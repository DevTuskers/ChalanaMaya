import { useEffect, useRef, useState, type ReactNode } from "react";
import { clearCanvas } from "../store/actions";
import {
  canvasToBlob,
  downloadBlob,
  exportSize,
  exportToCanvas,
  timestampName,
} from "../io/export";
import { useAppState, useServices } from "./context";
import { Icon } from "./icons";
import { SHORTCUT_GROUPS, formatKeys } from "./shortcuts";

const Modal = ({
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
  useEffect(() => {
    const el = ref.current!;
    const doc = el.ownerDocument;
    const prev = doc.activeElement as HTMLElement | null;
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
      prev?.focus?.();
    };
  }, [onClose]);
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

const ExportDialog = ({ onClose }: { onClose: () => void }) => {
  const { store } = useServices();
  const elements = useAppState((s) => s.elements);
  const selectedIds = useAppState((s) => s.selectedIds);
  const theme = useAppState((s) => s.theme);
  const files = useAppState((s) => s.files);
  const [onlySelected, setOnlySelected] = useState(selectedIds.size > 0);
  const [background, setBackground] = useState(true);
  const [scale, setScale] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets =
    onlySelected && selectedIds.size
      ? elements.filter(
          (e) =>
            selectedIds.has(e.id) ||
            (e.type === "text" && e.containerId !== null && selectedIds.has(e.containerId)),
        )
      : elements;
  const size = exportSize(targets, scale);

  const doExport = async () => {
    setError(null);
    if (!targets.length) {
      setError("There is nothing to export yet. Draw something first.");
      return;
    }
    setBusy(true);
    try {
      const canvas = await exportToCanvas(targets, files, { background, scale, theme });
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, timestampName("png"));
      store.toast("PNG exported.", "success", 2500);
      onClose();
    } catch (e) {
      setError(`Export failed: ${(e as Error).message} Your board is unchanged.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export PNG" onClose={onClose} testId="export-dialog">
      <div className="form">
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
        <label className="check">
          <input
            type="checkbox"
            data-testid="export-background"
            checked={background}
            onChange={(e) => setBackground(e.target.checked)}
          />
          Include paper background
        </label>
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
            ? `Output: ${size.width} × ${size.height} px. Editor controls are never included.`
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
            Export PNG
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
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  testId: string;
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
        <button type="button" className="btn danger" data-testid="confirm-ok" onClick={onConfirm}>
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
      return <ExportDialog onClose={close} />;
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
