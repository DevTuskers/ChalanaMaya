import { readFileSync } from "node:fs";
/** Integration: the official MCP SDK client against a real server over HTTP (plan §8). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "node:fs";
import path from "node:path";
import { api, put, startServer, tempDir, type TestServer } from "../test/helpers";
import { ROOT_DIR } from "../config";
import { call, callError, httpClient, makePng } from "./testClient";
import type { ChangesEvent } from "../sessions/service";

let srv: TestServer;
let client: Client;

beforeAll(async () => {
  srv = await startServer();
  client = await httpClient(srv.base);
});
afterAll(async () => {
  await client?.close();
  await srv?.close();
});

const newBoard = async () =>
  (await call(client, "create_session", { title: "Test" })).session_id as string;

describe("MCP over HTTP", () => {
  it("lists every tool, prompt and resource without enumerating boards", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        "add_elements",
        "arrange_elements",
        "clear_scene",
        "create_session",
        "delete_elements",
        "get_scene",
        "get_session_info",
        "group_elements",
        "list_component_presets",
        "move_elements",
        "place_media",
        "reorder_elements",
        "set_style",
        "ungroup_elements",
        "update_elements",
        "update_session",
        "upload_media",
      ].sort(),
    );
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["chalanamaya_guide", "draw_diagram", "explain_board", "tidy_board"]);
    await newBoard();
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources.sort()).toEqual([
      "chalanamaya://guide",
      "chalanamaya://reference/component-presets",
      "chalanamaya://reference/elements",
      "chalanamaya://reference/palette",
    ]);
    expect(resources.join()).not.toMatch(/session\//);
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate,
    );
    expect(templates.sort()).toEqual([
      "chalanamaya://session/{session_id}/outline",
      "chalanamaya://session/{session_id}/scene",
    ]);
  });

  it("reads prompts and resources", async () => {
    const guide = await client.readResource({ uri: "chalanamaya://guide" });
    expect((guide.contents[0] as { text: string }).text).toContain("name: chalanamaya");
    const p = await client.getPrompt({
      name: "draw_diagram",
      arguments: { session_id: "x", description: "a flow" },
    });
    expect(JSON.stringify(p.messages)).toContain("add_elements");
    const g = await client.getPrompt({ name: "chalanamaya_guide" });
    expect(JSON.stringify(g.messages)).toContain("Coordinates");
    const id = await newBoard();
    await call(client, "add_elements", {
      session_id: id,
      elements: [{ type: "rectangle", label: "Hi" }],
    });
    const outline = await client.readResource({ uri: `chalanamaya://session/${id}/outline` });
    expect((outline.contents[0] as { text: string }).text).toMatch(/^box \S+ "Hi"/);
    const scene = await client.readResource({ uri: `chalanamaya://session/${id}/scene` });
    expect(JSON.parse((scene.contents[0] as { text: string }).text).count).toBe(1);
  });

  it("draws a connected diagram with keys, labels, frames and groups", async () => {
    const id = await newBoard();
    const events: ChangesEvent[] = [];
    const on = (e: ChangesEvent) => events.push(e);
    srv.handle.service.events.on("changes", on);
    const r = await call(client, "add_elements", {
      session_id: `${srv.base}/s/${id}`,
      agent_name: "Claude",
      elements: [
        {
          type: "frame",
          key: "f",
          x: 0,
          y: 0,
          width: 800,
          height: 400,
          name: "Flow",
          contains: ["a", "b"],
        },
        {
          type: "rectangle",
          key: "a",
          x: "80",
          y: 80,
          label: "Start",
          fill: "mint",
          fill_style: "solid",
          group: "g",
        },
        { type: "diamond", key: "b", x: 400, y: 80, label: "Ok?", stroke: "clay", group: "g" },
        { type: "arrow", key: "c", from: "a", to: "b", label: "go", routing: "elbow" },
        { type: "note", text: "remember", color: "butter", wat: 1 },
      ],
    });
    srv.handle.service.events.off("changes", on);
    expect(r.created.map((c: { key?: string }) => c.key)).toEqual(["f", "a", "b", "c", undefined]);
    expect(r.warnings).toEqual(["elements[4].wat: unknown field, ignored"]);
    expect(events).toHaveLength(1);
    expect(events[0].origin).toEqual({ kind: "agent", name: "Claude" });
    const scene = await call(client, "get_scene", { session_id: id });
    expect(scene.count).toBe(5);
    const byKey = Object.fromEntries(
      r.created.map((c: { key?: string; id: string }) => [c.key, c.id]),
    );
    const arrow = scene.elements.find((e: { id: string }) => e.id === byKey.c);
    expect(arrow).toMatchObject({ from: byKey.a, to: byKey.b, label: "go", routing: "elbow" });
    const box = scene.elements.find((e: { id: string }) => e.id === byKey.a);
    expect(box).toMatchObject({
      label: "Start",
      fill: "mint",
      fill_style: "solid",
      frame: byKey.f,
      x: 80,
    });
    // the end sits on the box outline, not its centre
    expect(arrow.points[0][0]).toBeGreaterThanOrEqual(240);
    const info = await call(client, "get_session_info", { session_id: id });
    expect(info).toMatchObject({ element_count: 5, open_tabs: 0, url: `${srv.base}/s/${id}` });
    // moving the target keeps the connector attached
    await call(client, "move_elements", { session_id: id, ids: [byKey.b], dx: 0, dy: 200 });
    const after = await call(client, "get_scene", {
      session_id: id,
      ids: [byKey.c],
      detail: "full",
    });
    expect(after.elements[0].to).toBe(byKey.b);
    expect(after.elements[0].points.at(-1)[1]).toBeGreaterThan(200);
  });

  it("round-trips full geometry through update_elements", async () => {
    const id = await newBoard();
    const r = await call(client, "add_elements", {
      session_id: id,
      elements: [
        { type: "rectangle", key: "a", x: 0, y: 0, label: "A", angle: 30 },
        { type: "rectangle", key: "b", x: 400, y: 0 },
        { type: "arrow", key: "c", from: "a", to: "b", points: [[300, 200]] },
        {
          type: "line",
          key: "l",
          points: [
            [0, 300],
            [100, 350],
            [200, 300],
          ],
          closed: true,
        },
        {
          type: "freedraw",
          key: "d",
          points: [
            [0, 500, 0.2],
            [10, 510, 0.8],
            [30, 505, 0.5],
          ],
        },
        { type: "text", key: "t", x: 600, y: 300, text: "hello world", width: 120 },
      ],
    });
    const ids = r.created.map((c: { id: string }) => c.id);
    const full = await call(client, "get_scene", { session_id: id, ids, detail: "full" });
    expect(full.elements).toHaveLength(6);
    const before = JSON.stringify(full.elements);
    const up = await call(client, "update_elements", { session_id: id, updates: full.elements });
    expect(up.warnings).toEqual([]);
    const again = await call(client, "get_scene", { session_id: id, ids, detail: "full" });
    expect(JSON.stringify(again.elements)).toBe(before);
    const fd = again.elements.find((e: { type: string }) => e.type === "freedraw");
    expect(fd.points).toEqual([
      [0, 500, 0.2],
      [10, 510, 0.8],
      [30, 505, 0.5],
    ]);
    const arrow = again.elements.find((e: { type: string }) => e.type === "arrow");
    expect(arrow.points).toHaveLength(3);
    expect(arrow.points[1]).toEqual([300, 200]);
    // change one bend point and write it back
    arrow.points[1] = [300, 260];
    await call(client, "update_elements", { session_id: id, updates: [arrow] });
    const moved = await call(client, "get_scene", {
      session_id: id,
      ids: [arrow.id],
      detail: "full",
    });
    expect(moved.elements[0].points[1]).toEqual([300, 260]);
    expect(moved.elements[0].from).toBe(ids[0]);
  });

  it("styles, groups, reorders, arranges, deletes and clears", async () => {
    const id = await newBoard();
    const r = await call(client, "add_elements", {
      session_id: id,
      elements: [
        { type: "rectangle", x: 0, y: 0, label: "A" },
        { type: "rectangle", x: 300, y: 30 },
        { type: "rectangle", x: 500, y: 60 },
        { type: "text", x: 0, y: 300, text: "free" },
      ],
    });
    const [a, b, c, t] = r.created.map((x: { id: string }) => x.id);
    const s = await call(client, "set_style", {
      session_id: id,
      ids: [a, t],
      style: { fill: "peach", font_size: "l" },
    });
    expect(s.skipped).toEqual([{ id: t, reason: "fill: a text has no fill" }]);
    const g = await call(client, "group_elements", { session_id: id, ids: [a, b] });
    expect(g.group_id).toBeTruthy();
    const sc = await call(client, "get_scene", { session_id: id, ids: [a] });
    expect(sc.elements[0].group).toBe(g.group_id);
    await call(client, "ungroup_elements", { session_id: id, ids: [g.group_id] });
    await call(client, "reorder_elements", { session_id: id, ids: [a], to: "front" });
    const order = (await call(client, "get_scene", { session_id: id })).elements.map(
      (e: { id: string }) => e.id,
    );
    expect(order.at(-1)).toBe(a);
    await call(client, "arrange_elements", {
      session_id: id,
      ids: [a, b, c],
      align: "top",
      distribute: "horizontal",
      gap: 40,
    });
    const arranged = (await call(client, "get_scene", { session_id: id, ids: [a, b, c] })).elements;
    expect(arranged.map((e: { y: number }) => e.y)).toEqual([0, 0, 0]);
    const xs = arranged.map((e: { x: number }) => e.x).sort((p: number, q: number) => p - q);
    expect(xs).toEqual([0, 200, 400]);
    await call(client, "update_elements", { session_id: id, updates: [{ id: c, locked: true }] });
    expect((await callError(client, "delete_elements", { session_id: id, ids: [c] })).code).toBe(
      "locked",
    );
    expect(
      (await call(client, "delete_elements", { session_id: id, ids: [a] })).deleted,
    ).toHaveLength(2);
    const cleared = await call(client, "clear_scene", { session_id: id, confirm: true });
    expect(cleared.deleted_count).toBe(3);
    expect((await call(client, "get_scene", { session_id: id })).count).toBe(0);
    const set = await call(client, "update_session", {
      session_id: id,
      background: "mist",
      grid: true,
      title: "T2",
    });
    expect(set).toMatchObject({ background: "#eef6f4", grid: true, title: "T2" });
  });

  it("reports precise errors and changes nothing", async () => {
    const id = await newBoard();
    const e1 = await callError(client, "add_elements", {
      session_id: id,
      elements: [
        { type: "rectangle", key: "start" },
        { type: "arrow", from: "start", to: "b9" },
      ],
    });
    expect(e1.message).toMatch(/^elements\[1\]\.to: no element or key "b9".*Known keys: start/);
    const e2 = await callError(client, "add_elements", {
      session_id: id,
      elements: [{ type: "rectangle", fill: "plaid" }],
    });
    expect(e2.message).toMatch(/elements\[0\]\.fill: "plaid" is not a colour/);
    expect((await call(client, "get_scene", { session_id: id })).count).toBe(0);
    expect((await callError(client, "get_scene", { session_id: "nope" })).code).toBe(
      "invalid_session_id",
    );
    expect((await callError(client, "get_scene", { session_id: "A".repeat(24) })).code).toBe(
      "session_not_found",
    );
    expect(
      (await callError(client, "get_scene", { session_id: id, detail: "full" })).message,
    ).toMatch(/needs ids/);
    expect((await callError(client, "clear_scene", { session_id: id, confirm: false })).code).toBe(
      "invalid_input",
    );
  });

  it("pages consistently and refuses stale cursors", async () => {
    const id = await newBoard();
    await call(client, "add_elements", {
      session_id: id,
      elements: Array.from({ length: 5 }, (_, i) => ({ type: "rectangle", x: i * 200, y: 0 })),
    });
    const p1 = await call(client, "get_scene", { session_id: id, limit: 2 });
    expect(p1.elements).toHaveLength(2);
    const p2 = await call(client, "get_scene", {
      session_id: id,
      limit: 2,
      cursor: p1.next_cursor,
    });
    const p3 = await call(client, "get_scene", {
      session_id: id,
      limit: 2,
      cursor: p2.next_cursor,
    });
    expect(p3.next_cursor).toBeUndefined();
    const all = [...p1.elements, ...p2.elements, ...p3.elements].map((e: { id: string }) => e.id);
    expect(new Set(all).size).toBe(5);
    await call(client, "add_elements", { session_id: id, elements: [{ type: "note" }] });
    const stale = await callError(client, "get_scene", {
      session_id: id,
      limit: 2,
      cursor: p1.next_cursor,
    });
    expect(stale.code).toBe("stale_cursor");
    expect(stale.message).toMatch(/rev \d+ → \d+/);
  });

  it("uploads and places pictures, links, GIFs and videos", async () => {
    const id = await newBoard();
    const png = makePng(40, 20, [200, 30, 30]);
    const placed = await call(client, "place_media", {
      session_id: id,
      kind: "image",
      source: { data_base64: png.toString("base64"), mime_type: "image/png" },
      x: 10,
      y: 10,
    });
    const sc = await call(client, "get_scene", { session_id: id, ids: [placed.id] });
    expect(sc.elements[0]).toMatchObject({
      type: "image",
      file_id: placed.file_id,
      mime: "image/png",
      w: 40,
      h: 20,
    });
    // a link to a picture on another site: stored as a remote file, never fetched
    const link = await call(client, "place_media", {
      session_id: id,
      kind: "image",
      source: { url: "https://media.example.com/a.png" },
    });
    expect(link.warnings.join(" ")).toMatch(/placeholder.*upload_media/);
    const linked = await call(client, "get_scene", { session_id: id, ids: [link.id] });
    expect(linked.elements[0]).toMatchObject({
      type: "image",
      mime: "image/png",
      source: "remote",
      url: "https://media.example.com/a.png",
    });
    const added = await call(client, "add_elements", {
      session_id: id,
      elements: [{ type: "image", url: "https://media.example.com/a.png", x: 600, y: 0 }],
    });
    // the same link in the same board reuses the file
    const again = await call(client, "get_scene", { session_id: id, ids: [added.created[0].id] });
    expect(again.elements[0].file_id).toBe(link.file_id);
    await call(client, "update_elements", {
      session_id: id,
      updates: [{ id: placed.id, url: "https://media.example.com/b.png" }],
    });
    const rev = (await call(client, "get_scene", { session_id: id })).rev;
    for (const url of [
      "http://media.example.com/a.png",
      "https://127.0.0.1/a.png",
      "https://nas.local/a.png",
    ])
      expect(
        (await callError(client, "place_media", { session_id: id, source: { url } })).message,
      ).toMatch(/source\.url: the link must/);
    // a picture is not a gif
    expect(
      (
        await callError(client, "place_media", {
          session_id: id,
          kind: "gif",
          source: { file_id: placed.file_id },
        })
      ).message,
    ).toMatch(/not a gif/);
    expect(
      (
        await callError(client, "add_elements", {
          session_id: id,
          elements: [{ type: "component" }],
        })
      ).code,
    ).toBe("invalid_input");
    const unsafe = await callError(client, "add_elements", {
      session_id: id,
      elements: [{ type: "component", html: '<img src="x" onerror="alert(1)">', css: "" }],
    });
    expect(unsafe.code).toBe("unsafe_component");
    expect(unsafe.message).toMatch(/rule: no_event_attributes/);
    expect(
      (
        await callError(client, "add_elements", {
          session_id: id,
          elements: [{ type: "component", html: "x".repeat(20 * 1024 + 1), css: "" }],
        })
      ).code,
    ).toBe("too_large");
    expect((await call(client, "get_scene", { session_id: id })).rev).toBe(rev);
    // components (MEDIA-05/06): a preset with params and custom HTML/CSS
    const presets = await call(client, "list_component_presets", {});
    expect(presets.presets.map((p: { name: string }) => p.name)).toContain("spinner");
    const comp = await call(client, "add_elements", {
      session_id: id,
      elements: [
        { type: "component", preset: "spinner", params: { color: "#ff0000" }, x: 0, y: 0 },
        { type: "component", html: "<p>Hi</p>", css: "p{animation:a 1s}", title: "Hi" },
      ],
    });
    const cs = await call(client, "get_scene", {
      session_id: id,
      ids: comp.created.map((c: { id: string }) => c.id),
      detail: "full",
    });
    expect(cs.elements[0]).toMatchObject({
      type: "component",
      preset: "spinner",
      params: { color: "#ff0000" },
    });
    expect(cs.elements[1]).toMatchObject({ type: "component", html: "<p>Hi</p>", title: "Hi" });
    await call(client, "update_elements", {
      session_id: id,
      updates: [{ id: comp.created[0].id, params: { speed: 3 }, paused: true }],
    });
    const cu = await call(client, "get_scene", {
      session_id: id,
      ids: [comp.created[0].id],
      detail: "full",
    });
    expect(cu.elements[0]).toMatchObject({ params: { color: "#ff0000", speed: 3 }, paused: true });
    await call(client, "delete_elements", {
      session_id: id,
      ids: comp.created.map((c: { id: string }) => c.id),
    });
    // an uploaded video: size and duration read from the file, muted loop by default
    const mp4 = readFileSync(new URL("../../test-fixtures/media/clip.mp4", import.meta.url));
    const vid = await call(client, "place_media", {
      session_id: id,
      kind: "video",
      source: { data_base64: mp4.toString("base64"), mime_type: "video/mp4" },
      loop: false,
    });
    const vsc = await call(client, "get_scene", { session_id: id, ids: [vid.id] });
    expect(vsc.elements[0]).toMatchObject({
      mime: "video/mp4",
      w: 320,
      h: 180,
      duration_ms: 1000,
      loop: false,
    });
    const full = await call(client, "get_scene", { session_id: id, ids: [vid.id], detail: "full" });
    expect(full.elements[0]).toMatchObject({ type: "image", loop: false, autoplay: true });
    const gif = await call(client, "place_media", {
      session_id: id,
      kind: "gif",
      source: { url: "https://media.example.com/spin.gif" },
    });
    await call(client, "update_elements", {
      session_id: id,
      updates: [{ id: gif.id, paused: true }],
    });
    expect(
      (await call(client, "get_scene", { session_id: id, ids: [gif.id] })).elements[0],
    ).toMatchObject({ mime: "image/gif", paused: true });
    // a 10 MB picture fits; the board's file serves it
    const big = makePng(8, 8, [0, 0, 255], 10 * 1024 * 1024 - 400);
    expect(big.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    const up = await call(client, "upload_media", {
      session_id: id,
      data_base64: big.toString("base64"),
      mime_type: "image/png",
    });
    expect(up).toMatchObject({ mime_type: "image/png", width: 8, height: 8, size: big.length });
    const res = await fetch(`${srv.base}/api/sessions/${id}/files/${placed.file_id}`);
    expect(res.status).toBe(200);
  });

  it("refuses bodies over 16 MB, GET and DELETE, and foreign origins", async () => {
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { x: "a".repeat(17 * 1024 * 1024) },
    });
    const r = await fetch(`${srv.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: huge,
    });
    expect(r.status).toBe(413);
    expect((await fetch(`${srv.base}/mcp`)).status).toBe(405);
    expect((await fetch(`${srv.base}/mcp`, { method: "DELETE" })).status).toBe(405);
    const foreign = await fetch(`${srv.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(foreign.status).toBe(403);
  });

  it("is stateless: clients keep working across a real server restart", async () => {
    const dir = tempDir("cm-restart-");
    let s1: TestServer | null = await startServer({ DATA_DIR: dir });
    const port = s1.port;
    const before = await httpClient(s1.base, "before-restart");
    try {
      const id = (await call(before, "create_session", {})).session_id as string;
      await call(before, "add_elements", { session_id: id, elements: [{ type: "note" }] });
      await s1.close();
      s1 = null;
      const s2 = await startServer({ DATA_DIR: dir, PORT: String(port) });
      try {
        // the client from before the restart works again (its first request may hit the
        // closed keep-alive socket) and a fresh one works at once: no MCP session state
        const again = () => call(before, "get_scene", { session_id: id });
        expect((await again().catch(again)).count).toBe(1);
        const fresh = await httpClient(s2.base, "after-restart");
        await call(fresh, "add_elements", { session_id: id, elements: [{ type: "note" }] });
        expect((await call(fresh, "get_scene", { session_id: id })).count).toBe(2);
        await fresh.close();
      } finally {
        await s2.close();
      }
    } finally {
      await before.close().catch(() => {});
      if (s1) await s1.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses JSON-RPC batches so the rate limit counts every call", async () => {
    const one = { jsonrpc: "2.0", method: "tools/list", params: {} };
    const r = await fetch(`${srv.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify([
        { ...one, id: 1 },
        { ...one, id: 2 },
      ]),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("names upload fields without a stray leading dot", async () => {
    const id = await newBoard();
    const e = await callError(client, "upload_media", {
      session_id: id,
      data_base64: "!!",
      mime_type: "image/png",
    });
    expect(e.message).toMatch(/^data_base64: /);
    const p = await callError(client, "place_media", {
      session_id: id,
      kind: "image",
      source: { data_base64: "!!", mime_type: "image/png" },
    });
    expect(p.message).toMatch(/^source\.data_base64: /);
  });

  it("leaves every element it did not touch byte-identical", async () => {
    const id = await newBoard();
    const r = await call(client, "add_elements", {
      session_id: id,
      elements: [
        { type: "rectangle", key: "r", x: 0, y: 0, label: "Browser measured" },
        { type: "rectangle", key: "s", x: 400, y: 0, label: "Other" },
        { type: "arrow", key: "c", from: "r", to: "s", label: "link" },
      ],
    });
    const A = api(srv);
    // a browser re-measures R's label with its own fonts and pushes the result
    let rows = (await A.scene(id)).elements as {
      el: Record<string, unknown>;
      idx: string;
      version: number;
    }[];
    const label = rows.find((e) => e.el.containerId === r.created[0].id)!;
    const pushed = await A.push(
      id,
      [
        put(
          { ...label.el, width: (label.el.width as number) - 3.25, height: 27.5 },
          label.idx,
          label.version,
        ),
      ],
      { baseRev: (await A.scene(id)).rev },
    );
    expect(pushed.status).toBe(200);
    rows = (await A.scene(id)).elements;
    const sId = r.created[1].id as string;
    const touched = new Set([sId]);
    for (const e of rows) if (e.el.containerId === sId) touched.add(e.el.id as string);
    const snapshot = new Map(rows.map((e) => [e.el.id as string, JSON.stringify(e)]));
    // the agent restyles and moves S and adds new items; R, its label and nothing else changes
    await call(client, "set_style", { session_id: id, ids: [sId], style: { fill: "mint" } });
    await call(client, "add_elements", {
      session_id: id,
      elements: [
        { type: "note", text: "new" },
        { type: "text", text: "more" },
      ],
    });
    const after = (await A.scene(id)).elements as { el: Record<string, unknown> }[];
    const arrowId = r.created[2].id as string;
    for (const e of after) {
      const was = snapshot.get(e.el.id as string);
      if (!was || touched.has(e.el.id as string)) continue;
      expect(JSON.stringify(e), String(e.el.type)).toBe(was);
    }
    // the connector and R's label were among the untouched ones
    expect(after.some((e) => e.el.id === arrowId)).toBe(true);
    expect(after.some((e) => e.el.id === label.el.id)).toBe(true);
  });

  it("draws the 6-step flowchart from SKILL.md verbatim in one call", async () => {
    const skill = fs.readFileSync(path.join(ROOT_DIR, "skills", "chalanamaya", "SKILL.md"), "utf8");
    const m =
      /<!-- flowchart-example:start -->\s*```json\n([\s\S]*?)```\s*<!-- flowchart-example:end -->/.exec(
        skill,
      );
    expect(m, "SKILL.md has the flowchart example").not.toBeNull();
    const args = JSON.parse(m![1]) as { session_id: string; elements: { type: string }[] };
    const id = await newBoard();
    const r = await call(client, "add_elements", { ...args, session_id: id });
    expect(r.warnings ?? []).toEqual([]);
    const nodes = args.elements.filter((e) => e.type !== "arrow");
    expect(nodes).toHaveLength(6);
    const scene = await call(client, "get_scene", { session_id: id });
    const items = scene.elements as {
      id: string;
      type: string;
      label?: string;
      from?: unknown;
      to?: unknown;
    }[];
    expect(items.filter((e) => e.type !== "arrow")).toHaveLength(6);
    const ids = new Set(items.map((e) => e.id));
    const arrows = items.filter((e) => e.type === "arrow");
    expect(arrows).toHaveLength(6);
    // every connector is bound at both ends to a box from the same call
    for (const a of arrows) {
      expect(ids.has(a.from as string)).toBe(true);
      expect(ids.has(a.to as string)).toBe(true);
    }
    expect(
      arrows
        .map((a) => a.label)
        .filter(Boolean)
        .sort(),
    ).toEqual(["no", "yes"]);
    expect(items.filter((e) => e.type !== "arrow").every((e) => e.label)).toBe(true);
  });
});

describe("ALLOWED_ORIGINS", () => {
  it("admits a listed origin on /mcp only", async () => {
    const s = await startServer({ ALLOWED_ORIGINS: "https://inspector.example" });
    try {
      const headers = {
        "content-type": "application/json",
        origin: "https://inspector.example",
        accept: "application/json, text/event-stream",
      };
      const mcp = await fetch(`${s.base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(mcp.status).toBe(200);
      const rest = await fetch(`${s.base}/api/sessions`, {
        method: "POST",
        headers: { ...headers, "x-chalanamaya": "1" },
        body: "{}",
      });
      expect(rest.status).toBe(403);
    } finally {
      await s.close();
    }
  });
});
