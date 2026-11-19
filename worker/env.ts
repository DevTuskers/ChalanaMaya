/** Bindings the ChalanaMaya worker is deployed with (wrangler.toml). */
export interface Env {
  /** The built Vite app (SPA fallback serves /s/* and /). */
  ASSETS: Fetcher;
  /** One Durable Object per board, named by viewId. */
  BOARD: DurableObjectNamespace;
  /** Fleet index: one row per board for the LRU sweep (phase 5). */
  INDEX: DurableObjectNamespace;
  /** Media bytes (uploads) keyed `<sessionId>/<sha256>`. */
  MEDIA: R2Bucket;
  /** Per-IP board-creation rate limit. */
  SESSION_CREATE: RateLimit;
}
