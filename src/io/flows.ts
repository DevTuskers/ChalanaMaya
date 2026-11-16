import { resolveBoardColor } from "../scene/constants";
import type { FileMap, SceneElement, Theme } from "../scene/types";
import { embedInPng, svgMetadata } from "./embed";
import { canvasToBlob, exportToCanvas } from "./export";
import { serializeBoard, type BoardSettings } from "./serialize";
import { elementsToPlainText, exportToSvg } from "./svg";
import kalam400 from "@fontsource/kalam/files/kalam-latin-400-normal.woff2?url";
import sans400 from "@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2?url";
import mono400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url";

export interface ImageExportRequest {
  elements: readonly SceneElement[];
  files: FileMap;
  /** Export theme, independent of the interface theme. */
  theme: Theme;
  background: boolean;
  /** Board colour id (light value). */
  boardColor: string;
  scale: number;
  embedScene: boolean;
  settings: BoardSettings;
}

const sceneJson = (r: ImageExportRequest) =>
  serializeBoard(r.elements, r.files, { ...r.settings, theme: r.theme });

export const exportPngBlob = async (r: ImageExportRequest): Promise<Blob> => {
  const canvas = await exportToCanvas(r.elements, r.files, {
    background: r.background,
    scale: r.scale,
    theme: r.theme,
    backgroundColor: resolveBoardColor(r.boardColor, r.theme),
  });
  const blob = await canvasToBlob(canvas);
  if (!r.embedScene) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const embedded = embedInPng(bytes, sceneJson(r));
  return new Blob([embedded.slice().buffer], { type: "image/png" });
};

let fontCssCache: Promise<string> | null = null;
const toDataUrl = async (url: string) => {
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:font/woff2;base64,${btoa(bin)}`;
};

/** @font-face rules for the brand fonts, so SVG text looks right elsewhere. */
export const brandFontCss = () => {
  fontCssCache ??= Promise.all(
    [
      ["Kalam", kalam400],
      ["Source Sans 3", sans400],
      ["IBM Plex Mono", mono400],
    ].map(async ([family, url]) => {
      try {
        return `@font-face{font-family:"${family}";src:url(${await toDataUrl(url)}) format("woff2");}`;
      } catch {
        return "";
      }
    }),
  ).then((rules) => rules.join(""));
  return fontCssCache;
};

export const exportSvgText = async (r: ImageExportRequest): Promise<string> => {
  const usesText = r.elements.some((e) => e.type === "text" || e.type === "frame");
  return exportToSvg(r.elements, r.files, {
    theme: r.theme,
    background: r.background ? resolveBoardColor(r.boardColor, r.theme) : null,
    metadata: r.embedScene ? svgMetadata(sceneJson(r)) : undefined,
    fontCss: usesText ? await brandFontCss() : undefined,
  });
};

export type CopyKind = "png" | "svg" | "text";

export type CopyResult = { ok: true } | { ok: false; message: string };

/** Copies a PNG, SVG markup or plain text to the system clipboard. */
export const copyAs = async (
  kind: CopyKind,
  r: ImageExportRequest,
  clipboard: Clipboard | undefined,
): Promise<CopyResult> => {
  if (!r.elements.length) return { ok: false, message: "There is nothing to copy yet." };
  if (kind === "text") {
    const text = elementsToPlainText(r.elements);
    if (!text) return { ok: false, message: "There is no text to copy in these items." };
    try {
      if (!clipboard) throw new Error("no clipboard");
      await clipboard.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false, message: "The browser blocked the clipboard. Nothing was copied." };
    }
  }
  try {
    if (!clipboard) throw new Error("no clipboard");
    if (kind === "svg") {
      await clipboard.writeText(await exportSvgText({ ...r, embedScene: false }));
    } else {
      if (typeof ClipboardItem === "undefined" || !clipboard.write) throw new Error("no image clipboard");
      const blob = exportPngBlob({ ...r, embedScene: false });
      await clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: `The browser blocked copying the ${kind.toUpperCase()}. Use Export ${kind.toUpperCase()} to save a file instead.`,
    };
  }
};
