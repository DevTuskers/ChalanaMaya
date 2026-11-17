import { describe, expect, it } from "vitest";
import {
  isSessionId,
  newPushId,
  newSessionId,
  parseSessionRef,
  PUSH_ID_RE,
  SESSION_ID_RE,
} from "./ids";
import { importSchema, pushSchema } from "./protocol";

describe("ids", () => {
  it("session ids are 24 base64url characters and differ", () => {
    const ids = new Set(Array.from({ length: 2000 }, newSessionId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(SESSION_ID_RE);
    // 18 random bytes: every alphabet character turns up across many ids
    const chars = new Set([...ids].join(""));
    expect(chars.size).toBe(64);
  });

  it("push ids are 22 characters", () => {
    const id = newPushId();
    expect(id).toHaveLength(22);
    expect(id).toMatch(PUSH_ID_RE);
  });

  it("checks the format", () => {
    expect(isSessionId("a".repeat(24))).toBe(true);
    expect(isSessionId("a".repeat(23))).toBe(false);
    expect(isSessionId("a".repeat(25))).toBe(false);
    expect(isSessionId("a".repeat(23) + "/")).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });

  it("parses a bare id or a board address", () => {
    const id = newSessionId();
    expect(parseSessionRef(` ${id} `)).toBe(id);
    expect(parseSessionRef(`http://localhost:5183/s/${id}`)).toBe(id);
    expect(parseSessionRef(`https://x.example/s/${id}?a=1`)).toBe(id);
    expect(parseSessionRef(`https://x.example/s/${id}x`)).toBeNull();
    expect(parseSessionRef("hello")).toBeNull();
  });
});

describe("protocol schemas", () => {
  const push = pushSchema(500);
  it("accepts a push and refuses unknown fields and bad ops", () => {
    const ok = { pushId: newPushId(), baseRev: 0, ops: [{ t: "del", id: "a", baseVersion: 1 }] };
    expect(push.safeParse(ok).success).toBe(true);
    expect(push.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(push.safeParse({ ...ok, pushId: "short" }).success).toBe(false);
    expect(push.safeParse({ ...ok, ops: [{ t: "eval", code: "x" }] }).success).toBe(false);
    expect(push.safeParse({ ...ok, ops: [{ t: "del", id: "<b>", baseVersion: 1 }] }).success).toBe(
      false,
    );
    expect(push.safeParse({ ...ok, mirrored: false }).success).toBe(false);
    expect(push.safeParse({ ...ok, mirrored: true }).success).toBe(true);
  });

  it("limits ops per push", () => {
    const ops = Array.from({ length: 3 }, (_, i) => ({ t: "del", id: `e${i}`, baseVersion: 0 }));
    expect(pushSchema(2).safeParse({ pushId: newPushId(), baseRev: 0, ops }).success).toBe(false);
  });

  it("accepts an import", () => {
    const r = importSchema.safeParse({
      importId: newPushId(),
      mode: "add",
      elements: [{ el: {}, idx: "a0" }],
    });
    expect(r.success).toBe(true);
    expect(
      importSchema.safeParse({ importId: newPushId(), mode: "merge", elements: [] }).success,
    ).toBe(false);
  });
});
