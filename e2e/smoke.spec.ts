import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STORAGE_KEY, clickBoard, drag, expectCount, freshBoard, storedElements } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";

const drawBox = async (
  page: Page,
  key: string,
  from = { x: 300, y: 200 },
  to = { x: 420, y: 290 },
) => {
  await page.keyboard.press(key);
  await drag(page, from, to);
};

test.beforeEach(async ({ page }) => {
  await freshBoard(page);
});

test("draws box, diamond and oval; undo and redo", async ({ page }) => {
  await drawBox(page, "r");
  await drawBox(page, "d", { x: 480, y: 200 }, { x: 580, y: 300 });
  await drawBox(page, "o", { x: 640, y: 200 }, { x: 760, y: 280 });
  let els = await storedElements(page);
  expect(els.map((e) => e.type)).toEqual(["rectangle", "diamond", "ellipse"]);
  expect(els[0].width).toBeGreaterThan(100);
  // tool returns to Pick after drawing
  await expect(page.getByTestId("tool-pick")).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press(`${mod}+z`);
  await expectCount(page, 2);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expectCount(page, 3);

  // a tiny click with the box tool does not leave an invisible shape
  await page.keyboard.press("r");
  await clickBoard(page, { x: 900, y: 500 });
  els = await storedElements(page);
  expect(els).toHaveLength(3);
});

test("connector binds to shapes and follows them", async ({ page }) => {
  await drawBox(page, "r", { x: 200, y: 200 }, { x: 320, y: 300 });
  await drawBox(page, "r", { x: 600, y: 200 }, { x: 720, y: 300 });
  await page.keyboard.press("a");
  await drag(page, { x: 260, y: 250 }, { x: 660, y: 250 }, 15);
  let els = await storedElements(page);
  const arrow = els.find((e) => e.type === "arrow")!;
  expect(arrow.startBinding?.elementId).toBe(els[0].id);
  expect(arrow.endBinding?.elementId).toBe(els[1].id);

  // move the second box; the connector end follows
  const before = arrow.x + arrow.points![arrow.points!.length - 1].x;
  await drag(page, { x: 720, y: 280 }, { x: 720, y: 440 }, 10);
  els = await storedElements(page);
  const moved = els.find((e) => e.type === "arrow")!;
  const endY = moved.y + moved.points![moved.points!.length - 1].y;
  expect(endY).toBeGreaterThan(300);
  expect(moved.x + moved.points![moved.points!.length - 1].x).toBeCloseTo(before, -1);
});

test("path tool, closing polygon, and sketch pencil", async ({ page }) => {
  await page.keyboard.press("l");
  await clickBoard(page, { x: 300, y: 300 });
  await clickBoard(page, { x: 400, y: 260 });
  await clickBoard(page, { x: 460, y: 360 });
  await page.keyboard.press("Enter");
  let els = await storedElements(page);
  expect(els[0].type).toBe("line");
  expect(els[0].points).toHaveLength(3);

  await page.keyboard.press("p");
  await drag(page, { x: 600, y: 300 }, { x: 760, y: 380 }, 20);
  els = await storedElements(page);
  expect(els[1].type).toBe("freedraw");
  expect(els[1].points!.length).toBeGreaterThan(5);
});

test("words tool and text inside a shape", async ({ page }) => {
  await page.keyboard.press("t");
  await clickBoard(page, { x: 300, y: 200 });
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Hello lagoon");
  await page.keyboard.press("Escape");
  let els = await storedElements(page);
  expect(els[0].type).toBe("text");
  expect(els[0].text).toBe("Hello lagoon");

  await drawBox(page, "r", { x: 400, y: 350 }, { x: 600, y: 450 });
  await page.mouse.dblclick((await page.getByTestId("board").boundingBox())!.x + 500, 400);
  await expect(editor).toBeFocused();
  await page.keyboard.type("Inside");
  await page.keyboard.press("Escape");
  els = await storedElements(page);
  const bound = els.find((e) => e.text === "Inside")!;
  expect(bound.containerId).toBe(els.find((e) => e.type === "rectangle")!.id);

  // empty text is not kept
  await page.keyboard.press("t");
  await clickBoard(page, { x: 900, y: 600 });
  await page.keyboard.press("Escape");
  await expectCount(page, 3);
});

