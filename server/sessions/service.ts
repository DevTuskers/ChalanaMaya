/**
 * SessionService (plan §3.6): the single authority over boards. Every write
 * goes through `apply`, which runs in one SQLite transaction, validates every
 * op strictly, enforces quotas, drops duplicate pushes and records the ack in
 * `push_log` in the same transaction.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Limits } from "../config";
import { dbBytes, type DB } from "../db/schema";
import { notFound, ServiceError, storageFull } from "../errors";
import { baseType, PICTURE_TYPES, pictureSize, sniffType, VIDEO_TYPES } from "../media/sniff";
import { newSessionId, randomId } from "../../src/shared/ids";
import { assignKeys, isValidKey, type LayerHint } from "../../src/shared/keys";
import { finalizeScene } from "../../src/scene/scene";
import { ALLOWED_MIME, validateSettings, validateStoredElement } from "../../src/shared/validate";
import { checkRemoteUrl } from "../../src/shared/urls";
import { videoMeta } from "../media/videoMeta";
import type {
  Ack,
  IgnoreReason,
  RawOp,
  Rejected,
  SceneSnapshot,
  StoredFile,
} from "../../src/shared/protocol";
import type { SceneElement } from "../../src/scene/types";

export interface ChangeOrigin {
  kind: "browser" | "agent";
  name: string;
}

export interface ApplyOptions {
  origin: ChangeOrigin;
  /** any rejection rolls the whole batch back */
  atomic: boolean;
  /**
   * Elements whose text the server laid out (agent path, §3.8): stored with
   * needs_layout = 1 so the first browser with fonts corrects them once.
   */
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
  elements: { el: unknown; idx: string }[];
  settings?: unknown;
  mirrored?: true;
}

export type AppliedOp =
  | { t: "put"; el: SceneElement; idx: string; version: number; needsLayout: boolean }
  | { t: "del"; id: string; version: number }
  | { t: "settings"; settings: Record<string, unknown> }
  | { t: "poster"; fileId: string; posterFileId: string }
  | { t: "fileMeta"; fileId: string; width: number; height: number; durationMs?: number };

/** Emitted after a batch commits (for live sync from phase 3). */
export interface ChangesEvent {
  sessionId: string;
  fromRev: number;
  rev: number;
  ops: AppliedOp[];
  origin: ChangeOrigin;
}

