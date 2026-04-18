const express = require('express');
const app = express();
const PORT = process.env.PORT || 5000;

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'cicd-backend'
  });
});

app.get('/', (req, res) => {
  res.status(200).json({ message: 'Backend API is running' });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
