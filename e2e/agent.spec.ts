// Phase 4: agents draw on an open board through MCP (plan §8). Edits show live
// with a notice, user and agent edits mix without loss, connectors stay bound,
// Restore undoes an agent's clear, and an uploaded picture renders, exports
// and works with the eyedropper while links are refused.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, callError, httpClient, makePng } from "../server/mcp/testClient";
import { drag, freshBoard, sessionId, settled, boardBox } from "./helpers";

const BASE = "http://localhost:5184";
const LIVE_MS = 2000;
const mod = process.platform === "darwin" ? "Meta" : "Control";

interface Item {
  id: string;
  type: string;
  x: number;
  y: number;
  backgroundColor: string;
  containerId?: string | null;
}

const items = (page: Page): Promise<Item[]> =>
  page.evaluate(() =>
    (
      window as unknown as { __chalanaSync: { host: { scene(): { elements: Item[] } } } }
    ).__chalanaSync.host
      .scene()
      .elements.map((e) => ({
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        backgroundColor: e.backgroundColor,
        containerId: e.containerId,
      })),
  );

const connected = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __chalanaSync?: { connected: boolean } }).__chalanaSync
              ?.connected ?? false,
        ),
      { timeout: 10000 },
    )
    .toBe(true);

let client: Client;
test.beforeAll(async () => {
  client = await httpClient(BASE, "e2e");
});
test.afterAll(async () => {
  await client?.close();
});

test("an agent's diagram shows live; user and agent edits mix; Restore undoes a clear", async ({
  page,
}) => {
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const r = await call(client, "add_elements", {
    session_id: page.url(),
    agent_name: "Claude",
    elements: [
      { type: "frame", key: "f", x: 120, y: 120, width: 760, height: 400, name: "Flow" },
      { type: "rectangle", key: "a", x: 200, y: 200, width: 160, height: 80, label: "Start" },
      { type: "rectangle", key: "b", x: 600, y: 200, width: 160, height: 80, label: "End" },
      { type: "arrow", key: "c", from: "a", to: "b" },
      { type: "note", x: 960, y: 200, text: "agent note" },
    ],
  });
  const key = Object.fromEntries(
    r.created.map((c: { key?: string; id: string }) => [c.key ?? "note", c.id]),
  );
  await expect
    .poll(async () => (await items(page)).filter((e) => !e.containerId).length, {
      timeout: LIVE_MS,
    })
    .toBe(5);
  await expect(page.getByTestId("toast").last()).toContainText("Claude added 5 items");
  await expect(page.getByTestId("agent-show")).toBeVisible();

  // the user drags box a down; the agent sees it and the connector stays bound
  await drag(page, { x: 230, y: 230 }, { x: 230, y: 430 }, 10);
  await settled(page);
  let scene = await call(client, "get_scene", {
    session_id: id,
    ids: [key.a, key.c],
    detail: "full",
  });
  const boxA = scene.elements.find((e: { id: string }) => e.id === key.a);
  expect(boxA.y).toBeCloseTo(400, -1);
  const arrow = scene.elements.find((e: { id: string }) => e.id === key.c);
  expect([arrow.from, arrow.to]).toEqual([key.a, key.b]);
  expect(arrow.points[0][1]).toBeGreaterThan(380);

  // the agent moves b while the user drags a: both kept, the connector attached at both ends
  const b0 = await boardBox(page);
  await page.mouse.move(b0.x + 230, b0.y + 430);
  await page.mouse.down();
  await page.mouse.move(b0.x + 230, b0.y + 470, { steps: 4 });
  await call(client, "move_elements", {
    session_id: id,
    ids: [key.b],
    dx: 0,
    dy: -100,
    agent_name: "Claude",
  });
  await expect
    .poll(async () => (await items(page)).find((e) => e.id === key.b)?.y, { timeout: LIVE_MS })
    .toBe(100);
  await page.mouse.move(b0.x + 230, b0.y + 530, { steps: 4 });
  await page.mouse.up();
  await settled(page);
  scene = await call(client, "get_scene", {
    session_id: id,
    ids: [key.a, key.b, key.c],
    detail: "full",
  });
  const [a2, b2, c2] = [key.a, key.b, key.c].map((k) =>
    scene.elements.find((e: { id: string }) => e.id === k),
  );
  expect(a2.y).toBeCloseTo(500, -1);
  expect(b2.y).toBe(100);
  expect([c2.from, c2.to]).toEqual([key.a, key.b]);
  const [sx, sy] = c2.points[0];
  const [ex, ey] = c2.points.at(-1);
  // the ends sit on (or just outside) the boxes they are attached to
  expect(sx).toBeGreaterThanOrEqual(a2.x - 12);
  expect(sx).toBeLessThanOrEqual(a2.x + a2.width + 12);
  expect(sy).toBeGreaterThanOrEqual(a2.y - 12);
  expect(ex).toBeGreaterThanOrEqual(b2.x - 12);
  expect(ey).toBeLessThanOrEqual(b2.y + b2.height + 12);
  // the page agrees
  const pageArrow = await page.evaluate(
    (cid) =>
      (
        window as unknown as {
          __chalanaSync: {
            host: {
              scene(): {
                elements: {
                  id: string;
                  startBinding?: { elementId: string } | null;
                  endBinding?: { elementId: string } | null;
                }[];
              };
            };
          };
        }
      ).__chalanaSync.host
        .scene()
        .elements.find((e) => e.id === cid),
    key.c,
  );
  expect(pageArrow?.startBinding?.elementId).toBe(key.a);
  expect(pageArrow?.endBinding?.elementId).toBe(key.b);

  // the agent's edit survives the user's undo of their own drag
  await page.keyboard.press(`${mod}+z`);
  await settled(page);
  expect((await items(page)).find((e) => e.id === key.b)?.y).toBe(100);

  // clear and Restore
  const before = (await items(page)).length;
  const count = (await call(client, "get_scene", { session_id: id })).count;
  await call(client, "clear_scene", { session_id: id, confirm: true, agent_name: "Claude" });
  await expect.poll(async () => (await items(page)).length, { timeout: LIVE_MS }).toBe(0);
  await expect(page.getByTestId("toast").last()).toContainText("Claude cleared the board");
  await page.getByTestId("agent-restore").click();
  await expect.poll(async () => (await items(page)).length).toBe(before);
  await settled(page);
  expect((await call(client, "get_scene", { session_id: id })).count).toBe(count);
});

