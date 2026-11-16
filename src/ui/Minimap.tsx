import { useEffect, useRef } from "react";
import { resolveBoardColor } from "../scene/constants";
import { getCommonBounds } from "../scene/geometry";
import {
  centerViewportOn,
  minimapLayout,
  minimapToBoard,
  type MinimapLayout,
} from "../render/minimap";
import { renderScene } from "../render/renderScene";
import { useAppState, useServices } from "./context";

const W = 220;
const H = 150;

/** Board overview (VIEW-05): artwork plus the visible area; click or drag to move the view. */
export const Minimap = () => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const viewport = useAppState((s) => s.viewport);
  const theme = useAppState((s) => s.theme);
  const files = useAppState((s) => s.files);
  const background = useAppState((s) => s.viewBackgroundColor);
  const ref = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<MinimapLayout | null>(null);
  const dragRef = useRef<MinimapLayout | null>(null);
  const empty = elements.length === 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const win = canvas.ownerDocument.defaultView;
    const dpr = win?.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const layout =
      dragRef.current ??
      minimapLayout(getCommonBounds(elements), viewport, store.viewSize, { width: W, height: H });
    layoutRef.current = layout;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderScene(ctx, {
      elements,
      files,
      viewport: layout.viewport,
      theme,
      background: resolveBoardColor(background, theme),
      width: W,
      height: H,
    });
    // current view (recomputed from the frozen layout while dragging)
    const k = layout.scale;
    const vx = (-viewport.scrollX - layout.world.minX) * k;
    const vy = (-viewport.scrollY - layout.world.minY) * k;
    const vw = (store.viewSize.width / viewport.zoom) * k;
    const vh = (store.viewSize.height / viewport.zoom) * k;
    ctx.save();
    ctx.fillStyle = theme === "dark" ? "rgba(90,214,200,0.14)" : "rgba(0,127,120,0.10)";
    ctx.strokeStyle = theme === "dark" ? "#5ad6c8" : "#007f78";
    ctx.lineWidth = 1.5;
    ctx.fillRect(vx, vy, vw, vh);
    ctx.strokeRect(vx + 0.75, vy + 0.75, Math.max(2, vw - 1.5), Math.max(2, vh - 1.5));
    ctx.restore();
  }, [elements, viewport, theme, files, background, store]);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const layout = dragRef.current ?? layoutRef.current;
    if (!layout || empty) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = minimapToBoard(layout, { x: e.clientX - r.left, y: e.clientY - r.top });
    store.set({ viewport: centerViewportOn(store.get().viewport, p, store.viewSize) });
  };

  return (
    <div className="minimap panel" data-testid="minimap" aria-label="Board overview">
      <canvas
        ref={ref}
        style={{ width: W, height: H }}
        data-testid="minimap-canvas"
        role="img"
        aria-label={
          empty
            ? "Board overview: the board is empty"
            : "Board overview. Click or drag to move the view."
        }
        onPointerDown={(e) => {
          if (empty) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = layoutRef.current;
          jump(e);
        }}
        onPointerMove={(e) => {
          if (dragRef.current) jump(e);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          dragRef.current = null;
          store.set({ viewport: { ...store.get().viewport } });
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />
      {empty ? (
        <p className="minimap-empty" data-testid="minimap-empty">
          Nothing drawn yet — the overview fills in as you draw.
        </p>
      ) : null}
    </div>
  );
};
