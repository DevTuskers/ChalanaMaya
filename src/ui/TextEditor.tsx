import { LIMITS } from "../shared/limits";
import { useEffect, useRef } from "react";
import { FONT_FAMILIES, LINE_HEIGHT } from "../scene/constants";
import { getCenter } from "../scene/geometry";
import { sceneToScreen } from "../scene/viewport";
import type { TextElement } from "../scene/types";
import { resolveColor } from "../render/renderScene";
import { useAppState, useServices } from "./context";

/** In-place editor for free and shape-bound text. */
export const TextEditor = () => {
  const { controller } = useServices();
  const editingId = useAppState((s) => s.editingTextId);
  const el = useAppState((s) =>
    s.editingTextId
      ? (s.elements.find((e) => e.id === s.editingTextId) as TextElement | undefined)
      : undefined,
  );
  const viewport = useAppState((s) => s.viewport);
  const theme = useAppState((s) => s.theme);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editingId]);

  if (!el) return null;
  const c = sceneToScreen(getCenter(el), viewport);
  const z = viewport.zoom;
  const width = el.width * z + (el.autoWidth ? el.fontSize * z : 0);
  const height = el.height * z;
  return (
    <textarea
      ref={ref}
      className="text-editor"
      aria-label={el.containerId ? "Text inside shape" : "Text"}
      data-testid="text-editor"
      value={el.text}
      maxLength={LIMITS.textChars}
      spellCheck
      wrap={el.autoWidth ? "off" : "soft"}
      onChange={(e) => controller.updateText(el.id, e.target.value)}
      onBlur={() => controller.finishTextEdit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          controller.finishTextEdit();
        }
      }}
      style={{
        left:
          c.x -
          (el.width * z) / 2 -
          (el.autoWidth && el.textAlign === "center" ? (el.fontSize * z) / 2 : 0) -
          (el.autoWidth && el.textAlign === "right" ? el.fontSize * z : 0),
        top: c.y - height / 2,
        width,
        height,
        transform: el.angle ? `rotate(${el.angle}rad)` : undefined,
        fontFamily: FONT_FAMILIES[el.fontFamily].css,
        fontSize: el.fontSize * z,
        lineHeight: LINE_HEIGHT,
        textAlign: el.textAlign,
        color: resolveColor(el.strokeColor, theme),
        whiteSpace: el.autoWidth ? "pre" : "pre-wrap",
      }}
    />
  );
};
