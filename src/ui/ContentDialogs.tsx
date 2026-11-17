import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import {
  insertChart,
  insertComponent,
  insertMediaLink,
  insertText,
  insertWebCard,
} from "../store/actions";
import { buildComponentDoc } from "../media/componentDoc";
import {
  checkCustomContent,
  checkPresetParams,
  COMPONENT_LIMITS,
  COMPONENT_RULES,
  PRESETS,
  presetByName,
  type ComponentSource,
  type ParamValue,
  type PresetName,
} from "../shared/components";
import { mimeFromUrl, normaliseRemoteUrl } from "../shared/urls";
import {
  buildChart,
  chartKindProblem,
  parseSpreadsheet,
  SERIES_COLORS,
  type ChartKind,
} from "../scene/chart";
import { resolveWebCard, WEB_CARD_PROVIDERS } from "../scene/webcard";
import { exportToSvg } from "../io/svg";
import { brandFontCss } from "../io/flows";
import type { Point } from "../scene/types";
import { useAppState, useServices } from "./context";
import { Modal } from "./Dialogs";

/** Asks for the link of a new web card (DRAW-14). */
export const WebCardDialog = ({ at, onClose }: { at: Point; onClose: () => void }) => {
  const { store } = useServices();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const res = value.trim() ? resolveWebCard(value) : null;
  return (
    <Modal title="Web card" onClose={onClose} testId="webcard-dialog">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const err = insertWebCard(store, at, value);
          if (err) setError(err);
        }}
      >
        <label className="field">
          <span>Link to a video, design or web page</span>
          <input
            data-autofocus
            data-testid="webcard-input"
            value={value}
            placeholder="https://www.youtube.com/watch?v=…"
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p className="dialog-note" data-testid="webcard-preview">
          {res?.ok
            ? res.target.kind === "embed"
              ? `${res.target.provider} — the page plays inside the card. Double-click the card to use it.`
              : `${res.target.host} — shown as a safe link you can open in a new tab.`
            : `${WEB_CARD_PROVIDERS.join(", ")} links play inside the card; other sites appear as a safe link.`}
        </p>
        {error ? (
          <p className="form-error" role="alert" data-testid="webcard-error">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" data-testid="webcard-save">
            Add web card
          </button>
        </div>
      </form>
    </Modal>
  );
};

/**
 * Adds a picture, GIF or video by its link on another site (MEDIA-05). The
 * link is shown live by this browser; the server only stores it.
 */
export const MediaLinkDialog = ({ onClose }: { onClose: () => void }) => {
  const { store } = useServices();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const check = value.trim() ? normaliseRemoteUrl(value) : null;
  const mime = check?.ok ? mimeFromUrl(check.url) : undefined;
  const [kind, setKind] = useState<"" | "image/png" | "image/gif" | "video/mp4">("");
  return (
    <Modal title="Media link" onClose={onClose} testId="medialink-dialog">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void insertMediaLink(store, value, kind || undefined).then((ok) => {
            setBusy(false);
            if (ok) onClose();
          });
        }}
      >
        <label className="field">
          <span>Link to a picture, GIF or video (https)</span>
          <input
            data-autofocus
            data-testid="medialink-input"
            value={value}
            placeholder="https://media.example.com/clip.mp4"
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {check?.ok && !mime ? (
          <label className="field">
            <span>What is it?</span>
            <select
              data-testid="medialink-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="">Choose…</option>
              <option value="image/png">Picture</option>
              <option value="image/gif">GIF</option>
              <option value="video/mp4">Video</option>
            </select>
          </label>
        ) : null}
        <p className="dialog-note" data-testid="medialink-note">
          {check && !check.ok
            ? `This link ${check.reason}.`
            : "Shown live in the browser, never fetched by the server. Exports show a placeholder card instead; uploading the file gives full support."}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            data-testid="medialink-save"
            disabled={busy || !check?.ok || (!mime && !kind)}
          >
            Add media
          </button>
        </div>
      </form>
    </Modal>
  );
};

const KINDS: { id: ChartKind; label: string }[] = [
  { id: "bar", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "radar", label: "Radar" },
];

