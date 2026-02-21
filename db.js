const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

function nanoid(size = 8) {
  return crypto.randomBytes(size).toString('base64url').slice(0, size);
}

const connString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
let sql = null;

function getSql() {
  if (!connString) throw new Error('DATABASE_URL or POSTGRES_URL is required');
  if (!sql) sql = neon(connString);
  return sql;
}

async function initSchema() {
  const db = getSql();
  await db`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      short_code VARCHAR(32) UNIQUE NOT NULL,
      original_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await db`
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      link_id INTEGER NOT NULL REFERENCES links(id),
      ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      country TEXT,
      city TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      clicked_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code)`;
  await db`CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id)`;
  await db`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS webrtc_ip TEXT`;
  await db`ALTER TABLE clicks ADD COLUMN IF NOT EXISTS fingerprint JSONB DEFAULT '{}'`;
}

async function createLink(originalUrl) {
  const db = getSql();
  let shortCode = nanoid(8);
  let attempts = 0;
  while (attempts < 10) {
    try {
      await db`
        INSERT INTO links (short_code, original_url)
        VALUES (${shortCode}, ${originalUrl})
      `;
      return { shortCode, originalUrl };
    } catch (e) {
      if (e.code === '23505') {
        shortCode = nanoid(8);
        attempts++;
      } else {
        throw e;
      }
    }
  }
  throw new Error('Failed to generate unique short code');
}

async function getLinkByCode(shortCode) {
  const db = getSql();
  const rows = await db`
    SELECT * FROM links WHERE short_code = ${shortCode}
  `;
  return rows[0] || null;
}

async function getLinkById(id) {
  const db = getSql();
  const rows = await db`SELECT * FROM links WHERE id = ${id}`;
  return rows[0] || null;
}

async function logClick(linkId, data) {
  const db = getSql();
  const initialFingerprint = data.fingerprint || {};
  const rows = await db`
    INSERT INTO clicks (link_id, ip, user_agent, referrer, country, city, lat, lng, fingerprint)
    VALUES (
      ${linkId},
      ${data.ip || null},
      ${data.user_agent || null},
      ${data.referrer || null},
      ${data.country || null},
      ${data.city || null},
      ${data.lat ?? null},
      ${data.lng ?? null},
      ${JSON.stringify(initialFingerprint)}
    )
    RETURNING id
  `;
  return rows[0]?.id;
}

async function updateClickFingerprint(clickId, clientFingerprint) {
  if (!clickId || !clientFingerprint || typeof clientFingerprint !== 'object') return;
  const db = getSql();
  const webrtcIp = clientFingerprint.rtc_localIPv4 || clientFingerprint.rtc_localIPv6 ||
    clientFingerprint.rtc_publicIP || clientFingerprint.webrtc_ip;
  const rows = await db`SELECT fingerprint FROM clicks WHERE id = ${clickId}`;
  if (!rows[0]) return;
  const existing = rows[0].fingerprint;
  let existingObj = {};
  if (existing) {
    if (typeof existing === 'string') try { existingObj = JSON.parse(existing); } catch (e) {}
    else existingObj = existing;
  }
  const merged = { ...existingObj, ...clientFingerprint };
  await db`
    UPDATE clicks SET fingerprint = ${JSON.stringify(merged)}, webrtc_ip = COALESCE(webrtc_ip, ${webrtcIp || null})
    WHERE id = ${clickId}
  `;
}

async function getAllLinksWithClickCounts() {
  const db = getSql();
  const rows = await db`
    SELECT l.id, l.short_code, l.original_url, l.created_at,
           COUNT(c.id)::int as click_count
    FROM links l
    LEFT JOIN clicks c ON l.id = c.link_id
    GROUP BY l.id
    ORDER BY l.created_at DESC
  `;
  return rows;
}

async function getClicksForLink(linkId) {
  const db = getSql();
  const rows = await db`
    SELECT * FROM clicks
    WHERE link_id = ${linkId}
    ORDER BY clicked_at DESC
  `;
  return rows;
}

async function deleteLink(linkId) {
  const database = getSql();
  await database`DELETE FROM clicks WHERE link_id = ${linkId}`;
  await database`DELETE FROM links WHERE id = ${linkId}`;
}

async function deleteClick(clickId, linkId) {
  const database = getSql();
  await database`DELETE FROM clicks WHERE id = ${clickId} AND link_id = ${linkId}`;
}

module.exports = {
  initSchema,
  createLink,
  getLinkByCode,
  getLinkById,
  logClick,
  updateClickFingerprint,
  getAllLinksWithClickCounts,
  getClicksForLink,
  deleteLink,
  deleteClick,
};
