import { useEffect, useRef } from "react";
import { resolveBoardColor } from "../scene/constants";
import { effectiveCrop, fullImageBox } from "../scene/crop";
import { applyStyle, setTool } from "../store/actions";
import { getImage } from "../render/renderScene";
import { renderOverlay } from "../render/renderOverlay";
import { drawSpotlight, pruneSpotlight } from "../render/spotlight";
import { renderScene, setImageLoadListener } from "../render/renderScene";
import {
  FramePacer,
  isPlaying,
  isRemote,
  mediaClip,
  screenRect,
  isVideoFile,
  needsFrames,
  pruneVideos,
  setLiveListener,
  setMediaListener,
  setMediaNoticeListener,
  videoCount,
  videoState,
} from "../render/media";
import type { PointerInput } from "../tools/controller";
import { getElementBounds } from "../scene/geometry";
import type { SceneElement, Viewport } from "../scene/types";
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
    pressure: "pressure" in e ? e.pressure : undefined,
  };
};

/** Whether an item reaches into the visible board. */
const inView = (v: Viewport, width: number, height: number) => (el: SceneElement) => {
  const b = getElementBounds(el);
  return (
    (b.maxX + v.scrollX) * v.zoom > 0 &&
    (b.maxY + v.scrollY) * v.zoom > 0 &&
    (b.minX + v.scrollX) * v.zoom < width &&
    (b.minY + v.scrollY) * v.zoom < height
  );
};

/** Boards this big draw drags over a still layer. */
const BIG_BOARD = 500;

