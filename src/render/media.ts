/**
 * Animated media on the board canvas (plan §6.3, MEDIA-01..04, MEDIA-08).
 *
 * Uploaded GIFs and videos are same-origin, so they are drawn on the canvas
 * and keep their place in the layer order. GIF frames come from ImageDecoder
 * where the browser has it (each GIF keeps its own timing); elsewhere the
 * still first frame is drawn. Videos are one muted <video> per item, drawn
 * frame by frame. Remote links are never drawn here: the live layer shows
 * them and the canvas (and every export) gets a placeholder card instead.
 *
 * Playback state that is shared lives on the element (paused, loop,
 * autoplay). Mute and the reduced-motion "play anyway" choice are personal
 * to this tab and live here.
 */
import type {
  BinaryFile,
  FileMap,
  ImageElement,
  SceneElement,
  Theme,
  Viewport,
} from "../scene/types";
import { getElementBounds } from "../scene/geometry";
import { isSessionFilePath } from "../shared/ids";
import { isVideoMime, remoteHost } from "../shared/urls";

export const isRemote = (f: BinaryFile | undefined) =>
  !!f &&
  (f.source === "remote" || (!f.dataURL.startsWith("data:") && !isSessionFilePath(f.dataURL)));
export const isGifFile = (f: BinaryFile | undefined) => f?.mimeType === "image/gif";
export const isVideoFile = (f: BinaryFile | undefined) => isVideoMime(f?.mimeType);
export const isAnimated = (f: BinaryFile | undefined) => isGifFile(f) || isVideoFile(f);

export type MediaKind = "picture" | "gif" | "video";
export const mediaKind = (f: BinaryFile | undefined): MediaKind =>
  isVideoFile(f) ? "video" : isGifFile(f) ? "gif" : "picture";

let onFrameReady: () => void = () => {};
export const setMediaListener = (fn: () => void) => {
  onFrameReady = fn;
};

/* ---------------------------------------------------------------- per-tab state */

const unmuted = new Set<string>();
/** reduced motion: items this tab chose to play anyway */
const playAnyway = new Set<string>();
export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const isMuted = (id: string) => !unmuted.has(id);
export const setMuted = (id: string, muted: boolean) => {
  if (muted) unmuted.delete(id);
  else unmuted.add(id);
  const v = videos.get(id);
  if (v) v.el.muted = muted;
};
export const setPlayAnyway = (id: string, on: boolean) => {
  if (on) playAnyway.add(id);
  else playAnyway.delete(id);
};

/** Should this item be moving right now (shared state + this tab's choices)? */
let loopPaused = false;
/** Set when the frame budget paused every animation (until Play). */
export const setLoopPaused = (on: boolean) => {
  loopPaused = on;
  onFrameReady();
};
export const isLoopPaused = () => loopPaused;

export const isPlaying = (el: ImageElement, f: BinaryFile | undefined) => {
  if (!isAnimated(f) || el.paused || loopPaused) return false;
  if (isVideoFile(f) && el.autoplay === false && !playAnyway.has(el.id)) return false;
  if (reducedMotion() && !playAnyway.has(el.id)) return false;
  return true;
};

/* ---------------------------------------------------------------- GIFs */

interface GifFrames {
  frames: { bmp: ImageBitmap; until: number }[];
  total: number;
}
const gifs = new Map<string, GifFrames | "loading" | "none">();
const gifHold = new Map<string, number>();
const MAX_GIF_FRAMES = 400;
const tooBigGifs = new Set<string>();
/** Whether this GIF has too many frames to animate (it shows its first frame). */
export const isGifTooBig = (fileId: string) => tooBigGifs.has(fileId);
let onNotice: (text: string) => void = () => {};
export const setMediaNoticeListener = (fn: (text: string) => void) => {
  onNotice = fn;
};

type Decoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode(o: { frameIndex: number }): Promise<{
    image: { duration: number | null; close(): void } & CanvasImageSource;
  }>;
  close(): void;
};

