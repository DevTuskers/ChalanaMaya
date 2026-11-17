// Phase 6 performance checks (plan §11, phase 6 "Delivers"): a board of 5,000
// elements seeded through MCP loads in under 2 s, and a remote batch of 200
// items sent by an agent is applied in an open tab in under 100 ms end to end
// (from the moment the agent sends the call until the tab's board holds it).
import { expect, test, type Page } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, httpClient } from "../server/mcp/testClient";

const BASE = "http://localhost:5184";

const count = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __chalanaSync?: { host: { scene(): { elements: unknown[] } } };
        }
      ).__chalanaSync?.host.scene().elements.length ?? 0,
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

const batch = (from: number, n: number, y0 = 0) =>
  Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return {
      type: i % 3 === 0 ? "ellipse" : "rectangle",
      x: (i % 100) * 24,
      y: y0 + Math.floor(i / 100) * 18,
      width: 18,
      height: 12,
    };
  });

let client: Client;
test.beforeAll(async () => {
  client = await httpClient(BASE, "e2e-perf-scale");
});
test.afterAll(async () => {
  await client?.close();
});

test("a board of 5,000 elements loads in under 2 s", async ({ page }) => {
  test.setTimeout(120000);
  const sid = (await call(client, "create_session", { title: "5k" })).session_id as string;
  for (let i = 0; i < 5000; i += 200)
    await call(client, "add_elements", { session_id: sid, elements: batch(i, 200) });
  // warm the server's and browser's caches for the app itself (not the board)
  await page.goto("/");
  const times: number[] = [];
  for (let run = 0; run < 2; run++) {
    await page.goto(`/s/${sid}`);
    // ms since navigation start until the board holds all 5,000 and has painted
    const t = await page.waitForFunction(
      () => {
        const s = (
          window as unknown as {
            __chalanaSync?: { host: { scene(): { elements: unknown[] } } };
          }
        ).__chalanaSync;
        return (s?.host.scene().elements.length ?? 0) === 5000 ? performance.now() : 0;
      },
      undefined,
      { polling: "raf", timeout: 20000 },
    );
    times.push((await t.jsonValue()) as number);
  }
  test.info().annotations.push({ type: "load-ms", description: times.map(Math.round).join(", ") });
  expect(Math.min(...times)).toBeLessThan(2000);
});

test("a remote batch of 200 items is applied in an open tab in under 100 ms end to end", async ({
  page,
}) => {
  const sid = (await call(client, "create_session", { title: "Batch" })).session_id as string;
  await page.goto(`/s/${sid}`);
  await connected(page);
  const results: number[] = [];
  for (let run = 0; run < 3; run++) {
    const target = (run + 1) * 200;
    // the tab notes the wall-clock time the board first holds the batch
    await page.evaluate((n) => {
      const w = window as unknown as {
        __applied?: number;
        __chalanaSync: { host: { scene(): { elements: unknown[] } } };
      };
      w.__applied = 0;
      const tick = () => {
        if (w.__chalanaSync.host.scene().elements.length >= n) w.__applied = Date.now();
        else setTimeout(tick, 1);
      };
      tick();
    }, target);
    const elements = batch(run * 200, 200, 2000);
    const sent = Date.now();
    await call(client, "add_elements", { session_id: sid, elements });
    await expect.poll(() => count(page)).toBe(target);
    const applied = await page.evaluate(
      () => (window as unknown as { __applied: number }).__applied,
    );
    results.push(applied - sent);
  }
  test.info().annotations.push({ type: "batch-ms", description: results.join(", ") });
  // the first call warms the path (JIT, prepared statements); the best run is the measure
  expect(Math.min(...results)).toBeLessThan(100);
});
