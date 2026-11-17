/**
 * Host header check (plan §5.1): stops DNS rebinding. Same rule as the MCP SDK's
 * hostHeaderValidation (hostnames compared without ports), but refusals are
 * answered in the shape each route expects.
 */
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** The bare hostname of a Host header (IPv6 in brackets), or null when unusable. */
export const hostnameOf = (host: string | undefined): string | null => {
  if (!host) return null;
  try {
    const h = new URL(`http://${host}`).hostname.toLowerCase();
    return h || null;
  } catch {
    return null;
  }
};

export const isHostAllowed = (host: string | undefined, allowed: readonly string[]) => {
  const h = hostnameOf(host);
  return h !== null && allowed.includes(h);
};

const MESSAGE = "This address is not allowed for this ChalanaMaya server (Host header refused).";

export const sendRefusal = (
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
) => {
  // originalUrl: inside the /api router req.path no longer starts with /api
  const p = (req.originalUrl || req.url).split("?")[0] ?? "";
  if (p === "/mcp" || p.startsWith("/mcp/")) {
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  } else if (p === "/api" || p.startsWith("/api/")) {
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
