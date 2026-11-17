import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getElementBounds } from "../scene/geometry";
import type { EmbedElement, Viewport } from "../scene/types";
import { resolveWebCard, WEB_CARD_HEADER, WEB_CARD_SANDBOX } from "../scene/webcard";
import { useAppState, useServices } from "./context";

const onScreen = (el: EmbedElement, v: Viewport, size: { width: number; height: number }) => {
  const b = getElementBounds(el);
  const minX = (b.minX + v.scrollX) * v.zoom;
  const minY = (b.minY + v.scrollY) * v.zoom;
  const maxX = (b.maxX + v.scrollX) * v.zoom;
  const maxY = (b.maxY + v.scrollY) * v.zoom;
  return maxX > 0 && maxY > 0 && minX < size.width && minY < size.height;
};

/**
 * Live content of web cards, laid over the board. The page frames are sandboxed and
 * ignore the pointer until a card is double-clicked (or selected and Enter pressed),
 * so they can't change the board. The layer sits above the board canvas, so a live
 * card always shows on top of drawn items, selection handles and Spotlight trails.
 */
export const WebCards = () => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const viewport = useAppState((s) => s.viewport);
  const active = useAppState((s) => s.activeEmbedId);
  const editing = useAppState((s) => s.editingTextId);
  const viewSize = useSyncExternalStore(store.subscribeViewSize, store.getViewSize);
  const cards = elements.filter(
    (e): e is EmbedElement => e.type === "embed" && onScreen(e, viewport, viewSize),
  );
  const layerRef = useRef<HTMLDivElement>(null);
  const [trapped, setTrapped] = useState(false);
  // DRAW-14: focus the card wrapper, never the cross-origin page, so Esc still
  // reaches the board's key handler. Leaving the card hands focus back.
  useEffect(() => {
    if (!active) return;
    const layer = layerRef.current;
    const card = layer?.querySelector<HTMLElement>(`[data-id="${CSS.escape(active)}"]`);
    card?.focus({ preventScroll: true });
    // a click inside the page moves focus into it, where Esc can't be heard
    const onBlur = () => {
      // activeElement settles on the frame just after the blur/focusout event
      setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) setTrapped(true);
      }, 0);
    };
    layer?.addEventListener("focusout", onBlur);
    const onFocus = () => setTrapped(false);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      layer?.removeEventListener("focusout", onBlur);
      window.removeEventListener("focus", onFocus);
      setTrapped(false);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && layer?.contains(focused)) focused.blur();
    };
  }, [active]);
  // Done sits before the hint text so it doesn't shift when the text changes
  const done = () => {
    store.set({ activeEmbedId: null });
  };
  if (!cards.length) return null;
  return (
    <div className="webcards" ref={layerRef} aria-hidden={editing ? true : undefined}>
      {cards.map((el) => {
        const res = resolveWebCard(el.url);
        if (!res.ok) return null;
        const bodyH = el.height - WEB_CARD_HEADER;
        if (bodyH < 40 || el.width < 60) return null;
        const sx = (el.x + viewport.scrollX) * viewport.zoom;
        const sy = (el.y + viewport.scrollY) * viewport.zoom;
        const transform =
          `translate(${sx}px, ${sy}px) scale(${viewport.zoom}) ` +
          `translate(${el.width / 2}px, ${el.height / 2}px) rotate(${el.angle}rad) ` +
          `translate(${-el.width / 2}px, ${-el.height / 2}px)`;
        const isActive = active === el.id;
        return (
          <div
            key={el.id}
            className={`webcard${isActive ? " is-active" : ""}`}
            data-testid="webcard"
            data-id={el.id}
            data-kind={res.target.kind}
            tabIndex={-1}
            style={{ width: el.width, height: el.height, transform, opacity: el.opacity / 100 }}
          >
            <div className="webcard-body" style={{ top: WEB_CARD_HEADER, height: bodyH }}>
              {res.target.kind === "embed" ? (
                <iframe
                  title={`${res.target.provider} web card`}
                  src={res.target.src}
                  sandbox={WEB_CARD_SANDBOX}
                  referrerPolicy="strict-origin-when-cross-origin"
                  loading="lazy"
                  allow="fullscreen; picture-in-picture; encrypted-media"
                  data-testid="webcard-frame"
                  tabIndex={isActive ? 0 : -1}
                  style={{ pointerEvents: isActive ? "auto" : "none" }}
                />
              ) : (
                <div className="webcard-blocked" data-testid="webcard-blocked">
                  <p>{res.target.reason}</p>
                  <a
                    href={res.target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn"
                    data-testid="webcard-open"
                  >
                    Open {res.target.host}
                  </a>
                </div>
              )}
            </div>
            {isActive ? (
              <p className="webcard-hint" data-testid="webcard-active">
                <button
                  type="button"
                  className="btn webcard-done"
                  data-testid="webcard-done"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={done}
                >
                  Done
                </button>
                <span data-testid="webcard-hint-text">
                  {trapped
                    ? "Click Done or the board to return"
                    : "Using the page · press Esc or click Done to return"}
                </span>
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