test("styling the selection and new shapes", async ({ page }) => {
  await drawBox(page, "r");
  await expect(page.getByTestId("properties")).toBeVisible();
  await page.getByTestId("stroke-b65b24").click();
  await page.getByTestId("fill-bfe8e2").click();
  await page.getByTestId("width-extra").click();
  let el = (await storedElements(page))[0];
  expect(el.strokeColor).toBe("#b65b24");
  expect(el.backgroundColor).toBe("#bfe8e2");
  expect(el.strokeWidth).toBe(4.5);

  await page.keyboard.press("t");
  await page.getByTestId("font-code").click();
  await page.getByTestId("size-l").click();
  await page.getByTestId("align-right").click();
  await clickBoard(page, { x: 700, y: 500 });
  await page.keyboard.type("code text");
  await page.keyboard.press("Escape");
  el = (await storedElements(page))[1];
  expect(el.fontFamily).toBe("code");
  expect(el.fontSize).toBe(28);
  expect(el.textAlign).toBe("right");
});

test("select all, duplicate, copy/paste, cut and delete", async ({ page }) => {
  await drawBox(page, "r");
  await drawBox(page, "o", { x: 500, y: 200 }, { x: 600, y: 300 });
  await page.keyboard.press(`${mod}+a`);
  await expect(page.getByTestId("properties")).toContainText("2 selected");
  await page.keyboard.press(`${mod}+d`);
  await expectCount(page, 4);
  await page.keyboard.press("Delete");
  await expectCount(page, 2);

  // box-select the first shape, then copy + paste
  await drag(page, { x: 280, y: 180 }, { x: 440, y: 310 });
  await expect(page.getByTestId("properties")).toContainText("1 selected");
  await page.keyboard.press(`${mod}+c`);
  await clickBoard(page, { x: 800, y: 500 });
  await page.keyboard.press(`${mod}+v`);
  await expectCount(page, 3);
  await page.keyboard.press(`${mod}+x`);
  await expectCount(page, 2);
});

test("move, resize and rotate the selection", async ({ page }) => {
  await drawBox(page, "r", { x: 300, y: 200 }, { x: 400, y: 300 });
  // move
  await drag(page, { x: 350, y: 250 }, { x: 450, y: 300 });
  let el = (await storedElements(page))[0];
  expect(el.x).toBeCloseTo(400, -1);
  expect(el.y).toBeCloseTo(250, -1);
  // resize from bottom-right handle
  const right = el.x + el.width;
  const bottom = el.y + el.height;
  const w0 = el.width;
  const h0 = el.height;
  await drag(page, { x: right + 4, y: bottom + 4 }, { x: right + 54, y: bottom + 34 });
  el = (await storedElements(page))[0];
  // the edge follows the pointer delta exactly (no jump by the handle padding)
  expect(el.width).toBeCloseTo(w0 + 50, 0);
  expect(el.height).toBeCloseTo(h0 + 30, 0);
  // rotate from the handle above the box
  await drag(
    page,
    { x: el.x + el.width / 2, y: el.y - 26 },
    { x: el.x + el.width + 80, y: el.y + el.height / 2 },
  );
  el = (await storedElements(page))[0];
  expect(Math.abs(el.angle)).toBeGreaterThan(0.5);
});

test("zoom, fit and pan", async ({ page }) => {
  const zoom = page.getByTestId("zoom-value");
  await expect(zoom).toHaveText("100%");
  await page.getByTestId("zoom-in").click();
  await expect(zoom).toHaveText("120%");
  await page.keyboard.press(`${mod}+0`);
  await expect(zoom).toHaveText("100%");
  await drawBox(page, "r", { x: 300, y: 200 }, { x: 340, y: 230 });
  await page.getByTestId("zoom-fit").click();
  await expect(zoom).not.toHaveText("100%");

  // grab canvas pans without changing elements
  const before = (await storedElements(page))[0];
  await page.keyboard.press("h");
  await drag(page, { x: 600, y: 400 }, { x: 700, y: 450 });
  const after = (await storedElements(page))[0];
  expect(after.x).toBe(before.x);
});

