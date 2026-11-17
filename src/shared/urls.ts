/**
 * Remote media link rules (plan §6.2), shared by the browser and the server.
 * Best effort, not a network wall: a public name can still resolve to a
 * private address. The server never fetches these links (no SSRF); the
 * browser loads them with referrerpolicy="no-referrer" in the live layer.
 */
import { LIMITS } from "./limits";

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
  ".corp",
];

export type RemoteUrlCheck =
  { ok: true; url: string; host: string } | { ok: false; reason: string };

/** Hosts that are IP literals in any form the URL parser accepts (it normalises decimal/hex IPv4). */
const isIpHost = (host: string) =>
  host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^[0-9.]+$/.test(host);

export const checkRemoteUrl = (raw: unknown): RemoteUrlCheck => {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "must be a link" };
  if (raw.length > LIMITS.url)
    return { ok: false, reason: `must be at most ${LIMITS.url} characters` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid web address" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "must start with https://" };
  if (u.username || u.password)
    return { ok: false, reason: "must not contain a user name or password" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (isIpHost(host)) return { ok: false, reason: "must use a site name, not an IP address" };
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s)))
    return { ok: false, reason: "must not point to this computer or a private network name" };
  if (!host.includes(".")) return { ok: false, reason: "must use a full site name (with a dot)" };
  // canonical form: what the URL parser gives back, so every replica stores the same text
  if (u.href !== raw) return { ok: false, reason: `must be written in canonical form (${u.href})` };
  return { ok: true, url: u.href, host };
};

/** Normalises a typed link to canonical form before checking it (UI and agent input). */
export const normaliseRemoteUrl = (raw: string): RemoteUrlCheck => {
  try {
    return checkRemoteUrl(new URL(raw.trim()).href);
  } catch {
    return { ok: false, reason: "is not a valid web address" };
  }
};

export const isRemoteMediaUrl = (v: unknown) => checkRemoteUrl(v).ok;

/** The host name shown on placeholder cards ("media.example.com"). */
export const remoteHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
};

/** Guesses a media type from a link's file extension (links have no sniffable bytes). */
export const mimeFromUrl = (url: string): string | null => {
  let p = "";
  try {
    p = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.png$/.test(p)) return "image/png";
  if (/\.jpe?g$/.test(p)) return "image/jpeg";
  if (/\.gif$/.test(p)) return "image/gif";
  if (/\.webp$/.test(p)) return "image/webp";
  if (/\.mp4$|\.m4v$/.test(p)) return "video/mp4";
  if (/\.webm$/.test(p)) return "video/webm";
  return null;
};

export const isVideoMime = (m: string | undefined) => m === "video/mp4" || m === "video/webm";