const decodeGif = async (fileId: string, src: string) => {
  const Ctor = (globalThis as { ImageDecoder?: new (o: unknown) => Decoder }).ImageDecoder;
  if (!Ctor) {
    gifs.set(fileId, "none");
    return;
  }
  try {
    const res = await fetch(src, { credentials: "same-origin" });
    const dec = new Ctor({ data: await res.arrayBuffer(), type: "image/gif" });
    await dec.tracks.ready;
    const total = dec.tracks.selectedTrack?.frameCount ?? 0;
    if (total > MAX_GIF_FRAMES) {
      // too many frames to keep: show the first frame and say so (MEDIA-01)
      dec.close();
      gifs.set(fileId, "none");
      tooBigGifs.add(fileId);
      onNotice("This GIF has too many frames to animate here, so it shows its first frame.");
      onFrameReady();
      return;
    }
    const count = total;
    const frames: GifFrames["frames"] = [];
    let t = 0;
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      // browsers treat frame delays under 20 ms as 100 ms; so do we
      const ms = (image.duration ?? 100_000) / 1000;
      t += ms < 20 ? 100 : ms;
      frames.push({ bmp: await createImageBitmap(image), until: t });
      image.close();
    }
    dec.close();
    gifs.set(fileId, frames.length > 1 ? { frames, total: t } : "none");
  } catch {
    gifs.set(fileId, "none");
  }
  onFrameReady();
};

/** The GIF frame to draw now, or null to draw the still <img>. */
export const gifFrame = (el: ImageElement, file: BinaryFile, now: number): ImageBitmap | null => {
  const g = gifs.get(file.id);
  if (g === undefined) {
    gifs.set(file.id, "loading");
    void decodeGif(file.id, file.dataURL);
    return null;
  }
  if (typeof g === "string") return null;
  // a paused GIF holds the frame it last showed here (the first frame if never played)
  let t = gifHold.get(el.id) ?? 0;
  if (isPlaying(el, file)) {
    t = now % g.total;
    gifHold.set(el.id, t);
  }
  const frame = g.frames.find((f) => t < f.until) ?? g.frames[g.frames.length - 1];
  return frame.bmp;
};
/* ---------------------------------------------------------------- videos */

const videos = new Map<
  string,
  { el: HTMLVideoElement; src: string; fileId: string; seen: number }
>();
/** At most this many videos play at once; the others hold their frame. */
export const MAX_PLAYING_VIDEOS = 6;
const playingCount = () => {
  let n = 0;
  for (const v of videos.values()) if (!v.el.paused) n++;
  return n;
};

export const getVideo = (el: ImageElement, file: BinaryFile): HTMLVideoElement => {
  let v = videos.get(el.id);
  // an inlined (data: URL) copy of the same file keeps the loaded element: the
  // page CSP refuses data: media, and swapping would stall the board's video
  const sameFileCopy =
    !!v && v.fileId === file.id && file.dataURL.startsWith("data:") && !v.src.startsWith("data:");
  if (!v || (v.src !== file.dataURL && !sameFileCopy)) {
    v?.el.pause();
    const video = document.createElement("video");
    video.muted = isMuted(el.id);
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("loadeddata", () => onFrameReady());
    video.addEventListener("seeked", () => onFrameReady());
    video.addEventListener("ended", () => onFrameReady());
    video.src = file.dataURL;
    v = { el: video, src: file.dataURL, fileId: file.id, seen: 0 };
    videos.set(el.id, v);
  }
  v.seen = performance.now();
  const video = v.el;
  video.loop = el.loop !== false;
  video.preload = isPlaying(el, file) ? "auto" : "metadata";
  const want = isPlaying(el, file) && !(video.ended && !video.loop);
  if (want && video.paused && playingCount() < MAX_PLAYING_VIDEOS)
    void video.play().catch(() => {});
  else if (!want && !video.paused) video.pause();
  return video;
};

/** Plays a video again from the start (MEDIA-03 Restart). */
export const restartMedia = (id: string) => {
  const v = videos.get(id);
  if (v) {
    v.el.currentTime = 0;
    void v.el.play().catch(() => {});
  }
  gifHold.delete(id);
};

export const videoState = (id: string) => {
  const v = videos.get(id)?.el;
  return v ? { currentTime: v.currentTime, paused: v.paused, muted: v.muted } : null;
};

/**
 * Releases videos whose items left the board, and (5 s later) those that
 * left the screen; videos off screen stop playing at once.
 */
