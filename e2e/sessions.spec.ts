// Phase 2: every board is a server-backed session at /s/<id> (plan §4.1).
import { expect, test, type Page } from "@playwright/test";
import { generateNKeysBetween } from "fractional-indexing";
import { createFreedraw, createShape } from "../src/scene/elements";
import {
  SESSION_URL,
  STORAGE_KEY,
  drag,
  expectCount,
  expectOnBoard,
  freshBoard,
  serverBoard,
  sessionId,
  settled,
} from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";

const drawRect = async (page: Page, from = { x: 300, y: 200 }, to = { x: 420, y: 290 }) => {
  await page.keyboard.press("r");
  await drag(page, from, to);
};

const openMenu = async (page: Page) => {
  if (!(await page.getByTestId("session-menu").isVisible()))
    await page.getByTestId("menu-button").click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
};

test("/ opens a new board at /s/<id>, and edits survive a reload", async ({ page }) => {
  await freshBoard(page);
  await expect(page).toHaveURL(SESSION_URL);
  await drawRect(page);
  await drawRect(page, { x: 500, y: 200 }, { x: 600, y: 300 });
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  expect((await serverBoard(page)).elements).toHaveLength(2);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expectOnBoard(page, 2);
  // the scene is not kept in this browser's storage any more
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBeNull();
});

test("an edit made just before a reload is not lost", async ({ page }) => {
  await freshBoard(page);
  await drawRect(page);
  // no waiting for the debounced save: pagehide sends or mirrors it
  await page.reload();
  await expectOnBoard(page, 1);
  expect((await serverBoard(page)).elements).toHaveLength(1);
});

test("edits made while the server is unreachable are kept and sent later", async ({ page }) => {
  await freshBoard(page);
  await page.route("**/api/sessions/*/ops", (r) => r.abort());
  await drawRect(page);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "offline", {
    timeout: 5000,
  });
  // the pending change is mirrored locally
  const id = sessionId(page);
  await expect
    .poll(() => page.evaluate((sid) => localStorage.getItem(`chalanamaya.pending.${sid}`), id))
    .not.toBeNull();
  await page.unroute("**/api/sessions/*/ops");
  await page.reload();
  await expectOnBoard(page, 1);
  expect((await serverBoard(page)).elements).toHaveLength(1);
  await expect
    .poll(() => page.evaluate((sid) => localStorage.getItem(`chalanamaya.pending.${sid}`), id))
    .toBeNull();
});

test("session menu: title, ids, new board and recent boards", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshBoard(page);
  const first = sessionId(page);
  await openMenu(page);
  await expect(page.getByTestId("session-short-id")).toContainText(first.slice(0, 6));
  await page.getByTestId("session-title").fill("Roadmap");
  await page.getByTestId("session-title").press("Enter");
  await expect.poll(async () => (await serverBoard(page)).title).toBe("Roadmap");
  await expect(page).toHaveTitle(/Roadmap/);

  await openMenu(page);
  await page.getByTestId("session-copy-id").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  await openMenu(page);
  await page.getByTestId("session-copy-link").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(new RegExp(`/s/${first}$`));

  await openMenu(page);
  await page.getByTestId("session-new").click();
  await expect(page).toHaveURL(SESSION_URL);
  await expect.poll(() => sessionId(page)).not.toBe(first);
  await expect(page.getByTestId("board")).toBeVisible();
  await openMenu(page);
  await page.getByTestId("session-recent").click();
  const recent = page.getByTestId("session-recent-list");
  await expect(recent).toContainText("Roadmap");
  await recent.getByText("Roadmap").click();
  await expect(page).toHaveURL(new RegExp(`/s/${first}$`));
});

test("a bad or unknown board address gets a clear page", async ({ page }) => {
  await page.goto(`/s/${"Q".repeat(24)}`);
  await expect(page.getByTestId("board-missing")).toBeVisible();
  await expect(page.getByTestId("board-missing")).toContainText(/does not exist|deleted/i);
});

