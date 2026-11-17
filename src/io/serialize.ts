import { normalizeLink } from "../scene/arrange";
import { COMPONENT_LIMITS, checkComponentSource, type ComponentSource } from "../shared/components";
import { checkRemoteUrl } from "../shared/urls";
import { PAPER } from "../scene/constants";
import { isSessionFilePath } from "../shared/ids";
import { isColor } from "../shared/limits";
import type { FileMap, SceneElement, Theme } from "../scene/types";

export const FILE_TYPE = "chalana";
/**
 * 2: media (MEDIA-10). Files may be GIFs, MP4/WebM videos or https links
 * (`source: "remote"`, kept as links, never inlined); pictures gained
 * `paused`, `loop` and `autoplay`. Version 1 files still open.
 */
export const FORMAT_VERSION = 2;
export const CLIPBOARD_TYPE = "chalana/clipboard";

export interface BoardSettings {
  viewBackgroundColor: string;
  theme: Theme;
  gridEnabled: boolean;
}

export interface ChalanaFile {
  type: typeof FILE_TYPE;
  version: number;
  source: string;
  elements: SceneElement[];
  files: FileMap;
  settings: BoardSettings;
  /** reasons for items left out when the file was read (not written) */
  skipped?: string[];
}

export interface ClipboardPayload {
  type: typeof CLIPBOARD_TYPE;
  version: number;
  elements: SceneElement[];
  files: FileMap;
}

export class FormatError extends Error {}
/** An item that can't be used but does not spoil the rest of the file (it is skipped). */
export class SkippableItemError extends FormatError {}

const ELEMENT_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "image",
  "note",
  "frame",
  "embed",
  "component",
]);

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export const ARROWHEADS = [
  "none",
  "arrow",
  "bar",
  "circle",
  "circle-outline",
  "triangle",
  "triangle-outline",
  "diamond",
  "diamond-outline",
  "er-zero",
  "er-one",
  "er-many",
  "er-zero-one",
  "er-zero-many",
  "er-one-many",
] as const;

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
/**
 * A colour that is a hex colour or "transparent" once trimmed and lower-cased;
 * anything else becomes the default (plan §3.11). Case is left to
 * canonicalisation, which reports it.
 */
const color = (v: unknown, fallback: string): string =>
  typeof v === "string" && isColor(v.trim().toLowerCase()) ? v : fallback;
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
    strokeColor: color(raw.strokeColor, "#193a36"),
    backgroundColor: color(raw.backgroundColor, "transparent"),
    fillStyle: oneOf(raw.fillStyle, ["hachure", "cross-hatch", "zigzag", "solid"], "hachure"),
    strokeWidth: num(raw.strokeWidth, 2.5),
    strokeStyle: oneOf(raw.strokeStyle, ["solid", "dashed", "dotted"], "solid"),
    roughness: (raw.roughness === 0 || raw.roughness === 2 ? raw.roughness : 1) as 0 | 1 | 2,
    edges: oneOf(raw.edges, ["sharp", "round"], "sharp"),
    opacity: Math.max(0, Math.min(100, num(raw.opacity, 100))),
    seed: num(raw.seed, 1),
    locked: raw.locked === true,
    groupIds: Array.isArray(raw.groupIds)
      ? raw.groupIds.filter((g): g is string => typeof g === "string")
      : [],
    frameId: typeof raw.frameId === "string" ? raw.frameId : null,
    link: typeof raw.link === "string" ? normalizeLink(raw.link) : null,
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
        routing:
          type === "arrow"
            ? oneOf(raw.routing, ["straight", "curved", "elbow"], "straight")
            : "straight",
        startArrowhead: oneOf(raw.startArrowhead, ARROWHEADS, "none"),
        endArrowhead: oneOf(raw.endArrowhead, ARROWHEADS, type === "arrow" ? "arrow" : "none"),
      };
    case "freedraw": {
      const pts = points(raw.points);
      const pr = raw.pressures;
      const pressures =
        Array.isArray(pr) &&
        pr.length === pts.length &&
        pr.every((v) => typeof v === "number" && isFinite(v))
          ? pr.map((v: number) => Math.max(0, Math.min(1, v)))
          : null;
      return { ...base, type, points: pts, ...(pressures ? { pressures } : {}) };
    }
    case "embed":
      return { ...base, type, url: str(raw.url) };
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
    case "note":
      return { ...base, type };
    case "frame":
      return { ...base, type, name: str(raw.name, "Page") };
    case "component": {
      // the content is kept exactly (no repair): unsafe or oversized content is refused
      const bad = checkComponentSource(raw.source);
      if (bad) throw new SkippableItemError(`A component can't be used: ${bad.path} ${bad.reason}`);
      return {
        ...base,
        type,
        source: raw.source as ComponentSource,
        title: str(raw.title).slice(0, COMPONENT_LIMITS.title),
        ...(typeof raw.paused === "boolean" ? { paused: raw.paused } : {}),
      };
    }
    default: {
      const c = raw.crop;
      const crop =
        isObj(c) &&
        [c.x, c.y, c.width, c.height, c.naturalWidth, c.naturalHeight].every(
          (v) => typeof v === "number" && isFinite(v),
        ) &&
        num(c.width) > 0 &&
        num(c.height) > 0
          ? {
              x: num(c.x),
              y: num(c.y),
              width: num(c.width),
              height: num(c.height),
              naturalWidth: num(c.naturalWidth),
              naturalHeight: num(c.naturalHeight),
            }
          : null;
      return {
        ...base,
        type: "image",
        fileId: str(raw.fileId),
        crop,
        flipX: raw.flipX === true,
        flipY: raw.flipY === true,
        ...(typeof raw.paused === "boolean" ? { paused: raw.paused } : {}),
        ...(typeof raw.loop === "boolean" ? { loop: raw.loop } : {}),
        ...(typeof raw.autoplay === "boolean" ? { autoplay: raw.autoplay } : {}),
      };
    }
  }
};

