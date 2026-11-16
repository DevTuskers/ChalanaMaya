import { useEffect, useRef } from "react";
import { pasteWithApi } from "../store/actions";
import { useAppState, useServices } from "./context";
import { Icon } from "./icons";
import { formatKeys } from "./shortcuts";

export const MainMenu = () => {
  const { store, openFile, saveFile } = useServices();
  const theme = useAppState((s) => s.theme);
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
    store.set({ menuOpen: false });
    fn();
  };

  const items: {
    label: string;
    icon: () => React.JSX.Element;
    keys?: string;
    onClick: () => void;
    id: string;
  }[] = [
    { id: "open", label: "Open .chalana file…", icon: Icon.open, keys: "Mod+O", onClick: openFile },
    { id: "save", label: "Save as .chalana", icon: Icon.save, keys: "Mod+S", onClick: saveFile },
    {
      id: "export",
      label: "Export PNG…",
      icon: Icon.image,
      keys: "Mod+Shift+E",
      onClick: () => store.set({ dialog: { kind: "export" } }),
    },
    {
      id: "paste",
      label: "Paste",
      icon: Icon.paste,
      keys: "Mod+V",
      onClick: () => void pasteWithApi(store),
    },
    {
      id: "theme",
      label: theme === "light" ? "Dark theme" : "Light theme",
      icon: theme === "light" ? Icon.moon : Icon.sun,
      onClick: () => store.set({ theme: theme === "light" ? "dark" : "light" }),
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
      onClick: () => store.set({ dialog: { kind: "clear" } }),
    },
  ];

  return (
    <div className="menu panel" role="menu" aria-label="Main menu" ref={ref}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          className={`menu-item${it.id === "clear" ? " danger" : ""}`}
          data-testid={`menu-${it.id}`}
          onClick={run(it.onClick)}
        >
          <it.icon />
          <span>{it.label}</span>
          {it.keys ? <kbd>{formatKeys(it.keys)}</kbd> : null}
        </button>
      ))}
      <p className="menu-note">
        Your board autosaves in this browser only. Clearing browser data deletes this copy, so save
        a .chalana file now and then as a backup.
      </p>
    </div>
  );
};
