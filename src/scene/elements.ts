import { DEFAULT_STYLE, TRANSPARENT } from "./constants";
import type {
  FreedrawElement,
  ImageElement,
  ItemStyle,
  LinearElement,
  LinearType,
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
  fillStyle: "hachure" as const,
  strokeWidth: style.strokeWidth,
  seed: newSeed(),
  locked: false,
});

export const createShape = (
  type: ShapeType,
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
  width = 0,
  height = 0,
): ShapeElement => ({ ...base(style, x, y), type, width, height });

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
});

export const createFreedraw = (
  x: number,
  y: number,
  style: ItemStyle = DEFAULT_STYLE,
): FreedrawElement => ({
  ...base(style, x, y),
  type: "freedraw",
  backgroundColor: TRANSPARENT,
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
});

export const isShape = (el: SceneElement): el is ShapeElement =>
  el.type === "rectangle" || el.type === "diamond" || el.type === "ellipse";

export const isLinear = (el: SceneElement): el is LinearElement =>
  el.type === "arrow" || el.type === "line";

export const hasPoints = (el: SceneElement): el is LinearElement | FreedrawElement =>
  isLinear(el) || el.type === "freedraw";

/** Elements that can hold a fill colour. */
export const isFillable = (el: SceneElement) => isShape(el) || (el.type === "line" && el.closed);

/** Elements arrows can attach to. */
export const isBindable = (el: SceneElement) =>
  isShape(el) || el.type === "image" || (el.type === "text" && !el.containerId);

export const isBoundText = (el: SceneElement): el is TextElement =>
  el.type === "text" && el.containerId !== null;
