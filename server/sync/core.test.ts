/** The sync core without WebSocket: admission limits and hello rate limit. */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../config";
import { openDatabase } from "../db/schema";
import { SessionService } from "../sessions/service";
import { tempDir } from "../test/helpers";
import { createSyncCore, type SyncConn, type SyncTransport } from "./socket";
import type { ServerMessage } from "../../src/shared/protocol";

let dir: string;
let clock = 1_000_000;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const make = (opts: { maxPerBoard?: number; maxSockets?: number } = {}) => {
  const service = new SessionService(openDatabase(":memory:"), {
    limits: DEFAULT_LIMITS,
    mediaDir: dir,
  });
  const core = createSyncCore(service, { limits: DEFAULT_LIMITS, now: () => clock, ...opts });
  return { service, core };
};

const transport = () => {
  const msgs: ServerMessage[] = [];
  const closed: number[] = [];
  const t: SyncTransport = {
    send: (text) => void msgs.push(JSON.parse(text) as ServerMessage),
    close: (code) => void closed.push(code),
  };
  return { t, msgs, closed };
};

const conn = (c: SyncConn | { refused: number }) => {
  if ("refused" in c) throw new Error(`refused ${c.refused}`);
  return c;
};

describe("sync core", () => {
  it("refuses a missing board, a full board and a full server", () => {
    const { service, core } = make({ maxPerBoard: 2, maxSockets: 3 });
    const a = service.create().sessionId;
    const b = service.create().sessionId;
    expect(core.connect("x".repeat(24), transport().t)).toEqual({ refused: 404 });
    const c1 = conn(core.connect(a, transport().t));
    conn(core.connect(a, transport().t));
    expect(core.connect(a, transport().t)).toEqual({ refused: 503 });
    conn(core.connect(b, transport().t));
    // the server is full even though board b has room
    expect(core.admits(b)).toBe(503);
    expect(core.total()).toBe(3);
    c1.disconnect();
    c1.disconnect(); // twice is harmless
    expect(core.total()).toBe(2);
    expect(core.admits(b)).toBe(true);
  });

  it("a socket that keeps saying hello is told off and closed", () => {
    const { service, core } = make();
    const sid = service.create().sessionId;
    const { t, msgs, closed } = transport();
    const c = conn(core.connect(sid, t));
    for (let i = 0; i < 10; i++)
      c.receive(JSON.stringify({ type: "hello", clientId: "client-a-1" }));
    expect(msgs.filter((m) => m.type === "snapshot")).toHaveLength(10);
    expect(closed).toEqual([]);
    c.receive(JSON.stringify({ type: "hello", clientId: "client-a-1" }));
    expect(msgs.at(-1)).toMatchObject({ type: "error", code: "rate_limited", status: 429 });
    expect(closed).toEqual([4429]);
  });

  it("hellos spread over time are fine", () => {
    const { service, core } = make();
    const sid = service.create().sessionId;
    const { t, msgs, closed } = transport();
    const c = conn(core.connect(sid, t));
    for (let i = 0; i < 30; i++) {
      clock += 2000;
      c.receive(JSON.stringify({ type: "hello", clientId: "client-a-1", sinceRev: 0 }));
    }
    expect(closed).toEqual([]);
    expect(msgs.some((m) => m.type === "error")).toBe(false);
  });
});
