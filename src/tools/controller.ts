import {
  captureInteraction,
  interactionScene,
  liveIds,
  type InteractionBase,
} from "../scene/rebase";
import { LIMITS } from "../shared/limits";
import {
  createFrame,
  createFreedraw,
  createLinear,
  createNote,
  createShape,
  createText,
  isLinear,
  isTextContainer,
} from "../scene/elements";
import {
  assignFrames,
  elementsInLasso,
  elementsUnderTrail,
  expandGroups,
  insertPoint,
  snapBox,
  snapPoint,
  withDependents,
} from "../scene/arrange";
import { cropByHandle } from "../scene/crop";
import { deleteElements } from "../scene/scene";
import { getCommonBounds } from "../scene/geometry";
import type { ImageElement } from "../scene/types";
import {
  distance,
  fromAbsolutePoints,
  getAbsolutePoints,
  getCenter,
  normalizeRect,
  snapAngle,
} from "../scene/geometry";
import type { Snapshot } from "../scene/history";
import { elementAt, elementsInBox, hitElement, lockedElementAt } from "../scene/hit";
import { unlockElement } from "../store/actions";
import { bindingTargetAt, getBoundText } from "../scene/scene";
import { layoutText } from "../scene/text";
import {
  moveElements,
  resizeElement,
  resizeGroup,
  rotateElements,
  type Handle,
} from "../scene/transform";
import type {
  Bounds,
  FreedrawElement,
  LinearElement,
  Point,
  SceneElement,
  TextElement,
} from "../scene/types";
import { panBy, screenToScene, zoomAt } from "../scene/viewport";
import {
  HANDLE_CURSORS,
  HANDLE_SIZE,
  getHandleLayout,
  getTransformBox,
  handleEdgePoint,
  paddedBoxCorners,
  usesEndpointHandlesOnly,
} from "../render/handles";
import { pointInPolygon } from "../scene/geometry";
import type { Store, ToolId } from "../store/store";
import { pourTargetAt } from "../scene/hit";
import { recognizeShape, SHAPE_NAMES } from "../scene/recognize";
import { resolveWebCard } from "../scene/webcard";
import { TRANSPARENT } from "../scene/constants";

/**
 * Pressures recorded for a stroke, or null when they carry no information
 * (no stylus, or a pen that always reports the same value): those draw steadily.
 */
export const steadyPressure = (pressures: number[] | null, count: number): number[] | null => {
  if (!pressures || !pressures.length) return null;
  const list = pressures.slice(0, count);
  while (list.length < count) list.push(list[list.length - 1]);
  const min = Math.min(...list);
  const max = Math.max(...list);
  return max - min < 0.02 ? null : list;
};

export interface PointerInput {
  /** Screen position relative to the canvas, CSS px. */
  x: number;
  y: number;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** "mouse", "pen" or "touch". */
  pointerType?: string;
  /** PointerEvent.pressure (0–1); only meaningful for pens. */
  pressure?: number;
}

type Interaction =
  | { kind: "none" }
  | { kind: "pan"; last: Point }
  | { kind: "shape"; id: string; origin: Point; before: Snapshot }
  | { kind: "frame"; id: string; origin: Point; before: Snapshot }
  | { kind: "trail"; mode: "lasso" | "eraser"; points: Point[] }
  | { kind: "arrow"; id: string; origin: Point; before: Snapshot }
  | {
      kind: "freedraw";
      id: string;
      points: Point[];
      /** Stylus pressures, or null when the input has no pressure. */
      pressures: number[] | null;
      tidy: boolean;
      before: Snapshot;
    }
  | { kind: "spotlight" }
  | {
      kind: "path";
      id: string;
      points: Point[];
      before: Snapshot;
      down: Point | null;
      downScreen: Point | null;
    }
  | {
      kind: "move";
      start: Point;
      base: InteractionBase;
      ids: Set<string>;
      before: Snapshot;
    }
  | {
      kind: "resize";
      handle: Handle;
      /** Edge point minus grab point, so the box edge follows the pointer delta. */
      offset: Point;
      base: InteractionBase;
      ids: Set<string>;
      startBounds: Bounds;
      before: Snapshot;
    }
  | {
      kind: "rotate";
      base: InteractionBase;
      ids: Set<string>;
      center: Point;
      startAngle: number;
      single: boolean;
      before: Snapshot;
    }
  | { kind: "box"; origin: Point; current: Point; base: Set<string>; additive: boolean }
  | { kind: "endpoint"; id: string; index: number; before: Snapshot };

export interface Overlay {
  selectionBox: Bounds | null;
  bindingTargetId: string | null;
  pathStart: Point | null;
}

/** Max zoom change per wheel event, as a natural log (ln 1.2 ≈ 0.182). */
const MAX_WHEEL_ZOOM_LOG = Math.log(1.2);

const DRAW_TOOLS: ToolId[] = [
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "note",
  "frame",
  "lasso",
  "eraser",
  "eyedropper",
  "laser",
  "tidy",
  "pour",
  "embed",
];

/** Tools that create artwork (pen mode ignores touch for these). */
const CREATING_TOOLS: ToolId[] = [
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "note",
  "frame",
  "eraser",
  "tidy",
  "pour",
  "embed",
];

export class Controller {
  private interaction: Interaction = { kind: "none" };
  overlay: Overlay = { selectionBox: null, bindingTargetId: null, pathStart: null };
  spaceHeld = false;
  cursor = "default";
  onOverlay: () => void = () => {};
  /** Eyedropper sampling at a screen point; set by the canvas. */
  onSample: (screen: Point) => void = () => {};
  /** Asked to open a link (view mode or link badge). */
  onLink: (el: SceneElement) => void = () => {};
  /** Text edit session started by startTextEdit. */
  private textSession: { id: string; before: Snapshot; isNew: boolean } | null = null;

