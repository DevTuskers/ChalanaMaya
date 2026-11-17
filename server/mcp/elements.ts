/**
 * Agent input → scene elements (plan §5.2, §5.3). Forgiving about form
 * (palette names, numeric strings, named sizes, missing positions) and strict
 * about meaning: every problem is a ToolError with a path and a hint. The
 * stored result is validated again by SessionService.apply.
 */
import {
  createComponent,
  createEmbed,
  createFrame,
  createFreedraw,
  createImage,
  createLinear,
  createNote,
  createShape,
  createText,
  hasPoints,
  isBoundText,
  isLinear,
  isTextContainer,
  newId,
} from "../../src/scene/elements";
import { DEFAULT_STYLE, NOTE_SWATCHES } from "../../src/scene/constants";
import {
  fromAbsolutePoints,
  getAbsolutePoints,
  getCenter,
  getCommonBounds,
} from "../../src/scene/geometry";
import { layoutText } from "../../src/scene/text";
import type {
  Arrowhead,
  Crop,
  FreedrawElement,
  ItemStyle,
  LinearElement,
  Point,
  ImageElement,
  SceneElement,
  TextElement,
} from "../../src/scene/types";
import { LIMITS, wrapAngle } from "../../src/shared/limits";
import {
  checkCustomContent,
  checkPresetParams,
  COMPONENT_LIMITS,
  PRESET_NAMES,
  presetByName,
  type ComponentSource,
  type ParamValue,
  type PresetName,
} from "../../src/shared/components";
import { normalizeLink } from "../../src/shared/links";
import { ALLOWED_MIME, ARROWHEAD_NAMES } from "../../src/shared/validate";
import { isVideoMime, mimeFromUrl, normaliseRemoteUrl } from "../../src/shared/urls";
import type { StoredFile } from "../../src/shared/protocol";
import {
  bool,
  color,
  degToRad,
  FONT_SIZE_NAMES,
  invalid,
  num,
  oneOf,
  ROUGHNESS_NAMES,
  str,
  STROKE_WIDTH_NAMES,
  ToolError,
} from "./palette";

type Obj = Record<string, unknown>;

export const COORD_MAX = 1_000_000;
export const SIZE_MAX = 100_000;

export const INPUT_TYPES = [
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "note",
  "frame",
  "arrow",
  "line",
  "freedraw",
  "image",
  "gif",
  "video",
  "web_card",
  "component",
] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export const STYLE_FIELDS = [
  "stroke",
  "fill",
  "fill_style",
  "stroke_width",
  "stroke_style",
  "roughness",
  "edges",
  "opacity",
  "font",
  "font_size",
  "text_align",
] as const;
const COMMON_FIELDS = [
  "type",
  "key",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "locked",
  "link",
  "group",
  "frame",
  ...STYLE_FIELDS,
];
const TYPE_FIELDS: Record<string, string[]> = {
  rectangle: ["label"],
  diamond: ["label"],
  ellipse: ["label"],
  text: ["text"],
  note: ["text", "color", "label"],
  frame: ["name", "contains"],
  arrow: ["from", "to", "points", "label", "routing", "start_arrowhead", "end_arrowhead", "closed"],
  // full detail lists every path field for lines too; they are accepted and kept as they are
  line: ["points", "closed", "from", "to", "routing", "start_arrowhead", "end_arrowhead"],
  freedraw: ["points"],
  image: ["file_id", "url", "mime_type", "crop", "flip_x", "flip_y", "paused"],
  gif: ["file_id", "url", "crop", "flip_x", "flip_y", "paused"],
  video: ["file_id", "url", "mime_type", "paused", "loop", "autoplay"],
  web_card: ["url"],
  component: ["preset", "params", "html", "css", "title", "paused"],
};
/** fields update_elements and full detail add on top (round trip of get_scene full) */
const UPDATE_EXTRA = ["id", "group_ids", "container", "label", "text", "name", "contains"];

/** Everything a build needs from the board and the call. */
export interface BuildContext {
  /** board elements by id (the current scene, plus items built so far in this call) */
  byId: Map<string, SceneElement>;
  /** keys given in this call → ids */
  keys: Map<string, string>;
  files: Map<string, StoredFile>;
  warnings: string[];
  /** group names in this call → new group ids */
  groups: Map<string, string>;
  /** where the next item without x/y goes */
  cursor: Point;
  /**
   * Records a remote media link as a board file (never fetched by the server).
   * Absent in pure unit contexts, where links are refused.
   */
  addLink?: (url: string, mime: string) => StoredFile;
}

export const freeSpace = (elements: readonly SceneElement[]): Point => {
  const b = getCommonBounds(elements.filter((e) => !isBoundText(e)));
  if (!b) return { x: 80, y: 80 };
  return { x: Math.round((b.maxX + 80) / 40) * 40, y: Math.round(b.minY / 40) * 40 };
};

