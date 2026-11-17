/**
 * Media type checks (plan §7): the first bytes must match the claimed type.
 * No SVG (it can carry script).
 */
import { imageSize } from "image-size";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const VIDEO_TYPES = ["video/mp4", "video/webm"] as const;
export type PictureType = (typeof PICTURE_TYPES)[number];

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The media type the bytes really are, or null when they are none of the allowed types. */
export const sniffType = (b: Uint8Array): string | null => {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(b, ascii("ftyp"), 4)) return "video/mp4";
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
};

/** Normalises a Content-Type header ("image/PNG; charset=x" -> "image/png"). */
export const baseType = (contentType: string | undefined) =>
  (contentType ?? "").split(";")[0].trim().toLowerCase();

/** Picture width and height, or nulls when the file cannot be read (upload still succeeds, §6.1). */
export const pictureSize = (b: Uint8Array): { width: number | null; height: number | null } => {
  try {
    const s = imageSize(b);
    const w = s.width;
    const h = s.height;
    if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)
      return { width: w, height: h };
  } catch {
    // unreadable header
  }
  return { width: null, height: null };
};
