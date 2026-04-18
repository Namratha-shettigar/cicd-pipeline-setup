

## 1. Executive Summary

This project delivers an end-to-end CI/CD pipeline that automatically builds, tests, and deploys a Dockerised frontend and backend application to an AWS EC2 Windows Server 2022 instance on every push to the `main` branch.

AWS CodePipeline was chosen as the CI/CD orchestrator because it operates entirely within the AWS ecosystem, uses IAM roles for all authentication (no cross-cloud credentials), integrates natively with ECR and SSM, and aligns with the AWS DevOps Professional certification path. The trade-off is that it is less flexible than GitHub Actions for non-AWS targets, but for an AWS-only deployment this is the correct choice.

**Trade-offs documented honestly:**
- CodePipeline has no free tier beyond 1 pipeline — cost is $1/pipeline/month.
- SSM Run Command on Windows requires the SSM Agent to be running and the instance to have outbound HTTPS (port 443) to SSM endpoints — port 22 is never opened.
- Docker Desktop on Windows requires WSL2, which adds ~500 MB overhead but enables Linux containers natively.

---

## 2. Architecture Overview

```
Internet
    │
    ▼ port 80
┌─────────────────────────────────────────────┐
│  AWS EC2 — Windows Server 2022 (t3.medium)  │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │  Docker (WSL2 backend)               │   │
│  │                                      │   │
│  │  cicd-nginx (nginx:alpine)         │   │
│  │    port 80 → frontend:3000           │   │
│  │    /health  → backend:5000           │   │
│  │                                      │   │
│  │  cicd-frontend (nginx:alpine)      │   │
│  │    port 3000 — serves index.html     │   │
│  │                                      │   │
│  │  cicd-backend (node:18-alpine)     │   │
│  │    port 5000 — Express /health       │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
         ▲
         │ SSM Run Command (port 443, no SSH)
         │
┌────────────────────┐
│  AWS CodePipeline  │
│  Stage 1: Source   │  ← GitHub push to main
│  Stage 2: Build    │  ← CodeBuild, Docker build
│  Stage 3: Push     │  ← Push to ECR
│  Stage 4: Deploy   │  ← SSM Run Command
│  Stage 5: Verify   │  ← curl /health → HTTP 200
└────────────────────┘
         │
┌────────────────────┐
│  AWS ECR           │
│  cicd-frontend   │
│  cicd-backend    │
└────────────────────┘
```

---

## 3. Prerequisites and Environment Setup

### AWS Resources Required
- AWS Account with permissions to create IAM roles, ECR, EC2, CodePipeline, CodeBuild, SSM
- GitHub repository connected via AWS CodeStar Connections

### Secrets Approach — Never Hardcoded
All sensitive values are handled via:
- **IAM Roles** — EC2 instance role for ECR pull + SSM; CodeBuild role for ECR push + SSM send
- **AWS Secrets Manager** — store any application secrets (e.g. DB passwords) referenced as `{{resolve:secretsmanager:<secret-name>}}`
- **Environment variables in CodeBuild** — `AWS_ACCOUNT_ID` and `AWS_REGION` injected at build time from CloudFormation, never in source code

### EC2 Setup (Windows Server 2022, t3.medium)

**Security Group rules:**
| Port | Protocol | Source         | Purpose          |
|------|----------|----------------|------------------|
| 80   | TCP      | 0.0.0.0/0      | HTTP traffic     |
| 3389 | TCP      | \<your-IP\>/32 | RDP (setup only) |
| 443  | TCP      | 0.0.0.0/0      | SSM + ECR pull   |

**IAM Instance Profile — attach these managed policies:**
- `AmazonEC2ContainerRegistryReadOnly`
- `AmazonSSMManagedInstanceCore`

**PowerShell bootstrap (run via RDP once after launch):**
```powershell
# 1. Install Chocolatey
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# 2. Install AWS CLI
choco install awscli -y

# 3. Install Docker Desktop (WSL2 backend)
choco install docker-desktop -y

# 4. Reboot to activate WSL2
Restart-Computer -Force
```

**After reboot — run in PowerShell:**
```powershell
# 5. Create app directory
New-Item -ItemType Directory -Force -Path C:\app\cicd

# 6. Copy docker-compose.yml and nginx/nginx.conf to C:\app\cicd\
# (SSM deploy stage handles this automatically via artifact copy)

# 7. Verify SSM Agent is running (pre-installed on Windows Server 2022 AMI)
Get-Service AmazonSSMAgent
```

---

## 4. CI/CD Pipeline Walkthrough

### Stage 1 — Source
- Trigger: push to `main` branch on GitHub
- Provider: AWS CodeStar Connections (OAuth, no tokens stored in pipeline)
- Output: source code ZIP artifact

