/** Limits shared by the editors (source limits) and strict validation (§3.11, §7). */
export const LIMITS = {
  coord: 10_000_000,
  size: 10_000_000,
  angle: 4 * Math.PI,
  opacityMax: 100,
  strokeWidthMax: 64,
  fontSizeMin: 1,
  fontSizeMax: 1000,
  seedMax: 2 ** 31,
  textChars: 10_000,
  frameName: 200,
  link: 2048,
  url: 2048,
  linearPoints: 1000,
  freedrawPoints: 5000,
  groupIds: 32,
  elementBytes: 256 * 1024,
  title: 120,
} as const;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;
export const isColor = (v: unknown): v is string =>
  v === "transparent" || (typeof v === "string" && COLOR_RE.test(v));

/** Wraps an angle into [0, 2π). */
export const wrapAngle = (a: number) => {
  const full = Math.PI * 2;
  let r = a % full;
  if (r < 0) r += full;
  // -0 and values that round to 2π stay in range
  return r >= full || Object.is(r, -0) ? 0 : r;
};

/**
 * Source caps for pencil strokes, derived from the element byte cap so a stroke
 * the app makes can never be too large, whatever its coordinates (fractional
 * zoom, later resizes) and pressures. A JSON number in the coordinate range is
 * at most 25 characters (sign, "0.00000" and 17 significant digits), so one
 * point `{"x":…,"y":…},` is at most 62 bytes and one pressure at most 25.
 * 8 KiB is kept for the other fields (ids, 32 group ids, a 2,048-character link).
 */
const WORST_POINT_BYTES = 62;
const WORST_PRESSURE_BYTES = 25;
const ELEMENT_FIELDS_RESERVE = 8 * 1024;
export const freedrawSourcePoints = (hasPressures: boolean) =>
  Math.min(
    LIMITS.freedrawPoints,
    Math.floor(
      (LIMITS.elementBytes - ELEMENT_FIELDS_RESERVE) /
        (WORST_POINT_BYTES + (hasPressures ? WORST_PRESSURE_BYTES : 0)),
    ),
  );
