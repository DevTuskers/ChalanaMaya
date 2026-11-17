import { createContext, useContext, useSyncExternalStore } from "react";
import type { Controller } from "../tools/controller";
import type { AppState, Store } from "../store/store";

export interface AppServices {
  store: Store;
  controller: Controller;
  openFile: () => void;
  insertPicture: () => void;
  saveFile: () => void;
  /** Session board commands (absent outside a server session). */
  session?: SessionServices;
}

export interface SessionServices {
  newBoard: () => void;
  copyLink: () => void;
  copyId: () => void;
  /** Deletes this board on the server (after the confirm dialog). */
  deleteBoard: () => Promise<void>;
  setTitle: (title: string) => void;
  importLegacy: () => void;
  removeLegacy: () => void;
  dismissLegacy: () => void;
}

export const AppContext = createContext<AppServices | null>(null);

export const useServices = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
};

export const useAppState = <T>(select: (s: AppState) => T): T => {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
};
