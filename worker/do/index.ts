/**
 * BoardIndex: the single DO that tracks every board's last activity (plan
 * §3.3). Cloudflare offers no Durable Object enumeration, so each board
 * create/open/delete writes a row here; the daily alarm evicts boards idle
 * for 7 days and enforces the fleet LRU cap (phase 5 wires the sweep).
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { json } from "../http";

export const IDLE_EVICT_MS = 7 * 24 * 3600_000;
/** Fleet cap on stored boards (phase 5 LRU sweeps beyond this). */
export const MAX_BOARDS = 50_000;

// See BoardSession: no `extends DurableObject` (tsc hang on its types).
export class BoardIndex {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS boards (
          id TEXT PRIMARY KEY,
          last_active INTEGER NOT NULL
        )`,
      );
      this.state.storage.setAlarm(Date.now() + 24 * 3600_000);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/touch") {
      const { id } = (await req.json()) as { id: string };
      this.state.storage.sql.exec(
        "INSERT INTO boards (id, last_active) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_active = excluded.last_active",
        id,
        Date.now(),
      );
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/remove") {
      const { id } = (await req.json()) as { id: string };
      this.state.storage.sql.exec("DELETE FROM boards WHERE id = ?", id);
      return json({ ok: true });
    }
    if (req.method === "GET" && url.pathname === "/boards")
      return json({
        boards: this.state.storage.sql
          .exec("SELECT id, last_active FROM boards ORDER BY last_active")
          .toArray(),
      });
    return json({ error: { code: "not_found", message: "No route." } }, 404);
  }

  /** Daily sweep: evict idle boards via their DOs (phase 5 completes this). */
  async alarm() {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    const stale = this.state.storage.sql
      .exec<{ id: string }>("SELECT id FROM boards WHERE last_active < ?", cutoff)
      .toArray();
    for (const { id } of stale) {
      try {
        const stub = this.env.BOARD.get(this.env.BOARD.idFromName(id));
        await stub.fetch("https://do/_evict", { method: "POST" });
      } catch {
        // the DO is gone or busy: leave the row; the next sweep retries
      }
    }
    this.state.storage.setAlarm(Date.now() + 24 * 3600_000);
  }
}
