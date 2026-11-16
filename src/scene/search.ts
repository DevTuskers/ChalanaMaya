import type { SceneElement, TextElement } from "./types";

export interface SearchMatch {
  /** The text element containing the match. */
  textId: string;
  /** Item to highlight and focus: the container for labels and notes. */
  targetId: string;
  /** Short snippet around the match. */
  snippet: string;
}

/** Case-insensitive search across words, notes, labels and frame names, in reading order. */
export const searchText = (elements: readonly SceneElement[], query: string): SearchMatch[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const hits: { el: SceneElement; m: SearchMatch }[] = [];
  for (const el of elements) {
    const text = el.type === "text" ? el.text : el.type === "frame" ? el.name : null;
    if (text === null) continue;
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const start = Math.max(0, at - 16);
    const snippet =
      (start > 0 ? "…" : "") +
      text.slice(start, at + q.length + 16).replace(/\s+/g, " ") +
      (at + q.length + 16 < text.length ? "…" : "");
    const container = el.type === "text" ? (el as TextElement).containerId : null;
    const target = (container && byId.get(container)) || el;
    hits.push({ el: target, m: { textId: el.id, targetId: target.id, snippet } });
  }
  hits.sort((a, b) => a.el.y - b.el.y || a.el.x - b.el.x);
  return hits.map((h) => h.m);
};
