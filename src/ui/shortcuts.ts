import type { ToolId } from "../store/store";

export const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** Formats a shortcut like "Mod+Shift+Z" for the current platform. */
export const formatKeys = (keys: string, mac = isMac()) =>
  keys
    .split("+")
    .map((k) => {
      if (k === "Mod") return mac ? "⌘" : "Ctrl";
      if (k === "Alt") return mac ? "⌥" : "Alt";
      if (k === "Shift") return mac ? "⇧" : "Shift";
      return k;
    })
    .join(mac ? "" : "+");

export interface ToolDef {
  id: ToolId;
  name: string;
  /** Common term shown alongside the ChalanaMaya name. */
  common: string;
  key: string;
  digit?: string;
}

export const TOOLS: ToolDef[] = [
  { id: "hand", name: "Grab canvas", common: "pan", key: "H" },
  { id: "pick", name: "Pick", common: "selection", key: "V", digit: "1" },
  { id: "rectangle", name: "Box", common: "rectangle", key: "R", digit: "2" },
  { id: "diamond", name: "Diamond", common: "diamond", key: "D", digit: "3" },
  { id: "ellipse", name: "Oval", common: "ellipse", key: "O", digit: "4" },
  { id: "arrow", name: "Connector", common: "arrow", key: "A", digit: "5" },
  { id: "line", name: "Path", common: "line", key: "L", digit: "6" },
  { id: "freedraw", name: "Sketch pencil", common: "freehand", key: "P", digit: "7" },
  { id: "text", name: "Words", common: "text", key: "T", digit: "8" },
];

export interface ShortcutGroup {
  title: string;
  items: { label: string; keys: string[] }[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Tools",
    items: TOOLS.map((t) => ({
      label: `${t.name} — ${t.common}`,
      keys: t.digit ? [t.key, t.digit] : [t.key],
    })),
  },
  {
    title: "Editing",
    items: [
      { label: "Undo", keys: ["Mod+Z"] },
      { label: "Redo", keys: ["Mod+Shift+Z", "Mod+Y"] },
      { label: "Select all", keys: ["Mod+A"] },
      { label: "Add to / remove from selection", keys: ["Shift+Click"] },
      { label: "Delete selection", keys: ["Delete", "Backspace"] },
      { label: "Duplicate selection", keys: ["Mod+D"] },
      { label: "Cut / Copy / Paste", keys: ["Mod+X", "Mod+C", "Mod+V"] },
      { label: "Edit text in a shape", keys: ["Enter", "Double-click"] },
      { label: "Finish text or path, deselect", keys: ["Escape"] },
      { label: "Keep proportions / snap angle", keys: ["Shift+Drag"] },
    ],
  },
  {
    title: "View",
    items: [
      { label: "Zoom in", keys: ["Mod+=", "Mod+Wheel"] },
      { label: "Zoom out", keys: ["Mod+-"] },
      { label: "Reset zoom to 100%", keys: ["Mod+0"] },
      { label: "Zoom to fit all", keys: ["Shift+1"] },
      { label: "Zoom to selection", keys: ["Shift+2"] },
      { label: "Pan the board", keys: ["Space+Drag", "Wheel"] },
    ],
  },
  {
    title: "Board",
    items: [
      { label: "Save .chalana file", keys: ["Mod+S"] },
      { label: "Open .chalana file", keys: ["Mod+O"] },
      { label: "Export PNG", keys: ["Mod+Shift+E"] },
      { label: "Show this help", keys: ["?"] },
    ],
  },
];
