// Phase 6: animated CSS components and board deletion (docs/features/07-media.md,
// docs/features/06-sessions-and-agents.md). Components show in a sandboxed frame
// with a CSP, move and resize like other items, pause under reduced motion and
// export as a static card; the attack corpus neither runs nor loads anything.
// Deleting a board removes it on the server and tells open tabs at once.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, callError, httpClient } from "../server/mcp/testClient";
import { boardBox, drag, freshBoard, serverBoard, sessionId, settled } from "./helpers";

const BASE = "http://localhost:5184";
const mod = process.platform === "darwin" ? "Meta" : "Control";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

interface Item {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paused?: boolean;
}
const items = (page: Page): Promise<Item[]> =>
  page.evaluate(() =>
    (
      window as unknown as { __chalanaSync: { host: { scene(): { elements: Item[] } } } }
    ).__chalanaSync.host
      .scene()
      .elements.map((e) => ({
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        paused: e.paused,
      })),
  );

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

const toScreen = async (page: Page, p: { x: number; y: number }) => {
  const v = await page.evaluate(() =>
    (
      window as unknown as {
        __chalanaMedia: { view(): { zoom: number; scrollX: number; scrollY: number } };
      }
    ).__chalanaMedia.view(),
  );
  const box = await boardBox(page);
  return { x: (p.x + v.scrollX) * v.zoom, y: (p.y + v.scrollY) * v.zoom, box };
};

/** Records any request to the attacker's host. */
const watchEvil = async (page: Page) => {
  const hits: string[] = [];
  await page.context().route(/evil\.example/, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, body: "" });
  });
  return hits;
};

let client: Client;
test.beforeAll(async () => {
  client = await httpClient(BASE, "e2e-components");
});
test.afterAll(async () => {
  await client?.close();
});

test("a built-in component is sandboxed, moves, resizes, pauses and exports as a card", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await freshBoard(page);
  await connected(page);
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-insert-component").click();
  await page.getByTestId("component-preset").selectOption("spinner");
  await page.getByTestId("component-title").fill("Loading");
  await expect(page.getByTestId("component-preview")).toHaveAttribute("sandbox", "");
  await page.getByTestId("component-save").click();
  await expect.poll(async () => (await items(page)).length).toBe(1);
  const [comp] = await items(page);
  expect(comp.type).toBe("component");

  const frame = page.locator(`[data-testid="live-component"][data-id="${comp.id}"]`);
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("data-paused", "false");
  const srcdoc = (await frame.getAttribute("srcdoc"))!;
  expect(srcdoc).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  expect(srcdoc).not.toMatch(/<script/i);
  // the frame never takes the pointer, and the selection frame sits above it
  await expect(frame).toHaveCSS("pointer-events", "none");
  const z = await page.evaluate(() => ({
    top: getComputedStyle(document.querySelector(".board-top")!).zIndex,
    live: getComputedStyle(document.querySelector(".livemedia")!).zIndex,
  }));
  expect(Number(z.top)).toBeGreaterThan(Number(z.live));

  // a drag on it moves it (the board handles the pointer)
  const c = await toScreen(page, { x: comp.x + comp.width / 2, y: comp.y + comp.height / 2 });
  await drag(page, { x: c.x, y: c.y }, { x: c.x + 120, y: c.y + 40 });
  await expect.poll(async () => Math.round((await items(page))[0].x - comp.x)).toBe(120);
  // the bottom-right handle resizes it, and the frame follows
  const moved = (await items(page))[0];
  const br = await toScreen(page, { x: moved.x + moved.width, y: moved.y + moved.height });
  await drag(page, { x: br.x + 4, y: br.y + 4 }, { x: br.x + 84, y: br.y + 64 });
  await expect.poll(async () => (await items(page))[0].width).toBeGreaterThan(comp.width + 40);
  const resized = (await items(page))[0];
  await expect(frame).toHaveCSS("width", `${resized.width}px`);
  const b = await serverBoard(page);
  expect(b.elements[0]).toMatchObject({ type: "component", title: "Loading" });

  // Pause is shared and rebuilds the frame paused
  await page.getByTestId("component-play").click();
  await expect(frame).toHaveAttribute("data-paused", "true");
  expect(await frame.getAttribute("srcdoc")).toContain("animation-play-state:paused");
  await expect.poll(async () => (await items(page))[0].paused).toBe(true);
  await page.getByTestId("component-play").click();
  await expect(frame).toHaveAttribute("data-paused", "false");

  // PNG and SVG exports show the static card
  await page.keyboard.press(`${mod}+Shift+e`);
  const png = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const pngBytes = await readFile(await (await png).path());
  expect(pngBytes.subarray(1, 4).toString()).toBe("PNG");
  await page.keyboard.press(`${mod}+Shift+e`);
  await page.getByTestId("export-format-svg").click();
  const svgDl = page.waitForEvent("download");
  await page.getByTestId("export-confirm").click();
  const svg = await readFile(await (await svgDl).path(), "utf8");
  expect(svg).toContain("Loading");
  expect(svg).toContain("Animated component");
  expect(svg).not.toMatch(/<iframe|<foreignObject|spinner-ring/i);
  expect(errors).toEqual([]);
});

