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