  constructor(private readonly store: Store) {}

  private get state() {
    return this.store.get();
  }

  private toScene(input: { x: number; y: number }) {
    return screenToScene(input, this.state.viewport);
  }

  private tolerance() {
    return 8 / this.state.viewport.zoom;
  }

  private setOverlay(patch: Partial<Overlay>) {
    this.overlay = { ...this.overlay, ...patch };
    this.onOverlay();
  }

  isBusy() {
    return this.interaction.kind !== "none";
  }

  get isDrawingPath() {
    return this.interaction.kind === "path";
  }

  // ---------- pointer down ----------

  /** Selection and tool to use after finishing a new item (Keep drawing aware). */
  private after(id: string): { selectedIds: Set<string>; tool?: ToolId } {
    if (this.state.toolLocked) return { selectedIds: new Set() };
    return { selectedIds: new Set([id]), tool: "pick" };
  }

  private snapOn(input: PointerInput) {
    return this.state.prefs.snapping && !input.altKey;
  }

  /** The first corner of a new box snaps to nearby edges too (Alt skips it). */
  private snapStart(input: PointerInput, p: Point): Point {
    if (!this.snapOn(input)) return p;
    return snapPoint(this.state.elements, p, new Set(), 6 / this.state.viewport.zoom).point;
  }

  pointerDown(input: PointerInput) {
    if (this.state.editingTextId) this.finishTextEdit();
    let p = this.toScene(input);
    const tool = this.state.tool;
    const { viewMode, prefs } = this.state;
    if (this.state.activeEmbedId) this.store.set({ activeEmbedId: null });
    if (tool === "laser" && input.button === 0 && !this.spaceHeld) {
      this.beginSpotlight(p);
      return;
    }
    if (viewMode && input.button === 0 && !this.spaceHeld) {
      const hit = elementAt(this.state.elements, p, this.tolerance());
      if (hit?.link) {
        this.onLink(hit);
        return;
      }
    }
    const touchBlocked =
      prefs.penMode && input.pointerType === "touch" && CREATING_TOOLS.includes(tool);
    if (input.button === 1 || this.spaceHeld || tool === "hand" || viewMode || touchBlocked) {
      this.interaction = { kind: "pan", last: { x: input.x, y: input.y } };
      this.cursor = "grabbing";
      return;
    }
    if (input.button !== 0) return;
    if (this.interaction.kind === "path") {
      this.pathPointerDown(input, p);
      return;
    }
    switch (tool) {
      case "pick":
        this.pickDown(input, p);
        return;
      case "rectangle":
      case "diamond":
      case "ellipse":
        this.beginShape(tool, this.snapStart(input, p));
        return;
      case "arrow":
        this.beginArrow(p);
        return;
      case "line":
        this.beginPath(input, p);
        return;
      case "freedraw":
      case "tidy":
        this.beginFreedraw(p, input, tool === "tidy");
        return;
      case "pour":
        this.pourAt(p);
        return;
      case "embed":
        this.store.set({ dialog: { kind: "webcard", at: p } });
        return;
      case "text":
        this.textToolDown(p);
        return;
      case "note":
        this.placeNote(p);
        return;
      case "frame": {
        p = this.snapStart(input, p);
        const before = this.store.snapshot();
        const count = this.state.elements.filter((e) => e.type === "frame").length;
        const el = createFrame(p.x, p.y, `Page ${count + 1}`);
        this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
        this.interaction = { kind: "frame", id: el.id, origin: p, before };
        return;
      }
      case "lasso":
      case "eraser":
        this.interaction = { kind: "trail", mode: tool, points: [p] };
        this.store.set({ trail: { kind: tool, points: [p] }, pendingErase: new Set() });
        if (tool === "eraser") this.eraseAlong([p]);
        return;
      case "eyedropper":
        this.onSample({ x: input.x, y: input.y });
        return;
    }
  }

  private placeNote(p: Point) {
    const before = this.store.snapshot();
    const note = createNote(p.x - 90, p.y - 90, this.state.currentStyle);
    const text = createText(
      p.x,
      p.y,
      { ...this.state.currentStyle, strokeColor: "#193a36" },
      "",
      note.id,
    );
    this.store.updateElements([...this.state.elements, note, text]);
    this.textSession = { id: text.id, before, isNew: false };
    this.store.set({ editingTextId: text.id, selectedIds: new Set() });
    this.noteSession = note.id;
  }

  /** Note created by the note tool; finishing an empty note keeps the paper. */
  private noteSession: string | null = null;

  private eraseAlong(points: Point[]) {
    const hit = elementsUnderTrail(this.state.elements, points, this.tolerance());
    if (!hit.size) return;
    const next = new Set(this.state.pendingErase);
    for (const id of hit) next.add(id);
    if (next.size !== this.state.pendingErase.size) this.store.set({ pendingErase: next });
  }