export interface ApplyResult {
  ack: Ack;
  /** false when an atomic batch was rolled back */
  applied: boolean;
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

/** An agent change the server refused (validation, quota); nothing was stored. */
import { AgentRejected } from "../../src/shared/agentRejected";
export { AgentRejected };

class Rollback extends Error {
  constructor(readonly ack: Ack) {
    super("rolled back");
  }
}

export interface ServiceOptions {
  limits: Limits;
  mediaDir: string;
  now?: () => number;
}

export const fileUrl = (sessionId: string, fileId: string) =>
  `/api/sessions/${sessionId}/files/${fileId}`;

/** Fields a layout correction may change (§3.6): a text's box, a container's height. */
const LAYOUT_FIELDS: Record<string, readonly string[]> = {
  text: ["x", "y", "width", "height"],
  // the types that can hold a bound label and grow to fit it (syncBoundTexts)
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

export class SessionService {
  readonly events = new EventEmitter();
  private readonly limits: Limits;
  private readonly mediaDir: string;
  private readonly now: () => number;
  private readonly q;

  constructor(
    readonly db: DB,
    opts: ServiceOptions,
  ) {
    this.limits = opts.limits;
    this.mediaDir = opts.mediaDir;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.q = {
      session: db.prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?"),
      countSessions: db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sessions"),
      insertSession: db.prepare(
        "INSERT INTO sessions (id, title, settings, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
      ),
      element: db.prepare<[string, string], ElementRow>(
        "SELECT id, idx, version, rev, deleted, needs_layout, data FROM elements WHERE session_id = ? AND id = ?",
      ),
      liveIds: db.prepare<[string], { id: string; version: number }>(
        "SELECT id, version FROM elements WHERE session_id = ? AND deleted = 0",
      ),
      sceneBytes: db.prepare<[string], { n: number }>(
        "SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS n FROM elements WHERE session_id = ? AND deleted = 0",
      ),
      upsert: db.prepare(
        `INSERT INTO elements (session_id, id, idx, version, rev, deleted, needs_layout, data, updated_at)
         VALUES (@sid, @id, @idx, @version, @rev, 0, @needsLayout, @data, @now)
         ON CONFLICT (session_id, id) DO UPDATE SET idx = excluded.idx, version = excluded.version,
           rev = excluded.rev, deleted = 0, needs_layout = excluded.needs_layout, data = excluded.data,
           updated_at = excluded.updated_at`,
      ),
      tombstone: db.prepare(
        "UPDATE elements SET deleted = 1, version = ?, rev = ?, needs_layout = 0, data = 'null', updated_at = ? WHERE session_id = ? AND id = ?",
      ),
      liveElements: db.prepare<[string], ElementRow>(
        "SELECT id, idx, version, rev, deleted, needs_layout, data FROM elements WHERE session_id = ? AND deleted = 0 ORDER BY idx, id",
      ),
      tombstones: db.prepare<[string], { id: string; version: number }>(
        "SELECT id, version FROM elements WHERE session_id = ? AND deleted = 1 ORDER BY id",
      ),
      file: db.prepare<[string, string], FileRow>(
        "SELECT * FROM files WHERE session_id = ? AND id = ?",
      ),
      fileBySha: db.prepare<[string, string], FileRow>(
        "SELECT * FROM files WHERE session_id = ? AND sha256 = ? AND source = 'upload' LIMIT 1",
      ),
      files: db.prepare<[string], FileRow>(
        "SELECT * FROM files WHERE session_id = ? ORDER BY created_at, id",
      ),
      pushLog: db.prepare<[string, string], { ack: string }>(
        "SELECT ack FROM push_log WHERE session_id = ? AND push_id = ?",
      ),
      insertPushLog: db.prepare(
        "INSERT INTO push_log (session_id, push_id, rev, ack, created_at) VALUES (?, ?, ?, ?, ?)",
      ),
      updateSession: db.prepare(
        "UPDATE sessions SET rev = ?, element_count = ?, title = ?, settings = ?, updated_at = ? WHERE id = ?",
      ),
      totalMedia: db.prepare<[], { n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM blobs"),
      blob: db.prepare<[string], { sha256: string; size: number; refs: number }>(
        "SELECT * FROM blobs WHERE sha256 = ?",
      ),
    };
  }

  // ---------------------------------------------------------------- sessions

  private requireSession(id: string): SessionRow {
    const s = this.q.session.get(id);
    if (!s) throw notFound();
    return s;
  }

  private checkDbSize() {
    if (dbBytes(this.db) > this.limits.maxDbBytes) throw storageFull("database size limit");
  }

  create(title = ""): { sessionId: string } {
    return this.db.transaction(() => {
      if (this.q.countSessions.get()!.n >= this.limits.maxSessions)
        throw new ServiceError(
          507,
          "too_many_sessions",
          "The ChalanaMaya server has reached its board limit. Ask its owner to free space.",
        );
      this.checkDbSize();
      const id = newSessionId();
      const now = this.now();
      this.q.insertSession.run(id, title, now, now);
      return { sessionId: id };
    })();
  }

  meta(id: string) {
    const s = this.requireSession(id);
    return {
      session_id: s.id,
      title: s.title,
      rev: s.rev,
      element_count: s.element_count,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  }

  snapshot(id: string, opts: { markOpened?: boolean } = {}): SceneSnapshot {
    const s = this.requireSession(id);
    if (opts.markOpened)
      this.db.prepare("UPDATE sessions SET opened_at = ? WHERE id = ?").run(this.now(), id);
    return {
      rev: s.rev,
      title: s.title,
      settings: JSON.parse(s.settings),
      elements: this.q.liveElements.all(id).map((r) => ({
        el: JSON.parse(r.data) as SceneElement,
        idx: r.idx,
        version: r.version,
        needsLayout: r.needs_layout === 1,
      })),
      tombstones: this.q.tombstones.all(id),
      files: this.q.files.all(id).map((f) => this.fileOut(id, f)),
    };
  }

  private fileOut(sessionId: string, f: FileRow): StoredFile {
    return {
      id: f.id,
      mime: f.mime,
      url: f.source === "upload" ? fileUrl(sessionId, f.id) : (f.url ?? ""),
      size: f.size,
      width: f.width,
      height: f.height,
      durationMs: f.duration_ms,
      source: f.source,
      posterFileId: f.poster_file_id,
    };
  }

  /**
   * The agent path (plan §3.9): `mutate` gets the live scene and returns the
   * next one plus the ids it touched. Only those are finalized (bound labels,
   * connector ends), the diff becomes ops with keys from `assignKeys`, and the
   * batch is applied atomically with an agent origin. Throws AgentRejected when
   * the server refuses an op; nothing is stored then.
   */
  applyAgentChange<R>(
    sessionId: string,
    mutate: (
      elements: SceneElement[],
      snap: SceneSnapshot,
    ) => { next: SceneElement[]; touched: Iterable<string>; hint?: LayerHint; result: R },
    agentName: string,
  ): { rev: number; result: R; changed: boolean; elements: SceneElement[] } {
    const snap = this.snapshot(sessionId);
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
      sessionId,
      { pushId: randomId(16), baseRev: snap.rev, ops },
      { origin: { kind: "agent", name: agentName }, atomic: true, layoutIds },
    );
    if (!applied || ack.rejected.length) throw new AgentRejected(ack.rejected);
    return { rev: ack.rev, result, changed: true, elements: next };
  }

  deleteSession(id: string) {
    this.requireSession(id);
    this.deleteSessions([id]);
  }

  private deleteSessions(ids: string[]) {
    const orphans: string[] = this.db.transaction(() => {
      const gone: string[] = [];
      for (const id of ids) {
        for (const f of this.q.files.all(id)) {
          if (f.source !== "upload") continue;
          this.db.prepare("UPDATE blobs SET refs = refs - 1 WHERE sha256 = ?").run(f.sha256);
        }
        this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      }
      for (const b of this.db
        .prepare<[], { sha256: string }>("SELECT sha256 FROM blobs WHERE refs <= 0")
        .all())
        gone.push(b.sha256);
      this.db.prepare("DELETE FROM blobs WHERE refs <= 0").run();
      return gone;
    })();
    for (const sha of orphans) fs.rmSync(path.join(this.mediaDir, sha), { force: true });
    // open tabs and agents' sockets hear at once that the board is gone
    this.events.emit("deleted", ids);
  }

  // ---------------------------------------------------------------- ops

  /** Applies one push. Returns the ack (a stored first ack with `duplicate: true` for a repeated pushId). */
  apply(sessionId: string, push: PushInput, opts: ApplyOptions): ApplyResult {
    let event: ChangesEvent | null = null;
    let result: ApplyResult;
    try {
      result = this.db.transaction(() => {
        const r = this.applyInTx(sessionId, push, opts);
        event = r.event;
        return { ack: r.ack, applied: true };
      })();
    } catch (e) {
      if (e instanceof Rollback) return { ack: e.ack, applied: false };
      throw e;
    }
    if (event) this.events.emit("changes", event);
    return result;
  }

  private applyInTx(
    sessionId: string,
    push: PushInput,
    opts: ApplyOptions,
  ): { ack: Ack; event: ChangesEvent | null } {
    const s = this.requireSession(sessionId);
    const dup = this.q.pushLog.get(sessionId, push.pushId);
    if (dup) return { ack: { ...(JSON.parse(dup.ack) as Ack), duplicate: true }, event: null };
    if (push.ops.length > 0) this.checkDbSize();

    const now = this.now();
    const replay = push.mirrored === true && push.baseRev < s.push_log_floor_rev;
    const newRev = s.rev + 1;
    let count = s.element_count;
    let bytes = this.q.sceneBytes.get(sessionId)!.n;
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
          const row = this.q.element.get(sessionId, el.id);
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
          if (el.type === "image" && !this.q.file.get(sessionId, el.fileId)) {
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
          const nextBytes =
            bytes - (live ? Buffer.byteLength(row.data) : 0) + Buffer.byteLength(data);
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
          // only the server's own text layout sets the flag (agent path, §3.8);
          // a browser put, including a layout correction, always clears it
          const needsLayout = !op.layout && opts.layoutIds?.has(el.id) ? 1 : 0;
          this.q.upsert.run({
            sid: sessionId,
            id: el.id,
            idx: op.idx,
            version,
            rev: newRev,
            needsLayout,
            data,
            now,
          });
          versions[el.id] = version;
          applied.push({ t: "put", el, idx: op.idx, version, needsLayout: needsLayout === 1 });
          return;
        }
        case "del": {
          const row = this.q.element.get(sessionId, op.id);
          if (!row) return ignore(op.id, "not_found");
          if (row.deleted === 1) return ignore(op.id, "already_deleted");
          if (replay && row.version !== op.baseVersion) return ignore(op.id, "stale_replay");
          const version = row.version + 1;
          this.q.tombstone.run(version, newRev, now, sessionId, op.id);
          count -= 1;
          bytes -= Buffer.byteLength(row.data);
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
          const f = this.q.file.get(sessionId, op.fileId);
          const p = this.q.file.get(sessionId, op.posterFileId);
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
          this.db
            .prepare("UPDATE files SET poster_file_id = ? WHERE session_id = ? AND id = ?")
            .run(op.posterFileId, sessionId, op.fileId);
          applied.push({ ...op });
          return;
        }
        case "fileMeta": {
          const f = this.q.file.get(sessionId, op.fileId);
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
          this.db
            .prepare(
              "UPDATE files SET width = ?, height = ?, duration_ms = ? WHERE session_id = ? AND id = ?",
            )
            .run(op.width, op.height, op.durationMs ?? null, sessionId, op.fileId);
          applied.push({ ...op });
          return;
        }
      }
    });

    if (opts.atomic && rejected.length > 0)
      throw new Rollback({ pushId: push.pushId, rev: s.rev, versions: {}, rejected, ignored });

    const rev = applied.length > 0 ? newRev : s.rev;
    if (applied.length > 0)
      this.q.updateSession.run(rev, count, title, JSON.stringify(settings), now, sessionId);
    const ack: Ack = { pushId: push.pushId, rev, versions, rejected, ignored };
    this.q.insertPushLog.run(sessionId, push.pushId, rev, JSON.stringify(ack), now);
    this.trimPushLog(sessionId, now);
    const event =
      applied.length > 0
        ? { sessionId, fromRev: s.rev, rev, ops: applied, origin: opts.origin }
        : null;
    return { ack, event };
  }

