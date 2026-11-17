/**
 * Board → agent views (plan §5.4): compact elements (only non-default fields,
 * labels folded into their shape), full elements in the input names of §5.3
 * (round-trippable through update_elements), the one-line outline, filters
 * and rev-pinned paging cursors.
 */
import { createHash } from "node:crypto";
import { DEFAULT_STYLE } from "../../src/scene/constants";
import { hasPoints, isBoundText, isLinear } from "../../src/scene/elements";
import { getCommonBounds, getElementBounds } from "../../src/scene/geometry";
import type { Bounds, SceneElement, TextElement } from "../../src/scene/types";
import type { SceneSnapshot, StoredFile } from "../../src/shared/protocol";
import { base64url } from "../../src/shared/ids";
import { absolute, freeSpace, inputType } from "./elements";
import { colorName, radToDeg, round, ToolError } from "./palette";

type Obj = Record<string, unknown>;

const ROUGH = ["tidy", "sketchy", "wobbly"];

export const labelsByContainer = (elements: readonly SceneElement[]) => {
  const map = new Map<string, TextElement>();
  for (const el of elements) if (isBoundText(el)) map.set(el.containerId!, el);
  return map;
};

const pt = (p: { x: number; y: number }) => [round(p.x), round(p.y)];

export const compactElement = (
  el: SceneElement,
  label: TextElement | undefined,
  files: Map<string, StoredFile>,
): Obj => {
  const o: Obj = { id: el.id, type: inputType(el) };
  if (!isLinear(el)) {
    o.x = round(el.x);
    o.y = round(el.y);
    o.w = round(el.width);
    o.h = round(el.height);
  }
  if (el.angle) o.angle = radToDeg(el.angle);
  if (label) o.label = label.text;
  if (el.type === "text") {
    o.text = el.text;
    if (el.fontSize !== DEFAULT_STYLE.fontSize) o.font_size = el.fontSize;
    if (el.fontFamily !== DEFAULT_STYLE.fontFamily) o.font = el.fontFamily;
  }
  if (
    el.type !== "image" &&
    el.type !== "frame" &&
    el.type !== "embed" &&
    el.type !== "note" &&
    el.type !== "component"
  )
    if (el.strokeColor !== DEFAULT_STYLE.strokeColor) o.stroke = colorName(el.strokeColor);
  if (el.backgroundColor !== "transparent") o.fill = colorName(el.backgroundColor);
  if (el.backgroundColor !== "transparent" && el.fillStyle !== "hachure" && el.type !== "note")
    o.fill_style = el.fillStyle;
  if (el.strokeStyle !== "solid") o.stroke_style = el.strokeStyle;
  if (el.opacity !== 100) o.opacity = el.opacity;
  if (el.groupIds.length) o.group = el.groupIds[el.groupIds.length - 1];
  if (el.frameId) o.frame = el.frameId;
  if (el.locked) o.locked = true;
  if (el.link) o.link = el.link;
  if (el.type === "frame") o.name = el.name;
  if (el.type === "embed") o.url = el.url;
  if (el.type === "component") {
    if (el.title) o.title = el.title;
    if (el.source.kind === "preset") {
      o.preset = el.source.preset;
      if (Object.keys(el.source.params).length) o.params = el.source.params;
    } else o.custom = true;
    if (el.paused) o.paused = true;
  }
  if (isLinear(el)) {
    if (el.startBinding) o.from = el.startBinding.elementId;
    if (el.endBinding) o.to = el.endBinding.elementId;
    o.points = absolute(el).map(pt);
    if (el.type === "line" && el.closed) o.closed = true;
    if (el.type === "arrow" && el.routing !== "straight") o.routing = el.routing;
  }
  if (el.type === "freedraw") {
    o.x = round(el.x);
    o.y = round(el.y);
    o.point_count = el.points.length;
  }
  if (el.type === "image") {
    o.file_id = el.fileId;
    const f = files.get(el.fileId);
    if (f) {
      o.mime = f.mime;
      o.source = f.source;
      if (f.source === "remote") o.url = f.url;
      if (f.durationMs) o.duration_ms = f.durationMs;
    }
    if (el.paused) o.paused = true;
    if (el.loop === false) o.loop = false;
    if (el.autoplay === false) o.autoplay = false;
  }
  return o;
};