export const resolveRef = (ctx: BuildContext, ref: unknown, path: string): string => {
  if (typeof ref !== "string" || !ref)
    throw invalid(path, "must be an element id or a key given earlier in this call");
  const id = ctx.keys.get(ref) ?? ref;
  if (ctx.byId.has(id)) return id;
  const known = [...ctx.keys.keys()];
  throw invalid(
    path,
    `no element or key "${ref}" in this board or this call.${known.length ? ` Known keys: ${known.join(", ")}.` : ""}`,
  );
};

const warnUnknown = (o: Obj, allowed: readonly string[], path: string, ctx: BuildContext) => {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) ctx.warnings.push(`${path}.${k}: unknown field, ignored`);
};

export const point = (v: unknown, path: string, withPressure = false): Point & { p?: number } => {
  let x: unknown, y: unknown, p: unknown;
  if (Array.isArray(v)) [x, y, p] = v;
  else if (v && typeof v === "object") ({ x, y, p } = v as Obj);
  else throw invalid(path, "must be a point [x, y]");
  const out: Point & { p?: number } = {
    x: num(x, `${path}[0]`, { min: -COORD_MAX, max: COORD_MAX }),
    y: num(y, `${path}[1]`, { min: -COORD_MAX, max: COORD_MAX }),
  };
  if (withPressure && p !== undefined) out.p = num(p, `${path}[2]`, { min: 0, max: 1 });
  return out;
};

export const pointList = (v: unknown, path: string, min: number, max: number, pressure = false) => {
  if (!Array.isArray(v)) throw invalid(path, "must be a list of points [[x, y], …]");
  if (v.length < min || v.length > max) throw invalid(path, `must have ${min}–${max} points`);
  return v.map((p, i) => point(p, `${path}[${i}]`, pressure));
};

/** Style fields → element fields; fields that do not apply are reported in `skipped`. */
export const applyStyle = (
  el: SceneElement,
  o: Obj,
  path: string,
  skipped?: string[],
): SceneElement => {
  const out = { ...el } as Record<string, unknown>;
  const skip = (field: string, why: string) => {
    if (skipped) skipped.push(`${field}: ${why}`);
  };
  const t = el.type;
  const textual = t === "text";
  if (o.stroke !== undefined) {
    if (t === "image") skip("stroke", "pictures have no outline");
    else out.strokeColor = color(o.stroke, `${path}.stroke`, "stroke");
  }
  if (o.fill !== undefined) {
    if (textual || t === "freedraw" || t === "image" || t === "arrow")
      skip("fill", `a ${t} has no fill`);
    else out.backgroundColor = color(o.fill, `${path}.fill`, t === "note" ? "note" : "fill");
  }
  if (o.fill_style !== undefined)
    out.fillStyle = oneOf(o.fill_style, `${path}.fill_style`, [
      "hachure",
      "cross-hatch",
      "zigzag",
      "solid",
    ]);
  if (o.stroke_width !== undefined) {
    const w =
      typeof o.stroke_width === "string" && STROKE_WIDTH_NAMES[o.stroke_width]
        ? STROKE_WIDTH_NAMES[o.stroke_width]
        : num(o.stroke_width, `${path}.stroke_width`, { min: 0.5, max: 32 });
    out.strokeWidth = w;
  }
  if (o.stroke_style !== undefined) {
    if (textual || t === "freedraw") skip("stroke_style", `a ${t} has no dashes`);
    else
      out.strokeStyle = oneOf(o.stroke_style, `${path}.stroke_style`, [
        "solid",
        "dashed",
        "dotted",
      ]);
  }
  if (o.roughness !== undefined) {
    if (typeof o.roughness === "string" && o.roughness in ROUGHNESS_NAMES)
      out.roughness = ROUGHNESS_NAMES[o.roughness];
    else {
      const r = num(o.roughness, `${path}.roughness`, { min: 0, max: 2 });
      if (![0, 1, 2].includes(r))
        throw invalid(`${path}.roughness`, 'use "tidy", "sketchy" or "wobbly"');
      out.roughness = r;
    }
  }
  if (o.edges !== undefined) {
    if (t === "ellipse" || textual || t === "freedraw") skip("edges", `a ${t} has no corners`);
    else out.edges = oneOf(o.edges, `${path}.edges`, ["sharp", "round"]);
  }
  if (o.opacity !== undefined)
    out.opacity = num(o.opacity, `${path}.opacity`, { min: 0, max: 100 });
  if (o.font !== undefined) {
    if (!textual) skip("font", "only text has a font (style the label through its box)");
    else out.fontFamily = oneOf(o.font, `${path}.font`, ["hand", "normal", "code"]);
  }
  if (o.font_size !== undefined) {
    if (!textual) skip("font_size", "only text has a font size");
    else
      out.fontSize =
        typeof o.font_size === "string" && FONT_SIZE_NAMES[o.font_size]
          ? FONT_SIZE_NAMES[o.font_size]
          : num(o.font_size, `${path}.font_size`, { min: 8, max: 400 });
  }
  if (o.text_align !== undefined) {
    if (!textual) skip("text_align", "only text has an alignment");
    else out.textAlign = oneOf(o.text_align, `${path}.text_align`, ["left", "center", "right"]);
  }
  return out as unknown as SceneElement;
};

