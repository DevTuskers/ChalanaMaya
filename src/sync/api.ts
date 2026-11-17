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
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface Api {
  createSession(title?: string): Promise<{ session_id: string; url: string }>;
  scene(id: string): Promise<SceneSnapshot>;
  push(id: string, body: PushBody, opts?: { keepalive?: boolean }): Promise<Ack>;
  importScene(id: string, body: ImportBody): Promise<Ack>;
  upload(id: string, blob: Blob): Promise<UploadedFile>;
}

const HEADERS = { "X-ChalanaMaya": "1", "Content-Type": "application/json" };

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
      headers: HEADERS,
      body: JSON.stringify(body),
      keepalive: opts?.keepalive === true,
    }),
  importScene: (id, body) =>
    call(`${base}/api/sessions/${enc(id)}/import`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    }),
  upload: (id, blob) =>
    call(`${base}/api/sessions/${enc(id)}/files`, {
      method: "POST",
      headers: { "X-ChalanaMaya": "1", "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    }),
});

export const httpApi = createHttpApi();