test("reduced motion starts components paused in this tab only", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const r = await call(client, "add_elements", {
    session_id: id,
    elements: [{ type: "component", preset: "pulse", x: 100, y: 100 }],
  });
  const eid = r.created[0].id as string;
  const frame = page.locator(`[data-testid="live-component"][data-id="${eid}"]`);
  await expect(frame).toBeVisible({ timeout: 5000 });
  await expect(frame).toHaveAttribute("data-paused", "true");
  expect(await frame.getAttribute("srcdoc")).toContain("animation-play-state:paused");
  // play anyway is this tab's choice; the board stays unpaused
  const c = await toScreen(page, { x: 160, y: 160 });
  await page.mouse.click(c.box.x + c.x, c.box.y + c.y);
  await expect(page.getByTestId("component-reduced-motion")).toBeVisible();
  await page.getByTestId("component-play").click();
  await expect(frame).toHaveAttribute("data-paused", "false");
  expect((await serverBoard(page)).elements[0]).not.toMatchObject({ paused: true });
});

const HTML_ATTACKS = [
  '<img src="https://evil.example/onerror.png" onerror="parent.document.title=\'pwned\'">',
  "<script>parent.document.title='pwned'</script>",
  "<a href=\"javascript:parent.document.title='pwned'\">x</a>",
  '<meta http-equiv="refresh" content="0;url=https://evil.example/refresh">',
  '<iframe src="https://evil.example/frame"></iframe>',
  '<form action="https://evil.example/form"><button>go</button></form>',
  '<link rel="stylesheet" href="https://evil.example/link.css">',
  '<svg><foreignObject><img src="x" onerror="parent.document.title=\'pwned\'"></foreignObject></svg>',
  '<div style="background:url(https://evil.example/inline.png)">x</div>',
];
const CSS_ATTACKS = [
  '@import url("https://evil.example/import.css");',
  "body{background:url(https://evil.example/bg.png)}",
  "</style><script>parent.document.title='pwned'</script>",
];

test("the attack corpus is refused, and even raw in the sandbox it neither runs nor loads", async ({
  page,
}) => {
  const hits = await watchEvil(page);
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  // the agent path refuses each one with a named rule
  for (const html of HTML_ATTACKS) {
    const e = await callError(client, "add_elements", {
      session_id: id,
      elements: [{ type: "component", html, css: "" }],
    });
    expect(e.code, html).toBe("unsafe_component");
  }
  for (const css of CSS_ATTACKS) {
    const e = await callError(client, "add_elements", {
      session_id: id,
      elements: [{ type: "component", html: "<p>x</p>", css }],
    });
    expect(e.code, css).toBe("unsafe_component");
  }
  // the dialog explains the rule and won't add it
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-insert-component").click();
  await page.getByTestId("component-mode-custom").click();
  await page.getByTestId("component-html").fill(HTML_ATTACKS[0]);
  await expect(page.getByTestId("component-error")).toContainText("no_event_attributes");
  await expect(page.getByTestId("component-save")).toBeDisabled();
  await page.keyboard.press("Escape");

  // defence in depth: the same sandbox and CSP with the corpus left unsanitised
  const raw = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${CSS_ATTACKS.join("\n")}</style></head><body>${HTML_ATTACKS.join("\n")}</body></html>`;
  await page.evaluate((doc) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "");
    f.setAttribute("data-testid", "raw-attack");
    f.srcdoc = doc;
    document.body.append(f);
  }, raw);
  await page.waitForTimeout(1500);
  expect(await page.title()).not.toBe("pwned");
  expect(hits).toEqual([]);
  // the frame was not navigated away by the meta refresh
  const url = await page.evaluate(
    () => (document.querySelector("[data-testid=raw-attack]") as HTMLIFrameElement).src,
  );
  expect(url).toBe("");
  expect(await items(page)).toEqual([]);
});

test("a custom component placed by an agent shows live and round-trips", async ({ page }) => {
  const hits = await watchEvil(page);
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const r = await call(client, "add_elements", {
    session_id: id,
    elements: [
      {
        type: "component",
        title: "Badge",
        html: '<div class="b">New</div>',
        css: ".b{animation:p 1s infinite;color:#007f78}@keyframes p{50%{opacity:.4}}",
        x: 50,
        y: 50,
        width: 200,
        height: 120,
      },
    ],
  });
  const eid = r.created[0].id as string;
  const frame = page.locator(`[data-testid="live-component"][data-id="${eid}"]`);
  await expect(frame).toBeVisible({ timeout: 5000 });
  const inner = page.frameLocator(`[data-testid="live-component"][data-id="${eid}"]`);
  await expect(inner.locator(".b")).toHaveText("New");
  const full = await call(client, "get_scene", { session_id: id, ids: [eid], detail: "full" });
  expect(full.elements[0]).toMatchObject({ html: '<div class="b">New</div>', title: "Badge" });
  expect(hits).toEqual([]);
});

test("deleting a board removes it and tells another open tab at once", async ({
  page,
  context,
}) => {
  await freshBoard(page);
  await connected(page);
  await page.keyboard.press("r");
  await drag(page, { x: 300, y: 300 }, { x: 400, y: 380 });
  await settled(page);
  const id = sessionId(page);
  const other = await context.newPage();
  await other.goto(page.url());
  await connected(other);

  await page.getByTestId("menu-button").click();
  await page.getByTestId("session-delete").click();
  await expect(page.getByTestId("delete-board-dialog")).toContainText("can't be undone");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("board-missing")).toBeVisible({ timeout: 10000 });
  // the other tab hears it on the socket, without reloading
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-state", "gone", {
    timeout: 5000,
  });
  const status = await page.evaluate(
    async (s) => (await fetch(`/api/sessions/${s}/scene`)).status,
    id,
  );
  expect(status).toBe(404);
  const e = await callError(client, "get_scene", { session_id: id });
  expect(e.code).toBe("session_not_found");
  await other.close();
});
