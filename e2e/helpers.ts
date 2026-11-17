import { expect, type Page } from "@playwright/test";

export const STORAGE_KEY = "chalanamaya.board.v1";

export const SESSION_URL = /\/s\/[A-Za-z0-9_-]{24}$/;

/** Opens a fresh, empty board: `/` creates a new session. */
export const freshBoard = async (page: Page) => {
  await page.goto("/");
  await expect(page).toHaveURL(SESSION_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await expect(page).toHaveURL(SESSION_URL);
  await expect(page.getByTestId("board")).toBeVisible();
};

/** The session id in the page address. */
export const sessionId = (page: Page) => {
  const m = /\/s\/([A-Za-z0-9_-]{24})/.exec(page.url());
  if (!m) throw new Error(`not a session page: ${page.url()}`);
  return m[1];
};

/** Waits until every change is acknowledged by the server. */
export const settled = async (page: Page) => {
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __chalanaSync?: { settle(): Promise<void> } })
        .__chalanaSync;
      return s ? s.settle().then(() => true) : false;
    },
    undefined,
    { timeout: 15000 },
  );
};

interface ServerBoard {
  title: string;
  settings: { viewBackgroundColor?: string; gridEnabled?: boolean };
  elements: StoredElement[];
}

/** The board as the server holds it, after the page has saved everything. */
export const serverBoard = async (page: Page, id = sessionId(page)): Promise<ServerBoard> => {
  await settled(page);
  return page.evaluate(async (sid) => {
    const r = await fetch(`/api/sessions/${sid}/scene`);
    const s = await r.json();
    return {
      title: s.title,
      settings: s.settings,
      elements: s.elements.map((e: { el: unknown }) => e.el),
    };
  }, id);
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

export interface StoredElement {
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

/** Reads the saved board from the server (saving is debounced, so this waits). */
export const storedElements = async (page: Page): Promise<StoredElement[]> =>
  (await serverBoard(page)).elements;

export const expectCount = async (page: Page, n: number) => {
  await expect.poll(async () => (await storedElements(page)).length).toBe(n);
};

/** Waits until the page shows `n` items (what is on screen, not what is saved). */
export const expectOnBoard = async (page: Page, n: number) => {
  await expect(page.getByTestId("app")).toHaveAttribute("data-items", String(n), {
    timeout: 15000,
  });
};
