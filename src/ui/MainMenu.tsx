import { useEffect, useRef, useState } from "react";
import { STORAGE_KEY, getStorage } from "../io/autosave";
import { boardLabel, readRecent, shortId } from "../sync/recent";
import { copySelectionAs, lockAll, pasteWithApi, unlockAll } from "../store/actions";
import { useAppState, useServices } from "./context";
import { Icon } from "./icons";
import { formatKeys } from "./shortcuts";

/** The board session: title, id, new board, links and recent boards (plan §4.1). */
const SessionSection = ({ close }: { close: () => void }) => {
  const { session, store } = useServices();
  const info = useAppState((s) => s.session);
  const viewMode = useAppState((s) => s.viewMode);
  const [title, setTitle] = useState(info?.title ?? "");
  const [showRecent, setShowRecent] = useState(false);
  if (!session || !info) return null;
  const storage = getStorage();
  const recent = readRecent(storage).filter((r) => r.id !== info.id);
  let hasLegacy = false;
  try {
    hasLegacy = !!storage?.getItem(STORAGE_KEY);
  } catch {
    // no storage, nothing to import
  }
  const commitTitle = () => {
    const t = title.trim().slice(0, 120);
    if (t !== info.title) session.setTitle(t);
  };
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div className="menu-session" data-testid="session-menu">
      <label className="menu-session-title">
        <span>Board name</span>
        <input
          type="text"
          value={title}
          maxLength={120}
          placeholder="Untitled board"
          disabled={viewMode}
          data-testid="session-title"
          onChange={(e) => setTitle(e.currentTarget.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTitle();
            }
          }}
        />
      </label>
      <p className="menu-session-id">
        Board id <code data-testid="session-short-id">{shortId(info.id)}</code>
      </p>
      <div className="menu-session-actions">
        {/* a link, so Ctrl/⌘ + click opens the new board in a new tab */}
        <a className="btn" href="/" data-testid="session-new" onClick={close}>
          New board
        </a>
        <button
          type="button"
          className="btn"
          data-testid="session-copy-link"
          onClick={act(session.copyLink)}
        >
          Copy board link
        </button>
        <button
          type="button"
          className="btn"
          data-testid="session-copy-id"
          onClick={act(session.copyId)}
        >
          Copy board id
        </button>
        <button
          type="button"
          className="btn"
          data-testid="session-connect-agent"
          onClick={() => {
            close();
            store.set({ dialog: { kind: "connectAgent" } });
          }}
        >
          Connect an agent…
        </button>
        <button
          type="button"
          className="btn danger"
          data-testid="session-delete"
          onClick={() => {
            close();
            store.set({ dialog: { kind: "deleteBoard" } });
          }}
        >
          Delete this board…
        </button>
      </div>
      {recent.length ? (
        <div className="menu-session-recent">
          <button
            type="button"
            className="menu-item"
            aria-expanded={showRecent}
            data-testid="session-recent"
            onClick={() => setShowRecent(!showRecent)}
          >
            <span>Recent boards ({recent.length})</span>
          </button>
          {showRecent ? (
            <ul data-testid="session-recent-list">
              {recent.map((r) => (
                <li key={r.id}>
                  <a href={`/s/${r.id}`}>
                    {boardLabel(r.title)} <code>{shortId(r.id)}</code>
                  </a>{" "}
                  <time dateTime={new Date(r.openedAt).toISOString()}>
                    {new Date(r.openedAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {hasLegacy && !viewMode ? (
        <button
          type="button"
          className="menu-item"
          data-testid="session-import-legacy"
          onClick={act(session.importLegacy)}
        >
          <span>Import the board saved in this browser</span>
        </button>
      ) : null}
      <div className="menu-sep" role="separator" />
    </div>
  );
};

export const MainMenu = () => {
  const { store, openFile, saveFile, insertPicture, session } = useServices();
  const theme = useAppState((s) => s.theme);
  const grid = useAppState((s) => s.gridEnabled);
  const zen = useAppState((s) => s.zenMode);
  const viewMode = useAppState((s) => s.viewMode);
  const stats = useAppState((s) => s.statsOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = ref.current!;
    const doc = menu.ownerDocument;
    const win = doc.defaultView;
    if (win) {
      // keep the whole menu inside the window; it scrolls when the window is short
      const top = menu.getBoundingClientRect().top;
      menu.style.maxHeight = `${Math.max(200, win.innerHeight - top - 14)}px`;
    }
    menu.querySelector<HTMLButtonElement>("[role=menuitem], [role=menuitemcheckbox]")?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.contains(t) && !(t as Element).closest?.("[data-testid=menu-button]")) {
        store.set({ menuOpen: false });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        store.set({ menuOpen: false });
        doc.querySelector<HTMLButtonElement>("[data-testid=menu-button]")?.focus();
      }
    };
    doc.addEventListener("pointerdown", onDown);
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("pointerdown", onDown);
      doc.removeEventListener("keydown", onKey, true);
    };
  }, [store]);

  const run = (fn: () => void) => () => {
    // the menu item unmounts, so hand focus to the menu button first; dialogs opened
    // from the menu then return focus there when they close
    ref.current?.ownerDocument
      .querySelector<HTMLButtonElement>("[data-testid=menu-button]")
      ?.focus();
    store.set({ menuOpen: false });
    fn();
  };

  const items: {
    label: string;
    icon: () => React.JSX.Element;
    keys?: string;
    onClick: () => void;
    id: string;
    checked?: boolean;
    section?: string;
    /** Changes the board; hidden in look-only mode. */
    edits?: boolean;
  }[] = [
    {
      id: "open",
      label: "Open board or editable image…",
      icon: Icon.open,
      keys: "Mod+O",
      edits: true,
      onClick: openFile,
    },
    {
      id: "insert-picture",
      label: "Insert picture or video…",
      icon: Icon.image,
      edits: true,
      onClick: insertPicture,
    },
    {
      id: "insert-media-link",
      label: "Add media link…",
      icon: Icon.image,
      edits: true,
      onClick: () => store.set({ dialog: { kind: "mediaLink" } }),
    },
    {
      id: "insert-component",
      label: "Add animated component…",
      icon: Icon.image,
      edits: true,
      onClick: () => store.set({ dialog: { kind: "component" } }),
    },
    { id: "save", label: "Save as .chalana", icon: Icon.save, keys: "Mod+S", onClick: saveFile },
    {
      id: "export",
      label: "Export PNG…",
      icon: Icon.image,
      keys: "Mod+Shift+E",
      onClick: () => store.set({ dialog: { kind: "export" } }),
    },
    {
      id: "export-svg",
      label: "Export SVG…",
      icon: Icon.svg,
      onClick: () => store.set({ dialog: { kind: "svg" } }),
    },
    {
      id: "copy-png",
      label: "Copy as PNG",
      icon: Icon.copy,
      keys: "Shift+Alt+C",
      onClick: () => void copySelectionAs(store, "png"),
    },
    {
      id: "copy-svg",
      label: "Copy as SVG",
      icon: Icon.copy,
      onClick: () => void copySelectionAs(store, "svg"),
    },
    {
      id: "copy-text",
      label: "Copy as text",
      icon: Icon.copy,
      onClick: () => void copySelectionAs(store, "text"),
    },
    {
      id: "paste",
      label: "Paste",
      icon: Icon.paste,
      keys: "Mod+V",
      edits: true,
      onClick: () => void pasteWithApi(store),
    },
    {
      id: "search",
      section: "View",
      label: "Find text…",
      icon: Icon.search,
      keys: "Mod+F",
      onClick: () => store.set({ searchOpen: true }),
    },
    {
      id: "grid",
      label: "Show grid",
      icon: Icon.grid,
      keys: "Mod+'",
      checked: grid,
      onClick: () => store.set({ gridEnabled: !grid }),
    },
    {
      id: "zen",
      label: "Quiet desk",
      icon: Icon.calm,
      keys: "Alt+Z",
      checked: zen,
      onClick: () => store.set({ zenMode: !zen }),
    },
    {
      id: "view-mode",
      label: "Look-only mode",
      icon: Icon.eye,
      keys: "Alt+R",
      checked: viewMode,
      onClick: () => store.set({ viewMode: !viewMode, selectedIds: new Set(), tool: "pick" }),
    },
    {
      id: "stats",
      label: "Measurements",
      icon: Icon.stats,
      keys: "Alt+/",
      checked: stats,
      onClick: () => store.set({ statsOpen: !stats }),
    },
    {
      id: "theme",
      label: theme === "light" ? "Dark theme" : "Light theme",
      icon: theme === "light" ? Icon.moon : Icon.sun,
      onClick: () => store.set({ theme: theme === "light" ? "dark" : "light" }),
    },
    {
      id: "settings",
      label: "Board settings…",
      icon: Icon.settings,
      onClick: () => store.set({ dialog: { kind: "settings" } }),
    },
    {
      id: "lock-all",
      section: "Board",
      label: "Lock everything",
      icon: Icon.lock,
      edits: true,
      onClick: () => lockAll(store),
    },
    {
      id: "unlock-all",
      label: "Unlock all",
      icon: Icon.unlock,
      edits: true,
      onClick: () => unlockAll(store),
    },
    {
      id: "help",
      label: "Keyboard shortcuts",
      icon: Icon.help,
      keys: "?",
      onClick: () => store.set({ dialog: { kind: "help" } }),
    },
    {
      id: "clear",
      label: "Clear board…",
      icon: Icon.eraseAll,
      edits: true,
      onClick: () => store.set({ dialog: { kind: "clear" } }),
    },
  ];

  // in look-only mode drop board-changing entries, keeping their section breaks
  let pendingSection: string | undefined;
  const shown = viewMode
    ? items.flatMap((it) => {
        if (it.edits) {
          pendingSection ??= it.section;
          return [];
        }
        const section = it.section ?? pendingSection;
        pendingSection = undefined;
        return [{ ...it, section }];
      })
    : items;

  return (
    <div className="menu panel" role="menu" aria-label="Main menu" ref={ref}>
      {session ? <SessionSection close={() => store.set({ menuOpen: false })} /> : null}
      {shown.map((it) => [
        it.section ? <div key={`${it.id}-sep`} className="menu-sep" role="separator" /> : null,
        <button
          key={it.id}
          type="button"
          role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={it.checked}
          className={`menu-item${it.id === "clear" ? " danger" : ""}`}
          data-testid={`menu-${it.id}`}
          onClick={run(it.onClick)}
        >
          <it.icon />
          <span>{it.label}</span>
          {it.checked ? (
            <span className="menu-check" aria-hidden="true">
              ✓
            </span>
          ) : null}
          {it.keys ? <kbd>{formatKeys(it.keys)}</kbd> : null}
        </button>,
      ])}
      <p className="menu-note">
        {session
          ? "This board is saved on the ChalanaMaya server. Anyone with its address or id can open and change it, so share it only with people and agents you trust."
          : "Your board autosaves in this browser only. Clearing browser data deletes this copy, so save a .chalana file now and then as a backup."}
      </p>
    </div>
  );
};
