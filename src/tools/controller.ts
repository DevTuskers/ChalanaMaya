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
import { elementAt, elementsInBox, hitElement } from "../scene/hit";
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
}

type Interaction =
  | { kind: "none" }
  | { kind: "pan"; last: Point }
  | { kind: "shape"; id: string; origin: Point; before: Snapshot }
  | { kind: "frame"; id: string; origin: Point; before: Snapshot }
  | { kind: "trail"; mode: "lasso" | "eraser"; points: Point[] }
  | { kind: "arrow"; id: string; origin: Point; before: Snapshot }
  | { kind: "freedraw"; id: string; points: Point[]; before: Snapshot }
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
      base: readonly SceneElement[];
      ids: Set<string>;
      before: Snapshot;
    }
  | {
      kind: "resize";
      handle: Handle;
      /** Edge point minus grab point, so the box edge follows the pointer delta. */
      offset: Point;
      base: readonly SceneElement[];
      ids: Set<string>;
      startBounds: Bounds;
      before: Snapshot;
    }
  | {
      kind: "rotate";
      base: readonly SceneElement[];
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
];

/** Tools that create artwork (pen mode ignores touch for these). */
const CREATING_TOOLS: ToolId[] = ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "note", "frame", "eraser"];

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

  pointerDown(input: PointerInput) {
    if (this.state.editingTextId) this.finishTextEdit();
    const p = this.toScene(input);
    const tool = this.state.tool;
    const { viewMode, prefs } = this.state;
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
        this.beginShape(tool, p);
        return;
      case "arrow":
        this.beginArrow(p);
        return;
      case "line":
        this.beginPath(input, p);
        return;
      case "freedraw":
        this.beginFreedraw(p);
        return;
      case "text":
        this.textToolDown(p);
        return;
      case "note":
        this.placeNote(p);
        return;
      case "frame": {
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
    const text = createText(p.x, p.y, { ...this.state.currentStyle, strokeColor: "#193a36" }, "", note.id);
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
        this.interaction = { kind: "endpoint", id: editingPts.id, index: idx, before: this.store.snapshot() };
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
          base: elements,
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
            base: elements,
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
      base: this.state.elements,
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
    this.store.commitFrom(it.before, this.after(it.id));
  }

  private beginFreedraw(p: Point) {
    const before = this.store.snapshot();
    const el = createFreedraw(p.x, p.y, this.state.currentStyle);
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.interaction = { kind: "freedraw", id: el.id, points: [p], before };
  }

  private textToolDown(p: Point) {
    const { elements } = this.state;
    const hit = elementAt(elements, p, this.tolerance());
    if (hit && hit.type === "text") return this.startTextEdit(hit.id);
    if (hit && (isTextContainer(hit) || hit.type === "arrow")) return this.editContainerText(hit);
    this.createTextAt(p);
  }

  createTextAt(p: Point) {
    const style = this.state.currentStyle;
    const el = layoutText(createText(p.x, p.y - (style.fontSize * 1.3) / 2, style));
    const before = this.store.snapshot();
    this.store.set({ elements: [...this.state.elements, el], selectedIds: new Set() });
    this.textSession = { id: el.id, before, isNew: true };
    this.store.set({ editingTextId: el.id });
  }

  editContainerText(container: SceneElement) {
    const existing = getBoundText(this.state.elements, container.id);
    if (existing) return this.startTextEdit(existing.id);
    const c = getCenter(container);
    const style =
      container.type === "note" ? { ...this.state.currentStyle, strokeColor: "#193a36" } : this.state.currentStyle;
    const el = createText(c.x, c.y, style, "", container.id);
    const before = this.store.snapshot();
    this.store.updateElements([...this.state.elements, el]);
    this.textSession = { id: el.id, before, isNew: true };
    this.store.set({ editingTextId: el.id, selectedIds: new Set() });
  }

  startTextEdit(id: string) {
    this.textSession = { id, before: this.store.snapshot(), isNew: false };
    this.store.set({ editingTextId: id, selectedIds: new Set() });
  }

  /** Live text update from the editor; history is recorded when editing ends. */
  updateText(id: string, text: string) {
    const elements = this.state.elements.map((e) => {
      if (e.id !== id || e.type !== "text") return e;
      const next: TextElement = { ...e, text };
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
    const done = this.state.toolLocked && noteId
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
        this.store.set({ editingTextId: null, ...(noteId ? done : { tool: "pick", selectedIds: select(el.containerId) }) });
      }
      return;
    }
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
      case "trail": {
        const last = it.points[it.points.length - 1];
        if (distance(last, p) * this.state.viewport.zoom < 2) return;
        it.points.push(p);
        this.store.set({ trail: { kind: it.mode, points: [...it.points] } });
        if (it.mode === "eraser") this.eraseAlong([last, { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 }, p]);
        return;
      }
      case "frame":
      case "shape": {
        if (this.snapOn(input)) {
          const snapped = snapPoint(this.state.elements, p, new Set([it.id]), 6 / this.state.viewport.zoom);
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
        const el = this.find(it.id) as FreedrawElement;
        this.store.set({
          elements: this.state.elements.map((e) =>
            e.id === it.id ? fromAbsolutePoints(el, it.points) : e,
          ),
        });
        return;
      }
      case "path": {
        it.points[it.points.length - 1] = p;
        this.updatePathElement();
        return;
      }
      case "move": {
        let dx = p.x - it.start.x;
        let dy = p.y - it.start.y;
        if (this.snapOn(input)) {
          const moving = withDependents(it.base, it.ids);
          const b = getCommonBounds(it.base.filter((e) => moving.has(e.id)));
          if (b) {
            const r = snapBox(
              it.base,
              { minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy },
              moving,
              6 / this.state.viewport.zoom,
            );
            dx += r.dx;
            dy += r.dy;
            this.store.set({ snapLines: r.lines });
          }
        } else if (this.state.snapLines.length) this.store.set({ snapLines: [] });
        this.store.updateElements(moveElements(it.base, it.ids, dx, dy));
        return;
      }
      case "resize": {
        const target = { x: p.x + it.offset.x, y: p.y + it.offset.y };
        if (it.ids.size === 1) {
          const [id] = it.ids;
          const el = it.base.find((e) => e.id === id)!;
          const img = el.type === "image" && this.state.croppingId === el.id ? this.naturalSize(el) : null;
          const next = img
            ? cropByHandle(el as ImageElement, img, it.handle, target)
            : resizeElement(el, it.handle, target, input.shiftKey);
          this.store.updateElements(it.base.map((e) => (e.id === id ? next : e)));
        } else {
          this.store.updateElements(
            resizeGroup(it.base, it.ids, it.startBounds, it.handle, target),
          );
        }
        return;
      }
      case "rotate": {
        let delta = Math.atan2(p.y - it.center.y, p.x - it.center.x) - it.startAngle;
        if (input.shiftKey) {
          if (it.single) {
            const el = it.base.find((e) => it.ids.has(e.id))!;
            delta = snapAngle(el.angle + delta) - el.angle;
          } else delta = snapAngle(delta);
        }
        this.store.updateElements(rotateElements(it.base, it.ids, it.center, delta));
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
          // an empty loop leaves the selection as it was
          if (ids.length) this.store.set({ selectedIds: expandGroups(this.state.elements, ids) });
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
        this.store.commitFrom(it.before, this.after(it.id));
        return;
      }
      case "freedraw": {
        this.interaction = { kind: "none" };
        const el = this.find(it.id) as FreedrawElement | undefined;
        if (!el) return;
        if (it.points.length === 1) {
          const pts = [it.points[0], { x: it.points[0].x + 0.5, y: it.points[0].y + 0.5 }];
          this.store.set({
            elements: this.state.elements.map((e) =>
              e.id === it.id ? fromAbsolutePoints(el, pts) : e,
            ),
          });
        }
        this.store.commitFrom(it.before);
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
        this.store.updateElements(assignFrames(this.state.elements, withDependents(this.state.elements, it.ids)));
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

  doubleClick(input: PointerInput) {
    if (this.interaction.kind === "path") {
      this.finishPath(false);
      return;
    }
    if (this.state.tool !== "pick") return;
    const p = this.toScene(input);
    const { elements } = this.state;
    const hit = elementAt(elements, p, this.tolerance());
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
    if (hit) return;
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
    if (
      it.kind === "shape" ||
      it.kind === "frame" ||
      it.kind === "arrow" ||
      it.kind === "freedraw" ||
      it.kind === "move" ||
      it.kind === "resize" ||
      it.kind === "rotate" ||
      it.kind === "endpoint"
    ) {
      this.store.set({ elements: it.before.elements });
    }
    this.interaction = { kind: "none" };
    this.setOverlay({ bindingTargetId: null, selectionBox: null });
  }

  /** Natural pixel size of an image, when loaded. Set by the canvas. */
  naturalSize: (el: SceneElement) => { width: number; height: number } | null = () => null;

  private find(id: string) {
    return this.state.elements.find((e) => e.id === id);
  }

  private patchElement(id: string, patch: Partial<SceneElement>) {
    this.store.updateElements(
      this.state.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as SceneElement) : e)),
    );
  }
}
