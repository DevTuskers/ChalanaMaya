import { expect, test } from "@playwright/test";
import { drag, expectCount, freshBoard } from "./helpers";

// Phase 1b: the app is served by the ChalanaMaya server and still saves to localStorage.

test("the server serves the app with its security headers", async ({ page, request }) => {
  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("ws://localhost:5184 wss://localhost:5184");
  expect(res?.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  await expect(page.getByTestId("board")).toBeVisible();
  const health = await request.get("/api/health");
  expect(await health.json()).toMatchObject({ ok: true });
});

test("a board address serves the same app, and a bad one is a 404", async ({ page }) => {
  const res = await page.goto(`/s/${"A".repeat(24)}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("board")).toBeVisible();
  const bad = await page.goto("/s/not-a-board");
  expect(bad?.status()).toBe(404);
});

test("the app still saves to localStorage under the strict CSP", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await freshBoard(page);
  await page.getByTestId("tool-rectangle").click();
  await drag(page, { x: 200, y: 200 }, { x: 320, y: 300 });
  await expectCount(page, 1);
  await page.reload();
  await expectCount(page, 1);
  expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
});

test("the page can use the REST API; a foreign origin cannot", async ({ page, request }) => {
  await page.goto("/");
  const created = await page.evaluate(async () => {
    const r = await fetch("/api/sessions", {
      method: "POST",
      headers: { "X-ChalanaMaya": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "From the page" }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(created.status).toBe(201);
  expect(created.body.session_id).toMatch(/^[A-Za-z0-9_-]{24}$/);
  const meta = await request.get(`/api/sessions/${created.body.session_id}`);
  expect((await meta.json()).title).toBe("From the page");
  const evil = await request.post("/api/sessions", {
    headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
    data: "x",
  });
  expect(evil.status()).toBe(403);
});
