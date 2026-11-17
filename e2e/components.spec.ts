// Phase 6: animated CSS components and board deletion (docs/features/07-media.md,
// docs/features/06-sessions-and-agents.md). Components show in a sandboxed frame
// with a CSP, move and resize like other items, pause under reduced motion and
// export as a static card; the attack corpus neither runs nor loads anything.
// Deleting a board removes it on the server and tells open tabs at once.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { call, callError, httpClient } from "../server/mcp/testClient";
import { PRESET_NAMES } from "../src/shared/components";
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
  angle: number;
  locked: boolean;
  groupIds: string[];
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
        angle: e.angle,
        locked: e.locked,
        groupIds: e.groupIds,
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
  "<img/onerror=parent.document.title='pwned' src=\"data:image/png;base64,AA\">",
  "<svg/onload=parent.document.title='pwned'>",
  '<svg><rect width="9" height="9"><animate attributeName="width" to="90" dur="1s"/></rect></svg>',
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

/** The RGB of page pixels at screen points (one screenshot, read in the page). */
const pixels = async (page: Page, pts: { x: number; y: number }[]) => {
  const shot = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return pts.map((p) =>
        Array.from(g.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data.slice(0, 3)),
      );
    },
    { b64: shot, pts },
  );
};
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 8);

test("on the dark board live components stay see-through and their text is readable", async ({
  page,
}) => {
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  const r = await call(client, "add_elements", {
    session_id: id,
    elements: [
      { type: "component", preset: "pulse", x: 100, y: 100, width: 160, height: 160 },
      { type: "component", preset: "typing-dots", x: 400, y: 100, width: 200, height: 100 },
      { type: "component", preset: "marquee", x: 100, y: 400, width: 360, height: 60 },
      {
        type: "component",
        preset: "progress-bar",
        params: { label: "Build" },
        x: 500,
        y: 400,
        width: 320,
        height: 80,
      },
    ],
  });
  const ids = (r.created as { id: string }[]).map((c) => c.id);
  await page.getByTestId("menu-button").click();
  await page.getByTestId("menu-theme").click();
  await expect(page.getByTestId("app")).toHaveAttribute("data-theme", "dark");
  for (const eid of ids) {
    const f = page.locator(`[data-testid="live-component"][data-id="${eid}"]`);
    await expect(f).toBeVisible();
    await expect(f).toHaveAttribute("data-theme", "dark");
    await expect(f).toHaveCSS("color-scheme", "light");
  }
  await page.waitForTimeout(400);
  const box = await boardBox(page);
  const at = async (x: number, y: number) => {
    const s = await toScreen(page, { x, y });
    return { x: box.x + s.x, y: box.y + s.y };
  };
  // corners inside each frame (away from the animation) and the board next to them
  const probes = [
    await at(108, 108), // inside the pulse frame, outside the dot and its ring
    await at(90, 90), // the board beside it
    await at(406, 106), // typing-dots corner
    await at(394, 94),
    await at(104, 452), // under the marquee frame, below its text line
    await at(480, 452), // the board between the marquee and the progress bar
  ];
  const px = await pixels(page, probes);
  const board = px[1];
  // the dark paper, not a white box
  expect(board[0] + board[1] + board[2]).toBeLessThan(200);
  expect(near(px[0], board), `pulse ${px[0]} vs ${board}`).toBe(true);
  expect(near(px[2], px[3]), `typing-dots ${px[2]} vs ${px[3]}`).toBe(true);
  expect(near(px[4], px[5]), `marquee ${px[4]} vs ${px[5]}`).toBe(true);

  // text follows the theme: light ink on the dark board
  const ink = "rgb(237, 248, 243)";
  const marquee = page.frameLocator(`[data-testid="live-component"][data-id="${ids[2]}"]`);
  await expect(marquee.locator(".m span")).toHaveCSS("color", ink);
  const bar = page.frameLocator(`[data-testid="live-component"][data-id="${ids[3]}"]`);
  await expect(bar.locator(".l")).toHaveText("Build");
  await expect(bar.locator(".l")).toHaveCSS("color", ink);
  const dots = page.frameLocator(`[data-testid="live-component"][data-id="${ids[1]}"]`);
  await expect(dots.locator(".t i").first()).toHaveCSS("background-color", ink);
});

