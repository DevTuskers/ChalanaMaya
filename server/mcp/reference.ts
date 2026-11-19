/**
 * MCP reference data and prompt/resource definitions (plan §5.5). Pure data and
 * small closures only — no fs, no SDK — so the same registrations serve the
 * Node SDK endpoint (guide.ts) and the Workers JSON-RPC dispatcher
 * (worker/mcp.ts). The guide text is the portable skill
 * (skills/chalanamaya/SKILL.md), embedded by guideText.ts.
 */
import { z } from "zod";
import {
  COMPONENT_LIMITS,
  COMPONENT_RULES,
  PRESET_NAMES,
  PRESETS,
} from "../../src/shared/components";
import { BOARD_COLORS } from "../../src/scene/constants";
import { parseSessionRef } from "../../src/shared/ids";
import type { SessionService } from "../sessions/service";
import { INPUT_TYPES } from "./elements";
import { FILL_NAMES, NOTE_NAMES, STROKE_NAMES } from "./palette";
import { queryScene } from "./view";
import GUIDE_TEXT from "./guideText";

export const INSTRUCTIONS =
  "ChalanaMaya is a whiteboard. Every board is a session; its URL ends in /s/<session_id>. " +
  "Pass that id (or the URL) as session_id. Coordinates are board units, x right, y down, boxes by top-left corner. " +
  "Read with get_scene, add with add_elements (keys + from/to for connectors), pass agent_name. " +
  "Read the chalanamaya://guide resource for layout rules and recipes. " +
  "The MCP protocol session is unrelated to the board session_id.";

export const guideText = () => GUIDE_TEXT;

export const ELEMENTS_REFERENCE = {
  coordinates:
    "Board units; x grows right, y grows down; boxes by top-left corner; angle in degrees clockwise; path points absolute [x, y].",
  types: INPUT_TYPES,
  common_fields: {
    key: "name to refer to this item later in the same call",
    x: "number (±1,000,000); omit to place in free space",
    y: "number",
    width: "1–100,000",
    height: "1–100,000",
    angle: "degrees",
    locked: "boolean",
    link: 'http(s), mailto or "#el=<id>"',
    group: "items in one call with the same group name are grouped",
    frame: "id or key of a frame to put the item in",
    stroke: "palette name or #hex",
    fill: "palette name, none or #hex",
    fill_style: "hachure | cross-hatch | zigzag | solid",
    stroke_width: "thin | bold | extra-bold | 0.5–32",
    stroke_style: "solid | dashed | dotted",
    roughness: "tidy | sketchy | wobbly",
    edges: "sharp | round",
    opacity: "0–100",
    font: "hand | normal | code (text and labels)",
    font_size: "s | m | l | xl | 8–400",
    text_align: "left | center | right (free text)",
  },
  per_type: {
    rectangle: { label: "text inside" },
    diamond: { label: "text inside" },
    ellipse: { label: "text inside" },
    text: { text: "required; give width to wrap" },
    note: { text: "its text", color: "butter | apricot | seafoam | mist | blush | #hex" },
    frame: { name: "title", contains: "ids/keys to put inside" },
    arrow: {
      from: "id/key (attached) or [x, y] (free)",
      to: "id/key or [x, y]",
      points: "bend points between from and to (in update_elements: the whole path)",
      label: "text on the connector",
      routing: "straight | curved | elbow",
      start_arrowhead: "none | arrow | bar | circle | triangle | diamond | er-* …",
      end_arrowhead: "default arrow",
    },
    line: { points: "2–1,000 absolute points", closed: "boolean" },
    freedraw: { points: "[x, y] or [x, y, pressure], ≤ 5,000" },
    image: {
      file_id: "from upload_media",
      url: "or an https link to a picture (shown live, never fetched by the server)",
      mime_type: "the link's type when its address has no extension",
    },
    gif: { file_id: "an uploaded image/gif", url: "or an https link", paused: "boolean" },
    video: {
      file_id: "an uploaded MP4/WebM",
      url: "or an https link",
      paused: "boolean",
      loop: "boolean (default true)",
      autoplay: "boolean (default true); videos are always muted at first",
    },
    web_card: { url: "http(s) page address" },
    component: {
      preset: `built-in animation: ${PRESET_NAMES.join(" | ")} (see list_component_presets)`,
      params: 'preset parameters, e.g. {color: "#007f78", speed: 2}',
      html: "or custom body HTML (≤ 20 KB, no scripts, links, frames, forms or <style>)",
      css: "custom CSS with @keyframes (≤ 20 KB, no @import, url() only data: pictures)",
      title: "short title (shown on exported cards)",
      paused: "boolean (paused for everyone)",
    },
  },
  examples: [
    {
      type: "rectangle",
      key: "a",
      x: 80,
      y: 80,
      label: "Start",
      fill: "mint",
      fill_style: "solid",
    },
    { type: "arrow", from: "a", to: "b", label: "next" },
    { type: "note", x: 400, y: 80, text: "A comment", color: "butter" },
    { type: "component", preset: "spinner", params: { color: "#007f78" }, x: 80, y: 300 },
  ],
};

