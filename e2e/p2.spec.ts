import { expect, test, type Page } from "@playwright/test";
import { boardBox, clickBoard, drag, expectCount, freshBoard, storedElements } from "./helpers";

const pasteText = async (page: Page, text: string) => {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, text);
};

const sketch = async (page: Page, pts: { x: number; y: number }[]) => {
  const b = await boardBox(page);
  await page.mouse.move(b.x + pts[0].x, b.y + pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(b.x + p.x, b.y + p.y, { steps: 3 });
  await page.mouse.up();
};

test("Shape tidy turns a sketched box into a box, undo restores the sketch", async ({ page }) => {
  await freshBoard(page);
  await page.getByTestId("tool-tidy").click();
  await sketch(page, [
    { x: 300, y: 200 },
    { x: 500, y: 204 },
    { x: 502, y: 340 },
    { x: 298, y: 338 },
    { x: 300, y: 202 },
  ]);
  await expect
    .poll(async () => (await storedElements(page)).map((e) => e.type))
    .toEqual(["rectangle"]);
  await page.getByTestId("undo").click();
  await expect
    .poll(async () => (await storedElements(page)).map((e) => e.type))
    .toEqual(["freedraw"]);
  // a scribble stays a sketch
  await page.keyboard.press("s");
  await sketch(page, [
    { x: 600, y: 400 },
    { x: 640, y: 460 },
    { x: 680, y: 400 },
    { x: 720, y: 460 },
  ]);
  await expectCount(page, 2);
  expect((await storedElements(page)).map((e) => e.type)).toEqual(["freedraw", "freedraw"]);
});

test("Pour colour fills a closed shape only", async ({ page }) => {
  await freshBoard(page);
  await page.keyboard.press("r");
  await drag(page, { x: 300, y: 200 }, { x: 460, y: 320 });
  await expectCount(page, 1);
  await page.keyboard.press("b");
  await page.getByTestId("fill-ffd9b8").click();
  await clickBoard(page, { x: 380, y: 260 });
  await expect.poll(async () => (await storedElements(page))[0].backgroundColor).toBe("#ffd9b8");
  // empty space changes nothing
  await clickBoard(page, { x: 800, y: 600 });
  await expect(page.getByTestId("toast").last()).toContainText("closed shapes");
  expect(await storedElements(page)).toHaveLength(1);
});

test("Spotlight draws a fading trail that is never saved", async ({ page }) => {
  await freshBoard(page);
  await page.keyboard.press("r");
  await drag(page, { x: 300, y: 200 }, { x: 460, y: 320 });
  await expectCount(page, 1);
  const before = await storedElements(page);
  await page.getByTestId("tool-laser").click();
  await drag(page, { x: 200, y: 200 }, { x: 600, y: 400 }, 20);
  await page.waitForTimeout(1600);
  expect(await storedElements(page)).toEqual(before);
  // also usable in look-only mode
  await page.keyboard.press("Alt+r");
  await page.keyboard.press("x");
  await expect(page.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
});

test("Web cards: embeddable link, safe link and invalid address", async ({ page }) => {
  await freshBoard(page);
  await page.keyboard.press("w");
  await clickBoard(page, { x: 500, y: 350 });
  const dialog = page.getByTestId("webcard-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("webcard-input").fill("not a link");
  await page.getByTestId("webcard-save").click();
  await expect(page.getByTestId("webcard-error")).toContainText("valid web address");
  await page.getByTestId("webcard-input").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await expect(page.getByTestId("webcard-preview")).toContainText("YouTube");
  await page.getByTestId("webcard-save").click();
  await expect(dialog).toBeHidden();
  await expectCount(page, 1);
  const frame = page.getByTestId("webcard-frame");
  await expect(frame).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
  await expect(frame).toHaveCSS("pointer-events", "none");
  // double-click to use the page; clicking the board returns
  await page.mouse.dblclick((await boardBox(page)).x + 500, (await boardBox(page)).y + 350);
  await expect(page.getByTestId("webcard-active")).toBeVisible();
  await expect(frame).toHaveCSS("pointer-events", "auto");
  await clickBoard(page, { x: 1000, y: 700 });
  await expect(page.getByTestId("webcard-active")).toBeHidden();

  await page.keyboard.press("w");
  await clickBoard(page, { x: 400, y: 650 });
  await page.getByTestId("webcard-input").fill("example.com");
  await page.getByTestId("webcard-save").click();
  await expectCount(page, 2);
  const link = page.getByTestId("webcard-open");
  await expect(link).toHaveAttribute("href", "https://example.com/");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("Pasted spreadsheet rows preview and create a chart; cancel changes nothing", async ({
  page,
}) => {
  await freshBoard(page);
  await page.getByTestId("board").click();
  const rows = "Fruit\tSold\nApples\t12\nPears\t7\nPlums\t9";
  await pasteText(page, rows);
  const dialog = page.getByTestId("chart-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("chart-labels")).toHaveText("Apples, Pears, Plums");
  await page.getByTestId("chart-cancel").click();
  await expect(dialog).toBeHidden();
  expect(await storedElements(page)).toHaveLength(0);

  await pasteText(page, rows);
  await page.getByTestId("chart-data").fill("a\tb\nc\td");
  await expect(page.getByTestId("chart-error")).toContainText("No column of numbers");
  await expect(page.getByTestId("chart-insert")).toBeDisabled();
  await page.getByTestId("chart-data").fill(rows);
  await page.getByTestId("chart-kind-radar").click();
  await expect(page.getByTestId("chart-preview").locator("img")).toBeVisible();
  await page.getByTestId("chart-insert").click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await storedElements(page)).length).toBeGreaterThan(5);
  const els = await storedElements(page);
  expect(els.some((e) => e.type === "text" && e.text === "Pears")).toBe(true);
});

test("Board overview shows the view and moves it on click", async ({ page }) => {
  await freshBoard(page);
  await page.getByTestId("minimap-toggle").click();
  await expect(page.getByTestId("minimap-empty")).toBeVisible();
  await page.keyboard.press("r");
  await drag(page, { x: 300, y: 200 }, { x: 460, y: 320 });
  await page.keyboard.press("r");
  await drag(page, { x: 900, y: 500 }, { x: 1000, y: 600 });
  await expect(page.getByTestId("minimap-empty")).toBeHidden();
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("chalanamaya.prefs") ?? "{}"),
  );
  expect(before.minimap).toBe(true);
  const map = page.getByTestId("minimap-canvas");
  const mb = (await map.boundingBox())!;
  const zoomBefore = await page.getByTestId("zoom-value").textContent();
  // drag the view inside the overview; the main view follows
  await page.mouse.move(mb.x + 20, mb.y + 20);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width - 20, mb.y + mb.height - 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("zoom-value")).toHaveText(zoomBefore!);
  // the first box is now off screen to the upper left: clicking on it via the board misses
  await page.keyboard.press("v");
  await clickBoard(page, { x: 380, y: 260 });
  await expect(page.getByTestId("properties")).toHaveCount(0);
});

test("pencil pressure can be switched off in settings", async ({ page }) => {
  await freshBoard(page);
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-settings").click();
  const box = page.getByTestId("pref-pressure");
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("chalanamaya.prefs") ?? "{}")))
    .toMatchObject({ pencilPressure: false });
});

test("Board overview never covers the properties panel at 1280x800", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshBoard(page);
  await page.getByTestId("minimap-toggle").click();
  const topAtCentre = async () => {
    const del = page.getByTestId("action-delete");
    await del.scrollIntoViewIfNeeded();
    return del.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = node.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && (hit === node || node.contains(hit));
    });
  };
  const noOverlap = async () => {
    const props = (await page.getByTestId("properties").boundingBox())!;
    const map = (await page.getByTestId("minimap").boundingBox())!;
    expect(props.y + props.height).toBeLessThanOrEqual(map.y);
  };
  // a box has the tallest panel
  await page.keyboard.press("r");
  await drag(page, { x: 300, y: 200 }, { x: 460, y: 320 });
  await expect(page.getByTestId("properties")).toBeVisible();
  await noOverlap();
  expect(await topAtCentre()).toBe(true);
  await page.getByTestId("action-delete").click();
  await expectCount(page, 0);
  // and a text item
  await page.keyboard.press("t");
  await clickBoard(page, { x: 400, y: 300 });
  await page.keyboard.type("hello");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("properties")).toBeVisible();
  await noOverlap();
  expect(await topAtCentre()).toBe(true);
});