  private pickDown(input: PointerInput, p: Point) {
    const { elements, selectedIds, viewport } = this.state;
    const selected = elements.filter((e) => selectedIds.has(e.id));
    const box = getTransformBox(selected);
    const hs = HANDLE_SIZE / viewport.zoom;

    const editingPts = this.state.editingPointsId
      ? elements.find((e) => e.id === this.state.editingPointsId)
      : undefined;
    if (editingPts && isLinear(editingPts)) {
      const pts = getAbsolutePoints(editingPts);
      const idx = pts.findIndex((q) => distance(q, p) <= hs);
      if (idx >= 0) {
        this.interaction = {
          kind: "endpoint",
          id: editingPts.id,
          index: idx,
          before: this.store.snapshot(),
        };
        this.store.set({ selectedIds: new Set([editingPts.id]), editingPointIndex: idx });
        return;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
        if (distance(m, p) <= hs) {
          const before = this.store.snapshot();
          const next = insertPoint(editingPts, i);
          this.store.updateElements(elements.map((e) => (e.id === next.id ? next : e)));
          this.interaction = { kind: "endpoint", id: next.id, index: i + 1, before };
          this.store.set({ editingPointIndex: i + 1 });
          return;
        }
      }
      if (!hitElement(editingPts, p, this.tolerance(), elements)) {
        this.store.set({ editingPointsId: null, editingPointIndex: null });
      } else return;
    }

    if (selected.length === 1 && isLinear(selected[0])) {
      const pts = getAbsolutePoints(selected[0]);
      const idx = [0, pts.length - 1].find((i) => distance(pts[i], p) <= hs);
      if (idx !== undefined) {
        this.interaction = {
          kind: "endpoint",
          id: selected[0].id,
          index: idx,
          before: this.store.snapshot(),
        };
        return;
      }
    }

    if (box && !usesEndpointHandlesOnly(selected)) {
      const layout = getHandleLayout(box, viewport.zoom);
      if (distance(layout.rotate, p) <= hs) {
        const center = getCenter(box);
        this.interaction = {
          kind: "rotate",
          base: captureInteraction(elements, selectedIds),
          ids: new Set(selectedIds),
          center,
          startAngle: Math.atan2(p.y - center.y, p.x - center.x),
          single: selected.length === 1,
          before: this.store.snapshot(),
        };
        return;
      }
      for (const [h, pos] of Object.entries(layout.handles) as [Handle, Point][]) {
        if (Math.abs(pos.x - p.x) <= hs && Math.abs(pos.y - p.y) <= hs) {
          const edge = handleEdgePoint(box, h);
          this.interaction = {
            kind: "resize",
            handle: h,
            offset: { x: edge.x - p.x, y: edge.y - p.y },
            base: captureInteraction(elements, selectedIds),
            ids: new Set(selectedIds),
            startBounds: {
              minX: box.x,
              minY: box.y,
              maxX: box.x + box.width,
              maxY: box.y + box.height,
            },
            before: this.store.snapshot(),
          };
          return;
        }
      }
    }

    const hit = elementAt(elements, p, this.tolerance());
    if (this.state.croppingId && hit?.id !== this.state.croppingId) {
      this.store.set({ croppingId: null });
    }
    if (hit) {
      let ids: Set<string>;
      const unit = expandGroups(elements, [hit.id]);
      if (input.shiftKey) {
        ids = new Set(selectedIds);
        if (ids.has(hit.id)) for (const id of unit) ids.delete(id);
        else for (const id of unit) ids.add(id);
      } else if (selectedIds.has(hit.id)) {
        ids = new Set(selectedIds);
      } else {
        ids = unit;
      }
      this.store.set({ selectedIds: ids });
      if (ids.has(hit.id)) this.beginMove(p, ids);
      return;
    }

    if (box && !input.shiftKey) {
      const corners = paddedBoxCorners(box, viewport.zoom);
      if (pointInPolygon(p, corners)) {
        this.beginMove(p, new Set(selectedIds));
        return;
      }
    }

    const base = input.shiftKey ? new Set(selectedIds) : new Set<string>();
    if (!input.shiftKey && selectedIds.size) this.store.set({ selectedIds: new Set() });
    this.interaction = { kind: "box", origin: p, current: p, base, additive: input.shiftKey };
  }

  private beginMove(p: Point, ids: Set<string>) {
    if ([...ids].some((id) => this.find(id)?.locked)) {
      ids = new Set([...ids].filter((id) => !this.find(id)?.locked));
    }
    this.interaction = {
      kind: "move",
      start: p,
      base: captureInteraction(this.state.elements, ids),
      ids,
      before: this.store.snapshot(),
    };
  }

  private beginShape(type: "rectangle" | "diamond" | "ellipse", p: Point) {
    const before = this.store.snapshot();
    const el = createShape(type, p.x, p.y, this.state.currentStyle);
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.interaction = { kind: "shape", id: el.id, origin: p, before };
  }

  private beginArrow(p: Point) {
    const before = this.store.snapshot();
    const target = bindingTargetAt(this.state.elements, p);
    const el: LinearElement = {
      ...createLinear("arrow", p.x, p.y, this.state.currentStyle, [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]),
      startBinding: target ? { elementId: target.id } : null,
    };
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.interaction = { kind: "arrow", id: el.id, origin: p, before };
    this.setOverlay({ bindingTargetId: target?.id ?? null });
  }

