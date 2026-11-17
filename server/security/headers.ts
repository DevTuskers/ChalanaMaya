/** Security headers for the app pages (plan §7). */
import type { NextFunction, Request, Response } from "express";
import { normalHost } from "./host";

const FRAME_SRC = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.figma.com",
  "https://codepen.io",
];

/**
 * The app's Content-Security-Policy. `host` is the request's Host header as
 * normalised by normalHost (strictly host[:port]), so it cannot inject into the header. Explicit
 * ws:/wss: origins are needed because older WebKit does not match `ws:` against 'self'.
 */
export const appCsp = (host: string, dev: boolean) =>
  [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    `connect-src 'self' ws://${host} wss://${host}${dev ? " ws: wss:" : ""}`,
    `frame-src ${FRAME_SRC.join(" ")}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");

/** Headers for every response. */
export const baseHeaders = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.removeHeader("X-Powered-By");
  next();
};

/** The CSP for app pages and assets (not for /api, which sets its own). */
export const appHeaders = (dev: boolean) => (req: Request, res: Response, next: NextFunction) => {
  // normalHost only returns a strict host[:port], so nothing can be injected here
  res.setHeader(
    "Content-Security-Policy",
    appCsp(normalHost(req.headers.host) ?? "localhost", dev),
  );
  next();
};

/** Headers for served media: never run as a page, never sniffed. */
export const MEDIA_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cache-Control": "private, max-age=31536000, immutable",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;
