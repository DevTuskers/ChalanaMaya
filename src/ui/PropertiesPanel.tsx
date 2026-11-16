import {
  alignSelected,
  applyStyle,
  copyStyles,
  copyWithApi,
  deleteSelected,
  distributeSelected,
  duplicateSelected,
  flipSelected,
  groupSelected,
  lockSelected,
  pasteStyles,
  removeFrameKeepContents,
  reorderSelected,
  resetImageCrop,
  setFrameName,
  switchSelectedType,
  ungroupSelected,
} from "../store/actions";
import { acceptsStyle } from "../scene/arrange";
import {
  FILL_SWATCHES,
  FONT_FAMILIES,
  FONT_SIZES,
  STROKE_SWATCHES,
  STROKE_WIDTHS,
  NOTE_SWATCHES,
  ROUGHNESS_LEVELS,
  TRANSPARENT,
} from "../scene/constants";
import { isShape } from "../scene/elements";
import { getBoundText } from "../scene/scene";
import type {
  Arrowhead,
  FillStyle,
  FontFamily,
  FontSizeName,
  ItemStyle,
  Routing,
  SceneElement,
  StrokeStyle,
  TextAlign,
} from "../scene/types";
import { useState } from "react";
import { resolveColor } from "../render/renderScene";
import { useAppState, useServices } from "./context";
import { HintButton } from "./Hint";
import { Icon } from "./icons";
import { formatKeys } from "./shortcuts";

const COLOR_NAMES: Record<string, string> = {
  "#193a36": "Ink",
  "#007f78": "Lagoon",
  "#b65b24": "Clay",
  "#c0392b": "Brick red",
  "#2f6fb5": "Harbour blue",
  "#6b8e23": "Moss",
  transparent: "No fill",
  "#bfe8e2": "Sea glass",
  "#ffd9b8": "Apricot",
  "#f7c6c1": "Blush",
  "#c9dcf5": "Sky",
  "#e3edc2": "Lime wash",
  "#ffe59a": "Butter",
  "#ffd2b0": "Peach",
  "#c9efe6": "Mint",
  "#d6e4fb": "Cloud",
  "#f6d0e2": "Rose",
};

const ARROWHEAD_OPTIONS: { value: Arrowhead; label: string }[] = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "triangle", label: "Triangle" },
  { value: "triangle-outline", label: "Triangle outline" },
  { value: "circle", label: "Dot" },
  { value: "circle-outline", label: "Ring" },
  { value: "diamond", label: "Diamond" },
  { value: "diamond-outline", label: "Diamond outline" },
  { value: "bar", label: "Bar" },
  { value: "er-one", label: "Exactly one" },
  { value: "er-many", label: "Many" },
  { value: "er-zero-one", label: "Zero or one" },
  { value: "er-zero-many", label: "Zero or many" },
  { value: "er-one-many", label: "One or many" },
  { value: "er-zero", label: "Zero" },
];

const Select = <T extends string>({
  label,
  value,
  options,
  onPick,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onPick: (v: T) => void;
  testId: string;
}) => (
  <label className="prop-select">
    <span>{label}</span>
    <select data-testid={testId} value={value} onChange={(e) => onPick(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </label>
);

const Btn = ({
  label,
  testId,
  onClick,
  keys,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  keys?: string;
}) => (
  <HintButton
    label={label}
    shortcut={keys}
    side="bottom"
    data-testid={testId}
    className="text-btn"
    onClick={onClick}
  >
    {label}
  </HintButton>
);

const FrameName = ({ id, name }: { id: string; name: string }) => {
  const { store } = useServices();
  const [value, setValue] = useState(name);
  return (
    <label className="prop-select">
      <span>Frame name</span>
      <input
        data-testid="frame-name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== name && setFrameName(store, id, value.trim() || "Page")}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
    </label>
  );
};

const Swatches = ({
  legend,
  colors,
  value,
  onPick,
  testId,
}: {
  legend: string;
  colors: string[];
  value: string;
  onPick: (c: string) => void;
  testId: string;
}) => {
  const theme = useAppState((s) => s.theme);
  return (
    <fieldset className="prop-group">
      <legend>{legend}</legend>
      <div className="swatches" role="radiogroup" aria-label={legend}>
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value.toLowerCase() === c}
            aria-label={COLOR_NAMES[c] ?? c}
            title={COLOR_NAMES[c] ?? c}
            data-testid={`${testId}-${c.replace("#", "")}`}
            className={`swatch${c === TRANSPARENT ? " swatch-none" : ""}`}
            style={{ background: c === TRANSPARENT ? undefined : resolveColor(c, theme) }}
            onClick={() => onPick(c)}
          />
        ))}
        <label className="swatch swatch-custom" title="Custom colour">
          <span className="sr-only">Custom {legend.toLowerCase()}</span>
          <input
            type="color"
            data-testid={`${testId}-custom`}
            value={value === TRANSPARENT ? "#ffffff" : value}
            onChange={(e) => onPick(e.target.value)}
          />
        </label>
      </div>
    </fieldset>
  );
};

