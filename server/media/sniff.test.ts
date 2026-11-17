import { describe, expect, it } from "vitest";
import { GIF, PNG, WEBP } from "../test/helpers";
import { baseType, pictureSize, sniffType } from "./sniff";

describe("magic-number sniffing", () => {
  it("recognises pictures", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(GIF)).toBe("image/gif");
    expect(sniffType(WEBP)).toBe("image/webp");
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg");
  });

  it("recognises videos", () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypisom"),
      Buffer.alloc(8),
    ]);
    expect(sniffType(mp4)).toBe("video/mp4");
    expect(sniffType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]))).toBe("video/webm");
  });

  it("refuses everything else", () => {
    expect(sniffType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffType(Buffer.from("<html><script>"))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
    expect(sniffType(Buffer.from("RIFF0000WAVE"))).toBeNull();
  });

  it("reads sizes and survives broken files", () => {
    expect(pictureSize(PNG)).toEqual({ width: 1, height: 1 });
    expect(pictureSize(GIF)).toEqual({ width: 1, height: 1 });
    expect(pictureSize(Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(4)]))).toEqual({
      width: null,
      height: null,
    });
  });

  it("strips media type parameters", () => {
    expect(baseType("Image/PNG; charset=binary")).toBe("image/png");
    expect(baseType(undefined)).toBe("");
  });
});