/**
 * Parses an embedded file map. Board files carry data URLs only. A clipboard
 * payload (`sessionPaths`) may also name pictures by their same-origin session
 * path (`/api/sessions/<id>/files/<fileId>`): a copy from a server-backed board
 * keeps the server URLs, and the paste re-uploads them when they belong to
 * another board.
 */
export const parseFiles = (raw: unknown, opts: { sessionPaths?: boolean } = {}): FileMap => {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new FormatError("The image list is invalid.");
  const files: FileMap = {};
  for (const [id, f] of Object.entries(raw)) {
    const remote = isObj(f) && f.source === "remote";
    const ok =
      isObj(f) &&
      typeof f.dataURL === "string" &&
      (remote
        ? checkRemoteUrl(f.dataURL).ok
        : f.dataURL.startsWith("data:") ||
          (opts.sessionPaths === true && isSessionFilePath(f.dataURL)));
    if (!ok || !isObj(f) || typeof f.dataURL !== "string") {
      throw new FormatError(
        remote
          ? "A media link in the file is not a public https link."
          : "An embedded image is damaged.",
      );
    }
    const dim = (v: unknown) => (typeof v === "number" && v > 0 && isFinite(v) ? v : undefined);
    files[id] = {
      id,
      mimeType: str(f.mimeType, "image/png"),
      dataURL: f.dataURL,
      ...(remote ? { source: "remote" as const } : {}),
      ...(dim(f.width) && dim(f.height) ? { width: dim(f.width), height: dim(f.height) } : {}),
      ...(dim(f.durationMs) ? { durationMs: dim(f.durationMs) } : {}),
    };
  }
  return files;
};

/**
 * Parses the element list. An item with unsafe component content is skipped
 * and reported (plan §3: unreadable items are reported and left out), so one
 * bad component does not stop the whole file from opening.
 */
const parseElements = (raw: unknown, skipped: string[] = []): SceneElement[] => {
  if (!Array.isArray(raw)) throw new FormatError("The file has no element list.");
  const els: SceneElement[] = [];
  for (const r of raw) {
    try {
      els.push(parseElement(r));
    } catch (err) {
      if (!(err instanceof SkippableItemError)) throw err;
      skipped.push(err.message);
    }
  }
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
  return parseBoardObject(raw);
};

export const parseBoardObject = (raw: unknown): ChalanaFile => {
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
  const skipped: string[] = [];
  return {
    type: FILE_TYPE,
    version,
    source: typeof raw.source === "string" ? raw.source : "",
    elements: parseElements(raw.elements, skipped),
    ...(skipped.length ? { skipped } : {}),
    files: parseFiles(raw.files),
    settings: {
      viewBackgroundColor: str(settingsRaw.viewBackgroundColor, PAPER.light),
      theme: settingsRaw.theme === "dark" ? "dark" : "light",
      gridEnabled: settingsRaw.gridEnabled === true,
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
      files: parseFiles(raw.files, { sessionPaths: true }),
    };
  } catch {
    return null;
  }
};