export const pruneVideos = (
  elements: readonly SceneElement[],
  visible: (el: SceneElement) => boolean = () => true,
  now = performance.now(),
) => {
  if (!videos.size) return;
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const [id, v] of videos) {
    const el = byId.get(id);
    const shown = !!el && visible(el);
    if (shown) continue;
    if (!v.el.paused) v.el.pause();
    if (!el || now - v.seen > 5000) {
      v.el.removeAttribute("src");
      v.el.load();
      videos.delete(id);
    }
  }
};
export const videoCount = () => videos.size;

/* ---------------------------------------------------------------- live layer state */

/** Links the live layer has on screen now, and those whose bytes have loaded. */
let liveNow = new Set<string>();
/** A full board repaint (the still layer holds the cards under links). */
let onLiveChanged: () => void = () => {};
export const setLiveListener = (fn: () => void) => {
  onLiveChanged = fn;
};
const liveLoaded = new Set<string>();
const liveKey = (id: string, url: string) => `${id}\n${url}`;
/** The live layer reports the items it shows (after each render). */
export const setLiveShown = (ids: readonly string[]) => {
  const next = new Set(ids);
  const changed = next.size !== liveNow.size || ids.some((id) => !liveNow.has(id));
  liveNow = next;
  if (changed) onLiveChanged();
};
/** The live layer reports a link that finished loading. */
export const markLiveLoaded = (id: string, url: string) => {
  const k = liveKey(id, url);
  if (liveLoaded.has(k)) return;
  liveLoaded.add(k);
  onLiveChanged();
};
/**
 * Is this link showing live over the board right now? Then the board draws
 * nothing under it (a transparent picture must not show the card through).
 */
export const isLiveShown = (el: ImageElement, file: BinaryFile) =>
  liveNow.has(el.id) && liveLoaded.has(liveKey(el.id, file.dataURL));

/* ---------------------------------------------------------------- placeholders */

/**
 * The card drawn for media the canvas cannot show: remote links (on the
 * board, under the live element, and in exports) and videos not loaded yet.
 */