test("toolbar hints and shortcuts help", async ({ page }) => {
  await page.getByTestId("tool-rectangle").hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Box — rectangle" })).toBeVisible();
  await page.getByTestId("undo").focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "Nothing to undo yet" })).toBeVisible();

  await page.getByTestId("board").focus();
  await page.keyboard.press("?");
  const help = page.getByTestId("help-dialog");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Zoom to fit all");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("autosave survives reload", async ({ page }) => {
  await drawBox(page, "r");
  await expectCount(page, 1);
  await page.reload();
  await expectCount(page, 1);
  await expect(page.getByTestId("zoom-fit")).not.toHaveAttribute("aria-disabled", "true");
});

test("save and open a .chalana file, rejecting invalid files", async ({ page }, info) => {
  await drawBox(page, "r");
  await drawBox(page, "o", { x: 500, y: 200 }, { x: 600, y: 300 });
  await page.getByTestId("menu-button").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("menu-save").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.chalana$/);
  const path = info.outputPath("board.chalana");
  await download.saveAs(path);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.type).toBe("chalana");
  expect(saved.version).toBe(1);
  expect(saved.elements).toHaveLength(2);

  // invalid file leaves the board unchanged
  await page.getByTestId("file-input").setInputFiles({
    name: "broken.chalana",
    mimeType: "application/json",
    buffer: Buffer.from("{ not json"),
  });
  await expect(page.getByTestId("toast").filter({ hasText: "Couldn't open" })).toBeVisible();
  await expectCount(page, 2);

  // clear the board, then open the saved file back
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-clear").click();
  await page.getByTestId("confirm-ok").click();
  await expectCount(page, 0);
  await page.getByTestId("file-input").setInputFiles(path);
  await expectCount(page, 2);
});

test("export PNG with options", async ({ page }) => {
  await drawBox(page, "r");
  await page.keyboard.press(`${mod}+Shift+e`);
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("export-background").uncheck();
  await page.getByTestId("export-scale-1").click();
  await expect(dialog).toContainText("Output:");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-confirm").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const path = await download.path();
  const bytes = await readFile(path);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
});

test("paste text and images from the clipboard", async ({ page }) => {
  await page.getByTestId("board").focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted note");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect
    .poll(async () => (await storedElements(page)).map((e) => e.text))
    .toEqual(["pasted note"]);

  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 30;
    c.getContext("2d")!.fillRect(0, 0, 40, 30);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "dot.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect
    .poll(async () => (await storedElements(page)).map((e) => e.type))
    .toEqual(["text", "image"]);
});

test("clear board asks first and can be undone", async ({ page }) => {
  await drawBox(page, "r");
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-clear").click();
  await expect(page.getByTestId("clear-dialog")).toContainText("including locked ones");
  await page.getByTestId("confirm-cancel").click();
  await expectCount(page, 1);
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-clear").click();
  await page.getByTestId("confirm-ok").click();
  await expectCount(page, 0);
  await page.keyboard.press(`${mod}+z`);
  await expectCount(page, 1);
});

test("theme switch keeps the board", async ({ page }) => {
  await drawBox(page, "r");
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-theme").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-theme", "dark");
  // the theme is part of the autosaved board settings straight away
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}").settings?.theme,
        STORAGE_KEY,
      ),
    )
    .toBe("dark");
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-theme", "dark");
  await expectCount(page, 1);
});

test("style changes while typing undo and redo in linear order", async ({ page }) => {
  await drawBox(page, "r");
  await page.keyboard.press("Enter");
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("hello");
  await page.getByTestId("font-code").click();
  await page.getByTestId("size-xl").click();
  await expect(editor).toBeFocused();
  await page.keyboard.press("Escape");
  const label = async () => {
    const els = await storedElements(page);
    const t = els.find((e) => e.type === "text");
    return `${els.length}:${t ? `${t.text}/${t.fontFamily}/${t.fontSize}` : "-"}`;
  };
  await expect.poll(label).toBe("2:hello/code/40");

  await page.getByTestId("board").focus();
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(label).toBe("1:-");
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(label).toBe("0:-");
  await page.keyboard.press(`${mod}+z`);
  await expect(page.getByTestId("toast").filter({ hasText: "Nothing to undo" })).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(label).toBe("1:-");
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(label).toBe("2:hello/code/40");
});

test("dialogs return focus to the control that opened them", async ({ page }) => {
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-help").click();
  await expect(page.getByTestId("help-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-dialog")).toBeHidden();
  await expect(page.getByTestId("menu-button")).toBeFocused();

  await page.getByTestId("board").focus();
  await page.keyboard.press("?");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("board")).toBeFocused();
});
