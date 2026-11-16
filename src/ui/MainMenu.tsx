import { useEffect, useRef } from "react";
import { copySelectionAs, lockAll, pasteWithApi, unlockAll } from "../store/actions";
import { useAppState, useServices } from "./context";
import { Icon } from "./icons";
import { formatKeys } from "./shortcuts";

export const MainMenu = () => {
  const { store, openFile, saveFile } = useServices();
  const theme = useAppState((s) => s.theme);
  const grid = useAppState((s) => s.gridEnabled);
  const zen = useAppState((s) => s.zenMode);
  const viewMode = useAppState((s) => s.viewMode);
  const stats = useAppState((s) => s.statsOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = ref.current!;
    const doc = menu.ownerDocument;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
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
  }[] = [
    {
      id: "open",
      label: "Open board or editable image…",
      icon: Icon.open,
      keys: "Mod+O",
      onClick: openFile,
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
      onClick: () => lockAll(store),
    },
    { id: "unlock-all", label: "Unlock all", icon: Icon.unlock, onClick: () => unlockAll(store) },
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
      onClick: () => store.set({ dialog: { kind: "clear" } }),
    },
  ];

  return (
    <div className="menu panel" role="menu" aria-label="Main menu" ref={ref}>
      {items.map((it) => [
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
        Your board autosaves in this browser only. Clearing browser data deletes this copy, so save
        a .chalana file now and then as a backup.
      </p>
    </div>
  );
};
