import { useEffect, useRef } from "react";
import { PAPER } from "../scene/constants";
import { renderOverlay } from "../render/renderOverlay";
import { renderScene, setImageLoadListener } from "../render/renderScene";
import type { PointerInput } from "../tools/controller";
import { useServices } from "./context";

const toInput = (e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): PointerInput => {
  const r = canvas.getBoundingClientRect();
  return {
    x: e.clientX - r.left,
    y: e.clientY - r.top,
    button: e.button,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
  };
};

/** The board: renders artwork plus editor overlay and forwards pointer input. */
export const Canvas = () => {
  const { store, controller } = useServices();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const doc = canvas.ownerDocument;
    const win = doc.defaultView!;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;

    const draw = () => {
      frame = 0;
      const s = store.get();
      const { width, height } = store.viewSize;
      const dpr = win.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const skip = s.editingTextId ? new Set([s.editingTextId]) : undefined;
      renderScene(ctx, {
        elements: s.elements,
        files: s.files,
        viewport: s.viewport,
        theme: s.theme,
        background: PAPER[s.theme],
        width,
        height,
        skipIds: skip,
      });
      const selected = s.elements.filter((e) => s.selectedIds.has(e.id));
      const o = controller.overlay;
      renderOverlay(ctx, {
        selected: s.editingTextId ? [] : selected,
        viewport: s.viewport,
        theme: s.theme,
        selectionBox: o.selectionBox,
        bindingTarget: o.bindingTargetId
          ? (s.elements.find((e) => e.id === o.bindingTargetId) ?? null)
          : null,
        pathStart: o.pathStart,
        width,
        height,
      });
      canvas.style.cursor = controller.cursor;
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(draw);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = win.devicePixelRatio || 1;
      store.viewSize = { width: r.width, height: r.height };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const unsub = store.subscribe(schedule);
    controller.onOverlay = schedule;
    setImageLoadListener(schedule);
    doc.fonts?.addEventListener?.("loadingdone", schedule);

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      canvas.focus({ preventScroll: true });
      controller.pointerDown(toInput(e, canvas));
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      const input = toInput(e, canvas);
      store.lastPointer = { x: input.x, y: input.y };
      controller.pointerMove(input);
    };
    const onUp = (e: PointerEvent) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      controller.pointerUp(toInput(e, canvas));
    };
    const onLeave = () => {
      store.lastPointer = null;
    };
    const onDbl = (e: MouseEvent) => controller.doubleClick(toInput(e, canvas));
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const scale = e.deltaMode === 1 ? 16 : 1;
      controller.wheel({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        deltaX: e.deltaX * scale,
        deltaY: e.deltaY * scale,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      });
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      unsub();
      ro.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      doc.fonts?.removeEventListener?.("loadingdone", schedule);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
    };
  }, [store, controller]);

  return (
    <canvas
      ref={ref}
      className="board"
      data-testid="board"
      tabIndex={0}
      aria-label="Drawing board. Use the tool rail or keyboard shortcuts to draw; press ? for help."
    />
  );
};