const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const near = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("an uploaded PNG renders, exports and works with the eyedropper; links are refused", async ({
  page,
}) => {
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const teal: [number, number, number] = [0, 127, 120];
  const png = makePng(200, 100, teal);
  const refused = await callError(client, "place_media", {
    session_id: id,
    kind: "image",
    source: { url: "https://example.com/pic.png" },
  });
  expect(refused.code).toBe("links_not_supported_yet");
  const placed = await call(client, "place_media", {
    session_id: id,
    kind: "image",
    source: { data_base64: png.toString("base64"), mime_type: "image/png" },
    x: 200,
    y: 200,
    agent_name: "Claude",
  });
  await expect
    .poll(async () => (await items(page)).map((e) => e.type), { timeout: LIVE_MS })
    .toEqual(["image"]);
  expect((await items(page))[0].id).toBe(placed.id);

  // it renders: the board's pixels under the picture are teal
  await expect
    .poll(async () => {
      const shot = await page.getByTestId("board").screenshot();
      return page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(300, 250, 1, 1).data.slice(0, 3));
      }, shot.toString("base64"));
    })
    .toEqual(teal);

  // eyedropper: a new box takes the picture's colour as its fill
  await page.keyboard.press("r");
  await drag(page, { x: 600, y: 200 }, { x: 700, y: 300 });
  await page.getByTestId("fill-transparent").click();
  await page.keyboard.press("i");
  await page.getByTestId("eyedropper-backgroundColor").click();
  await page.mouse.click((await boardBox(page)).x + 300, (await boardBox(page)).y + 250);
  await expect
    .poll(async () => {
      const box = (await items(page)).find((e) => e.type === "rectangle");
      return box ? near(hex(box.backgroundColor), teal) : false;
    })
    .toBe(true);
  await page.keyboard.press("Escape");

  // export: the PNG contains the picture
  await page.keyboard.press(`${mod}+Shift+e`);
  const download = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const out = await readFile(await (await download).path());
  const found = await page.evaluate(
    async ({ b64, want }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4)
        if (
          Math.abs(d[i] - want[0]) <= 6 &&
          Math.abs(d[i + 1] - want[1]) <= 6 &&
          Math.abs(d[i + 2] - want[2]) <= 6
        )
          n++;
      return n;
    },
    { b64: out.toString("base64"), want: teal },
  );
  // the picture (200×100) plus the sampled box fill, at export scale ≥ 1
  expect(found).toBeGreaterThan(15000);
});