/** Text style fields copied from a container's input onto its label. */
const labelStyle = (o: Obj, path: string): ItemStyle => {
  const s: ItemStyle = { ...DEFAULT_STYLE };
  if (o.font !== undefined)
    s.fontFamily = oneOf(o.font, `${path}.font`, ["hand", "normal", "code"]);
  if (o.font_size !== undefined)
    s.fontSize =
      typeof o.font_size === "string" && FONT_SIZE_NAMES[o.font_size]
        ? FONT_SIZE_NAMES[o.font_size]
        : num(o.font_size, `${path}.font_size`, { min: 8, max: 400 });
  return s;
};

const geometry = (el: SceneElement, o: Obj, path: string): SceneElement => {
  const out = { ...el };
  if (o.x !== undefined) out.x = num(o.x, `${path}.x`, { min: -COORD_MAX, max: COORD_MAX });
  if (o.y !== undefined) out.y = num(o.y, `${path}.y`, { min: -COORD_MAX, max: COORD_MAX });
  if (!hasPoints(el)) {
    if (o.width !== undefined) out.width = num(o.width, `${path}.width`, { min: 1, max: SIZE_MAX });
    if (o.height !== undefined)
      out.height = num(o.height, `${path}.height`, { min: 1, max: SIZE_MAX });
  }
  if (o.angle !== undefined)
    out.angle = wrapAngle(degToRad(num(o.angle, `${path}.angle`, { min: -3600, max: 3600 })));
  return out;
};

const common = (el: SceneElement, o: Obj, path: string, ctx: BuildContext): SceneElement => {
  let out = el;
  if (o.locked !== undefined) out = { ...out, locked: bool(o.locked, `${path}.locked`) };
  if (o.link !== undefined) {
    if (o.link === null || o.link === "") out = { ...out, link: null };
    else {
      const link = normalizeLink(str(o.link, `${path}.link`, LIMITS.link));
      if (!link) throw invalid(`${path}.link`, 'must be an http(s) or mailto link, or "#el=<id>"');
      out = { ...out, link };
    }
  }
  if (o.group !== undefined) {
    const name = str(o.group, `${path}.group`, 64);
    let gid = ctx.groups.get(name);
    if (!gid) ctx.groups.set(name, (gid = newId()));
    out = { ...out, groupIds: [...out.groupIds, gid] };
  }
  if (o.group_ids !== undefined) {
    if (!Array.isArray(o.group_ids) || o.group_ids.length > LIMITS.groupIds)
      throw invalid(`${path}.group_ids`, `must be a list of at most ${LIMITS.groupIds} group ids`);
    out = { ...out, groupIds: o.group_ids.map((g, i) => str(g, `${path}.group_ids[${i}]`, 64)) };
  }
  if (o.frame !== undefined) {
    if (o.frame === null) out = { ...out, frameId: null };
    else {
      const fid = resolveRef(ctx, o.frame, `${path}.frame`);
      if (ctx.byId.get(fid)!.type !== "frame")
        throw invalid(`${path}.frame`, `${o.frame} is not a frame`);
      out = { ...out, frameId: fid };
    }
  }
  return out;
};

const arrowhead = (v: unknown, path: string) =>
  oneOf(v, path, ARROWHEAD_NAMES as unknown as readonly Arrowhead[]);

const labelText = (v: unknown, path: string) => str(v, path, LIMITS.textChars);

/** A bound label for `container`, or null when the text is empty. */
const makeLabel = (container: SceneElement, text: string, style: ItemStyle): TextElement => {
  const t = createText(container.x, container.y, style, text, container.id);
  return { ...t, strokeColor: container.type === "note" ? "#193a36" : container.strokeColor };
};

const endpoint = (
  ctx: BuildContext,
  v: unknown,
  path: string,
): { point: Point; bind: string | null } => {
  if (typeof v === "string") {
    const id = resolveRef(ctx, v, path);
    const target = ctx.byId.get(id)!;
    if (isLinear(target) || target.type === "text" || target.type === "freedraw")
      throw invalid(
        path,
        `a connector can attach to boxes, notes, frames and pictures, not a ${target.type}`,
      );
    return { point: getCenter(target), bind: id };
  }
  return { point: point(v, path), bind: null };
};

