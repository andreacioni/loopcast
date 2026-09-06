const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "..", "resume.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS resume (
    item_id     TEXT PRIMARY KEY,
    title       TEXT,
    position    REAL DEFAULT 0,
    duration    REAL DEFAULT 0,
    updated_at  INTEGER
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    usn         TEXT PRIMARY KEY,
    kind        TEXT,
    selected    BOOLEAN DEFAULT 0
  )
`);

// IMPORTANT: prepare each statement exactly once and reuse it. Calling
// db.prepare() inside a hot path (e.g. a 7s polling interval per renderer)
// creates and discards a native Statement object every time, and rapid
// create/GC churn of those native objects is what triggers the
// "Assertion failed: (env) != nullptr" crash in better-sqlite3 during
// Node's environment cleanup on some platforms.
const resume_stmts = {
  get: db.prepare("SELECT * FROM resume WHERE item_id = ?"),
  upsert: db.prepare(`
    INSERT INTO resume (item_id, title, position, duration, updated_at)
    VALUES (@itemId, @title, @position, @duration, @now)
    ON CONFLICT(item_id) DO UPDATE SET
      position = @position,
      duration = @duration,
      updated_at = @now
  `),
  clear: db.prepare("DELETE FROM resume WHERE item_id = ?"),
  list: db.prepare("SELECT * FROM resume ORDER BY updated_at DESC"),
};

const device_stmts = {
  list: db.prepare("SELECT * FROM devices"),
  upsert: db.prepare(`
    INSERT INTO devices (usn, kind, selected)
    VALUES (@usn, @kind, @selected)
    ON CONFLICT(usn) DO UPDATE SET
      kind = @kind,
      selected = @selected
  `),
  clearSelected: db.prepare("UPDATE devices SET selected = 0"),
  select: db.prepare("UPDATE devices SET selected = 1 WHERE usn = ?"),
};

function getResume(itemId) {
  return resume_stmts.get.get(itemId);
}

function saveResume(itemId, title, position, duration) {
  resume_stmts.upsert.run({
    itemId,
    title,
    position,
    duration,
    now: Date.now(),
  });
}

function clearResume(itemId) {
  resume_stmts.clear.run(itemId);
}

function listResumable() {
  return resume_stmts.list.all();
}

function listDevices() {
  return device_stmts.list.all();
}

function close() {
  db.close();
}

module.exports = {
  getResume,
  saveResume,
  clearResume,
  listResumable,
  listDevices,
  close,
};
