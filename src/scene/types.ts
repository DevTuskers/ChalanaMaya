export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type ShapeType = "rectangle" | "diamond" | "ellipse";
export type LinearType = "arrow" | "line";
export type ElementType =
  ShapeType | LinearType | "freedraw" | "text" | "image" | "note" | "frame";

export type FontFamily = "hand" | "normal" | "code";
export type FontSizeName = "s" | "m" | "l" | "xl";
export type TextAlign = "left" | "center" | "right";
export type FillStyle = "hachure" | "cross-hatch" | "zigzag" | "solid";
export type StrokeStyle = "solid" | "dashed" | "dotted";
/** 0 = tidy, 1 = sketchy, 2 = wobbly. */
export type Roughness = 0 | 1 | 2;
export type Edges = "sharp" | "round";
export type Routing = "straight" | "curved" | "elbow";
export type Arrowhead =
  | "none"
  | "arrow"
  | "bar"
  | "circle"
  | "circle-outline"
  | "triangle"
  | "triangle-outline"
  | "diamond"
  | "diamond-outline"
  | "er-zero"
  | "er-one"
  | "er-many"
  | "er-zero-one"
  | "er-zero-many"
  | "er-one-many";

export interface BaseElement {
  id: string;
  type: ElementType;
  /** Top-left corner of the unrotated box, in board units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in radians around the box centre. */
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: Roughness;
  edges: Edges;
  /** 0 (invisible) to 100 (opaque). */
  opacity: number;
  /** Stable random seed for the hand-drawn look. */
  seed: number;
  locked: boolean;
  /** Group ids, innermost first. */
  groupIds: string[];
  /** Page frame this element belongs to. */
  frameId: string | null;
  /** External URL or internal "#el=<id>" link. */
  link: string | null;
}

export interface ShapeElement extends BaseElement {
  type: ShapeType;
}

export interface NoteElement extends BaseElement {
  type: "note";
}

export interface FrameElement extends BaseElement {
  type: "frame";
  name: string;
}

export interface Binding {
  elementId: string;
}

export interface LinearElement extends BaseElement {
  type: LinearType;
  /** Points relative to (x, y). */
  points: Point[];
  /** Only meaningful for lines: the path is a closed polygon. */
  closed: boolean;
  startBinding: Binding | null;
  endBinding: Binding | null;
  routing: Routing;
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
}

export interface FreedrawElement extends BaseElement {
  type: "freedraw";
  /** Points relative to (x, y). */
  points: Point[];
}

export interface TextElement extends BaseElement {
  type: "text";
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  textAlign: TextAlign;
  /** When set, the text is bound inside this shape, note or connector. */
  containerId: string | null;
  /** Unconstrained text grows with its content; otherwise it wraps at `width`. */
  autoWidth: boolean;
}

/** Visible part of an image, in natural image pixels. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ImageElement extends BaseElement {
  type: "image";
  fileId: string;
  crop: Crop | null;
  flipX: boolean;
  flipY: boolean;
}

export type SceneElement =
  | ShapeElement
  | LinearElement
  | FreedrawElement
  | TextElement
  | ImageElement
  | NoteElement
  | FrameElement;

export interface BinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
}

export type FileMap = Record<string, BinaryFile>;

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export type Theme = "light" | "dark";

export interface ItemStyle {
  strokeColor: string;
  backgroundColor: string;
  strokeWidth: number;
  fontFamily: FontFamily;
  fontSize: number;
  textAlign: TextAlign;
  fillStyle: FillStyle;
  strokeStyle: StrokeStyle;
  roughness: Roughness;
  edges: Edges;
  opacity: number;
  routing: Routing;
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
}