/**
 * Sets connector geometry. New items: `points` are bend points between
 * `from` and `to` (or the whole path when an end is missing). Updates:
 * `points` is the whole path in absolute coordinates, as get_scene full
 * returns it; `from`/`to` set or clear the attachments.
 */
const connectorPath = (
  el: LinearElement,
  o: Obj,
  path: string,
  ctx: BuildContext,
  isNew: boolean,
): LinearElement => {
  let startBinding = el.startBinding;
  let endBinding = el.endBinding;
  let full: Point[];
  const old = absolute(el);
  if (isNew) {
    const bends =
      o.points === undefined ? [] : pointList(o.points, `${path}.points`, 0, LIMITS.linearPoints);
    let start: Point | undefined;
    let end: Point | undefined;
    if (o.from !== undefined && o.from !== null) {
      const e = endpoint(ctx, o.from, `${path}.from`);
      start = e.point;
      startBinding = e.bind ? { elementId: e.bind } : null;
    } else start = bends.shift();
    if (o.to !== undefined && o.to !== null) {
      const e = endpoint(ctx, o.to, `${path}.to`);
      end = e.point;
      endBinding = e.bind ? { elementId: e.bind } : null;
    } else end = bends.pop();
    if (!start || !end)
      throw invalid(
        path,
        `a ${el.type} needs "from" and "to" (ids, keys or [x, y]) or at least 2 "points"`,
      );
    full = [start, ...bends, end];
  } else {
    full =
      o.points === undefined ? old : pointList(o.points, `${path}.points`, 2, LIMITS.linearPoints);
    const same = (a: Point | undefined, b: Point | undefined) =>
      !!a && !!b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    if (o.points !== undefined) {
      // a moved end comes loose unless from/to says where it attaches
      if (o.from === undefined && startBinding && !same(full[0], old[0])) startBinding = null;
      if (o.to === undefined && endBinding && !same(full[full.length - 1], old[old.length - 1]))
        endBinding = null;
    }
    for (const side of ["from", "to"] as const) {
      const v = o[side];
      if (v === undefined) continue;
      const i = side === "from" ? 0 : full.length - 1;
      let binding: { elementId: string } | null = null;
      if (v !== null) {
        const e = endpoint(ctx, v, `${path}.${side}`);
        binding = e.bind ? { elementId: e.bind } : null;
        const prev = side === "from" ? el.startBinding : el.endBinding;
        if (!e.bind || o.points === undefined || prev?.elementId !== e.bind) {
          full = [...full];
          full[i] = e.point;
        }
      }
      if (side === "from") startBinding = binding;
      else endBinding = binding;
    }
  }
  if (full.length > LIMITS.linearPoints)
    throw invalid(`${path}.points`, `a ${el.type} has at most ${LIMITS.linearPoints} points`);
  if (el.type === "line" && (startBinding || endBinding)) {
    startBinding = null;
    endBinding = null;
  }
  if (
    startBinding &&
    endBinding &&
    startBinding.elementId === endBinding.elementId &&
    full.length < 3
  )
    throw invalid(path, "a connector from an item to itself needs a bend point in points");
  return fromAbsolutePoints({ ...el, startBinding, endBinding }, full);
};

/** Absolute board points of a path (rotation applied). */
export const absolute = (el: LinearElement | FreedrawElement): Point[] => getAbsolutePoints(el);

const freedrawPoints = (el: FreedrawElement, v: unknown, path: string): FreedrawElement => {
  const pts = pointList(v, path, 1, LIMITS.freedrawPoints, true);
  const withP = pts.some((p) => p.p !== undefined);
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));
  return {
    ...el,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    angle: 0,
    points: pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
    pressures: withP ? pts.map((p) => p.p ?? 0.5) : null,
  };
};

export type MediaKind = "image" | "gif" | "video";

/** Does a file's type fit the asked kind? image takes any picture (a GIF too). */
export const kindFits = (kind: MediaKind, mime: string) =>
  kind === "video"
    ? isVideoMime(mime)
    : kind === "gif"
      ? mime === "image/gif"
      : mime.startsWith("image/");

/** A remote media link (MEDIA-05) as a board file: rules checked, type from mime_type or the extension. */
export const linkFile = (
  ctx: BuildContext,
  rawUrl: unknown,
  rawMime: unknown,
  kind: MediaKind,
  path: string,
): StoredFile => {
  const r = normaliseRemoteUrl(str(rawUrl, `${path}.url`, LIMITS.url));
  if (!r.ok) throw invalid(`${path}.url`, `the link ${r.reason}`);
  const mime =
    rawMime !== undefined
      ? oneOf(rawMime, `${path}.mime_type`, ALLOWED_MIME)
      : (mimeFromUrl(r.url) ?? (kind === "gif" ? "image/gif" : null));
  if (!mime)
    throw invalid(
      `${path}.mime_type`,
      "cannot tell the link's type from its address; give mime_type (for example image/png or video/mp4)",
    );
  if (!kindFits(kind, mime)) throw invalid(`${path}.url`, `the link is ${mime}, not a ${kind}`);
  if (!ctx.addLink) throw invalid(`${path}.url`, "links cannot be added here");
  const f = ctx.addLink(r.url, mime);
  ctx.files.set(f.id, f);
  return f;
};

