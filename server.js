const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 6677;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const isProduction = process.env.NODE_ENV === 'production';
const SECRET = process.env.SECRET || 'change-me-in-production';
const AUTH_COOKIE = 'auth';

function signAuth(val) {
  return val + '.' + crypto.createHmac('sha256', SECRET).update(val).digest('hex');
}

function verifyAuthCookie(signed) {
  if (!signed || typeof signed !== 'string') return false;
  const dot = signed.indexOf('.');
  if (dot === -1) return false;
  const val = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(val).digest('hex');
  return sig === expected && val === 'ok';
}

let schemaInitialized = false;
async function ensureSchema(req, res, next) {
  if (schemaInitialized) return next();
  try {
    await db.initSchema();
    schemaInitialized = true;
  } catch (e) {
    console.error('Schema init error:', e);
    const msg = 'Database error. DATABASE_URL must be postgresql://user:pass@host/db?sslmode=require (from Neon Connection string, not REST URL). ' + e.message;
    return res.status(500).send(msg);
  }
  next();
}

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => res.send('ok'));

app.use(ensureSchema);

function getClientIP(req) {
  const raw = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    '';
  return raw.replace(/^::ffff:/, '').replace(/^::1/, '127.0.0.1');
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  if (/["'<>]/.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch (e) {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (verifyAuthCookie(req.cookies[AUTH_COOKIE])) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  res.render('index', { error: null, shortUrl: null });
});

app.post('/create', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!validateUrl(url)) {
    return res.render('index', { error: 'Please enter a valid http:// or https:// URL', shortUrl: null });
  }
  try {
    const { shortCode } = await db.createLink(url);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shortUrl = `${baseUrl}/${shortCode}`;
    res.render('index', { error: null, shortUrl });
  } catch (e) {
    console.error('Create link error:', e);
    res.render('index', { error: 'Failed to create link. Please try again.', shortUrl: null });
  }
});

app.get('/login', (req, res) => {
  if (verifyAuthCookie(req.cookies[AUTH_COOKIE])) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const password = (req.body.password || '').trim();
  const envHash = process.env.DASHBOARD_PASSWORD_HASH?.trim();
  const envPlain = (process.env.DASHBOARD_PASSWORD || '').trim();
  const isDev = process.env.NODE_ENV !== 'production';
  let valid = false;
  if (envHash) {
    valid = bcrypt.compareSync(password, envHash);
  } else if (envPlain && password === envPlain) {
    valid = true;
  } else if (isDev && password === 'admin123') {
    valid = true;
  } else if (!envHash && !envPlain && !isDev) {
    return res.render('login', { error: 'Server not configured. Set DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_HASH.' });
  }
  if (valid) {
    res.cookie(AUTH_COOKIE, signAuth('ok'), {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'Invalid password' });
});

app.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.redirect('/login');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const links = await db.getAllLinksWithClickCounts();
  res.render('dashboard', { links });
});

app.get('/dashboard/links/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/dashboard');
  const links = await db.getAllLinksWithClickCounts();
  const link = links.find(l => l.id === id);
  if (!link) return res.redirect('/dashboard');
  const clicks = await db.getClicksForLink(id);
  res.render('link-detail', { link, clicks });
});

app.get('/:shortCode', async (req, res, next) => {
  const shortCode = req.params.shortCode;
  if (['dashboard', 'login', 'create', 'logout', 'track-webrtc', 'track-fingerprint', 'health'].includes(shortCode)) return next();
  const link = await db.getLinkByCode(shortCode);
  if (!link) return next();
  const ip = getClientIP(req);
  let country = null, city = null, region = null, loc = null, org = null, postal = null;
  let lat = null, lng = null;
  if (ip && ip !== '127.0.0.1' && !ip.startsWith('::')) {
    try {
      const geo = await axios.get(`https://ipinfo.io/${ip}/json`, { timeout: 3000 });
      country = geo.data.country;
      city = geo.data.city;
      region = geo.data.region;
      loc = geo.data.loc;
      org = geo.data.org;
      postal = geo.data.postal;
      if (geo.data.loc) {
        const [latStr, lngStr] = geo.data.loc.split(',');
        lat = parseFloat(latStr);
        lng = parseFloat(lngStr);
      }
    } catch (e) { /* ignore */ }
  }
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const initialFingerprint = {
    ip,
    country,
    city,
    region,
    loc,
    org,
    postal,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
    user_agent: req.headers['user-agent'],
    referrer: req.headers['referrer'] || req.headers['referer'],
    hostname: req.hostname,
    pathname: req.path,
    httpHeaders: {
      userAgent: req.headers['user-agent'],
      acceptLanguage: req.headers['accept-language'],
      doNotTrack: req.headers['dnt']
    },
    toLocaleString: new Date().toLocaleString(),
    systemTime: new Date().toISOString(),
    dateTime: new Date().toISOString()
  };
  const clickId = await db.logClick(link.id, {
    ip,
    user_agent: req.headers['user-agent'],
    referrer: req.headers['referrer'] || req.headers['referer'],
    country,
    city,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
    fingerprint: initialFingerprint
  });
  res.render('redirect', {
    originalUrl: link.original_url,
    clickId: clickId || 0
  });
});

app.post('/track-fingerprint/:clickId', express.json({ limit: '100kb' }), async (req, res) => {
  const clickId = parseInt(req.params.clickId, 10);
  if (!clickId || clickId < 1) return res.status(400).end();
  const fp = req.body;
  if (!fp || typeof fp !== 'object') return res.status(400).end();
  try {
    await db.updateClickFingerprint(clickId, fp);
  } catch (e) { /* ignore */ }
  res.status(204).end();
});

app.use((req, res) => {
  res.status(404).render('404');
});

if (process.env.VERCEL) {
  module.exports = app;
} else {
  const hasAuth = !!(process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD_HASH);
  if (!hasAuth) console.warn('WARNING: No DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_HASH set - login will fail');
  schemaInitialized = false;
  db.initSchema()
    .then(() => {
      schemaInitialized = true;
      app.listen(PORT, () => {
        console.log(`Link shortener running on port ${PORT}${hasAuth ? ' (auth configured)' : ''}`);
      });
    })
    .catch(err => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
}
