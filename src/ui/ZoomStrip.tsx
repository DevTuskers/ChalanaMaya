import { fitToContent, redo, resetZoom, undo, zoomBy } from "../store/actions";
import { useAppState, useServices } from "./context";
import { HintButton } from "./Hint";
import { Icon } from "./icons";
import { formatKeys } from "./shortcuts";

/** Bottom strip: history and zoom controls. */
export const ZoomStrip = () => {
  const { store } = useServices();
  const zoom = useAppState((s) => s.viewport.zoom);
  useAppState((s) => s.historyVersion);
  const hasSelection = useAppState((s) => s.selectedIds.size > 0);
  const empty = useAppState((s) => s.elements.length === 0);
  const viewMode = useAppState((s) => s.viewMode);
  const canUndo = store.history.canUndo && !viewMode;
  const canRedo = store.history.canRedo && !viewMode;
  const lookOnly = "Look-only mode is on";
  return (
    <div className="bottom-bar">
      <div className="strip panel" role="group" aria-label="History">
        <HintButton
          label="Undo"
          shortcut={formatKeys("Mod+Z")}
          side="top"
          unavailable={!canUndo}
          unavailableReason={viewMode ? lookOnly : "Nothing to undo yet"}
          data-testid="undo"
          onClick={() => undo(store)}
        >
          <Icon.undo />
        </HintButton>
        <HintButton
          label="Redo"
          shortcut={formatKeys("Mod+Shift+Z")}
          side="top"
          unavailable={!canRedo}
          unavailableReason={viewMode ? lookOnly : "Nothing to redo"}
          data-testid="redo"
          onClick={() => redo(store)}
        >
          <Icon.redo />
        </HintButton>
      </div>
      <div className="strip panel" role="group" aria-label="Zoom">
        <HintButton
          label="Zoom out"
          shortcut={formatKeys("Mod+-")}
          side="top"
          data-testid="zoom-out"
          onClick={() => zoomBy(store, 1 / 1.2)}
        >
          <Icon.minus />
        </HintButton>
        <HintButton
          label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`}
          hint="Reset zoom to 100%"
          shortcut={formatKeys("Mod+0")}
          side="top"
          className="zoom-value"
          data-testid="zoom-reset"
          onClick={() => resetZoom(store)}
        >
          <span data-testid="zoom-value">{Math.round(zoom * 100)}%</span>
        </HintButton>
        <HintButton
          label="Zoom in"
          shortcut={formatKeys("Mod+=")}
          side="top"
          data-testid="zoom-in"
          onClick={() => zoomBy(store, 1.2)}
        >
          <Icon.plus />
        </HintButton>
        <HintButton
          label="Fit all artwork"
          shortcut={formatKeys("Shift+1")}
          side="top"
          unavailable={empty}
          unavailableReason="The board is empty"
          data-testid="zoom-fit"
          onClick={() => fitToContent(store, false)}
        >
          <Icon.fit />
        </HintButton>
        <HintButton
          label="Fit selection"
          shortcut={formatKeys("Shift+2")}
          side="top"
          unavailable={!hasSelection}
          unavailableReason="Select something first"
          data-testid="zoom-fit-selection"
          onClick={() => fitToContent(store, true)}
        >
          <Icon.fitSelection />
        </HintButton>
      </div>
    </div>
  );
};
