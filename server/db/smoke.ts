/**
 * Database smoke check (plan §3.4, risk 5). `better-sqlite3` is a native module:
 * some versions crash (SIGSEGV) on some systems as soon as a database opens.
 * `runSmokeIsolated` runs the check in a child process, so even a crash turns
 * into a clear start-up error instead of a dead server.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export interface SmokeResult {
  sqliteVersion: string;
}

/** Opens a temporary database, checks WAL, writes, reads, and cleans up. */
export const runSmoke = (): SmokeResult => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chalanamaya-smoke-"));
  try {
    const db = new Database(path.join(dir, "smoke.db"));
    try {
      const { v } = db.prepare("select sqlite_version() as v").get() as { v: string };
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      if (mode !== "wal") throw new Error(`WAL mode is not available (got ${String(mode)})`);
      db.exec("create table t (k integer primary key, v text)");
      db.prepare("insert into t (v) values (?)").run("ok");
      const row = db.prepare("select v from t").get() as { v: string } | undefined;
      if (row?.v !== "ok") throw new Error("a written row could not be read back");
      return { sqliteVersion: v };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const CHILD = `
const Database = require(process.argv[1]);
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chalanamaya-smoke-"));
try {
  const db = new Database(path.join(dir, "smoke.db"));
  const v = db.prepare("select sqlite_version() as v").get().v;
  if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") throw new Error("WAL mode is not available");
  db.exec("create table t (k integer primary key, v text)");
  db.prepare("insert into t (v) values (?)").run("ok");
  if (db.prepare("select v from t").get().v !== "ok") throw new Error("a written row could not be read back");
  db.close();
  process.stdout.write(JSON.stringify({ sqliteVersion: v }));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
`;

export class SmokeError extends Error {}

/** The same check in a child process; throws SmokeError with a readable message. */
export const runSmokeIsolated = (): SmokeResult => {
  const require = createRequire(import.meta.url);
  const modPath = require.resolve("better-sqlite3");
  const r = spawnSync(process.execPath, ["-e", CHILD, modPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const hint =
    "better-sqlite3 must be exactly 12.11.1 (13.x crashes on Node 22 on some systems); run `npm ci` and `npm run db:smoke`.";
  if (r.error)
    throw new SmokeError(`The database check could not run: ${r.error.message}. ${hint}`);
  if (r.signal)
    throw new SmokeError(
      `The database library crashed (${r.signal}) while opening a database. ${hint}`,
    );
  if (r.status !== 0)
    throw new SmokeError(
      `The database check failed: ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")} ${hint}`,
    );
  return JSON.parse(r.stdout) as SmokeResult;
};
