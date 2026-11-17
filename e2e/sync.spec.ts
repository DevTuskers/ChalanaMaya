// Phase 3: live sync between tabs (plan §8). Two pages on one board see each
// other's edits within a second; layer order, concurrent edits, a 1,000-item
// drag and offline edits all come through.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { generateNKeysBetween } from "fractional-indexing";
import { createShape } from "../src/scene/elements";
import { drag, expectOnBoard, freshBoard, serverBoard, sessionId, settled } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";
/** The phase acceptance: another page shows an edit within 1 s. */
const LIVE_MS = 1000;

interface Item {
  id: string;
  x: number;
  y: number;
  strokeColor: string;
}

/** What the page shows, in layer order. */
const items = (page: Page): Promise<Item[]> =>
  page.evaluate(() => {
    const s = (
      window as unknown as {
        __chalanaSync: { host: { scene(): { elements: Item[] } } };
      }
    ).__chalanaSync;
    return s.host
      .scene()
      .elements.map((e) => ({ id: e.id, x: e.x, y: e.y, strokeColor: e.strokeColor }));
  });

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

const drawRect = async (page: Page, from = { x: 300, y: 200 }, to = { x: 420, y: 290 }) => {
  await page.keyboard.press("r");
  await drag(page, from, to);
};

/** Two pages on one new board, both on the live channel. */
const twoTabs = async (browser: Browser, separate = false) => {
  const ctxA = await browser.newContext();
  const ctxB = separate ? await browser.newContext() : ctxA;
  const a = await ctxA.newPage();
  await freshBoard(a);
  const b = await ctxB.newPage();
  await b.goto(a.url());
  await expect(b.getByTestId("board")).toBeVisible();
  await connected(a);
  await connected(b);
  const close = async () => {
    await ctxA.close();
    if (separate) await ctxB.close();
  };
  return { a, b, ctxA, ctxB, close };
};

test("two pages see each other's adds, moves and deletes within 1 s", async ({ browser }) => {
  const { a, b, close } = await twoTabs(browser);
  await drawRect(a);
  await expectOnBoard(a, 1);
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "1", { timeout: LIVE_MS });
  const [before] = await items(b);
  // b moves it (drag its left edge); a follows
  await b.keyboard.press("v");
  await drag(b, { x: 300, y: 245 }, { x: 400, y: 345 });
  await expect
    .poll(async () => (await items(a))[0].x, { timeout: LIVE_MS })
    .toBeCloseTo(before.x + 100);
  // a deletes it; b follows
  await a.keyboard.press(`${mod}+a`);
  await a.keyboard.press("Delete");
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "0", { timeout: LIVE_MS });
  expect((await serverBoard(a)).elements).toHaveLength(0);
  await close();
});

test("layer order goes across, and both pages keep the same order", async ({ browser }) => {
  const { a, b, close } = await twoTabs(browser);
  await drawRect(a);
  await drawRect(a, { x: 500, y: 200 }, { x: 600, y: 300 });
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "2", { timeout: LIVE_MS });
  const [first, second] = await items(a);
  expect((await items(b)).map((e) => e.id)).toEqual([first.id, second.id]);
  // a brings the first one to the front
  await a.keyboard.press("v");
  await a.keyboard.press("Escape");
  await a.mouse.click(
    (await a.getByTestId("board").boundingBox())!.x + 300,
    (await a.getByTestId("board").boundingBox())!.y + 245,
  );
  await a.keyboard.press(`${mod}+Shift+BracketRight`);
  await expect.poll(async () => (await items(a)).map((e) => e.id)).toEqual([second.id, first.id]);
  await expect
    .poll(async () => (await items(b)).map((e) => e.id), { timeout: LIVE_MS })
    .toEqual([second.id, first.id]);
  // b sends it back again; a follows
  await b.keyboard.press("v");
  await b.mouse.click(
    (await b.getByTestId("board").boundingBox())!.x + 300,
    (await b.getByTestId("board").boundingBox())!.y + 245,
  );
  await b.keyboard.press(`${mod}+Shift+BracketLeft`);
  await expect
    .poll(async () => (await items(a)).map((e) => e.id), { timeout: LIVE_MS })
    .toEqual([first.id, second.id]);
  await settled(a);
  await settled(b);
  const server = (await serverBoard(a)).elements.map((e) => e.id);
  expect(server).toEqual([first.id, second.id]);
  await close();
});

