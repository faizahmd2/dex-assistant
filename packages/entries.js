const Database = require('better-sqlite3')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const time = require('./time')

const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_PATH)
let db
function getDb() {
  if (!db) { db = new Database(DB_PATH); db.pragma('journal_mode = WAL'); init() }
  return db
}
function init() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'general',
      title TEXT, content TEXT NOT NULL, entry_date TEXT,
      metadata TEXT DEFAULT '{}', source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      entry_id UNINDEXED, type UNINDEXED, title, content, tokenize = "porter ascii"
    );
    CREATE INDEX IF NOT EXISTS idx_entries_type_date ON entries(type, entry_date);
  `)
}

function add({ type = 'general', title = null, content, entry_date = null, metadata = {}, source = 'manual' }) {
  const db = getDb()
  const id = uuidv4()
  const date = entry_date || time.todayIST()
  db.prepare(`INSERT INTO entries (id, type, title, content, entry_date, metadata, source)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, type, title, content, date, JSON.stringify(metadata), source)
  db.prepare(`INSERT INTO entries_fts (entry_id, type, title, content) VALUES (?, ?, ?, ?)`)
    .run(id, type, title || '', content)
  return { id, type, entry_date: date, content }
}

function remove(id) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id)
  if (!row) return null
  db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(id)
  db.prepare('DELETE FROM entries WHERE id = ?').run(id)
  return row
}

function findByKeyword(type, date, keyword) {
  return getDb().prepare(`
    SELECT * FROM entries WHERE type = ? AND entry_date = ? AND content LIKE ?
    ORDER BY created_at DESC LIMIT 1
  `).get(type, date, `%${keyword}%`)
}

function getByDate(type, date) {
  return getDb().prepare(`SELECT * FROM entries WHERE type = ? AND entry_date = ? ORDER BY created_at ASC`).all(type, date)
}

// FTS5 treats raw punctuation ("`, -, :, AND/OR/NOT, unmatched quotes...) as
// query syntax and throws. A natural-language chat message hits this
// constantly. Strip it down to plain tokens and OR them together so any
// user message is always a *valid* MATCH query, never a syntax error.
function sanitiseFtsQuery(raw) {
  if (!raw) return null
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/g)
  if (!tokens || !tokens.length) return null
  const unique = [...new Set(tokens)].slice(0, 12)
  return unique.map(t => `"${t}"`).join(' OR ')
}

// Keyword search across a type
function search(type, query, limit = 5) {
  const db = getDb()
  const ftsQuery = sanitiseFtsQuery(query)
  if (!ftsQuery) return []
  try {
    const rows = db.prepare(`
      SELECT entries_fts.entry_id, bm25(entries_fts) AS score
      FROM entries_fts WHERE entries_fts MATCH ? AND type = ?
      ORDER BY score LIMIT ?
    `).all(ftsQuery, type, limit)
    if (!rows.length) return []
    const ids = rows.map(r => r.entry_id)
    const placeholders = ids.map(() => '?').join(',')
    return db.prepare(`SELECT * FROM entries WHERE id IN (${placeholders}) ORDER BY entry_date DESC`).all(...ids)
  } catch (err) {
    // Fail open with an empty result instead of taking down /chat.
    console.error('[entries.search] FTS query failed:', err.message, '| raw:', query, '| sanitised:', ftsQuery)
    return []
  }
}

module.exports = { add, remove, findByKeyword, getByDate, search }