export const fullElement = (el: SceneElement, label: TextElement | undefined): Obj => {
  const o: Obj = {
    id: el.id,
    type: inputType(el),
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    angle: hasPoints(el) ? 0 : radToDeg(el.angle),
    stroke: el.strokeColor,
    fill: el.backgroundColor,
    fill_style: el.fillStyle,
    stroke_width: el.strokeWidth,
    stroke_style: el.strokeStyle,
    roughness: ROUGH[el.roughness],
    edges: el.edges,
    opacity: el.opacity,
    locked: el.locked,
    link: el.link,
    group_ids: el.groupIds,
    frame: el.frameId,
  };
  if (label !== undefined) o.label = label.text;
  switch (el.type) {
    case "text":
      Object.assign(o, {
        text: el.text,
        font: el.fontFamily,
        font_size: el.fontSize,
        text_align: el.textAlign,
        container: el.containerId,
      });
      break;
    case "arrow":
    case "line":
      delete o.x;
      delete o.y;
      delete o.width;
      delete o.height;
      Object.assign(o, {
        points: absolute(el).map((p) => [p.x, p.y]),
        from: el.startBinding?.elementId ?? null,
        to: el.endBinding?.elementId ?? null,
        routing: el.routing,
        start_arrowhead: el.startArrowhead,
        end_arrowhead: el.endArrowhead,
        closed: el.closed,
      });
      break;
    case "freedraw": {
      const abs = absolute(el);
      delete o.x;
      delete o.y;
      delete o.width;
      delete o.height;
      o.points = abs.map((p, i) =>
        el.pressures ? [p.x, p.y, el.pressures[i] ?? 0.5] : [p.x, p.y],
      );
      break;
    }
    case "image":
      Object.assign(o, {
        file_id: el.fileId,
        crop: el.crop
          ? {
              x: el.crop.x,
              y: el.crop.y,
              width: el.crop.width,
              height: el.crop.height,
              natural_width: el.crop.naturalWidth,
              natural_height: el.crop.naturalHeight,
            }
          : null,
        flip_x: el.flipX,
        flip_y: el.flipY,
        ...(el.paused !== undefined ? { paused: el.paused } : {}),
        ...(el.loop !== undefined ? { loop: el.loop } : {}),
        ...(el.autoplay !== undefined ? { autoplay: el.autoplay } : {}),
      });
      break;
    case "frame":
      o.name = el.name;
      break;
    case "embed":
      o.url = el.url;
      break;
    case "component":
      // full detail: everything needed to rebuild it (custom content included)
      delete o.custom;
      o.title = el.title;
      if (el.source.kind === "preset") {
        o.preset = el.source.preset;
        o.params = el.source.params;
      } else {
        o.html = el.source.html;
        o.css = el.source.css;
      }
      if (el.paused !== undefined) o.paused = el.paused;
      break;
  }
  return o;
};

