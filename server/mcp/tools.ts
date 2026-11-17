/**
 * The MCP tools (plan §5.4). Each handler parses its arguments strictly (the
 * published zod schemas are loose on purpose, §5.2), changes the board through
 * SessionService.applyAgentChange (one atomic rev per call, broadcast live to
 * open tabs) and returns structuredContent plus the same JSON as text.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  alignElements,
  expandGroups,
  groupElements,
  reorder,
  ungroupElements,
  withDependents,
} from "../../src/scene/arrange";
import { isBoundText, isLinear, isTextContainer } from "../../src/scene/elements";
import { getCommonBounds, getElementBounds } from "../../src/scene/geometry";
import { deleteElements, withBoundTexts } from "../../src/scene/scene";
import { moveElements } from "../../src/scene/transform";
import type { SceneElement, TextElement } from "../../src/scene/types";
import { layoutText } from "../../src/scene/text";
import { parseSessionRef } from "../../src/shared/ids";
import { LIMITS } from "../../src/shared/limits";
import type { StoredFile } from "../../src/shared/protocol";
import { ServiceError } from "../errors";
import { AgentRejected, type SessionService } from "../sessions/service";
import {
  buildConnector,
  buildElement,
  type BuildContext,
  freeSpace,
  INPUT_TYPES,
  linkFile,
  mediaSize,
  place,
  STYLE_FIELDS,
  updateElement,
  applyStyle,
} from "./elements";
import { boardColor, bool, invalid, num, oneOf, str, ToolError } from "./palette";
import { boundsOut, labelsByContainer, queryScene } from "./view";

type Obj = Record<string, unknown>;

export interface ToolContext {
  service: SessionService;
  /** open browser tabs of a board */
  peers(sessionId: string): number;
  /** absolute origin for board links, e.g. http://localhost:5183 */
  baseUrl: string;
  maxImageBytes: number;
  /** largest video upload; defaults to maxImageBytes */
  maxVideoBytes?: number;
}

export const DEFAULT_AGENT = "An agent";

// ------------------------------------------------------------------ schemas

const n = z.union([z.number(), z.string()]);
const pointSchema = z.union([z.array(n), z.looseObject({ x: n, y: n })]);
const refOrPoint = z.union([z.string(), pointSchema]);
const sessionArg = z
  .string()
  .describe("The board's session id (the part after /s/ in its URL) or the full board URL.");
const agentArg = z
  .string()
  .optional()
  .describe(
    'Your name, shown to people on the board ("Claude added 3 items"). Default "An agent".',
  );
const idsArg = z.array(z.string()).describe("Element ids (from get_scene or a previous call).");

const styleShape = {
  stroke: z
    .string()
    .optional()
    .describe("Outline/ink colour: ink, lagoon, clay, berry, sky, moss or #hex."),
  fill: z
    .string()
    .optional()
    .describe(
      "Fill: none, mint, peach, rose, cloud, sage (notes: butter, apricot, seafoam, mist, blush) or #hex.",
    ),
  fill_style: z.string().optional().describe("hachure | cross-hatch | zigzag | solid"),
  stroke_width: n.optional().describe('"thin" | "bold" | "extra-bold" or a number 0.5–32'),
  stroke_style: z.string().optional().describe("solid | dashed | dotted"),
  roughness: n.optional().describe('"tidy" | "sketchy" | "wobbly"'),
  edges: z.string().optional().describe("sharp | round (boxes, diamonds, connectors)"),
  opacity: n.optional().describe("0–100"),
  font: z.string().optional().describe("Text and labels: hand | normal | code"),
  font_size: n.optional().describe('Text and labels: "s" | "m" | "l" | "xl" or 8–400'),
  text_align: z.string().optional().describe("Free text: left | center | right"),
};

const elementFields = {
  type: z
    .enum(INPUT_TYPES)
    .describe(
      "rectangle | diamond | ellipse | text | note | frame | arrow | line | freedraw | image | gif | video | web_card. (component arrives in a later version and is refused for now.)",
    ),
  key: z
    .string()
    .optional()
    .describe(
      "Your name for this item, to refer to it later in the same call (from/to/frame/contains).",
    ),
  x: n
    .optional()
    .describe("Left edge in board units (x grows right). Omit to place in free space."),
  y: n.optional().describe("Top edge in board units (y grows down)."),
  width: n
    .optional()
    .describe(
      "Box size (default 160×80; note 180; frame 800×600; web card 480×300; pictures 480 wide).",
    ),
  height: n.optional(),
  angle: n.optional().describe("Rotation in degrees, clockwise."),
  locked: z.union([z.boolean(), z.string()]).optional(),
  link: z.string().optional().describe('http(s) or mailto link, or "#el=<id>" to jump to an item.'),
  group: z.string().optional().describe("Items in this call with the same group name are grouped."),
  frame: z.string().optional().describe("Put inside this frame (id or key)."),
  label: z
    .string()
    .optional()
    .describe("rectangle/diamond/ellipse/note/arrow: the text inside or on it."),
  text: z.string().optional().describe("text: the words (give width to wrap); note: its text."),
  color: z.string().optional().describe("note: butter | apricot | seafoam | mist | blush or #hex."),
  name: z.string().optional().describe("frame: its title."),
  contains: z.array(z.string()).optional().describe("frame: ids/keys of items to put inside."),
  from: refOrPoint
    .optional()
    .describe("arrow: start; an id/key attaches to that item, [x, y] leaves it free."),
  to: refOrPoint
    .optional()
    .describe("arrow: end; an id/key attaches to that item, [x, y] leaves it free."),
  points: z
    .array(z.array(n))
    .optional()
    .describe(
      "Absolute [x, y] points. arrow: bend points between from and to; line: the path (2–1000); freedraw: [x, y] or [x, y, pressure] (≤ 5000).",
    ),
  routing: z.string().optional().describe("arrow: straight | curved | elbow"),
  start_arrowhead: z
    .string()
    .optional()
    .describe("arrow: none | arrow | bar | circle | triangle | diamond | er-one | er-many …"),
  end_arrowhead: z.string().optional(),
  closed: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe("line: close the path into a polygon."),
  file_id: z.string().optional().describe("image: a file id from upload_media."),
  url: z
    .string()
    .optional()
    .describe(
      "web_card: the page address. image, gif, video: an https link to the media (shown live by browsers, never fetched by the server); or use file_id.",
    ),
  ...styleShape,
};

