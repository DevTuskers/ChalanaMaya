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

/** A small solid PNG, base64 (made in the page). */
const makePng = (page: Page, color = "#007f78") =>
  page.evaluate((c) => {
    const cv = document.createElement("canvas");
    cv.width = 120;
    cv.height = 60;
    const g = cv.getContext("2d")!;
    g.fillStyle = c;
    g.fillRect(0, 0, 120, 60);
    return cv.toDataURL("image/png").split(",")[1];
  }, color);

const insertPicture = async (page: Page) => {
  await page.getByTestId("picture-input").setInputFiles({
    name: "pic.png",
    mimeType: "image/png",
    buffer: Buffer.from(await makePng(page), "base64"),
  });
  await expect
    .poll(async () => (await serverBoard(page)).elements.map((e) => e.type))
    .toContain("image");
};

const types = async (page: Page) => (await serverBoard(page)).elements.map((e) => e.type).sort();

/** True when every picture on the page's board is a file the session serves. */
const picturesLoad = (page: Page) =>
  page.evaluate(async (sid) => {
    const s = await (await fetch(`/api/sessions/${sid}/scene`)).json();
    const files = new Map<string, string>(
      s.files.map((f: { id: string; url: string }) => [f.id, f.url]),
    );
    const imgs = s.elements.filter((e: { el: { type: string } }) => e.el.type === "image");
    if (!imgs.length) return false;
    for (const e of imgs) {
      const url = files.get(e.el.fileId);
      if (!url || !url.startsWith(`/api/sessions/${sid}/files/`)) return false;
      const ok = await new Promise<boolean>((resolve) => {
        const i = new Image();
        i.onload = () => resolve(i.naturalWidth > 0);
        i.onerror = () => resolve(false);
        i.src = url;
      });
      if (!ok) return false;
    }
    return true;
  }, sessionId(page));

test("copying a picture and a box pastes both on the same board", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshBoard(page);
  await insertPicture(page);
  await drawRect(page, { x: 700, y: 400 }, { x: 800, y: 480 });
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  await page.keyboard.press(`${mod}+v`);
  await expect.poll(() => types(page)).toEqual(["image", "image", "rectangle", "rectangle"]);
  // the same board keeps using the same picture file
  const imgs = (await serverBoard(page)).elements.filter((e) => e.type === "image");
  expect(new Set(imgs.map((e) => e.fileId)).size).toBe(1);
  expect(await picturesLoad(page)).toBe(true);
});

test("a box and a picture copied in board A paste into board B and survive a reload", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshBoard(page);
  await insertPicture(page);
  await drawRect(page, { x: 700, y: 400 }, { x: 800, y: 480 });
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  const a = sessionId(page);
  await page.goto("/");
  await expect(page).toHaveURL(SESSION_URL);
  await expect(page.getByTestId("board")).toBeVisible();
  expect(sessionId(page)).not.toBe(a);
  await page.keyboard.press(`${mod}+v`);
  await expect.poll(() => types(page)).toEqual(["image", "rectangle"]);
  await page.reload();
  await expectOnBoard(page, 2);
  // the picture was copied into board B's own files
  await expect.poll(() => picturesLoad(page)).toBe(true);
});

for (const block of ["abort", "429"] as const) {
  test(`a board opens while the server refuses saves during the reload (${block})`, async ({
    page,
  }) => {
    await freshBoard(page);
    const refuse = (r: import("@playwright/test").Route) =>
      block === "abort"
        ? r.abort()
        : r.fulfill({
            status: 429,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "rate_limited", message: "Slow down." } }),
          });
    await page.route("**/api/sessions/*/ops", refuse);
    await drawRect(page);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "offline", {
      timeout: 5000,
    });
    // reload while the server still refuses: the board opens with the edit on it
    await page.reload();
    await expectOnBoard(page, 1);
    await expect(page.getByTestId("boot-page")).toHaveCount(0);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "offline", {
      timeout: 5000,
    });
    // the server comes back: the same batch is sent and the board is saved
    await page.unroute("**/api/sessions/*/ops");
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", {
      timeout: 20000,
    });
    expect((await serverBoard(page)).elements).toHaveLength(1);
    await page.reload();
    await expectOnBoard(page, 1);
    const id = sessionId(page);
    await expect
      .poll(() => page.evaluate((sid) => localStorage.getItem(`chalanamaya.pending.${sid}`), id))
      .toBeNull();
  });
}

test("a legacy board with pictures imports, and a 4.5 MB local board can be dragged", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await freshBoard(page);
  const png = await makePng(page, "#c0392b");
  const dataURL = `data:image/png;base64,${png}`;
  const pic = (x: number, fileId: string) => ({
    ...createShape("rectangle", x, 100),
    type: "image",
    width: 120,
    height: 60,
    fileId,
    crop: null,
    flipX: false,
    flipY: false,
    backgroundColor: "transparent",
  });
  const strokes = Array.from({ length: 27 }, (_, i) => ({
    ...createFreedraw(100 + i * 10, 300 + i * 5),
    points: Array.from({ length: 3800 }, (_, j) => ({
      x: j * 0.3711 + i / 3,
      y: Math.sin(j / 7) * 40 + i / 7,
    })),
  }));
  const legacy = JSON.stringify({
    type: "chalana",
    version: 1,
    source: "ChalanaMaya",
    elements: [pic(100, "legacy-pic-1"), pic(300, "legacy-pic-1"), ...strokes],
    files: { "legacy-pic-1": { id: "legacy-pic-1", mimeType: "image/png", dataURL } },
    settings: { viewBackgroundColor: "#fff9ed", theme: "light", gridEnabled: false },
  });
  expect(legacy.length).toBeGreaterThan(4.5 * 1000 * 1000);
  await page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: STORAGE_KEY, v: legacy });
  await page.reload();
  await expect(page.getByTestId("legacy-banner")).toContainText("29 items");
  await page.getByTestId("legacy-import").click();
  await expectOnBoard(page, 29);
  await expect.poll(async () => (await types(page)).filter((t) => t === "image")).toHaveLength(2);
  expect(await picturesLoad(page)).toBe(true);
  // with the storage nearly full, a long drag still saves (the mirror never throws)
  await page.keyboard.press(`${mod}+a`);
  await drag(page, { x: 160, y: 130 }, { x: 260, y: 230 }, 30);
  await settled(page);
  const moved = (await serverBoard(page)).elements.filter((e) => e.type === "image");
  expect(Math.min(...moved.map((e) => e.y))).toBeGreaterThan(150);
  expect(errors).toEqual([]);
});