const imageFile = (
  ctx: BuildContext,
  o: Obj,
  path: string,
  kind: MediaKind = "image",
): StoredFile => {
  if (o.url !== undefined) {
    if (o.file_id !== undefined) throw invalid(path, "give file_id or url, not both");
    return linkFile(ctx, o.url, o.mime_type, kind, path);
  }
  if (o.file_id === undefined)
    throw invalid(
      path,
      `a ${kind === "image" ? "picture" : kind} needs file_id (from upload_media) or url (an https link); or use place_media`,
    );
  const fid = str(o.file_id, `${path}.file_id`, 128);
  const f = ctx.files.get(fid);
  if (!f)
    throw invalid(
      `${path}.file_id`,
      `no uploaded file "${fid}" in this board. Upload it with upload_media first`,
    );
  if (!kindFits(kind, f.mime))
    throw invalid(
      `${path}.file_id`,
      `${fid} is ${f.mime}, not a ${kind === "image" ? "picture" : kind}${isVideoMime(f.mime) ? ' (use type "video")' : ""}`,
    );
  return f;
};

const crop = (
  v: unknown,
  el: SceneElement,
  f: StoredFile | undefined,
  path: string,
): Crop | null => {
  if (v === null) return null;
  if (!v || typeof v !== "object")
    throw invalid(path, "must be {x, y, width, height} in picture pixels, or null");
  const o = v as Obj;
  const nw = o.natural_width ?? f?.width ?? el.width;
  const nh = o.natural_height ?? f?.height ?? el.height;
  return {
    x: num(o.x ?? 0, `${path}.x`, { min: 0 }),
    y: num(o.y ?? 0, `${path}.y`, { min: 0 }),
    width: num(o.width, `${path}.width`, { min: 1 }),
    height: num(o.height, `${path}.height`, { min: 1 }),
    naturalWidth: num(nw, `${path}.natural_width`, { min: 1 }),
    naturalHeight: num(nh, `${path}.natural_height`, { min: 1 }),
  };
};

/** Default size for placed media: 480 wide keeping its ratio (videos of unknown size: 16:9). */
export const mediaSize = (f: StoredFile, o: { width?: number; height?: number }) => {
  const ratio = f.width && f.height ? f.height / f.width : isVideoMime(f.mime) ? 9 / 16 : 0.75;
  if (o.width !== undefined && o.height !== undefined) return { width: o.width, height: o.height };
  if (o.width !== undefined) return { width: o.width, height: Math.max(1, o.width * ratio) };
  if (o.height !== undefined) return { width: Math.max(1, o.height / ratio), height: o.height };
  const width = f.width ? Math.min(480, f.width) : 480;
  return { width, height: Math.max(1, Math.round(width * ratio)) };
};

/**
 * Playback fields (MEDIA-03): paused for GIFs and videos, loop and autoplay
 * for videos. Fields that do not fit the file are dropped with a warning.
 */
const playback = (
  o: Obj,
  f: StoredFile,
  path: string,
  current?: ImageElement,
): Partial<ImageElement> => {
  const out: Partial<ImageElement> = {};
  const video = isVideoMime(f.mime);
  const animated = video || f.mime === "image/gif";
  if (o.paused !== undefined) {
    if (animated) out.paused = bool(o.paused, `${path}.paused`);
    else throw invalid(`${path}.paused`, "only GIFs and videos play");
  }
  for (const k of ["loop", "autoplay"] as const)
    if (o[k] !== undefined) {
      if (video) out[k] = bool(o[k], `${path}.${k}`);
      else throw invalid(`${path}.${k}`, "only videos have this");
    }
  if (video && !current) {
    out.loop ??= true;
    out.autoplay ??= true;
  }
  return out;
};

export interface Built {
  el: SceneElement;
  label?: TextElement;
  /** frame `contains` refs to adopt after everything is built */
  contains?: string[];
}

