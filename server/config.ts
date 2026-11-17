/**
 * Server configuration, read from environment variables only (no secrets in
 * the repo). Every value has a documented default; malformed values are a
 * start-up error with a clear message (plan §3.4, §5.1, §7).
 */
import path from "node:path";

export class ConfigError extends Error {}

export interface Limits {
  /** global: number of boards on this server */
  maxSessions: number;
  /** global: sum of all stored media bytes */
  maxTotalMediaBytes: number;
  /** global: SQLite database size (page_count × page_size) */
  maxDbBytes: number;
  /** per board: live elements */
  maxElements: number;
  /** per board: JSON size of all live elements */
  maxSceneBytes: number;
  /** per board: stored media bytes */
  maxSessionMediaBytes: number;
  /** per picture or GIF upload */
  maxImageBytes: number;
  /** Largest video upload (MP4/WebM). */
  maxVideoBytes: number;
  /** per op batch (REST /ops and later the socket) */
  maxOpsPerPush: number;
  /** REST /ops JSON body */
  opsBodyBytes: number;
  /** REST /import JSON body */
  importBodyBytes: number;
  /** push_log rows kept per board */
  pushLogMax: number;
  /** push_log rows older than this are purged */
  pushLogMaxAgeMs: number;
  /** tombstones older than this are purged */
  tombstoneMaxAgeMs: number;
}

export interface RateLimits {
  enabled: boolean;
  windowMs: number;
  sessionsPerWindow: number;
  uploadsPerWindow: number;
  mcpPerWindow: number;
}

export interface Config {
  port: number;
  /** null = loopback only (127.0.0.1 and ::1) */
  host: string | null;
  publicUrl: URL | null;
  dataDir: string;
  /** bare, normalised hostnames accepted in the Host header */
  allowedHosts: string[];
  /** extra Origins accepted for /mcp only (browser-based MCP clients) */
  allowedOrigins: string[];
  /** passed to Express "trust proxy"; false = off */
  trustProxy: false | number | string;
  rateLimits: RateLimits;
  limits: Limits;
  /** delete boards not opened for this many days (null = keep) */
  sessionTtlDays: number | null;
  dev: boolean;
  /** folder with the built app (dist/) */
  appDir: string;
}

export const MB = 1024 * 1024;

export const DEFAULT_LIMITS: Limits = {
  maxSessions: 10_000,
  maxTotalMediaBytes: 5 * 1024 * MB,
  maxDbBytes: 1024 * MB,
  maxElements: 5000,
  maxSceneBytes: 10 * MB,
  maxSessionMediaBytes: 200 * MB,
  maxImageBytes: 10 * MB,
  maxVideoBytes: 25 * MB,
  maxOpsPerPush: 500,
  opsBodyBytes: 2 * MB,
  importBodyBytes: 12 * MB,
  pushLogMax: 2000,
  pushLogMaxAgeMs: 15 * 60_000,
  tombstoneMaxAgeMs: 30 * 24 * 3600_000,
};

/**
 * Normalises one host entry to the bare form that `new URL("http://" + host).hostname`
 * returns: lower case, no port, IPv6 literals in brackets. Throws on entries
 * with a scheme, a path or a wildcard.
 */
export const normalizeHostEntry = (entry: string): string => {
  const raw = entry.trim().toLowerCase();
  if (!raw) throw new ConfigError("empty host entry");
  if (raw.includes("://") || raw.includes("/") || raw.includes("*") || raw.includes("@"))
    throw new ConfigError(
      `"${entry}" is not a bare host name (no scheme, path or wildcard; for example 192.168.1.20 or myboard.lan)`,
    );
  let host: string;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) throw new ConfigError(`"${entry}" has an unclosed IPv6 bracket`);
    const rest = raw.slice(end + 1);
    if (rest && !(/^:\d{1,5}$/.test(rest) && Number(rest.slice(1)) <= 65535))
      throw new ConfigError(`"${entry}" has a bad port`);
    host = raw.slice(0, end + 1);
  } else if ((raw.match(/:/g) ?? []).length >= 2) {
    host = `[${raw}]`; // bare IPv6 literal such as ::1 or fe80::1
  } else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(raw);
    if (!m || (m[2] !== undefined && Number(m[2]) > 65535))
      throw new ConfigError(`"${entry}" has a bad port`);
    host = m[1];
  }
  let parsed: string;
  try {
    parsed = new URL(`http://${host}`).hostname;
  } catch {
    throw new ConfigError(`"${entry}" is not a valid host name`);
  }
  if (parsed !== host) throw new ConfigError(`"${entry}" is not a valid host name`);
  return host;
};