test("every preset can be added from the dialog and shows live", async ({ page }) => {
  await freshBoard(page);
  await connected(page);
  for (const name of PRESET_NAMES) {
    await page.getByTestId("menu-button").click();
    await page.getByTestId("menu-insert-component").click();
    await page.getByTestId("component-preset").selectOption(name);
    await expect(page.getByTestId("component-preview")).toHaveAttribute("sandbox", "");
    await page.getByTestId("component-save").click();
    await expect(page.getByTestId("component-dialog")).toBeHidden();
  }
  const b = await serverBoard(page);
  expect(
    b.elements.map((e) => (e as unknown as { source: { preset: string } }).source.preset),
  ).toEqual([...PRESET_NAMES]);
  await expect(page.locator('[data-testid="live-component"]')).toHaveCount(PRESET_NAMES.length);
  for (const f of await page.locator('[data-testid="live-component"]').all())
    await expect(f).toHaveAttribute("sandbox", "");
});

test("components rotate, group, lock and undo like other items", async ({ page }) => {
  await freshBoard(page);
  await connected(page);
  const id = sessionId(page);
  await call(client, "add_elements", {
    session_id: id,
    elements: [
      { type: "component", preset: "spinner", x: 200, y: 200, width: 120, height: 120 },
      { type: "component", preset: "pulse", x: 500, y: 200, width: 120, height: 120 },
    ],
  });
  await expect.poll(async () => (await items(page)).length).toBe(2);
  const [a, b] = await items(page);
  const frameA = page.locator(`[data-testid="live-component"][data-id="${a.id}"]`);
  await expect(frameA).toBeVisible();

  // select the first and rotate it from the handle above it
  const c = await toScreen(page, { x: a.x + a.width / 2, y: a.y + a.height / 2 });
  await page.mouse.click(c.box.x + c.x, c.box.y + c.y);
  const top = await toScreen(page, { x: a.x + a.width / 2, y: a.y - 26 });
  const right = await toScreen(page, { x: a.x + a.width + 80, y: a.y + a.height / 2 });
  await drag(page, { x: top.x, y: top.y }, { x: right.x, y: right.y });
  await expect.poll(async () => Math.abs((await items(page))[0].angle)).toBeGreaterThan(0.5);
  expect(await frameA.evaluate((f) => (f as HTMLElement).style.transform)).toMatch(/rotate\(/);
  // undo and redo the rotation
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await items(page))[0].angle).toBe(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(async () => Math.abs((await items(page))[0].angle)).toBeGreaterThan(0.5);

  // group both, then lock the group
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+g`);
  await expect
    .poll(async () => {
      const [x, y] = await items(page);
      return x.groupIds.length === 1 && x.groupIds[0] === y.groupIds[0];
    })
    .toBe(true);
  await page.keyboard.press(`${mod}+Shift+l`);
  await expect.poll(async () => (await items(page)).every((e) => e.locked)).toBe(true);
  // a locked component does not move when dragged
  await page.keyboard.press("Escape");
  const cb = await toScreen(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  await drag(page, { x: cb.x, y: cb.y }, { x: cb.x + 100, y: cb.y + 60 });
  await page.waitForTimeout(200);
  expect((await items(page))[1].x).toBe(b.x);
  // undo the lock, then the group
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await items(page)).some((e) => e.locked)).toBe(false);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await items(page)).every((e) => !e.groupIds.length)).toBe(true);
  const saved = await serverBoard(page);
  expect(saved.elements.every((e) => (e as unknown as { locked: boolean }).locked)).toBe(false);
});
