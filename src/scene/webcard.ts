/**
 * Web card (DRAW-14) link handling: decides whether a link can be shown inside the
 * board and, if so, which embed address to use. Pure logic, no DOM.
 */

export type WebCardTarget =
  | { kind: "embed"; provider: string; src: string; url: string }
  | { kind: "link"; url: string; host: string; reason: string };

export type WebCardResult = { ok: true; target: WebCardTarget } | { ok: false; error: string };

const parseHttpUrl = (raw: string): URL | null => {
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || !u.hostname.includes(".")) return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
};

const youtubeId = (u: URL): string | null => {
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/);
      id = m ? m[1] : null;
    }
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
};

const youtubeStart = (u: URL): number | null => {
  const t = u.searchParams.get("t") ?? u.searchParams.get("start");
  if (!t) return null;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m) return null;
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return secs > 0 ? secs : null;
};

/** Normalises a user-entered link; returns a clear error for unusable input. */
export const resolveWebCard = (raw: string): WebCardResult => {
  if (!raw.trim()) return { ok: false, error: "Enter a web address first." };
  const u = parseHttpUrl(raw);
  if (!u) {
    return {
      ok: false,
      error: "That is not a valid web address. Use a link that starts with https://",
    };
  }
  const url = u.toString();
  const host = u.hostname.replace(/^www\./, "");
  const yt = youtubeId(u);
  if (yt) {
    const start = youtubeStart(u);
    return {
      ok: true,
      target: {
        kind: "embed",
        provider: "YouTube",
        src: `https://www.youtube-nocookie.com/embed/${yt}${start ? `?start=${start}` : ""}`,
        url,
      },
    };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = u.pathname.match(/(\d{5,12})/);
    if (m)
      return {
        ok: true,
        target: {
          kind: "embed",
          provider: "Vimeo",
          src: `https://player.vimeo.com/video/${m[1]}`,
          url,
        },
      };
  }
  if (host === "figma.com" && /^\/(file|design|proto|board)\//.test(u.pathname)) {
    return {
      ok: true,
      target: {
        kind: "embed",
        provider: "Figma",
        src: `https://www.figma.com/embed?embed_host=chalanamaya&url=${encodeURIComponent(url)}`,
        url,
      },
    };
  }
  if (host === "codepen.io") {
    const m = u.pathname.match(/^\/([^/]+)\/(?:pen|full|details)\/([^/]+)/);
    if (m)
      return {
        ok: true,
        target: {
          kind: "embed",
          provider: "CodePen",
          src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`,
          url,
        },
      };
  }
  return {
    ok: true,
    target: {
      kind: "link",
      url,
      host,
      reason:
        "This site can't be shown inside the board (many sites block it). Open it in a new tab instead.",
    },
  };
};

/** Providers whose pages are shown inside web cards. */
export const WEB_CARD_PROVIDERS = ["YouTube", "Vimeo", "Figma", "CodePen"];

/** Sandbox for embedded frames: no top navigation, no access to the board. */
export const WEB_CARD_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";

/** Height of the card's title bar in board units (drawn on the canvas, used to grab it). */
export const WEB_CARD_HEADER = 28;