test("a 1,000-item move is saved in chunks", async ({ page }) => {
  await freshBoard(page);
  const id = sessionId(page);
  const keys = generateNKeysBetween(null, null, 1000);
  const elements = Array.from({ length: 1000 }, (_, i) => ({
    el: {
      ...createShape("rectangle", 40 + (i % 40) * 22, 80 + Math.floor(i / 40) * 22),
      width: 16,
      height: 16,
    },
    idx: keys[i],
  }));
  await page.evaluate(
    async ({ sid, elements }) => {
      const r = await fetch(`/api/sessions/${sid}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ChalanaMaya": "1" },
        body: JSON.stringify({ importId: "e2e-thousand-import", mode: "add", elements }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    { sid: id, elements },
  );
  await page.reload();
  await expectOnBoard(page, 1000);
  const pushes: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/sessions/${id}/ops`))
      pushes.push((r.postDataJSON() as { ops: unknown[] }).ops.length);
  });
  await page.keyboard.press(`${mod}+a`);
  await drag(page, { x: 48, y: 88 }, { x: 148, y: 138 });
  const saved = await serverBoard(page);
  expect(pushes.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...pushes)).toBeLessThanOrEqual(500);
  expect(pushes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  const byId = new Map(elements.map((e) => [e.el.id, e.el]));
  for (const e of saved.elements) expect(e.x).toBe(byId.get(e.id)!.x + 100);
});

test("a 5 MB legacy board imports as one undo step", async ({ page }) => {
  await freshBoard(page);
  const strokes = Array.from({ length: 30 }, (_, i) => ({
    ...createFreedraw(100 + i * 10, 100 + i * 5),
    points: Array.from({ length: 3800 }, (_, j) => ({
      x: j * 0.3711 + i / 3,
      y: Math.sin(j / 7) * 40 + i / 7,
    })),
  }));
  const legacy = JSON.stringify({
    type: "chalana",
    version: 1,
    source: "ChalanaMaya",
    elements: strokes,
    files: {},
    settings: { viewBackgroundColor: "#fff9ed", theme: "light", gridEnabled: false },
  });
  // over 5 MB, yet inside the browser's 5 Mi-character storage quota
  expect(legacy.length).toBeGreaterThan(5 * 1000 * 1000);
  expect(legacy.length).toBeLessThan(5 * 1024 * 1024 - 64);
  await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: STORAGE_KEY, v: legacy });
  await page.reload();
  await expect(page.getByTestId("legacy-banner")).toContainText("30 items");
  await page.getByTestId("legacy-import").click();
  await expectOnBoard(page, 30);
  await expect(page.getByTestId("legacy-banner")).toHaveCount(0);
  expect((await serverBoard(page)).elements).toHaveLength(30);
  // the old copy is kept until it is removed on purpose
  expect(await page.evaluate((k) => localStorage.getItem(k) !== null, STORAGE_KEY)).toBe(true);

  await page.keyboard.press(`${mod}+z`);
  await expectOnBoard(page, 0);
  expect((await serverBoard(page)).elements).toHaveLength(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expectCount(page, 30);
  await settled(page);

  // reloading does not offer the same import again
  await page.reload();
  await expectOnBoard(page, 30);
  await expect(page.getByTestId("legacy-banner")).toHaveCount(0);
});

test("the old browser copy can be removed from the banner", async ({ page }) => {
  await freshBoard(page);
  const legacy = JSON.stringify({
    type: "chalana",
    version: 1,
    source: "ChalanaMaya",
    elements: [{ ...createShape("rectangle", 100, 100), width: 80, height: 60 }],
    files: {},
    settings: { viewBackgroundColor: "#fff9ed", theme: "light", gridEnabled: false },
  });
  await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: STORAGE_KEY, v: legacy });
  await page.reload();
  await expect(page.getByTestId("legacy-banner")).toContainText("1 item");
  await page.getByTestId("legacy-remove").click();
  await expect(page.getByTestId("legacy-banner")).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBeNull();
  await expectCount(page, 0);
});

test("board colour and grid are saved with the board; the theme is not", async ({ page }) => {
  await freshBoard(page);
  await page.keyboard.press(`${mod}+'`);
  await expect.poll(async () => (await serverBoard(page)).settings.gridEnabled).toBe(true);
  await page.reload();
  await expect.poll(async () => (await serverBoard(page)).settings.gridEnabled).toBe(true);
  expect((await serverBoard(page)).settings).not.toHaveProperty("theme");
});
