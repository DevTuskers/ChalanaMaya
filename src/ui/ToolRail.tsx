import { setTool } from "../store/actions";
import { useAppState, useServices } from "./context";
import { HintButton } from "./Hint";
import { Icon, ToolIcon } from "./icons";
import { MainMenu } from "./MainMenu";
import { TOOLS } from "./shortcuts";

/** Compact vertical rail on the left: main menu and drawing tools. */
export const ToolRail = () => {
  const { store } = useServices();
  const tool = useAppState((s) => s.tool);
  const menuOpen = useAppState((s) => s.menuOpen);
  const toolLocked = useAppState((s) => s.toolLocked);
  const viewMode = useAppState((s) => s.viewMode);
  const zen = useAppState((s) => s.zenMode);
  return (
    <nav className="rail panel" aria-label="Tools">
      <div className="rail-menu">
        <HintButton
          label="Main menu"
          hint="Menu — open, save, export, theme"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          data-testid="menu-button"
          onClick={() => store.set({ menuOpen: !menuOpen })}
        >
          <Icon.menu />
        </HintButton>
        {menuOpen ? <MainMenu /> : null}
      </div>
      {viewMode ? null : (
        <>
          <div className="rail-sep" role="separator" />
          <div
            className="rail-tools"
            role="toolbar"
            aria-orientation="vertical"
            aria-label="Drawing tools"
          >
            {TOOLS.map((t) => (
              <HintButton
                key={t.id}
                label={`${t.name} — ${t.common}`}
                shortcut={t.digit ? `${t.key} or ${t.digit}` : t.key}
                active={tool === t.id}
                data-testid={`tool-${t.id}`}
                onClick={() => setTool(store, t.id)}
              >
                <ToolIcon tool={t.id} />
                {t.digit ? (
                  <span className="tool-digit" aria-hidden="true">
                    {t.digit}
                  </span>
                ) : null}
              </HintButton>
            ))}
          </div>
          {zen ? null : (
            <>
              <div className="rail-sep" role="separator" />
              <HintButton
                label={toolLocked ? "Keep drawing is on" : "Keep drawing"}
                hint={
                  toolLocked
                    ? "Keep drawing is on — tools stay active"
                    : "Keep drawing — stay on the tool after each item"
                }
                shortcut="K"
                active={toolLocked}
                aria-pressed={toolLocked}
                data-testid="tool-lock"
                onClick={() => store.set({ toolLocked: !toolLocked })}
              >
                {toolLocked ? <Icon.lock /> : <Icon.unlock />}
              </HintButton>
            </>
          )}
        </>
      )}
    </nav>
  );
};
