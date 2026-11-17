import { isMuted, isPlaying, isVideoFile, liveMediaItems, mediaKind } from "../render/media";
import { useAppState, useServices } from "./context";

/**
 * Remote media links (MEDIA-05), shown by the browser in HTML over the board
 * so they work without CORS. The server never fetches them; they are loaded
 * with no referrer, ignore the pointer (the board handles selection and
 * moves), and are left out of exports, which draw a placeholder card instead.
 */
export const LiveMedia = () => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const files = useAppState((s) => s.files);
  const viewport = useAppState((s) => s.viewport);
  const selected = useAppState((s) => s.selectedIds);
  const items = liveMediaItems(elements, files, viewport, store.viewSize, selected);
  if (!items.length) return null;
  return (
    <div className="livemedia" aria-hidden="true">
      {items.map((el) => {
        const f = files[el.fileId]!;
        const sx = (el.x + viewport.scrollX) * viewport.zoom;
        const sy = (el.y + viewport.scrollY) * viewport.zoom;
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
          <img key={el.id} {...common} src={f.dataURL} alt="" draggable={false} decoding="async" />
        );
      })}
    </div>
  );
};
