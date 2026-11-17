import { expect, test, type Page } from "@playwright/test";
import { boardBox, clickBoard, expectCount, freshBoard } from "./helpers";

// DRAW-14: Esc and Done return from a live web card to the board.
const addCard = async (page: Page) => {
  await freshBoard(page);
  await page.keyboard.press("w");
  await clickBoard(page, { x: 500, y: 350 });
  await page.getByTestId("webcard-input").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.getByTestId("webcard-save").click();
  await expectCount(page, 1);
};

const focusIsNotInFrame = (page: Page) =>
  page.evaluate(() => document.activeElement?.tagName !== "IFRAME");

test("Esc after double-click returns to the board", async ({ page }) => {
  await addCard(page);
  const b = await boardBox(page);
  await page.mouse.dblclick(b.x + 500, b.y + 350);
  const active = page.getByTestId("webcard-active");
  await expect(active).toBeVisible();
  // the wrapper holds focus, not the cross-origin page
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
    "webcard",
  );
  await page.keyboard.press("Escape");
  await expect(active).toBeHidden();
  await expect(page.getByTestId("webcard-frame")).toHaveCSS("pointer-events", "none");
  expect(await focusIsNotInFrame(page)).toBe(true);
  // board shortcuts work again straight away
  await page.keyboard.press("r");
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-pressed", "true");
});

test("Esc after Enter returns to the board", async ({ page }) => {
  await addCard(page);
  await page.keyboard.press("v");
  await clickBoard(page, { x: 500, y: 350 });
  await page.keyboard.press("Enter");
  const active = page.getByTestId("webcard-active");
  await expect(active).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(active).toBeHidden();
  expect(await focusIsNotInFrame(page)).toBe(true);
});

test("Done returns to the board", async ({ page }) => {
  await page.route("https://www.youtube-nocookie.com/embed/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body style="margin:0;height:100vh"><button style="width:100%;height:100%">Inside</button></body>',
    }),
  );
  await addCard(page);
  const b = await boardBox(page);
  await page.mouse.dblclick(b.x + 500, b.y + 350);
  const active = page.getByTestId("webcard-active");
  await expect(active).toBeVisible();
  await expect(page.getByTestId("webcard-hint-text")).toContainText("Esc");
  // a real click inside the page moves focus into it, where the board can't hear Esc.
  // The cross-origin page is served locally so the test doesn't depend on the network.
  const frameEl = page.frameLocator('[data-testid="webcard-frame"]');
  await expect(frameEl.getByRole("button", { name: "Inside" })).toBeVisible();
  const frame = await page.getByTestId("webcard-frame").boundingBox();
  if (!frame) throw new Error("web card frame not laid out");
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height * 0.75);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");
  await expect(page.getByTestId("webcard-hint-text")).toHaveText(
    "Click Done or the board to return",
  );
  // Esc inside the cross-origin page can't reach the board, so the card stays live
  await page.keyboard.press("Escape");
  await expect(active).toBeVisible();
  await page.getByTestId("webcard-done").click();
  await expect(active).toBeHidden();
  await expect(page.getByTestId("webcard-frame")).toHaveCSS("pointer-events", "none");
  expect(await focusIsNotInFrame(page)).toBe(true);
  await expectCount(page, 1);
  // board shortcuts work again straight away
  await page.keyboard.press("o");
  await expect(page.getByTestId("tool-ellipse")).toHaveAttribute("aria-pressed", "true");
});
