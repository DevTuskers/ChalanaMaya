/**
 * Cross-site request guard (plan §7). Any website can send simple requests to
 * localhost; this refuses them on every state-changing route:
 *  1. `Sec-Fetch-Site: cross-site` is refused;
 *  2. a present `Origin` must be the address the request came to (whose Host the host
 *     check accepted), PUBLIC_URL's origin, or, for /mcp, one of ALLOWED_ORIGINS;
 *  3. REST also needs `X-ChalanaMaya: 1`, which forces a CORS preflight that fails
 *     (the server sends no CORS headers), and which HTML forms cannot set.
 */
import type { NextFunction, Request, Response } from "express";
import { sendRefusal } from "./host";

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
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.host === new URL(`http://${host}`).host
    );
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
    const p = req.path;
    const isMcp = p === "/mcp";
    const isApi = p.startsWith("/api/");
    if (!isMcp && !isApi) return next();
    const origins = isMcp ? [...opts.appOrigins, ...opts.mcpOrigins] : opts.appOrigins;
    const reason = crossSiteReason(req.headers, origins);
    if (reason) return sendRefusal(req, res, 403, "cross_site_refused", reason);
    if (isApi && req.headers["x-chalanamaya"] !== "1")
      return sendRefusal(
        req,
        res,
        403,
        "cross_site_refused",
        "Changes need the header X-ChalanaMaya: 1 (the app sends it).",
      );
    next();
  };