test("edits made at the same time in both pages are all kept", async ({ browser }) => {
  const { a, b, close } = await twoTabs(browser);
  await drawRect(a);
  await drawRect(a, { x: 600, y: 200 }, { x: 700, y: 300 });
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "2", { timeout: LIVE_MS });
  const [one, two] = await items(a);
  await a.keyboard.press("v");
  await b.keyboard.press("v");
  await a.keyboard.press("Escape");
  await b.keyboard.press("Escape");
  // at the same time: a moves the first, b moves the second, both add one
  await Promise.all([
    (async () => {
      await drag(a, { x: 300, y: 245 }, { x: 300, y: 445 });
      await drawRect(a, { x: 300, y: 550 }, { x: 360, y: 600 });
    })(),
    (async () => {
      await drag(b, { x: 600, y: 245 }, { x: 600, y: 445 });
      await drawRect(b, { x: 600, y: 550 }, { x: 660, y: 600 });
    })(),
  ]);
  await settled(a);
  await settled(b);
  for (const p of [a, b]) {
    await expect(p.getByTestId("app")).toHaveAttribute("data-items", "4", { timeout: 5000 });
    await expect
      .poll(async () => (await items(p)).find((e) => e.id === one.id)?.y)
      .toBeCloseTo(one.y + 200);
    await expect
      .poll(async () => (await items(p)).find((e) => e.id === two.id)?.y)
      .toBeCloseTo(two.y + 200);
  }
  expect(await items(a)).toEqual(await items(b));
  expect((await serverBoard(a)).elements).toHaveLength(4);
  await close();
});

test("undo in one page undoes only that page's step", async ({ browser }) => {
  const { a, b, close } = await twoTabs(browser);
  await drawRect(a);
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "1", { timeout: LIVE_MS });
  await drawRect(b, { x: 600, y: 200 }, { x: 700, y: 300 });
  await expect(a.getByTestId("app")).toHaveAttribute("data-items", "2", { timeout: LIVE_MS });
  const mine = (await items(a))[0].id;
  const theirs = (await items(a))[1].id;
  await a.keyboard.press("Escape");
  await a.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await items(a)).map((e) => e.id)).toEqual([theirs]);
  await expect
    .poll(async () => (await items(b)).map((e) => e.id), { timeout: LIVE_MS })
    .toEqual([theirs]);
  // redo brings a's box back in both pages
  await a.keyboard.press(`${mod}+Shift+z`);
  await expect
    .poll(async () => (await items(b)).map((e) => e.id).sort(), { timeout: LIVE_MS })
    .toEqual([mine, theirs].sort());
  await close();
});

