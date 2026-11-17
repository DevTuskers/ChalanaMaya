/**
 * Video metadata (plan §6.1): size and duration of MP4 and WebM uploads.
 *
 * MP4: a small ISO-BMFF box walker (moov > mvhd for duration, moov > trak >
 * tkhd for the picture size). WebM: a small EBML reader (Segment > Info for
 * TimecodeScale/Duration, Segment > Tracks > TrackEntry > Video for
 * PixelWidth/PixelHeight). Both are bounded and never throw; anything they
 * cannot read is null and the caller falls back to 480 x 270 (16:9).
 * We read only the few fields we need, so no demuxer dependency is pulled in.
 */
export interface VideoMeta {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

const NONE: VideoMeta = { width: null, height: null, durationMs: null };
const MAX_BOXES = 10_000;

/* ---------- MP4 ---------- */

const mp4Boxes = function* (b: Buffer, start: number, end: number) {
  let off = start;
  let n = 0;
  while (off + 8 <= end && n++ < MAX_BOXES) {
    let size = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(b.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size };
    off += size;
  }
};

export const mp4Meta = (b: Buffer): VideoMeta => {
  try {
    const moov = [...mp4Boxes(b, 0, b.length)].find((x) => x.type === "moov");
    if (!moov) return NONE;
    let durationMs: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    for (const box of mp4Boxes(b, moov.start, moov.end)) {
      if (box.type === "mvhd") {
        const v = b[box.start];
        const timescale = v === 1 ? b.readUInt32BE(box.start + 20) : b.readUInt32BE(box.start + 12);
        const dur =
          v === 1 ? Number(b.readBigUInt64BE(box.start + 24)) : b.readUInt32BE(box.start + 16);
        if (timescale > 0) durationMs = Math.round((dur / timescale) * 1000);
      } else if (box.type === "trak" && width === null) {
        const tkhd = [...mp4Boxes(b, box.start, box.end)].find((x) => x.type === "tkhd");
        if (!tkhd) continue;
        const v = b[tkhd.start];
        // width/height are the last 8 bytes, 16.16 fixed point
        const at = tkhd.start + (v === 1 ? 88 : 76);
        if (at + 8 > tkhd.end) continue;
        const w = b.readUInt32BE(at) / 65536;
        const h = b.readUInt32BE(at + 4) / 65536;
        if (w > 0 && h > 0) {
          width = Math.round(w);
          height = Math.round(h);
        }
      }
    }
    return { width, height, durationMs };
  } catch {
    return NONE;
  }
};

/* ---------- WebM (EBML) ---------- */

const vint = (b: Buffer, off: number, keepMarker: boolean) => {
  if (off >= b.length) return null;
  const first = b[off];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[off + i];
    if (b[off + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
};

const ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
};
const MASTERS = new Set([ID.segment, ID.info, ID.tracks, ID.trackEntry, ID.video]);

const uint = (b: Buffer, s: number, e: number) => {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + b[i];
  return v;
};

export const webmMeta = (b: Buffer): VideoMeta => {
  try {
    let scale = 1_000_000;
    let duration: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    const walk = (start: number, end: number, depth: number) => {
      let off = start;
      let n = 0;
      while (off < end && n++ < MAX_BOXES) {
        const id = vint(b, off, true);
        if (!id) return;
        const size = vint(b, off + id.len, false);
        if (!size) return;
        const s = off + id.len + size.len;
        const e = size.unknown ? end : Math.min(end, s + size.value);
        if (id.value === ID.cluster) return; // media data: everything we need comes before it
        if (MASTERS.has(id.value) && depth < 6) walk(s, e, depth + 1);
        else if (id.value === ID.timecodeScale) scale = uint(b, s, e) || scale;
        else if (id.value === ID.duration)
          duration = e - s === 4 ? b.readFloatBE(s) : e - s === 8 ? b.readDoubleBE(s) : null;
        else if (id.value === ID.pixelWidth && width === null) width = uint(b, s, e);
        else if (id.value === ID.pixelHeight && height === null) height = uint(b, s, e);
        off = e;
      }
    };
    walk(0, b.length, 0);
    const durationMs =
      duration !== null && Number.isFinite(duration) && duration > 0
        ? Math.round((duration * scale) / 1e6)
        : null;
    return { width: width || null, height: height || null, durationMs };
  } catch {
    return NONE;
  }
};

export const videoMeta = (mime: string, b: Buffer): VideoMeta =>
  mime === "video/mp4" ? mp4Meta(b) : mime === "video/webm" ? webmMeta(b) : NONE;

/** The fallback box for a video whose size is unknown (16:9). */
export const VIDEO_FALLBACK = { width: 480, height: 270 };
