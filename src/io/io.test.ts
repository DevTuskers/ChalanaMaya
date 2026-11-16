import { describe, expect, it } from "vitest";
import { createImage, createLinear, createShape, createText } from "../scene/elements";
import {
  BACKUP_KEY,
  STORAGE_KEY,
  loadFromStorage,
  saveToStorage,
  type StorageLike,
} from "./autosave";
import { classifyText } from "./clipboard";
import { exportSize, timestampName } from "./export";
import {
  FORMAT_VERSION,
  FormatError,
  parseBoard,
  parseClipboard,
  serializeBoard,
  serializeClipboard,
} from "./serialize";

const settings = { theme: "light" as const, viewBackgroundColor: "#fff9ed", gridEnabled: false };

const sample = () => {
  const shape = { ...createShape("rectangle", 10, 20), width: 100, height: 50 };
  const label = { ...createText(0, 0, undefined, "Label"), containerId: shape.id };
  const arrow = {
    ...createLinear("arrow", 0, 0, undefined, [
      { x: 0, y: 0 },
      { x: 40, y: 10 },
    ]),
    startBinding: { elementId: shape.id },
  };
  const image = createImage(200, 200, 40, 30, "f1");
  const files = {
    f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" },
    unused: { id: "unused", mimeType: "image/png", dataURL: "data:image/png;base64,BBBB" },
  };
  return { elements: [shape, label, arrow, image], files };
};

describe(".chalana files", () => {
  it("round-trips elements, images and settings", () => {
    const { elements, files } = sample();
    const text = serializeBoard(elements, files, settings);
    const parsed = parseBoard(text);
    expect(parsed.type).toBe("chalana");
    expect(parsed.version).toBe(FORMAT_VERSION);
    expect(parsed.elements).toEqual(elements);
    expect(parsed.settings).toEqual(settings);
    // only referenced images are kept
    expect(Object.keys(parsed.files)).toEqual(["f1"]);
  });

  it("rejects non-JSON and foreign JSON", () => {
    expect(() => parseBoard("{ nope")).toThrow(FormatError);
    expect(() => parseBoard(JSON.stringify({ type: "something-else", elements: [] }))).toThrow(
      FormatError,
    );
  });

  it("rejects files from a newer format version", () => {
    const text = JSON.stringify({
      type: "chalana",
      version: FORMAT_VERSION + 1,
      elements: [],
      files: {},
    });
    expect(() => parseBoard(text)).toThrow(/newer/i);
  });

  it("rejects malformed elements", () => {
    const text = JSON.stringify({
      type: "chalana",
      version: 1,
      elements: [{ id: "x", type: "rectangle", x: "oops" }],
      files: {},
      settings,
    });
    expect(() => parseBoard(text)).toThrow(FormatError);
  });

  it("rejects images whose data is not an image", () => {
    const { elements } = sample();
    const text = serializeBoard(
      elements,
      { f1: { id: "f1", mimeType: "image/png", dataURL: "javascript:alert(1)" } },
      settings,
    );
    expect(() => parseBoard(text)).toThrow(FormatError);
  });
});

describe("clipboard", () => {
  it("round-trips copied elements", () => {
    const { elements, files } = sample();
    const payload = parseClipboard(serializeClipboard(elements, files));
    expect(payload?.elements).toHaveLength(4);
    expect(Object.keys(payload!.files)).toEqual(["f1"]);
  });

  it("classifies plain and empty text", () => {
    expect(classifyText("hello\r\nworld")).toEqual({ kind: "text", text: "hello\nworld" });
    expect(classifyText("   ")).toEqual({ kind: "empty" });
    expect(classifyText(serializeClipboard(sample().elements, {})).kind).toBe("scene");
    expect(parseClipboard('{"type":"other"}')).toBeNull();
  });
});

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  fail: Error | null = null;
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.fail) throw this.fail;
    this.data.set(k, v);
  }
}

describe("autosave", () => {
  it("saves and restores the board", () => {
    const s = new MemoryStorage();
    const { elements, files } = sample();
    expect(saveToStorage(s, elements, files, settings)).toBeNull();
    expect(s.data.has(STORAGE_KEY)).toBe(true);
    expect(loadFromStorage(s)?.elements).toHaveLength(4);
  });

  it("reports quota failures without throwing", () => {
    const s = new MemoryStorage();
    s.fail = new DOMException("full", "QuotaExceededError");
    expect(saveToStorage(s, [], {}, settings)).toMatch(/full/);
    expect(saveToStorage(null, [], {}, settings)).toMatch(/storage/);
  });

  it("ignores corrupt stored data but keeps a backup copy", () => {
    const s = new MemoryStorage();
    s.data.set(STORAGE_KEY, "garbage");
    expect(loadFromStorage(s)).toBeNull();
    expect(s.data.get(BACKUP_KEY)).toBe("garbage");
  });
});

describe("export", () => {
  it("computes padded, scaled output size", () => {
    const el = { ...createShape("rectangle", 0, 0), width: 100, height: 50 };
    expect(exportSize([el], 2, 10)).toMatchObject({ width: 240, height: 140 });
    expect(exportSize([], 1)).toBeNull();
  });

  it("names files with a timestamp", () => {
    expect(timestampName("png", new Date(2024, 0, 2, 3, 4))).toBe("board-20240102-0304.png");
  });
});
