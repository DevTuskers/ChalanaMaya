import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { clickBoard, drag, expectCount, freshBoard, serverBoard } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";

type Loose = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const board = async (
  page: Page,
): Promise<{ elements: Loose[]; settings: Record<string, unknown> }> => {
  const b = await serverBoard(page);
  return { elements: b.elements as unknown as Loose[], settings: b.settings };
};
const els = async (page: Page) => (await board(page)).elements;

const box = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.keyboard.press("r");
  await drag(page, from, to);
};

test.beforeEach(async ({ page }) => {
  await freshBoard(page);
});

test("curved and elbow connectors with a label and arrowheads", async ({ page }) => {
  await page.keyboard.press("a");
  await drag(page, { x: 200, y: 200 }, { x: 500, y: 350 }, 10);
  await page.getByTestId("routing-elbow").click();
  await page.getByTestId("end-head").selectOption("er-many");
  await page.getByTestId("start-head").selectOption("circle");
  let a = (await els(page))[0];
  expect(a).toMatchObject({ routing: "elbow", endArrowhead: "er-many", startArrowhead: "circle" });
  await page.getByTestId("routing-curved").click();
  // label: Enter edits the connector's text
  await page.keyboard.press("Enter");
  await page.keyboard.type("flows to");
  await page.keyboard.press("Escape");
  const all = await els(page);
  a = all.find((e) => e.type === "arrow")!;
  expect(a.routing).toBe("curved");
  const label = all.find((e) => e.type === "text")!;
  expect(label).toMatchObject({ text: "flows to", containerId: a.id });
});

test("sticky notes, frames and keep drawing", async ({ page }) => {
  await page.keyboard.press("n");
  await clickBoard(page, { x: 300, y: 300 });
  await page.keyboard.type("Buy paint");
  await page.keyboard.press("Escape");
  let all = await els(page);
  const note = all.find((e) => e.type === "note")!;
  expect(all.find((e) => e.type === "text")).toMatchObject({
    text: "Buy paint",
    containerId: note.id,
  });

  // frame around the note collects it
  await page.keyboard.press("f");
  await drag(page, { x: 150, y: 150 }, { x: 500, y: 480 });
  all = await els(page);
  const frame = all.find((e) => e.type === "frame")!;
  expect(all.find((e) => e.id === note.id)!.frameId).toBe(frame.id);
  await page.getByTestId("frame-name").fill("Plan");
  await page.getByTestId("frame-name").press("Enter");
  await expect
    .poll(async () => (await els(page)).find((e) => e.type === "frame")!.name)
    .toBe("Plan");

  // keep drawing keeps the tool; off returns to Pick
  await page.getByTestId("tool-lock").click();
  await box(page, { x: 600, y: 200 }, { x: 680, y: 260 });
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-pressed", "true");
  await drag(page, { x: 700, y: 200 }, { x: 780, y: 260 });
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("tool-lock").click();
  await drag(page, { x: 800, y: 200 }, { x: 880, y: 260 });
  await expect(page.getByTestId("tool-pick")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/p1-light.png" });
});

test("eraser skips locked items and can be undone; lasso picks enclosed items", async ({
  page,
}) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 280 });
  await box(page, { x: 400, y: 200 }, { x: 500, y: 280 });
  // lock the second box
  await page.getByTestId("lock").click();
  await page.keyboard.press("e");
  await drag(page, { x: 150, y: 200 }, { x: 560, y: 200 }, 20);
  let all = await els(page);
  expect(all).toHaveLength(1);
  expect(all[0].locked).toBe(true);
  await page.keyboard.press(`${mod}+z`);
  await expectCount(page, 2);

  await page.locator("[data-testid=menu-button]").click();
  await page.getByTestId("menu-unlock-all").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("q");
  const b = await page.getByTestId("board").boundingBox();
  const pts = [
    [170, 170],
    [330, 170],
    [330, 310],
    [170, 310],
    [170, 172],
  ];
  await page.mouse.move(b!.x + pts[0][0], b!.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(b!.x + x, b!.y + y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("properties")).toContainText("1 selected");
  all = await els(page);
  expect(all).toHaveLength(2);
});

