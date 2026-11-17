/**
 * Host header check (plan §5.1): stops DNS rebinding. Same rule as the MCP SDK's
 * hostHeaderValidation (hostnames compared without ports), but refusals are
 * answered in the shape each route expects.
 */
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * A Host header must be exactly host[:port]: letters, digits, dots, hyphens, an
 * IPv6 literal in brackets, and an optional port. Anything else (a path, spaces,
 * tabs, `@`, `;`) is refused, so the value can never smuggle text into headers.
 */
const HOST_SYNTAX = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** The normalised host[:port] of a Host header (IPv6 compressed), or null when unusable. */
export const normalHost = (host: string | undefined): string | null => {
  if (!host || host.length > 300 || !HOST_SYNTAX.test(host)) return null;
  const port = /:(\d{1,5})$/.exec(host)?.[1];
  if (port !== undefined && Number(port) > 65535) return null;
  try {
    const u = new URL(`http://${host}`);
    return u.hostname ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The bare hostname of a Host header (IPv6 in brackets), or null when unusable. */
export const hostnameOf = (host: string | undefined): string | null => {
  const h = normalHost(host);
  return h === null ? null : new URL(`http://${h}`).hostname;
};

export const isHostAllowed = (host: string | undefined, allowed: readonly string[]) => {
  const h = hostnameOf(host);
  return h !== null && allowed.includes(h);
};

const MESSAGE = "This address is not allowed for this ChalanaMaya server (Host header refused).";

/**
 * Which area a URL belongs to, matched the way Express routes (case-insensitive,
 * trailing slash ignored), so `/API/x` and `/mcp/` are classified like `/api/x` and `/mcp`.
 */
export const routeKind = (url: string): "api" | "mcp" | "page" => {
  const p = (url.split("?")[0] ?? "").toLowerCase().replace(/\/+$/, "");
  if (p === "/mcp" || p.startsWith("/mcp/")) return "mcp";
  if (p === "/api" || p.startsWith("/api/")) return "api";
  return "page";
};

export const sendRefusal = (
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
) => {
  // originalUrl: inside the /api router req.path no longer starts with /api
  const p = routeKind(req.originalUrl || req.url);
  if (p === "mcp") {
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  } else if (p === "api") {
    res.status(status).json({ error: { code, message } });
  } else {
    res.status(status).type("text/plain").send(`${message}\n`);
  }
};

export const hostCheck =
  (allowed: readonly string[]) => (req: Request, res: Response, next: NextFunction) => {
    if (isHostAllowed(req.headers.host, allowed)) return next();
    sendRefusal(req, res, 403, "host_not_allowed", MESSAGE);
  };

/** For socket upgrades: answers 403 and closes the socket when the host is refused. */
export const checkUpgradeHost = (
  req: IncomingMessage,
  socket: Duplex,
  allowed: readonly string[],
) => {
  if (isHostAllowed(req.headers.host, allowed)) return true;
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  return false;
};
