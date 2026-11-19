/**
 * Durable Object SQLite schema for one board (plan §3.5 of the Cloudflare
 * plan). Same tables as the Node server, plus `auth` for the board's three
 * secrets (only SHA-256 hashes are stored). Migrations run by
 * `PRAGMA user_version`, like `server/db/schema.ts`.
 */
import type { SqlStorage } from "@cloudflare/workers-types";

const MIGRATIONS: string[] = [
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
  CREATE TABLE auth (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    edit_hash TEXT NOT NULL,
    owner_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Runs the migrations a fresh (or older) board storage needs. */
export const migrate = (sql: SqlStorage) => {
  const current = sql.exec<{ user_version: number }>("PRAGMA user_version").one().user_version ?? 0;
  if (current > SCHEMA_VERSION)
    throw new Error(
      `this board was made by a newer ChalanaMaya (schema ${current}, this build knows ${SCHEMA_VERSION})`,
    );
  for (let v = current; v < SCHEMA_VERSION; v += 1) {
    sql.exec(MIGRATIONS[v]);
    sql.exec(`PRAGMA user_version = ${v + 1}`);
  }
};
