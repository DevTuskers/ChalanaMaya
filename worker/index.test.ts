/**
 * Phase-1 acceptance tests for the Cloudflare Worker + Board Durable Object
 * (docs/plans/cloudflare-hosting-plan.md). They run the real worker fetch
 * handler over in-process fakes whose SqlStorage is real SQLite, so the
 * routing, auth and board semantics match production.
 */
import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./env";
import { fakeCtx, fakeEnv } from "./test/fakes";
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

  it("answers /mcp with 501 until phase 3", async () => {
    const res = await call(new Request("https://h.test/mcp"));
    expect(res.status).toBe(501);
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