test("style controls, copy and paste styles", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 280 });
  await page.getByTestId("fill-bfe8e2").click();
  await page.getByTestId("fillstyle-cross-hatch").click();
  await page.getByTestId("strokestyle-dashed").click();
  await page.getByTestId("roughness-2").click();
  await page.getByTestId("edges-round").click();
  await page.getByTestId("opacity").fill("50");
  let r = (await els(page))[0];
  expect(r).toMatchObject({
    fillStyle: "cross-hatch",
    strokeStyle: "dashed",
    roughness: 2,
    edges: "round",
    opacity: 50,
  });
  await page.getByTestId("copy-styles").click();
  await box(page, { x: 400, y: 200 }, { x: 500, y: 280 });
  await page.getByTestId("paste-styles").click();
  r = (await els(page))[1];
  expect(r).toMatchObject({ fillStyle: "cross-hatch", strokeStyle: "dashed", opacity: 50 });
});

test("eyedropper samples a colour and Escape cancels", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 320, y: 300 });
  await page.getByTestId("fill-bfe8e2").click();
  await page.getByTestId("fillstyle-solid").click();
  await box(page, { x: 500, y: 200 }, { x: 600, y: 300 });
  await page.getByTestId("fill-transparent").click();
  await page.keyboard.press("i");
  await page.getByTestId("eyedropper-backgroundColor").click();
  await page.keyboard.press("Escape");
  expect((await els(page))[1].backgroundColor).toBe("transparent");
  await page.keyboard.press("i");
  await page.getByTestId("eyedropper-backgroundColor").click();
  await clickBoard(page, { x: 260, y: 250 });
  await expect.poll(async () => (await els(page))[1].backgroundColor).toBe("#bfe8e2");
});

test("group, z-order, align, flip, switch type and links", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 280 });
  await box(page, { x: 400, y: 240 }, { x: 480, y: 320 });
  await page.keyboard.press(`${mod}+a`);
  await page.getByTestId("align-top").click();
  let all = await els(page);
  expect(all[0].y).toBeCloseTo(all[1].y, 0);
  await page.keyboard.press(`${mod}+g`);
  all = await els(page);
  expect((all[0].groupIds as string[])[0]).toBe((all[1].groupIds as string[])[0]);
  // clicking one member selects the group
  await page.keyboard.press("Escape");
  await clickBoard(page, { x: 200, y: 230 });
  await expect(page.getByTestId("properties")).toContainText("2 selected");
  await page.keyboard.press(`${mod}+Shift+g`);
  await page.keyboard.press("Escape");
  await clickBoard(page, { x: 200, y: 230 });
  await page.keyboard.press(`${mod}+Shift+]`);
  all = await els(page);
  expect(all[1].type).toBe("rectangle");
  expect(all[1].x).toBeLessThan(all[0].x);
  await page.getByTestId("switch-ellipse").click();
  all = await els(page);
  expect(all[1].type).toBe("ellipse");
  await page.keyboard.press("Shift+H");
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("link-input").fill("javascript:alert(1)");
  await page.getByTestId("link-save").click();
  await expect(page.getByTestId("link-error")).toBeVisible();
  await page.getByTestId("link-input").fill("example.com/docs");
  await page.getByTestId("link-save").click();
  all = await els(page);
  expect(all[1].link).toBe("https://example.com/docs");
});

test("grid, quiet desk, look-only mode, measurements and search", async ({ page }) => {
  await page.keyboard.press("t");
  await clickBoard(page, { x: 300, y: 300 });
  await page.keyboard.type("hello world");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+'`);
  expect((await board(page)).settings.gridEnabled).toBe(true);
  await page.keyboard.press("Alt+/");
  await expect(page.getByTestId("stat-x")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("stats-empty")).toBeVisible();

  await page.keyboard.press("Alt+z");
  await expect(page.getByTestId("zen-banner")).toBeVisible();
  await expect(page.getByTestId("stats")).toHaveCount(0);
  await page.getByTestId("leave-zen").click();
  await expect(page.getByTestId("stats")).toBeVisible();

  await page.keyboard.press(`${mod}+f`);
  await expect(page.getByTestId("search-status")).toContainText("Type to find");
  await page.getByTestId("search-input").fill("world");
  await expect(page.getByTestId("search-status")).toHaveText("1 of 1");
  await page.getByTestId("search-input").fill("zzz");
  await expect(page.getByTestId("search-status")).toContainText("No matches");
  await page.getByTestId("search-input").press("Escape");

  await page.keyboard.press("Alt+r");
  await expect(page.getByTestId("view-mode-banner")).toBeVisible();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press("Delete");
  await page.keyboard.press("r");
  await drag(page, { x: 500, y: 200 }, { x: 600, y: 300 });
  await expectCount(page, 1);
  await page.getByTestId("leave-view-mode").click();
  await expect(page.getByTestId("view-mode-banner")).toHaveCount(0);
});

