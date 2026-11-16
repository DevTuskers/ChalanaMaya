import { PAPER } from "../scene/constants";
import type { FileMap, SceneElement, Theme } from "../scene/types";

export const FILE_TYPE = "chalana";
export const FORMAT_VERSION = 1;
export const CLIPBOARD_TYPE = "chalana/clipboard";

export interface BoardSettings {
  viewBackgroundColor: string;
  theme: Theme;
}

export interface ChalanaFile {
  type: typeof FILE_TYPE;
  version: number;
  source: string;
  elements: SceneElement[];
  files: FileMap;
  settings: BoardSettings;
}

export interface ClipboardPayload {
  type: typeof CLIPBOARD_TYPE;
  version: number;
  elements: SceneElement[];
  files: FileMap;
}

export class FormatError extends Error {}

const ELEMENT_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "image",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback?: number): number => {
  if (typeof v === "number" && isFinite(v)) return v;
  if (fallback !== undefined) return fallback;
  throw new FormatError("An element has an invalid number.");
};
const str = (v: unknown, fallback?: string): string => {
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new FormatError("An element has an invalid text value.");
};
const points = (v: unknown) => {
  if (!Array.isArray(v) || v.length === 0) throw new FormatError("A path has no points.");
  return v.map((p) => {
    if (!isObj(p)) throw new FormatError("A path point is invalid.");
    return { x: num(p.x), y: num(p.y) };
  });
};
const binding = (v: unknown) =>
  isObj(v) && typeof v.elementId === "string" ? { elementId: v.elementId } : null;

/** Validates and normalises one element; throws FormatError when unusable. */
export const parseElement = (raw: unknown): SceneElement => {
  if (!isObj(raw)) throw new FormatError("An element is not an object.");
  const type = raw.type;
  if (typeof type !== "string" || !ELEMENT_TYPES.has(type)) {
    throw new FormatError(`Unsupported element type: ${String(type)}`);
  }
  const base = {
    id: str(raw.id),
    x: num(raw.x),
    y: num(raw.y),
    width: num(raw.width),
    height: num(raw.height),
    angle: num(raw.angle, 0),
    strokeColor: str(raw.strokeColor, "#193a36"),
    backgroundColor: str(raw.backgroundColor, "transparent"),
    fillStyle: raw.fillStyle === "solid" ? ("solid" as const) : ("hachure" as const),
    strokeWidth: num(raw.strokeWidth, 2.5),
    seed: num(raw.seed, 1),
    locked: raw.locked === true,
  };
  switch (type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
      return { ...base, type };
    case "arrow":
    case "line":
      return {
        ...base,
        type,
        points: points(raw.points),
        closed: type === "line" && raw.closed === true,
        startBinding: binding(raw.startBinding),
        endBinding: binding(raw.endBinding),
      };
    case "freedraw":
      return { ...base, type, points: points(raw.points) };
    case "text": {
      const family = raw.fontFamily;
      const align = raw.textAlign;
      return {
        ...base,
        type,
        text: str(raw.text),
        fontFamily: family === "normal" || family === "code" ? family : "hand",
        fontSize: num(raw.fontSize, 20),
        textAlign: align === "center" || align === "right" ? align : "left",
        containerId: typeof raw.containerId === "string" ? raw.containerId : null,
        autoWidth: raw.autoWidth !== false,
      };
    }
    default:
      return { ...base, type: "image", fileId: str(raw.fileId) };
  }
};

export const parseFiles = (raw: unknown): FileMap => {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new FormatError("The image list is invalid.");
  const files: FileMap = {};
  for (const [id, f] of Object.entries(raw)) {
    if (!isObj(f) || typeof f.dataURL !== "string" || !f.dataURL.startsWith("data:")) {
      throw new FormatError("An embedded image is damaged.");
    }
    files[id] = { id, mimeType: str(f.mimeType, "image/png"), dataURL: f.dataURL };
  }
  return files;
};

const parseElements = (raw: unknown): SceneElement[] => {
  if (!Array.isArray(raw)) throw new FormatError("The file has no element list.");
  const els = raw.map(parseElement);
  const ids = new Set<string>();
  for (const e of els) {
    if (ids.has(e.id)) throw new FormatError("The file contains duplicate element ids.");
    ids.add(e.id);
  }
  return els;
};

export const serializeBoard = (
  elements: readonly SceneElement[],
  files: FileMap,
  settings: BoardSettings,
): string => {
  const used = new Set(elements.flatMap((e) => (e.type === "image" ? [e.fileId] : [])));
  const usedFiles = Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id)));
  const data: ChalanaFile = {
    type: FILE_TYPE,
    version: FORMAT_VERSION,
    source: "ChalanaMaya",
    elements: [...elements],
    files: usedFiles,
    settings,
  };
  return JSON.stringify(data, null, 2);
};

/** Parses a .chalana document. Throws FormatError with a readable message. */
export const parseBoard = (text: string): ChalanaFile => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FormatError("This file is not valid ChalanaMaya data (it is not JSON).");
  }
  if (!isObj(raw) || raw.type !== FILE_TYPE) {
    throw new FormatError("This is not a .chalana board file.");
  }
  const version = raw.version;
  if (typeof version !== "number" || version < 1) {
    throw new FormatError("The file has no valid format version.");
  }
  if (version > FORMAT_VERSION) {
    throw new FormatError(
      `This board uses format version ${version}, which is newer than this app supports.`,
    );
  }
  const settingsRaw = isObj(raw.settings) ? raw.settings : {};
  return {
    type: FILE_TYPE,
    version,
    source: typeof raw.source === "string" ? raw.source : "",
    elements: parseElements(raw.elements),
    files: parseFiles(raw.files),
    settings: {
      viewBackgroundColor: str(settingsRaw.viewBackgroundColor, PAPER.light),
      theme: settingsRaw.theme === "dark" ? "dark" : "light",
    },
  };
};

export const serializeClipboard = (elements: readonly SceneElement[], files: FileMap): string => {
  const used = new Set(elements.flatMap((e) => (e.type === "image" ? [e.fileId] : [])));
  const payload: ClipboardPayload = {
    type: CLIPBOARD_TYPE,
    version: FORMAT_VERSION,
    elements: [...elements],
    files: Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id))),
  };
  return JSON.stringify(payload);
};

/** Returns null when the text is not a ChalanaMaya clipboard payload. */
export const parseClipboard = (text: string): ClipboardPayload | null => {
  if (!text.includes(CLIPBOARD_TYPE)) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObj(raw) || raw.type !== CLIPBOARD_TYPE) return null;
    return {
      type: CLIPBOARD_TYPE,
      version: FORMAT_VERSION,
      elements: parseElements(raw.elements),
      files: parseFiles(raw.files),
    };
  } catch {
    return null;
  }
};