const elementInput = z.looseObject(elementFields);
const updateInput = z.looseObject({
  ...elementFields,
  type: z.string().optional(),
  id: z.string().describe("The item to change."),
  link: z.string().nullable().optional().describe("null removes the link."),
  frame: z.string().nullable().optional().describe("null takes the item out of its frame."),
  from: refOrPoint
    .nullable()
    .optional()
    .describe("arrow: id/key attaches, [x, y] frees, null detaches."),
  to: refOrPoint.nullable().optional(),
  container: z.string().nullable().optional().describe("Read-only: the box a label belongs to."),
  group_ids: z.array(z.string()).optional(),
  crop: z.unknown().optional(),
  flip_x: z.union([z.boolean(), z.string()]).optional(),
  flip_y: z.union([z.boolean(), z.string()]).optional(),
});

const loose = (shape: z.ZodRawShape) => z.looseObject(shape);

// ------------------------------------------------------------------ helpers

const result = (data: Obj): CallToolResult => ({
  structuredContent: data,
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const failure = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
});

const run = async (
  fn: () => Obj | Promise<Obj>,
  paths?: Map<string, string>,
): Promise<CallToolResult> => {
  try {
    return result(await fn());
  } catch (e) {
    if (e instanceof ToolError) return failure(e.code, e.message);
    if (e instanceof AgentRejected) {
      const r = e.rejected[0];
      const where = (r && paths?.get(r.id)) ?? (r ? `item ${r.id}` : "");
      const msg = r
        ? `${where}: the board refused it (${r.reason}${r.path ? ` at ${r.path}` : ""}${r.message ? `: ${r.message}` : ""}). Nothing was changed.`
        : "The board refused the change. Nothing was changed.";
      return failure(r?.reason === "scene_too_large" ? "scene_too_large" : "invalid_input", msg);
    }
    if (e instanceof ServiceError) {
      if (e.status === 404)
        return failure(
          "session_not_found",
          "No board with this session id. Check the id at the end of the board's URL (/s/<id>), or create a board with create_session.",
        );
      return failure(e.code, e.message);
    }
    throw e;
  }
};

const sessionId = (v: unknown) => {
  const id = typeof v === "string" ? parseSessionRef(v) : null;
  if (!id)
    throw new ToolError(
      "invalid_session_id",
      "session_id: not a ChalanaMaya session id. Pass the 24-character id after /s/ in the board URL, or the URL itself.",
    );
  return id;
};

const agent = (v: unknown) => {
  if (v === undefined || v === null || v === "") return DEFAULT_AGENT;
  const s = str(v, "agent_name", 60).trim();
  return s || DEFAULT_AGENT;
};

const idList = (v: unknown, path: string, min = 1, max = 1000): string[] => {
  if (!Array.isArray(v)) throw invalid(path, "must be a list of element ids");
  if (v.length < min || v.length > max) throw invalid(path, `must have ${min}–${max} ids`);
  return v.map((x, i) => str(x, `${path}[${i}]`, 64));
};

const requireIds = (
  els: readonly SceneElement[],
  ids: string[],
  path: string,
  opts: { unlocked?: boolean } = {},
) => {
  const map = new Map(els.map((e) => [e.id, e]));
  ids.forEach((id, i) => {
    const el = map.get(id);
    if (!el)
      throw invalid(
        `${path}[${i}]`,
        `no element "${id}" in this board. Call get_scene to see the current ids.`,
      );
    if (opts.unlocked && el.locked)
      throw new ToolError(
        "locked",
        `${path}[${i}]: ${id} is locked; unlock it first (update_elements with locked: false)`,
      );
  });
  return map;
};

const fileMap = (files: StoredFile[]) => new Map(files.map((f) => [f.id, f]));

const strictB64 = /^[A-Za-z0-9+/]*={0,2}$/;
const decodeBase64 = (v: unknown, path: string, max: number): Buffer => {
  if (typeof v !== "string" || !v) throw invalid(path, "must be base64 data");
  let s = v.trim();
  const m = /^data:[^;,]+;base64,/.exec(s);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\s+/g, "");
  if (!strictB64.test(s) || s.length % 4 === 1) throw invalid(path, "is not valid base64");
  const buf = Buffer.from(s, "base64");
  if (!buf.length) throw invalid(path, "is empty");
  if (buf.length > max)
    throw new ToolError(
      "too_large",
      `${path}: pictures can be at most ${Math.round(max / 1024 / 1024)} MB.`,
    );
  return buf;
};

