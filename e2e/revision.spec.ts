import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { boardBox, drag, expectCount, freshBoard, serverBoard } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";

type Loose = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked?: boolean;
  frameId?: string | null;
};

const els = async (page: Page): Promise<Loose[]> => {
  return (await serverBoard(page)).elements as unknown as Loose[];
};

const box = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.keyboard.press("r");
  await drag(page, from, to);
};

const dblBoard = async (page: Page, p: { x: number; y: number }) => {
  const b = await boardBox(page);
  await page.mouse.dblclick(b.x + p.x, b.y + p.y);
};

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await freshBoard(page);
});

test("look-only mode refuses every board-changing control", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 300 });
  await box(page, { x: 400, y: 200 }, { x: 500, y: 300 });
  await box(page, { x: 600, y: 200 }, { x: 700, y: 300 });
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+z`);
  await expectCount(page, 2); // both undo and redo are now possible

  await page.keyboard.press("Alt+r");
  await expect(page.getByTestId("view-mode-banner")).toBeVisible();

  // zoom strip history buttons
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("redo")).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("undo").click({ force: true });
  await page.getByTestId("redo").click({ force: true });
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expectCount(page, 2);

  // the main menu hides every board-changing entry
  await page.getByTestId("menu-button").click();
  for (const id of ["paste", "lock-all", "unlock-all", "clear", "insert-picture", "open"]) {
    await expect(page.getByTestId(`menu-${id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId("menu-export")).toBeVisible();
  await page.keyboard.press("Escape");

  // files picked anyway (e.g. from an old dialog) are refused
  await page.getByTestId("picture-input").setInputFiles({
    name: "dot.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByTestId("file-input").setInputFiles({
    name: "b.chalana",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ type: "chalanamaya", version: 1, elements: [] })),
  });
  // double-click never starts writing; keyboard edits do nothing
  await dblBoard(page, { x: 250, y: 250 });
  await dblBoard(page, { x: 900, y: 600 });
  await expect(page.getByTestId("text-editor")).toHaveCount(0);
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press("Delete");
  await page.keyboard.press(`${mod}+d`);
  await expectCount(page, 2);
  expect((await els(page)).every((e) => !e.locked)).toBe(true);

  // leaving restores editing
  await page.getByTestId("leave-view-mode").click();
  await page.getByTestId("menu-button").click();
  await expect(page.getByTestId("menu-clear")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("redo").click();
  await expectCount(page, 3);
});

test("locked items refuse text editing and can be unlocked one at a time", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 320, y: 300 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("keep");
  await page.keyboard.press("Escape");
  await box(page, { x: 450, y: 200 }, { x: 550, y: 300 });
  // lock both boxes
  await page.keyboard.press(`${mod}+a`);
  await page.getByTestId("lock").click();
  await expect.poll(async () => (await els(page)).filter((e) => e.locked).length).toBe(2);

  await dblBoard(page, { x: 260, y: 250 });
  await expect(page.getByTestId("text-editor")).toHaveCount(0);
  await dblBoard(page, { x: 500, y: 250 });
  await expect(page.getByTestId("text-editor")).toHaveCount(0);
  await expectCount(page, 3);

  // unlock just the second box from the notice
  await page.getByTestId("unlock-item").last().click();
  const all = await els(page);
  const rects = all.filter((e) => e.type === "rectangle").sort((a, b) => a.x - b.x);
  expect(rects.map((r) => r.locked)).toEqual([true, false]);
  await dblBoard(page, { x: 500, y: 250 });
  await expect(page.getByTestId("text-editor")).toHaveCount(1);
});

test("SVG export uses the chosen scale", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 300 });
  await page.keyboard.press(`${mod}+Shift+e`);
  await page.getByTestId("export-format-svg").click();
  await page.getByTestId("export-scale-3").click();
  const dialog = page.getByTestId("export-dialog");
  const text = (await dialog.textContent()) ?? "";
  const [, w, h] = text.match(/Output: (\d+) × (\d+) px/) ?? [];
  expect(Number(w)).toBeGreaterThan(400);
  const download = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const svg = await readFile(await (await download).path(), "utf8");
  const head = svg.slice(0, svg.indexOf(">"));
  expect(head).toContain(`width="${w}"`);
  expect(head).toContain(`height="${h}"`);
  const vb = head.match(/viewBox="0 0 (\d+) (\d+)"/)!;
  expect(Number(vb[1]) * 3).toBe(Number(w));
});

test("new items drawn in a frame join it; new boxes snap, Alt skips", async ({ page }) => {
  await page.keyboard.press("f");
  await drag(page, { x: 150, y: 150 }, { x: 600, y: 500 });
  await box(page, { x: 200, y: 200 }, { x: 300, y: 300 });
  let all = await els(page);
  const frame = all.find((e) => e.type === "frame")!;
  expect(all.find((e) => e.type === "rectangle")!.frameId).toBe(frame.id);

  // start 3 px below the first box's top edge: the corner snaps onto it
  await box(page, { x: 700, y: 203 }, { x: 800, y: 290 });
  all = await els(page);
  const [first, second] = all.filter((e) => e.type === "rectangle");
  expect(second.y).toBeCloseTo(first.y, 1);
  expect(second.frameId ?? null).toBeNull();

  // with Alt held nothing snaps
  await page.keyboard.press("r");
  await page.keyboard.down("Alt");
  await drag(page, { x: 850, y: 203 }, { x: 950, y: 291 });
  await page.keyboard.up("Alt");
  all = await els(page);
  const third = all.filter((e) => e.type === "rectangle")[2];
  expect(third.y - first.y).toBeCloseTo(3, 0);
});
