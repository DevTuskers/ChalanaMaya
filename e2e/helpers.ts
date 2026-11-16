import { expect, type Page } from "@playwright/test";

export const STORAGE_KEY = "chalanamaya.board.v1";

/** Opens a fresh, empty board. */
export const freshBoard = async (page: Page) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
};

export const boardBox = async (page: Page) => {
  const box = await page.getByTestId("board").boundingBox();
  if (!box) throw new Error("board not visible");
  return box;
};

/** Drags on the board between two points given relative to the board's top-left. */
export const drag = async (
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
) => {
  const b = await boardBox(page);
  await page.mouse.move(b.x + from.x, b.y + from.y);
  await page.mouse.down();
  await page.mouse.move(b.x + to.x, b.y + to.y, { steps });
  await page.mouse.up();
};

export const clickBoard = async (page: Page, p: { x: number; y: number }) => {
  const b = await boardBox(page);
  await page.mouse.click(b.x + p.x, b.y + p.y);
};

interface StoredElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  text?: string;
  containerId?: string | null;
  strokeColor: string;
  backgroundColor?: string;
  strokeWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  textAlign?: string;
  points?: { x: number; y: number }[];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  fileId?: string;
}

/** Reads the autosaved board (autosave is debounced, so this polls). */
export const storedElements = async (page: Page): Promise<StoredElement[]> => {
  await page.waitForTimeout(400);
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw).elements as StoredElement[]) : [];
  }, STORAGE_KEY);
};

export const expectCount = async (page: Page, n: number) => {
  await expect.poll(async () => (await storedElements(page)).length).toBe(n);
};
