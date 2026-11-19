/**
 * Random ids (plan §4). Uses the Web Crypto API, available in browsers and in Node.
 * A session id is 18 random bytes in base64url: 24 characters, 144 bits. It is
 * the board's access token, so it must be unguessable.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{24}$/;
export const PUSH_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const base64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const randomId = (bytes: number) => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
};

export const newSessionId = () => randomId(18);
/** 16 random bytes, base64url (22 characters). */
export const newPushId = () => randomId(16);
export const isSessionId = (v: unknown): v is string =>
  typeof v === "string" && SESSION_ID_RE.test(v);

/** Accepts a bare id or a board address such as https://host/s/<id>; returns the id or null. */
export const parseSessionRef = (input: string): string | null => {
  const t = input.trim();
  if (isSessionId(t)) return t;
  const m = /\/s\/([A-Za-z0-9_-]{24})(?:[/?#]|$)/.exec(t);
  return m ? m[1] : null;
};

/**
 * The board secrets carried in a `#key=...` / `#owner=...` fragment on the
 * Cloudflare host (plan: three secrets). Both may appear, `#owner=` last.
 */
export const parseBoardHash = (hash: string): { key?: string; owner?: string } => {
  const out: { key?: string; owner?: string } = {};
  for (const part of hash.replace(/^#/, "").split("&")) {
    const m = /^(key|owner)=([A-Za-z0-9_-]{16,64})$/.exec(part);
    if (m) out[m[1] as "key" | "owner"] = m[2];
  }
  return out;
};

/** A same-origin session file path: `/api/sessions/<24-char id>/files/<file id>`. */
export const SESSION_FILE_PATH_RE =
  /^\/api\/sessions\/[A-Za-z0-9_-]{24}\/files\/[A-Za-z0-9_-]{1,64}$/;
export const isSessionFilePath = (v: unknown): v is string =>
  typeof v === "string" && SESSION_FILE_PATH_RE.test(v);
