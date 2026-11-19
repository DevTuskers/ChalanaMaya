/**
 * Session routing (plan §4.1): `/` creates a board and replaces the address
 * with `/s/<id>`; `/s/<id>` replays any pending mirror, loads the scene and
 * starts the app. An unknown id shows a clear page with a new-board button.
 */
import { useCallback, useEffect, useState } from "react";
import { getStorage } from "../io/autosave";
import { ApiError, httpApi, readOwnerKey, setBoardKey, storeOwnerKey, type Api } from "./api";
import { parseBoardHash } from "../shared/ids";
import { loadSession, sessionIdFromPath, type SessionBoot } from "./session";
import { forgetBoard } from "./recent";

type BootState =
  | { kind: "loading" }
  | { kind: "missing"; id: string | null }
  | { kind: "error"; message: string }
  | { kind: "ready"; boot: SessionBoot };

let creating: ReturnType<Api["createSession"]> | null = null;

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
    // a malformed or unknown address never silently becomes a new board
    if (target === null || target === "invalid") {
      setState({ kind: "missing", id: null });
      return;
    }
    try {
      let id: string;
      let owner: string | undefined;
      if (target === "root") {
        // one board per visit, even when React runs the effect twice
        creating ??= httpApi.createSession().finally(() => (creating = null));
        const created = await creating;
        id = created.session_id;
        // On a keyed host the url carries `#key=<edit>`; the Node self-host's
        // bare `/s/<id>` also works with it (no secrets needed).
        const address = created.url || `/s/${id}`;
        const keys = parseBoardHash(new URL(address, window.location.origin).hash);
        owner = keys.owner;
        if (created.owner_url) {
          const o = parseBoardHash(new URL(created.owner_url, window.location.origin).hash).owner;
          if (o) owner = o;
        }
        setBoardKey(keys.key ?? "");
        if (owner) storeOwnerKey(id, owner);
        window.history.replaceState(null, "", address);
      } else {
        id = target;
        const keys = parseBoardHash(window.location.hash);
        owner = keys.owner ?? readOwnerKey(id) ?? undefined;
        setBoardKey(keys.key ?? "");
        if (owner) storeOwnerKey(id, owner);
      }
      const boot = await loadSession(httpApi, id);
      setState({ kind: "ready", boot });
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_not_found" && target !== "root") {
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
