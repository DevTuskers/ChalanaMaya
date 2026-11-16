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
 * ignore the pointer until a card is double-clicked, so they can't change the board.
 */
export const WebCards = () => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const viewport = useAppState((s) => s.viewport);
  const active = useAppState((s) => s.activeEmbedId);
  const editing = useAppState((s) => s.editingTextId);
  const cards = elements.filter(
    (e): e is EmbedElement => e.type === "embed" && onScreen(e, viewport, store.viewSize),
  );
  if (!cards.length) return null;
  return (
    <div className="webcards" aria-hidden={editing ? true : undefined}>
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
            data-kind={res.target.kind}
            style={{ width: el.width, height: el.height, transform, opacity: el.opacity / 100 }}
          >
            <div className="webcard-body" style={{ top: WEB_CARD_HEADER, height: bodyH }}>
              {res.target.kind === "embed" ? (
                <iframe
                  title={`${res.target.provider} web card`}
                  src={res.target.src}
                  sandbox={WEB_CARD_SANDBOX}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  allow="fullscreen; picture-in-picture; encrypted-media"
                  data-testid="webcard-frame"
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
                Using the page · click the board to return
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
