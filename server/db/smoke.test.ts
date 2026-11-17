import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ROOT_DIR } from "../config";
import { migrate, openDatabase } from "./schema";
import { runSmoke, runSmokeIsolated } from "./smoke";

describe("db:smoke", () => {
  it("the pinned better-sqlite3 works here", () => {
    const require = createRequire(import.meta.url);
    const pkg = require(path.join(ROOT_DIR, "package.json"));
    expect(pkg.dependencies["better-sqlite3"]).toBe("12.11.1");
    expect(runSmoke().sqliteVersion).toMatch(/^3\.\d+/);
    expect(runSmokeIsolated().sqliteVersion).toMatch(/^3\.\d+/);
  });

  it("`npm run db:smoke` exits 0", () => {
    const r = spawnSync("npm", ["run", "--silent", "db:smoke"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/db:smoke ok: SQLite 3\./);
  });

  it("migrations are idempotent and create push_log", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["blobs", "elements", "files", "push_log", "sessions"]),
    );
    db.close();
  });
});
