import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mp4Meta, videoMeta, webmMeta } from "./videoMeta";

const fx = (n: string) => readFileSync(new URL(`../../test-fixtures/media/${n}`, import.meta.url));

describe("video metadata (MEDIA-02)", () => {
  it("reads MP4 size and duration", () => {
    expect(mp4Meta(fx("clip.mp4"))).toEqual({ width: 320, height: 180, durationMs: 1000 });
  });
  it("reads WebM size and duration", () => {
    const m = webmMeta(fx("clip.webm"));
    expect(m.width).toBe(320);
    expect(m.height).toBe(240);
    expect(m.durationMs).toBeGreaterThan(900);
    expect(m.durationMs).toBeLessThan(1100);
  });
  it("never throws on junk and returns nulls", () => {
    const junk = Buffer.from([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76, 1, 2, 3]);
    expect(videoMeta("video/mp4", junk)).toEqual({ width: null, height: null, durationMs: null });
    expect(videoMeta("video/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff]))).toEqual({
      width: null,
      height: null,
      durationMs: null,
    });
    // truncated real files still do not throw
    expect(() => mp4Meta(fx("clip.mp4").subarray(0, 300))).not.toThrow();
    expect(() => webmMeta(fx("clip.webm").subarray(0, 100))).not.toThrow();
  });
});