/** The board: renders artwork plus editor overlay and forwards pointer input. */
export const Canvas = () => {
  const { store, controller } = useServices();
  const ref = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const doc = canvas.ownerDocument;
    const win = doc.defaultView!;
    const ctx = canvas.getContext("2d")!;
    // selection frames, handles and the laser sit on a canvas above the live
    // layer, so selected live media still shows its frame (plan §6.3)
    const top = topRef.current!;
    const topCtx = top.getContext("2d")!;
    const perf = new URLSearchParams(win.location.search).get("perf");
    // read-only hooks for the browser tests (like __chalanaSync)
    (win as unknown as { __chalanaMedia?: unknown }).__chalanaMedia = {
      view: () => store.get().viewport,
      video: videoState,
      loop: () => pacer.stats(),
      videos: videoCount,
    };
    let frame = 0;

    const pacer = new FramePacer();
    let mediaTimer = 0;
    /** only playing media changed since the last frame: repaint just those items */
    let mediaOnly = false;
    let lastClip: ReturnType<typeof mediaClip> = null;
    /** what the board canvas shows now, to skip redraws that change nothing */
    let shown: {
      key: string;
      elements: readonly SceneElement[];
      files: unknown;
      skip: string | null;
      fade: unknown;
    } | null = null;
    /** a video or GIF has a new frame to show (loaded, seeked, decoded) */
    let mediaDirty = false;
    const mediaChanged = () => {
      mediaDirty = true;
      if (!frame) frame = win.requestAnimationFrame(draw);
    };
    /** something outside the store changed what the board shows (a picture loaded, a resize) */
    let dirty = true;
    const repaint = () => {
      dirty = true;
      still = null;
      schedule();
    };
    let still: { canvas: HTMLCanvasElement; key: string; refs: Set<SceneElement> } | null = null;
    const draw = () => {
      frame = 0;
      const partial = mediaOnly;
      mediaOnly = false;
      const mediaPaint = mediaDirty;
      mediaDirty = false;
      const started = win.performance.now();
      const s = store.get();
      const { width, height } = store.viewSize;
      const dpr = win.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const skip = s.editingTextId ? new Set([s.editingTextId]) : undefined;
      const sceneOpts = {
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
      };
      // Big boards during a drag: the items that are not changing are drawn
      // once into a still layer, and each frame only paints the moving items
      // (and playing media) on top of it, so a drag stays smooth (MEDIA-08).
      const key = `${s.viewport.zoom}|${s.viewport.scrollX}|${s.viewport.scrollY}|${s.theme}|${width}x${height}|${dpr}|${s.gridEnabled}|${s.viewBackgroundColor}`;
      const busy = s.elements.length >= BIG_BOARD && controller.isBusy();
      let settled = false;
      if (!busy && still) {
        // The drag is over: draw in true layer order again, repainting only
        // where the moved items are now (the still layer has the rest).
        const left = still.key === key ? s.elements.filter((e) => !still!.refs.has(e)) : null;
        if (left && left.length <= 300 && !dirty) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(still.canvas, 0, 0);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          if (left.length)
            renderScene(ctx, {
              ...sceneOpts,
              clip: left.map((e) => screenRect(e, s.viewport)),
            });
          settled = true;
        } else dirty = true;
        still = null;
      }
      let moving: SceneElement[] | null = null;
      if (busy && still && still.key === key) {
        moving = s.elements.filter((e) => !still!.refs.has(e));
        if (moving.length > 300) moving = null;
      }
      if (busy && !moving) {
        // (re)build the still layer: everything except the selection and playing media
        const off = still?.canvas ?? doc.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const octx = off.getContext("2d")!;
        const keep = s.elements.filter(
          (e) =>
            !s.selectedIds.has(e.id) &&
            !(
              e.type === "image" &&
              isPlaying(e, s.files[e.fileId]) &&
              !isRemote(s.files[e.fileId])
            ),
        );
        const keepRefs = new Set(keep);
        // Start from the frame on screen and repaint only where it differs
        // from the still layer, so starting a drag costs no full redraw.
        const prev = shown && shown.key === key && !dirty ? shown.elements : null;
        let rects: ReturnType<typeof screenRect>[] | null = null;
        if (prev) {
          const prevRefs = new Set(prev);
          const out = prev.filter((e) => !keepRefs.has(e));
          const fresh = keep.filter((e) => !prevRefs.has(e));
          if (out.length + fresh.length <= 300)
            rects = [...out, ...fresh].map((e) => screenRect(e, s.viewport));
        }
        octx.setTransform(1, 0, 0, 1, 0, 0);
        if (rects) {
          octx.clearRect(0, 0, off.width, off.height);
          octx.drawImage(canvas, 0, 0);
        }
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!rects || rects.length)
          renderScene(octx, { ...sceneOpts, elements: keep, clip: rects });
        still = { canvas: off, key, refs: keepRefs };
        moving = s.elements.filter((e) => !keepRefs.has(e));
      }
      if (busy && still && moving) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(still.canvas, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderScene(ctx, {
          ...sceneOpts,
          elements: moving,
          background: null,
          grid: null,
          keep: true,
        });
      } else if (
        !settled &&
        (dirty ||
          !shown ||
          shown.key !== key ||
          shown.elements !== s.elements ||
          shown.files !== s.files ||
          shown.skip !== s.editingTextId ||
          shown.fade !== s.pendingErase)
      )
        renderScene(ctx, sceneOpts);
      else if (!settled && (partial || mediaPaint)) {
        // only media changed: repaint just where it is
        const clip = mediaPaint
          ? mediaClip(s.elements, s.files, inView(s.viewport, width, height), s.viewport, true)
          : lastClip;
        if (clip) renderScene(ctx, { ...sceneOpts, clip });
      }
      dirty = false;
      shown = {
        key,
        elements: s.elements,
        files: s.files,
        skip: s.editingTextId,
        fade: s.pendingErase,
      };
      if (perf === "slow" && pacer.animating) {
        const until = win.performance.now() + 30;
        while (win.performance.now() < until) {
          /* injected frame cost for the performance test */
        }
      }
      const frameCost = win.performance.now() - started;
      topCtx.setTransform(1, 0, 0, 1, 0, 0);
      topCtx.clearRect(0, 0, top.width, top.height);
      topCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const selected = s.elements.filter((e) => s.selectedIds.has(e.id));
      const o = controller.overlay;
      renderOverlay(topCtx, {
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
      if (s.spotlight.length) {
        const now = controller.now();
        drawSpotlight(topCtx, s.spotlight, s.viewport, s.theme, now);
        const next = pruneSpotlight(s.spotlight, now, undefined, controller.isBusy());
        if (next !== s.spotlight) store.set({ spotlight: next });
        if (next.length) schedule();
      }
      canvas.style.cursor = controller.cursor;
      // MEDIA-08: keep drawing only while a playing GIF or video is on screen,
      // at a rate the board can afford
      const v = s.viewport;
      const visible = inView(v, width, height);
      pruneVideos(s.elements, visible, win.performance.now());
      const animating = needsFrames(s.elements, s.files, visible);
      lastClip = animating ? mediaClip(s.elements, s.files, visible, v) : null;
      const was = pacer.paused;
      pacer.record(animating ? frameCost : null, win.performance.now());
      if (pacer.paused && !was)
        store.toast("Moving media paused to keep the board responsive.", "info", 6000, {
          label: "Play",
          run: () => {
            pacer.resume();
            schedule();
          },
        });
      if (animating && !pacer.paused && !mediaTimer) {
        mediaTimer = win.setTimeout(
          () => {
            mediaTimer = 0;
            if (!frame) {
              mediaOnly = true;
              frame = win.requestAnimationFrame(draw);
            }
          },
          Math.max(0, 1000 / pacer.fps - 4),
        );
      }
    };
    const schedule = () => {
      mediaOnly = false;
      if (!frame) frame = win.requestAnimationFrame(draw);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = win.devicePixelRatio || 1;
      store.viewSize = { width: r.width, height: r.height };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      top.width = canvas.width;
      top.height = canvas.height;
      dirty = true;
      still = null;
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
      const f = store.get().files[el.fileId];
      if (f?.width && f.height && (isVideoFile(f) || isRemote(f)))
        return { width: f.width, height: f.height };
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
      const s = store.get();
      const at = [Math.floor(pt.x * dpr), Math.floor(pt.y * dpr)] as const;
      let pixel: Uint8ClampedArray;
      try {
        pixel = ctx.getImageData(at[0], at[1], 1, 1).data;
      } catch (e) {
        // MEDIA-05: a tainted canvas refuses to be read. Sample the board drawn
        // without media instead, so the tool still works.
        if (!(e instanceof DOMException && e.name === "SecurityError")) throw e;
        const off = doc.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const octx = off.getContext("2d")!;
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderScene(octx, {
          elements: s.elements.filter((el) => el.type !== "image"),
          files: {},
          viewport: s.viewport,
          theme: s.theme,
          background: resolveBoardColor(s.viewBackgroundColor, s.theme),
          grid: null,
          width: store.viewSize.width,
          height: store.viewSize.height,
        });
        pixel = octx.getImageData(at[0], at[1], 1, 1).data;
        store.toast("Can't pick a colour from this media; used the board under it.", "info");
      }
      const [r, g, b, a] = pixel;
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
    setImageLoadListener(repaint);
    setMediaListener(mediaChanged);
    setLiveListener(repaint);
    setMediaNoticeListener((text) => store.toast(text, "info", 6000));
    // MEDIA-09: following the system "reduce motion" setting without a reload
    const motion = win.matchMedia?.("(prefers-reduced-motion: reduce)");
    motion?.addEventListener?.("change", repaint);
    doc.fonts?.addEventListener?.("loadingdone", repaint);

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
      if (mediaTimer) win.clearTimeout(mediaTimer);
      doc.fonts?.removeEventListener?.("loadingdone", repaint);
      motion?.removeEventListener?.("change", repaint);
      setMediaNoticeListener(() => {});
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
    <>
      <canvas
        ref={ref}
        className="board"
        data-testid="board"
        tabIndex={0}
        aria-label="Drawing board. Use the tool rail or keyboard shortcuts to draw; press ? for help."
      />
      <canvas ref={topRef} className="board-top" data-testid="board-top" aria-hidden="true" />
    </>
  );
};
