/**
 * Editable scene data hidden inside PNG (a tEXt chunk) and SVG (a metadata block).
 * The payload is the regular .chalana JSON, base64 encoded (UTF-8 safe).
 */
export const EMBED_KEYWORD = "chalanamaya";
const SVG_MARKER = "chalanamaya-scene";

export class EmbedError extends Error {}

const utf8ToBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

const base64ToUtf8 = (b64: string) => {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

let crcTable: Uint32Array | null = null;
const crc32 = (bytes: Uint8Array) => {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export const isPng = (bytes: Uint8Array) => PNG_SIG.every((b, i) => bytes[i] === b);

/** Inserts a tEXt chunk with the scene right after IHDR. */
export const embedInPng = (png: Uint8Array, sceneJson: string): Uint8Array => {
  if (!isPng(png)) throw new EmbedError("Not a PNG image.");
  const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const data = new Uint8Array([...latin(EMBED_KEYWORD), 0, ...latin(utf8ToBase64(sceneJson))]);
  const type = latin("tEXt");
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(type.length + data.length);
  crcInput.set(type);
  crcInput.set(data, type.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  const ihdrEnd = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd));
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
};

/** Returns the embedded scene JSON, null when there is none; throws EmbedError when damaged. */
export const extractFromPng = (png: Uint8Array): string | null => {
  if (!isPng(png)) throw new EmbedError("This file is not a PNG image.");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  while (off + 12 <= png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (off + 12 + len > png.length) throw new EmbedError("The image is truncated.");
    if (type === "tEXt") {
      const data = png.subarray(off + 8, off + 8 + len);
      const zero = data.indexOf(0);
      const key = String.fromCharCode(...data.subarray(0, zero));
      if (key === EMBED_KEYWORD) {
        const crcInput = png.subarray(off + 4, off + 8 + len);
        if (crc32(crcInput) !== view.getUint32(off + 8 + len)) {
          throw new EmbedError("The board data inside this image is damaged.");
        }
        let b64 = "";
        for (const b of data.subarray(zero + 1)) b64 += String.fromCharCode(b);
        try {
          return base64ToUtf8(b64);
        } catch {
          throw new EmbedError("The board data inside this image is damaged.");
        }
      }
    }
    if (type === "IEND") break;
    off += 12 + len;
  }
  return null;
};

export const svgMetadata = (sceneJson: string) =>
  `<metadata id="${SVG_MARKER}">${utf8ToBase64(sceneJson)}</metadata>`;

export const extractFromSvg = (svg: string): string | null => {
  const start = svg.indexOf(`<metadata id="${SVG_MARKER}">`);
  if (start < 0) return null;
  const from = start + `<metadata id="${SVG_MARKER}">`.length;
  const end = svg.indexOf("</metadata>", from);
  if (end < 0) throw new EmbedError("The board data inside this SVG is damaged.");
  try {
    return base64ToUtf8(svg.slice(from, end));
  } catch {
    throw new EmbedError("The board data inside this SVG is damaged.");
  }
};