test("a 1,000-item drag reaches the other page", async ({ browser }) => {
  test.setTimeout(90000);
  const { a, b, close } = await twoTabs(browser);
  const id = sessionId(a);
  const keys = generateNKeysBetween(null, null, 1000);
  const elements = Array.from({ length: 1000 }, (_, i) => ({
    el: {
      ...createShape("rectangle", 40 + (i % 40) * 22, 80 + Math.floor(i / 40) * 22),
      width: 16,
      height: 16,
    },
    idx: keys[i],
  }));
  await a.evaluate(
    async ({ sid, elements }) => {
      const r = await fetch(`/api/sessions/${sid}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ChalanaMaya": "1" },
        body: JSON.stringify({ importId: "e2e-live-thousand", mode: "add", elements }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    { sid: id, elements },
  );
  // the import (a REST write) shows up live in both pages
  await expectOnBoard(a, 1000);
  await expectOnBoard(b, 1000);
  const rest: string[] = [];
  a.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/ops")) rest.push(r.url());
  });
  await a.keyboard.press("v");
  await a.keyboard.press(`${mod}+a`);
  await drag(a, { x: 48, y: 88 }, { x: 148, y: 138 });
  const t0 = Date.now();
  const byId = new Map(elements.map((e) => [e.el.id, e.el]));
  await b.waitForFunction(
    (want) => {
      const s = (
        window as unknown as {
          __chalanaSync: { host: { scene(): { elements: { id: string; x: number }[] } } };
        }
      ).__chalanaSync;
      const els = s.host.scene().elements;
      return els.length === 1000 && els.every((e) => e.x === want[e.id] + 100);
    },
    Object.fromEntries([...byId].map(([k, v]) => [k, v.x])),
    { timeout: 10000, polling: 50 },
  );
  const lag = Date.now() - t0;
  expect(lag).toBeLessThan(LIVE_MS);
  // it went over the live channel, not REST
  expect(rest).toEqual([]);
  const saved = await serverBoard(a);
  for (const e of saved.elements) expect(e.x).toBe(byId.get(e.id)!.x + 100);
  await close();
});

test("a page that goes offline sends its edits when the connection is back", async ({
  browser,
}) => {
  const { a, b, ctxB, close } = await twoTabs(browser, true);
  await drawRect(a);
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "1", { timeout: LIVE_MS });
  await ctxB.setOffline(true);
  await b.evaluate(() => window.dispatchEvent(new Event("offline")));
  await drawRect(b, { x: 600, y: 200 }, { x: 700, y: 300 });
  await expect(b.getByTestId("save-status")).toHaveAttribute("data-state", "offline", {
    timeout: 10000,
  });
  await expect(b.getByTestId("save-status")).toContainText(/offline/i);
  // a does not see it yet, but its own edits still reach b later
  await a.waitForTimeout(500);
  await expect(a.getByTestId("app")).toHaveAttribute("data-items", "1");
  await drawRect(a, { x: 300, y: 400 }, { x: 400, y: 480 });
  await ctxB.setOffline(false);
  await b.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(a.getByTestId("app")).toHaveAttribute("data-items", "3", { timeout: 10000 });
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "3", { timeout: 10000 });
  await expect(b.getByTestId("save-status")).toHaveAttribute("data-state", "saved", {
    timeout: 10000,
  });
  expect((await items(a)).map((e) => e.id).sort()).toEqual(
    (await items(b)).map((e) => e.id).sort(),
  );
  expect((await serverBoard(a)).elements).toHaveLength(3);
  await close();
});

test("a write by another client (REST, as an agent would) shows up live", async ({ browser }) => {
  const { a, b, close } = await twoTabs(browser);
  const id = sessionId(a);
  const keys = generateNKeysBetween(null, null, 1);
  const el = { ...createShape("ellipse", 200, 200), width: 80, height: 80 };
  await b.evaluate(
    async ({ sid, el, idx }) => {
      const scene = await (await fetch(`/api/sessions/${sid}/scene`)).json();
      const r = await fetch(`/api/sessions/${sid}/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ChalanaMaya": "1" },
        body: JSON.stringify({
          pushId: "e2e-rest-write-0001",
          baseRev: scene.rev,
          ops: [{ t: "put", el, idx, baseVersion: 0 }],
        }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    { sid: id, el, idx: keys[0] },
  );
  await expect(a.getByTestId("app")).toHaveAttribute("data-items", "1", { timeout: LIVE_MS });
  await expect(b.getByTestId("app")).toHaveAttribute("data-items", "1", { timeout: LIVE_MS });
  expect((await items(a))[0].id).toBe(el.id);
  await close();
});