  private beginPath(input: PointerInput, p: Point) {
    const before = this.store.snapshot();
    const el = createLinear("line", p.x, p.y, this.state.currentStyle, [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.interaction = {
      kind: "path",
      id: el.id,
      points: [p, { ...p }],
      before,
      down: p,
      downScreen: { x: input.x, y: input.y },
    };
    this.setOverlay({ pathStart: p });
  }

  private pathPointerDown(input: PointerInput, p: Point) {
    const it = this.interaction;
    if (it.kind !== "path") return;
    const fixed = it.points.slice(0, -1);
    const zoom = this.state.viewport.zoom;
    const nearStart = distance(fixed[0], p) * zoom <= 10;
    const nearLast = distance(fixed[fixed.length - 1], p) * zoom <= 6;
    if (nearStart && fixed.length >= 3) {
      this.finishPath(true);
      return;
    }
    if (nearLast && fixed.length >= 2) {
      this.finishPath(false);
      return;
    }
    it.points = [...fixed, { ...p }, { ...p }];
    it.down = p;
    it.downScreen = { x: input.x, y: input.y };
    this.updatePathElement();
  }

  private updatePathElement() {
    const it = this.interaction;
    if (it.kind !== "path") return;
    const elements = this.state.elements.map((e) =>
      e.id === it.id ? fromAbsolutePoints(e as LinearElement, it.points) : e,
    );
    this.store.set({ elements });
  }

  /** Ends a multi-point path; `closed` joins it back to the first point. */
  finishPath(closed = false) {
    const it = this.interaction;
    if (it.kind !== "path") return;
    const fixed = it.points.slice(0, -1);
    this.interaction = { kind: "none" };
    this.setOverlay({ pathStart: null });
    const el = this.state.elements.find((e) => e.id === it.id) as LinearElement | undefined;
    if (!el || fixed.length < 2) {
      this.store.set({ elements: it.before.elements });
      return;
    }
    const finished: LinearElement = { ...fromAbsolutePoints(el, fixed), closed };
    const elements = this.state.elements.map((e) => (e.id === it.id ? finished : e));
    this.store.set({ elements });
    this.claimFrame(it.id);
    this.store.commitFrom(it.before, this.after(it.id));
  }

  /** Pen pressure for this input, or null when it should draw a steady width. */
  private pressureOf(input: PointerInput): number | null {
    if (!this.state.prefs.pencilPressure || input.pointerType !== "pen") return null;
    if (typeof input.pressure !== "number" || !Number.isFinite(input.pressure)) return null;
    return Math.max(0.05, Math.min(1, input.pressure));
  }

  private beginFreedraw(p: Point, input: PointerInput, tidy = false) {
    const before = this.store.snapshot();
    const el = createFreedraw(p.x, p.y, this.state.currentStyle);
    const pr = this.pressureOf(input);
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.interaction = {
      kind: "freedraw",
      id: el.id,
      points: [p],
      pressures: pr === null ? null : [pr],
      tidy,
      before,
    };
  }

  /** Clock for Spotlight trails; replaceable in tests. */
  now: () => number = () => Date.now();

  private beginSpotlight(p: Point) {
    const t = this.now();
    this.interaction = { kind: "spotlight" };
    this.store.set({ spotlight: [...this.state.spotlight, { points: [{ ...p, t }] }] });
  }

  /** Pour colour: fills the closed shape under the pointer with the current fill. */
  private pourAt(p: Point) {
    const hit = pourTargetAt(this.state.elements, p, this.tolerance());
    if (hit.kind === "none") {
      this.store.toast(
        "Pour colour fills closed shapes. Click inside a box, diamond, oval, note or closed path. Sketch pencil strokes can't hold a fill.",
      );
      return;
    }
    if (hit.kind === "locked") return this.noticeLocked(hit.element);
    if (hit.kind === "open") {
      this.store.toast("That item isn't a closed shape, so it can't hold a fill.");
      return;
    }
    const { backgroundColor, fillStyle } = this.state.currentStyle;
    const el = hit.element;
    const fill = backgroundColor === TRANSPARENT ? TRANSPARENT : backgroundColor;
    const nextStyle = el.type === "note" ? {} : { fillStyle };
    if (el.backgroundColor === fill && (el.type === "note" || el.fillStyle === fillStyle)) return;
    if (el.type === "note" && fill === TRANSPARENT) {
      this.store.toast("Notes always have a paper colour. Pick a fill colour first.");
      return;
    }
    this.store.commit(
      this.state.elements.map((e) =>
        e.id === el.id ? ({ ...e, backgroundColor: fill, ...nextStyle } as SceneElement) : e,
      ),
    );
  }

  /** Shape tidy: turns a finished sketch into a box, diamond or oval when it is clearly one. */
  private tidySketch(id: string) {
    const el = this.find(id);
    if (!el || el.type !== "freedraw") return;
    const rec = recognizeShape(getAbsolutePoints(el));
    if (!rec) {
      this.store.toast("Shape tidy didn't recognise a box, diamond or oval, so it stays a sketch.");
      return;
    }
    const style = this.state.currentStyle;
    const shape = {
      ...createShape(rec.type, rec.x, rec.y, style, rec.width, rec.height),
      strokeColor: el.strokeColor,
      opacity: el.opacity,
      frameId: el.frameId,
      groupIds: el.groupIds,
    };
    const keepTool = this.state.toolLocked;
    this.store.commit(
      this.state.elements.map((e) => (e.id === id ? shape : e)),
      keepTool ? { selectedIds: new Set() } : { selectedIds: new Set([shape.id]) },
    );
    const name = SHAPE_NAMES[rec.type];
    const article = /^[aeiou]/i.test(name) ? "an" : "a";
    this.store.toast(`Shape tidy made it ${article} ${name}. Undo brings the sketch back.`);
  }

  private textToolDown(p: Point) {
    const { elements } = this.state;
    const hit = elementAt(elements, p, this.tolerance());
    const editsHit = hit && (hit.type === "text" || isTextContainer(hit) || hit.type === "arrow");
    if (editsHit && this.textEditBlocked(hit)) return;
    if (!hit) {
      const locked = this.lockedUnder(p);
      if (locked && (isTextContainer(locked) || locked.type === "text")) {
        this.noticeLocked(locked);
        return;
      }
    }
    if (hit && hit.type === "text") return this.startTextEdit(hit.id);
    if (hit && (isTextContainer(hit) || hit.type === "arrow")) return this.editContainerText(hit);
    this.createTextAt(p);
  }

  createTextAt(p: Point) {
    if (this.state.viewMode) return;
    const style = this.state.currentStyle;
    const el = layoutText(createText(p.x, p.y - (style.fontSize * 1.3) / 2, style));
    const before = this.store.snapshot();
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.textSession = { id: el.id, before, isNew: true };
    this.store.set({ editingTextId: el.id });
  }

  /** Locked items (and labels of locked containers) and look-only mode refuse text editing. */
  private textEditBlocked(el: SceneElement | undefined): boolean {
    if (this.state.viewMode) return true;
    if (!el) return false;
    const container = el.type === "text" && el.containerId ? this.find(el.containerId) : undefined;
    const locked = el.locked ? el : container?.locked ? container : null;
    if (locked) {
      this.noticeLocked(locked);
      return true;
    }
    return false;
  }

  /** Tells the user an item is locked and offers to unlock just that item. */
  private noticeLocked(el: SceneElement) {
    for (const t of this.state.toasts)
      if (t.action?.testId === "unlock-item") this.store.dismissToast(t.id);
    this.store.toast("This item is locked, so it can't be edited.", "info", 5000, {
      label: "Unlock it",
      testId: "unlock-item",
      run: () => unlockElement(this.store, el.id),
    });
  }

  /** The locked item under the pointer when nothing editable sits above it. */
  private lockedUnder(p: Point) {
    return lockedElementAt(this.state.elements, p, this.tolerance());
  }

  editContainerText(container: SceneElement) {
    if (this.textEditBlocked(container)) return;
    const existing = getBoundText(this.state.elements, container.id);
    if (existing) return this.startTextEdit(existing.id);
    const c = getCenter(container);
    const style =
      container.type === "note"
        ? { ...this.state.currentStyle, strokeColor: "#193a36" }
        : this.state.currentStyle;
    const el = createText(c.x, c.y, style, "", container.id);
    const before = this.store.snapshot();
    this.store.updateElements([...this.state.elements, el]);
    this.textSession = { id: el.id, before, isNew: true };
    this.store.set({ editingTextId: el.id, selectedIds: new Set() });
  }

  startTextEdit(id: string) {
    if (this.textEditBlocked(this.find(id))) return;
    this.textSession = { id, before: this.store.snapshot(), isNew: false };
    this.store.set({ editingTextId: id, selectedIds: new Set() });
  }

  /** Live text update from the editor; history is recorded when editing ends. */
  updateText(id: string, text: string) {
    const elements = this.state.elements.map((e) => {
      if (e.id !== id || e.type !== "text") return e;
      const next: TextElement = { ...e, text: text.slice(0, LIMITS.textChars) };
      return next.containerId ? next : layoutText(next);
    });
    this.store.updateElements(elements);
  }

  finishTextEdit() {
    const session = this.textSession;
    const id = this.state.editingTextId;
    this.textSession = null;
    if (!id) return;
    const el = this.state.elements.find((e) => e.id === id) as TextElement | undefined;
    const select = (target: string | null) => (target ? new Set([target]) : new Set<string>());
    if (!el) {
      this.store.set({ editingTextId: null });
      return;
    }
    const selectId = el.containerId ?? el.id;
    const noteId = this.noteSession;
    this.noteSession = null;
    const done =
      this.state.toolLocked && noteId
        ? { tool: this.state.tool, selectedIds: new Set<string>() }
        : { tool: "pick" as const, selectedIds: select(selectId) };
    if (!el.text.trim()) {
      const elements = this.state.elements.filter((e) => e.id !== id);
      if (session?.isNew) {
        this.store.set({
          elements: session.before.elements,
          editingTextId: null,
          tool: "pick",
          selectedIds: select(el.containerId),
        });
      } else {
        this.store.updateElements(elements);
        if (session) this.store.commitFrom(session.before);
        this.store.set({
          editingTextId: null,
          ...(noteId ? done : { tool: "pick", selectedIds: select(el.containerId) }),
        });
      }
      return;
    }
    if (session?.isNew && !el.containerId) this.claimFrame(el.id);
    if (session) this.store.commitFrom(session.before);
    this.store.set({ editingTextId: null, ...done });
  }

  // ---------- pointer move ----------

  pointerMove(input: PointerInput) {
    const p = this.toScene(input);
    const it = this.interaction;
    switch (it.kind) {
      case "none":
        this.updateHoverCursor(p);
        return;
      case "pan": {
        const v = panBy(this.state.viewport, input.x - it.last.x, input.y - it.last.y);
        it.last = { x: input.x, y: input.y };
        this.store.set({ viewport: v });
        return;
      }
      case "spotlight": {
        const strokes = this.state.spotlight;
        const cur = strokes[strokes.length - 1];
        if (!cur) return;
        const last = cur.points[cur.points.length - 1];
        if (last && distance(last, p) * this.state.viewport.zoom < 1.5) return;
        const next = { points: [...cur.points, { ...p, t: this.now() }] };
        this.store.set({ spotlight: [...strokes.slice(0, -1), next] });
        return;
      }
      case "trail": {
        const last = it.points[it.points.length - 1];
        if (distance(last, p) * this.state.viewport.zoom < 2) return;
        it.points.push(p);
        this.store.set({ trail: { kind: it.mode, points: [...it.points] } });
        if (it.mode === "eraser")
          this.eraseAlong([last, { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 }, p]);
        return;
      }
      case "frame":
      case "shape": {
        if (this.snapOn(input)) {
          const snapped = snapPoint(
            this.state.elements,
            p,
            new Set([it.id]),
            6 / this.state.viewport.zoom,
          );
          p.x = snapped.point.x;
          p.y = snapped.point.y;
          this.store.set({ snapLines: snapped.lines });
        } else if (this.state.snapLines.length) this.store.set({ snapLines: [] });
        let w = p.x - it.origin.x;
        let h = p.y - it.origin.y;
        if (input.shiftKey) {
          const s = Math.max(Math.abs(w), Math.abs(h));
          w = s * Math.sign(w || 1);
          h = s * Math.sign(h || 1);
        }
        const r = normalizeRect(it.origin, { x: it.origin.x + w, y: it.origin.y + h });
        this.patchElement(it.id, {
          x: r.minX,
          y: r.minY,
          width: r.maxX - r.minX,
          height: r.maxY - r.minY,
        });
        return;
      }
      case "arrow": {
        const el = this.find(it.id) as LinearElement;
        const target = bindingTargetAt(this.state.elements, p, new Set([it.id]));
        const startPt = el.startBinding ? getAbsolutePoints(el)[0] : it.origin;
        const next = fromAbsolutePoints(el, [startPt, p]);
        this.store.updateElements(this.state.elements.map((e) => (e.id === it.id ? next : e)));
        this.setOverlay({ bindingTargetId: target?.id ?? null });
        return;
      }
      case "freedraw": {
        const last = it.points[it.points.length - 1];
        if (distance(last, p) * this.state.viewport.zoom < 1) return;
        it.points.push(p);
        if (it.pressures) {
          const pr = this.pressureOf(input);
          it.pressures.push(pr ?? it.pressures[it.pressures.length - 1]);
        }
        const el = this.find(it.id) as FreedrawElement;
        const pressures = it.pressures ? [...it.pressures] : null;
        this.store.set({
          elements: this.state.elements.map((e) =>
            e.id === it.id ? { ...fromAbsolutePoints(el, it.points), pressures } : e,
          ),
        });
        // source limit: a very long stroke carries on as a new stroke, same undo step
        if (it.points.length >= LIMITS.freedrawPoints) {
          const next = createFreedraw(p.x, p.y, this.state.currentStyle);
          this.claimFrame(it.id);
          this.store.set({ elements: [...this.state.elements, next] });
          it.id = next.id;
          it.points = [p];
          if (it.pressures) it.pressures = [it.pressures[it.pressures.length - 1]];
        }
        return;
      }
      case "path": {
        it.points[it.points.length - 1] = p;
        this.updatePathElement();
        return;
      }
      case "move": {
        // Rule C: computed from the live scene with the gesture's start state put back
        const base = interactionScene(this.state.elements, it.base);
        const ids = liveIds(this.state.elements, it.base);
        let dx = p.x - it.start.x;
        let dy = p.y - it.start.y;
        if (this.snapOn(input)) {
          const moving = withDependents(base, ids);
          const b = getCommonBounds(base.filter((e) => moving.has(e.id)));
          if (b) {
            const r = snapBox(
              base,
              { minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy },
              moving,
              6 / this.state.viewport.zoom,
            );
            dx += r.dx;
            dy += r.dy;
            this.store.set({ snapLines: r.lines });
          }
        } else if (this.state.snapLines.length) this.store.set({ snapLines: [] });
        this.store.updateElements(moveElements(base, ids, dx, dy));
        return;
      }
      case "resize": {
        const target = { x: p.x + it.offset.x, y: p.y + it.offset.y };
        const base = interactionScene(this.state.elements, it.base);
        const ids = liveIds(this.state.elements, it.base);
        if (!ids.size) return;
        if (it.ids.size === 1) {
          const [id] = ids;
          const el = base.find((e) => e.id === id)!;
          const img =
            el.type === "image" && this.state.croppingId === el.id ? this.naturalSize(el) : null;
          const next = img
            ? cropByHandle(el as ImageElement, img, it.handle, target)
            : resizeElement(el, it.handle, target, input.shiftKey);
          this.store.updateElements(base.map((e) => (e.id === id ? next : e)));
        } else {
          this.store.updateElements(resizeGroup(base, ids, it.startBounds, it.handle, target));
        }
        return;
      }
      case "rotate": {
        let delta = Math.atan2(p.y - it.center.y, p.x - it.center.x) - it.startAngle;
        const base = interactionScene(this.state.elements, it.base);
        const ids = liveIds(this.state.elements, it.base);
        if (!ids.size) return;
        if (input.shiftKey) {
          if (it.single) {
            const el = base.find((e) => ids.has(e.id))!;
            delta = snapAngle(el.angle + delta) - el.angle;
          } else delta = snapAngle(delta);
        }
        this.store.updateElements(rotateElements(base, ids, it.center, delta));
        return;
      }
      case "box": {
        it.current = p;
        const box = normalizeRect(it.origin, p);
        const inside = expandGroups(
          this.state.elements,
          elementsInBox(this.state.elements, box).map((e) => e.id),
        );
        const ids = new Set(it.base);
        for (const id of inside) ids.add(id);
        this.store.set({ selectedIds: ids });
        this.setOverlay({ selectionBox: box });
        return;
      }
      case "endpoint": {
        const el = this.find(it.id) as LinearElement;
        const pts = getAbsolutePoints(el);
        pts[it.index] = p;
        const detached: LinearElement = {
          ...el,
          startBinding: it.index === 0 ? null : el.startBinding,
          endBinding: it.index === pts.length - 1 ? null : el.endBinding,
        };
        const next = fromAbsolutePoints(detached, pts);
        this.store.updateElements(this.state.elements.map((e) => (e.id === it.id ? next : e)));
        if (el.type === "arrow" && (it.index === 0 || it.index === pts.length - 1)) {
          const target = bindingTargetAt(this.state.elements, p, new Set([it.id]));
          this.setOverlay({ bindingTargetId: target?.id ?? null });
        }
        return;
      }
    }
  }

  private updateHoverCursor(p: Point) {
    const { tool, elements, selectedIds, viewport } = this.state;
    let cursor = "default";
    if (this.spaceHeld || tool === "hand") cursor = "grab";
    else if (tool === "text") cursor = "text";
    else if (DRAW_TOOLS.includes(tool)) cursor = "crosshair";
    else {
      const selected = elements.filter((e) => selectedIds.has(e.id));
      const box = getTransformBox(selected);
      const hs = HANDLE_SIZE / viewport.zoom;
      if (box && !usesEndpointHandlesOnly(selected)) {
        const layout = getHandleLayout(box, viewport.zoom);
        if (distance(layout.rotate, p) <= hs) cursor = "grab";
        for (const [h, pos] of Object.entries(layout.handles) as [Handle, Point][]) {
          if (Math.abs(pos.x - p.x) <= hs && Math.abs(pos.y - p.y) <= hs) {
            cursor = HANDLE_CURSORS[h];
          }
        }
      }
      if (cursor === "default" && elementAt(elements, p, this.tolerance())) cursor = "move";
    }
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.onOverlay();
    }
  }

  // ---------- pointer up ----------

  pointerUp(input: PointerInput) {
    const it = this.interaction;
    const p = this.toScene(input);
    switch (it.kind) {
      case "spotlight":
        this.interaction = { kind: "none" };
        return;
      case "pan":
        this.interaction = { kind: "none" };
        this.cursor = this.spaceHeld || this.state.tool === "hand" ? "grab" : "default";
        this.onOverlay();
        return;
      case "trail": {
        this.interaction = { kind: "none" };
        if (it.mode === "lasso") {
          const ids = elementsInLasso(this.state.elements, it.points);
          this.store.set({ trail: null });
          // an empty loop leaves no selection
          this.store.set({
            selectedIds: ids.length ? expandGroups(this.state.elements, ids) : new Set(),
          });
          return;
        }
        const erase = this.state.pendingErase;
        this.store.set({ trail: null, pendingErase: new Set() });
        if (erase.size) this.store.commit(deleteElements(this.state.elements, erase));
        return;
      }
      case "frame":
      case "shape": {
        this.interaction = { kind: "none" };
        if (this.state.snapLines.length) this.store.set({ snapLines: [] });
        const el = this.find(it.id);
        const zoom = this.state.viewport.zoom;
        if (!el || (el.width * zoom < 3 && el.height * zoom < 3)) {
          this.store.set({ elements: it.before.elements });
          return;
        }
        if (it.kind === "frame") this.store.updateElements(assignFrames(this.state.elements));
        else this.claimFrame(it.id);
        this.store.commitFrom(it.before, this.after(it.id));
        return;
      }
      case "arrow": {
        this.interaction = { kind: "none" };
        this.setOverlay({ bindingTargetId: null });
        const el = this.find(it.id) as LinearElement | undefined;
        const zoom = this.state.viewport.zoom;
        if (!el || distance(it.origin, p) * zoom < 4) {
          this.store.set({ elements: it.before.elements });
          return;
        }
        const target = bindingTargetAt(this.state.elements, p, new Set([it.id]));
        const sameAsStart = target && el.startBinding?.elementId === target.id;
        const bound: LinearElement = {
          ...el,
          endBinding: target && !sameAsStart ? { elementId: target.id } : null,
        };
        this.store.updateElements(this.state.elements.map((e) => (e.id === it.id ? bound : e)));
        this.claimFrame(it.id);
        this.store.commitFrom(it.before, this.after(it.id));
        return;
      }
      case "freedraw": {
        this.interaction = { kind: "none" };
        const el = this.find(it.id) as FreedrawElement | undefined;
        if (!el) return;
        const pts =
          it.points.length === 1
            ? [it.points[0], { x: it.points[0].x + 0.5, y: it.points[0].y + 0.5 }]
            : it.points;
        const pressures = steadyPressure(it.pressures, pts.length);
        const finished: FreedrawElement = { ...fromAbsolutePoints(el, pts), pressures };
        if (!pressures) delete finished.pressures;
        this.store.set({
          elements: this.state.elements.map((e) => (e.id === it.id ? finished : e)),
        });
        this.claimFrame(it.id);
        const after = this.after(it.id);
        this.store.commitFrom(it.before, it.tidy ? { selectedIds: new Set() } : after);
        if (it.tidy) this.tidySketch(it.id);
        return;
      }
      case "path": {
        if (it.down && it.downScreen) {
          const dragged = distance(it.downScreen, { x: input.x, y: input.y }) > 5;
          it.down = null;
          if (dragged && it.points.length === 2) {
            // a single drag makes a straight line straight away
            it.points.push({ ...p });
            this.finishPath(false);
          }
        }
        return;
      }
      case "move":
        this.interaction = { kind: "none" };
        if (this.state.snapLines.length) this.store.set({ snapLines: [] });
        this.store.updateElements(
          assignFrames(this.state.elements, withDependents(this.state.elements, it.ids)),
        );
        this.store.commitFrom(it.before);
        return;
      case "resize":
      case "rotate":
        this.interaction = { kind: "none" };
        if (it.ids.size === 1 && this.find([...it.ids][0])?.type === "frame") {
          this.store.updateElements(assignFrames(this.state.elements));
        }
        this.store.commitFrom(it.before);
        return;
      case "box":
        this.interaction = { kind: "none" };
        this.setOverlay({ selectionBox: null });
        return;
      case "endpoint": {
        this.interaction = { kind: "none" };
        this.setOverlay({ bindingTargetId: null });
        const el = this.find(it.id) as LinearElement | undefined;
        const isEnd = el && (it.index === 0 || it.index === el.points.length - 1);
        if (el && el.type === "arrow" && isEnd) {
          const target = bindingTargetAt(this.state.elements, p, new Set([it.id]));
          const other = it.index === 0 ? el.endBinding : el.startBinding;
          const binding =
            target && other?.elementId !== target.id ? { elementId: target.id } : null;
          const next: LinearElement =
            it.index === 0 ? { ...el, startBinding: binding } : { ...el, endBinding: binding };
          // rebinding happens only when released over a target; elsewhere the end stays detached
          this.store.updateElements(this.state.elements.map((e) => (e.id === it.id ? next : e)));
        }
        this.store.commitFrom(it.before);
        return;
      }
      default:
        return;
    }
  }

  /** Lets the pointer and keyboard into a web card's live page (DRAW-14). */
  activateWebCard(el: SceneElement) {
    if (el.type !== "embed" || !resolveWebCard(el.url).ok) return false;
    this.store.set({
      activeEmbedId: el.id,
      selectedIds: this.state.viewMode ? new Set() : new Set([el.id]),
    });
    return true;
  }

  doubleClick(input: PointerInput) {
    if (this.interaction.kind === "path") {
      this.finishPath(false);
      return;
    }
    if (this.state.viewMode && this.state.tool === "pick") {
      // look-only boards can still use a web card's live page
      const hit = elementAt(this.state.elements, this.toScene(input), this.tolerance());
      if (hit?.type === "embed") this.activateWebCard(hit);
      return;
    }
    if (this.state.tool !== "pick" || this.state.viewMode) return;
    const p = this.toScene(input);
    const { elements } = this.state;
    const hit = elementAt(elements, p, this.tolerance());
    if (hit && this.textEditBlocked(hit)) return;
    if (hit?.type === "text") return this.startTextEdit(hit.id);
    if (hit && (isTextContainer(hit) || hit.type === "arrow")) return this.editContainerText(hit);
    if (hit?.type === "line") {
      this.store.set({ editingPointsId: hit.id, selectedIds: new Set([hit.id]) });
      return;
    }
    if (hit?.type === "image") {
      this.store.set({ croppingId: hit.id, selectedIds: new Set([hit.id]) });
      return;
    }
    if (hit?.type === "embed") return this.activateWebCard(hit);
    if (hit) return;
    const locked = this.lockedUnder(p);
    if (locked) return this.noticeLocked(locked);
    // double-clicking inside an unfilled shape still edits its label
    const container = bindingTargetAt(elements, p);
    if (container && isTextContainer(container) && !container.locked)
      return this.editContainerText(container);
    this.createTextAt(p);
  }

  wheel(e: {
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) {
    const v = this.state.viewport;
    const mouse = this.state.prefs.inputPreference === "mouse";
    if (e.ctrlKey || e.metaKey || (mouse && !e.shiftKey)) {
      // fine for trackpad pinch (small deltas), capped per event for mouse wheel notches
      const step = Math.max(-MAX_WHEEL_ZOOM_LOG, Math.min(MAX_WHEEL_ZOOM_LOG, -e.deltaY * 0.01));
      const factor = Math.exp(step);
      this.store.set({ viewport: zoomAt(v, v.zoom * factor, { x: e.x, y: e.y }) });
      return;
    }
    // trackpad: two-finger scroll pans; mouse: Shift + wheel pans sideways
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    this.store.set({ viewport: panBy(v, -dx, -dy) });
  }

  /** Cancels any in-progress gesture (used on Escape, window blur and lost pointer capture). */
  cancel() {
    const it = this.interaction;
    if (it.kind === "path") return this.finishPath(false);
    if (it.kind === "box") this.setOverlay({ selectionBox: null });
    if (it.kind === "trail") this.store.set({ trail: null, pendingErase: new Set() });
    if (this.state.snapLines.length) this.store.set({ snapLines: [] });
    if (it.kind === "move" || it.kind === "resize" || it.kind === "rotate") {
      // put only the gesture's elements back, keeping anything else that changed meanwhile
      this.store.updateElements(interactionScene(this.state.elements, it.base));
    } else if (
      it.kind === "shape" ||
      it.kind === "frame" ||
      it.kind === "arrow" ||
      it.kind === "freedraw" ||
      it.kind === "endpoint"
    ) {
      this.store.set({ elements: it.before.elements });
    }
    this.interaction = { kind: "none" };
    this.setOverlay({ bindingTargetId: null, selectionBox: null });
  }

  /** Natural pixel size of an image, when loaded. Set by the canvas. */
  naturalSize: (el: SceneElement) => { width: number; height: number } | null = () => null;

  /** A new item drawn fully inside a page frame becomes part of it. */
  private claimFrame(id: string) {
    this.store.updateElements(assignFrames(this.state.elements, new Set([id])));
  }

  private find(id: string) {
    return this.state.elements.find((e) => e.id === id);
  }

  private patchElement(id: string, patch: Partial<SceneElement>) {
    this.store.updateElements(
      this.state.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as SceneElement) : e)),
    );
  }
}
