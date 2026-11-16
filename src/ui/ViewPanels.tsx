import { useEffect, useMemo, useRef, useState } from "react";
import { getCommonBounds } from "../scene/geometry";
import { searchText } from "../scene/search";
import { fitBounds } from "../scene/viewport";
import { setTool } from "../store/actions";
import type { Store } from "../store/store";
import { useAppState, useServices } from "./context";
import { Icon } from "./icons";
import { formatKeys } from "./shortcuts";

const round = (v: number) => Math.round(v * 10) / 10;

/** Measurements: exact position and size of the selection, in board units. */
export const StatsPanel = () => {
  const { store } = useServices();
  const open = useAppState((s) => s.statsOpen);
  const elements = useAppState((s) => s.elements);
  const selectedIds = useAppState((s) => s.selectedIds);
  if (!open) return null;
  const selected = elements.filter((e) => selectedIds.has(e.id));
  const b = getCommonBounds(selected);
  const single = selected.length === 1 ? selected[0] : null;
  return (
    <section className="stats panel" aria-label="Measurements" data-testid="stats">
      <header className="stats-head">
        <h2>Measurements</h2>
        <button
          type="button"
          className="icon-btn small"
          aria-label="Close measurements"
          onClick={() => store.set({ statsOpen: false })}
        >
          <Icon.close />
        </button>
      </header>
      {b ? (
        <dl className="stats-grid">
          <dt>X</dt>
          <dd data-testid="stat-x">{round(single ? single.x : b.minX)}</dd>
          <dt>Y</dt>
          <dd data-testid="stat-y">{round(single ? single.y : b.minY)}</dd>
          <dt>Width</dt>
          <dd data-testid="stat-w">{round(single ? single.width : b.maxX - b.minX)}</dd>
          <dt>Height</dt>
          <dd data-testid="stat-h">{round(single ? single.height : b.maxY - b.minY)}</dd>
          {single?.angle ? (
            <>
              <dt>Angle</dt>
              <dd>{Math.round((single.angle * 180) / Math.PI)}°</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="stats-empty" data-testid="stats-empty">
          Nothing selected. Pick an item to see its position and size.
        </p>
      )}
      <p className="stats-foot">
        {elements.filter((e) => !(e.type === "text" && e.containerId)).length} items on the board
      </p>
    </section>
  );
};

const focusElement = (store: Store, id: string) => {
  const el = store.get().elements.find((e) => e.id === id);
  if (!el) return;
  const v = fitBounds(getCommonBounds([el]), store.viewSize.width, store.viewSize.height);
  const cur = store.get().viewport;
  if (v)
    store.set({
      viewport: { ...v, zoom: Math.min(Math.max(cur.zoom, 0.5), v.zoom, 1.5) },
      searchHighlight: id,
    });
  // re-centre at the clamped zoom
  const z = store.get().viewport.zoom;
  const b = getCommonBounds([el])!;
  store.set({
    viewport: {
      zoom: z,
      scrollX: store.viewSize.width / 2 / z - (b.minX + b.maxX) / 2,
      scrollY: store.viewSize.height / 2 / z - (b.minY + b.maxY) / 2,
    },
  });
};

/** Find text: highlights matches and steps through them. */
export const SearchBar = () => {
  const { store } = useServices();
  const open = useAppState((s) => s.searchOpen);
  const elements = useAppState((s) => s.elements);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchText(elements, query), [elements, query]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const m = matches[Math.min(index, matches.length - 1)];
    if (m) focusElement(store, m.targetId);
    else store.set({ searchHighlight: null });
  }, [open, matches, index, store]);

  if (!open) return null;
  const close = () => {
    store.set({ searchOpen: false, searchHighlight: null });
    input.current?.ownerDocument.querySelector<HTMLElement>("[data-testid=board]")?.focus();
  };
  const step = (d: number) =>
    matches.length && setIndex((i) => (i + d + matches.length) % matches.length);
  const current = matches.length ? Math.min(index, matches.length - 1) + 1 : 0;
  const status = !query.trim()
    ? "Type to find words, notes and labels."
    : matches.length
      ? `${current} of ${matches.length}`
      : "No matches on this board.";
  return (
    <section className="search panel" role="search" aria-label="Find text" data-testid="search">
      <Icon.search />
      <input
        ref={input}
        data-testid="search-input"
        aria-label="Find text"
        placeholder="Find text…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") close();
        }}
      />
      <span className="search-status" aria-live="polite" data-testid="search-status">
        {status}
      </span>
      <button
        type="button"
        className="text-btn"
        data-testid="search-prev"
        disabled={!matches.length}
        onClick={() => step(-1)}
      >
        Previous
      </button>
      <button
        type="button"
        className="text-btn"
        data-testid="search-next"
        disabled={!matches.length}
        onClick={() => step(1)}
      >
        Next
      </button>
      <button type="button" className="icon-btn small" aria-label="Close search" onClick={close}>
        <Icon.close />
      </button>
    </section>
  );
};

/** Banners for look-only mode, quiet desk and the colour picker. */
export const ModeBanners = () => {
  const { store } = useServices();
  const viewMode = useAppState((s) => s.viewMode);
  const zen = useAppState((s) => s.zenMode);
  const tool = useAppState((s) => s.tool);
  const target = useAppState((s) => s.eyedropperTarget);
  return (
    <div className="banners">
      {viewMode ? (
        <div className="banner panel" role="status" data-testid="view-mode-banner">
          <Icon.eye />
          <span>Look-only mode: pan, zoom and follow links. Editing is paused.</span>
          <button
            type="button"
            className="text-btn"
            data-testid="leave-view-mode"
            onClick={() => store.set({ viewMode: false })}
          >
            Leave ({formatKeys("Alt+R")})
          </button>
        </div>
      ) : null}
      {zen ? (
        <div className="banner panel" role="status" data-testid="zen-banner">
          <Icon.calm />
          <span>Quiet desk</span>
          <button
            type="button"
            className="text-btn"
            data-testid="leave-zen"
            onClick={() => store.set({ zenMode: false })}
          >
            Show panels ({formatKeys("Alt+Z")})
          </button>
        </div>
      ) : null}
      {tool === "eyedropper" ? (
        <div className="banner panel" role="status" data-testid="eyedropper-banner">
          <span>Click the board to pick a colour for</span>
          <div className="segmented" role="radiogroup" aria-label="Colour to set">
            {(
              [
                ["strokeColor", "Stroke"],
                ["backgroundColor", "Fill"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={target === k}
                data-testid={`eyedropper-${k}`}
                className={target === k ? "is-active" : ""}
                onClick={() => store.set({ eyedropperTarget: k })}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-btn"
            data-testid="eyedropper-cancel"
            onClick={() => setTool(store, store.get().toolBeforeEyedropper)}
          >
            Cancel (Esc)
          </button>
        </div>
      ) : null}
    </div>
  );
};
