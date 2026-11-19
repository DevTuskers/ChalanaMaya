/**
 * BoardStore: the Durable Object port of `server/sessions/service.ts`
 * (SessionService). Same semantics — every write goes through `apply`, one
 * storage transaction per push, strict per-op validation, duplicate pushes
 * answered from `push_log` — against `ctx.storage.sql` and R2 instead of
 * better-sqlite3 and the filesystem.
 *
 * Differences from the Node service:
 *  - media bytes live in R2 at `<sessionId>/<sha256>` (blobs table still
 *    tracks refcounts for dedupe);
 *  - hashing is async (Web Crypto), so file/key paths are async;
 *  - three secrets per board are stored as SHA-256 hashes in `auth`
 *    (`mintKeys`, `checkKey`, `rotateKeys`);
 *  - global caps (maxSessions, maxTotalMediaBytes, maxDbBytes) have no
 *    per-DO meaning; the BoardIndex DO handles fleet limits (phase 5);
 *  - applied changes are kept on `lastEvent` for the socket layer (phase 2).
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { notFound, ServiceError, storageFull } from "../../server/errors";
import {
  baseType,
  PICTURE_TYPES,
  pictureSize,
  sniffType,
  VIDEO_TYPES,
} from "../../server/media/sniff";
import { videoMeta } from "../../server/media/videoMeta";
import { randomId } from "../../src/shared/ids";
import { assignKeys, isValidKey, type LayerHint } from "../../src/shared/keys";
import { finalizeScene } from "../../src/scene/scene";
import type { SceneElement } from "../../src/scene/types";
import { LIMITS } from "../../src/shared/limits";
import { ALLOWED_MIME, validateSettings, validateStoredElement } from "../../src/shared/validate";
import { checkRemoteUrl } from "../../src/shared/urls";
import type {
  Ack,
  IgnoreReason,
  RawOp,
  Rejected,
  SceneSnapshot,
  StoredFile,
} from "../../src/shared/protocol";
import type { SqlStorage } from "@cloudflare/workers-types";

export interface ChangeOrigin {
  kind: "browser" | "agent";
  name: string;
}

export interface ApplyOptions {
  origin: ChangeOrigin;
  atomic: boolean;
  layoutIds?: ReadonlySet<string>;
}

export interface PushInput {
  pushId: string;
  baseRev: number;
  ops: RawOp[];
  mirrored?: true;
}

export interface ImportInput {
  importId: string;
  mode: "replace" | "add";
  elements: { el: unknown; idx: string; v?: number }[];
  settings?: unknown;
  mirrored?: true;
}

export type AppliedOp =
  | { t: "put"; el: SceneElement; idx: string; version: number; needsLayout: boolean }
  | { t: "del"; id: string; version: number }
  | { t: "settings"; settings: Record<string, unknown> }
  | { t: "poster"; fileId: string; posterFileId: string }
  | { t: "fileMeta"; fileId: string; width: number; height: number; durationMs?: number };

export interface ChangesEvent {
  sessionId: string;
  fromRev: number;
  rev: number;
  ops: AppliedOp[];
  origin: ChangeOrigin;
}

export interface ApplyResult {
  ack: Ack;
  applied: boolean;
  event: ChangesEvent | null;
}

interface SessionRow {
  id: string;
  title: string;
  settings: string;
  rev: number;
  push_log_floor_rev: number;
  element_count: number;
  media_bytes: number;
  created_at: number;
  updated_at: number;
  opened_at: number | null;
}

interface ElementRow {
  id: string;
  idx: string;
  version: number;
  rev: number;
  deleted: number;
  needs_layout: number;
  data: string;
}

interface FileRow {
  id: string;
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  source: "upload" | "remote";
  url: string | null;
  poster_file_id: string | null;
}

import { AgentRejected } from "../../src/shared/agentRejected";
export { AgentRejected };

class Rollback extends Error {
  constructor(readonly ack: Ack) {
    super("rolled back");
  }
}

/** Per-board limits on Workers (global caps move to the BoardIndex sweep). */
export interface StoreLimits {
  maxElements: number;
  maxSceneBytes: number;
  maxSessionMediaBytes: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  pushLogMax: number;
  pushLogMaxAgeMs: number;
  tombstoneMaxAgeMs: number;
  /** ops applied to this board per UTC day (free-tier write budget) */
  maxDailyOps: number;
}

export const STORE_LIMITS: StoreLimits = {
  maxElements: 5000,
  maxSceneBytes: 10 * 1024 * 1024,
  maxSessionMediaBytes: 200 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxVideoBytes: 25 * 1024 * 1024,
  pushLogMax: 2000,
  pushLogMaxAgeMs: 15 * 60_000,
  tombstoneMaxAgeMs: 30 * 24 * 3600_000,
  maxDailyOps: 20_000,
};