function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onPick,
  testId,
}: {
  legend: string;
  options: { value: T; label: string; content?: React.ReactNode }[];
  value: T | undefined;
  onPick: (v: T) => void;
  testId: string;
}) {
  return (
    <fieldset className="prop-group">
      <legend>{legend}</legend>
      <div className="segmented" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.label}
            title={o.label}
            data-testid={`${testId}-${o.value}`}
            className={value === o.value ? "is-active" : ""}
            onClick={() => onPick(o.value)}
          >
            {o.content ?? o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const sizeName = (size: number): FontSizeName | undefined =>
  (Object.keys(FONT_SIZES) as FontSizeName[]).find((k) => FONT_SIZES[k].value === size);

/** Right-side panel: style controls for the current tool or selection. */
export const PropertiesPanel = () => {
  const { store } = useServices();
  const tool = useAppState((s) => s.tool);
  const elements = useAppState((s) => s.elements);
  const selectedIds = useAppState((s) => s.selectedIds);
  const style = useAppState((s) => s.currentStyle);
  const editingId = useAppState((s) => s.editingTextId);
  const croppingId = useAppState((s) => s.croppingId);
  const editingPointsId = useAppState((s) => s.editingPointsId);
  const copiedStyle = useAppState((s) => s.copiedStyle);
  const viewMode = useAppState((s) => s.viewMode);

  if (viewMode) return null;
  const selected = elements.filter((e) => selectedIds.has(e.id));
  const editing = editingId ? elements.find((e) => e.id === editingId) : undefined;
  const subjects: SceneElement[] = editing ? [editing] : selected;
  const drawingTools = [
    "rectangle",
    "diamond",
    "ellipse",
    "arrow",
    "line",
    "freedraw",
    "text",
    "note",
  ];
  const drawing = drawingTools.includes(tool);
  if (!subjects.length && !drawing) return null;

  const texts = subjects.flatMap((e) => {
    if (e.type === "text") return [e];
    const bound = getBoundText(elements, e.id);
    return bound ? [bound] : [];
  });
  // a stand-in element for "new item" style, so the same rules decide what is shown
  const proto = {
    type: tool === "freedraw" ? "freedraw" : tool,
    containerId: null,
    closed: false,
    routing: style.routing,
  } as unknown as SceneElement;
  const pool: SceneElement[] = subjects.length ? [...subjects, ...texts] : [proto];
  const can = (k: keyof ItemStyle) => pool.some((e) => acceptsStyle(e, k));
  const showText = subjects.length ? texts.length > 0 : tool === "text" || tool === "note";
  const isNoteOnly = pool.every((e) => e.type === "note");

  const first = subjects[0] as (SceneElement & Partial<ItemStyle>) | undefined;
  const pick = <K extends keyof ItemStyle>(k: K): ItemStyle[K] => {
    const holder = pool.find((e) => e !== proto && acceptsStyle(e, k)) as unknown as
      ItemStyle | undefined;
    return holder ? holder[k] : style[k];
  };
  const current: ItemStyle = {
    strokeColor: first && first.type !== "image" ? first.strokeColor : style.strokeColor,
    backgroundColor: pick("backgroundColor"),
    strokeWidth: pick("strokeWidth"),
    fontFamily: texts[0]?.fontFamily ?? style.fontFamily,
    fontSize: texts[0]?.fontSize ?? style.fontSize,
    textAlign: texts[0]?.textAlign ?? style.textAlign,
    fillStyle: pick("fillStyle"),
    strokeStyle: pick("strokeStyle"),
    roughness: pick("roughness"),
    edges: pick("edges"),
    opacity: subjects[0]?.opacity ?? style.opacity,
    routing: pick("routing"),
    startArrowhead: pick("startArrowhead"),
    endArrowhead: pick("endArrowhead"),
  };
  const set = (patch: Partial<ItemStyle>) => applyStyle(store, patch);
  const mod = (k: string) => formatKeys(k);
  const single = selected.length === 1 ? selected[0] : null;
  const allShapes = selected.length > 0 && selected.every(isShape);
  const allConnectors =
    selected.length > 0 &&
    selected.every((e) => (e.type === "arrow" || e.type === "line") && !e.closed);
  const grouped = selected.some((e) => e.groupIds.length > 0);

  return (
    <aside
      className="props panel"
      aria-label={subjects.length ? "Selection properties" : "New element style"}
      data-testid="properties"
      onPointerDown={(e) => {
        // keep text editing alive while choosing styles
        if (editing) e.preventDefault();
      }}
    >
      <h2 className="props-title">
        {subjects.length
          ? `${subjects.length} selected`
          : "Style for new " + (tool === "text" ? "words" : tool === "note" ? "notes" : "shapes")}
      </h2>
      {can("strokeColor") || showText ? (
        <Swatches
          legend={
            showText && !can("backgroundColor") && !can("strokeWidth")
              ? "Text colour"
              : "Stroke colour"
          }
          colors={STROKE_SWATCHES}
          value={current.strokeColor}
          onPick={(c) => set({ strokeColor: c })}
          testId="stroke"
        />
      ) : null}
      {can("backgroundColor") ? (
        <Swatches
          legend={isNoteOnly ? "Note colour" : "Fill"}
          colors={isNoteOnly ? NOTE_SWATCHES : FILL_SWATCHES}
          value={current.backgroundColor}
          onPick={(c) => set({ backgroundColor: c })}
          testId="fill"
        />
      ) : null}
      {can("fillStyle") ? (
        <Segmented<FillStyle>
          legend="Fill pattern"
          testId="fillstyle"
          value={current.fillStyle}
          onPick={(v) => set({ fillStyle: v })}
          options={[
            { value: "hachure", label: "Hatching" },
            { value: "cross-hatch", label: "Cross-hatch" },
            { value: "zigzag", label: "Zigzag" },
            { value: "solid", label: "Solid" },
          ]}
        />
      ) : null}
      {can("strokeWidth") ? (
        <Segmented<string>
          legend="Stroke width"
          testId="width"
          value={STROKE_WIDTHS.find((w) => w.value === current.strokeWidth)?.id}
          onPick={(v) => set({ strokeWidth: STROKE_WIDTHS.find((w) => w.id === v)!.value })}
          options={STROKE_WIDTHS.map((w) => ({
            value: w.id,
            label: w.label,
            content: (
              <svg width="28" height="16" aria-hidden="true">
                <path
                  d="M3 9c6-3 15 2 22-2"
                  stroke="currentColor"
                  strokeWidth={w.value}
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            ),
          }))}
        />
      ) : null}
      {can("strokeStyle") ? (
        <Segmented<StrokeStyle>
          legend="Stroke style"
          testId="strokestyle"
          value={current.strokeStyle}
          onPick={(v) => set({ strokeStyle: v })}
          options={(["solid", "dashed", "dotted"] as const).map((v) => ({
            value: v,
            label: v[0].toUpperCase() + v.slice(1),
            content: (
              <svg width="28" height="16" aria-hidden="true">
                <path
                  d="M3 8h22"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={v === "dashed" ? "6 4" : v === "dotted" ? "0.5 4" : undefined}
                />
              </svg>
            ),
          }))}
        />
      ) : null}
      {can("roughness") ? (
        <Segmented<string>
          legend="Sloppiness"
          testId="roughness"
          value={String(current.roughness)}
          onPick={(v) => set({ roughness: Number(v) as 0 | 1 | 2 })}
          options={ROUGHNESS_LEVELS.map((r) => ({ value: String(r.value), label: r.label }))}
        />
      ) : null}
      {can("edges") ? (
        <Segmented<"sharp" | "round">
          legend="Edges"
          testId="edges"
          value={current.edges}
          onPick={(v) => set({ edges: v })}
          options={[
            { value: "sharp", label: "Sharp" },
            { value: "round", label: "Round" },
          ]}
        />
      ) : null}
      {can("routing") ? (
        <>
          <Segmented<Routing>
            legend="Connector route"
            testId="routing"
            value={current.routing}
            onPick={(v) => set({ routing: v })}
            options={[
              { value: "straight", label: "Straight" },
              { value: "curved", label: "Curved" },
              { value: "elbow", label: "Elbow" },
            ]}
          />
          <div className="prop-row">
            <Select
              label="Start"
              testId="start-head"
              value={current.startArrowhead}
              options={ARROWHEAD_OPTIONS}
              onPick={(v) => set({ startArrowhead: v })}
            />
            <Select
              label="End"
              testId="end-head"
              value={current.endArrowhead}
              options={ARROWHEAD_OPTIONS}
              onPick={(v) => set({ endArrowhead: v })}
            />
          </div>
        </>
      ) : null}
      {showText ? (
        <>
          <Segmented<FontFamily>
            legend="Font"
            testId="font"
            value={current.fontFamily}
            onPick={(v) => set({ fontFamily: v })}
            options={(Object.keys(FONT_FAMILIES) as FontFamily[]).map((f) => ({
              value: f,
              label: FONT_FAMILIES[f].label,
              content: (
                <span style={{ fontFamily: FONT_FAMILIES[f].css }}>{FONT_FAMILIES[f].label}</span>
              ),
            }))}
          />
          <Segmented<FontSizeName>
            legend="Text size"
            testId="size"
            value={sizeName(current.fontSize)}
            onPick={(v) => set({ fontSize: FONT_SIZES[v].value })}
            options={(Object.keys(FONT_SIZES) as FontSizeName[]).map((k) => ({
              value: k,
              label: FONT_SIZES[k].label,
              content: k.toUpperCase(),
            }))}
          />
          {pool.some((e) => e.type === "text" && !e.containerId) ||
          (!subjects.length && tool === "text") ? (
            <Segmented<TextAlign>
              legend="Alignment"
              testId="align"
              value={current.textAlign}
              onPick={(v) => set({ textAlign: v })}
              options={[
                { value: "left", label: "Align left", content: <Icon.alignLeft /> },
                { value: "center", label: "Align centre", content: <Icon.alignCenter /> },
                { value: "right", label: "Align right", content: <Icon.alignRight /> },
              ]}
            />
          ) : null}
        </>
      ) : null}
      <label className="prop-select prop-range">
        <span>Opacity {current.opacity}%</span>
        <input
          type="range"
          min={0}
          max={100}
          step={10}
          data-testid="opacity"
          value={current.opacity}
          onChange={(e) => set({ opacity: Number(e.target.value) })}
        />
      </label>
      {single?.type === "frame" ? (
        <fieldset className="prop-group">
          <legend>Page frame</legend>
          <FrameName key={single.id} id={single.id} name={single.name} />
          <div className="prop-actions wrap">
            <Btn
              label="Remove frame, keep contents"
              testId="frame-unwrap"
              onClick={() => removeFrameKeepContents(store, single.id)}
            />
          </div>
        </fieldset>
      ) : null}
      {single?.type === "image" ? (
        <fieldset className="prop-group">
          <legend>Picture</legend>
          <div className="prop-actions wrap">
            <Btn
              label={croppingId === single.id ? "Done cropping" : "Crop"}
              testId="crop-toggle"
              onClick={() => store.set({ croppingId: croppingId === single.id ? null : single.id })}
            />
            <Btn label="Reset crop" testId="crop-reset" onClick={() => resetImageCrop(store)} />
          </div>
        </fieldset>
      ) : null}
      {single && (single.type === "arrow" || single.type === "line") ? (
        <div className="prop-actions wrap">
          <Btn
            label={editingPointsId === single.id ? "Done editing points" : "Edit points"}
            testId="edit-points"
            onClick={() =>
              store.set({
                editingPointsId: editingPointsId === single.id ? null : single.id,
                editingPointIndex: null,
              })
            }
          />
        </div>
      ) : null}
      {allShapes || allConnectors ? (
        <fieldset className="prop-group">
          <legend>Switch type</legend>
          <div className="prop-actions wrap">
            {(allShapes
              ? ([
                  ["rectangle", "Box"],
                  ["diamond", "Diamond"],
                  ["ellipse", "Oval"],
                ] as const)
              : ([
                  ["arrow", "Connector"],
                  ["line", "Path"],
                ] as const)
            ).map(([t, label]) => (
              <Btn
                key={t}
                label={label}
                testId={`switch-${t}`}
                onClick={() => switchSelectedType(store, t)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      {selected.length ? (
        <>
          <fieldset className="prop-group">
            <legend>Layers</legend>
            <div className="prop-actions wrap">
              <Btn
                label="To back"
                testId="z-back"
                keys={mod("Mod+Shift+[")}
                onClick={() => reorderSelected(store, "back")}
              />
              <Btn
                label="Backward"
                testId="z-backward"
                keys={mod("Mod+[")}
                onClick={() => reorderSelected(store, "backward")}
              />
              <Btn
                label="Forward"
                testId="z-forward"
                keys={mod("Mod+]")}
                onClick={() => reorderSelected(store, "forward")}
              />
              <Btn
                label="To front"
                testId="z-front"
                keys={mod("Mod+Shift+]")}
                onClick={() => reorderSelected(store, "front")}
              />
            </div>
          </fieldset>
          {selected.length > 1 ? (
            <fieldset className="prop-group">
              <legend>Align</legend>
              <div className="prop-actions wrap">
                <Btn
                  label="Left"
                  testId="align-left"
                  onClick={() => alignSelected(store, "left")}
                />
                <Btn
                  label="Centre"
                  testId="align-hcenter"
                  onClick={() => alignSelected(store, "hcenter")}
                />
                <Btn
                  label="Right"
                  testId="align-right"
                  onClick={() => alignSelected(store, "right")}
                />
                <Btn label="Top" testId="align-top" onClick={() => alignSelected(store, "top")} />
                <Btn
                  label="Middle"
                  testId="align-vcenter"
                  onClick={() => alignSelected(store, "vcenter")}
                />
                <Btn
                  label="Bottom"
                  testId="align-bottom"
                  onClick={() => alignSelected(store, "bottom")}
                />
                <Btn
                  label="Space across"
                  testId="distribute-h"
                  onClick={() => distributeSelected(store, "horizontal")}
                />
                <Btn
                  label="Space down"
                  testId="distribute-v"
                  onClick={() => distributeSelected(store, "vertical")}
                />
              </div>
            </fieldset>
          ) : null}
          <fieldset className="prop-group">
            <legend>Arrange</legend>
            <div className="prop-actions wrap">
              {selected.length > 1 ? (
                <Btn
                  label="Group"
                  testId="group"
                  keys={mod("Mod+G")}
                  onClick={() => groupSelected(store)}
                />
              ) : null}
              {grouped ? (
                <Btn
                  label="Ungroup"
                  testId="ungroup"
                  keys={mod("Mod+Shift+G")}
                  onClick={() => ungroupSelected(store)}
                />
              ) : null}
              <Btn
                label="Flip across"
                testId="flip-h"
                keys="Shift+H"
                onClick={() => flipSelected(store, "horizontal")}
              />
              <Btn
                label="Flip down"
                testId="flip-v"
                keys="Shift+V"
                onClick={() => flipSelected(store, "vertical")}
              />
              <Btn
                label="Lock"
                testId="lock"
                keys={mod("Mod+Shift+L")}
                onClick={() => lockSelected(store)}
              />
              <Btn
                label="Link…"
                testId="link"
                keys={mod("Mod+K")}
                onClick={() =>
                  single && store.set({ dialog: { kind: "link", elementId: single.id } })
                }
              />
              <Btn
                label="Copy styles"
                testId="copy-styles"
                keys={mod("Mod+Alt+C")}
                onClick={() => copyStyles(store)}
              />
              {copiedStyle ? (
                <Btn
                  label="Paste styles"
                  testId="paste-styles"
                  keys={mod("Mod+Alt+V")}
                  onClick={() => pasteStyles(store)}
                />
              ) : null}
            </div>
          </fieldset>
          <fieldset className="prop-group">
            <legend>Actions</legend>
            <div className="prop-actions">
              <HintButton
                label="Duplicate"
                shortcut={mod("Mod+D")}
                side="bottom"
                data-testid="action-duplicate"
                onClick={() => duplicateSelected(store)}
              >
                <Icon.duplicate />
              </HintButton>
              <HintButton
                label="Copy"
                shortcut={mod("Mod+C")}
                side="bottom"
                data-testid="action-copy"
                onClick={() => void copyWithApi(store, false)}
              >
                <Icon.copy />
              </HintButton>
              <HintButton
                label="Cut"
                shortcut={mod("Mod+X")}
                side="bottom"
                data-testid="action-cut"
                onClick={() => void copyWithApi(store, true)}
              >
                <Icon.cut />
              </HintButton>
              <HintButton
                label="Delete"
                shortcut="Delete"
                side="bottom"
                data-testid="action-delete"
                onClick={() => deleteSelected(store)}
              >
                <Icon.trash />
              </HintButton>
            </div>
          </fieldset>
        </>
      ) : null}
    </aside>
  );
};