test("the Connect an agent dialog shows the MCP address, the board id and snippets", async ({
  page,
}) => {
  await freshBoard(page);
  const id = sessionId(page);
  await page.getByTestId("menu-button").click();
  await page.getByTestId("session-connect-agent").click();
  const dialog = page.getByTestId("connect-agent-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("connect-mcp-url")).toHaveText(`${BASE}/mcp`);
  await expect(page.getByTestId("connect-session-id")).toHaveText(id);
  await expect(page.getByTestId("connect-snippet-http")).toContainText(`"url": "${BASE}/mcp"`);
  await expect(page.getByTestId("connect-snippet-stdio")).toContainText("dist-server/stdio.js");
  await expect(page.getByTestId("connect-snippet-prompt")).toContainText(id);
  await expect(page.getByTestId("connect-warning")).toContainText("Anyone with the board id");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

const sceneRows = (page: Page, id: string) =>
  page.evaluate(async (sid) => {
    const r = await fetch(`/api/sessions/${sid}/scene`);
    return (await r.json()).elements as {
      el: { id: string; type: string; x: number; y: number; width: number; height: number };
      needsLayout: boolean;
    }[];
  }, id);

test("text an agent adds while no tab is open is laid out by the first tab that opens it", async ({
  page,
}) => {
  const id = (await call(client, "create_session", {})).session_id as string;
  const r = await call(client, "add_elements", {
    session_id: id,
    agent_name: "Claude",
    elements: [
      { type: "diamond", key: "d", x: 100, y: 100, label: "A long decision label here" },
      { type: "rectangle", key: "r", x: 400, y: 100, label: "Plain words", font: "normal" },
      { type: "text", key: "t", x: 100, y: 400, text: "monospace text", font: "code" },
    ],
  });
  expect(r.created).toHaveLength(3);
  await page.goto("about:blank");
  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("board")).toBeVisible();
  // the flag is cleared by the page's one-time correction
  await expect
    .poll(async () => (await sceneRows(page, id)).filter((e) => e.needsLayout).length, {
      timeout: 5000,
    })
    .toBe(0);
  await settled(page);
  // and the server's geometry is what the page shows
  const rows = await sceneRows(page, id);
  const shown = await page.evaluate(() =>
    (
      window as unknown as {
        __chalanaSync: {
          host: {
            scene(): {
              elements: { id: string; x: number; y: number; width: number; height: number }[];
            };
          };
        };
      }
    ).__chalanaSync.host
      .scene()
      .elements.map((e) => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height })),
  );
  expect(
    rows.map((e) => ({
      id: e.el.id,
      x: e.el.x,
      y: e.el.y,
      width: e.el.width,
      height: e.el.height,
    })),
  ).toEqual(shown);
  // the diamond keeps a sensible size (no runaway growth from estimated metrics)
  const diamond = rows.find((e) => e.el.type === "diamond")!;
  expect(diamond.el.height).toBeLessThan(260);
});

