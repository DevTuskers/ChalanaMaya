/**
 * Palette names agents can use (plan §5.2), and the small coercions every
 * tool shares: numbers given as strings, named sizes, degrees, colours.
 */
import { BOARD_COLORS, FONT_SIZES } from "../../src/scene/constants";
import { COLOR_RE } from "../../src/shared/limits";

export const STROKE_NAMES: Record<string, string> = {
  ink: "#193a36",
  lagoon: "#007f78",
  clay: "#b65b24",
  berry: "#c0392b",
  sky: "#2f6fb5",
  moss: "#6b8e23",
};
export const FILL_NAMES: Record<string, string> = {
  none: "transparent",
  mint: "#bfe8e2",
  peach: "#ffd9b8",
  rose: "#f7c6c1",
  cloud: "#c9dcf5",
  sage: "#e3edc2",
};
export const NOTE_NAMES: Record<string, string> = {
  butter: "#ffe59a",
  apricot: "#ffd2b0",
  seafoam: "#c9efe6",
  mist: "#d6e4fb",
  blush: "#f6d0e2",
};
export const BOARD_NAMES: Record<string, string> = Object.fromEntries(
  BOARD_COLORS.map((c) => [c.label.toLowerCase(), c.id]),
);
const ALL_NAMES: Record<string, string> = { ...NOTE_NAMES, ...FILL_NAMES, ...STROKE_NAMES };
const BY_HEX = new Map<string, string>();
for (const [name, hex] of Object.entries({ ...STROKE_NAMES, ...FILL_NAMES, ...NOTE_NAMES }))
  if (!BY_HEX.has(hex)) BY_HEX.set(hex, name);

export const FONT_SIZE_NAMES: Record<string, number> = Object.fromEntries(
  Object.entries(FONT_SIZES).map(([k, v]) => [k, v.value]),
);
export const STROKE_WIDTH_NAMES: Record<string, number> = {
  thin: 1,
  bold: 2.5,
  "extra-bold": 4.5,
  extra: 4.5,
};
export const ROUGHNESS_NAMES: Record<string, 0 | 1 | 2> = { tidy: 0, sketchy: 1, wobbly: 2 };

/** A tool failure with a code, a precise path and a hint (returned with isError). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const invalid = (path: string, msg: string) =>
  new ToolError("invalid_input", path ? `${path}: ${msg}` : msg);

export const num = (
  v: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): number => {
  let n: number = NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) n = Number(v);
  if (!Number.isFinite(n)) throw invalid(path, "must be a number");
  if (opts.min !== undefined && n < opts.min) throw invalid(path, `must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw invalid(path, `must be at most ${opts.max}`);
  return n;
};

export const bool = (v: unknown, path: string): boolean => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw invalid(path, "must be true or false");
};

export const str = (v: unknown, path: string, max: number): string => {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") throw invalid(path, "must be a string");
  if (v.length > max) throw invalid(path, `must be at most ${max} characters`);
  return v;
};

export const oneOf = <T extends string>(v: unknown, path: string, options: readonly T[]): T => {
  if (typeof v === "string" && (options as readonly string[]).includes(v)) return v as T;
  throw invalid(path, `must be one of ${options.map((o) => `"${o}"`).join(", ")}`);
};

/** Palette name or hex; `kind` picks the list named in the error. */
export const color = (v: unknown, path: string, kind: "stroke" | "fill" | "note"): string => {
  if (typeof v !== "string") throw invalid(path, "must be a palette name or a hex colour");
  const t = v.trim().toLowerCase();
  if (t === "transparent") return "transparent";
  if (ALL_NAMES[t]) return ALL_NAMES[t];
  if (COLOR_RE.test(t)) return t;
  const names = kind === "stroke" ? STROKE_NAMES : kind === "fill" ? FILL_NAMES : NOTE_NAMES;
  throw invalid(
    path,
    `"${v}" is not a colour. Use a hex value like "#2f6fb5" or one of: ${Object.keys(names).join(", ")}`,
  );
};

/** Hex back to a palette name for compact output. */
export const colorName = (hex: string) =>
  hex === "transparent" ? "none" : (BY_HEX.get(hex.toLowerCase()) ?? hex);

export const boardColor = (v: unknown, path: string): string => {
  if (typeof v !== "string") throw invalid(path, "must be a board colour name or hex");
  const t = v.trim().toLowerCase();
  if (BOARD_NAMES[t]) return BOARD_NAMES[t];
  if (COLOR_RE.test(t)) return t;
  throw invalid(
    path,
    `"${v}" is not a board colour. Use one of: ${Object.keys(BOARD_NAMES).join(", ")} or a hex value`,
  );
};

export const degToRad = (deg: number) => (deg * Math.PI) / 180;
export const radToDeg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 1000) / 1000;
export const round = (n: number) => Math.round(n * 100) / 100;