  /**
   * Drops push_log rows older than the retention time and beyond the per-board
   * cap, and advances push_log_floor_rev to the highest rev removed (§3.5).
   */
  private trimPushLog(sessionId: string, now: number) {
    const cutoff = now - this.limits.pushLogMaxAgeMs;
    const victims = `SELECT rowid FROM push_log WHERE session_id = @sid AND (created_at < @cutoff OR rowid IN (
        SELECT rowid FROM push_log WHERE session_id = @sid ORDER BY rowid DESC LIMIT -1 OFFSET @max))`;
    const p = { sid: sessionId, cutoff, max: this.limits.pushLogMax };
    const top = this.db
      .prepare<typeof p, { r: number | null }>(
        `SELECT MAX(rev) AS r FROM push_log WHERE rowid IN (${victims})`,
      )
      .get(p)!.r;
    if (top === null) return;
    this.db.prepare(`DELETE FROM push_log WHERE rowid IN (${victims})`).run(p);
    this.db
      .prepare("UPDATE sessions SET push_log_floor_rev = MAX(push_log_floor_rev, ?) WHERE id = ?")
      .run(top, sessionId);
  }

  /** Atomic import (§3.6): one rev, one ack, every element validated, scene caps enforced. */
  importScene(sessionId: string, input: ImportInput, origin: ChangeOrigin): ApplyResult {
    let event: ChangesEvent | null = null;
    try {
      const ack = this.db.transaction(() => {
        this.requireSession(sessionId);
        const ops: RawOp[] = [];
        const incoming = new Set(
          input.elements
            .map((e) => (e.el as { id?: unknown } | null)?.id)
            .filter((v): v is string => typeof v === "string"),
        );
        // mirrored replays degrade replace to add (see worker/do/store.ts)
        if (input.mode === "replace" && input.mirrored !== true)
          for (const r of this.q.liveIds.all(sessionId))
            if (!incoming.has(r.id)) ops.push({ t: "del", id: r.id, baseVersion: r.version });
        for (const e of input.elements) {
          const rawId = (e.el as { id?: unknown } | null)?.id;
          const row = typeof rawId === "string" ? this.q.element.get(sessionId, rawId) : undefined;
          ops.push({ t: "put", el: e.el, idx: e.idx, baseVersion: row?.version ?? 0 });
        }
        if (input.settings !== undefined) ops.push({ t: "settings", settings: input.settings });
        const r = this.applyInTx(
          sessionId,
          { pushId: input.importId, baseRev: 0, ops },
          { origin, atomic: true },
        );
        event = r.event;
        return r.ack;
      })();
      if (event) this.events.emit("changes", event);
      return { ack, applied: true };
    } catch (e) {
      if (e instanceof Rollback) {
        if (e.ack.rejected.some((r) => r.reason === "scene_too_large"))
          throw new ServiceError(
            413,
            "scene_too_large",
            `The import would make the board larger than ${this.limits.maxElements} items or ${Math.round(this.limits.maxSceneBytes / 1048576)} MB; nothing was imported.`,
          );
        return { ack: e.ack, applied: false };
      }
      throw e;
    }
  }

