import { copyWithApi, applyStyle, deleteSelected, duplicateSelected } from "../store/actions";
import {
  FILL_SWATCHES,
  FONT_FAMILIES,
  FONT_SIZES,
  STROKE_SWATCHES,
  STROKE_WIDTHS,
  TRANSPARENT,
} from "../scene/constants";
import { hasPoints, isFillable, isShape } from "../scene/elements";
import { getBoundText } from "../scene/scene";
import type { FontFamily, FontSizeName, ItemStyle, SceneElement, TextAlign } from "../scene/types";
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

  const selected = elements.filter((e) => selectedIds.has(e.id));
  const editing = editingId ? elements.find((e) => e.id === editingId) : undefined;
  const subjects: SceneElement[] = editing ? [editing] : selected;
  const drawing = tool !== "pick" && tool !== "hand";
  if (!subjects.length && !drawing) return null;

  // text targets include text bound inside selected shapes
  const texts = subjects.flatMap((e) => {
    if (e.type === "text") return [e];
    const bound = getBoundText(elements, e.id);
    return bound ? [bound] : [];
  });
  const showText = subjects.length ? texts.length > 0 : tool === "text";
  const showFill = subjects.length
    ? subjects.some(isFillable)
    : ["rectangle", "diamond", "ellipse", "line"].includes(tool);
  const showWidth = subjects.length
    ? subjects.some((e) => isShape(e) || hasPoints(e))
    : tool !== "text";
  const showStroke = subjects.length ? subjects.some((e) => e.type !== "image") : true;

  const first = subjects[0];
  const current: ItemStyle = {
    strokeColor: first && first.type !== "image" ? first.strokeColor : style.strokeColor,
    backgroundColor: subjects.find(isFillable)?.backgroundColor ?? style.backgroundColor,
    strokeWidth: subjects.find((e) => isShape(e) || hasPoints(e))?.strokeWidth ?? style.strokeWidth,
    fontFamily: texts[0]?.fontFamily ?? style.fontFamily,
    fontSize: texts[0]?.fontSize ?? style.fontSize,
    textAlign: texts[0]?.textAlign ?? style.textAlign,
  };
  const set = (patch: Partial<ItemStyle>) => applyStyle(store, patch);
  const mod = (k: string) => formatKeys(k);

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
          : "Style for new " + (tool === "text" ? "words" : "shapes")}
      </h2>
      {showStroke ? (
        <Swatches
          legend={showText && !showFill && !showWidth ? "Text colour" : "Stroke colour"}
          colors={STROKE_SWATCHES}
          value={current.strokeColor}
          onPick={(c) => set({ strokeColor: c })}
          testId="stroke"
        />
      ) : null}
      {showFill ? (
        <Swatches
          legend="Fill"
          colors={FILL_SWATCHES}
          value={current.backgroundColor}
          onPick={(c) => set({ backgroundColor: c })}
          testId="fill"
        />
      ) : null}
      {showWidth ? (
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
        </>
      ) : null}
      {selected.length ? (
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
      ) : null}
    </aside>
  );
};
