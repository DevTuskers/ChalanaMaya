// Phase 5 performance (plan §8, MEDIA-08): 2,000 shapes, 4 uploaded GIFs and
// 3 uploaded videos in view. The animation loop keeps its frame cost under
// budget or steps its rate down by itself; a 1 s drag while media plays has
// no long task over 50 ms and ends at the pointer; an injected 30 ms frame
// cost (?perf=slow) steps down to 10 fps and then pauses with a notice; and
// at most 24 live items are mounted.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, httpClient } from "../server/mcp/testClient";
import { boardBox } from "./helpers";

const BASE = "http://localhost:5184";

interface LoopStats {
  fps: number;
  paused: boolean;
  average: number;
  frames: number;
}
const loop = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __chalanaMedia: { loop(): LoopStats } }).__chalanaMedia.loop(),
  );
const ready = (page: Page, n: number) =>
  expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __chalanaSync?: { host: { scene(): { elements: unknown[] } } };
              }
            ).__chalanaSync?.host.scene().elements.length ?? 0,
        ),
      { timeout: 20000 },
    )
    .toBe(n);

let client: Client;
let heavy: string;
test.beforeAll(async () => {
  client = await httpClient(BASE, "e2e-perf");
  heavy = (await call(client, "create_session", { title: "Perf" })).session_id;
  // 2,000 small shapes filling the view
  for (let chunk = 0; chunk < 10; chunk++) {
    const elements = Array.from({ length: 200 }, (_, k) => {
      const i = chunk * 200 + k;
      return {
        type: i % 3 === 0 ? "ellipse" : "rectangle",
        x: 20 + (i % 50) * 24,
        y: 20 + Math.floor(i / 50) * 18,
        width: 18,
        height: 12,
      };
    });
    await call(client, "add_elements", { session_id: heavy, elements });
  }
  const gif = (await readFile("test-fixtures/media/spin.gif")).toString("base64");
  const webm = (await readFile("test-fixtures/media/clip.webm")).toString("base64");
  const g = await call(client, "upload_media", {
    session_id: heavy,
    data_base64: gif,
    mime_type: "image/gif",
  });
  const v = await call(client, "upload_media", {
    session_id: heavy,
    data_base64: webm,
    mime_type: "video/webm",
  });
  for (let i = 0; i < 4; i++)
    await call(client, "place_media", {
      session_id: heavy,
      kind: "gif",
      source: { file_id: g.file_id },
      x: 60 + i * 200,
      y: 300,
      width: 160,
      height: 120,
    });
  for (let i = 0; i < 3; i++)
    await call(client, "place_media", {
      session_id: heavy,
      kind: "video",
      source: { file_id: v.file_id },
      x: 60 + i * 260,
      y: 480,
      width: 240,
      height: 180,
    });
});
test.afterAll(async () => {
  await client?.close();
});

test("frames stay under budget or step down; a drag has no long task and lands at the pointer", async ({
  page,
}) => {
  await page.goto(`/s/${heavy}?perf=1`);
  await ready(page, 2007);
  await page.waitForTimeout(5000);
  const s = await loop(page);
  expect(s.frames).toBeGreaterThan(10);
  expect(s.paused).toBe(false);
  expect(s.average < 16 || s.fps <= 15).toBe(true);

  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(e.duration);
    }).observe({ type: "longtask" });
  });
  // drag the first shape (20, 20) for one second while the media plays; on a
  // board this big the drag paints over a still layer (MEDIA-08)
  const box = await boardBox(page);
  const view = await page.evaluate(() =>
    (
      window as unknown as {
        __chalanaMedia: { view(): { zoom: number; scrollX: number; scrollY: number } };
      }
    ).__chalanaMedia.view(),
  );
  const at = (x: number, y: number) => ({
    x: box.x + (x + view.scrollX) * view.zoom,
    y: box.y + (y + view.scrollY) * view.zoom,
  });
  const from = at(29, 26);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Alt turns object snapping off, so the shape follows the pointer exactly
  await page.keyboard.down("Alt");
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + i * 10, from.y + i * 8);
    await page.waitForTimeout(1000 / steps);
  }
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const long = await page.evaluate(
    () => (window as unknown as { __longTasks: number[] }).__longTasks,
  );
  expect(long.filter((d) => d > 50)).toEqual([]);
  const moved = await page.evaluate(
    () =>
      (
        window as unknown as {
          __chalanaSync: { host: { scene(): { elements: { x: number; y: number }[] } } };
        }
      ).__chalanaSync.host.scene().elements[0],
  );
  expect(Math.round(moved.x)).toBe(20 + Math.round((steps * 10) / view.zoom));
  expect(Math.round(moved.y)).toBe(20 + Math.round((steps * 8) / view.zoom));
});

test("an injected 30 ms frame cost steps down to 10 fps, then pauses with a notice", async ({
  page,
}) => {
  await page.goto(`/s/${heavy}?perf=slow`);
  await ready(page, 2007);
  await expect.poll(async () => (await loop(page)).fps, { timeout: 15000 }).toBe(10);
  await expect.poll(async () => (await loop(page)).paused, { timeout: 15000 }).toBe(true);
  await expect(page.getByText("Moving media paused to keep the board responsive")).toBeVisible();
  await page.getByRole("button", { name: "Play" }).first().click();
  await expect.poll(async () => (await loop(page)).paused).toBe(false);
});

test("30 remote pictures and 10 remote videos on screen mount at most 24 live items", async ({
  page,
}) => {
  await page.route("https://media.example.com/**", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  const sid = (await call(client, "create_session", { title: "Live cap" })).session_id;
  for (let i = 0; i < 40; i++)
    await call(client, "place_media", {
      session_id: sid,
      kind: i < 30 ? "image" : "video",
      source: { url: `https://media.example.com/m${i}.${i < 30 ? "png" : "mp4"}` },
      x: 20 + (i % 8) * 150,
      y: 20 + Math.floor(i / 8) * 140,
      width: 140,
      height: 120,
    });
  await page.goto(`/s/${sid}`);
  await ready(page, 40);
  await expect(page.locator('[data-testid="live-media"]')).toHaveCount(24);
});
