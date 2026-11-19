/** Response helpers shared by the worker and the board Durable Object. */
import { ServiceError } from "../server/errors";

/** /api error shape, matching the Node server: {error: {code, message}}. */
export const errorBody = (e: unknown) => {
  if (e instanceof ServiceError)
    return { status: e.status, body: { error: { code: e.code, message: e.message } } };
  return { status: 500, body: { error: { code: "internal", message: "Something went wrong." } } };
};

const API_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
} as const;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: API_HEADERS });

export const apiError = (e: unknown): Response => {
  const { status, body } = errorBody(e);
  return json(body, status);
};

/** Headers on every response (matches `baseHeaders` on the Node server). */
export const BASE_HEADERS = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;

const FRAME_SRC = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.figma.com",
  "https://codepen.io",
];

/** The app's CSP (same as `appCsp` on the Node server), keyed to the request host. */
export const appCsp = (host: string) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    `connect-src 'self' ws://${host} wss://${host}`,
    `frame-src ${FRAME_SRC.join(" ")}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");

/** Adds the base headers to a response (asset responses pass through). */
export const withBaseHeaders = (res: Response): Response => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

/** Adds the base headers and the app CSP (for the index/page responses). */
export const withAppHeaders = (res: Response, host: string): Response => {
  const r = withBaseHeaders(res);
  r.headers.set("Content-Security-Policy", appCsp(host));
  return r;
};