const upload = (ctx: ToolContext, sid: string, data: unknown, mime: unknown, base: string) => {
  // "" for upload_media's own arguments, "source" inside place_media
  const path = (k: string) => (base ? `${base}.${k}` : k);
  const mimeType = mime === undefined ? undefined : str(mime, path("mime_type"), 100).toLowerCase();
  const isVideo = mimeType?.startsWith("video/") ?? false;
  const buf = decodeBase64(
    data,
    path("data_base64"),
    isVideo ? (ctx.maxVideoBytes ?? ctx.maxImageBytes) : ctx.maxImageBytes,
  );
  try {
    return ctx.service.addFile(sid, buf, mimeType);
  } catch (e) {
    if (e instanceof ServiceError && e.code === "unsupported_type")
      throw new ToolError(
        "unsupported_type",
        `${path("data_base64")}: ${e.message} Upload a PNG, JPEG, GIF or WebP picture or an MP4 or WebM video.`,
      );
    throw e;
  }
};

const created = (els: readonly SceneElement[], ids: { id: string; key?: string }[]) => {
  const map = new Map(els.map((e) => [e.id, e]));
  return ids.map(({ id, key }) => {
    const el = map.get(id)!;
    const b = getElementBounds(el);
    return {
      ...(key ? { key } : {}),
      id,
      type: el.type === "embed" ? "web_card" : el.type,
      x: Math.round(b.minX * 100) / 100,
      y: Math.round(b.minY * 100) / 100,
      width: Math.round((b.maxX - b.minX) * 100) / 100,
      height: Math.round((b.maxY - b.minY) * 100) / 100,
    };
  });
};

/** Records remote media links for one board (the server never fetches them). */
const linkerFor =
  (service: SessionService) =>
  (sid: string): BuildContext["addLink"] =>
  (url, mime) =>
    service.addRemoteFile(sid, url, mime);

const sessionUrl = (ctx: ToolContext, id: string) => `${ctx.baseUrl}/s/${id}`;

/** Builds the items of add_elements into `elements` (shared with place_media). */
const addItems = (
  elements: SceneElement[],
  files: Map<string, StoredFile>,
  inputs: unknown[],
  warnings: string[],
  paths: Map<string, string>,
  addLink?: BuildContext["addLink"],
) => {
  const ctx: BuildContext = {
    byId: new Map(elements.map((e) => [e.id, e])),
    keys: new Map(),
    files,
    warnings,
    groups: new Map(),
    cursor: freeSpace(elements),
    addLink,
  };
  const built: {
    el: SceneElement;
    label?: TextElement;
    raw: Obj;
    path: string;
    key?: string;
    contains?: string[];
  }[] = new Array(inputs.length);
  const seenKeys = new Set<string>();
  inputs.forEach((raw, i) => {
    const o = raw as Obj;
    if (o && typeof o === "object" && o.key !== undefined) {
      const key = str(o.key, `elements[${i}].key`, 64);
      if (seenKeys.has(key))
        throw invalid(`elements[${i}].key`, `"${key}" is used twice in this call`);
      seenKeys.add(key);
    }
  });
  // frames first (so `frame` refs to keys work), then other items, then connectors
  const rank = (raw: unknown) => {
    const t = (raw as Obj)?.type;
    return t === "frame" ? 0 : t === "arrow" || t === "line" ? 2 : 1;
  };
  const order = inputs.map((_, i) => i).sort((a, b) => rank(inputs[a]) - rank(inputs[b]) || a - b);
  for (const i of order) {
    const path = `elements[${i}]`;
    const raw = inputs[i] as Obj;
    let b = buildElement(raw, path, ctx);
    let el = place(b.el, raw, ctx);
    if (isLinear(el)) {
      const c = buildConnector(el, raw, path, ctx);
      el = c.el;
      b = { ...b, label: c.label };
    }
    const label = b.label ? { ...b.label, x: el.x, y: el.y } : undefined;
    const key = raw.key === undefined ? undefined : String(raw.key);
    if (key) ctx.keys.set(key, el.id);
    ctx.byId.set(el.id, el);
    paths.set(el.id, path);
    if (label) {
      ctx.byId.set(label.id, label);
      paths.set(label.id, `${path}.label`);
    }
    built[i] = { el, label, raw, path, key, contains: b.contains };
  }
  // frames adopt their `contains`
  const adopt = new Map<string, string>();
  for (const b of built) {
    if (!b.contains) continue;
    b.contains.forEach((ref, j) => {
      const id = ctx.keys.get(ref) ?? ref;
      const target = ctx.byId.get(id);
      if (!target) throw invalid(`${b.path}.contains[${j}]`, `no element or key "${ref}"`);
      if (target.locked)
        throw new ToolError("locked", `${b.path}.contains[${j}]: ${id} is locked; unlock it first`);
      if (target.type === "frame" || isBoundText(target))
        throw invalid(
          `${b.path}.contains[${j}]`,
          `a ${target.type === "frame" ? "frame" : "label"} cannot go inside a frame`,
        );
      adopt.set(id, b.el.id);
    });
  }
  const touched = new Set<string>();
  const out: SceneElement[] = elements.map((e) => {
    if (!adopt.has(e.id)) return e;
    touched.add(e.id);
    return { ...e, frameId: adopt.get(e.id)! };
  });
  const ids: { id: string; key?: string }[] = [];
  for (const b of built) {
    const el = adopt.has(b.el.id) ? { ...b.el, frameId: adopt.get(b.el.id)! } : b.el;
    out.push(el);
    touched.add(el.id);
    if (b.label) {
      out.push(b.label);
      touched.add(b.label.id);
    }
    ids.push({ id: el.id, key: b.key });
  }
  return { next: out, touched, ids };
};

// -------------------------------------------------------------------- tools

