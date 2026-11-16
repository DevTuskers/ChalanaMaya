import type { FontFamily, FontSizeName, ItemStyle } from "./types";

/** Default ink matches the brand's main text colour; dark theme renders it light. */
export const INK = "#193a36";
export const INK_DARK = "#edf8f3";
export const TRANSPARENT = "transparent";

export const STROKE_SWATCHES = [INK, "#007f78", "#b65b24", "#c0392b", "#2f6fb5", "#6b8e23"];
export const FILL_SWATCHES = [TRANSPARENT, "#bfe8e2", "#ffd9b8", "#f7c6c1", "#c9dcf5", "#e3edc2"];

export const STROKE_WIDTHS = [
  { id: "thin", label: "Thin", value: 1 },
  { id: "bold", label: "Bold", value: 2.5 },
  { id: "extra", label: "Extra bold", value: 4.5 },
] as const;

export const FONT_SIZES: Record<FontSizeName, { label: string; value: number }> = {
  s: { label: "Small", value: 16 },
  m: { label: "Medium", value: 20 },
  l: { label: "Large", value: 28 },
  xl: { label: "Extra large", value: 40 },
};

export const FONT_FAMILIES: Record<FontFamily, { label: string; css: string }> = {
  hand: { label: "Hand-drawn", css: '"Kalam", "Comic Sans MS", "Segoe Print", cursive' },
  normal: {
    label: "Normal",
    css: '"Source Sans 3", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  },
  code: { label: "Code", css: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace' },
};

export const LINE_HEIGHT = 1.3;
export const BOUND_TEXT_PADDING = 8;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;

export const DEFAULT_STYLE: ItemStyle = {
  strokeColor: INK,
  backgroundColor: TRANSPARENT,
  strokeWidth: 2.5,
  fontFamily: "hand",
  fontSize: FONT_SIZES.m.value,
  textAlign: "left",
};

export const PAPER = { light: "#fff9ed", dark: "#172524" } as const;
