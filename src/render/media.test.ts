import { afterEach, describe, expect, it } from "vitest";
import { createComponent, createImage, createShape } from "../scene/elements";
import { renderScene } from "./renderScene";
import type { FileMap, ImageElement } from "../scene/types";
import { exportToSvg } from "../io/svg";
import { FORMAT_VERSION, parseBoard, serializeBoard } from "../io/serialize";
import {
  FramePacer,
  getVideo,
  isAnimated,
  isLiveShown,
  isLoopPaused,
  isPlaying,
  isRemote,
  LIVE_MEDIA_CAP,
  liveMediaItems,
  markLiveLoaded,
  mediaClip,
  mediaKind,
  needsFrames,
  pruneVideos,
  screenRect,
  setLiveShown,
  setLoopPaused,
  setLiveShown as setLive,
  isComponentLive,
  setPlayAnyway,
} from "./media";

const files: FileMap = {
  pic: { id: "pic", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" },
  gif: {
    id: "gif",
    mimeType: "image/gif",
    dataURL: "/api/sessions/abcdefghijklmnopqrstuvwx/files/gif",
  },
  vid: {
    id: "vid",
    mimeType: "video/mp4",
    dataURL: "/api/sessions/abcdefghijklmnopqrstuvwx/files/vid",
  },
  link: {
    id: "link",
    mimeType: "video/webm",
    dataURL: "https://media.example.com/clip.webm",
    source: "remote",
  },
};
const img = (fileId: string, x = 0, w = 200, h = 150): ImageElement =>
  createImage(x, 0, w, h, fileId);
const view = { zoom: 1, scrollX: 0, scrollY: 0 };
const screen = { width: 1000, height: 800 };

afterEach(() => setLoopPaused(false));

describe("media kinds", () => {
  it("tells pictures, GIFs, videos and links apart", () => {
    expect(mediaKind(files.pic)).toBe("picture");
    expect(mediaKind(files.gif)).toBe("gif");
    expect(mediaKind(files.vid)).toBe("video");
    expect(isAnimated(files.pic)).toBe(false);
    expect(isAnimated(files.gif)).toBe(true);
    expect(isRemote(files.link)).toBe(true);
    expect(isRemote(files.gif)).toBe(false);
    // an https address without a source flag is still a link
    expect(
      isRemote({ id: "x", mimeType: "image/png", dataURL: "https://a.example.com/x.png" }),
    ).toBe(true);
  });
});

describe("playback state", () => {
  it("plays GIFs and videos unless paused, autoplay is off or the loop paused everything", () => {
    const gif = img("gif");
    expect(isPlaying(gif, files.gif)).toBe(true);
    expect(isPlaying({ ...gif, paused: true }, files.gif)).toBe(false);
    expect(isPlaying(img("pic"), files.pic)).toBe(false);
    const vid = { ...img("vid"), autoplay: false };
    expect(isPlaying(vid, files.vid)).toBe(false);
    setPlayAnyway(vid.id, true);
    expect(isPlaying(vid, files.vid)).toBe(true);
    setPlayAnyway(vid.id, false);
    setLoopPaused(true);
    expect(isLoopPaused()).toBe(true);
    expect(isPlaying(gif, files.gif)).toBe(false);
  });

  it("asks for frames only while a playing same-origin GIF or video is visible", () => {
    const gif = img("gif");
    const link = img("link");
    expect(needsFrames([gif], files, () => true)).toBe(true);
    expect(needsFrames([gif], files, () => false)).toBe(false);
    expect(needsFrames([{ ...gif, paused: true }], files, () => true)).toBe(false);
    // links play in the live layer; the canvas never animates them
    expect(needsFrames([link, img("pic")], files, () => true)).toBe(false);
    expect(needsFrames([createShape("rectangle", 0, 0)], files, () => true)).toBe(false);
  });
});

describe("partial redraw", () => {
  const view = { zoom: 2, scrollX: 10, scrollY: 0 };
  it("covers each playing same-origin GIF or video in whole screen pixels", () => {
    const g = img("gif", 0, 100, 50);
    const rects = mediaClip([img("pic"), g, img("link")], files, () => true, view);
    expect(rects).toHaveLength(1);
    const r = rects![0];
    expect(r.x).toBeLessThanOrEqual(20);
    expect(r.x + r.width).toBeGreaterThanOrEqual(220);
    expect(r.height).toBeGreaterThanOrEqual(100);
    expect(Number.isInteger(r.x) && Number.isInteger(r.width)).toBe(true);
  });
  it("leaves out paused items unless asked for every animated one", () => {
    const g = { ...img("gif"), paused: true };
    expect(mediaClip([g], files, () => true, view)).toBeNull();
    expect(mediaClip([g], files, () => true, view, true)).toHaveLength(1);
    expect(mediaClip([img("gif")], files, () => false, view)).toBeNull();
  });
  it("pads a shape's box by its stroke", () => {
    const sh = createShape("rectangle", 0, 0, undefined, 10, 10);
    const r = screenRect(sh, { zoom: 1, scrollX: 0, scrollY: 0 });
    expect(r.x).toBeLessThan(0);
    expect(r.width).toBeGreaterThan(10);
  });
});

describe("frame budget", () => {
  const run = (p: FramePacer, cost: number, ms: number, from = 0, step = 33) => {
    let t = from;
    for (; t < from + ms; t += step) p.record(cost, t);
    return t;
  };

  it("keeps 30 fps for cheap frames", () => {
    const p = new FramePacer();
    run(p, 3, 3000);
    expect(p.fps).toBe(30);
    expect(p.paused).toBe(false);
  });

  it("steps to 15 fps above 12 ms and to 10 fps above 25 ms", () => {
    const p = new FramePacer();
    run(p, 14, 1000);
    expect(p.fps).toBe(15);
    const q = new FramePacer();
    run(q, 26, 1000);
    expect(q.fps).toBe(10);
  });

  it("pauses everything after 2 s over budget at 10 fps, and Play resumes", () => {
    const p = new FramePacer();
    const t = run(p, 40, 4000, 0, 100);
    expect(p.paused).toBe(true);
    expect(isLoopPaused()).toBe(true);
    p.resume();
    expect(p.paused).toBe(false);
    expect(isLoopPaused()).toBe(false);
    expect(t).toBeGreaterThan(0);
  });

  it("steps back up after 5 s under budget", () => {
    const p = new FramePacer();
    const t = run(p, 14, 1000);
    expect(p.fps).toBe(15);
    run(p, 2, 6000, t);
    expect(p.fps).toBe(30);
  });

  it("does not count frames with nothing moving", () => {
    const p = new FramePacer();
    p.record(null, 0);
    expect(p.animating).toBe(false);
    expect(p.stats().frames).toBe(0);
  });
});

describe("live layer", () => {
  it("mounts only on-screen remote items, at most 24, keeping board order", () => {
    const many = Array.from({ length: 30 }, (_, i) => img("link", i * 10, 100 + i, 100));
    const live = liveMediaItems(many, files, view, screen, new Set());
    expect(live).toHaveLength(LIVE_MEDIA_CAP);
    // the biggest win; the order is the board's
    expect(live.map((e) => e.id)).toEqual(many.slice(6).map((e) => e.id));
    expect(liveMediaItems([img("pic"), img("gif")], files, view, screen, new Set())).toEqual([]);
  });

  it("always keeps selected items and leaves out small, off-screen and far-out items", () => {
    const many = Array.from({ length: 30 }, (_, i) => img("link", i * 10, 300, 300));
    const small = img("link", 0, 300, 300);
    const live = liveMediaItems([small, ...many], files, view, screen, new Set([small.id]));
    expect(live.map((e) => e.id)).toContain(small.id);
    expect(liveMediaItems([img("link", 0, 40, 40)], files, view, screen, new Set())).toEqual([]);
    expect(liveMediaItems([img("link", 5000)], files, view, screen, new Set())).toEqual([]);
    expect(
      liveMediaItems([img("link")], files, { ...view, zoom: 0.25 }, screen, new Set()),
    ).toEqual([]);
  });
});

describe("export and file format", () => {
  it("draws a placeholder card for links and videos in SVG export", () => {
    const svg = exportToSvg([img("link"), img("vid", 300)], files, {
      theme: "light",
      background: null,
    });
    expect(svg.match(/data-media-placeholder/g)).toHaveLength(2);
    expect(svg).toContain("Video · media.example.com");
    expect(svg).not.toContain("https://media.example.com/clip.webm");
  });

  it("writes format 2 with links kept as links and playback fields", () => {
    expect(FORMAT_VERSION).toBe(2);
    const el = { ...img("link"), paused: true, loop: false, autoplay: false };
    const text = serializeBoard([el], files, {
      viewBackgroundColor: "paper",
      gridEnabled: false,
    } as never);
    const back = parseBoard(text);
    expect(back.version).toBe(2);
    expect(back.files.link).toMatchObject({
      dataURL: "https://media.example.com/clip.webm",
      source: "remote",
    });
    expect(back.elements[0]).toMatchObject({ paused: true, loop: false, autoplay: false });
  });

  it("refuses links to private hosts in a file", () => {
    const text = JSON.stringify({
      type: "chalana",
      version: 2,
      elements: [img("x")],
      files: {
        x: { id: "x", mimeType: "image/png", dataURL: "https://localhost/a.png", source: "remote" },
      },
    });
    expect(() => parseBoard(text)).toThrow(/public https/);
  });
});

describe("board videos and export copies", () => {
  it("keeps the loaded <video> when an export passes a data: URL copy of the same file", () => {
    const made: { src: string; paused: boolean; pause(): void }[] = [];
    const fake = () => {
      const v = {
        src: "",
        paused: true,
        muted: true,
        loop: true,
        ended: false,
        playsInline: false,
        preload: "",
        addEventListener() {},
        pause() {
          v.paused = true;
        },
        play() {
          v.paused = false;
          return Promise.resolve();
        },
        removeAttribute() {},
        load() {},
      };
      made.push(v);
      return v;
    };
    const g = globalThis as { document?: unknown };
    const had = g.document;
    g.document = { createElement: fake };
    try {
      const el = img("vid");
      const board = getVideo(el, files.vid);
      expect(board.src).toBe(files.vid.dataURL);
      const copy = { ...files.vid, dataURL: "data:video/mp4;base64,AAAA" };
      expect(getVideo(el, copy)).toBe(board);
      expect(made).toHaveLength(1);
      expect(board.paused).toBe(false);
      // a different file for the item does replace it
      const other = {
        ...files.vid,
        id: "vid2",
        dataURL: "/api/sessions/abcdefghijklmnopqrstuvwx/files/vid2",
      };
      expect(getVideo(el, other)).not.toBe(board);
      pruneVideos([]);
    } finally {
      g.document = had;
    }
  });

  it("draws no card under a link only while it shows live and has loaded", () => {
    const el = img("link");
    expect(isLiveShown(el, files.link)).toBe(false);
    setLiveShown([el.id]);
    expect(isLiveShown(el, files.link)).toBe(false);
    markLiveLoaded(el.id, files.link.dataURL);
    expect(isLiveShown(el, files.link)).toBe(true);
    // a different link for the same item has to load first
    expect(isLiveShown(el, { ...files.link, dataURL: "https://media.example.com/b.webm" })).toBe(
      false,
    );
    setLiveShown([]);
    expect(isLiveShown(el, files.link)).toBe(false);
  });
});

describe("animated components (MEDIA-05/06)", () => {
  const comp = (x = 0, title = "Loader") =>
    createComponent(x, 0, { kind: "preset", preset: "spinner", params: {} }, title);

  it("share the live layer and its cap of 24 with remote media", () => {
    const many = [
      ...Array.from({ length: 20 }, (_, i) => img("link", i * 10, 300, 300)),
      ...Array.from({ length: 10 }, (_, i) => comp(i * 10)),
    ];
    const live = liveMediaItems(many, files, view, screen, new Set());
    expect(live).toHaveLength(LIVE_MEDIA_CAP);
    expect(live.some((e) => e.type === "component")).toBe(true);
    setLive([many[25].id]);
    expect(isComponentLive(many[25].id)).toBe(true);
    setLive([]);
  });

  it("export as a static card with the title, never the HTML", () => {
    const c = createComponent(0, 0, { kind: "custom", html: "<p>SECRET</p>", css: "" }, "Card <b>");
    const svg = exportToSvg([c, comp(400)], files, { theme: "light", background: null });
    expect(svg).toContain("Card &#60;b&#62;");
    expect(svg).toContain("Loader");
    expect(svg.match(/Animated component/g)).toHaveLength(2);
    expect(svg).not.toContain("SECRET");
    expect(svg).not.toMatch(/<foreignObject|<iframe/i);
  });

  it("PNG export (a still render) draws the card even while the frame is live", () => {
    const c = comp();
    setLive([c.id]);
    const texts: string[] = [];
    const ctx: CanvasRenderingContext2D = new Proxy(
      {},
      {
        get: (_t, k) =>
          k === "canvas"
            ? { getContext: () => ctx, width: 500, height: 500 }
            : k === "fillText"
              ? (t: string) => void texts.push(t)
              : k === "measureText"
                ? () => ({ width: 10 })
                : k === "getTransform"
                  ? () => ({ a: 1, d: 1 })
                  : () => undefined,
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    const opts = {
      elements: [c],
      files,
      theme: "light" as const,
      background: null,
      width: 500,
      height: 500,
      viewport: { zoom: 1, scrollX: 0, scrollY: 0 },
    };
    renderScene(ctx, { ...opts, still: true });
    expect(texts).toEqual(["Loader", "Animated component"]);
    texts.length = 0;
    renderScene(ctx, opts);
    expect(texts).toEqual([]); // the live frame shows on screen instead
    setLive([]);
  });
});