  /**
   * Everything that changed after `sinceRev` (§3.6 reconnect): live elements
   * and tombstones with a newer rev, plus the settings and title. Returns null
   * when the board cannot answer exactly (older than the push-log floor, where
   * tombstones may have been purged, or ahead of the board) — the caller then
   * sends a full snapshot.
   */
  changesSince(
    sessionId: string,
    sinceRev: number,
  ): { fromRev: number; rev: number; ops: AppliedOp[]; files: StoredFile[] } | null {
    const s = this.requireSession(sessionId);
    if (sinceRev > s.rev || sinceRev < s.push_log_floor_rev) return null;
    if (sinceRev === s.rev) return { fromRev: sinceRev, rev: s.rev, ops: [], files: [] };
    const rows = this.db
      .prepare<[string, number], ElementRow>(
        "SELECT id, idx, version, rev, deleted, needs_layout, data FROM elements WHERE session_id = ? AND rev > ? ORDER BY idx, id",
      )
      .all(sessionId, sinceRev);
    // Settings carry no rev of their own (they are one small JSON column, not
    // rows), so the delta cannot tell whether they changed after `sinceRev`.
    // They are sent whenever anything changed: a few bytes per reconnect, and
    // applying unchanged settings is a no-op on the client. An unchanged board
    // (sinceRev === rev, above) sends nothing.
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
    return { fromRev: sinceRev, rev: s.rev, ops, files: this.filesFor(sessionId, ops) };
  }