/** First pass: everything but connector geometry (which needs the targets). */
export const buildElement = (raw: unknown, path: string, ctx: BuildContext): Built => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw invalid(path, "must be an object");
  const o = raw as Obj;
  const type = oneOf(o.type, `${path}.type`, INPUT_TYPES);
  warnUnknown(o, [...COMMON_FIELDS, ...TYPE_FIELDS[type]], path, ctx);
  const x0 = 0;
  let el: SceneElement;
  let label: TextElement | undefined;
  let contains: string[] | undefined;
  switch (type) {
    case "rectangle":
    case "diamond":
    case "ellipse":
      el = createShape(type, x0, x0, DEFAULT_STYLE, 160, 80);
      break;
    case "note":
      el = createNote(x0, x0, DEFAULT_STYLE, 180);
      if (o.color !== undefined)
        el = { ...el, backgroundColor: color(o.color, `${path}.color`, "note") };
      break;
    case "frame":
      el = {
        ...createFrame(
          x0,
          x0,
          o.name === undefined ? "Page" : str(o.name, `${path}.name`, LIMITS.frameName),
        ),
        width: 800,
        height: 600,
      };
      if (o.contains !== undefined) {
        if (!Array.isArray(o.contains))
          throw invalid(`${path}.contains`, "must be a list of ids or keys");
        contains = o.contains.map((r) => {
          if (typeof r !== "string")
            throw invalid(`${path}.contains`, "must be a list of ids or keys");
          return r;
        });
      }
      break;
    case "text": {
      if (o.text === undefined) throw invalid(`${path}.text`, "is required for text");
      const t = labelText(o.text, `${path}.text`);
      el = createText(x0, x0, DEFAULT_STYLE, t);
      if (o.width !== undefined) el = { ...el, autoWidth: false };
      break;
    }
    case "arrow":
    case "line":
      el = createLinear(type, x0, x0, DEFAULT_STYLE, [{ x: 0, y: 0 }]);
      break;
    case "freedraw":
      el = createFreedraw(0, 0, DEFAULT_STYLE);
      if (o.points === undefined) throw invalid(`${path}.points`, "is required for freedraw");
      el = freedrawPoints(el, o.points, `${path}.points`);
      break;
    case "image":
    case "gif":
    case "video": {
      const f = imageFile(ctx, o, path, type);
      const w =
        o.width === undefined
          ? undefined
          : num(o.width, `${path}.width`, { min: 1, max: SIZE_MAX });
      const h =
        o.height === undefined
          ? undefined
          : num(o.height, `${path}.height`, { min: 1, max: SIZE_MAX });
      const size = mediaSize(f, { width: w, height: h });
      el = createImage(0, 0, size.width, size.height, f.id);
      el = { ...el, ...playback(o, f, path) };
      break;
    }
    case "web_card": {
      const url = normalizeLink(str(o.url, `${path}.url`, LIMITS.url));
      if (!url || !/^https?:/.test(url)) throw invalid(`${path}.url`, "must be an http(s) address");
      el = createEmbed(0, 0, url);
      break;
    }
    case "component": {
      const source = componentSource(o, path);
      const def = source.kind === "preset" ? presetByName(source.preset) : undefined;
      const title =
        o.title === undefined ? "" : str(o.title, `${path}.title`, COMPONENT_LIMITS.title);
      el = createComponent(0, 0, source, title, def?.width ?? 320, def?.height ?? 200);
      if (o.paused !== undefined) el = { ...el, paused: bool(o.paused, `${path}.paused`) };
      break;
    }
  }
  el = applyStyle(el, o, path);
  el = geometry(el, o, path);
  el = common(el, o, path, ctx);
  if (el.type === "text") el = layoutText(el);
  if (
    el.type === "image" &&
    (o.flip_x !== undefined || o.flip_y !== undefined || o.crop !== undefined)
  )
    el = imageExtras(el, o, path, ctx);
  const textField = o.label ?? (type === "note" ? o.text : undefined);
  if (textField !== undefined && isTextContainer(el)) {
    const t = labelText(textField, `${path}.${o.label !== undefined ? "label" : "text"}`);
    if (t) label = makeLabel(el, t, labelStyle(o, path));
  }
  return { el, label, contains };
};

const imageExtras = (el: SceneElement, o: Obj, path: string, ctx: BuildContext): SceneElement => {
  if (el.type !== "image") return el;
  const out = { ...el };
  if (o.flip_x !== undefined) out.flipX = bool(o.flip_x, `${path}.flip_x`);
  if (o.flip_y !== undefined) out.flipY = bool(o.flip_y, `${path}.flip_y`);
  if (o.crop !== undefined) out.crop = crop(o.crop, el, ctx.files.get(el.fileId), `${path}.crop`);
  return out;
};

/**
 * A component's source from preset/params or html/css (MEDIA-05/06). On
 * update, params merge into the current preset's, and html or css alone
 * keeps the other. Unsafe or oversized content is refused naming the rule.
 */
