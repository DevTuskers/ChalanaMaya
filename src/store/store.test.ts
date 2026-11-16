import { describe, expect, it } from "vitest";
import { createShape, createText } from "../scene/elements";
import { wrapText } from "../scene/text";
import {
  applyStyle,
  clearCanvas,
  deleteSelected,
  duplicateSelected,
  fitToContent,
  insertText,
  selectAll,
  undo,
  redo,
  zoomBy,
} from "./actions";
import { Store, initialState } from "./store";

const withShapes = () => {
  const store = new Store(initialState());
  const a = { ...createShape("rectangle", 0, 0), width: 100, height: 80 };
  const b = { ...createShape("ellipse", 300, 0), width: 100, height: 80 };
  store.commit([a, b]);
  return { store, a, b };
};

describe("store actions", () => {
  it("select all, duplicate and delete are undoable", () => {
    const { store } = withShapes();
    selectAll(store);
    expect(store.get().selectedIds.size).toBe(2);
    duplicateSelected(store);
    expect(store.get().elements).toHaveLength(4);
    deleteSelected(store);
    expect(store.get().elements).toHaveLength(2);
    undo(store);
    expect(store.get().elements).toHaveLength(4);
    redo(store);
    expect(store.get().elements).toHaveLength(2);
  });

  it("applies styles to the selection and to new elements", () => {
    const { store, a } = withShapes();
    store.set({ selectedIds: new Set([a.id]) });
    applyStyle(store, { strokeColor: "#b65b24", strokeWidth: 4.5 });
    const el = store.get().elements.find((e) => e.id === a.id)!;
    expect(el.strokeColor).toBe("#b65b24");
    expect(store.get().currentStyle.strokeColor).toBe("#b65b24");
    // other element untouched
    expect(store.get().elements[1].strokeColor).not.toBe("#b65b24");
  });

  it("applies font settings to text inside a selected shape", () => {
    const { store, a } = withShapes();
    const label = { ...createText(0, 0, undefined, "Hi"), containerId: a.id };
    store.commit([...store.get().elements, label]);
    store.set({ selectedIds: new Set([a.id]) });
    applyStyle(store, { fontFamily: "code", textAlign: "right" });
    const t = store.get().elements.find((e) => e.id === label.id)!;
    expect(t).toMatchObject({ fontFamily: "code", textAlign: "right" });
  });

  it("clear canvas removes everything including locked elements and can be undone", () => {
    const { store } = withShapes();
    store.commit([...store.get().elements, { ...createShape("diamond", 0, 0), locked: true }]);
    clearCanvas(store);
    expect(store.get().elements).toHaveLength(0);
    undo(store);
    expect(store.get().elements).toHaveLength(3);
  });

  it("fires the autosave hook on scene changes", () => {
    const { store } = withShapes();
    let n = 0;
    store.onSceneChange = () => n++;
    insertText(store, "note");
    expect(n).toBeGreaterThan(0);
    expect(store.get().elements.at(-1)).toMatchObject({ type: "text", text: "note" });
  });

  it("zooms and fits to content", () => {
    const { store } = withShapes();
    zoomBy(store, 2);
    expect(store.get().viewport.zoom).toBe(2);
    store.viewSize = { width: 400, height: 300 };
    fitToContent(store, false);
    const v = store.get().viewport;
    expect(v.zoom).toBeLessThan(1);
    // content centre (200, 40) lands in the middle of the view
    expect((200 + v.scrollX) * v.zoom).toBeCloseTo(200);
  });
});

describe("text wrapping", () => {
  it("keeps explicit line breaks and wraps long text", () => {
    expect(wrapText("a\nb", "16px sans-serif", null)).toEqual(["a", "b"]);
    const lines = wrapText("one two three four five six", "16px sans-serif", 60);
    expect(lines.length).toBeGreaterThan(1);
  });
});