export const fileUrl = (sessionId: string, fileId: string) =>
  `/api/sessions/${sessionId}/files/${fileId}`;

const LAYOUT_FIELDS: Record<string, readonly string[]> = {
  text: ["x", "y", "width", "height"],
  rectangle: ["height"],
  diamond: ["height"],
  ellipse: ["height"],
  note: ["height"],
};
const withoutLayoutFields = (el: Record<string, unknown>) => {
  const omit = LAYOUT_FIELDS[el.type as string] ?? [];
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(el)) if (!omit.includes(k)) copy[k] = el[k];
  return JSON.stringify(copy);
};

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

const sha256Hex = async (data: Uint8Array | string): Promise<string> => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const r2Key = (sessionId: string, sha: string) => `${sessionId}/${sha}`;

interface MediaBucket {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export class BoardStore {
  private readonly limits: StoreLimits;
  private readonly now: () => number;
  private readonly tx: <T>(fn: () => T) => T;
  private readonly onWrite: () => void;
  /** The committed change of the last `apply`/`importScene` (phase 2 broadcast). */
  lastEvent: ChangesEvent | null = null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly sessionId: string,
    private readonly media: MediaBucket,
    opts: {
      limits?: Partial<StoreLimits>;
      now?: () => number;
      /** storage.transactionSync — sql.exec bans BEGIN/COMMIT in DO SQLite */
      tx?: <T>(fn: () => T) => T;
      /** Fired after a successful write; the DO uses it to refresh fleet idle clocks. */
      onWrite?: () => void;
    } = {},
  ) {
    this.limits = { ...STORE_LIMITS, ...opts.limits };
    this.now = opts.now ?? Date.now;
    this.onWrite = opts.onWrite ?? (() => {});
    this.tx =
      opts.tx ??
      // Single-writer DO storage serialises anyway; this fallback is for the
      // vitest shim, whose better-sqlite3 accepts BEGIN/COMMIT through exec.
      ((fn) => {
        this.sql.exec("BEGIN IMMEDIATE");
        try {
          const out = fn();
          this.sql.exec("COMMIT");
          return out;
        } catch (e) {
          this.sql.exec("ROLLBACK");
          throw e;
        }
      });
  }

  // ---------------------------------------------------------------- queries

  private one<T>(query: string, ...params: unknown[]): T | undefined {
    const rows = this.sql.exec(query, ...params).toArray() as T[];
    return rows[0];
  }

  private all<T>(query: string, ...params: unknown[]): T[] {
    return this.sql.exec(query, ...params).toArray() as T[];
  }

  private run(query: string, ...params: unknown[]) {
    this.sql.exec(query, ...params);
  }

  /** Set when deletion starts: in-flight writes see a retryable 503, not a
   *  permanent 404 — if the R2 delete fails the board survives and their
   *  edits were never refused. */
  private deleted = false;

  private requireSession(): SessionRow {
    const s = this.one<SessionRow>("SELECT * FROM sessions WHERE id = ?", this.sessionId);
    if (!s) throw notFound();
    if (this.deleted)
      throw new ServiceError(503, "deleting", "This board is being deleted; retry shortly.");
    return s;
  }

  private element(id: string) {
    return this.one<ElementRow>(
      "SELECT id, idx, version, rev, deleted, needs_layout, data FROM elements WHERE session_id = ? AND id = ?",
      this.sessionId,
      id,
    );
  }

  private file(id: string) {
    return this.one<FileRow>(
      "SELECT * FROM files WHERE session_id = ? AND id = ?",
      this.sessionId,
      id,
    );
  }

  private sceneBytes(): number {
    return (
      this.one<{ n: number }>(
        "SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS n FROM elements WHERE session_id = ? AND deleted = 0",
        this.sessionId,
      )?.n ?? 0
    );
  }

  // ---------------------------------------------------------------- secrets

  /** SHA-256 hashes of the board's secrets, or null before `create`. */
  private authRow(): { edit_hash: string; owner_hash: string } | undefined {
    return this.one<{ edit_hash: string; owner_hash: string }>(
      "SELECT edit_hash, owner_hash FROM auth WHERE session_id = ?",
      this.sessionId,
    );
  }

