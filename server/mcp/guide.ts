/**
 * MCP prompts and resources (plan §5.5). The guide is the portable skill
 * (skills/chalanamaya/SKILL.md). Session resources are templates without a
 * list callback, so no board ids are ever enumerated.
 */
import fs from "node:fs";
import path from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ROOT_DIR } from "../config";
import { parseSessionRef } from "../../src/shared/ids";
import { BOARD_COLORS } from "../../src/scene/constants";
import type { SessionService } from "../sessions/service";
import { INPUT_TYPES } from "./elements";
import { FILL_NAMES, NOTE_NAMES, STROKE_NAMES } from "./palette";
import { queryScene } from "./view";

let guideCache: string | null = null;
export const guideText = () => {
  if (guideCache === null) {
    try {
      guideCache = fs.readFileSync(
        path.join(ROOT_DIR, "skills", "chalanamaya", "SKILL.md"),
        "utf8",
      );
    } catch {
      guideCache = "# ChalanaMaya\n\nThe drawing guide is missing from this installation.";
    }
  }
  return guideCache;
};

export const ELEMENTS_REFERENCE = {
  coordinates:
    "Board units; x grows right, y grows down; boxes by top-left corner; angle in degrees clockwise; path points absolute [x, y].",
  types: INPUT_TYPES,
  later_versions: ["gif", "video", "component", "image url links"],
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
      url: "refused in this version: links_not_supported_yet",
    },
    web_card: { url: "http(s) page address" },
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
  ],
};

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

export const registerGuide = (server: McpServer, service: SessionService) => {
  server.registerPrompt(
    "draw_diagram",
    {
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
    },
    ({ session_id, description, kind }) =>
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
  );
  server.registerPrompt(
    "explain_board",
    {
      title: "Explain a board",
      description: "Reads a board and summarises it.",
      argsSchema: { session_id: z.string().describe("Board session id or URL") },
    },
    ({ session_id }) =>
      promptText(
        `Call get_scene on the ChalanaMaya board ${session_id} with format "outline" (page with next_cursor if needed). Then explain what the board shows: its parts, how they connect (connectors list "from → to"), and any notes. Do not change the board.`,
      ),
  );
  server.registerPrompt(
    "tidy_board",
    {
      title: "Tidy a board",
      description: "Aligns, distributes and fixes overlaps on a board.",
      argsSchema: { session_id: z.string().describe("Board session id or URL") },
    },
    ({ session_id }) =>
      promptText(
        `Tidy the ChalanaMaya board ${session_id}. Read it with get_scene, find rows and columns of items that are almost aligned, and use arrange_elements (align, distribute with a gap of 80) and move_elements to line them up and remove overlaps. Do not delete or restyle anything, and leave locked items alone. Pass agent_name.`,
      ),
  );
  server.registerPrompt(
    "chalanamaya_guide",
    { title: "ChalanaMaya drawing guide", description: "The drawing guide for agents." },
    () => promptText(guideText()),
  );

  server.registerResource(
    "guide",
    "chalanamaya://guide",
    { title: "ChalanaMaya drawing guide", mimeType: "text/markdown" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guideText() }] }),
  );
  server.registerResource(
    "elements-reference",
    "chalanamaya://reference/elements",
    { title: "Element input reference", mimeType: "application/json" },
    (uri) => json(uri.href, ELEMENTS_REFERENCE),
  );
  server.registerResource(
    "palette",
    "chalanamaya://reference/palette",
    { title: "Colour names", mimeType: "application/json" },
    (uri) => json(uri.href, PALETTE_REFERENCE),
  );
  server.registerResource(
    "component-presets",
    "chalanamaya://reference/component-presets",
    { title: "Component presets", mimeType: "application/json" },
    (uri) =>
      json(uri.href, {
        presets: [],
        note: "Animated components arrive in a later version of ChalanaMaya.",
      }),
  );
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
  server.registerResource(
    "session-scene",
    new ResourceTemplate("chalanamaya://session/{session_id}/scene", { list: undefined }),
    { title: "A board's items (compact JSON)", mimeType: "application/json" },
    boardView("json"),
  );
  server.registerResource(
    "session-outline",
    new ResourceTemplate("chalanamaya://session/{session_id}/outline", { list: undefined }),
    { title: "A board's outline", mimeType: "text/plain" },
    boardView("outline"),
  );
};
