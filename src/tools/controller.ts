import {
  createFreedraw,
  createLinear,
  createShape,
  createText,
  isLinear,
  isShape,
} from "../scene/elements";
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
import { bindingTargetAt, getBoundText, withBoundTexts } from "../scene/scene";
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
}

type Interaction =
  | { kind: "none" }
  | { kind: "pan"; last: Point }
  | { kind: "shape"; id: string; origin: Point; before: Snapshot }
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

const DRAW_TOOLS: ToolId[] = ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw"];

export class Controller {
  private interaction: Interaction = { kind: "none" };
  overlay: Overlay = { selectionBox: null, bindingTargetId: null, pathStart: null };
  spaceHeld = false;
  cursor = "default";
  onOverlay: () => void = () => {};
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

  pointerDown(input: PointerInput) {
    if (this.state.editingTextId) this.finishTextEdit();
    const p = this.toScene(input);
    const tool = this.state.tool;
    if (input.button === 1 || this.spaceHeld || tool === "hand") {
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
    }
  }

  private pickDown(input: PointerInput, p: Point) {
    const { elements, selectedIds, viewport } = this.state;
    const selected = elements.filter((e) => selectedIds.has(e.id));
    const box = getTransformBox(selected);
    const hs = HANDLE_SIZE / viewport.zoom;

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
          this.interaction = {
            kind: "resize",
            handle: h,
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
    if (hit) {
      let ids: Set<string>;
      if (input.shiftKey) {
        ids = new Set(selectedIds);
        if (ids.has(hit.id)) ids.delete(hit.id);
        else ids.add(hit.id);
      } else if (selectedIds.has(hit.id)) {
        ids = new Set(selectedIds);
      } else {
        ids = new Set([hit.id]);
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
    this.store.commitFrom(it.before, { selectedIds: new Set([it.id]), tool: "pick" });
  }

  cancelPath() {
    if (this.interaction.kind === "path") this.finishPath(false);
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
    if (hit && isShape(hit)) return this.editContainerText(hit);
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
    const el = createText(c.x, c.y, this.state.currentStyle, "", container.id);
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
        this.store.set({ editingTextId: null, tool: "pick", selectedIds: select(el.containerId) });
      }
      return;
    }
    if (session) this.store.commitFrom(session.before);
    this.store.set({ editingTextId: null, tool: "pick", selectedIds: select(selectId) });
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
      case "shape": {
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
        const dx = p.x - it.start.x;
        const dy = p.y - it.start.y;
        this.store.updateElements(moveElements(it.base, it.ids, dx, dy));
        return;
      }
      case "resize": {
        if (it.ids.size === 1) {
          const [id] = it.ids;
          const el = it.base.find((e) => e.id === id)!;
          const next = resizeElement(el, it.handle, p, input.shiftKey);
          this.store.updateElements(it.base.map((e) => (e.id === id ? next : e)));
        } else {
          this.store.updateElements(resizeGroup(it.base, it.ids, it.startBounds, it.handle, p));
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
        const inside = elementsInBox(this.state.elements, box).map((e) => e.id);
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
          endBinding: it.index === 0 ? el.endBinding : null,
        };
        const next = fromAbsolutePoints(detached, pts);
        this.store.updateElements(this.state.elements.map((e) => (e.id === it.id ? next : e)));
        if (el.type === "arrow") {
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
      case "shape": {
        this.interaction = { kind: "none" };
        const el = this.find(it.id);
        const zoom = this.state.viewport.zoom;
        if (!el || (el.width * zoom < 3 && el.height * zoom < 3)) {
          this.store.set({ elements: it.before.elements });
          return;
        }
        this.store.commitFrom(it.before, { selectedIds: new Set([it.id]), tool: "pick" });
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
        this.store.commitFrom(it.before, { selectedIds: new Set([it.id]), tool: "pick" });
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
      case "resize":
      case "rotate":
        this.interaction = { kind: "none" };
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
        if (el && el.type === "arrow") {
          const target = bindingTargetAt(this.state.elements, p, new Set([it.id]));
          const other = it.index === 0 ? el.endBinding : el.startBinding;
          const binding =
            target && other?.elementId !== target.id ? { elementId: target.id } : null;
          const next: LinearElement =
            it.index === 0 ? { ...el, startBinding: binding } : { ...el, endBinding: binding };
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
    if (hit && isShape(hit)) return this.editContainerText(hit);
    if (hit) return;
    // double-clicking inside an unfilled shape still edits its label
    const container = bindingTargetAt(elements, p);
    if (container && isShape(container) && !container.locked)
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
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      this.store.set({ viewport: zoomAt(v, v.zoom * factor, { x: e.x, y: e.y }) });
      return;
    }
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    this.store.set({ viewport: panBy(v, -dx, -dy) });
  }

  /** Cancels any in-progress gesture (used on Escape and blur). */
  cancel() {
    const it = this.interaction;
    if (it.kind === "path") return this.finishPath(false);
    if (it.kind === "box") this.setOverlay({ selectionBox: null });
    if (
      it.kind === "shape" ||
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

  private find(id: string) {
    return this.state.elements.find((e) => e.id === id);
  }

  private patchElement(id: string, patch: Partial<SceneElement>) {
    this.store.updateElements(
      this.state.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as SceneElement) : e)),
    );
  }

  /** Hit test helper exposed for the UI (e.g. context checks). */
  hit(p: Point) {
    return this.state.elements.some((e) => hitElement(e, p, this.tolerance()));
  }

  selectionWithText() {
    return withBoundTexts(this.state.elements, this.state.selectedIds);
  }
}
