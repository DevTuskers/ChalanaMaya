import { parseClipboard, type ClipboardPayload } from "./serialize";

export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type PasteContent =
  | { kind: "image"; blob: Blob }
  | { kind: "scene"; payload: ClipboardPayload }
  | { kind: "text"; text: string }
  | { kind: "unsupported"; detail: string }
  | { kind: "empty" };

/** Classifies text from the clipboard. */
export const classifyText = (text: string): PasteContent => {
  const payload = parseClipboard(text);
  if (payload) return { kind: "scene", payload };
  if (text.trim()) return { kind: "text", text: text.replace(/\r\n/g, "\n") };
  return { kind: "empty" };
};

/** Reads a paste event synchronously-available data. */
export const readPasteEvent = (data: DataTransfer | null): PasteContent => {
  if (!data) return { kind: "unsupported", detail: "The clipboard could not be read." };
  const files = [...data.files];
  const image = files.find((f) => SUPPORTED_IMAGE_TYPES.includes(f.type));
  if (image) return { kind: "image", blob: image };
  const text = data.getData("text/plain");
  if (text) return classifyText(text);
  if (files.length) {
    return {
      kind: "unsupported",
      detail: `This kind of content (${files[0].type || "unknown file"}) can't be pasted.`,
    };
  }
  return { kind: "empty" };
};

/** Reads the clipboard through the async API (used by the Paste button). */
export const readClipboardApi = async (): Promise<PasteContent> => {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip) {
    return { kind: "unsupported", detail: "This browser does not give access to the clipboard." };
  }
  try {
    if (clip.read) {
      const items = await clip.read();
      for (const item of items) {
        const type = item.types.find((t) => SUPPORTED_IMAGE_TYPES.includes(t));
        if (type) return { kind: "image", blob: await item.getType(type) };
      }
      for (const item of items) {
        if (item.types.includes("text/plain")) {
          return classifyText(await (await item.getType("text/plain")).text());
        }
      }
      if (items.some((i) => i.types.length)) {
        return { kind: "unsupported", detail: "The clipboard holds content that can't be pasted." };
      }
      return { kind: "empty" };
    }
    return classifyText(await clip.readText());
  } catch {
    return {
      kind: "unsupported",
      detail: "Clipboard access was blocked. Try Ctrl+V / ⌘V, or allow clipboard access.",
    };
  }
};

/** Writes text via the async clipboard API. Resolves false when not permitted. */
export const writeClipboardText = async (text: string): Promise<boolean> => {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });

export const imageSize = (dataURL: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("The image could not be decoded."));
    img.src = dataURL;
  });
