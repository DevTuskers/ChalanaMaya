import { useEffect, useSyncExternalStore } from "react";
import DOMPurify from "dompurify";
import { buildComponentDoc } from "../media/componentDoc";
import type { ComponentElement } from "../scene/types";
import {
  isMuted,
  isComponentPaused,
  playAnywayRevision,
  subscribePlayAnyway,
  reducedMotion,
  isPlaying,
  isVideoFile,
  liveMediaItems,
  markLiveLoaded,
  mediaKind,
  setLiveShown,
} from "../render/media";
import { useAppState, useServices } from "./context";

/**
 * Remote media links (MEDIA-05), shown by the browser in HTML over the board
 * so they work without CORS. The server never fetches them; pictures are
 * loaded with no referrer, and videos (HTML gives <video> no referrerpolicy)
 * with the page's strict-origin-when-cross-origin, which sends the origin but
 * never the /s/<id> path. They ignore the pointer (the board handles selection and
 * moves), and are left out of exports, which draw a placeholder card instead.
 */
const docs = new WeakMap<ComponentElement["source"], Map<boolean, string>>();
/** The srcdoc for a component, cached per source so the frame is not rebuilt on every paint. */
const componentDoc = (el: ComponentElement, paused: boolean) => {
  let m = docs.get(el.source);
  if (!m) docs.set(el.source, (m = new Map()));
  let d = m.get(paused);
  if (d === undefined) m.set(paused, (d = buildComponentDoc(DOMPurify, el.source, paused)));
  return d;
};

const subscribeMotion = (fn: () => void) => {
  if (typeof matchMedia !== "function") return () => {};
  const q = matchMedia("(prefers-reduced-motion: reduce)");
  q.addEventListener("change", fn);
  return () => q.removeEventListener("change", fn);
};

export const LiveMedia = () => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const files = useAppState((s) => s.files);
  const viewport = useAppState((s) => s.viewport);
  const selected = useAppState((s) => s.selectedIds);
  useSyncExternalStore(subscribeMotion, reducedMotion, () => false);
  useSyncExternalStore(subscribePlayAnyway, playAnywayRevision, () => 0);
  const items = liveMediaItems(elements, files, viewport, store.viewSize, selected);
  const shownKey = items.map((el) => el.id).join(",");
  useEffect(() => {
    setLiveShown(shownKey ? shownKey.split(",") : []);
  }, [shownKey]);
  useEffect(() => () => setLiveShown([]), []);
  if (!items.length) return null;
  return (
    <div className="livemedia" aria-hidden="true">
      {items.map((el) => {
        const sx = (el.x + viewport.scrollX) * viewport.zoom;
        const sy = (el.y + viewport.scrollY) * viewport.zoom;
        if (el.type === "component") {
          const transform =
            `translate(${sx}px, ${sy}px) scale(${viewport.zoom}) ` +
            `translate(${el.width / 2}px, ${el.height / 2}px) rotate(${el.angle}rad) ` +
            `translate(${-el.width / 2}px, ${-el.height / 2}px)`;
          const paused = isComponentPaused(el);
          return (
            <iframe
              key={el.id}
              data-testid="live-component"
              data-id={el.id}
              data-paused={paused ? "true" : "false"}
              className="livemedia-item livemedia-component"
              title={el.title || "Animated component"}
              sandbox=""
              referrerPolicy="no-referrer"
              tabIndex={-1}
              srcDoc={componentDoc(el, paused)}
              style={{ width: el.width, height: el.height, transform, opacity: el.opacity / 100 }}
            />
          );
        }
        const f = files[el.fileId]!;
        const flip = `scale(${el.flipX ? -1 : 1}, ${el.flipY ? -1 : 1})`;
        const transform =
          `translate(${sx}px, ${sy}px) scale(${viewport.zoom}) ` +
          `translate(${el.width / 2}px, ${el.height / 2}px) rotate(${el.angle}rad) ${flip} ` +
          `translate(${-el.width / 2}px, ${-el.height / 2}px)`;
        const style = { width: el.width, height: el.height, transform, opacity: el.opacity / 100 };
        const common = {
          "data-testid": "live-media",
          "data-id": el.id,
          "data-kind": mediaKind(f),
          className: "livemedia-item",
          style,
          referrerPolicy: "no-referrer" as const,
        };
        if (isVideoFile(f)) {
          const playing = isPlaying(el, f);
          return (
            <video
              key={el.id}
              {...common}
              src={f.dataURL}
              muted={isMuted(el.id)}
              loop={el.loop !== false}
              playsInline
              preload="metadata"
              autoPlay={playing}
              onLoadedData={() => markLiveLoaded(el.id, f.dataURL)}
              ref={(v) => {
                if (!v) return;
                v.muted = isMuted(el.id);
                if (playing && v.paused) void v.play().catch(() => {});
                else if (!playing && !v.paused) v.pause();
              }}
            />
          );
        }
        return (
          <img
            key={el.id}
            {...common}
            src={f.dataURL}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={() => markLiveLoaded(el.id, f.dataURL)}
          />
        );
      })}
    </div>
  );
};