  /** The stored files the given ops refer to (so another tab can show them). */
  filesFor(sessionId: string, ops: readonly AppliedOp[]): StoredFile[] {
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
      const f = this.q.file.get(sessionId, id);
      if (f) out.push(this.fileOut(sessionId, f));
    }
    return out;
  }

  // ---------------------------------------------------------------- files

  /** Stores an uploaded picture (§3.10, §7). Same bytes in the same board give the same file. */
  addFile(sessionId: string, bytes: Buffer, contentType: string | undefined): StoredFile {
    this.requireSession(sessionId);
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
    const sha = createHash("sha256").update(bytes).digest("hex");
    const existing = this.q.fileBySha.get(sessionId, sha);
    if (existing) return this.fileOut(sessionId, existing);
    const meta = isVideo
      ? videoMeta(real, bytes)
      : { ...pictureSize(bytes), durationMs: null as number | null };
    const { width, height, durationMs } = meta;
    const blobPath = path.join(this.mediaDir, sha);
    const row = this.db.transaction(() => {
      const s = this.requireSession(sessionId);
      if (s.media_bytes + bytes.length > this.limits.maxSessionMediaBytes)
        throw storageFull("this board's media limit");
      const blob = this.q.blob.get(sha);
      if (!blob && this.q.totalMedia.get()!.n + bytes.length > this.limits.maxTotalMediaBytes)
        throw storageFull("media storage limit");
      this.checkDbSize();
      if (blob) this.db.prepare("UPDATE blobs SET refs = refs + 1 WHERE sha256 = ?").run(sha);
      else
        this.db
          .prepare("INSERT INTO blobs (sha256, size, refs) VALUES (?, ?, 1)")
          .run(sha, bytes.length);
      const id = `f${randomId(12)}`;
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO files (session_id, id, mime, size, sha256, width, height, duration_ms, source, url, poster_file_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upload', NULL, NULL, ?)`,
        )
        .run(sessionId, id, real, bytes.length, sha, width, height, durationMs, now);
      this.db
        .prepare("UPDATE sessions SET media_bytes = media_bytes + ?, updated_at = ? WHERE id = ?")
        .run(bytes.length, now, sessionId);
      // written last, so a failed insert leaves no file behind; if writing fails the
      // transaction rolls back. maintenance() sweeps anything a crash leaves behind.
      if (!fs.existsSync(blobPath)) {
        const tmp = `${blobPath}.${randomId(6)}.tmp`;
        try {
          fs.writeFileSync(tmp, bytes);
          fs.renameSync(tmp, blobPath);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          throw e;
        }
      }
      return this.q.file.get(sessionId, id)!;
    })();
    return this.fileOut(sessionId, row);
  }

  /**
   * Records a remote media link (plan §6.2). The server never fetches it: the
   * row only carries the canonical https link and the type the caller states,
   * and browsers show it in the live layer. The same link in the same board
   * gives the same file.
   */
  addRemoteFile(
    sessionId: string,
    url: string,
    mime: string,
    meta: { width?: number | null; height?: number | null } = {},
  ): StoredFile {
    this.requireSession(sessionId);
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
    const existing = this.db
      .prepare<[string, string], FileRow>(
        "SELECT * FROM files WHERE session_id = ? AND sha256 = ? AND source = 'remote' LIMIT 1",
      )
      .get(sessionId, sha);
    if (existing) return this.fileOut(sessionId, existing);
    const dim = (v: number | null | undefined) =>
      typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : null;
    const row = this.db.transaction(() => {
      this.requireSession(sessionId);
      this.checkDbSize();
      const id = `f${randomId(12)}`;
      this.db
        .prepare(
          `INSERT INTO files (session_id, id, mime, size, sha256, width, height, duration_ms, source, url, poster_file_id, created_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, NULL, 'remote', ?, NULL, ?)`,
        )
        .run(sessionId, id, mime, sha, dim(meta.width), dim(meta.height), check.url, this.now());
      return this.q.file.get(sessionId, id)!;
    })();
    return this.fileOut(sessionId, row);
  }

  /** The file's row and its path on disk, for downloads. */
  fileForDownload(sessionId: string, fileId: string): { file: StoredFile; path: string } {
    this.requireSession(sessionId);
    const f = this.q.file.get(sessionId, fileId);
    if (!f || f.source !== "upload")
      throw new ServiceError(404, "file_not_found", "This file does not exist in this board.");
    return { file: this.fileOut(sessionId, f), path: path.join(this.mediaDir, f.sha256) };
  }

  // ---------------------------------------------------------------- upkeep

  /** Purges old push_log rows, old tombstones, never-used boards and (optionally) unopened boards. */
  maintenance(opts: { sessionTtlDays: number | null } = { sessionTtlDays: null }) {
    const now = this.now();
    const sids = this.db
      .prepare<[number], { session_id: string }>(
        "SELECT DISTINCT session_id FROM push_log WHERE created_at < ?",
      )
      .all(now - this.limits.pushLogMaxAgeMs);
    for (const { session_id } of sids)
      this.db.transaction(() => this.trimPushLog(session_id, now))();
    this.db
      .prepare("DELETE FROM elements WHERE deleted = 1 AND updated_at < ?")
      .run(now - this.limits.tombstoneMaxAgeMs);
    const stale = this.db
      .prepare<[number], { id: string }>(
        `SELECT id FROM sessions s WHERE created_at < ? AND rev = 0
           AND NOT EXISTS (SELECT 1 FROM files f WHERE f.session_id = s.id)`,
      )
      .all(now - 24 * 3600_000)
      .map((r) => r.id);
    if (opts.sessionTtlDays !== null) {
      const cutoff = now - opts.sessionTtlDays * 24 * 3600_000;
      for (const r of this.db
        .prepare<[number], { id: string }>(
          "SELECT id FROM sessions WHERE COALESCE(opened_at, created_at) < ?",
        )
        .all(cutoff))
        stale.push(r.id);
    }
    if (stale.length) this.deleteSessions([...new Set(stale)]);
    this.sweepOrphanMedia(now);
  }

  /** Removes media files with no blobs row (left by a crash mid-upload), older than an hour. */
  private sweepOrphanMedia(now: number) {
    const known = this.db.prepare<[string], { n: number }>(
      "SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?",
    );
    let names: string[];
    try {
      names = fs.readdirSync(this.mediaDir);
    } catch {
      return;
    }
    for (const name of names) {
      const sha = name.split(".")[0] ?? "";
      if (name === sha && known.get(sha)!.n > 0) continue;
      const file = path.join(this.mediaDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > 3600_000) fs.rmSync(file, { force: true });
      } catch {
        // gone already
      }
    }
  }
}