const componentSource = (o: Obj, path: string, current?: ComponentSource): ComponentSource => {
  const custom = o.html !== undefined || o.css !== undefined;
  if (custom && (o.preset !== undefined || o.params !== undefined))
    throw invalid(path, "give either preset (with params) or html/css, not both");
  if (custom) {
    const prev = current?.kind === "custom" ? current : { html: "", css: "" };
    const html = o.html === undefined ? prev.html : o.html;
    const css = o.css === undefined ? prev.css : o.css;
    if (typeof html !== "string") throw invalid(`${path}.html`, "must be text");
    if (typeof css !== "string") throw invalid(`${path}.css`, "must be text");
    const bad = checkCustomContent(html, css);
    if (bad)
      throw new ToolError(
        bad.rule === "too_large" ? "too_large" : "unsafe_component",
        `${path}.${bad.field}: ${bad.message} (rule: ${bad.rule}). See chalanamaya://reference/component-presets for the rules.`,
      );
    return { kind: "custom", html, css };
  }
  const preset =
    o.preset !== undefined ? o.preset : current?.kind === "preset" ? current.preset : undefined;
  if (preset === undefined)
    throw invalid(
      `${path}.preset`,
      `is required: a preset (${PRESET_NAMES.join(", ")}) or custom html/css`,
    );
  if (typeof preset !== "string" || !presetByName(preset))
    throw invalid(`${path}.preset`, `must be one of ${PRESET_NAMES.join(", ")}`);
  const base = current?.kind === "preset" && current.preset === preset ? current.params : {};
  if (
    o.params !== undefined &&
    (typeof o.params !== "object" || o.params === null || Array.isArray(o.params))
  )
    throw invalid(`${path}.params`, "must be an object of parameter values");
  const params = { ...base, ...((o.params as Record<string, ParamValue> | undefined) ?? {}) };
  const bad = checkPresetParams(preset, params);
  if (bad) throw invalid(`${path}.${bad.path}`, bad.reason);
  return { kind: "preset", preset: preset as PresetName, params };
};

/** Second pass for connectors, once every target exists. */
export const buildConnector = (el: LinearElement, raw: Obj, path: string, ctx: BuildContext) => {
  let out = connectorPath(el, raw, path, ctx, true);
  if (out.type === "arrow") {
    if (raw.routing !== undefined)
      out = {
        ...out,
        routing: oneOf(raw.routing, `${path}.routing`, ["straight", "curved", "elbow"]),
      };
    if (raw.start_arrowhead !== undefined)
      out = { ...out, startArrowhead: arrowhead(raw.start_arrowhead, `${path}.start_arrowhead`) };
    if (raw.end_arrowhead !== undefined)
      out = { ...out, endArrowhead: arrowhead(raw.end_arrowhead, `${path}.end_arrowhead`) };
  } else if (raw.closed !== undefined) out = { ...out, closed: bool(raw.closed, `${path}.closed`) };
  let label: TextElement | undefined;
  if (raw.label !== undefined && out.type === "arrow") {
    const t = labelText(raw.label, `${path}.label`);
    if (t) label = { ...makeLabel(out, t, labelStyle(raw, path)), textAlign: "center" };
  }
  return { el: out, label };
};

/** True when the element is a connector or line that needs a second pass. */
export const needsPath = (el: SceneElement): el is LinearElement => isLinear(el);

/** Sizes a box-like element that has no explicit x/y at the free-space cursor. */
export const place = (el: SceneElement, o: Obj, ctx: BuildContext): SceneElement => {
  if (o.x !== undefined && o.y !== undefined) return el;
  if (isLinear(el) || el.type === "freedraw") return el;
  const out = { ...el };
  if (o.x === undefined) out.x = ctx.cursor.x;
  if (o.y === undefined) out.y = ctx.cursor.y;
  ctx.cursor = { x: ctx.cursor.x, y: out.y + Math.max(out.height, 20) + 40 };
  return out;
};

// ------------------------------------------------------------- update path

/**
 * One update entry applied to an existing element. Returns the new element
 * and the label change for containers (undefined = unchanged, "" = remove).
 */
