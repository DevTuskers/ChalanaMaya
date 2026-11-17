/** Integration tests: a real server on a random port in 5000–5999 (plan §8). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreedraw } from "../src/scene/elements";
import { injectionCorpus } from "../src/shared/corpus";
import { newPushId } from "../src/shared/ids";
import {
  api,
  APP,
  GIF,
  JSON_APP,
  keys,
  PNG,
  put,
  raw,
  rect,
  startServer,
  type TestServer,
  upgradeStatus,
} from "./test/helpers";

let srv: TestServer;
let A: ReturnType<typeof api>;
beforeAll(async () => {
  srv = await startServer();
  A = api(srv);
});
afterAll(() => srv.close());

const sessionCount = (s: TestServer) =>
  (s.handle.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

describe("REST API", () => {
  it("health", async () => {
    const r = await raw(srv.port, "GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, version: expect.any(String) });
  });

  it("creates, reads and deletes a session", async () => {
    const r = await A.call("POST", "/api/sessions", { title: "Plan" });
    expect(r.status).toBe(201);
    const { session_id, url } = r.json();
    expect(session_id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(url).toBe(`/s/${session_id}`);
    const meta = await A.call("GET", `/api/sessions/${session_id}`);
    expect(meta.json()).toMatchObject({ session_id, title: "Plan", rev: 0, element_count: 0 });
    expect(meta.headers["cache-control"]).toBe("no-store");
    const scene = await A.scene(session_id);
    expect(scene).toMatchObject({ rev: 0, elements: [], files: [], tombstones: [] });
    expect((await A.call("DELETE", `/api/sessions/${session_id}`)).status).toBe(204);
    const gone = await A.call("GET", `/api/sessions/${session_id}`);
    expect(gone.status).toBe(404);
    expect(gone.json().error.code).toBe("session_not_found");
  });

  it("bad and unknown ids get 404 with the error shape", async () => {
    for (const p of [
      "/api/sessions/short",
      "/api/sessions/" + "A".repeat(24),
      "/api/sessions/" + "A".repeat(24) + "/scene",
    ]) {
      const r = await A.call("GET", p);
      expect(r.status, p).toBe(404);
      expect(r.json().error).toMatchObject({
        code: "session_not_found",
        message: expect.any(String),
      });
    }
    expect((await A.push("bad-id", [])).status).toBe(404);
    expect((await A.call("GET", "/api/nope")).json().error.code).toBe("not_found");
    const sid = await A.createSession();
    expect((await A.call("GET", `/api/sessions/${sid}/files/fXYZ`)).status).toBe(404);
    expect((await A.call("GET", `/api/sessions/${sid}/files/..%2Fetc`)).status).toBe(404);
  });

  it("refuses bad bodies with 400", async () => {
    const sid = await A.createSession();
    const r = await A.call("POST", `/api/sessions/${sid}/ops`, { pushId: "x", ops: [] });
    expect(r.status).toBe(400);
    expect(r.json().error.code).toBe("invalid_request");
    const notJson = await raw(srv.port, "POST", `/api/sessions/${sid}/ops`, {
      headers: JSON_APP,
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect((await A.call("POST", "/api/sessions", { title: "a\u0007" })).status).toBe(400);
  });

  it("the validation corpus over /ops and /import is rejected and changes nothing", async () => {
    const sid = await A.createSession();
    for (const [el, p] of injectionCorpus()) {
      const r = await A.push(sid, [put(el)]);
      expect(r.status).toBe(200);
      expect(r.json().rejected[0]).toMatchObject({ reason: "invalid", path: `ops[0].el.${p}` });
      const imp = await A.call("POST", `/api/sessions/${sid}/import`, {
        importId: newPushId(),
        mode: "add",
        elements: [{ el, idx: "a0" }],
      });
      expect(imp.status).toBe(200);
      expect(imp.json().rejected[0].reason).toBe("invalid");
    }
    const bg = await A.push(sid, [
      { t: "settings", settings: { viewBackgroundColor: "#fff</style><script>" } },
    ]);
    expect(bg.json().rejected[0].reason).toBe("invalid");
    const scene = await A.scene(sid);
    expect(scene.rev).toBe(0);
    expect(scene.elements).toEqual([]);
    expect(scene.settings).toEqual({});
  });

  it("stores a valid element byte-identically", async () => {
    const sid = await A.createSession();
    const el = rect();
    await A.push(sid, [put(el)]);
    const stored = srv.handle.db.prepare("SELECT data FROM elements WHERE id = ?").get(el.id) as {
      data: string;
    };
    expect(stored.data).toBe(JSON.stringify(el));
    expect(JSON.stringify((await A.scene(sid)).elements[0].el)).toBe(JSON.stringify(el));
  });

  it("acks carry versions for put and del; atomic rolls back on one bad op", async () => {
    const sid = await A.createSession();
    const a = rect();
    const r1 = (await A.push(sid, [put(a)])).json();
    expect(r1.versions).toEqual({ [a.id]: 1 });
    const r2 = (await A.push(sid, [{ t: "del", id: a.id, baseVersion: 1 }], { baseRev: 1 })).json();
    expect(r2.versions).toEqual({ [a.id]: 2 });
    const b = rect();
    const r3 = (
      await A.push(sid, [put(b), put({ ...rect(), opacity: 300 })], {}, "?atomic=1")
    ).json();
    expect(r3.rev).toBe(2);
    expect(r3.versions).toEqual({});
    expect(r3.rejected).toHaveLength(1);
    expect((await A.scene(sid)).elements).toEqual([]);
  });

  it("a repeated pushId gets duplicate: true and is not reapplied", async () => {
    const sid = await A.createSession();
    const body = { pushId: newPushId(), baseRev: 0, ops: [put(rect())] };
    const first = (await A.call("POST", `/api/sessions/${sid}/ops`, body)).json();
    const second = (await A.call("POST", `/api/sessions/${sid}/ops`, body)).json();
    expect(second).toEqual({ ...first, duplicate: true });
    expect((await A.scene(sid)).rev).toBe(1);
  });

  it("a 5 MB /import is one rev and one ack; repeating the importId is a duplicate", async () => {
    const sid = await A.createSession();
    const k = keys(32);
    const elements = k.map((idx, i) => {
      const fd = createFreedraw(i * 100, 0);
      const points = Array.from({ length: 4000 }, (_, j) => ({
        x: j + 0.123456789012,
        y: (j % 50) + 0.987654321098,
      }));
      return { el: { ...fd, points, width: 4000, height: 50 }, idx };
    });
    const body = { importId: newPushId(), mode: "replace", elements };
    const size = JSON.stringify(body).length;
    expect(size).toBeGreaterThan(5 * 1024 * 1024);
    const r = await A.call("POST", `/api/sessions/${sid}/import`, body);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const ack = r.json();
    expect(ack.rejected).toEqual([]);
    expect(ack.rev).toBe(1);
    expect(Object.keys(ack.versions)).toHaveLength(32);
    const scene = await A.scene(sid);
    expect(scene.rev).toBe(1);
    expect(scene.elements).toHaveLength(32);
    const again = (await A.call("POST", `/api/sessions/${sid}/import`, body)).json();
    expect(again.duplicate).toBe(true);
    expect((await A.scene(sid)).rev).toBe(1);
  });

  it("oversized bodies get 413", async () => {
    const sid = await A.createSession();
    const big = "x".repeat(2.1 * 1024 * 1024);
    const ops = await A.call("POST", `/api/sessions/${sid}/ops`, {
      pushId: newPushId(),
      baseRev: 0,
      ops: [],
      pad: big,
    });
    expect(ops.status).toBe(413);
    expect(ops.json().error.code).toBe("too_large");
    const imp = await A.call("POST", `/api/sessions/${sid}/import`, {
      importId: newPushId(),
      mode: "add",
      elements: [],
      pad: "x".repeat(12.5 * 1024 * 1024),
    });
    expect(imp.status).toBe(413);
  });
});

describe("uploads", () => {
  it("stores a picture with metadata and serves it with Range", async () => {
    const sid = await A.createSession();
    const up = await raw(srv.port, "POST", `/api/sessions/${sid}/files`, {
      headers: { ...APP, "Content-Type": "image/png" },
      body: PNG,
    });
    expect(up.status).toBe(201);
    const f = up.json();
    expect(f).toMatchObject({
      mime: "image/png",
      size: PNG.length,
      width: 1,
      height: 1,
      duration_ms: null,
    });
    expect(f.url).toBe(`/api/sessions/${sid}/files/${f.file_id}`);
    const get = await raw(srv.port, "GET", f.url);
    expect(get.status).toBe(200);
    expect(Buffer.compare(get.body, PNG)).toBe(0);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(get.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const part = await raw(srv.port, "GET", f.url, { headers: { Range: "bytes=0-7" } });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-7/${PNG.length}`);
    expect(Buffer.compare(part.body, PNG.subarray(0, 8))).toBe(0);
    expect((await A.scene(sid)).files[0]).toMatchObject({ id: f.file_id, mime: "image/png" });
  });

  it("checks types and magic bytes", async () => {
    const sid = await A.createSession();
    const send = (type: string, body: Buffer) =>
      raw(srv.port, "POST", `/api/sessions/${sid}/files`, {
        headers: { ...APP, "Content-Type": type },
        body,
      });
    const svg = await send("image/svg+xml", Buffer.from("<svg/>"));
    expect(svg.status).toBe(415);
    expect(svg.json().error.code).toBe("unsupported_type");
    expect((await send("image/png", GIF)).status).toBe(415);
    expect((await send("image/gif", Buffer.from("<html>"))).status).toBe(415);
    expect((await send("image/gif", GIF)).status).toBe(201);
  });

  it("too big is 413", async () => {
    const small = await startServer({ MAX_IMAGE_BYTES: "50" });
    try {
      const sid = await api(small).createSession();
      const r = await raw(small.port, "POST", `/api/sessions/${sid}/files`, {
        headers: { ...APP, "Content-Type": "image/png" },
        body: Buffer.concat([PNG, Buffer.alloc(100)]),
      });
      expect(r.status).toBe(413);
      expect(r.json().error.code).toBe("too_large");
    } finally {
      await small.close();
    }
  });
});

describe("quotas return 507", () => {
  it("MAX_SESSIONS", async () => {
    const s = await startServer({ MAX_SESSIONS: "1" });
    try {
      await api(s).createSession();
      const r = await api(s).call("POST", "/api/sessions", {});
      expect(r.status).toBe(507);
      expect(r.json().error.code).toBe("too_many_sessions");
    } finally {
      await s.close();
    }
  });

  it("MAX_TOTAL_MEDIA_BYTES", async () => {
    const s = await startServer({ MAX_TOTAL_MEDIA_BYTES: String(PNG.length) });
    try {
      const sid = await api(s).createSession();
      const up = (type: string, body: Buffer) =>
        raw(s.port, "POST", `/api/sessions/${sid}/files`, {
          headers: { ...APP, "Content-Type": type },
          body,
        });
      expect((await up("image/png", PNG)).status).toBe(201);
      const r = await up("image/gif", GIF);
      expect(r.status).toBe(507);
      expect(r.json().error.code).toBe("storage_full");
    } finally {
      await s.close();
    }
  });

  it("MAX_DB_BYTES", async () => {
    const s = await startServer({ MAX_DB_BYTES: "1" });
    try {
      const r = await api(s).call("POST", "/api/sessions", {});
      expect(r.status).toBe(507);
      expect(r.json().error.code).toBe("storage_full");
    } finally {
      await s.close();
    }
  });
});

describe("host check", () => {
  const sid = "A".repeat(24);
  it("refuses a wrong Host with the right shape per route", async () => {
    for (const host of ["evil.example", `evil.example:${srv.port}`]) {
      const a = await raw(srv.port, "GET", "/api/health", { headers: { host } });
      expect(a.status).toBe(403);
      expect(a.json()).toEqual({
        error: { code: "host_not_allowed", message: expect.any(String) },
      });
      const m = await raw(srv.port, "POST", "/mcp", {
        headers: { host, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(m.status).toBe(403);
      expect(m.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
      const page = await raw(srv.port, "GET", `/s/${sid}`, { headers: { host } });
      expect(page.status).toBe(403);
      expect(page.headers["content-type"]).toMatch(/^text\/plain/);
    }
  });

  it("accepts localhost:<port>, [::1]:<port> and 127.0.0.1", async () => {
    for (const host of [
      `localhost:${srv.port}`,
      `[::1]:${srv.port}`,
      `127.0.0.1:${srv.port}`,
      "localhost",
    ])
      expect((await raw(srv.port, "GET", "/api/health", { headers: { host } })).status, host).toBe(
        200,
      );
  });

  it("accepts an ALLOWED_HOSTS entry", async () => {
    const s = await startServer({ ALLOWED_HOSTS: "MyBoard.lan:5183,fe80::1" });
    try {
      for (const host of [`myboard.lan:${s.port}`, `[fe80::1]:${s.port}`])
        expect((await raw(s.port, "GET", "/api/health", { headers: { host } })).status, host).toBe(
          200,
        );
      expect(
        (await raw(s.port, "GET", "/api/health", { headers: { host: "other.lan" } })).status,
      ).toBe(403);
    } finally {
      await s.close();
    }
  });
});

describe("cross-site request guard", () => {
  it("a text/plain POST from a foreign Origin gets 403 and creates no session", async () => {
    const before = sessionCount(srv);
    const r = await raw(srv.port, "POST", "/api/sessions", {
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: "x",
    });
    expect(r.status).toBe(403);
    expect(r.json().error.code).toBe("cross_site_refused");
    // even if the page could add the header, the Origin is refused
    const withHeader = await raw(srv.port, "POST", "/api/sessions", {
      headers: { ...APP, Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: "x",
    });
    expect(withHeader.status).toBe(403);
    expect(sessionCount(srv)).toBe(before);
  });

  it("refuses requests without X-ChalanaMaya, with Sec-Fetch-Site: cross-site, or from another port", async () => {
    const before = sessionCount(srv);
    expect(
      (
        await raw(srv.port, "POST", "/api/sessions", {
          headers: { "Content-Type": "text/plain" },
          body: "x",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await raw(srv.port, "POST", "/api/sessions", {
          headers: { ...APP, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await raw(srv.port, "POST", "/api/sessions", {
          headers: { ...APP, Origin: "http://localhost:5000" },
        })
      ).status,
    ).toBe(403);
    expect(sessionCount(srv)).toBe(before);
  });

  it("DELETE, /ops and uploads from a foreign Origin are refused", async () => {
    const sid = await A.createSession();
    const evil = { Origin: "https://evil.example" };
    expect((await A.call("DELETE", `/api/sessions/${sid}`, undefined, evil)).status).toBe(403);
    expect((await A.push(sid, [put(rect())], {}, "")).status).toBe(200);
    expect(
      (
        await A.call(
          "POST",
          `/api/sessions/${sid}/ops`,
          { pushId: newPushId(), baseRev: 0, ops: [] },
          evil,
        )
      ).status,
    ).toBe(403);
    const up = await raw(srv.port, "POST", `/api/sessions/${sid}/files`, {
      headers: { ...APP, ...evil, "Content-Type": "image/png" },
      body: PNG,
    });
    expect(up.status).toBe(403);
    expect((await A.call("GET", `/api/sessions/${sid}`)).status).toBe(200);
  });

  it("the app's own requests pass", async () => {
    const origin = `http://localhost:${srv.port}`;
    const r = await A.call(
      "POST",
      "/api/sessions",
      {},
      { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    );
    expect(r.status).toBe(201);
    const sid = r.json().session_id;
    expect(
      (await A.call("DELETE", `/api/sessions/${sid}`, undefined, { Origin: origin })).status,
    ).toBe(204);
  });

  it("non-canonical paths (/API, /Api, /mcp/, /MCP) are guarded too and create no session", async () => {
    const before = sessionCount(srv);
    const evil = { Origin: "https://evil.example", "Content-Type": "text/plain" };
    for (const p of ["/API/sessions", "/Api/sessions", "/api/sessions/", "/API/sessions/"]) {
      const r = await raw(srv.port, "POST", p, { headers: evil, body: "x" });
      expect(r.status, p).toBe(403);
      expect(r.json().error.code, p).toBe("cross_site_refused");
    }
    const site = await raw(srv.port, "POST", "/Api/sessions", {
      headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "text/plain" },
      body: "x",
    });
    expect(site.status).toBe(403);
    // with no header at all a mis-cased path is still refused (needs X-ChalanaMaya)
    expect(
      (await raw(srv.port, "POST", "/API/sessions", { headers: { "Content-Type": "text/plain" } }))
        .status,
    ).toBe(403);
    // the app's header on a mis-cased path passes the guard but routes nowhere
    expect((await raw(srv.port, "POST", "/API/sessions", { headers: APP })).status).toBe(404);
    for (const p of ["/mcp/", "/MCP", "/Mcp/", "/mcp?x=1"]) {
      const r = await raw(srv.port, "POST", p, {
        headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(r.status, p).toBe(403);
      expect(r.json().jsonrpc, p).toBe("2.0");
    }
    // other paths: a state-changing request from another site is refused too
    expect((await raw(srv.port, "POST", "/", { headers: evil, body: "x" })).status).toBe(403);
    expect(sessionCount(srv)).toBe(before);
  });

  it("/mcp: foreign Origin refused by default, ALLOWED_ORIGINS admits it for /mcp only", async () => {
    const inspector = { Origin: "http://localhost:6274", "Content-Type": "application/json" };
    const refused = await raw(srv.port, "POST", "/mcp", { headers: inspector, body: "{}" });
    expect(refused.status).toBe(403);
    expect(refused.json().jsonrpc).toBe("2.0");
    const s = await startServer({ ALLOWED_ORIGINS: "http://localhost:6274" });
    try {
      const ok = await raw(s.port, "POST", "/mcp", { headers: inspector, body: "{}" });
      expect(ok.status).not.toBe(403); // passes the guard (the endpoint arrives in phase 4)
      const rest = await raw(s.port, "POST", "/api/sessions", {
        headers: { ...APP, Origin: "http://localhost:6274" },
      });
      expect(rest.status).toBe(403);
    } finally {
      await s.close();
    }
  });
});

describe("socket upgrades", () => {
  it("refuses a foreign Host or Origin, and answers 404 otherwise (no sockets yet)", async () => {
    expect(await upgradeStatus(srv.port, "/api/sessions/x/socket", { Host: "evil.example" })).toBe(
      403,
    );
    expect(
      await upgradeStatus(srv.port, "/api/sessions/x/socket", { Origin: "https://evil.example" }),
    ).toBe(403);
    expect(
      await upgradeStatus(srv.port, "/api/sessions/x/socket", { "Sec-Fetch-Site": "cross-site" }),
    ).toBe(403);
    expect(
      await upgradeStatus(srv.port, "/api/sessions/x/socket", {
        Origin: `http://localhost:${srv.port}`,
      }),
    ).toBe(404);
  });
});

describe("app pages and headers", () => {
  it("serves the app at / and /s/<id>, 404 for a bad id", async () => {
    const home = await raw(srv.port, "GET", "/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("ChalanaMaya test app");
    const board = await raw(srv.port, "GET", `/s/${"A".repeat(24)}`);
    expect(board.status).toBe(200);
    expect(board.text).toContain("ChalanaMaya test app");
    const bad = await raw(srv.port, "GET", "/s/nope");
    expect(bad.status).toBe(404);
    expect((await raw(srv.port, "GET", "/assets/app.js")).status).toBe(200);
  });

  it("the CSP names ws:// and wss:// for the request host; Referrer-Policy is set", async () => {
    const r = await raw(srv.port, "GET", "/", { headers: { host: `[::1]:${srv.port}` } });
    const csp = r.headers["content-security-policy"] as string;
    expect(csp).toContain(`ws://[::1]:${srv.port} wss://[::1]:${srv.port}`);
    expect(csp).toContain("script-src 'self';");
    expect(r.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("rate limits and TRUST_PROXY", () => {
  const create = (s: TestServer, ip: string) =>
    raw(s.port, "POST", "/api/sessions", { headers: { ...APP, "X-Forwarded-For": ip } });

  it("with TRUST_PROXY=loopback two X-Forwarded-For values get separate buckets", async () => {
    const s = await startServer({
      RATE_LIMITS: "on",
      RATE_LIMIT_SESSIONS: "2",
      TRUST_PROXY: "loopback",
    });
    try {
      expect((await create(s, "203.0.113.1")).status).toBe(201);
      expect((await create(s, "203.0.113.1")).status).toBe(201);
      const limited = await create(s, "203.0.113.1");
      expect(limited.status).toBe(429);
      expect(limited.json().error.code).toBe("rate_limited");
      expect((await create(s, "203.0.113.2")).status).toBe(201);
    } finally {
      await s.close();
    }
  });

  it("with TRUST_PROXY off they share one bucket", async () => {
    const s = await startServer({ RATE_LIMITS: "on", RATE_LIMIT_SESSIONS: "2" });
    try {
      expect((await create(s, "203.0.113.1")).status).toBe(201);
      expect((await create(s, "203.0.113.2")).status).toBe(201);
      expect((await create(s, "203.0.113.3")).status).toBe(429);
    } finally {
      await s.close();
    }
  });
});