  /**
   * Mints the three secrets of a new board. Returns them once — only their
   * hashes are kept.
   */
  async create(title = ""): Promise<{ editKey: string; ownerKey: string }> {
    const editKey = randomId(16);
    const ownerKey = randomId(16);
    const [editHash, ownerHash] = await Promise.all([sha256Hex(editKey), sha256Hex(ownerKey)]);
    this.tx(() => {
      if (this.one("SELECT id FROM sessions WHERE id = ?", this.sessionId))
        throw new ServiceError(409, "session_exists", "This board already exists.");
      const now = this.now();
      this.run(
        "INSERT INTO sessions (id, title, settings, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
        this.sessionId,
        title.slice(0, LIMITS.title),
        now,
        now,
      );
      this.run(
        "INSERT INTO auth (session_id, edit_hash, owner_hash, updated_at) VALUES (?, ?, ?, ?)",
        this.sessionId,
        editHash,
        ownerHash,
        now,
      );
    });
    return { editKey, ownerKey };
  }

  /** True when `key` matches the stored hash for `kind` (owner also edits). */
  async checkKey(key: string, kind: "edit" | "owner"): Promise<boolean> {
    const a = this.authRow();
    if (!a) return false;
    const hash = await sha256Hex(key);
    return kind === "edit" ? hash === a.edit_hash || hash === a.owner_hash : hash === a.owner_hash;
  }

  /** Owner-only: replaces both secrets; the old ones stop working at once. */
  async rotateKeys(): Promise<{ editKey: string; ownerKey: string }> {
    this.requireSession();
    const editKey = randomId(16);
    const ownerKey = randomId(16);
    const [editHash, ownerHash] = await Promise.all([sha256Hex(editKey), sha256Hex(ownerKey)]);
    this.run(
      "UPDATE auth SET edit_hash = ?, owner_hash = ?, updated_at = ? WHERE session_id = ?",
      editHash,
      ownerHash,
      this.now(),
      this.sessionId,
    );
    return { editKey, ownerKey };
  }

  // ---------------------------------------------------------------- sessions

  get exists(): boolean {
    return this.one("SELECT id FROM sessions WHERE id = ?", this.sessionId) !== undefined;
  }

