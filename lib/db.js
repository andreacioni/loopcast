const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'resume.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS resume (
    item_id     TEXT PRIMARY KEY,
    title       TEXT,
    position    REAL DEFAULT 0,
    duration    REAL DEFAULT 0,
    updated_at  INTEGER
  )
`);

// IMPORTANT: prepare each statement exactly once and reuse it. Calling
// db.prepare() inside a hot path (e.g. a 7s polling interval per renderer)
// creates and discards a native Statement object every time, and rapid
// create/GC churn of those native objects is what triggers the
// "Assertion failed: (env) != nullptr" crash in better-sqlite3 during
// Node's environment cleanup on some platforms.
const stmts = {
  get: db.prepare('SELECT * FROM resume WHERE item_id = ?'),
  upsert: db.prepare(`
    INSERT INTO resume (item_id, title, position, duration, updated_at)
    VALUES (@itemId, @title, @position, @duration, @now)
    ON CONFLICT(item_id) DO UPDATE SET
      position = @position,
      duration = @duration,
      updated_at = @now
  `),
  clear: db.prepare('DELETE FROM resume WHERE item_id = ?'),
  list: db.prepare('SELECT * FROM resume ORDER BY updated_at DESC'),
};

function getResume(itemId) {
  return stmts.get.get(itemId);
}

function saveResume(itemId, title, position, duration) {
  stmts.upsert.run({ itemId, title, position, duration, now: Date.now() });
}

function clearResume(itemId) {
  stmts.clear.run(itemId);
}

function listResumable() {
  return stmts.list.all();
}

function close() {
  db.close();
}

module.exports = { getResume, saveResume, clearResume, listResumable, close };
