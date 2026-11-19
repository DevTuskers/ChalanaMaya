/**
 * ChalanaMaya Worker entry (docs/plans/cloudflare-hosting-plan.md phase 1).
 *
 *  - `POST /api/sessions` creates a board Durable Object named by a random
 *    24-char viewId and answers the three links (view / edit / owner).
 *  - `/api/sessions/<viewId>/...` is proxied to that board's DO. Reads need
 *    only the viewId; every mutating route checks `Authorization: Bearer`
 *    inside the DO.
 *  - `/mcp` answers 501 until phase 3 lands the MCP transport.
 *  - Everything else is served from the bundled Vite build (assets), with
 *    SPA fallback for `/s/...` and the app's security headers.
 */
import { isSessionId, newSessionId } from "../src/shared/ids";
import type { Env } from "./env";
import { apiError, json, withAppHeaders, withBaseHeaders } from "./http";
import { BoardSession } from "./do/board";
import { BoardIndex } from "./do/index";
import { ServiceError } from "../server/errors";

export { BoardSession, BoardIndex };

const SESSION_PATH = /^\/api\/sessions\/([A-Za-z0-9_-]{24})(\/|$)/;

const boardStub = (env: Env, viewId: string) => env.BOARD.get(env.BOARD.idFromName(viewId));

const touchIndex = (env: Env, viewId: string, ctx: ExecutionContext) => {
  ctx.waitUntil(
    env.INDEX.get(env.INDEX.idFromName("fleet")).fetch("https://index/touch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: viewId }),
    }),
  );
};

const createSession = async (req: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  // Per-IP board-creation limit (Cloudflare rate-limit rule, free tier).
  const key = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.SESSION_CREATE.limit({ key });
  if (!success)
    return json(
      {
        error: {
          code: "rate_limited",
          message: "Too many new boards from this address. Try again in a minute.",
        },
      },
      429,
    );

  let title = "";
  try {
    const body = (await req.json()) as { title?: unknown };
    if (typeof body?.title === "string") title = body.title.slice(0, 120);
  } catch {
    // an empty body makes an untitled board
  }

  const viewId = newSessionId();
  const stub = boardStub(env, viewId);
  const res = await stub.fetch("https://board/_create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return res;
  const { editKey, ownerKey } = (await res.json()) as { editKey: string; ownerKey: string };
  touchIndex(env, viewId, ctx);
  return json(
    {
      session_id: viewId,
      url: `/s/${viewId}#key=${editKey}`,
      view_url: `/s/${viewId}`,
      invite_url: `/s/${viewId}#key=${editKey}`,
      owner_url: `/s/${viewId}#owner=${ownerKey}`,
    },
    201,
  );
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true });

      if (path === "/api/sessions" && req.method === "POST")
        return await createSession(req, env, ctx);

      if (path === "/api/sessions")
        return json({ error: { code: "not_found", message: "No route." } }, 404);

      const m = SESSION_PATH.exec(path);
      if (m) {
        const viewId = m[1];
        if (!isSessionId(viewId))
          return json({ error: { code: "session_not_found", message: "No such board." } }, 404);
        const stub = boardStub(env, viewId);
        // Board reads refresh the idle-eviction clock.
        if (req.method === "GET") touchIndex(env, viewId, ctx);
        const res = await stub.fetch(req);
        // A DO answering 404 session_not_found means the board was evicted or deleted.
        if (res.status === 404) {
          const body = (await res
            .clone()
            .json()
            .catch(() => null)) as {
            error?: { code?: string };
          } | null;
          if (body?.error?.code === "session_not_found") return res;
        }
        return res;
      }

      if (path === "/mcp" || path.startsWith("/mcp/"))
        return json(
          {
            error: {
              code: "not_implemented",
              message: "The ChalanaMaya MCP endpoint is not live on this host yet.",
            },
          },
          501,
        );

      if (path.startsWith("/api/"))
        return json({ error: { code: "not_found", message: "No route." } }, 404);

      // The app itself: static assets with SPA fallback; page answers get the CSP.
      const res = await env.ASSETS.fetch(req);
      const type = res.headers.get("Content-Type") ?? "";
      if (type.includes("text/html")) return withAppHeaders(res, url.host);
      return withBaseHeaders(res);
    } catch (e) {
      if (e instanceof ServiceError) return apiError(e);
      return apiError(e);
    }
  },
} satisfies ExportedHandler<Env>;