test("server-measured text widths are within 5 % of the browser's for the three fonts", async ({
  page,
}) => {
  const strings = ["Hello board", "A long decision label here", "Quarterly plan 2025: v2.1"];
  const fonts = ["hand", "normal", "code"] as const;
  const id = (await call(client, "create_session", {})).session_id as string;
  const elements = fonts.flatMap((font, i) =>
    strings.map((text, j) => ({ type: "text", x: 0, y: (i * 3 + j) * 60, text, font })),
  );
  const r = await call(client, "add_elements", { session_id: id, elements });
  // read the server's widths before any page opens the board
  const scene = await call(client, "get_scene", {
    session_id: id,
    ids: r.created.map((c: { id: string }) => c.id),
    detail: "full",
  });
  const serverWidths = r.created.map(
    (c: { id: string }) =>
      scene.elements.find((e: { id: string; width: number }) => e.id === c.id).width as number,
  );
  await freshBoard(page);
  const css = {
    hand: '"Kalam", "Comic Sans MS", "Segoe Print", cursive',
    normal: '"Source Sans 3", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    code: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
  };
  const browserWidths = await page.evaluate(
    async ({ fonts, strings, css }) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const out: number[] = [];
      for (const f of fonts) {
        const font = `20px ${css[f]}`;
        await document.fonts.load(font);
        ctx.font = font;
        for (const s of strings) out.push(ctx.measureText(s).width);
      }
      return out;
    },
    { fonts: [...fonts], strings, css },
  );
  expect(serverWidths).toHaveLength(9);
  serverWidths.forEach((w: number, i: number) => {
    const b = browserWidths[i];
    expect(Math.abs(w - b) / b, `${fonts[Math.floor(i / 3)]}: "${strings[i % 3]}"`).toBeLessThan(
      0.05,
    );
  });
});

test("agent edits during a user's drag, Esc and two undos are all kept", async ({ page }) => {
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  // the user draws box U (one undo step)
  await page.keyboard.press("r");
  await drag(page, { x: 200, y: 200 }, { x: 320, y: 280 });
  await page.keyboard.press("Escape");
  await settled(page);
  const userBox = (await items(page))[0];
  // the agent adds box V
  const v = await call(client, "add_elements", {
    session_id: id,
    agent_name: "Claude",
    elements: [{ type: "rectangle", x: 700, y: 200, width: 120, height: 80 }],
  });
  const vId = v.created[0].id as string;
  await expect.poll(async () => (await items(page)).length, { timeout: LIVE_MS }).toBe(2);

  // drag U by its edge (an unfilled box is picked by its outline) and hold it while the agent adds 3 items and recolours V
  const b = await boardBox(page);
  await page.mouse.move(b.x + 200, b.y + 240);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + 300, { steps: 4 });
  const three = await call(client, "add_elements", {
    session_id: id,
    agent_name: "Claude",
    elements: [
      { type: "ellipse", x: 200, y: 600, width: 80, height: 60 },
      { type: "note", x: 400, y: 600, text: "from the agent" },
      { type: "text", x: 600, y: 600, text: "agent text" },
    ],
  });
  const threeIds = three.created.map((c: { id: string }) => c.id) as string[];
  await call(client, "set_style", {
    session_id: id,
    agent_name: "Claude",
    ids: [vId],
    style: { fill: "rose", fill_style: "solid" },
  });
  await expect
    .poll(async () => (await items(page)).find((e) => e.id === vId)?.backgroundColor, {
      timeout: LIVE_MS,
    })
    .toBe("#f7c6c1");
  await page.mouse.move(b.x + 200, b.y + 360, { steps: 4 });
  await page.mouse.up();
  await settled(page);
  const moved = (await items(page)).find((e) => e.id === userBox.id)!;
  expect(moved.y).toBeCloseTo(userBox.y + 120, -1);
  // a second drag cancelled with Esc
  await page.mouse.move(b.x + 200, b.y + 360);
  await page.mouse.down();
  await page.mouse.move(b.x + 400, b.y + 420, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await settled(page);
  expect((await items(page)).find((e) => e.id === userBox.id)!.y).toBe(moved.y);
  // undo the drag, then the user's box
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await settled(page);
  const now = await items(page);
  expect(now.some((e) => e.id === userBox.id)).toBe(false);
  for (const t of threeIds) expect(now.some((e) => e.id === t)).toBe(true);
  expect(now.find((e) => e.id === vId)?.backgroundColor).toBe("#f7c6c1");
  const scene = await call(client, "get_scene", { session_id: id });
  const ids = scene.elements.map((e: { id: string }) => e.id);
  for (const t of [...threeIds, vId]) expect(ids).toContain(t);
  expect(ids).not.toContain(userBox.id);
  expect(scene.elements.find((e: { id: string }) => e.id === vId).fill).toBe("rose");
});