const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const int = (env: Env, name: string, def: number, min = 0): number => {
  const v = env[name];
  if (v === undefined || v === "") return def;
  if (!/^\d+$/.test(v.trim())) throw new ConfigError(`${name} must be a whole number, got "${v}"`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(`${name} must be at least ${min}`);
  return n;
};

const parseTrustProxy = (v: string | undefined): false | number | string => {
  if (v === undefined || v.trim() === "" || /^(off|false|0|no)$/i.test(v.trim())) return false;
  const t = v.trim();
  if (/^(on|true|yes|\*)$/i.test(t))
    throw new ConfigError(
      'TRUST_PROXY must name the proxy: "loopback", a hop count such as 1, or a list of proxy addresses. Trusting every address would let any client fake its address.',
    );
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(",").map((p) => p.trim());
  for (const p of parts) {
    if (!/^(loopback|linklocal|uniquelocal|[0-9a-f.:]+(\/\d{1,3})?)$/i.test(p))
      throw new ConfigError(
        `TRUST_PROXY entry "${p}" is not loopback, linklocal, uniquelocal or an address`,
      );
  }
  return parts.join(",");
};

const parseOrigin = (name: string, entry: string): string => {
  let u: URL;
  try {
    u = new URL(entry.trim());
  } catch {
    throw new ConfigError(
      `${name} entry "${entry}" is not a full origin such as http://localhost:6274`,
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new ConfigError(`${name} entry "${entry}" must start with http:// or https://`);
  if (u.pathname !== "/" || u.search || u.hash || u.username)
    throw new ConfigError(`${name} entry "${entry}" must be an origin only (no path)`);
  return u.origin;
};

export type Env = Record<string, string | undefined>;

export const ROOT_DIR = path.resolve(import.meta.dirname, "..");

export const loadConfig = (env: Env = process.env, overrides: Partial<Config> = {}): Config => {
  const port = int(env, "PORT", 5183, 0);
  if (port > 65535) throw new ConfigError("PORT must be at most 65535");
  let publicUrl: URL | null = null;
  if (env.PUBLIC_URL) {
    try {
      publicUrl = new URL(env.PUBLIC_URL);
    } catch {
      throw new ConfigError(`PUBLIC_URL "${env.PUBLIC_URL}" is not a full address`);
    }
    if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:")
      throw new ConfigError("PUBLIC_URL must start with http:// or https://");
  }
  const extraHosts = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      try {
        return normalizeHostEntry(h);
      } catch (e) {
        throw new ConfigError(`ALLOWED_HOSTS: ${(e as Error).message}`);
      }
    });
  const allowedHosts = [
    ...new Set([...DEFAULT_HOSTS, ...(publicUrl ? [publicUrl.hostname] : []), ...extraHosts]),
  ];
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => parseOrigin("ALLOWED_ORIGINS", o));
  const rl = (env.RATE_LIMITS ?? "on").trim().toLowerCase();
  if (!["on", "off"].includes(rl)) throw new ConfigError('RATE_LIMITS must be "on" or "off"');
  const ttl = int(env, "SESSION_TTL_DAYS", 0);
  const L = DEFAULT_LIMITS;
  const cfg: Config = {
    port,
    host: env.HOST?.trim() ? env.HOST.trim() : null,
    publicUrl,
    dataDir: path.resolve(env.DATA_DIR?.trim() || path.join(ROOT_DIR, "data")),
    allowedHosts,
    allowedOrigins,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimits: {
      enabled: rl === "on",
      windowMs: 60_000,
      sessionsPerWindow: int(env, "RATE_LIMIT_SESSIONS", 30, 1),
      uploadsPerWindow: int(env, "RATE_LIMIT_UPLOADS", 60, 1),
      mcpPerWindow: int(env, "RATE_LIMIT_MCP", 600, 1),
    },
    limits: {
      ...L,
      maxSessions: int(env, "MAX_SESSIONS", L.maxSessions, 1),
      maxTotalMediaBytes: int(env, "MAX_TOTAL_MEDIA_BYTES", L.maxTotalMediaBytes),
      maxDbBytes: int(env, "MAX_DB_BYTES", L.maxDbBytes),
      maxElements: int(env, "MAX_ELEMENTS", L.maxElements, 1),
      maxSceneBytes: int(env, "MAX_SCENE_BYTES", L.maxSceneBytes, 1),
      maxSessionMediaBytes: int(env, "MAX_SESSION_MEDIA_BYTES", L.maxSessionMediaBytes),
      maxImageBytes: int(env, "MAX_IMAGE_BYTES", L.maxImageBytes, 1),
      maxVideoBytes: int(env, "MAX_VIDEO_BYTES", L.maxVideoBytes, 1),
    },
    sessionTtlDays: ttl > 0 ? ttl : null,
    dev: env.CHALANAMAYA_DEV === "1",
    appDir: path.join(ROOT_DIR, "dist"),
  };
  return { ...cfg, ...overrides };
};

/** Origins whose browsers may change boards: the app's own addresses. */
export const appOrigins = (cfg: Config, port = cfg.port): string[] => {
  const out = new Set<string>();
  for (const h of cfg.allowedHosts) {
    out.add(`http://${h}:${port}`);
    if (h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]") out.add(`https://${h}:${port}`);
  }
  if (cfg.publicUrl) out.add(cfg.publicUrl.origin);
  return [...out];
};
