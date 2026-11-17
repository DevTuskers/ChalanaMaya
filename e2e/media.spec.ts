// Phase 5: GIF and video elements (docs/features/07-media.md). Remote links
// show live in the browser (served here by a route with no CORS headers, as
// most sites do), PNG export draws a placeholder for them, the eyedropper
// survives a SecurityError, uploaded GIFs and videos animate, pause, move and
// sync, and an agent's place_media video appears live.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, httpClient, makePng } from "../server/mcp/testClient";
import { boardBox, drag, freshBoard, serverBoard, sessionId, settled } from "./helpers";

const BASE = "http://localhost:5184";
const mod = process.platform === "darwin" ? "Meta" : "Control";
const RED: [number, number, number] = [220, 30, 30];

interface Item {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  paused?: boolean;
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
        width: e.width,
        height: e.height,
        angle: e.angle,
        paused: e.paused,
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

/** Board point → page point. */
const toScreen = async (page: Page, p: { x: number; y: number }) => {
  const v = await page.evaluate(() =>
    (
      window as unknown as {
        __chalanaMedia: { view(): { zoom: number; scrollX: number; scrollY: number } };
      }
    ).__chalanaMedia.view(),
  );
  const box = await boardBox(page);
  return { x: box.x + (p.x + v.scrollX) * v.zoom, y: box.y + (p.y + v.scrollY) * v.zoom };
};

/** A hash of the board's pixels inside an item (to tell frames apart). */
const pixelsOf = async (page: Page, it: Item) => {
  const a = await toScreen(page, { x: it.x + 4, y: it.y + 4 });
  const b = await toScreen(page, { x: it.x + it.width - 4, y: it.y + it.height - 4 });
  const shot = await page.screenshot({
    clip: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
  });
  return shot.toString("base64");
};

/** Serves https://media.example.com/... from here, without CORS headers. */
const serveRemote = async (page: Page) => {
  const png = makePng(120, 80, RED);
  const webm = await readFile("test-fixtures/media/clip.webm");
  const gif = await readFile("test-fixtures/media/spin.gif");
  const seen: { url: string; referer?: string }[] = [];
  await page.route("https://media.example.com/**", (route) => {
    const url = route.request().url();
    seen.push({ url, referer: route.request().headers()["referer"] });
    const body = url.endsWith(".webm") ? webm : url.endsWith(".gif") ? gif : png;
    const type = url.endsWith(".webm")
      ? "video/webm"
      : url.endsWith(".gif")
        ? "image/gif"
        : "image/png";
    return route.fulfill({ status: 200, body, headers: { "content-type": type } });
  });
  return seen;
};

const decode = (page: Page, b64: string) =>
  page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const count = (want: number[], tol = 8) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4)
        if (want.every((v, k) => Math.abs(d[i + k] - v) <= tol)) n++;
      return n;
    };
    return { red: count([220, 30, 30]), card: count([238, 243, 241], 3) };
  }, b64);

let client: Client;
test.beforeAll(async () => {
  client = await httpClient(BASE, "e2e-media");
});
test.afterAll(async () => {
  await client?.close();
});