### Stage 2 — Build (`buildspec-build.yml`)
- Runs on: CodeBuild Linux container (`aws/codebuild/standard:7.0`, PrivilegedMode ON for Docker)
- Actions:
  - Computes `IMAGE_TAG = <build-number>-<7-char-commit-SHA>` (e.g. `42-a3f9c1d`)
  - `docker build` for frontend and backend
  - Exports `imageDetail.json` with ImageTag, CommitSHA, BuildNumber
- Output artifact: `BuildArtifact` (imageDetail.json + compose files)

### Stage 3 — Push (`buildspec-push.yml`)
- Rebuilds images (CodeBuild is stateless between stages)
- `aws ecr get-login-password` → `docker login` using CodeBuild IAM role (no credentials)
- Pushes both `:<image-tag>` and `:latest` to ECR
- No SSH keys, no access keys — pure IAM role auth

### Stage 4 — Deploy (`buildspec-deploy.yml`)
- Looks up EC2 instance ID by tag `Name=cicd-server`
- Issues `aws ssm send-command` with `AWS-RunPowerShellScript` document
- PowerShell on EC2:
  - ECR login via instance IAM role
  - `docker-compose pull` → pulls new image tags
  - `docker-compose up -d --force-recreate --remove-orphans`
- Polls SSM command status — fails pipeline if status ≠ `Success`

### Stage 5 — Verify (`buildspec-verify.yml`)
- Looks up EC2 public IP by tag
- `curl -s http://<EC2_IP>/health` with HTTP status code capture
- Pipeline **fails** (`exit 1`) if:
  - HTTP code ≠ 200
  - `status` ≠ `"ok"`
  - `service` ≠ `"cicd-backend"`

---

## 5. Deployment and Nginx Configuration

### docker-compose.yml
Uses ECR image URLs with environment variables — no hardcoded account IDs:
```
${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/cicd-frontend:${IMAGE_TAG}
${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/cicd-backend:${IMAGE_TAG}
```
All three containers have `restart: unless-stopped` for auto-recovery on reboot.

### Nginx Reverse Proxy Routing
```
GET /        → proxy_pass http://frontend:3000
GET /health  → proxy_pass http://backend:5000/health
```
The nginx container mounts `./nginx/nginx.conf` read-only — no image rebuild needed for config changes.

### Frontend Container
- Base image: `nginx:alpine`
- Custom `nginx-frontend.conf` makes nginx listen on port 3000 (not default 80)
- Serves `index.html` as static content

### Backend Container
- Base image: `node:18-alpine`
- Express server on port 5000
- `/health` returns exactly: `{ "status": "ok", "service": "cicd-backend" }`

---

## 6. Health Check URL and Validation

**Endpoint:** `GET http://<EC2_PUBLIC_IP>/health`

**Expected response:**
```json
HTTP/1.1 200 OK
Content-Type: application/json

{ "status": "ok", "service": "cicd-backend" }
```

**Manual validation:**
```bash
curl -v http://<EC2_PUBLIC_IP>/health
```

**Pipeline validation (Stage 5 — Verify):**
The verify stage captures the HTTP status code separately from the body using `curl -w "%{http_code}"`. Both the status code AND the JSON body fields are validated. The pipeline fails hard (`exit 1`) on any mismatch, ensuring a broken deployment never silently passes.

**Local testing:**
```bash
docker-compose up -d
curl http://localhost/health
# Expected: {"status":"ok","service":"cicd-backend"}
```

---

## Deploying the Pipeline via CloudFormation

```bash
# 1. Create GitHub connection in AWS Console first:
#    Developer Tools → Connections → Create connection → GitHub
#    Copy the connection ARN

# 2. Deploy the stack
aws cloudformation deploy \
  --template-file pipeline/pipeline.yml \
  --stack-name cicd-pipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubConnectionArn=<connection-arn> \
    GitHubOwner=<your-github-username> \
    GitHubRepo=<your-repo-name> \
    GitHubBranch=main
```

## File Structure
```
cicd-assignment/
├── frontend/
│   ├── Dockerfile
│   ├── nginx-frontend.conf
│   └── index.html
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── nginx/
│   └── nginx.conf
├── pipeline/
│   └── pipeline.yml        ← CloudFormation stack
├── buildspec-build.yml     ← Stage 2: build images
├── buildspec-push.yml      ← Stage 3: push to ECR
├── buildspec-deploy.yml    ← Stage 4: SSM deploy
├── buildspec-verify.yml    ← Stage 5: health check
├── docker-compose.yml
└── README.md
```