/** The component presets and custom-content rules (tool and resource). */
export const componentPresetsReference = () => ({
  presets: PRESETS.map((p) => ({
    name: p.name,
    title: p.title,
    description: p.description,
    default_size: { width: p.width, height: p.height },
    params: p.params.map((q) => ({
      name: q.name,
      type: q.type,
      default: q.default,
      description: q.description,
      ...(q.min !== undefined ? { min: q.min, max: q.max } : {}),
      ...(q.choices ? { choices: q.choices } : {}),
    })),
  })),
  custom: {
    how: 'add_elements {type: "component", html, css, title}',
    limits: { html_bytes: COMPONENT_LIMITS.contentBytes, css_bytes: COMPONENT_LIMITS.contentBytes },
    rules: COMPONENT_RULES,
    note: "Components run in a sandboxed frame with no scripts and no network; they are look-only. Exports show a static card with the title.",
  },
});

export const PALETTE_REFERENCE = {
  stroke: STROKE_NAMES,
  fill: FILL_NAMES,
  note: NOTE_NAMES,
  board: BOARD_COLORS.map((c) => ({ name: c.label.toLowerCase(), light: c.light, dark: c.dark })),
  meaning:
    "lagoon/mint for the main path, clay/peach for attention or decisions, berry/rose for errors and risks, notes for comments. On dark boards ink is shown light automatically.",
};

