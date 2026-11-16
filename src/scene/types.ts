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
export type ElementType = ShapeType | LinearType | "freedraw" | "text" | "image";

export type FontFamily = "hand" | "normal" | "code";
export type FontSizeName = "s" | "m" | "l" | "xl";
export type TextAlign = "left" | "center" | "right";
export type FillStyle = "hachure" | "solid";

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
  /** Stable random seed for the hand-drawn look. */
  seed: number;
  locked: boolean;
}

export interface ShapeElement extends BaseElement {
  type: ShapeType;
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
  /** When set, the text is bound inside this shape. */
  containerId: string | null;
  /** Unconstrained text grows with its content; otherwise it wraps at `width`. */
  autoWidth: boolean;
}

export interface ImageElement extends BaseElement {
  type: "image";
  fileId: string;
}

export type SceneElement =
  ShapeElement | LinearElement | FreedrawElement | TextElement | ImageElement;

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
}
