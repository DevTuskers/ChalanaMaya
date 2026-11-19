/**
 * Phase-1 acceptance tests for the Cloudflare Worker + Board Durable Object
 * (docs/plans/cloudflare-hosting-plan.md). They run the real worker fetch
 * handler over in-process fakes whose SqlStorage is real SQLite, so the
 * routing, auth and board semantics match production.
 */
import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./env";
import { FakeSocket, fakeCtx, fakeEnv } from "./test/fakes";
import { parseBoardHash } from "../src/shared/ids";
import { createImage, createShape } from "../src/scene/elements";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let env: Env;
const ctx = fakeCtx();
const call = (req: Request) => worker.fetch(req, env, ctx);

const createBoard = async () => {
  const res = await call(
    new Request("https://h.test/api/sessions", { method: "POST", body: "{}" }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    session_id: string;
    url: string;
    invite_url: string;
    owner_url: string;
  };
  const keys = parseBoardHash(new URL(body.invite_url, "https://h.test").hash);
  const owner = parseBoardHash(new URL(body.owner_url, "https://h.test").hash).owner!;
  return { id: body.session_id, key: keys.key!, owner, view: body.view_url };
};

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const api = (id: string, path = "") => `https://h.test/api/sessions/${id}${path}`;

const PUT = (id: string) => ({
  t: "put",
  el: { ...createShape("rectangle", 0, 0), id },
  idx: "a0",
  baseVersion: 0,
});

beforeEach(() => {
  env = fakeEnv();
});

describe("worker routing", () => {
  it("serves /api/health and the app shell for /s/<id>", async () => {
    const health = await call(new Request("https://h.test/api/health"));
    expect(await health.json()).toEqual({ ok: true });

    const page = await call(new Request("https://h.test/s/abcdefghij0123456789ABCD"));
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  const mcp = (body: unknown, headers: Record<string, string> = {}) =>
    call(
      new Request("https://h.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const rpc = (method: string, params?: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  it("mcp: initialize and tools/list work with no board", async () => {
    const init = await mcp(rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect((await init.json()).result.serverInfo.name).toBe("chalanamaya");
    const list = (await (await mcp(rpc("tools/list"))).json()).result.tools;
    expect(list.map((t: { name: string }) => t.name)).toContain("add_elements");
    expect(list.length).toBeGreaterThan(10);
    expect((await mcp(rpc("prompts/list"))).status).toBe(200);
  });

  it("mcp: read tools run keyless, write tools need the board key", async () => {
    const { id, key } = await createBoard();
    const call_ = (name: string, args: Record<string, unknown>, h?: Record<string, string>) =>
      mcp(rpc("tools/call", { name, arguments: args }), h);
    const scene = await call_("get_scene", { session_id: id });
    expect((await scene.json()).result.isError).toBeUndefined();
    const noKey = (await (
      await call_("add_elements", {
        session_id: id,
        elements: [{ type: "rectangle", x: 10, y: 10, width: 50, height: 40 }],
      })
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(noKey.result.isError).toBe(true);
    expect(noKey.result.content[0].text).toContain("look-only");
    const keyed = (await (
      await call_(
        "add_elements",
        {
          session_id: id,
          elements: [{ type: "rectangle", x: 10, y: 10, width: 50, height: 40 }],
        },
        bearer(key),
      )
    ).json()) as { result: { isError?: boolean; structuredContent: { rev: number } } };
    expect(keyed.result.isError).toBeUndefined();
    expect(keyed.result.structuredContent.rev).toBe(1);
    // a key inside the session_id URL fragment also authorises
    const viaUrl = await call_("get_session_info", {
      session_id: `https://h.test/s/${id}#key=${key}`,
    });
    expect((await viaUrl.json()).result.structuredContent.session_id).toBe(id);
  });

  it("mcp: create_session returns a keyed board URL", async () => {
    const res = (await (
      await mcp(rpc("tools/call", { name: "create_session", arguments: { title: "t" } }))
    ).json()) as { result: { structuredContent: { session_id: string; url: string } } };
    const { session_id, url } = res.result.structuredContent;
    expect(session_id).toHaveLength(24);
    expect(url).toContain(`/s/${session_id}#key=`);
  });

  it("rate-limits board creation per IP", async () => {
    env = fakeEnv({ rateLimit: 2 });
    const mk = () =>
      call(
        new Request("https://h.test/api/sessions", {
          method: "POST",
          body: "{}",
          headers: { "CF-Connecting-IP": "1.2.3.4" },
        }),
      );
    await mk();
    await mk();
    const third = await mk();
    expect(third.status).toBe(429);
  });
});

describe("board lifecycle", () => {
  it("create → keyed scene → ops → view-only rejected", async () => {
    const { id, key } = await createBoard();

    const scene = await call(new Request(api(id, "/scene")));
    expect(scene.status).toBe(200);
    const snap = (await scene.json()) as { keyed?: boolean; elements: unknown[] };
    expect(snap.keyed).toBe(true);
    expect(snap.elements).toEqual([]);

    // a viewer without the key cannot write
    const denied = await call(
      new Request(api(id, "/ops"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushId: "abcdefghijklmnop", baseRev: 0, ops: [PUT("e1")] }),
      }),
    );
    expect(denied.status).toBe(403);

    const ok = await call(
      new Request(api(id, "/ops"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(key) },
        body: JSON.stringify({ pushId: "abcdefghijklmnop", baseRev: 0, ops: [PUT("e1")] }),
      }),
    );
    expect(ok.status).toBe(200);
    const ack = (await ok.json()) as { rev: number; versions: Record<string, number> };
    expect(ack.rev).toBe(1);
    expect(ack.versions.e1).toBe(1);

    // same pushId answers the stored ack (duplicate)
    const dup = await call(
      new Request(api(id, "/ops"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(key) },
        body: JSON.stringify({ pushId: "abcdefghijklmnop", baseRev: 0, ops: [PUT("e1")] }),
      }),
    );
    expect((await dup.json()).duplicate).toBe(true);
  });

  it("import replaces the scene atomically", async () => {
    const { id, key } = await createBoard();
    const res = await call(
      new Request(api(id, "/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(key) },
        body: JSON.stringify({
          importId: "abcdefgh12345678",
          mode: "replace",
          elements: [{ el: PUT("e1").el, idx: "a0" }],
          settings: { title: "Imported" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const scene = await call(new Request(api(id, "/scene")));
    const snap = (await scene.json()) as { title: string; elements: unknown[] };
    expect(snap.title).toBe("Imported");
    expect(snap.elements).toHaveLength(1);
  });

  it("upload stores bytes in R2 and the file route streams them", async () => {
    const { id, key } = await createBoard();
    const up = await call(
      new Request(api(id, "/files"), {
        method: "POST",
        headers: { "Content-Type": "image/png", ...bearer(key) },
        body: PNG,
      }),
    );
    expect(up.status).toBe(201);
    const { file_id, url } = (await up.json()) as { file_id: string; url: string };

    const got = await call(new Request(`https://h.test${url}`));
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);

    // a put referencing the uploaded file is accepted
    const img = { ...createImage(0, 0, 10, 10, file_id), id: "img1" };
    const res = await call(
      new Request(api(id, "/ops"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(key) },
        body: JSON.stringify({
          pushId: "qazwsxedcrfvtgby",
          baseRev: 0,
          ops: [{ ...PUT("img1"), el: img }],
        }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("delete needs the owner key and removes the board", async () => {
    const { id, key, owner } = await createBoard();
    const denied = await call(new Request(api(id), { method: "DELETE", headers: bearer(key) }));
    expect(denied.status).toBe(403);
    const ok = await call(new Request(api(id), { method: "DELETE", headers: bearer(owner) }));
    expect(ok.status).toBe(200);
    const scene = await call(new Request(api(id, "/scene")));
    expect(scene.status).toBe(404);
  });

  it("internal _create/_evict are unreachable through the public API", async () => {
    const { id } = await createBoard();
    for (const internal of ["/_create", "/_evict"]) {
      const forged = await call(new Request(api(id, internal), { method: "POST" }));
      expect(forged.status).toBe(404);
    }
    // the board survived the forged evict
    const scene = await call(new Request(api(id, "/scene")));
    expect(scene.status).toBe(200);
  });

  it("sockets: keyed writes broadcast to peers, view-only sockets cannot push", async () => {
    const { id, key } = await createBoard();
    const state = (
      env as unknown as { _states: Map<string, { acceptWebSocket(w: unknown): void }> }
    )._states.get(id)!;
    const board = (
      env as unknown as {
        _boards: Map<string, { webSocketMessage(w: unknown, m: string): Promise<void> }>;
      }
    )._boards.get(id)!;

    const say = (ws: FakeSocket, msg: object) => board.webSocketMessage(ws, JSON.stringify(msg));
    const hello = { type: "hello", clientId: "clientid1" };
    const push = {
      type: "push",
      pushId: "abcdefghijklmnop",
      baseRev: 0,
      ops: [PUT("e1")],
    };

    // a view-only socket (no key) gets the snapshot but cannot push
    const viewer = new FakeSocket();
    state.acceptWebSocket(viewer);
    await say(viewer, hello);
    expect(viewer.messages()[0].type).toBe("snapshot");
    await say(viewer, push);
    const denied = viewer.messages().at(-1)!;
    expect(denied.type).toBe("error");
    expect((denied as { code: string }).code).toBe("forbidden");

    // a keyed socket pushes; every ready peer hears the change, not the pusher
    const editor = new FakeSocket();
    const watcher = new FakeSocket();
    state.acceptWebSocket(editor);
    state.acceptWebSocket(watcher);
    await say(editor, { ...hello, clientId: "clientid2", key });
    await say(watcher, { ...hello, clientId: "clientid3" });
    await say(editor, push);
    expect(editor.messages().at(-1)!.type).toBe("ack");
    const change = watcher.messages().at(-1)!;
    expect(change.type).toBe("changes");
    expect((change as { rev: number }).rev).toBe(1);
    expect(viewer.messages().at(-1)!.type).toBe("changes");
  });

  it("sockets: per-push re-verify honors a mid-session rotation", async () => {
    const { id, key, owner } = await createBoard();
    const state = (
      env as unknown as { _states: Map<string, { acceptWebSocket(w: unknown): void }> }
    )._states.get(id)!;
    const board = (
      env as unknown as {
        _boards: Map<string, { webSocketMessage(w: unknown, m: string): Promise<void> }>;
      }
    )._boards.get(id)!;

    const ws = new FakeSocket();
    state.acceptWebSocket(ws);
    await board.webSocketMessage(ws, JSON.stringify({ type: "hello", clientId: "clientid1", key }));

    await call(new Request(api(id, "/keys/rotate"), { method: "POST", headers: bearer(owner) }));

    await board.webSocketMessage(
      ws,
      JSON.stringify({
        type: "push",
        pushId: "abcdefghijklmnop",
        baseRev: 0,
        ops: [PUT("e1")],
      }),
    );
    const last = ws.messages().at(-1)!;
    expect(last.type).toBe("error");
    expect((last as { code: string }).code).toBe("forbidden");
  });

  it("rotation replaces both secrets", async () => {
    const { id, key, owner } = await createBoard();
    const res = await call(
      new Request(api(id, "/keys/rotate"), { method: "POST", headers: bearer(owner) }),
    );
    expect(res.status).toBe(200);
    const next = (await res.json()) as { invite_url: string };
    const newKey = parseBoardHash(new URL(next.invite_url, "https://h.test").hash).key!;

    const oldDenied = await call(
      new Request(api(id, "/ops"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(key) },
        body: JSON.stringify({ pushId: "pushpushpushpush", baseRev: 0, ops: [] }),
      }),
    );
    expect(oldDenied.status).toBe(403);
    const newOk = await call(
      new Request(api(id, "/ops"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(newKey) },
        body: JSON.stringify({ pushId: "pushpushpushpush", baseRev: 0, ops: [] }),
      }),
    );
    expect(newOk.status).toBe(200);
  });
});