const json = (uri: string, data: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

const promptText = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

type Obj = Record<string, unknown>;

export interface PromptResult {
  messages: {
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }[];
}

export interface ResourceResult {
  contents: { uri: string; text?: string; blob?: string; mimeType?: string }[];
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  argsSchema: Obj;
  run: (args: Record<string, string>) => PromptResult;
}

export interface ResourceDef {
  name: string;
  uri?: string;
  uriTemplate?: string;
  title: string;
  mimeType: string;
  read: (uri: URL, vars: Record<string, string | string[]>) => ResourceResult;
}

export const PROMPTS: PromptDef[] = [
  {
    name: "draw_diagram",
    title: "Draw a diagram",
    description: "Step-by-step instructions to draw a diagram on a board.",
    argsSchema: {
      session_id: z.string().describe("Board session id or URL"),
      description: z.string().describe("What to draw"),
      kind: z
        .string()
        .optional()
        .describe("flowchart, mind map, sequence, architecture, timeline, wireframe or freeform"),
    },
    run: ({ session_id, description, kind }) =>
      promptText(
        [
          `Draw ${kind ? `a ${kind}` : "a diagram"} on the ChalanaMaya board ${session_id}: ${description}`,
          "",
          '1. Call get_scene (format "outline") to see what is on the board and where free_space is.',
          "2. Plan a grid in board units: 40-unit grid, boxes 160×80, 80 between boxes, 160 between rows; x grows right, y grows down, items by their top-left corner.",
          "3. Add all items with add_elements in one or two batches. Give each item a key and connect with arrows using from/to keys in the same call. Pass agent_name.",
          "4. Call get_scene again to check the result; fix overlaps with move_elements or arrange_elements.",
          "5. Tell the person what you drew. Read the chalanamaya://guide resource for recipes and colours.",
        ].join("\n"),
      ),
  },
  {
    name: "explain_board",
    title: "Explain a board",
    description: "Reads a board and summarises it.",
    argsSchema: { session_id: z.string().describe("Board session id or URL") },
    run: ({ session_id }) =>
      promptText(
        `Call get_scene on the ChalanaMaya board ${session_id} with format "outline" (page with next_cursor if needed). Then explain what the board shows: its parts, how they connect (connectors list "from → to"), and any notes. Do not change the board.`,
      ),
  },
  {
    name: "tidy_board",
    title: "Tidy a board",
    description: "Aligns, distributes and fixes overlaps on a board.",
    argsSchema: { session_id: z.string().describe("Board session id or URL") },
    run: ({ session_id }) =>
      promptText(
        `Tidy the ChalanaMaya board ${session_id}. Read it with get_scene, find rows and columns of items that are almost aligned, and use arrange_elements (align, distribute with a gap of 80) and move_elements to line them up and remove overlaps. Do not delete or restyle anything, and leave locked items alone. Pass agent_name.`,
      ),
  },
  {
    name: "chalanamaya_guide",
    title: "ChalanaMaya drawing guide",
    description: "The drawing guide for agents.",
    argsSchema: {},
    run: () => promptText(guideText()),
  },
];

const STATIC_RESOURCES: ResourceDef[] = [
  {
    name: "guide",
    uri: "chalanamaya://guide",
    title: "ChalanaMaya drawing guide",
    mimeType: "text/markdown",
    read: (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: guideText() }],
    }),
  },
  {
    name: "elements-reference",
    uri: "chalanamaya://reference/elements",
    title: "Element input reference",
    mimeType: "application/json",
    read: (uri) => json(uri.href, ELEMENTS_REFERENCE),
  },
  {
    name: "palette",
    uri: "chalanamaya://reference/palette",
    title: "Colour names",
    mimeType: "application/json",
    read: (uri) => json(uri.href, PALETTE_REFERENCE),
  },
  {
    name: "component-presets",
    uri: "chalanamaya://reference/component-presets",
    title: "Component presets",
    mimeType: "application/json",
    read: (uri) => json(uri.href, componentPresetsReference()),
  },
];

export const resourceDefs = (service: SessionService): ResourceDef[] => {
  const boardView =
    (format: "json" | "outline") => (uri: URL, vars: Record<string, string | string[]>) => {
      const raw = Array.isArray(vars.session_id) ? vars.session_id[0] : vars.session_id;
      const sid = parseSessionRef(decodeURIComponent(raw ?? ""));
      if (!sid) throw new Error("Not a ChalanaMaya session id.");
      const snap = service.snapshot(sid);
      const view = queryScene(snap, { format, detail: "compact", limit: 500 });
      if (format === "outline")
        return {
          contents: [
            { uri: uri.href, mimeType: "text/plain", text: (view as { outline: string }).outline },
          ],
        };
      return json(uri.href, view);
    };
  return [
    ...STATIC_RESOURCES,
    {
      name: "session-scene",
      uriTemplate: "chalanamaya://session/{session_id}/scene",
      title: "A board's items (compact JSON)",
      mimeType: "application/json",
      read: boardView("json"),
    },
    {
      name: "session-outline",
      uriTemplate: "chalanamaya://session/{session_id}/outline",
      title: "A board's outline",
      mimeType: "text/plain",
      read: boardView("outline"),
    },
  ];
};
