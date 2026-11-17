/** Per-address rate limits (plan §7). `RATE_LIMITS=off` turns them all off. */
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { RateLimits } from "../config";
import { sendRefusal } from "./host";

const pass: RequestHandler = (_req, _res, next) => next();

const make = (cfg: RateLimits, limit: number, what: string): RequestHandler =>
  cfg.enabled
    ? rateLimit({
        windowMs: cfg.windowMs,
        limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        // req.ip follows TRUST_PROXY; we validate that setting ourselves
        validate: { xForwardedForHeader: false, trustProxy: false },
        handler: (req, res) =>
          sendRefusal(req, res, 429, "rate_limited", `Too many ${what}; try again in a minute.`),
      })
    : pass;

export const rateLimiters = (cfg: RateLimits) => ({
  sessions: make(cfg, cfg.sessionsPerWindow, "new boards"),
  uploads: make(cfg, cfg.uploadsPerWindow, "uploads"),
  mcp: make(cfg, cfg.mcpPerWindow, "agent requests"),
});

/** Logs never show a full session id (it is the board's access token). */
export const redactIds = (text: string) =>
  text.replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{20}(?![A-Za-z0-9_-])/g, "$1…");
