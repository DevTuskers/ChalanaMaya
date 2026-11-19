/**
 * Test stand-in for the `cloudflare:workers` module (aliased in the worker
 * vitest project; typecheck still sees the real types from workers-types).
 */
export class DurableObject<E = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
export type DurableObjectState = unknown;
