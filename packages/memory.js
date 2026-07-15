const Database = require('better-sqlite3')
const path = require('path')
const { v4: uuidv4 } = require('uuid')

// Always resolve relative to project root, not cwd
const DB_PATH = path.resolve(process.cwd(), process.env.SQLITE_PATH);

console.log('[memory] using db:', DB_PATH)

let db

function getDb() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    init()
  }
  return db
}

function init() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        importance INTEGER DEFAULT 5,
        source TEXT DEFAULT 'manual',
        tags TEXT DEFAULT '[]',
        expires_at TEXT,
        due_at TEXT,
        done INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      content TEXT NOT NULL,
      changed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context_used TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

function remember({ content, type = 'general', importance = 5, source = 'manual', tags = [], expires_at = null, due_at = null }) {
  const db = getDb()
  const id = uuidv4()
  db.prepare(`
    INSERT INTO memories (id, content, type, importance, source, tags, expires_at, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, content, type, importance, source, JSON.stringify(tags), expires_at, due_at)
  return { id, content, type, importance, due_at }
}

function forget(id) {
  const db = getDb()
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
  if (!memory) return null
  db.prepare(`
    INSERT INTO memory_versions (id, memory_id, content)
    VALUES (?, ?, ?)
  `).run(uuidv4(), id, memory.content)
  db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  return { deleted: id }
}

function update(id, { content, importance, tags, expires_at, due_at, done }) {
  const db = getDb()
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
  if (!memory) return null
  db.prepare(`INSERT INTO memory_versions (id, memory_id, content) VALUES (?, ?, ?)`)
    .run(uuidv4(), id, memory.content)
  db.prepare(`
    UPDATE memories SET
      content = COALESCE(?, content),
      importance = COALESCE(?, importance),
      tags = COALESCE(?, tags),
      expires_at = COALESCE(?, expires_at),
      due_at = COALESCE(?, due_at),
      done = COALESCE(?, done),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(content, importance, tags ? JSON.stringify(tags) : null, expires_at, due_at, done, id)
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
}

function search(query, { type, limit = 10 } = {}) {
  const db = getDb()
  let sql = `SELECT * FROM memories WHERE content LIKE ? `
  const params = [`%${query}%`]
  if (type) { sql += `AND type = ? `; params.push(type) }
  sql += `ORDER BY importance DESC LIMIT ?`
  params.push(limit)
  return db.prepare(sql).all(...params)
}

function list({ type, limit = 50 } = {}) {
  const db = getDb()
  let sql = `SELECT * FROM memories WHERE (expires_at IS NULL OR expires_at > datetime('now'))`
  const params = []
  if (type) { sql += ` AND type = ?`; params.push(type) }
  sql += ` ORDER BY importance DESC, created_at DESC LIMIT ?`
  params.push(limit)
  return db.prepare(sql).all(...params)
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'what', 'when',
  'where', 'about', 'from', 'your', 'you', 'are', 'was', 'were', 'been',
  'does', 'did', 'not', 'can', 'could', 'would', 'should', 'will', 'just',
  'like', 'know', 'tell', 'give', 'get', 'got', 'been', 'been', 'hai'
])

// Used by /chat instead of list(). Only pulls memories whose content
// actually shares a keyword with the current message, ranked by
// importance among those matches — instead of always injecting the
// top-N most-important memories regardless of what was asked.
function getContextMemories(message, limit = 8) {
  const db = getDb()
  const tokens = (message.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(t => t.length > 2 && !STOPWORDS.has(t))

  if (!tokens.length) {
    // Nothing meaningful to match on — return only a small, high-signal
    // slice rather than the full top-20 dump.
    return list({ limit: Math.min(limit, 5) })
  }

  const unique = [...new Set(tokens)].slice(0, 8)
  const clauses = unique.map(() => 'content LIKE ?').join(' OR ')
  const params = unique.map(t => `%${t}%`)

  return db.prepare(`
    SELECT * FROM memories
    WHERE (expires_at IS NULL OR expires_at > datetime('now'))
      AND (${clauses})
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(...params, limit)
}

function saveChat({ role, content, context_used = [] }) {
  const db = getDb()
  const id = uuidv4()
  db.prepare(`
    INSERT INTO chat_history (id, role, content, context_used)
    VALUES (?, ?, ?, ?)
  `).run(id, role, content, JSON.stringify(context_used))
  return id
}

function getRecentChats(limit = 10) {
  return getDb().prepare(`
    SELECT * FROM chat_history ORDER BY created_at DESC LIMIT ?
  `).all(limit).reverse()
}

function getUpcoming(hours = 24) {
  return getDb().prepare(`
    SELECT * FROM memories
    WHERE due_at IS NOT NULL AND done = 0
      AND due_at BETWEEN datetime('now') AND datetime('now', '+' || ? || ' hours')
    ORDER BY due_at ASC
  `).all(hours)
}

function getOverdue(limit = 10) {
  return getDb().prepare(`
    SELECT * FROM memories
    WHERE due_at IS NOT NULL AND done = 0 AND due_at < datetime('now')
    ORDER BY due_at DESC LIMIT ?
  `).all(limit)
}

function getByDate(date) {
  return getDb().prepare(`SELECT * FROM memories WHERE created_at LIKE ? ORDER BY created_at ASC`).all(`${date}%`)
}

module.exports = {
  remember, forget, update, search, list, getContextMemories,
  saveChat, getRecentChats, getUpcoming, getOverdue, getByDate
}