const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>NAS100 Trading Assistant</title></head>
    <body>
      <h1>✅ NAS100 Trading Assistant</h1>
      <p>Server is running! 🚀</p>
      <p>Instrument: ${process.env.INSTRUMENT || 'NAS100'}</p>
      <p>Time: ${new Date().toLocaleString('en-PK', {timeZone: 'Asia/Karachi'})}</p>
    </body>
    </html>
  `);
});

app.get('/api/v1/market/current', (req, res) => {
  res.json({
    success: true,
    data: {
      instrument: 'NAS100',
      price: 19845.60,
      change: 63.20,
      timestamp: Date.now()
    }
  });
});

app.listen(PORT, () => {
  console.log('✅ NAS100 Trading Assistant running on port', PORT);
});