test("a remote static PNG shows live, exports as a placeholder and the eyedropper is safe", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const seen = await serveRemote(page);
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const placed = await call(client, "place_media", {
    session_id: id,
    source: { url: "https://media.example.com/red.png" },
    x: 100,
    y: 100,
    width: 240,
    height: 160,
    agent_name: "Claude",
  });
  const live = page.locator(`[data-testid="live-media"][data-id="${placed.id}"]`);
  await expect(live).toBeVisible({ timeout: 5000 });
  await expect(live).toHaveAttribute("data-kind", "picture");
  await expect(live).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect
    .poll(() => live.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(120);
  // fetched by the browser without a referrer, never by the server
  expect(seen.some((s) => s.url === "https://media.example.com/red.png")).toBe(true);
  expect(seen.every((s) => !s.referer)).toBe(true);
  const shot = await decode(page, (await page.screenshot()).toString("base64"));
  expect(shot.red).toBeGreaterThan(20000);

  // PNG export succeeds and shows the placeholder card, not the picture
  await page.keyboard.press(`${mod}+Shift+e`);
  const download = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const out = await readFile(await (await download).path());
  const exported = await decode(page, out.toString("base64"));
  expect(exported.red).toBe(0);
  expect(exported.card).toBeGreaterThan(10000);

  // the eyedropper still works if the board canvas refuses to be read
  await page.keyboard.press("r");
  await drag(page, { x: 600, y: 200 }, { x: 700, y: 300 });
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const real = proto.getImageData;
    let thrown = false;
    proto.getImageData = function (...args: Parameters<typeof real>) {
      if (!thrown && this.canvas.dataset.testid === "board") {
        thrown = true;
        throw new DOMException("The canvas has been tainted", "SecurityError");
      }
      return real.apply(this, args);
    };
  });
  await page.keyboard.press("i");
  await page.getByTestId("eyedropper-backgroundColor").click();
  const box = await boardBox(page);
  await page.mouse.click(box.x + 900, box.y + 600);
  await expect(page.getByText("Can't pick a colour from this media")).toBeVisible();
  await expect
    .poll(async () => {
      const b = await serverBoard(page);
      return b.elements.find((e) => e.type === "rectangle")?.backgroundColor ?? "";
    })
    .toMatch(/^#[0-9a-f]{6}$/);
  expect(errors).toEqual([]);
});

test("an uploaded GIF animates, pauses, moves and syncs to another tab", async ({
  page,
  context,
}) => {
  await freshBoard(page);
  await connected(page);
  await page.getByTestId("picture-input").setInputFiles("test-fixtures/media/spin.gif");
  await expect.poll(async () => (await items(page)).length).toBe(1);
  const [gif] = await items(page);
  expect(gif.width / gif.height).toBeCloseTo(64 / 48, 2);
  await settled(page);

  // it animates: the pixels change between frames
  const frames = new Set<string>();
  for (let i = 0; i < 6; i++) {
    frames.add(await pixelsOf(page, gif));
    await page.waitForTimeout(130);
  }
  expect(frames.size).toBeGreaterThan(1);

  const other = await context.newPage();
  await other.goto(page.url());
  await connected(other);

  // Pause syncs; a paused GIF holds still
  await expect(page.getByTestId("media-controls")).toBeVisible();
  await page.getByTestId("media-play").click();
  await expect(page.getByTestId("media-play")).toHaveText("Play");
  await expect.poll(async () => (await items(other))[0]?.paused).toBe(true);
  const still = new Set<string>();
  for (let i = 0; i < 4; i++) {
    still.add(await pixelsOf(page, (await items(page))[0]));
    await page.waitForTimeout(130);
  }
  expect(still.size).toBe(1);

  // a drag moves it, here and in the other tab
  const c = await toScreen(page, { x: gif.x + gif.width / 2, y: gif.y + gif.height / 2 });
  const box = await boardBox(page);
  await drag(page, { x: c.x - box.x, y: c.y - box.y }, { x: c.x - box.x + 150, y: c.y - box.y });
  await expect
    .poll(async () => Math.round((await items(other))[0]?.x - gif.x))
    .toBeGreaterThan(100);
  await other.close();
});