const OUTLINE_NAME: Record<string, string> = {
  rectangle: "box",
  diamond: "diamond",
  ellipse: "ellipse",
  note: "note",
  frame: "frame",
  text: "text",
  arrow: "connector",
  line: "line",
  freedraw: "drawing",
  image: "picture",
  embed: "web_card",
  component: "component",
};
const q = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}…` : s);

export const outlineLine = (el: SceneElement, label: TextElement | undefined): string => {
  const name = OUTLINE_NAME[el.type] ?? el.type;
  const parts = [name, el.id];
  if (el.type === "text") parts.push(q(el.text));
  else if (label) parts.push(q(label.text));
  if (el.type === "frame") parts.push(q(el.name));
  if (el.type === "component") {
    parts.push(el.source.kind === "preset" ? el.source.preset : "custom");
    if (el.title) parts.push(q(el.title));
  }
  if (isLinear(el)) {
    const abs = absolute(el);
    const a = el.startBinding?.elementId ?? `(${pt(abs[0]).join(",")})`;
    const b = el.endBinding?.elementId ?? `(${pt(abs[abs.length - 1]).join(",")})`;
    parts.splice(2, 0, `${a} → ${b}`);
  } else {
    parts.push(`at (${round(el.x)},${round(el.y)}) ${round(el.width)}×${round(el.height)}`);
    if (el.backgroundColor !== "transparent") parts.push(colorName(el.backgroundColor));
  }
  if (el.frameId) parts.push(`in ${el.frameId}`);
  if (el.locked) parts.push("locked");
  return parts.join(" ");
};

// ------------------------------------------------------------------ query

export interface SceneQuery {
  format: "json" | "outline";
  detail: "compact" | "full";
  ids?: string[];
  region?: { x: number; y: number; width: number; height: number };
  query?: string;
  limit: number;
  cursor?: string;
}

const RESPONSE_CAP = 50_000;

export const boundsOut = (b: Bounds | null) =>
  b
    ? {
        x: round(b.minX),
        y: round(b.minY),
        width: round(b.maxX - b.minX),
        height: round(b.maxY - b.minY),
      }
    : null;

const filterHash = (q: SceneQuery) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        q.format,
        q.detail,
        q.ids ?? null,
        q.region ?? null,
        q.query ?? null,
        q.limit,
      ]),
    )
    .digest("base64url")
    .slice(0, 12);

const encodeCursor = (rev: number, after: [string, string], hash: string) =>
  base64url(new TextEncoder().encode(JSON.stringify({ r: rev, a: after, h: hash })));

const decodeCursor = (c: string) => {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as {
      r: unknown;
      a: unknown;
      h: unknown;
    };
    if (
      typeof v.r === "number" &&
      Array.isArray(v.a) &&
      v.a.length === 2 &&
      v.a.every((x) => typeof x === "string") &&
      typeof v.h === "string"
    )
      return { rev: v.r, after: v.a as [string, string], hash: v.h };
  } catch {
    /* fall through */
  }
  throw new ToolError(
    "invalid_cursor",
    "cursor: not a cursor from get_scene. Call get_scene again without it.",
  );
};

const cmp = (a: [string, string], b: [string, string]) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

export const queryScene = (snap: SceneSnapshot, q: SceneQuery) => {
  const elements = snap.elements.map((e) => e.el);
  const labels = labelsByContainer(elements);
  const files = new Map(snap.files.map((f) => [f.id, f]));
  const hash = filterHash(q);
  let rows = snap.elements
    .map((e) => ({ el: e.el, key: [e.idx, e.el.id] as [string, string] }))
    .sort((a, b) => cmp(a.key, b.key));
  // bound labels are folded into their item (asking for a label's id returns it as text)
  const idSet = q.ids ? new Set(q.ids) : null;
  rows = rows.filter((r) => !isBoundText(r.el) || (idSet?.has(r.el.id) ?? false));
  if (idSet) rows = rows.filter((r) => idSet.has(r.el.id));
  if (q.region) {
    const { x, y, width, height } = q.region;
    rows = rows.filter((r) => {
      const b = getElementBounds(r.el);
      return b.maxX >= x && b.minX <= x + width && b.maxY >= y && b.minY <= y + height;
    });
  }
  if (q.query) {
    const needle = q.query.toLowerCase();
    rows = rows.filter((r) => {
      const texts = [
        r.el.type === "text" ? r.el.text : "",
        labels.get(r.el.id)?.text ?? "",
        r.el.type === "frame" ? r.el.name : "",
      ];
      return texts.some((t) => t.toLowerCase().includes(needle));
    });
  }
  const count = rows.length;
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c.hash !== hash)
      throw new ToolError(
        "stale_cursor",
        "cursor: it belongs to a call with other filters. Repeat the same filters, or call get_scene again without a cursor.",
      );
    if (c.rev !== snap.rev)
      throw new ToolError(
        "stale_cursor",
        `The board changed while you were paging (rev ${c.rev} → ${snap.rev}). Call get_scene again without a cursor, or narrow it with ids, region or query.`,
      );
    rows = rows.filter((r) => cmp(r.key, c.after) > 0);
  }
  const out: unknown[] = [];
  let size = 0;
  let last: [string, string] | null = null;
  let more = false;
  const full = q.detail === "full";
  for (const r of rows) {
    if (out.length >= q.limit) {
      more = true;
      break;
    }
    const item =
      q.format === "outline"
        ? outlineLine(r.el, labels.get(r.el.id))
        : full
          ? fullElement(r.el, labels.get(r.el.id))
          : compactElement(r.el, labels.get(r.el.id), files);
    const bytes = typeof item === "string" ? item.length + 1 : JSON.stringify(item).length + 1;
    if (!full && out.length && size + bytes > RESPONSE_CAP) {
      more = true;
      break;
    }
    size += bytes;
    out.push(item);
    last = r.key;
  }
  const next_cursor = more && last ? encodeCursor(snap.rev, last, hash) : undefined;
  const bounds = boundsOut(getCommonBounds(elements));
  const free_space = freeSpace(elements);
  if (q.format === "outline")
    return {
      rev: snap.rev,
      bounds,
      count,
      outline: out.join("\n"),
      ...(next_cursor ? { next_cursor } : {}),
      free_space,
    };
  return {
    rev: snap.rev,
    bounds,
    count,
    elements: out,
    ...(next_cursor ? { next_cursor } : {}),
    free_space,
  };
};
