/**
 * SQLite schema and migrations (plan §3.5). Migrations run by `PRAGMA user_version`.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // 1: sessions, elements, files, blobs, push_log
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    push_log_floor_rev INTEGER NOT NULL DEFAULT 0,
    element_count INTEGER NOT NULL DEFAULT 0,
    media_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    opened_at INTEGER
  );
  CREATE TABLE elements (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    idx TEXT NOT NULL,
    version INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    needs_layout INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
  );
  CREATE INDEX elements_order ON elements (session_id, deleted, idx, id);
  CREATE INDEX elements_rev ON elements (session_id, rev);
  CREATE TABLE files (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    source TEXT NOT NULL CHECK (source IN ('upload', 'remote')),
    url TEXT,
    poster_file_id TEXT,
    created_at INTEGER,
    PRIMARY KEY (session_id, id)
  );
  CREATE INDEX files_sha ON files (session_id, sha256);
  CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    refs INTEGER NOT NULL
  );
  CREATE TABLE push_log (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    push_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    ack TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, push_id)
  );
  CREATE INDEX push_log_age ON push_log (session_id, created_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export const migrate = (db: DB) => {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION)
    throw new Error(
      `the database was made by a newer ChalanaMaya (schema ${current}, this build knows ${SCHEMA_VERSION})`,
    );
  for (let v = current; v < SCHEMA_VERSION; v += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
};

/** Opens (and migrates) the board database in `dataDir`, or in memory for ":memory:". */
export const openDatabase = (dataDir: string | ":memory:"): DB => {
  let db: DB;
  if (dataDir === ":memory:") db = new Database(":memory:");
  else {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, "chalanamaya.db"));
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
};

/** Current database size in bytes (page_count × page_size). */
export const dbBytes = (db: DB) =>
  (db.pragma("page_count", { simple: true }) as number) *
  (db.pragma("page_size", { simple: true }) as number);