export const registerTools = (server: McpServer, ctx: ToolContext) => {
  const { service } = ctx;
  const linker = linkerFor(service);
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "create_session",
    {
      title: "Create a board",
      description:
        "Creates a new empty ChalanaMaya board and returns its session_id and URL. Give the URL to the person so they can watch you draw.",
      inputSchema: { title: z.string().optional().describe("Board title (≤ 120 characters).") },
      outputSchema: { session_id: z.string(), url: z.string() },
      annotations: write,
    },
    (args) =>
      run(() => {
        const title = args.title === undefined ? "" : str(args.title, "title", LIMITS.title).trim();
        const { sessionId: id } = service.create(title);
        return { session_id: id, url: sessionUrl(ctx, id) };
      }),
  );

  server.registerTool(
    "get_session_info",
    {
      title: "Board info",
      description:
        "Title, revision, item count, open browser tabs, content bounds, background and grid of a board.",
      inputSchema: { session_id: sessionArg },
      outputSchema: loose({ session_id: z.string(), url: z.string(), rev: z.number() }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const snap = service.snapshot(sid);
        const els = snap.elements.map((e) => e.el);
        return {
          session_id: sid,
          url: sessionUrl(ctx, sid),
          title: snap.title,
          rev: snap.rev,
          element_count: els.filter((e) => !isBoundText(e)).length,
          open_tabs: ctx.peers(sid),
          bounds: boundsOut(getCommonBounds(els)),
          background: snap.settings.viewBackgroundColor ?? "#fff9ed",
          grid: snap.settings.gridEnabled ?? false,
        };
      }),
  );

  server.registerTool(
    "update_session",
    {
      title: "Change board settings",
      description:
        "Sets the board title, background colour (paper, white, mist, peach, slate or #hex) and grid.",
      inputSchema: {
        session_id: sessionArg,
        title: z.string().optional(),
        background: z.string().optional(),
        grid: z.union([z.boolean(), z.string()]).optional(),
        agent_name: agentArg,
      },
      outputSchema: loose({ rev: z.number() }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const settings: Obj = {};
        if (args.title !== undefined)
          settings.title = str(args.title, "title", LIMITS.title).trim();
        if (args.background !== undefined)
          settings.viewBackgroundColor = boardColor(args.background, "background");
        if (args.grid !== undefined) settings.gridEnabled = bool(args.grid, "grid");
        if (!Object.keys(settings).length)
          throw invalid("", "give at least one of title, background or grid");
        const snap = service.snapshot(sid);
        const { ack } = service.apply(
          sid,
          {
            pushId: crypto.randomUUID().replace(/-/g, ""),
            baseRev: snap.rev,
            ops: [{ t: "settings", settings }],
          },
          { origin: { kind: "agent", name: agent(args.agent_name) }, atomic: true },
        );
        if (ack.rejected.length)
          throw invalid(ack.rejected[0].path ?? "", ack.rejected[0].message ?? "refused");
        const after = service.snapshot(sid);
        return {
          rev: ack.rev,
          title: after.title,
          background: after.settings.viewBackgroundColor ?? "#fff9ed",
          grid: after.settings.gridEnabled ?? false,
        };
      }),
  );

  server.registerTool(
    "get_scene",
    {
      title: "Read the board",
      description:
        'Reads the board. format "json" (default) returns compact items (labels folded into their box, only non-default fields); format "outline" returns one line per item. detail "full" returns every field in the input names, round-trippable through update_elements (needs ids, at most 50). Filter with ids, region or query; page with limit and next_cursor. free_space is a good top-left for new items.',
      inputSchema: {
        session_id: sessionArg,
        format: z.string().optional().describe("json | outline"),
        detail: z
          .string()
          .optional()
          .describe("compact | full (full needs ids, ≤ 50, and format json)"),
        ids: z.array(z.string()).optional(),
        region: z.looseObject({ x: n, y: n, width: n, height: n }).optional(),
        query: z
          .string()
          .optional()
          .describe("Only items whose text, label or frame name contains this."),
        limit: n.optional().describe("Items per page (≤ 500, default 200)."),
        cursor: z.string().optional().describe("next_cursor from the previous page."),
      },
      outputSchema: loose({ rev: z.number() }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const format =
          args.format === undefined ? "json" : oneOf(args.format, "format", ["json", "outline"]);
        const detail =
          args.detail === undefined ? "compact" : oneOf(args.detail, "detail", ["compact", "full"]);
        const ids = args.ids === undefined ? undefined : idList(args.ids, "ids", 1, 1000);
        if (detail === "full") {
          if (!ids)
            throw invalid(
              "detail",
              '"full" needs ids (at most 50); read the compact view first to find them',
            );
          if (ids.length > 50) throw invalid("ids", 'detail "full" takes at most 50 ids per call');
          if (format !== "json")
            throw invalid("format", 'detail "full" works with format "json" only');
        }
        const region = args.region
          ? {
              x: num(args.region.x, "region.x"),
              y: num(args.region.y, "region.y"),
              width: num(args.region.width, "region.width", { min: 0 }),
              height: num(args.region.height, "region.height", { min: 0 }),
            }
          : undefined;
        const limit =
          args.limit === undefined
            ? 200
            : Math.floor(num(args.limit, "limit", { min: 1, max: 500 }));
        const query = args.query === undefined ? undefined : str(args.query, "query", 200);
        const snap = service.snapshot(sid);
        if (ids) {
          const known = new Set(snap.elements.map((e) => e.el.id));
          const missing = ids.filter((id) => !known.has(id));
          if (missing.length && detail === "full")
            throw invalid(
              "ids",
              `no element ${missing.map((m) => `"${m}"`).join(", ")} in this board`,
            );
        }
        return queryScene(snap, {
          format,
          detail,
          ids,
          region,
          query,
          limit,
          cursor: args.cursor,
        }) as Obj;
      }),
  );

  server.registerTool(
    "add_elements",
    {
      title: "Add items",
      description:
        "Adds 1–200 items in one atomic change. Coordinates are board units, top-left of each box; omit x/y to place in free space. Give items a key and refer to it in arrow from/to, frame or contains in the same call. Connectors attach to the outline of the items they point at and stay attached when those move.",
      inputSchema: {
        session_id: sessionArg,
        elements: z.array(elementInput),
        agent_name: agentArg,
      },
      outputSchema: loose({
        rev: z.number(),
        created: z.array(z.looseObject({ id: z.string() })),
        warnings: z.array(z.string()),
      }),
      annotations: write,
    },
    (args) => {
      const paths = new Map<string, string>();
      return run(() => {
        const sid = sessionId(args.session_id);
        const inputs = args.elements as unknown[];
        if (!inputs.length || inputs.length > 200)
          throw invalid("elements", "must have 1–200 items");
        const warnings: string[] = [];
        const r = service.applyAgentChange(
          sid,
          (els, snap) => {
            const a = addItems(els, fileMap(snap.files), inputs, warnings, paths, linker(sid));
            return { next: a.next, touched: a.touched, result: a.ids };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev, created: created(r.elements, r.result), warnings };
      }, paths);
    },
  );

  server.registerTool(
    "update_elements",
    {
      title: "Change items",
      description:
        'Changes 1–200 existing items in one atomic change: text, label, name, url, points (absolute, the whole path), from/to, geometry, style, locked, link. Elements from get_scene detail "full" can be sent back as they are. Locked items are refused unless the update has locked: false.',
      inputSchema: { session_id: sessionArg, updates: z.array(updateInput), agent_name: agentArg },
      outputSchema: loose({
        rev: z.number(),
        updated: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
      annotations: write,
    },
    (args) => {
      const paths = new Map<string, string>();
      return run(() => {
        const sid = sessionId(args.session_id);
        const updates = args.updates as unknown[];
        if (!updates.length || updates.length > 200)
          throw invalid("updates", "must have 1–200 updates");
        const warnings: string[] = [];
        const r = service.applyAgentChange(
          sid,
          (els, snap) => {
            let next = [...els];
            const index = new Map(next.map((e, i) => [e.id, i]));
            const ctx: BuildContext = {
              byId: new Map(next.map((e) => [e.id, e])),
              keys: new Map(),
              files: fileMap(snap.files),
              warnings,
              groups: new Map(),
              cursor: freeSpace(els),
              addLink: linker(sid),
            };
            const touched = new Set<string>();
            const updated: string[] = [];
            const removeLabels = new Set<string>();
            const addLabels: TextElement[] = [];
            updates.forEach((raw, i) => {
              const path = `updates[${i}]`;
              if (!raw || typeof raw !== "object") throw invalid(path, "must be an object");
              const o = raw as Obj;
              const id = str(o.id, `${path}.id`, 64);
              const at = index.get(id);
              if (at === undefined)
                throw invalid(
                  `${path}.id`,
                  `no element "${id}" in this board. Call get_scene to see the current ids.`,
                );
              const cur = next[at];
              const labels = labelsByContainer(next);
              const res = updateElement(cur, o, path, ctx, labels.get(id));
              paths.set(id, path);
              // a moved frame takes its contents along
              if (cur.type === "frame" && (res.el.x !== cur.x || res.el.y !== cur.y)) {
                const kids = new Set(
                  next.filter((e) => e.frameId === id && !e.locked).map((e) => e.id),
                );
                if (kids.size) {
                  next = moveElements(next, kids, res.el.x - cur.x, res.el.y - cur.y);
                  for (const k of withBoundTexts(next, kids)) touched.add(k);
                }
              }
              next[at] = res.el;
              ctx.byId.set(id, res.el);
              touched.add(id);
              updated.push(id);
              if (res.label === null) {
                const l = labels.get(id)!;
                removeLabels.add(l.id);
              } else if (res.label) {
                const l = labels.get(id);
                if (l) {
                  next[index.get(l.id)!] = res.label;
                  touched.add(l.id);
                } else addLabels.push(res.label);
              }
              if (cur.type === "text" && cur.containerId) touched.add(cur.containerId);
            });
            if (removeLabels.size) next = next.filter((e) => !removeLabels.has(e.id));
            for (const l of addLabels) {
              const at2 = next.findIndex((e) => e.id === l.containerId);
              next.splice(at2 + 1, 0, l);
              touched.add(l.id);
            }
            return { next, touched, result: updated };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev, updated: r.result, warnings };
      }, paths);
    },
  );

  server.registerTool(
    "move_elements",
    {
      title: "Move items",
      description:
        "Moves items by dx/dy, or so the top-left of their combined box lands at to {x, y}. Groups move as one; frame contents, labels and attached connector ends follow.",
      inputSchema: {
        session_id: sessionArg,
        ids: idsArg,
        dx: n.optional(),
        dy: n.optional(),
        to: z.looseObject({ x: n, y: n }).optional(),
        agent_name: agentArg,
      },
      outputSchema: loose({ rev: z.number(), moved: z.array(z.string()) }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids");
        if (args.to === undefined && args.dx === undefined && args.dy === undefined)
          throw invalid("", "give dx/dy or to {x, y}");
        const r = service.applyAgentChange(
          sid,
          (els) => {
            requireIds(els, ids, "ids", { unlocked: true });
            const set = expandGroups(els, ids);
            const sel = els.filter((e) => set.has(e.id));
            const b = getCommonBounds(sel)!;
            let dx = 0,
              dy = 0;
            if (args.to !== undefined) {
              dx = num(args.to.x, "to.x", { min: -1e6, max: 1e6 }) - b.minX;
              dy = num(args.to.y, "to.y", { min: -1e6, max: 1e6 }) - b.minY;
            } else {
              dx = args.dx === undefined ? 0 : num(args.dx, "dx", { min: -1e6, max: 1e6 });
              dy = args.dy === undefined ? 0 : num(args.dy, "dy", { min: -1e6, max: 1e6 });
            }
            const moving = withBoundTexts(els, withDependents(els, set));
            const next = moveElements(els, set, dx, dy);
            return { next, touched: moving, result: [...set] };
          },
          agent(args.agent_name),
        );
        const moved = new Set(r.result);
        return {
          rev: r.rev,
          moved: r.result,
          bounds: boundsOut(getCommonBounds(r.elements.filter((e) => moved.has(e.id)))),
        };
      }),
  );

  server.registerTool(
    "set_style",
    {
      title: "Style items",
      description:
        "Applies style fields to items. Text fields (font, font_size, text_align) on a box style its label. Fields that do not apply to an item are listed in skipped.",
      inputSchema: {
        session_id: sessionArg,
        ids: idsArg,
        style: z.looseObject(styleShape),
        agent_name: agentArg,
      },
      outputSchema: loose({ rev: z.number(), updated: z.array(z.string()) }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids");
        const style = args.style as Obj;
        const warnings: string[] = [];
        for (const k of Object.keys(style))
          if (!(STYLE_FIELDS as readonly string[]).includes(k))
            warnings.push(`style.${k}: unknown field, ignored`);
        const skippedOut: { id: string; reason: string }[] = [];
        const r = service.applyAgentChange(
          sid,
          (els) => {
            requireIds(els, ids, "ids", { unlocked: true });
            const labels = labelsByContainer(els);
            const textKeys = ["font", "font_size", "text_align"];
            const touched = new Set<string>();
            const byId = new Map<string, SceneElement>();
            for (const id of ids) {
              const el = els.find((e) => e.id === id)!;
              const skipped: string[] = [];
              const label = labels.get(id);
              const own: Obj = {};
              const lab: Obj = {};
              for (const [k, v] of Object.entries(style)) {
                if (!(STYLE_FIELDS as readonly string[]).includes(k)) continue;
                if (textKeys.includes(k) && el.type !== "text") {
                  if (label) lab[k] = v;
                  else skipped.push(`${k}: only text and labels have it`);
                } else own[k] = v;
              }
              if (label && own.stroke !== undefined && isTextContainer(el)) lab.stroke = own.stroke;
              byId.set(id, applyStyle(el, own, "style", skipped));
              touched.add(id);
              if (label && Object.keys(lab).length) {
                byId.set(label.id, applyStyle(label, lab, "style"));
                touched.add(label.id);
              }
              for (const s of skipped) skippedOut.push({ id, reason: s });
            }
            const next = els.map((e) => {
              const u = byId.get(e.id);
              if (!u) return e;
              return u.type === "text" && !u.containerId ? layoutText(u) : u;
            });
            return { next, touched, result: ids };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev, updated: r.result, skipped: skippedOut, warnings };
      }),
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Delete items",
      description:
        "Deletes items. Labels go with their box; connectors to deleted items come loose.",
      inputSchema: { session_id: sessionArg, ids: idsArg, agent_name: agentArg },
      outputSchema: loose({ rev: z.number(), deleted: z.array(z.string()) }),
      annotations: { ...write, destructiveHint: true },
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids");
        const r = service.applyAgentChange(
          sid,
          (els) => {
            requireIds(els, ids, "ids", { unlocked: true });
            const next = deleteElements(els, ids);
            const left = new Set(next.map((e) => e.id));
            return {
              next,
              touched: [],
              result: els.filter((e) => !left.has(e.id)).map((e) => e.id),
            };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev, deleted: r.result };
      }),
  );

  server.registerTool(
    "group_elements",
    {
      title: "Group items",
      description: "Groups 2 or more items so they move and select together. Returns the group id.",
      inputSchema: { session_id: sessionArg, ids: idsArg, agent_name: agentArg },
      outputSchema: loose({ rev: z.number() }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids", 2);
        const r = service.applyAgentChange(
          sid,
          (els) => {
            requireIds(els, ids, "ids", { unlocked: true });
            const next = groupElements(els, new Set(ids));
            if (!next) throw invalid("ids", "needs at least 2 items that are not labels");
            const g = next.find((e) => e.id === ids[0])!;
            return { next, touched: [], result: g.groupIds[g.groupIds.length - 1] };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev, group_id: r.result };
      }),
  );

  server.registerTool(
    "ungroup_elements",
    {
      title: "Ungroup items",
      description: "Removes the outermost group of the given items (element ids or a group id).",
      inputSchema: { session_id: sessionArg, ids: idsArg, agent_name: agentArg },
      outputSchema: loose({ rev: z.number() }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids");
        const r = service.applyAgentChange(
          sid,
          (els) => {
            const groupIds = new Set(els.flatMap((e) => e.groupIds));
            const elIds = ids.filter((id) => !groupIds.has(id) || els.some((e) => e.id === id));
            requireIds(els, elIds, "ids", { unlocked: true });
            const set = expandGroups(els, elIds);
            for (const id of ids)
              if (groupIds.has(id)) for (const e of els) if (e.groupIds.includes(id)) set.add(e.id);
            const next = ungroupElements(els, set);
            if (!next) throw invalid("ids", "none of these items is in a group");
            return { next, touched: [], result: null };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev };
      }),
  );

  server.registerTool(
    "reorder_elements",
    {
      title: "Change layer order",
      description: "Moves items to the front, the back, one step forward or one step backward.",
      inputSchema: {
        session_id: sessionArg,
        ids: idsArg,
        to: z.string().describe("front | back | forward | backward"),
        agent_name: agentArg,
      },
      outputSchema: loose({ rev: z.number() }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids");
        const to = oneOf(args.to, "to", ["front", "back", "forward", "backward"]);
        const r = service.applyAgentChange(
          sid,
          (els) => {
            requireIds(els, ids, "ids", { unlocked: true });
            const set = new Set(ids);
            const next = reorder(els, set, to);
            if (!next) throw invalid("ids", "nothing to move");
            return {
              next,
              touched: [],
              hint: { kind: to, ids: withBoundTexts(els, set) },
              result: null,
            };
          },
          agent(args.agent_name),
        );
        return { rev: r.rev };
      }),
  );

  server.registerTool(
    "arrange_elements",
    {
      title: "Align and distribute",
      description:
        "Aligns items (left, center, right, top, middle, bottom) and/or distributes them horizontally or vertically. With gap, items are laid out with exactly that spacing in their current order.",
      inputSchema: {
        session_id: sessionArg,
        ids: idsArg,
        align: z.string().optional(),
        distribute: z.string().optional(),
        gap: n.optional(),
        agent_name: agentArg,
      },
      outputSchema: loose({ rev: z.number() }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const ids = idList(args.ids, "ids", 2);
        const align =
          args.align === undefined
            ? undefined
            : oneOf(args.align, "align", ["left", "center", "right", "top", "middle", "bottom"]);
        const distribute =
          args.distribute === undefined
            ? undefined
            : oneOf(args.distribute, "distribute", ["horizontal", "vertical"]);
        const gap =
          args.gap === undefined ? undefined : num(args.gap, "gap", { min: 0, max: 100_000 });
        if (!align && !distribute) throw invalid("", "give align and/or distribute");
        if (gap !== undefined && !distribute) throw invalid("gap", "works with distribute");
        const r = service.applyAgentChange(
          sid,
          (els) => {
            requireIds(els, ids, "ids", { unlocked: true });
            const set = expandGroups(els, ids);
            let next: SceneElement[] = [...els];
            if (align) {
              const mode =
                ({ center: "hcenter", middle: "vcenter" } as const)[align as "center" | "middle"] ??
                align;
              next = alignElements(next, set, mode as "left") ?? next;
            }
            if (distribute) next = distributeWithGap(next, set, distribute, gap);
            return { next, touched: withBoundTexts(next, withDependents(next, set)), result: null };
          },
          agent(args.agent_name),
        );
        return {
          rev: r.rev,
          bounds: boundsOut(getCommonBounds(r.elements.filter((e) => ids.includes(e.id)))),
        };
      }),
  );

  server.registerTool(
    "clear_scene",
    {
      title: "Clear the board",
      description:
        "Removes every item from the board, locked ones too (like Clear canvas). Needs confirm: true. People on the board get a notice with Restore.",
      inputSchema: {
        session_id: sessionArg,
        confirm: z.union([z.boolean(), z.string()]),
        agent_name: agentArg,
      },
      outputSchema: loose({ rev: z.number(), deleted_count: z.number() }),
      annotations: { ...write, destructiveHint: true },
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        if (bool(args.confirm, "confirm") !== true)
          throw invalid("confirm", "must be true to clear the board");
        const r = service.applyAgentChange(
          sid,
          (els) => ({ next: [], touched: [], result: els.filter((e) => !isBoundText(e)).length }),
          agent(args.agent_name),
        );
        return { rev: r.rev, deleted_count: r.result };
      }),
  );

  server.registerTool(
    "upload_media",
    {
      title: "Upload a picture or video",
      description:
        "Uploads a PNG, JPEG, GIF or WebP picture (≤ 10 MB decoded) or an MP4 or WebM video (≤ 25 MB decoded) to the board and returns its file_id for place_media or an image / gif / video item.",
      inputSchema: {
        session_id: sessionArg,
        data_base64: z.string().describe("The file as base64 (a data: URL prefix is accepted)."),
        mime_type: z
          .string()
          .optional()
          .describe("image/png, image/jpeg, image/gif, image/webp, video/mp4 or video/webm"),
        filename: z.string().optional(),
        agent_name: agentArg,
      },
      outputSchema: loose({ file_id: z.string(), mime_type: z.string(), size: z.number() }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        if (args.filename !== undefined) str(args.filename, "filename", 255);
        service.meta(sid);
        const f = upload(ctx, sid, args.data_base64, args.mime_type, "");
        return {
          file_id: f.id,
          mime_type: f.mime,
          size: f.size,
          width: f.width,
          height: f.height,
          duration_ms: f.durationMs,
        };
      }),
  );

  server.registerTool(
    "place_media",
    {
      title: "Place a picture, GIF or video",
      description:
        'Places a picture, GIF or video on the board. source is {file_id} (from upload_media), {data_base64, mime_type} or {url} (an https link to the media file; browsers show it live and the server never fetches it; links are left out of PNG exports and shown as a placeholder). kind is "image" (default), "gif" or "video"; videos start muted and looping (autoplay, loop).',
      inputSchema: {
        session_id: sessionArg,
        kind: z.string().optional().describe('"image" (default), "gif" or "video"'),
        source: z.looseObject({
          file_id: z.string().optional(),
          data_base64: z.string().optional(),
          mime_type: z.string().optional(),
          url: z
            .string()
            .optional()
            .describe(
              "https link to the file (public site names only; no IP addresses or local names). Give mime_type when the address has no file extension.",
            ),
        }),
        x: n.optional(),
        y: n.optional(),
        width: n.optional(),
        height: n.optional(),
        autoplay: z.union([z.boolean(), z.string()]).optional(),
        loop: z.union([z.boolean(), z.string()]).optional(),
        agent_name: agentArg,
      },
      outputSchema: loose({
        rev: z.number(),
        id: z.string(),
        file_id: z.string(),
        warnings: z.array(z.string()),
      }),
      annotations: write,
    },
    (args) =>
      run(() => {
        const sid = sessionId(args.session_id);
        const kind =
          args.kind === undefined ? "image" : oneOf(args.kind, "kind", ["image", "gif", "video"]);
        const src = args.source as Obj;
        const warnings: string[] = [];
        if (kind !== "video") {
          if (args.autoplay !== undefined) warnings.push("autoplay: only videos autoplay; ignored");
          if (args.loop !== undefined) warnings.push("loop: only videos loop; ignored");
        }
        service.meta(sid);
        let fileId: string;
        const given = ["file_id", "data_base64", "url"].filter((k) => src[k] !== undefined);
        if (given.length > 1) throw invalid("source", `give only one of ${given.join(", ")}`);
        if (src.file_id !== undefined) fileId = str(src.file_id, "source.file_id", 128);
        else if (src.data_base64 !== undefined)
          fileId = upload(ctx, sid, src.data_base64, src.mime_type, "source").id;
        else if (src.url !== undefined) {
          warnings.push(
            "source.url: links are shown live in the browser and as a placeholder card in PNG/SVG exports; upload the file (upload_media) for full support",
          );
          fileId = linkFile(
            { files: new Map(), addLink: linker(sid) } as unknown as BuildContext,
            src.url,
            src.mime_type,
            kind,
            "source",
          ).id;
        } else
          throw invalid(
            "source",
            "give {file_id} from upload_media, {data_base64, mime_type} or {url} (an https link)",
          );
        const item: Obj = { type: kind, file_id: fileId };
        for (const k of ["x", "y", "width", "height"] as const)
          if (args[k] !== undefined) item[k] = args[k];
        if (kind === "video")
          for (const k of ["autoplay", "loop"] as const)
            if (args[k] !== undefined)
              item[k] = typeof args[k] === "string" ? args[k] === "true" : args[k];
        const r = service.applyAgentChange(
          sid,
          (els, snap) => {
            const files = fileMap(snap.files);
            const f = files.get(fileId);
            if (f && item.width === undefined && item.height === undefined)
              Object.assign(item, mediaSize(f, {}));
            const a = addItems(els, files, [item], warnings, new Map());
            return { next: a.next, touched: a.touched, result: a.ids[0].id };
          },
          agent(args.agent_name),
        );
        return {
          rev: r.rev,
          id: r.result,
          file_id: fileId,
          warnings: warnings.map((w) => w.replace(/^elements\[0\]\./, "")),
        };
      }),
  );

  server.registerTool(
    "list_component_presets",
    {
      title: "Component presets",
      description:
        "Lists the animated component presets. Animated components arrive in a later version; the list is empty for now.",
      inputSchema: { session_id: sessionArg.optional() },
      outputSchema: loose({ presets: z.array(z.unknown()) }),
      annotations: { readOnlyHint: true },
    },
    () =>
      run(() => ({
        presets: [],
        note: "Animated components arrive in a later version of ChalanaMaya.",
      })),
  );
};

/** Distribute with an optional exact gap (units = outer groups). */
const distributeWithGap = (
  els: SceneElement[],
  set: Set<string>,
  axis: "horizontal" | "vertical",
  gap: number | undefined,
): SceneElement[] => {
  const units = new Map<string, SceneElement[]>();
  for (const e of els) {
    if (!set.has(e.id) || e.locked || isBoundText(e)) continue;
    const key = e.groupIds[e.groupIds.length - 1] ?? e.id;
    units.set(key, [...(units.get(key) ?? []), e]);
  }
  const list = [...units.values()].map((u) => ({
    ids: new Set(u.map((e) => e.id)),
    b: getCommonBounds(u)!,
  }));
  if (list.length < 2) return els;
  const h = axis === "horizontal";
  list.sort((a, b) => (h ? a.b.minX - b.b.minX : a.b.minY - b.b.minY));
  const size = (b: (typeof list)[number]["b"]) => (h ? b.maxX - b.minX : b.maxY - b.minY);
  let g = gap;
  if (g === undefined) {
    if (list.length < 3) return els;
    const first = list[0].b;
    const last = list[list.length - 1].b;
    const span = h ? last.maxX - first.minX : last.maxY - first.minY;
    g = (span - list.reduce((s, u) => s + size(u.b), 0)) / (list.length - 1);
  }
  let cursor = h ? list[0].b.minX : list[0].b.minY;
  let next = els;
  for (const u of list) {
    const d = cursor - (h ? u.b.minX : u.b.minY);
    if (d) next = moveElements(next, u.ids, h ? d : 0, h ? 0 : d);
    cursor += size(u.b) + g;
  }
  return next;
};