test("board settings: colour, input preference and pen mode persist", async ({ page }) => {
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-settings").click();
  await page.getByTestId("board-color-mist").click();
  await page.getByTestId("input-mouse").click();
  await expect(page.getByTestId("input-explainer")).toContainText("wheel zooms");
  await page.getByTestId("pref-pen").check();
  await page.keyboard.press("Escape");
  await page.reload();
  expect((await board(page)).settings.viewBackgroundColor).toBe("#eef6f4");
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("chalanamaya.prefs")!));
  expect(prefs).toMatchObject({ inputPreference: "mouse", penMode: true });
});

test("SVG export with dark theme and embedded data reopens", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 280 });
  await page.keyboard.press(`${mod}+Shift+e`);
  await page.getByTestId("export-format-svg").click();
  await page.getByTestId("export-theme-dark").click();
  await page.getByTestId("export-embed").check();
  await expect(page.getByTestId("embed-warning")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const file = await (await download).path();
  const svg = await readFile(file, "utf8");
  expect(svg).toContain("<svg");
  expect(svg).toContain("#172524");
  expect(svg).toContain('id="chalanamaya-scene"');

  // reopen into a fresh board
  await freshBoard(page);
  await page.getByTestId("file-input").setInputFiles({
    name: "board.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(svg),
  });
  await expectCount(page, 1);
  // damaged data is refused without changing the board
  await page.getByTestId("file-input").setInputFiles({
    name: "bad.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg><metadata id="chalanamaya-scene">%%%</metadata></svg>'),
  });
  await expect(page.getByTestId("toast").last()).toContainText("damaged");
});

test("PNG export embeds editable data", async ({ page }) => {
  await box(page, { x: 200, y: 200 }, { x: 300, y: 280 });
  await page.keyboard.press(`${mod}+Shift+e`);
  await page.getByTestId("export-embed").check();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const png = await readFile(await (await download).path());
  expect(png.includes(Buffer.from("tEXtchalanamaya"))).toBe(true);
  await freshBoard(page);
  await page
    .getByTestId("file-input")
    .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: png });
  await expectCount(page, 1);
});

test("copy as text and SVG", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("t");
  await clickBoard(page, { x: 300, y: 300 });
  await page.keyboard.type("copy me");
  await page.keyboard.press("Escape");
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-copy-text").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy me");
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-copy-svg").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("<svg");
});

test("edit path points and dark theme screenshot", async ({ page }) => {
  await page.keyboard.press("l");
  await drag(page, { x: 200, y: 300 }, { x: 500, y: 300 });
  await page.getByTestId("edit-points").click();
  // drag the midpoint handle to add a bend
  await drag(page, { x: 350, y: 300 }, { x: 350, y: 200 });
  const line = (await els(page))[0];
  expect((line.points as unknown[]).length).toBe(3);
  await page.keyboard.press("Delete");
  await expect.poll(async () => ((await els(page))[0].points as unknown[]).length).toBe(2);
  await page.keyboard.press("Escape");

  await page.keyboard.press("n");
  await clickBoard(page, { x: 700, y: 300 });
  await page.keyboard.type("Dark note");
  await page.keyboard.press("Escape");
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-theme").click();
  await page.keyboard.press(`${mod}+'`);
  await page.screenshot({ path: "test-results/p1-dark.png" });
});

test("insert, crop and reset a picture; unsupported files are refused", async ({ page }) => {
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 100;
    const g = c.getContext("2d")!;
    g.fillStyle = "#007f78";
    g.fillRect(0, 0, 200, 100);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByTestId("picture-input").setInputFiles({
    name: "pic.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect.poll(async () => (await els(page)).map((e) => e.type)).toEqual(["image"]);
  const img = (await els(page))[0];
  expect(img.width / img.height).toBeCloseTo(2);

  await page.getByTestId("crop-toggle").click();
  const midY = img.y + img.height / 2;
  await drag(page, { x: img.x + img.width, y: midY }, { x: img.x + img.width - 60, y: midY });
  await page.getByTestId("crop-toggle").click();
  const cropped = (await els(page))[0];
  expect(cropped.width).toBeCloseTo(img.width - 60, 0);
  expect(cropped.height).toBeCloseTo(img.height, 0);
  expect(cropped.crop).toBeTruthy();
  await page.getByTestId("crop-reset").click();
  const reset = (await els(page))[0];
  expect(reset.crop).toBeNull();
  expect(reset.width).toBeCloseTo(img.width, 0);

  await page.getByTestId("picture-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByTestId("toast").last()).toContainText("isn't a supported picture");
  await expectCount(page, 1);
});