test("an agent's place_media video appears live and plays; links play in the live layer", async ({
  page,
}) => {
  await serveRemote(page);
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const webm = await readFile("test-fixtures/media/clip.webm");
  const placed = await call(client, "place_media", {
    session_id: id,
    kind: "video",
    source: { data_base64: webm.toString("base64"), mime_type: "video/webm" },
    x: 80,
    y: 80,
    agent_name: "Devin",
  });
  await expect.poll(async () => (await items(page)).map((e) => e.id)).toEqual([placed.id]);
  const [vid] = await items(page);
  // the server read the WebM size: 320 × 240
  expect(vid.width / vid.height).toBeCloseTo(4 / 3, 2);
  await expect
    .poll(
      () =>
        page.evaluate(
          (eid) =>
            (
              window as unknown as {
                __chalanaMedia: { video(id: string): { paused: boolean; muted: boolean } | null };
              }
            ).__chalanaMedia.video(eid),
          placed.id,
        ),
      { timeout: 8000 },
    )
    .toMatchObject({ paused: false, muted: true });
  const frames = new Set<string>();
  for (let i = 0; i < 6; i++) {
    frames.add(await pixelsOf(page, vid));
    await page.waitForTimeout(150);
  }
  expect(frames.size).toBeGreaterThan(1);

  // the agent can resize and rotate it; the board follows
  await call(client, "update_elements", {
    session_id: id,
    updates: [{ id: placed.id, width: 400, height: 300, angle: 15 }],
  });
  await expect.poll(async () => Math.round((await items(page))[0].width)).toBe(400);
  expect((await items(page))[0].angle).toBeCloseTo((15 * Math.PI) / 180, 3);

  // a remote WebM plays in the live layer, muted, with no referrer
  const link = await call(client, "place_media", {
    session_id: id,
    kind: "video",
    source: { url: "https://media.example.com/clip.webm" },
    x: 600,
    y: 80,
  });
  const live = page.locator(`[data-testid="live-media"][data-id="${link.id}"]`);
  await expect(live).toBeVisible({ timeout: 5000 });
  await expect(live).toHaveAttribute("data-kind", "video");
  await expect
    .poll(() =>
      live.evaluate((v: HTMLVideoElement) => ({
        ready: v.readyState >= 2,
        muted: v.muted,
        loop: v.loop,
        crossOrigin: v.crossOrigin,
      })),
    )
    .toEqual({ ready: true, muted: true, loop: true, crossOrigin: null });
});

test("a media link can be added from the menu", async ({ page }) => {
  await serveRemote(page);
  await freshBoard(page);
  await connected(page);
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-insert-media-link").click();
  await page.getByTestId("medialink-input").fill("http://media.example.com/a.gif");
  await expect(page.getByTestId("medialink-note")).toContainText("https");
  await expect(page.getByTestId("medialink-save")).toBeDisabled();
  await page.getByTestId("medialink-input").fill("https://media.example.com/spin.gif");
  await page.getByTestId("medialink-save").click();
  const live = page.locator('[data-testid="live-media"][data-kind="gif"]');
  await expect(live).toBeVisible({ timeout: 5000 });
  // the server holds the link and the item
  const board = await serverBoard(page);
  expect(board.elements.map((e) => e.type)).toEqual(["image"]);
  const sid = sessionId(page);
  const files = await page.evaluate(async (s) => {
    const r = await fetch(`/api/sessions/${s}/scene`);
    return (await r.json()).files;
  }, sid);
  expect(files).toEqual([
    expect.objectContaining({ source: "remote", url: "https://media.example.com/spin.gif" }),
  ]);
});

test("dropping a WebM file adds a playing video, and PNG export still works", async ({ page }) => {
  await freshBoard(page);
  await connected(page);
  const webm = (await readFile("test-fixtures/media/clip.webm")).toString("base64");
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "clip.webm", { type: "video/webm" }));
    const target = document.querySelector("canvas")!;
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  }, webm);
  await expect.poll(async () => (await items(page)).length, { timeout: 8000 }).toBe(1);
  const [vid] = await items(page);
  expect(vid.width / vid.height).toBeCloseTo(4 / 3, 2);
  await expect
    .poll(
      () =>
        page.evaluate(
          (eid) =>
            (
              window as unknown as {
                __chalanaMedia: { video(id: string): { paused: boolean } | null };
              }
            ).__chalanaMedia.video(eid)?.paused,
          vid.id,
        ),
      { timeout: 8000 },
    )
    .toBe(false);

  // a file that is not media is refused, leaving the board as it was
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    document
      .querySelector("canvas")!
      .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  });
  await expect(page.getByTestId("toast").filter({ hasText: "can be dropped" })).toBeVisible();
  expect(await items(page)).toHaveLength(1);

  await page.keyboard.press(`${mod}+Shift+e`);
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-confirm").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
});
