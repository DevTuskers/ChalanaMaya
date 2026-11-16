import { useEffect, useRef } from "react";
import { resolveBoardColor } from "../scene/constants";
import { effectiveCrop, fullImageBox } from "../scene/crop";
import { applyStyle, setTool } from "../store/actions";
import { getImage } from "../render/renderScene";
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
    pointerType: "pointerType" in e ? e.pointerType : "mouse",
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
        background: resolveBoardColor(s.viewBackgroundColor, s.theme),
        grid: s.gridEnabled
          ? s.theme === "dark"
            ? "rgba(237,248,243,0.09)"
            : "rgba(25,58,54,0.08)"
          : null,
        width,
        height,
        skipIds: skip,
        fadeIds: s.pendingErase,
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
        trail: s.trail,
        snapLines: s.snapLines,
        highlight: s.searchHighlight
          ? (s.elements.find((e) => e.id === s.searchHighlight) ?? null)
          : null,
        pointEditing: s.editingPointsId
          ? (s.elements.find((e) => e.id === s.editingPointsId) ?? null)
          : null,
        cropping: (() => {
          const el = s.croppingId ? s.elements.find((e) => e.id === s.croppingId) : undefined;
          if (el?.type !== "image") return null;
          const nat = controller.naturalSize(el);
          return nat ? { el, full: fullImageBox(el, effectiveCrop(el, nat)) } : null;
        })(),
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
    controller.naturalSize = (el) => {
      if (el.type !== "image") return null;
      if (el.crop) return { width: el.crop.naturalWidth, height: el.crop.naturalHeight };
      const img = getImage(el.fileId, store.get().files);
      return img && img.naturalWidth
        ? { width: img.naturalWidth, height: img.naturalHeight }
        : null;
    };
    controller.onLink = (el) => {
      if (el.link) store.set({ dialog: { kind: "openLink", url: el.link } });
    };
    controller.onSample = (pt) => {
      draw();
      const dpr = win.devicePixelRatio || 1;
      const [r, g, b, a] = ctx.getImageData(
        Math.floor(pt.x * dpr),
        Math.floor(pt.y * dpr),
        1,
        1,
      ).data;
      const s = store.get();
      const hex =
        a === 0
          ? resolveBoardColor(s.viewBackgroundColor, s.theme)
          : `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      applyStyle(store, { [s.eyedropperTarget]: hex });
      store.toast(
        `Picked ${hex} for the ${s.eyedropperTarget === "strokeColor" ? "stroke" : "fill"}.`,
        "success",
        1800,
      );
      setTool(store, s.toolBeforeEyedropper === "eyedropper" ? "pick" : s.toolBeforeEyedropper);
      if (s.toolBeforeEyedropper === "pick") store.set({ selectedIds: s.selectedIds });
    };
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
    const onCancel = (e: PointerEvent) => {
      // the browser took the pointer away (e.g. a system gesture): undo the drag
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (controller.isBusy() && !controller.isDrawingPath) controller.cancel();
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
    canvas.addEventListener("pointercancel", onCancel);
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
      canvas.removeEventListener("pointercancel", onCancel);
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
