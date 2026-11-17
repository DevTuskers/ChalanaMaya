/**
 * Pictures in a session board live on the server (plan §4.1): the file map
 * holds the board-relative URL instead of a data URL, and anything brought in
 * from outside (a .chalana file, the old browser board, a paste from another
 * board) is uploaded first and its fileIds remapped.
 */
import type { FileMap, SceneElement } from "../scene/types";

export type Uploader = (blob: Blob) => Promise<{ id: string; url: string; mime: string }>;

export const dataUrlToBlob = (dataURL: string): Blob => {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataURL);
  if (!m) throw new Error("not a data URL");
  const mime = m[1] || "application/octet-stream";
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: mime });
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const sourceBlob = async (src: string, mime: string): Promise<Blob> => {
  if (src.startsWith("data:")) return dataUrlToBlob(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`could not read ${src}`);
  const b = await res.blob();
  return b.type ? b : new Blob([b], { type: mime });
};

export interface AdoptResult {
  elements: SceneElement[];
  files: FileMap;
  /** Pictures that could not be uploaded (their items are left out). */
  failed: number;
}

/**
 * Uploads the pictures `elements` use that the board does not have yet, and
 * returns the elements with remapped fileIds plus the new file entries.
 */
export const adoptFiles = async (
  elements: readonly SceneElement[],
  files: FileMap,
  current: FileMap,
  upload: Uploader,
): Promise<AdoptResult> => {
  const remap = new Map<string, string | null>();
  const added: FileMap = {};
  let failed = 0;
  for (const el of elements) {
    if (el.type !== "image" || remap.has(el.fileId)) continue;
    const src = files[el.fileId];
    const have = current[el.fileId];
    if (have && (!src || src.dataURL === have.dataURL)) {
      remap.set(el.fileId, el.fileId);
      continue;
    }
    if (!src) {
      remap.set(el.fileId, null);
      continue;
    }
    try {
      const up = await upload(await sourceBlob(src.dataURL, src.mimeType));
      remap.set(el.fileId, up.id);
      added[up.id] = { id: up.id, mimeType: up.mime, dataURL: up.url };
    } catch {
      remap.set(el.fileId, null);
    }
  }
  const out: SceneElement[] = [];
  const droppedIds = new Set<string>();
  for (const el of elements) {
    if (el.type !== "image") continue;
    const id = remap.get(el.fileId);
    if (!id) {
      droppedIds.add(el.id);
      failed += 1;
    }
  }
  for (const el of elements) {
    if (droppedIds.has(el.id)) continue;
    if (el.type === "image") out.push({ ...el, fileId: remap.get(el.fileId)! });
    else out.push(el);
  }
  return { elements: out, files: added, failed };
};

/** Turns server file URLs back into data URLs (for .chalana files and exports). */
export const inlineFiles = async (files: FileMap, used?: ReadonlySet<string>): Promise<FileMap> => {
  const out: FileMap = {};
  for (const [id, f] of Object.entries(files)) {
    if (used && !used.has(id)) continue;
    if (f.dataURL.startsWith("data:")) {
      out[id] = f;
      continue;
    }
    try {
      const blob = await sourceBlob(f.dataURL, f.mimeType);
      const dataURL = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      out[id] = { ...f, dataURL };
    } catch {
      // a missing picture is left out; the item shows as an empty picture
    }
  }
  return out;
};

export const usedFileIds = (elements: readonly SceneElement[]) =>
  new Set(elements.flatMap((e) => (e.type === "image" ? [e.fileId] : [])));