export const updateElement = (
  current: SceneElement,
  o: Obj,
  path: string,
  ctx: BuildContext,
  label: TextElement | undefined,
): { el: SceneElement; label?: TextElement | null } => {
  const type = inputType(current, ctx.files);
  if (o.type !== undefined && o.type !== type && o.type !== current.type)
    throw invalid(
      `${path}.type`,
      `is "${type}"; changing the type is not supported, add a new item instead`,
    );
  if (current.locked && o.locked !== false)
    throw new ToolError(
      "locked",
      `${path}: ${current.id} is locked; unlock it first (locked: false)`,
    );
  warnUnknown(o, [...COMMON_FIELDS, ...(TYPE_FIELDS[type] ?? []), ...UPDATE_EXTRA], path, ctx);
  if (o.id !== undefined && o.id !== current.id) throw invalid(`${path}.id`, "does not match");
  if (o.container !== undefined && current.type === "text" && o.container !== current.containerId)
    ctx.warnings.push(`${path}.container: a label cannot move to another item; ignored`);
  let el = applyStyle(current, o, path);
  el = common(el, o, path, ctx);
  if (el.type === "text" && el.containerId) {
    // a bound label follows its container: geometry is ignored
    for (const k of ["x", "y", "width", "height"])
      if (o[k] !== undefined && o[k] !== (current as unknown as Obj)[k])
        ctx.warnings.push(
          `${path}.${k}: a label is placed by its container; move the container instead`,
        );
  } else el = geometry(el, o, path);
  if (el.type === "text") {
    if (o.text !== undefined) el = { ...el, text: labelText(o.text, `${path}.text`) };
    if (o.width !== undefined && !el.containerId && o.width !== current.width)
      el = { ...el, autoWidth: false };
    if (!el.containerId) el = layoutText(el);
  }
  if (el.type === "frame" && o.name !== undefined)
    el = { ...el, name: str(o.name, `${path}.name`, LIMITS.frameName) };
  if (el.type === "embed" && o.url !== undefined) {
    const url = normalizeLink(str(o.url, `${path}.url`, LIMITS.url));
    if (!url || !/^https?:/.test(url)) throw invalid(`${path}.url`, "must be an http(s) address");
    el = { ...el, url };
  }
  if (el.type === "component") {
    const touches = ["preset", "params", "html", "css"].some((k) => o[k] !== undefined);
    if (touches) el = { ...el, source: componentSource(o, path, el.source) };
    if (o.title !== undefined)
      el = { ...el, title: str(o.title, `${path}.title`, COMPONENT_LIMITS.title) };
    if (o.paused !== undefined) el = { ...el, paused: bool(o.paused, `${path}.paused`) };
  }
  if (el.type === "image") {
    const kind = type === "gif" || type === "video" ? type : "image";
    if ((o.file_id !== undefined && o.file_id !== el.fileId) || o.url !== undefined) {
      const f = imageFile(ctx, o, path, kind === "gif" ? "image" : kind);
      if (f.id !== el.fileId) el = { ...el, fileId: f.id, crop: null };
    }
    const img = imageExtras(el, o, path, ctx) as ImageElement;
    const f = ctx.files.get(img.fileId);
    el = f ? { ...img, ...playback(o, f, path, img) } : img;
  }
  if (isLinear(el)) {
    if (o.points !== undefined || o.from !== undefined || o.to !== undefined) {
      // moving x/y alone shifts the path; points are absolute and win
      el = connectorPath(el, o, path, ctx, false);
    }
    if (el.type === "arrow") {
      if (o.routing !== undefined)
        el = {
          ...el,
          routing: oneOf(o.routing, `${path}.routing`, ["straight", "curved", "elbow"]),
        };
      if (o.start_arrowhead !== undefined)
        el = { ...el, startArrowhead: arrowhead(o.start_arrowhead, `${path}.start_arrowhead`) };
      if (o.end_arrowhead !== undefined)
        el = { ...el, endArrowhead: arrowhead(o.end_arrowhead, `${path}.end_arrowhead`) };
    }
    if (o.closed !== undefined && el.type === "line")
      el = { ...el, closed: bool(o.closed, `${path}.closed`) };
    else if (o.closed !== undefined && o.closed !== el.closed)
      ctx.warnings.push(`${path}.closed: only lines can be closed; ignored`);
  }
  if (el.type === "freedraw" && o.points !== undefined)
    el = freedrawPoints(el, o.points, `${path}.points`);
  let nextLabel: TextElement | null | undefined;
  const textField = o.label ?? (el.type === "note" ? o.text : undefined);
  if (textField !== undefined && (isTextContainer(el) || el.type === "arrow")) {
    const t = labelText(textField, `${path}.${o.label !== undefined ? "label" : "text"}`);
    if (!t) nextLabel = label ? null : undefined;
    else if (label) nextLabel = label.text === t ? undefined : { ...label, text: t };
    else
      nextLabel = {
        ...makeLabel(el, t, DEFAULT_STYLE),
        ...(el.type === "arrow" ? { textAlign: "center" as const } : {}),
      };
  }
  return { el, label: nextLabel };
};

/** The input-facing type name of a stored element. */
/** The agent-facing type: web_card for embeds; gif / video for pictures whose file is one. */
export const inputType = (
  el: SceneElement,
  files?: ReadonlyMap<string, { mime: string }>,
): string => {
  if (el.type === "embed") return "web_card";
  if (el.type === "image" && files) {
    const m = files.get(el.fileId)?.mime;
    if (m === "image/gif") return "gif";
    if (isVideoMime(m)) return "video";
  }
  return el.type;
};

export const NOTE_DEFAULT = NOTE_SWATCHES[0];
