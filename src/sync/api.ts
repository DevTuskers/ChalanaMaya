/**
 * The browser side of the REST API (plan §4.1). Every state-changing request
 * carries `X-ChalanaMaya: 1`, which the server's cross-site guard requires.
 */
import type { Ack, Op, SceneSnapshot } from "../shared/protocol";
import type { SceneElement } from "../scene/types";

export interface PushBody {
  pushId: string;
  baseRev: number;
  ops: Op[];
  mirrored?: true;
}

export interface ImportBody {
  importId: string;
  mode: "replace" | "add";
  elements: { el: SceneElement; idx: string }[];
  settings?: { viewBackgroundColor?: string; gridEnabled?: boolean };
  /** A mirror replay: a `replace` keeps the elements added after the import. */
  mirrored?: true;
}

export interface UploadedFile {
  file_id: string;
  url: string;
  mime: string;
  width: number | null;
  height: number | null;
}

/** A failed request. `retry` is true for network trouble, 5xx and 429. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get retry() {
    // `capacity` is the board's daily ops budget — retrying is pointless
    // until it resets, so the board is surfaced as read-only instead.
    return (
      this.status === 0 || (this.status === 429 && this.code !== "capacity") || this.status >= 500
    );
  }
}

export interface Api {
  createSession(title?: string): Promise<{
    session_id: string;
    /** invite address, `/s/<id>#key=<editKey>` on the Cloudflare host;
     *  absent on the Node self-host */
    url?: string;
    view_url?: string;
    invite_url?: string;
    owner_url?: string;
  }>;
  scene(id: string): Promise<SceneSnapshot>;
  push(id: string, body: PushBody, opts?: { keepalive?: boolean }): Promise<Ack>;
  importScene(id: string, body: ImportBody): Promise<Ack>;
  /** Deletes the board, its items and its unshared files (SESS-09). */
  deleteSession(id: string): Promise<void>;
  upload(id: string, blob: Blob): Promise<UploadedFile>;
  link(
    id: string,
    url: string,
    mime: string,
    size?: { width: number; height: number },
  ): Promise<UploadedFile>;
}

const HEADERS = { "X-ChalanaMaya": "1", "Content-Type": "application/json" };

/**
 * The board's edit key for the default `httpApi` (Cloudflare hosts). Boot
 * sets it from the `#key=` fragment; mutating calls send it as a Bearer token.
 * The Node self-host ignores the header.
 */
let boardKey = "";
let editKey = "";
export const setBoardKey = (key: string, edit = key) => {
  boardKey = key;
  editKey = edit;
};
export const getBoardKey = () => boardKey;
/** The edit key only — never the owner key. Empty on an owner-link visit, so
 *  shareable edit links are never minted from owner secrets. */
export const getEditKey = () => editKey;

/** The owner key lives in sessionStorage (`chalana.owner.<id>`): only a tab
 * holding it may delete the board or rotate its keys. */
export const ownerKeyName = (id: string) => `chalana.owner.${id}`;
export const storeOwnerKey = (id: string, owner: string) => {
  try {
    sessionStorage.setItem(ownerKeyName(id), owner);
  } catch {
    // private mode: the owner link in the address bar still works
  }
};
export const readOwnerKey = (id: string): string | null => {
  try {
    return sessionStorage.getItem(ownerKeyName(id));
  } catch {
    return null;
  }
};

const authHeaders = (base: Record<string, string>, key?: string) => {
  const k = key ?? boardKey;
  return k ? { ...base, Authorization: `Bearer ${k}` } : base;
};

const call = async <T>(url: string, init: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "network", "The ChalanaMaya server could not be reached.");
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = ((body ?? {}) as { error?: { code?: string; message?: string } }).error ?? {};
    throw new ApiError(
      res.status,
      e.code ?? "http_error",
      e.message ?? `The server answered ${res.status}.`,
    );
  }
  return body as T;
};

const enc = encodeURIComponent;

/** The REST API at `base` ("" for the page's own server). */
export const createHttpApi = (base = ""): Api => ({
  createSession: (title) =>
    call(`${base}/api/sessions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(title ? { title } : {}),
    }),
  scene: (id) => call(`${base}/api/sessions/${enc(id)}/scene`, { method: "GET" }),
  push: (id, body, opts) =>
    call(`${base}/api/sessions/${enc(id)}/ops`, {
      method: "POST",
      headers: authHeaders(HEADERS),
      body: JSON.stringify(body),
      keepalive: opts?.keepalive === true,
    }),
  importScene: (id, body) =>
    call(`${base}/api/sessions/${enc(id)}/import`, {
      method: "POST",
      headers: authHeaders(HEADERS),
      body: JSON.stringify(body),
    }),
  deleteSession: async (id) => {
    // owner-only on a keyed host; falls back to the edit key (self-host)
    await call(`${base}/api/sessions/${enc(id)}`, {
      method: "DELETE",
      headers: authHeaders(HEADERS, readOwnerKey(id) ?? undefined),
    });
  },
  upload: (id, blob) =>
    call(`${base}/api/sessions/${enc(id)}/files`, {
      method: "POST",
      headers: authHeaders({
        "X-ChalanaMaya": "1",
        "Content-Type": blob.type || "application/octet-stream",
      }),
      body: blob,
    }),
  link: (id, url, mime, size) =>
    call(`${base}/api/sessions/${enc(id)}/links`, {
      method: "POST",
      headers: authHeaders(HEADERS),
      body: JSON.stringify({
        url,
        mime,
        ...(size ? { width: Math.round(size.width), height: Math.round(size.height) } : {}),
      }),
    }),
});

export const httpApi = createHttpApi();
