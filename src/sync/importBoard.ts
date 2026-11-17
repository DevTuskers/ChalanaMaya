/**
 * Bringing a whole board into a session (plan §4.1): the old browser board
 * and `.chalana` files go through the lenient parser, canonicalisation and a
 * picture upload, then land on the board as one local undo step and travel to
 * the server as one atomic `/import`.
 */
import { canonicalizeElements, summarizeReport } from "../shared/canonical";
import { isColor } from "../shared/limits";
import { PAPER } from "../scene/constants";
import { getCommonBounds } from "../scene/geometry";
import { cloneElements, finalizeScene } from "../scene/scene";
import type { ChalanaFile } from "../io/serialize";
import type { Store } from "../store/store";
import type { SyncClient } from "./client";
import { adoptFiles } from "./files";

export interface ImportOutcome {
  ok: boolean;
  count: number;
  /** Canonicalisation summary ("" when nothing was changed). */
  summary: string;
  failedPictures: number;
}

/**
 * `replace` makes the file the whole board (opening a .chalana file);
 * `add` places it beside what is already there, with fresh ids.
 */
export const importIntoSession = async (
  store: Store,
  sync: SyncClient,
  file: ChalanaFile,
  mode: "replace" | "add",
): Promise<ImportOutcome> => {
  const { elements: canonical, report } = canonicalizeElements(file.elements);
  const upload = store.uploadFile;
  const adopted = upload
    ? await adoptFiles(canonical, file.files, store.get().files, upload)
    : { elements: canonical, files: file.files, failed: 0 };
  const state = store.get();
  let incoming = adopted.elements;
  if (mode === "add") {
    const here = getCommonBounds(state.elements);
    const there = getCommonBounds(incoming);
    const dx = here && there ? here.maxX + 120 - there.minX : 0;
    const dy = here && there ? here.minY - there.minY : 0;
    incoming = cloneElements(incoming, dx, dy).clones;
  }
  const ids = new Set(incoming.map((e) => e.id));
  store.history.record(store.snapshot());
  const bg = file.settings.viewBackgroundColor.toLowerCase();
  const settings =
    mode === "replace"
      ? {
          viewBackgroundColor: isColor(bg) ? bg : PAPER.light,
          gridEnabled: file.settings.gridEnabled,
        }
      : undefined;
  store.set({
    files: { ...state.files, ...adopted.files },
    elements: finalizeScene(mode === "replace" ? incoming : [...state.elements, ...incoming]),
    selectedIds:
      mode === "add"
        ? new Set(incoming.filter((e) => !("containerId" in e && e.containerId)).map((e) => e.id))
        : new Set(),
    editingTextId: null,
    ...(settings ?? {}),
    historyVersion: state.historyVersion + 1,
  });
  const ok = sync.queueImport(mode, ids, settings);
  return {
    ok,
    count: incoming.length,
    summary: summarizeReport(report),
    failedPictures: adopted.failed,
  };
};
