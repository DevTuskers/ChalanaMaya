/**
 * Cross-site request guard (plan §7). Any website can send simple requests to
 * localhost; this refuses them on every state-changing route:
 *  1. `Sec-Fetch-Site: cross-site` is refused;
 *  2. a present `Origin` must be the address the request came to (whose Host the host
 *     check accepted), PUBLIC_URL's origin, or, for /mcp, one of ALLOWED_ORIGINS;
 *  3. every state-changing request except /mcp (REST, and any other path) also
 *     needs `X-ChalanaMaya: 1`, which forces a CORS preflight that fails (the
 *     server sends no CORS headers), and which HTML forms cannot set.
 */
import type { NextFunction, Request, Response } from "express";
import { normalHost, routeKind, sendRefusal } from "./host";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface GuardOptions {
  appOrigins: readonly string[];
  mcpOrigins: readonly string[];
}

/** An http(s) Origin naming exactly the (already host-checked) Host the request came to. */
const sameOrigin = (origin: string, host: string | string[] | undefined) => {
  if (typeof host !== "string") return false;
  try {
    const u = new URL(origin);
    const h = normalHost(host);
    return (u.protocol === "http:" || u.protocol === "https:") && h !== null && u.host === h;
  } catch {
    return false;
  }
};

export const crossSiteReason = (
  headers: Record<string, string | string[] | undefined>,
  allowedOrigins: readonly string[],
): string | null => {
  const site = headers["sec-fetch-site"];
  if (site === "cross-site") return "Requests from other websites are refused.";
  const origin = headers.origin;
  if (origin !== undefined) {
    const o = (Array.isArray(origin) ? origin[0] : origin) ?? "";
    if (!allowedOrigins.includes(o) && !sameOrigin(o, headers.host))
      return `Requests from ${o.slice(0, 200)} are refused.`;
  }
  return null;
};

export const crossSiteGuard =
  (opts: GuardOptions) => (req: Request, res: Response, next: NextFunction) => {
    if (!STATE_CHANGING.has(req.method)) return next();
    // Every state-changing request is guarded whatever its path, so a path that
    // routes differently from how it reads (`/API/x`, `/mcp/`) cannot slip past.
    // Only /mcp (matched like the router: any case, trailing slash) gets the
    // looser rules for agent clients; everything else follows the REST rules.
    const isMcp = routeKind(req.originalUrl || req.url) === "mcp";
    const origins = isMcp ? [...opts.appOrigins, ...opts.mcpOrigins] : opts.appOrigins;
    const reason = crossSiteReason(req.headers, origins);
    if (reason) return sendRefusal(req, res, 403, "cross_site_refused", reason);
    if (!isMcp && req.headers["x-chalanamaya"] !== "1")
      return sendRefusal(
        req,
        res,
        403,
        "cross_site_refused",
        "Changes need the header X-ChalanaMaya: 1 (the app sends it).",
      );
    next();
  };