  meta() {
    const s = this.requireSession();
    return {
      session_id: s.id,
      title: s.title,
      rev: s.rev,
      element_count: s.element_count,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  }

  snapshot(opts: { markOpened?: boolean } = {}): SceneSnapshot {
    const s = this.requireSession();
    if (opts.markOpened)
      this.run("UPDATE sessions SET opened_at = ? WHERE id = ?", this.now(), this.sessionId);
    return {
      rev: s.rev,
      title: s.title,
      settings: JSON.parse(s.settings),
      elements: this.all<ElementRow>(
        "SELECT id, idx, version, rev, deleted, needs_layout, data FROM elements WHERE session_id = ? AND deleted = 0 ORDER BY idx, id",
        this.sessionId,
      ).map((r) => ({
        el: JSON.parse(r.data) as SceneElement,
        idx: r.idx,
        version: r.version,
        needsLayout: r.needs_layout === 1,
      })),
      tombstones: this.all<{ id: string; version: number }>(
        "SELECT id, version FROM elements WHERE session_id = ? AND deleted = 1 ORDER BY id",
        this.sessionId,
      ),
      files: this.all<FileRow>(
        "SELECT * FROM files WHERE session_id = ? ORDER BY created_at, id",
        this.sessionId,
      ).map((f) => this.fileOut(f)),
    };
  }

  private fileOut(f: FileRow): StoredFile {
    return {
      id: f.id,
      mime: f.mime,
      url: f.source === "upload" ? fileUrl(this.sessionId, f.id) : (f.url ?? ""),
      size: f.size,
      width: f.width,
      height: f.height,
      durationMs: f.duration_ms,
      source: f.source,
      posterFileId: f.poster_file_id,
    };
  }

  applyAgentChange<R>(
    mutate: (
      elements: SceneElement[],
      snap: SceneSnapshot,
    ) => { next: SceneElement[]; touched: Iterable<string>; hint?: LayerHint; result: R },
    agentName: string,
  ): { rev: number; result: R; changed: boolean; elements: SceneElement[] } {
    const snap = this.snapshot();
    const before = snap.elements.map((e) => e.el);
    const { next: raw, touched, hint, result } = mutate(before, snap);
    const touchedSet = new Set(touched);
    const next = finalizeScene(raw, touchedSet);
    const keys = new Map(snap.elements.map((e) => [e.el.id, e.idx]));
    const versions = new Map(snap.elements.map((e) => [e.el.id, e.version]));
    const prevById = new Map(before.map((e) => [e.id, e]));
    const newKeys = assignKeys(before, next, keys, hint);
    const ops: RawOp[] = [];
    const layoutIds = new Set<string>();
    const nextIds = new Set<string>();
    for (const el of next) {
      nextIds.add(el.id);
      const prev = prevById.get(el.id);
      const idx = newKeys.get(el.id)!;
      if (prev === el && keys.get(el.id) === idx) continue;
      if (prev && keys.get(el.id) === idx && JSON.stringify(prev) === JSON.stringify(el)) continue;
      ops.push({ t: "put", el, idx, baseVersion: versions.get(el.id) ?? 0 });
      if (el.type === "text" && touchedSet.has(el.id)) {
        layoutIds.add(el.id);
        if (el.containerId) layoutIds.add(el.containerId);
      }
    }
    for (const el of before)
      if (!nextIds.has(el.id)) ops.push({ t: "del", id: el.id, baseVersion: versions.get(el.id)! });
    if (!ops.length) return { rev: snap.rev, result, changed: false, elements: next };
    const { ack, applied } = this.apply(
      { pushId: randomId(16), baseRev: snap.rev, ops },
      { origin: { kind: "agent", name: agentName }, atomic: true, layoutIds },
    );
    if (!applied || ack.rejected.length) throw new AgentRejected(ack.rejected);
    return { rev: ack.rev, result, changed: true, elements: next };
  }

  /** Deletes the board's rows; media objects go with the DO's R2 prefix. */
  async deleteSession(): Promise<string[]> {
    this.requireSession();
    // flagged before the first await: an upload that slips into the R2-wait
    // window fails requireSession in its tx instead of committing a row whose
    // media object this delete never heard about
    this.deleted = true;
    const uploads = this.all<{ sha256: string }>(
      "SELECT sha256 FROM files WHERE session_id = ? AND source = 'upload'",
      this.sessionId,
    );
    const gone = [...new Set(uploads.map((f) => f.sha256))];
    try {
      // R2 first: if the delete fails the rows stay and the owner can retry —
      // erasing the rows first would orphan the objects with no way back.
      if (gone.length) await this.media.delete(gone.map((sha) => r2Key(this.sessionId, sha)));
      this.tx(() => {
        for (const f of uploads)
          this.run("UPDATE blobs SET refs = refs - 1 WHERE sha256 = ?", f.sha256);
        this.run("DELETE FROM sessions WHERE id = ?", this.sessionId);
        this.run("DELETE FROM blobs WHERE refs <= 0");
      });
    } catch (e) {
      this.deleted = false;
      throw e;
    }
    return gone;
  }

  // ---------------------------------------------------------------- ops

  /** Count `n` ops against today's write budget; 429 when it overflows. */
  private bumpDailyOps(n: number) {
    const k = `daily_ops:${new Date(this.now()).toISOString().slice(0, 10)}`;
    const row = this.one<{ v: string }>("SELECT v FROM _meta WHERE k = ?", k);
    const cur = row ? Number(row.v) : 0;
    if (cur + n > this.limits.maxDailyOps)
      throw new ServiceError(
        429,
        "capacity",
        "This board is read-only until the daily capacity resets.",
      );
    this.run(
      "INSERT INTO _meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      String(cur + n),
    );
  }

  apply(push: PushInput, opts: ApplyOptions): ApplyResult {
    this.lastEvent = null;
    try {
      const r = this.tx(() => this.applyInTx(push, opts));
      this.lastEvent = r.event;
      this.onWrite();
      return { ack: r.ack, applied: true, event: r.event };
    } catch (e) {
      if (e instanceof Rollback) return { ack: e.ack, applied: false, event: null };
      throw e;
    }
  }

  private applyInTx(push: PushInput, opts: ApplyOptions): { ack: Ack; event: ChangesEvent | null } {
    const s = this.requireSession();
    // charged inside the tx after the board check: a refused or rolled-back
    // push — deleting window, gone board, stale base — must not spend quota
    this.bumpDailyOps(push.ops.length || 1);
    const dup = this.one<{ ack: string }>(
      "SELECT ack FROM push_log WHERE session_id = ? AND push_id = ?",
      this.sessionId,
      push.pushId,
    );
    if (dup) return { ack: { ...(JSON.parse(dup.ack) as Ack), duplicate: true }, event: null };

    const now = this.now();
    const replay = push.mirrored === true && push.baseRev < s.push_log_floor_rev;
    const newRev = s.rev + 1;
    let count = s.element_count;
    let bytes = this.sceneBytes();
    let title = s.title;
    const settings = JSON.parse(s.settings) as Record<string, unknown>;
    const versions: Record<string, number> = {};
    const rejected: Rejected[] = [];
    const ignored: { id: string; reason: IgnoreReason }[] = [];
    const applied: AppliedOp[] = [];
    const ignore = (id: string, reason: IgnoreReason) => ignored.push({ id, reason });

    push.ops.forEach((op, i) => {
      switch (op.t) {
        case "put": {
          const rawId = (op.el as { id?: unknown } | null)?.id;
          const elId = typeof rawId === "string" ? rawId.slice(0, 64) : "";
          const v = validateStoredElement(op.el);
          if (!v.ok) {
            const tooBig = v.reason === "element_too_large";
            rejected.push({
              id: elId,
              reason: tooBig ? "element_too_large" : "invalid",
              path: `ops[${i}].el${v.path ? `.${v.path}` : ""}`,
              message: tooBig ? "the element is larger than 256 KB" : v.reason,
            });
            return;
          }
          const el = v.el;
          if (!isValidKey(op.idx)) {
            rejected.push({
              id: el.id,
              reason: "invalid",
              path: `ops[${i}].idx`,
              message: "must be a fractional layer key",
            });
            return;
          }
          const row = this.element(el.id);
          const stored = row?.version ?? 0;
          if (replay && stored !== op.baseVersion) return ignore(el.id, "stale_replay");
          if (row?.deleted === 1 && op.baseVersion !== row.version) {
            rejected.push({
              id: el.id,
              reason: "deleted",
              message: "this item was deleted; a change to it is not kept",
            });
            return;
          }
          if (el.type === "image" && !this.file(el.fileId)) {
            rejected.push({
              id: el.id,
              reason: "unknown_file",
              path: `ops[${i}].el.fileId`,
              message: `no file "${el.fileId}" in this board`,
            });
            return;
          }
          const live = row !== undefined && row.deleted === 0;
          if (op.layout) {
            if (!live || row.needs_layout !== 1) return ignore(el.id, "layout_done");
            const before = JSON.parse(row.data) as Record<string, unknown>;
            if (
              withoutLayoutFields(before) !==
              withoutLayoutFields(el as unknown as Record<string, unknown>)
            ) {
              rejected.push({
                id: el.id,
                reason: "layout_not_allowed",
                path: `ops[${i}].el`,
                message: "a layout correction may only change the text box or the container height",
              });
              return;
            }
          }
          const data = JSON.stringify(el);
          const nextCount = count + (live ? 0 : 1);
          const nextBytes = bytes - (live ? byteLength(row.data) : 0) + byteLength(data);
          if (nextCount > this.limits.maxElements || nextBytes > this.limits.maxSceneBytes) {
            rejected.push({
              id: el.id,
              reason: "scene_too_large",
              message: `a board holds at most ${this.limits.maxElements} items and ${Math.round(this.limits.maxSceneBytes / 1048576)} MB`,
            });
            return;
          }
          count = nextCount;
          bytes = nextBytes;
          const version = stored + 1;
          const needsLayout = !op.layout && opts.layoutIds?.has(el.id) ? 1 : 0;
          this.run(
            `INSERT INTO elements (session_id, id, idx, version, rev, deleted, needs_layout, data, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
             ON CONFLICT (session_id, id) DO UPDATE SET idx = excluded.idx, version = excluded.version,
               rev = excluded.rev, deleted = 0, needs_layout = excluded.needs_layout, data = excluded.data,
               updated_at = excluded.updated_at`,
            this.sessionId,
            el.id,
            op.idx,
            version,
            newRev,
            needsLayout,
            data,
            now,
          );
          versions[el.id] = version;
          applied.push({ t: "put", el, idx: op.idx, version, needsLayout: needsLayout === 1 });
          return;
        }
        case "del": {
          const row = this.element(op.id);
          if (!row) return ignore(op.id, "not_found");
          if (row.deleted === 1) return ignore(op.id, "already_deleted");
          if (replay && row.version !== op.baseVersion) return ignore(op.id, "stale_replay");
          const version = row.version + 1;
          this.run(
            "UPDATE elements SET deleted = 1, version = ?, rev = ?, needs_layout = 0, data = 'null', updated_at = ? WHERE session_id = ? AND id = ?",
            version,
            newRev,
            now,
            this.sessionId,
            op.id,
          );
          count -= 1;
          bytes -= byteLength(row.data);
          versions[op.id] = version;
          applied.push({ t: "del", id: op.id, version });
          return;
        }
        case "settings": {
          const v = validateSettings(op.settings);
          if (!v.ok) {
            rejected.push({
              id: "settings",
              reason: "invalid",
              path: `ops[${i}].settings${v.path ? `.${v.path}` : ""}`,
              message: v.reason,
            });
            return;
          }
          if (replay) return ignore("settings", "stale_replay");
          const { title: t, ...rest } = v.el;
          if (t !== undefined) title = t;
          Object.assign(settings, rest);
          applied.push({ t: "settings", settings: { ...v.el } });
          return;
        }
        case "poster": {
          const f = this.file(op.fileId);
          const p = this.file(op.posterFileId);
          if (!f || !p) {
            rejected.push({
              id: op.fileId,
              reason: "unknown_file",
              path: `ops[${i}]`,
              message: "both files must belong to this board",
            });
            return;
          }
          if (!p.mime.startsWith("image/")) {
            rejected.push({
              id: op.fileId,
              reason: "invalid",
              path: `ops[${i}].posterFileId`,
              message: "a poster must be a picture",
            });
            return;
          }
          if (f.poster_file_id) return ignore(op.fileId, "poster_set");
          this.run(
            "UPDATE files SET poster_file_id = ? WHERE session_id = ? AND id = ?",
            op.posterFileId,
            this.sessionId,
            op.fileId,
          );
          applied.push({ ...op });
          return;
        }
        case "fileMeta": {
          const f = this.file(op.fileId);
          if (!f) {
            rejected.push({
              id: op.fileId,
              reason: "unknown_file",
              path: `ops[${i}].fileId`,
              message: `no file "${op.fileId}" in this board`,
            });
            return;
          }
          if (f.width !== null || f.height !== null || f.duration_ms !== null)
            return ignore(op.fileId, "meta_known");
          this.run(
            "UPDATE files SET width = ?, height = ?, duration_ms = ? WHERE session_id = ? AND id = ?",
            op.width,
            op.height,
            op.durationMs ?? null,
            this.sessionId,
            op.fileId,
          );
          applied.push({ ...op });
          return;
        }
      }
    });

    if (opts.atomic && rejected.length > 0)
      throw new Rollback({ pushId: push.pushId, rev: s.rev, versions: {}, rejected, ignored });

    const rev = applied.length > 0 ? newRev : s.rev;
    if (applied.length > 0)
      this.run(
        "UPDATE sessions SET rev = ?, element_count = ?, title = ?, settings = ?, updated_at = ? WHERE id = ?",
        rev,
        count,
        title,
        JSON.stringify(settings),
        now,
        this.sessionId,
      );
    const ack: Ack = { pushId: push.pushId, rev, versions, rejected, ignored };
    this.run(
      "INSERT INTO push_log (session_id, push_id, rev, ack, created_at) VALUES (?, ?, ?, ?, ?)",
      this.sessionId,
      push.pushId,
      rev,
      JSON.stringify(ack),
      now,
    );
    this.trimPushLog(now);
    const event =
      applied.length > 0
        ? { sessionId: this.sessionId, fromRev: s.rev, rev, ops: applied, origin: opts.origin }
        : null;
    return { ack, event };
  }

  private trimPushLog(now: number) {
    const cutoff = now - this.limits.pushLogMaxAgeMs;
    const victims = `SELECT rowid FROM push_log WHERE session_id = @sid AND (created_at < @cutoff OR rowid IN (
        SELECT rowid FROM push_log WHERE session_id = @sid ORDER BY rowid DESC LIMIT -1 OFFSET @max))`;
    // DO sql binds positional ? only, so substitute the numbers directly
    // (all integers, no injection surface).
    const sql = victims
      .replaceAll("@sid", `'${this.sessionId}'`)
      .replaceAll("@cutoff", String(cutoff))
      .replaceAll("@max", String(this.limits.pushLogMax));
    const top = this.one<{ r: number | null }>(
      `SELECT MAX(rev) AS r FROM push_log WHERE rowid IN (${sql})`,
    )?.r;
    if (top === null || top === undefined) return;
    this.run(`DELETE FROM push_log WHERE rowid IN (${sql})`);
    this.run(
      "UPDATE sessions SET push_log_floor_rev = MAX(push_log_floor_rev, ?) WHERE id = ?",
      top,
      this.sessionId,
    );
  }

  /** Atomic import (§3.6): one rev, one ack, every element validated. */
  importScene(input: ImportInput, origin: ChangeOrigin): ApplyResult {
    this.lastEvent = null;
    try {
      const r = this.tx(() => {
        this.requireSession();
        const ops: RawOp[] = [];
        const incoming = new Set(
          input.elements
            .map((e) => (e.el as { id?: unknown } | null)?.id)
            .filter((v): v is string => typeof v === "string"),
        );
        // a mirrored replay degrades `replace` to `add`: the dedup receipt may
        // be gone by the time it lands, and rows added since the original
        // import must not be deleted
        if (input.mode === "replace" && input.mirrored !== true)
          for (const row of this.all<{ id: string; version: number }>(
            "SELECT id, version FROM elements WHERE session_id = ? AND deleted = 0",
            this.sessionId,
          ))
            if (!incoming.has(row.id)) ops.push({ t: "del", id: row.id, baseVersion: row.version });
        for (const e of input.elements) {
          const rawId = (e.el as { id?: unknown } | null)?.id;
          const row = typeof rawId === "string" ? this.element(rawId) : undefined;
          // a mirrored import reports the version it saw, so the replay guard
          // ignores puts that would clobber edits made after the import
          const baseVersion = input.mirrored === true ? (e.v ?? 0) : (row?.version ?? 0);
          ops.push({ t: "put", el: e.el, idx: e.idx, baseVersion });
        }
        if (input.settings !== undefined) ops.push({ t: "settings", settings: input.settings });
        return this.applyInTx(
          {
            pushId: input.importId,
            baseRev: 0,
            ops,
            ...(input.mirrored ? { mirrored: true as const } : {}),
          },
          { origin, atomic: true },
        );
      });
      this.lastEvent = r.event;
      return { ack: r.ack, applied: true, event: r.event };
    } catch (e) {
      if (e instanceof Rollback) {
        if (e.ack.rejected.some((r) => r.reason === "scene_too_large"))
          throw new ServiceError(
            413,
            "scene_too_large",
            `The import would make the board larger than ${this.limits.maxElements} items or ${Math.round(this.limits.maxSceneBytes / 1048576)} MB; nothing was imported.`,
          );
        return { ack: e.ack, applied: false, event: null };
      }
      throw e;
    }
  }

  /**
   * Everything that changed after `sinceRev` (reconnect path). Null when the
   * board cannot answer exactly — the caller then sends a full snapshot.
   */
  changesSince(
    sinceRev: number,
  ): { fromRev: number; rev: number; ops: AppliedOp[]; files: StoredFile[] } | null {
    const s = this.requireSession();
    if (sinceRev > s.rev || sinceRev < s.push_log_floor_rev) return null;
    if (sinceRev === s.rev) return { fromRev: sinceRev, rev: s.rev, ops: [], files: [] };
    const rows = this.all<ElementRow>(
      "SELECT id, idx, version, rev, deleted, needs_layout, data FROM elements WHERE session_id = ? AND rev > ? ORDER BY idx, id",
      this.sessionId,
      sinceRev,
    );
    const ops: AppliedOp[] = [
      { t: "settings", settings: { ...JSON.parse(s.settings), title: s.title } },
    ];
    for (const r of rows)
      ops.push(
        r.deleted
          ? { t: "del", id: r.id, version: r.version }
          : {
              t: "put",
              el: JSON.parse(r.data) as SceneElement,
              idx: r.idx,
              version: r.version,
              needsLayout: r.needs_layout === 1,
            },
      );
    return { fromRev: sinceRev, rev: s.rev, ops, files: this.filesFor(ops) };
  }

  filesFor(ops: readonly AppliedOp[]): StoredFile[] {
    const ids = new Set<string>();
    for (const op of ops) {
      if (op.t === "put") {
        const f = (op.el as { fileId?: unknown }).fileId;
        if (typeof f === "string") ids.add(f);
      } else if (op.t === "poster") {
        ids.add(op.fileId);
        ids.add(op.posterFileId);
      } else if (op.t === "fileMeta") ids.add(op.fileId);
    }
    const out: StoredFile[] = [];
    for (const id of ids) {
      const f = this.file(id);
      if (f) out.push(this.fileOut(f));
    }
    return out;
  }

  // ---------------------------------------------------------------- files

  /** Stores an uploaded picture/video in R2 (same dedupe rules as the Node service). */
  async addFile(
    bytes: Uint8Array,
    contentType: string | undefined,
    verify?: () => Promise<void>,
  ): Promise<StoredFile> {
    this.requireSession();
    const claimed = baseType(contentType);
    const isVideo = (VIDEO_TYPES as readonly string[]).includes(claimed);
    if (!isVideo && !(PICTURE_TYPES as readonly string[]).includes(claimed))
      throw new ServiceError(
        415,
        "unsupported_type",
        "Only PNG, JPEG, GIF and WebP pictures and MP4 and WebM videos can be uploaded (set Content-Type to the file's type).",
      );
    if (bytes.length === 0) throw new ServiceError(400, "empty_file", "The upload is empty.");
    const max = isVideo ? this.limits.maxVideoBytes : this.limits.maxImageBytes;
    if (bytes.length > max)
      throw new ServiceError(
        413,
        "too_large",
        `${isVideo ? "Videos" : "Pictures"} can be at most ${Math.round(max / 1048576)} MB.`,
      );
    const real = sniffType(bytes);
    if (real !== claimed)
      throw new ServiceError(415, "unsupported_type", `The file content is not a ${claimed} file.`);
    const sha = await sha256Hex(bytes);
    const existing = this.one<FileRow>(
      "SELECT * FROM files WHERE session_id = ? AND sha256 = ? AND source = 'upload' LIMIT 1",
      this.sessionId,
      sha,
    );
    if (existing) return this.fileOut(existing);
    const meta = isVideo
      ? videoMeta(real, Buffer.from(bytes))
      : { ...pictureSize(bytes), durationMs: null as number | null };
    const { width, height, durationMs } = meta;
    // R2 first, then the row: a put failure leaves nothing to dedup, so a
    // retry writes the media instead of returning a phantom success.
    const objectKey = r2Key(this.sessionId, sha);
    await this.media.put(objectKey, bytes);
    let row: FileRow;
    try {
      // re-check the caller's credential between the R2 write and the commit:
      // a key rotated during the put can no longer sneak the row in
      if (verify) await verify();
      row = this.tx(() => {
        const s = this.requireSession();
        if (s.media_bytes + bytes.length > this.limits.maxSessionMediaBytes)
          throw storageFull("this board's media limit");
        const blob = this.one<{ refs: number }>("SELECT refs FROM blobs WHERE sha256 = ?", sha);
        if (blob) this.run("UPDATE blobs SET refs = refs + 1 WHERE sha256 = ?", sha);
        else this.run("INSERT INTO blobs (sha256, size, refs) VALUES (?, ?, 1)", sha, bytes.length);
        const id = `f${randomId(12)}`;
        const now = this.now();
        this.run(
          `INSERT INTO files (session_id, id, mime, size, sha256, width, height, duration_ms, source, url, poster_file_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upload', NULL, NULL, ?)`,
          this.sessionId,
          id,
          real,
          bytes.length,
          sha,
          width,
          height,
          durationMs,
          now,
        );
        this.run(
          "UPDATE sessions SET media_bytes = media_bytes + ?, updated_at = ? WHERE id = ?",
          bytes.length,
          now,
          this.sessionId,
        );
        return this.file(id)!;
      });
    } catch (e) {
      // the tx failed after the put: drop the orphan object — unless a
      // concurrent identical upload already claimed it (its blob row exists)
      const claimed = this.one("SELECT 1 AS x FROM blobs WHERE sha256 = ?", sha);
      if (!claimed) await this.media.delete([objectKey]).catch(() => {});
      throw e;
    }
    this.onWrite();
    return this.fileOut(row);
  }

  /** Records a remote media link; the worker never fetches it (no SSRF).
   *  Sync like the Node service's: `addLink` runs inside sync transactions. */
  addRemoteFile(
    url: string,
    mime: string,
    meta: { width?: number | null; height?: number | null } = {},
  ): StoredFile {
    this.requireSession();
    const check = checkRemoteUrl(url);
    if (!check.ok) throw new ServiceError(400, "invalid_url", `The link ${check.reason}.`);
    if (!(ALLOWED_MIME as readonly string[]).includes(mime))
      throw new ServiceError(
        415,
        "unsupported_type",
        "Links can be PNG, JPEG, GIF or WebP pictures or MP4 or WebM videos.",
      );
    const key = `remote:${mime}:${check.url}`;
    const sha = createHash("sha256").update(key).digest("hex");
    const existing = this.one<FileRow>(
      "SELECT * FROM files WHERE session_id = ? AND sha256 = ? AND source = 'remote' LIMIT 1",
      this.sessionId,
      sha,
    );
    if (existing) return this.fileOut(existing);
    const dim = (v: number | null | undefined) =>
      typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : null;
    const row = this.tx(() => {
      const id = `f${randomId(12)}`;
      this.run(
        `INSERT INTO files (session_id, id, mime, size, sha256, width, height, duration_ms, source, url, poster_file_id, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, NULL, 'remote', ?, NULL, ?)`,
        this.sessionId,
        id,
        mime,
        sha,
        dim(meta.width),
        dim(meta.height),
        check.url,
        this.now(),
      );
      return this.file(id)!;
    });
    return this.fileOut(row);
  }

  /** The file's row and its R2 object key, for downloads. */
  fileForDownload(fileId: string): { file: StoredFile; key: string } {
    this.requireSession();
    const f = this.file(fileId);
    if (!f || f.source !== "upload")
      throw new ServiceError(404, "file_not_found", "This file does not exist in this board.");
    return { file: this.fileOut(f), key: r2Key(this.sessionId, f.sha256) };
  }

  // ---------------------------------------------------------------- upkeep

  /** Purges old push_log rows and old tombstones (called from the DO alarm). */
  maintenance() {
    const now = this.now();
    this.tx(() => {
      this.trimPushLog(now);
      this.run(
        "DELETE FROM elements WHERE deleted = 1 AND updated_at < ?",
        now - this.limits.tombstoneMaxAgeMs,
      );
    });
  }

  /** When the board last saw activity (open or write), for idle eviction. */
  lastActivity(): number {
    const s = this.requireSession();
    return Math.max(s.opened_at ?? 0, s.updated_at ?? 0, s.created_at ?? 0);
  }
}
