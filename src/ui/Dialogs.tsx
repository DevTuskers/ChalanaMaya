import { useEffect, useRef, useState, type ReactNode } from "react";
import { clearCanvas, followLink, setLink } from "../store/actions";
import { downloadBlob, exportSize, timestampName } from "../io/export";
import { exportPngBlob, exportSvgText, selectionTargets } from "../io/flows";
import { BOARD_COLORS } from "../scene/constants";
import type { Theme } from "../scene/types";
import type { Store } from "../store/store";
import { useAppState, useServices } from "./context";
import { Icon } from "./icons";
import { ChartDialog, WebCardDialog } from "./ContentDialogs";
import { SHORTCUT_GROUPS, formatKeys } from "./shortcuts";

export const Modal = ({
  title,
  onClose,
  children,
  testId,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
  wide?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const el = ref.current!;
    const doc = el.ownerDocument;
    // the control that opened the dialog gets focus back when it closes
    const prev = doc.activeElement as HTMLElement | null;
    const onClose = () => onCloseRef.current();
    el.querySelector<HTMLElement>("[data-autofocus], button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const items = [
          ...el.querySelectorAll<HTMLElement>("button, input, select, [tabindex='0']"),
        ];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && doc.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && doc.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("keydown", onKey, true);
      const target =
        prev && prev.isConnected && prev !== doc.body
          ? prev
          : doc.querySelector<HTMLElement>("[data-testid=board]");
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`dialog panel${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        ref={ref}
      >
        <header>
          <h2 id={`${testId}-title`}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon.close />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
};

/** AGENT-13: what to give an agent (plan §4.1). */
const ConnectAgentDialog = ({ onClose }: { onClose: () => void }) => {
  const { store } = useServices();
  const info = useAppState((s) => s.session);
  const origin = window.location.origin;
  const id = info?.id ?? "";
  const mcp = `${origin}/mcp`;
  const snippets = [
    {
      key: "http",
      title: "HTTP (Claude Code, Cursor, VS Code, ChatGPT, Devin…)",
      text: JSON.stringify({ mcpServers: { chalanamaya: { url: mcp } } }, null, 2),
    },
    {
      key: "stdio",
      title: "Desktop apps through the stdio bridge (Claude Desktop)",
      text: JSON.stringify(
        {
          mcpServers: {
            chalanamaya: {
              command: "node",
              args: ["/absolute/path/to/ChalanaMaya/dist-server/stdio.js"],
              env: { CHALANAMAYA_URL: origin },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      key: "prompt",
      title: "Then tell the agent",
      text: `On the ChalanaMaya board ${id}, draw a flowchart of …`,
    },
  ];
  const copy = (text: string, what: string) => {
    const p = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"));
    p.then(
      () => store.toast(`${what} copied.`, "success"),
      () => store.toast("The clipboard is not available here, so nothing was copied.", "error"),
    );
  };
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  return (
    <Modal title="Connect an agent" onClose={onClose} testId="connect-agent-dialog" wide>
      <p>
        Agents such as Claude, Devin or ChatGPT draw on this board through ChalanaMaya&apos;s MCP
        server. Set it up once, then give the agent this board&apos;s id.
      </p>
      <p>
        MCP address <code data-testid="connect-mcp-url">{mcp}</code>{" "}
        <button type="button" className="btn" onClick={() => copy(mcp, "MCP address")}>
          Copy
        </button>
      </p>
      <p>
        Board id <code data-testid="connect-session-id">{id}</code>{" "}
        <button
          type="button"
          className="btn"
          data-testid="connect-copy-id"
          onClick={() => copy(id, "Board id")}
        >
          Copy
        </button>
      </p>
      {snippets.map((s) => (
        <section key={s.key}>
          <h3>{s.title}</h3>
          <pre data-testid={`connect-snippet-${s.key}`}>{s.text}</pre>
          <button
            type="button"
            className="btn"
            data-testid={`connect-copy-${s.key}`}
            onClick={() => copy(s.text, "Setup")}
          >
            Copy
          </button>
        </section>
      ))}
      {local ? (
        <p>
          Cloud agents (ChatGPT, Devin) cannot reach this computer&apos;s localhost: they need a
          public HTTPS address for ChalanaMaya, see the setup guide.
        </p>
      ) : null}
      <p className="warning" data-testid="connect-warning">
        Anyone with the board id can change this board. Treat it like a password.
      </p>
    </Modal>
  );
};

const HelpDialog = ({ onClose }: { onClose: () => void }) => (
  <Modal title="Keyboard shortcuts" onClose={onClose} testId="help-dialog" wide>
    <div className="help-grid">
      {SHORTCUT_GROUPS.map((g) => (
        <section key={g.title}>
          <h3>{g.title}</h3>
          <dl>
            {g.items.map((it) => (
              <div key={it.label} className="help-row">
                <dt>{it.label}</dt>
                <dd>
                  {it.keys.map((k, i) => (
                    <span key={k}>
                      {i ? <span className="or"> or </span> : null}
                      <kbd>{formatKeys(k)}</kbd>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
    <p className="dialog-note">
      Shortcuts pause while you type in text or a field. Press Escape to close this dialog. Your
      board is kept in this browser; clearing browser data removes it, so save a .chalana file as a
      backup.
    </p>
  </Modal>
);

const ExportDialog = ({
  onClose,
  initialFormat,
}: {
  onClose: () => void;
  initialFormat: "png" | "svg";
}) => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const selectedIds = useAppState((s) => s.selectedIds);
  const uiTheme = useAppState((s) => s.theme);
  const files = useAppState((s) => s.files);
  const boardColor = useAppState((s) => s.viewBackgroundColor);
  const [format, setFormat] = useState<"png" | "svg">(initialFormat);
  const [theme, setTheme] = useState<Theme>(uiTheme);
  const [onlySelected, setOnlySelected] = useState(selectedIds.size > 0);
  const [background, setBackground] = useState(true);
  const [embed, setEmbed] = useState(false);
  const [scale, setScale] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets =
    onlySelected && selectedIds.size ? selectionTargets(elements, selectedIds) : elements;
  const size = exportSize(targets, scale);

  const doExport = async () => {
    setError(null);
    if (!targets.length) {
      setError("There is nothing to export yet. Draw something first.");
      return;
    }
    setBusy(true);
    try {
      const req = {
        elements: targets,
        files,
        theme,
        background,
        boardColor,
        scale,
        embedScene: embed,
        settings: store.boardSettings(),
      };
      if (format === "png") {
        downloadBlob(await exportPngBlob(req), timestampName("png"));
      } else {
        const svg = await exportSvgText(req);
        downloadBlob(new Blob([svg], { type: "image/svg+xml" }), timestampName("svg"));
      }
      store.toast(`${format.toUpperCase()} exported.`, "success", 2500);
      onClose();
    } catch (e) {
      setError(`Export failed: ${(e as Error).message} Your board is unchanged.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export image" onClose={onClose} testId="export-dialog">
      <div className="form">
        <fieldset>
          <legend>Format</legend>
          <div className="segmented" role="radiogroup" aria-label="Format">
            {(["png", "svg"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                data-testid={`export-format-${f}`}
                className={format === f ? "is-active" : ""}
                onClick={() => setFormat(f)}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Content</legend>
          <label>
            <input
              type="radio"
              name="scope"
              checked={!onlySelected || !selectedIds.size}
              onChange={() => setOnlySelected(false)}
            />
            Whole board
          </label>
          <label className={selectedIds.size ? "" : "is-unavailable"}>
            <input
              type="radio"
              name="scope"
              disabled={!selectedIds.size}
              checked={onlySelected && selectedIds.size > 0}
              onChange={() => setOnlySelected(true)}
            />
            Selection only{selectedIds.size ? "" : " (nothing selected)"}
          </label>
        </fieldset>
        <fieldset>
          <legend>Export colours</legend>
          <div className="segmented" role="radiogroup" aria-label="Export colours">
            {(["light", "dark"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                data-testid={`export-theme-${t}`}
                className={theme === t ? "is-active" : ""}
                onClick={() => setTheme(t)}
              >
                {t === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            data-testid="export-background"
            checked={background}
            onChange={(e) => setBackground(e.target.checked)}
          />
          Include board background
        </label>
        <label className="check">
          <input
            type="checkbox"
            data-testid="export-embed"
            checked={embed}
            onChange={(e) => setEmbed(e.target.checked)}
          />
          Keep it editable (embed board data)
        </label>
        {embed ? (
          <p className="dialog-note warn" data-testid="embed-warning">
            Anyone who gets this file can reopen the full drawing, including anything off-screen in
            the exported items. The file also gets larger.
          </p>
        ) : null}
        <fieldset>
          <legend>Scale</legend>
          <div className="segmented" role="radiogroup" aria-label="Scale">
            {[1, 2, 3].map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scale === s}
                data-testid={`export-scale-${s}`}
                className={scale === s ? "is-active" : ""}
                onClick={() => setScale(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </fieldset>
        <p className="dialog-note" aria-live="polite">
          {size
            ? `Output: ${size.width} × ${size.height} px${format === "svg" ? " (SVG stays sharp at any size)" : ""}. Editor controls are never included.`
            : "The board is empty, so there is nothing to export."}
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="export-confirm"
            disabled={busy}
            onClick={() => void doExport()}
          >
            Export {format.toUpperCase()}
          </button>
        </div>
      </div>
    </Modal>
  );
};

const LinkDialog = ({ elementId, onClose }: { elementId: string; onClose: () => void }) => {
  const { store } = useServices();
  const el = useAppState((s) => s.elements.find((e) => e.id === elementId));
  const [value, setValue] = useState(el?.link ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const err = setLink(store, elementId, value);
    if (err) setError(err);
    else onClose();
  };
  return (
    <Modal title="Link" onClose={onClose} testId="link-dialog">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>Web address, email, or another item on this board</span>
          <input
            data-autofocus
            data-testid="link-input"
            value={value}
            placeholder="https://example.com"
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p className="dialog-note">
          To link to another item, select it and use “Copy link to item” from its Link dialog, then
          paste it here. Links open only when you choose to follow them.
        </p>
        {el ? (
          <button
            type="button"
            className="text-btn"
            data-testid="copy-item-link"
            onClick={(e) => {
              const clip = e.currentTarget.ownerDocument.defaultView?.navigator.clipboard;
              if (!clip) {
                store.toast("The browser blocked the clipboard.", "error");
                return;
              }
              void clip
                .writeText(`#el=${el.id}`)
                .then(() => store.toast("Link to this item copied.", "success", 1800))
                .catch(() => store.toast("The browser blocked the clipboard.", "error"));
            }}
          >
            Copy link to this item
          </button>
        ) : null}
        {error ? (
          <p className="form-error" role="alert" data-testid="link-error">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          {el?.link ? (
            <button
              type="button"
              className="btn"
              data-testid="link-follow"
              onClick={() => {
                onClose();
                followLink(store, el.link!, rootWindow(store));
              }}
            >
              Follow link
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" data-testid="link-save">
            Save link
          </button>
        </div>
      </form>
    </Modal>
  );
};

const rootWindow = (store: Store) => store.ownerWindow;

const OpenLinkDialog = ({ url, onClose }: { url: string; onClose: () => void }) => {
  const { store } = useServices();
  const internal = url.startsWith("#el=");
  return (
    <ConfirmDialog
      title={internal ? "Go to the linked item?" : "Open this link?"}
      testId="open-link-dialog"
      confirmLabel={internal ? "Go to item" : "Open link"}
      tone="primary"
      body={
        <p className="link-preview">
          {internal ? "This link points to another item on this board." : url}
        </p>
      }
      onClose={onClose}
      onConfirm={() => {
        onClose();
        followLink(store, url, rootWindow(store));
      }}
    />
  );
};

const SettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const { store } = useServices();
  const prefs = useAppState((s) => s.prefs);
  const board = useAppState((s) => s.viewBackgroundColor);
  const theme = useAppState((s) => s.theme);
  const viewMode = useAppState((s) => s.viewMode);
  const setPrefs = (patch: Partial<typeof prefs>) => store.set({ prefs: { ...prefs, ...patch } });
  return (
    <Modal title="Board settings" onClose={onClose} testId="settings-dialog">
      <div className="form">
        <fieldset>
          <legend>Board colour</legend>
          <div className="swatches" role="radiogroup" aria-label="Board colour">
            {BOARD_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={board === c.id}
                aria-label={c.label}
                title={c.label}
                data-testid={`board-color-${c.label.toLowerCase()}`}
                className={`swatch${board === c.id ? " is-active" : ""}`}
                style={{ background: c[theme] }}
                disabled={viewMode}
                onClick={() => {
                  store.set({ viewBackgroundColor: c.id });
                  store.onSceneChange?.();
                }}
              />
            ))}
          </div>
          {viewMode ? (
            <p className="dialog-note">Leave look-only mode to change the board colour.</p>
          ) : null}
        </fieldset>
        <fieldset>
          <legend>Navigation</legend>
          <div className="segmented" role="radiogroup" aria-label="Input preference">
            {(
              [
                ["trackpad", "Trackpad"],
                ["mouse", "Mouse"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={prefs.inputPreference === v}
                data-testid={`input-${v}`}
                className={prefs.inputPreference === v ? "is-active" : ""}
                onClick={() => setPrefs({ inputPreference: v })}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="dialog-note" data-testid="input-explainer">
            {prefs.inputPreference === "trackpad"
              ? "Trackpad: two-finger scroll pans the board, pinch (or Ctrl + scroll) zooms. Space + drag also pans."
              : "Mouse: the wheel zooms around the pointer, Shift + wheel scrolls sideways. Drag with Space held or the middle button to pan."}
          </p>
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            data-testid="pref-pen"
            checked={prefs.penMode}
            onChange={(e) => setPrefs({ penMode: e.target.checked })}
          />
          Pen mode — only a stylus draws; fingers pan the board
        </label>
        <label className="check">
          <input
            type="checkbox"
            data-testid="pref-snapping"
            checked={prefs.snapping}
            onChange={(e) => setPrefs({ snapping: e.target.checked })}
          />
          Snap to nearby edges and centres (hold Alt to skip)
        </label>
        <label className="check">
          <input
            type="checkbox"
            data-testid="pref-pressure"
            checked={prefs.pencilPressure}
            onChange={(e) => setPrefs({ pencilPressure: e.target.checked })}
          />
          Pencil pressure — a stylus draws thinner or thicker lines as you press
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
};

const ConfirmDialog = ({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  testId,
  tone = "danger",
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  testId: string;
  tone?: "danger" | "primary";
}) => (
  <Modal title={title} onClose={onClose} testId={testId}>
    <div className="form">
      {body}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          data-autofocus
          data-testid="confirm-cancel"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${tone}`}
          data-testid="confirm-ok"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </Modal>
);

export const Dialogs = () => {
  const { store } = useServices();
  const dialog = useAppState((s) => s.dialog);
  const count = useAppState((s) => s.elements.length);
  const close = () => store.set({ dialog: null });
  if (!dialog) return null;
  switch (dialog.kind) {
    case "help":
      return <HelpDialog onClose={close} />;
    case "export":
      return <ExportDialog onClose={close} initialFormat="png" />;
    case "svg":
      return <ExportDialog onClose={close} initialFormat="svg" />;
    case "link":
      return <LinkDialog elementId={dialog.elementId} onClose={close} />;
    case "openLink":
      return <OpenLinkDialog url={dialog.url} onClose={close} />;
    case "settings":
      return <SettingsDialog onClose={close} />;
    case "connectAgent":
      return <ConnectAgentDialog onClose={close} />;
    case "webcard":
      return <WebCardDialog at={dialog.at} onClose={close} />;
    case "chart":
      return <ChartDialog text={dialog.text} onClose={close} />;
    case "clear":
      return (
        <ConfirmDialog
          title="Clear the board?"
          testId="clear-dialog"
          confirmLabel="Clear board"
          body={
            <p>
              This removes all {count} element{count === 1 ? "" : "s"} on the board, including
              locked ones. You can undo it during this session.
            </p>
          }
          onClose={close}
          onConfirm={() => clearCanvas(store)}
        />
      );
    case "confirmOpen":
      return (
        <ConfirmDialog
          title="Replace this board?"
          testId="open-dialog"
          confirmLabel="Replace board"
          body={
            <p>
              Opening “{dialog.fileName}” replaces everything on the current board. Save a .chalana
              copy first if you want to keep it. You can undo the replacement during this session.
            </p>
          }
          onClose={close}
          onConfirm={() => {
            close();
            dialog.apply();
          }}
        />
      );
  }
};