export const drawMediaPlaceholder = (
  ctx: CanvasRenderingContext2D,
  el: ImageElement,
  file: BinaryFile | undefined,
  theme: Theme,
) => {
  const w = el.width;
  const h = el.height;
  const dark = theme === "dark";
  ctx.fillStyle = dark ? "#1f2a29" : "#eef3f1";
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = "#8aa7a2";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.setLineDash([]);
  const kind = mediaKind(file);
  const r = Math.min(22, w / 6, h / 6);
  if (kind === "video" && r > 4) {
    ctx.fillStyle = "#5c7d78";
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(-r * 0.6, r);
    ctx.closePath();
    ctx.fill();
  }
  if (w > 80 && h > 40) {
    const label = file
      ? `${kind === "video" ? "Video" : kind === "gif" ? "GIF" : "Picture"}${isRemote(file) ? ` · ${remoteHost(file.dataURL)}` : ""}`
      : "Missing media";
    ctx.fillStyle = dark ? "#c8d8d4" : "#3d5753";
    ctx.font = `13px "Source Sans 3", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(label, 0, Math.min(h / 2 - 20, r + 8), w - 12);
  }
};

/* ---------------------------------------------------------------- frame pacing */

/**
 * Is any animated item on screen and playing? The board only keeps redrawing
 * while this is true, so a board of still items costs nothing (MEDIA-08).
 */
export const needsFrames = (
  elements: readonly SceneElement[],
  files: FileMap,
  visible: (el: SceneElement) => boolean,
) => {
  for (const el of elements) {
    if (el.type !== "image") continue;
    const f = files[el.fileId];
    if (!f || isRemote(f) || !isAnimated(f)) continue;
    if (isPlaying(el, f) && visible(el)) return true;
  }
  return false;
};

/**
 * The screen rectangles of every playing, visible GIF and video (rotation
 * included), for partial redraws; whole pixels with a small margin.
 */
export const mediaClip = (
  elements: readonly SceneElement[],
  files: FileMap,
  visible: (el: SceneElement) => boolean,
  v: Viewport,
  /** paused ones too (a video seeked or a GIF decoded) */
  all = false,
) => {
  const out: { x: number; y: number; width: number; height: number }[] = [];
  for (const el of elements) {
    if (el.type !== "image") continue;
    const f = files[el.fileId];
    if (!f || isRemote(f) || !visible(el)) continue;
    if (all ? !isAnimated(f) : !isPlaying(el, f)) continue;
    out.push(screenRect(el, v));
  }
  return out.length ? out : null;
};

/** An item's on-screen box in whole CSS pixels, with room for its stroke. */
export const screenRect = (el: SceneElement, v: Viewport, pad = 2) => {
  const b = getElementBounds(el);
  const m = pad + (("strokeWidth" in el ? el.strokeWidth : 0) || 0) * v.zoom;
  const x = Math.floor((b.minX + v.scrollX) * v.zoom - m);
  const y = Math.floor((b.minY + v.scrollY) * v.zoom - m);
  return {
    x,
    y,
    width: Math.ceil((b.maxX + v.scrollX) * v.zoom + m) - x,
    height: Math.ceil((b.maxY + v.scrollY) * v.zoom + m) - y,
  };
};

/**
 * The animation loop's frame budget (plan §6.3): a moving average of the
 * last 30 frame costs. Target 30 fps; average over 12 ms gives 15 fps, over
 * 25 ms 10 fps; still over 25 ms at 10 fps for 2 s pauses every animation
 * (the board shows a notice with Play). After 5 s under budget it steps back
 * up one rate.
 */
export class FramePacer {
  private costs: number[] = [];
  private overSince: number | null = null;
  private underSince: number | null = null;
  fps = 30;
  paused = false;
  animating = false;
  frames = 0;
  record(cost: number | null, now: number) {
    this.animating = cost !== null;
    if (cost === null) return;
    this.frames += 1;
    this.costs.push(cost);
    if (this.costs.length > 30) this.costs.shift();
    const avg = this.average;
    if (this.costs.length < 10 || this.paused) return;
    if (avg > 12) {
      this.underSince = null;
      const want = avg > 25 ? 10 : 15;
      if (want < this.fps) {
        this.fps = want;
        this.costs = [];
      }
      if (this.fps === 10 && avg > 25) {
        this.overSince ??= now;
        if (now - this.overSince >= 2000) {
          this.paused = true;
          setLoopPaused(true);
        }
      } else this.overSince = null;
    } else {
      this.overSince = null;
      this.underSince ??= now;
      if (this.fps < 30 && now - this.underSince >= 5000) {
        this.fps = this.fps === 10 ? 15 : 30;
        this.underSince = null;
      }
    }
  }
  resume() {
    this.paused = false;
    this.overSince = null;
    this.costs = [];
    setLoopPaused(false);
  }
  get average() {
    return this.costs.length ? this.costs.reduce((x, y) => x + y, 0) / this.costs.length : 0;
  }
  stats() {
    return { fps: this.fps, paused: this.paused, average: this.average, frames: this.frames };
  }
}

/* ---------------------------------------------------------------- live layer */

/** At most this many remote items are live at once; the rest keep their placeholder card. */
export const LIVE_MEDIA_CAP = 24;

const screenArea = (el: SceneElement, v: Viewport, size: { width: number; height: number }) => {
  const b = getElementBounds(el);
  const minX = Math.max(0, (b.minX + v.scrollX) * v.zoom);
  const minY = Math.max(0, (b.minY + v.scrollY) * v.zoom);
  const maxX = Math.min(size.width, (b.maxX + v.scrollX) * v.zoom);
  const maxY = Math.min(size.height, (b.maxY + v.scrollY) * v.zoom);
  return maxX > minX && maxY > minY ? (maxX - minX) * (maxY - minY) : 0;
};

/** The remote items to show live: on screen, biggest first, selected ones always in. */
export const liveMediaItems = (
  elements: readonly SceneElement[],
  files: FileMap,
  v: Viewport,
  size: { width: number; height: number },
  selected: ReadonlySet<string>,
  cap = LIVE_MEDIA_CAP,
): ImageElement[] => {
  // below 30 % zoom every link stays a placeholder card
  if (v.zoom < 0.3) return [];
  const ranked = elements
    .filter((e): e is ImageElement => e.type === "image" && isRemote(files[e.fileId]))
    .map((el) => ({ el, area: screenArea(el, v, size) + (selected.has(el.id) ? 1e12 : 0) }))
    .filter((r) => r.area > 0 && Math.min(r.el.width, r.el.height) * v.zoom >= 48)
    .sort((a, b) => b.area - a.area)
    .slice(0, cap);
  // keep board order so later items cover earlier ones
  const keep = new Set(ranked.map((r) => r.el.id));
  return elements.filter((e): e is ImageElement => keep.has(e.id));
};
