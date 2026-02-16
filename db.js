const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'links.sqlite');
let db = null;

function persist() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code TEXT UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT,
    referrer TEXT,
    country TEXT,
    city TEXT,
    lat REAL,
    lng REAL,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (link_id) REFERENCES links(id)
  )`);
  try { db.run(`ALTER TABLE clicks ADD COLUMN lat REAL`); } catch (e) { /* column may exist */ }
  try { db.run(`ALTER TABLE clicks ADD COLUMN lng REAL`); } catch (e) { /* column may exist */ }
  db.run(`CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id)`);
  persist();
  return db;
}

function createLink(originalUrl) {
  const { nanoid } = require('nanoid');
  let shortCode = nanoid(8);
  let success = false;
  while (!success) {
    try {
      db.run('INSERT INTO links (short_code, original_url) VALUES (?, ?)', [shortCode, originalUrl]);
      success = true;
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) {
        shortCode = nanoid(8);
      } else {
        throw e;
      }
    }
  }
  persist();
  return { shortCode, originalUrl };
}

function getLinkByCode(shortCode) {
  const stmt = db.prepare('SELECT * FROM links WHERE short_code = ?');
  stmt.bind([shortCode]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function logClick(linkId, data) {
  db.run(
    `INSERT INTO clicks (link_id, ip, user_agent, referrer, country, city, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      linkId,
      data.ip || null,
      data.user_agent || null,
      data.referrer || null,
      data.country || null,
      data.city || null,
      data.lat ?? null,
      data.lng ?? null
    ]
  );
  persist();
}

function getAllLinksWithClickCounts() {
  const result = db.exec(`
    SELECT l.id, l.short_code, l.original_url, l.created_at, COUNT(c.id) as click_count
    FROM links l
    LEFT JOIN clicks c ON l.id = c.link_id
    GROUP BY l.id
    ORDER BY l.created_at DESC
  `);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => obj[col] = row[i]);
    return obj;
  });
}

function getClicksForLink(linkId) {
  const stmt = db.prepare('SELECT * FROM clicks WHERE link_id = ? ORDER BY clicked_at DESC');
  stmt.bind([linkId]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

module.exports = {
  initDb,
  createLink,
  getLinkByCode,
  logClick,
  getAllLinksWithClickCounts,
  getClicksForLink,
  get db() { return db; }
};
