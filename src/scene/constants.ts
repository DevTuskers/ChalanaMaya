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
  fillStyle: "hachure",
  strokeStyle: "solid",
  roughness: 1,
  edges: "sharp",
  opacity: 100,
  routing: "straight",
  startArrowhead: "none",
  endArrowhead: "arrow",
};

export const PAPER = { light: "#fff9ed", dark: "#172524" } as const;

/** Note colours (stored as is; notes keep dark ink in both themes). */
export const NOTE_SWATCHES = ["#ffe59a", "#ffd2b0", "#c9efe6", "#d6e4fb", "#f6d0e2"];
export const NOTE_INK = "#193a36";

/** Board background choices; the dark theme shows a matching dark variant. */
export const BOARD_COLORS: { id: string; label: string; light: string; dark: string }[] = [
  { id: "#fff9ed", label: "Paper", light: "#fff9ed", dark: "#172524" },
  { id: "#ffffff", label: "White", light: "#ffffff", dark: "#121212" },
  { id: "#eef6f4", label: "Mist", light: "#eef6f4", dark: "#1b2b33" },
  { id: "#fdf0e6", label: "Peach", light: "#fdf0e6", dark: "#2b221c" },
  { id: "#eef0f3", label: "Slate", light: "#eef0f3", dark: "#1e2226" },
];

export const resolveBoardColor = (color: string, theme: "light" | "dark") => {
  const known = BOARD_COLORS.find((c) => c.id === color.toLowerCase());
  if (known) return known[theme];
  return color;
};

export const ROUGHNESS_LEVELS = [
  { value: 0, label: "Tidy" },
  { value: 1, label: "Sketchy" },
  { value: 2, label: "Wobbly" },
] as const;

export const GRID_SIZE = 20;
