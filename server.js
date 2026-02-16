const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 6677;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  res.render('index', { error: null, shortUrl: null });
});

app.post('/create', (req, res) => {
  const url = (req.body.url || '').trim();
  if (!validateUrl(url)) {
    return res.render('index', { error: 'Please enter a valid http:// or https:// URL', shortUrl: null });
  }
  try {
    const { shortCode } = db.createLink(url);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const shortUrl = `${baseUrl}/${shortCode}`;
    res.render('index', { error: null, shortUrl });
  } catch (e) {
    console.error('Create link error:', e);
    res.render('index', { error: 'Failed to create link. Please try again.', shortUrl: null });
  }
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/dashboard');
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
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }
  res.render('login', { error: 'Invalid password' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, (req, res) => {
  const links = db.getAllLinksWithClickCounts();
  res.render('dashboard', { links });
});

app.get('/dashboard/links/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.redirect('/dashboard');
  const links = db.getAllLinksWithClickCounts();
  const link = links.find(l => l.id === id);
  if (!link) return res.redirect('/dashboard');
  const clicks = db.getClicksForLink(id);
  res.render('link-detail', { link, clicks });
});

app.get('/:shortCode', async (req, res, next) => {
  const shortCode = req.params.shortCode;
  if (['dashboard', 'login', 'create', 'logout'].includes(shortCode)) return next();
  const link = db.getLinkByCode(shortCode);
  if (!link) return next();
  const ip = getClientIP(req);
  let country = null, city = null, lat = null, lng = null;
  if (ip && ip !== '127.0.0.1' && !ip.startsWith('::')) {
    try {
      const geo = await axios.get(`https://ipinfo.io/${ip}/json`, { timeout: 3000 });
      country = geo.data.country;
      city = geo.data.city;
      if (geo.data.loc) {
        const [latStr, lngStr] = geo.data.loc.split(',');
        lat = parseFloat(latStr);
        lng = parseFloat(lngStr);
      }
    } catch (e) { /* ignore */ }
  }
  db.logClick(link.id, {
    ip,
    user_agent: req.headers['user-agent'],
    referrer: req.headers['referrer'] || req.headers['referer'],
    country,
    city,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng
  });
  res.redirect(302, link.original_url);
});

app.use((req, res) => {
  res.status(404).render('404');
});

async function start() {
  await db.initDb();
  const hasAuth = !!(process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD_HASH);
  if (!hasAuth) console.warn('WARNING: No DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_HASH set - login will fail');
  app.listen(PORT, () => {
    console.log(`Link shortener running on port ${PORT}${hasAuth ? ' (auth configured)' : ''}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