/** Preview of pasted spreadsheet rows before they become a chart (FILE-09). */
export const ChartDialog = ({ text, onClose }: { text: string; onClose: () => void }) => {
  const { store } = useServices();
  const theme = useAppState((s) => s.theme);
  const style = useAppState((s) => s.currentStyle);
  const [value, setValue] = useState(text);
  const [kind, setKind] = useState<ChartKind>("bar");
  // the preview is an <img>, which can't see page fonts, so embed the brand fonts
  const [fontCss, setFontCss] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void brandFontCss().then((css) => {
      if (live) setFontCss(css);
    });
    return () => {
      live = false;
    };
  }, []);
  const parsed = useMemo(() => parseSpreadsheet(value), [value]);
  const problem = parsed.ok ? chartKindProblem(kind, parsed.data) : parsed.error;
  const preview = useMemo(() => {
    if (!parsed.ok || problem) return null;
    return exportToSvg(
      buildChart(parsed.data, kind, { x: 0, y: 0 }, style),
      {},
      {
        theme,
        background: null,
        padding: 12,
        fontCss,
      },
    );
  }, [parsed, kind, problem, theme, style, fontCss]);
  return (
    <Modal title="Chart from spreadsheet" onClose={onClose} testId="chart-dialog" wide>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.ok && !problem) insertChart(store, parsed.data, kind);
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="Chart type">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              tabIndex={kind === k.id ? 0 : -1}
              data-testid={`chart-kind-${k.id}`}
              onKeyDown={(e) => {
                const i = KINDS.findIndex((x) => x.id === kind);
                let next = -1;
                if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % KINDS.length;
                else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
                  next = (i - 1 + KINDS.length) % KINDS.length;
                else if (e.key === "Home") next = 0;
                else if (e.key === "End") next = KINDS.length - 1;
                if (next < 0) return;
                e.preventDefault();
                setKind(KINDS[next].id);
                const group = e.currentTarget.parentElement;
                const btn = group?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next];
                btn?.focus();
              }}
              className={kind === k.id ? "is-active" : ""}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="chart-preview-row">
          <div className="chart-preview" data-testid="chart-preview">
            {preview ? (
              <img
                alt={`${kind} chart preview`}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`}
              />
            ) : (
              <p className="dialog-note">No preview until the data is fixed.</p>
            )}
          </div>
          {parsed.ok ? (
            <div className="chart-summary" data-testid="chart-summary">
              <p>
                <strong>Labels:</strong>{" "}
                <span data-testid="chart-labels">{parsed.data.labels.join(", ")}</span>
              </p>
              {parsed.data.series.map((s, i) => (
                <p key={s.name + i}>
                  <span
                    className="chart-swatch"
                    style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                  />
                  <strong>{s.name}:</strong> {s.values.join(", ")}
                </p>
              ))}
            </div>
          ) : null}
        </div>
        <label className="field">
          <span>Pasted rows (labels in the first column, numbers beside them)</span>
          <textarea
            data-testid="chart-data"
            rows={4}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {problem ? (
          <p className="form-error" role="alert" data-testid="chart-error">
            {problem}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="btn"
            data-testid="chart-as-text"
            onClick={() => {
              onClose();
              insertText(store, text);
            }}
          >
            Paste as words
          </button>
          <button type="button" className="btn" data-testid="chart-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            data-testid="chart-insert"
            disabled={!parsed.ok || !!problem}
          >
            Add chart
          </button>
        </div>
      </form>
    </Modal>
  );
};

const SAMPLE_HTML = '<div class="badge">Live</div>';
const SAMPLE_CSS =
  "body{display:flex;align-items:center;justify-content:center}\n.badge{padding:8px 18px;border-radius:999px;background:#007f78;color:#fff;font:600 18px system-ui;animation:glow 1.5s ease-in-out infinite alternate}\n@keyframes glow{to{box-shadow:0 0 18px #007f78}}";

/**
 * Adds an animated component (MEDIA-05/06): a built-in preset with its
 * settings, or custom HTML and CSS, with a live preview in the same
 * sandboxed frame the board uses. The rules are the server's rules.
 */
export const ComponentDialog = ({ onClose }: { onClose: () => void }) => {
  const { store } = useServices();
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [preset, setPreset] = useState<PresetName>("pulse");
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState(SAMPLE_HTML);
  const [css, setCss] = useState(SAMPLE_CSS);
  const [error, setError] = useState<string | null>(null);
  const def = presetByName(preset)!;
  const source: ComponentSource =
    mode === "preset" ? { kind: "preset", preset, params } : { kind: "custom", html, css };
  const problem =
    mode === "custom"
      ? checkCustomContent(html, css)
      : (() => {
          const e = checkPresetParams(preset, params);
          return e
            ? { field: e.path, rule: "bad_parameter", message: `${e.path} ${e.reason}` }
            : null;
        })();
  const doc = useMemo(
    () => (problem ? "" : buildComponentDoc(DOMPurify, source, false)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, preset, JSON.stringify(params), html, css, !!problem],
  );
  return (
    <Modal title="Animated component" onClose={onClose} testId="component-dialog">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const err = insertComponent(store, source, title.trim());
          if (err) setError(err);
        }}
      >
        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "preset"}
            className={`btn${mode === "preset" ? " primary" : ""}`}
            data-testid="component-mode-preset"
            onClick={() => setMode("preset")}
          >
            Built-in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "custom"}
            className={`btn${mode === "custom" ? " primary" : ""}`}
            data-testid="component-mode-custom"
            onClick={() => setMode("custom")}
          >
            Custom HTML and CSS
          </button>
        </div>
        <label className="field">
          <span>Title (shown in exports)</span>
          <input
            data-testid="component-title"
            value={title}
            maxLength={COMPONENT_LIMITS.title}
            placeholder={mode === "preset" ? def.title : "Custom component"}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {mode === "preset" ? (
          <>
            <label className="field">
              <span>Component</span>
              <select
                data-testid="component-preset"
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value as PresetName);
                  setParams({});
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="dialog-note">{def.description}</p>
            {def.params.map((p) => {
              const v = params[p.name] ?? p.default;
              const set = (val: ParamValue) => setParams({ ...params, [p.name]: val });
              return (
                <label className="field" key={p.name}>
                  <span>
                    {p.name} <small>({p.description})</small>
                  </span>
                  {p.type === "choice" ? (
                    <select
                      data-testid={`component-param-${p.name}`}
                      value={String(v)}
                      onChange={(e) => set(e.target.value)}
                    >
                      {p.choices!.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      data-testid={`component-param-${p.name}`}
                      type={p.type === "color" ? "color" : p.type === "number" ? "number" : "text"}
                      min={p.min}
                      max={p.max}
                      step="any"
                      value={String(v)}
                      onChange={(e) =>
                        set(
                          p.type === "number"
                            ? Number(e.target.value)
                            : p.type === "color"
                              ? e.target.value.toLowerCase()
                              : e.target.value,
                        )
                      }
                    />
                  )}
                </label>
              );
            })}
          </>
        ) : (
          <>
            <label className="field">
              <span>HTML (no scripts)</span>
              <textarea
                data-testid="component-html"
                rows={4}
                spellCheck={false}
                value={html}
                onChange={(e) => {
                  setHtml(e.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="field">
              <span>CSS (animations welcome)</span>
              <textarea
                data-testid="component-css"
                rows={5}
                spellCheck={false}
                value={css}
                onChange={(e) => {
                  setCss(e.target.value);
                  setError(null);
                }}
              />
            </label>
            <ul className="dialog-note component-rules" data-testid="component-rules">
              {COMPONENT_RULES.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
        {problem || error ? (
          <p className="form-error" role="alert" data-testid="component-error">
            {problem ? `${problem.message} (${problem.rule})` : error}
          </p>
        ) : (
          <iframe
            className="component-preview"
            data-testid="component-preview"
            title="Preview"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={doc}
          />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            data-testid="component-save"
            disabled={!!problem}
          >
            Add component
          </button>
        </div>
      </form>
    </Modal>
  );
};
