import { DEFAULT_STYLE, NOTE_SWATCHES, TRANSPARENT } from "./constants";
import type {
  EmbedElement,
  FrameElement,
  FreedrawElement,
  ImageElement,
  ItemStyle,
  LinearElement,
  LinearType,
  NoteElement,
  Point,
  SceneElement,
  ShapeElement,
  ShapeType,
  TextElement,
} from "./types";

let counter = 0;
export const newId = () => {
  counter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${rand}${counter.toString(36)}`;
};

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

const base = (style: ItemStyle, x: number, y: number) => ({
  id: newId(),
  x,
  y,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: style.strokeColor,
  backgroundColor: style.backgroundColor,
  fillStyle: style.fillStyle ?? ("hachure" as const),
  strokeWidth: style.strokeWidth,
  strokeStyle: style.strokeStyle ?? ("solid" as const),
  roughness: style.roughness ?? (1 as const),
  edges: style.edges ?? ("sharp" as const),
  opacity: style.opacity ?? 100,
  seed: newSeed(),
  locked: false,
  groupIds: [] as string[],
  frameId: null,
  link: null,
});

export const createShape = (
  type: ShapeType,
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
  width = 0,
  height = 0,
): ShapeElement => ({
  ...base(style, x, y),
  type,
  width,
  height,
  edges: type === "ellipse" ? "sharp" : (style.edges ?? "sharp"),
});

export const createLinear = (
  type: LinearType,
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
  points: Point[] = [{ x: 0, y: 0 }],
): LinearElement => ({
  ...base(style, x, y),
  type,
  backgroundColor: type === "arrow" ? TRANSPARENT : style.backgroundColor,
  points,
  closed: false,
  startBinding: null,
  endBinding: null,
  routing: type === "arrow" ? (style.routing ?? "straight") : "straight",
  startArrowhead: type === "arrow" ? (style.startArrowhead ?? "none") : "none",
  endArrowhead: type === "arrow" ? (style.endArrowhead ?? "arrow") : "none",
  edges: type === "arrow" ? (style.edges ?? "sharp") : "sharp",
});

export const createFreedraw = (
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
): FreedrawElement => ({
  ...base(style, x, y),
  type: "freedraw",
  backgroundColor: TRANSPARENT,
  strokeStyle: "solid",
  points: [{ x: 0, y: 0 }],
});

export const createText = (
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
  text = "",
  containerId: string | null = null,
): TextElement => ({
  ...base(style, x, y),
  type: "text",
  backgroundColor: TRANSPARENT,
  strokeStyle: "solid",
  text,
  fontFamily: style.fontFamily,
  fontSize: style.fontSize,
  textAlign: containerId ? "center" : style.textAlign,
  containerId,
  autoWidth: containerId === null,
  width: 4,
  height: style.fontSize * 1.3,
});

export const createImage = (
  x: number,
  y: number,
  width: number,
  height: number,
  fileId: string,
): ImageElement => ({
  ...base(DEFAULT_STYLE, x, y),
  type: "image",
  strokeColor: TRANSPARENT,
  backgroundColor: TRANSPARENT,
  width,
  height,
  fileId,
  crop: null,
  flipX: false,
  flipY: false,
});

export const createNote = (
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
  size = 180,
): NoteElement => ({
  ...base(style, x, y),
  type: "note",
  width: size,
  height: size,
  strokeColor: "#193a36",
  backgroundColor: NOTE_SWATCHES[0],
  fillStyle: "solid",
  strokeWidth: 1,
  roughness: 0,
  edges: "round",
});

export const createFrame = (x: number, y: number, name = "Page"): FrameElement => ({
  ...base(DEFAULT_STYLE, x, y),
  type: "frame",
  strokeColor: "#52706b",
  backgroundColor: TRANSPARENT,
  strokeWidth: 1,
  roughness: 0,
  edges: "round",
  name,
});

export const createEmbed = (
  x: number,
  y: number,
  url: string,
  width = 480,
  height = 300,
): EmbedElement => ({
  ...base(DEFAULT_STYLE, x, y),
  type: "embed",
  strokeColor: "#52706b",
  backgroundColor: TRANSPARENT,
  strokeWidth: 1,
  roughness: 0,
  edges: "round",
  width,
  height,
  url,
});

export const isShape = (el: SceneElement): el is ShapeElement =>
  el.type === "rectangle" || el.type === "diamond" || el.type === "ellipse";

export const isLinear = (el: SceneElement): el is LinearElement =>
  el.type === "arrow" || el.type === "line";

export const hasPoints = (el: SceneElement): el is LinearElement | FreedrawElement =>
  isLinear(el) || el.type === "freedraw";

/** Shapes and notes can hold wrapped text. */
export const isTextContainer = (el: SceneElement): el is ShapeElement | NoteElement =>
  isShape(el) || el.type === "note";

/** Elements that can hold a fill colour. */
export const isFillable = (el: SceneElement) =>
  isShape(el) || el.type === "note" || (el.type === "line" && el.closed);

/** Elements whose outline offers a stroke style, width and sloppiness. */
export const hasOutline = (el: SceneElement) => isShape(el) || isLinear(el);

/** Elements that offer sharp or round edges. */
export const supportsEdges = (el: SceneElement) =>
  el.type === "rectangle" ||
  el.type === "diamond" ||
  el.type === "note" ||
  (el.type === "arrow" && el.routing === "elbow");

/** Elements arrows can attach to. */
export const isBindable = (el: SceneElement) =>
  isShape(el) ||
  el.type === "image" ||
  el.type === "embed" ||
  el.type === "note" ||
  (el.type === "text" && !el.containerId);

export const isBoundText = (el: SceneElement): el is TextElement =>
  el.type === "text" && el.containerId !== null;
