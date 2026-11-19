/**
 * A `SqlStorage` (DO SQLite API) shim over better-sqlite3 for the vitest
 * worker tests. Both sides are real SQLite with `?` positional binding, so
 * query semantics match; the tests swap the runtime, not the SQL.
 */
import Database from "better-sqlite3";
import type { SqlStorage, SqlStorageCursor, SqlStorageValue } from "@cloudflare/workers-types";

type Row = Record<string, SqlStorageValue>;

class Cursor<T extends Row> implements SqlStorageCursor<T> {
  private pos = 0;
  constructor(private readonly rows: T[]) {}
  get columnNames(): string[] {
    return this.rows.length ? Object.keys(this.rows[0]) : [];
  }
  get rowsRead(): number {
    return this.rows.length;
  }
  get rowsWritten(): number {
    return 0;
  }
  toArray(): T[] {
    return [...this.rows];
  }
  one(): T {
    if (!this.rows.length) throw new Error("one() on an empty cursor");
    return this.rows[0];
  }
  next(): IteratorResult<T> {
    const value = this.rows[this.pos++];
    return value === undefined ? { done: true, value: undefined } : { done: false, value };
  }
  raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    const rows = this.rows;
    return (function* () {
      for (const r of rows) yield Object.values(r) as unknown as U;
    })();
  }
  [Symbol.iterator](): IterableIterator<T> {
    const rows = this.rows;
    return (function* () {
      yield* rows;
    })();
  }
}

export class SqliteStorage implements Pick<SqlStorage, "exec"> {
  readonly db: Database.Database;

  constructor(file: string | ":memory:" = ":memory:") {
    this.db = new Database(file);
    this.db.pragma("foreign_keys = ON");
  }

  exec<T extends Row = Row>(query: string, ...bindings: SqlStorageValue[]): SqlStorageCursor<T> {
    const head = query.trimStart().split(/\s/, 1)[0].toUpperCase();
    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK" || head === "SAVEPOINT") {
      this.db.exec(query);
      return new Cursor<T>([]);
    }
    let stmt: Database.Statement;
    try {
      stmt = this.db.prepare(query);
    } catch {
      // multi-statement migration batches — no result rows, all applied at once
      this.db.exec(query);
      return new Cursor<T>([]);
    }
    if (stmt.reader) return new Cursor(stmt.all(...(bindings as never[])) as T[]);
    stmt.run(...(bindings as never[]));
    return new Cursor<T>([]);
  }
}
