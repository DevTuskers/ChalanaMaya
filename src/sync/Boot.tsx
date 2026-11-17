/**
 * Session routing (plan §4.1): `/` creates a board and replaces the address
 * with `/s/<id>`; `/s/<id>` replays any pending mirror, loads the scene and
 * starts the app. An unknown id shows a clear page with a new-board button.
 */
import { useCallback, useEffect, useState } from "react";
import { getStorage } from "../io/autosave";
import { ApiError, httpApi } from "./api";
import { loadSession, sessionIdFromPath, type SessionBoot } from "./session";
import { forgetBoard } from "./recent";

type BootState =
  | { kind: "loading" }
  | { kind: "missing"; id: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; boot: SessionBoot };

let creating: Promise<{ session_id: string }> | null = null;

const Page = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <main className="boot-page" data-testid="boot-page">
    <h1>{title}</h1>
    {children}
  </main>
);

export const Boot = ({ render }: { render: (boot: SessionBoot) => React.ReactNode }) => {
  const [state, setState] = useState<BootState>({ kind: "loading" });

  const start = useCallback(async () => {
    setState({ kind: "loading" });
    const target = sessionIdFromPath(window.location.pathname);
    try {
      let id: string;
      if (target === "root" || target === null) {
        // one board per visit, even when React runs the effect twice
        creating ??= httpApi.createSession().finally(() => (creating = null));
        id = (await creating).session_id;
        window.history.replaceState(null, "", `/s/${id}`);
      } else id = target;
      setState({ kind: "ready", boot: await loadSession(httpApi, id) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_not_found" && target && target !== "root") {
        forgetBoard(getStorage(), target);
        setState({ kind: "missing", id: target });
      } else
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "The board could not be opened.",
        });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  if (state.kind === "ready") return <>{render(state.boot)}</>;
  if (state.kind === "loading")
    return (
      <Page title="Opening the board…">
        <p>One moment.</p>
      </Page>
    );
  if (state.kind === "missing")
    return (
      <Page title="This board does not exist">
        <p data-testid="board-missing">
          There is no board at this address. It may have been deleted, or the link is mistyped.
        </p>
        <a className="btn btn-primary" href="/" data-testid="boot-new-board">
          Start a new board
        </a>
      </Page>
    );
  return (
    <Page title="The board could not be opened">
      <p data-testid="boot-error">{state.message}</p>
      <p>Your unsaved changes are still kept in this browser.</p>
      <button type="button" className="btn btn-primary" onClick={() => void start()}>
        Try again
      </button>
    </Page>
  );
};
