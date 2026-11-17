/**
 * The browser's save path for a session board (plan §4.1, phase 2).
 *
 * The client keeps what it believes the server holds (`known`: element JSON,
 * version and layer key). A save diffs the board against it into `put`/`del`/
 * `settings` ops, refuses elements the server would reject before sending,
 * splits the ops into pushes of at most 500 ops / 1.5 MB, and sends one push
 * at a time over REST. Every unacknowledged push is kept in the pending mirror
 * with its original pushId and baseRev, so a reload can replay it safely. On
 * `pagehide` a small batch goes out with `fetch(..., { keepalive: true })`.
 */
import { assignKeys } from "../shared/keys";
import { newPushId } from "../shared/ids";
import type { Ack, Op, SceneSnapshot } from "../shared/protocol";
import type { SceneElement } from "../scene/types";
import { ApiError, type Api, type ImportBody } from "./api";
import { ENVELOPE_BYTES, KEEPALIVE_BYTES, chunkOps, jsonBytes, refuseReason } from "./chunk";
import type { MirrorBatch, PendingMirror } from "./mirror";

export type SaveStatus = "saved" | "saving" | "offline" | "gone" | "full";

export interface SyncSettings {
  viewBackgroundColor: string;
  gridEnabled: boolean;
  title: string;
}

export interface SyncHost {
  scene(): { elements: readonly SceneElement[]; settings: SyncSettings };
  /** Replaces the board with server truth, without a history step. */
  replaceElements(elements: SceneElement[]): void;
  status(s: SaveStatus): void;
  /** A warning that recent changes are not protected against a reload, or null. */
  protection(warning: string | null): void;
  notice(message: string): void;
  /** Ids moved in the layer order since the last call (a reorder hint). */
  takeLayerMoves(): Iterable<string>;
}

interface Known {
  el: SceneElement;
  json: string;
  version: number;
}

type QueueItem =
  | { kind: "ops"; pushId: string; baseRev: number; ops: Op[]; sent: boolean }
  | { kind: "import"; body: ImportBody; sent: boolean };

/** Largest body the import endpoint takes (server `importBodyBytes`). */
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
const DEBOUNCE_MS = 250;

const jsonCache = new WeakMap<SceneElement, string>();
const toJson = (el: SceneElement) => {
  let j = jsonCache.get(el);
  if (j === undefined) {
    j = JSON.stringify(el);
    jsonCache.set(el, j);
  }
  return j;
};

/** Applies ops to a keyed scene (used for unsent ops after a reload). */
export const applyOpsToScene = (
  elements: readonly { el: SceneElement; idx: string }[],
  ops: readonly Op[],
): { el: SceneElement; idx: string }[] => {
  const byId = new Map(elements.map((e) => [e.el.id, e]));
  for (const op of ops) {
    if (op.t === "put") byId.set(op.el.id, { el: op.el, idx: op.idx });
    else if (op.t === "del") byId.delete(op.id);
  }
  return [...byId.values()].sort((a, b) =>
    a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : a.el.id < b.el.id ? -1 : 1,
  );
};

/**
 * Replays the mirrored pushes of a session in their original order, with
 * their original pushIds and baseRevs and `mirrored: true`. Network trouble
 * throws (the mirror is kept); a refused batch is skipped. Returns the ops
 * that were never sent, to be applied over the fresh snapshot.
 */
export const replayMirror = async (api: Api, mirror: PendingMirror): Promise<Op[]> => {
  const data = mirror.read();
  if (!data) return [];
  for (const b of data.batches) {
    try {
      await api.push(mirror.sessionId, {
        pushId: b.pushId,
        baseRev: b.baseRev,
        ops: b.ops,
        mirrored: true,
      });
    } catch (e) {
      if (e instanceof ApiError && e.retry) throw e;
      // refused for good: nothing to replay
    }
  }
  return data.unsent;
};

export class SyncClient {
  private known = new Map<string, Known>();
  private tomb = new Map<string, number>();
  private keys = new Map<string, string>();
  private order: { id: string }[] = [];
  private settings: SyncSettings;
  private rev = 0;
  private queue: QueueItem[] = [];
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 0;
  private lastStatus: SaveStatus | null = null;
  private lastProtection: string | null = null;
  private stopped: SaveStatus | null = null;
  private offline = false;
  private moves = new Set<string>();
  private resyncIds = new Set<string>();
  private resyncAll = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    private readonly api: Api,
    private readonly host: SyncHost,
    private readonly mirror: PendingMirror,
    snapshot: SceneSnapshot,
  ) {
    this.settings = { viewBackgroundColor: "", gridEnabled: false, title: "" };
    this.load(snapshot);
  }

  /** Takes a snapshot as the server's state. */
  load(s: SceneSnapshot) {
    this.known.clear();
    this.keys.clear();
    this.tomb.clear();
    for (const e of s.elements) {
      this.known.set(e.el.id, { el: e.el, json: toJson(e.el), version: e.version });
      this.keys.set(e.el.id, e.idx);
    }
    for (const t of s.tombstones) this.tomb.set(t.id, t.version);
    this.order = s.elements.map((e) => ({ id: e.el.id }));
    this.settings = {
      viewBackgroundColor: s.settings.viewBackgroundColor ?? "",
      gridEnabled: s.settings.gridEnabled ?? false,
      title: s.title,
    };
    this.rev = s.rev;
  }

  /** The layer key the server has for an element (tests and import). */
  keyOf(id: string) {
    return this.keys.get(id);
  }

  /** Call after every board change: saves after a short pause. */
  schedule() {
    if (this.stopped) return;
    for (const id of this.host.takeLayerMoves()) this.moves.add(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    this.updateStatus();
  }

  /** Diffs the board against the server state and queues the changes. */
  flush(opts: { keepalive?: boolean; exclude?: ReadonlySet<string> } = {}) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const ops = this.diff(opts.exclude);
    if (ops.length) {
      let rest = ops;
      if (opts.keepalive && !this.inflight && !this.queue.length) {
        const first = chunkOps(ops, 500, KEEPALIVE_BYTES - ENVELOPE_BYTES)[0];
        this.enqueue(first);
        const sent = new Set(first);
        rest = ops.filter((o) => !sent.has(o));
      }
      for (const chunk of chunkOps(rest)) this.enqueue(chunk);
    }
    this.writeMirror();
    this.pump(opts.keepalive === true);
    this.updateStatus();
  }

  /** Flushes now and resolves once everything queued is acknowledged. */
  settle(): Promise<void> {
    this.flush();
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  isIdle() {
    return !this.timer && !this.inflight && !this.queue.length;
  }

  /** pagehide: send what fits in a keepalive request, mirror the rest. */
  pageHide() {
    this.flush({ keepalive: true });
  }

  /**
   * Sends elements already placed on the board (by one local undo step) as
   * one atomic import. `add` keeps the rest of the board; `replace` makes the
   * imported elements the whole board.
   */
  queueImport(
    mode: "replace" | "add",
    ids: ReadonlySet<string>,
    settings?: ImportBody["settings"],
  ) {
    if (this.stopped) return false;
    if (mode === "add") this.flush({ exclude: ids });
    const { elements } = this.host.scene();
    const imported = elements.filter((e) => ids.has(e.id));
    const refused: SceneElement[] = [];
    const good: SceneElement[] = [];
    for (const e of imported) (refuseReason(e) ? refused : good).push(e);
    const goodIds = new Set(good.map((e) => e.id));
    const base = mode === "replace" ? [] : this.order;
    const nextOrder = elements.filter(
      (e) => (mode === "add" && this.known.has(e.id)) || goodIds.has(e.id),
    );
    const keys = assignKeys(base, nextOrder, mode === "replace" ? new Map() : this.keys);
    const body: ImportBody = {
      importId: newPushId(),
      mode,
      elements: good.map((el) => ({ el, idx: keys.get(el.id)! })),
      ...(settings ? { settings } : {}),
    };
    if (jsonBytes(body) > MAX_IMPORT_BYTES) {
      this.dropLocal(ids);
      this.host.notice(
        `This board is too large to import (over ${MAX_IMPORT_BYTES / 1024 / 1024} MB). Nothing was imported.`,
      );
      return false;
    }
    if (refused.length) {
      this.dropLocal(new Set(refused.map((e) => e.id)));
      this.host.notice(
        `${refused.length} item${refused.length === 1 ? " was" : "s were"} too large or invalid and left out.`,
      );
    }
    if (mode === "replace") {
      for (const [id, k] of this.known) this.tomb.set(id, k.version + 1);
      this.known.clear();
      this.keys.clear();
      if (settings) Object.assign(this.settings, settings);
    }
    for (const e of body.elements) {
      const base = this.known.get(e.el.id)?.version ?? 0;
      this.known.set(e.el.id, { el: e.el, json: toJson(e.el), version: base + 1 });
      this.keys.set(e.el.id, e.idx);
      this.tomb.delete(e.el.id);
    }
    this.order = this.host.scene().elements.filter((e) => this.known.has(e.id));
    this.queue.push({ kind: "import", body, sent: false });
    this.pump(false);
    this.updateStatus();
    return true;
  }

  /** Stops timers (the app is going away). */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  // ---------------------------------------------------------------- internals

  private diff(exclude?: ReadonlySet<string>): Op[] {
    const { elements: all, settings } = this.host.scene();
    for (const id of this.host.takeLayerMoves()) this.moves.add(id);
    const elements = exclude ? all.filter((e) => !exclude.has(e.id)) : all;
    const nextKeys = assignKeys(
      this.order,
      elements,
      this.keys,
      this.moves.size ? { kind: "move", ids: this.moves } : undefined,
    );
    this.moves = new Set();
    const ops: Op[] = [];
    const refused: { el: SceneElement; reason: string }[] = [];
    const present = new Set<string>();
    for (const el of elements) {
      present.add(el.id);
      const k = this.known.get(el.id);
      const idx = nextKeys.get(el.id)!;
      const json = toJson(el);
      const same = k !== undefined && k.json === json;
      if (same && this.keys.get(el.id) === idx) continue;
      if (!same) {
        const reason = refuseReason(el);
        if (reason) {
          refused.push({ el, reason });
          continue;
        }
      }
      const baseVersion = k ? k.version : (this.tomb.get(el.id) ?? 0);
      ops.push({ t: "put", el, idx, baseVersion });
      this.known.set(el.id, { el, json, version: baseVersion + 1 });
      this.keys.set(el.id, idx);
      this.tomb.delete(el.id);
    }
    for (const [id, k] of [...this.known]) {
      if (present.has(id) || exclude?.has(id)) continue;
      ops.push({ t: "del", id, baseVersion: k.version });
      this.known.delete(id);
      this.keys.delete(id);
      this.tomb.set(id, k.version + 1);
    }
    const changed: { viewBackgroundColor?: string; gridEnabled?: boolean; title?: string } = {};
    if (settings.viewBackgroundColor !== this.settings.viewBackgroundColor)
      changed.viewBackgroundColor = settings.viewBackgroundColor;
    if (settings.gridEnabled !== this.settings.gridEnabled)
      changed.gridEnabled = settings.gridEnabled;
    if (settings.title !== this.settings.title) changed.title = settings.title;
    if (Object.keys(changed).length) {
      ops.push({ t: "settings", settings: changed });
      this.settings = { ...settings };
    }
    this.order = elements.filter((e) => this.known.has(e.id));
    if (refused.length) this.refuse(refused);
    return ops;
  }

  /** Puts refused elements back to the saved version (or removes new ones). */
  private refuse(refused: { el: SceneElement; reason: string }[]) {
    const byId = new Map(refused.map((r) => [r.el.id, r]));
    const { elements } = this.host.scene();
    const next: SceneElement[] = [];
    for (const el of elements) {
      if (!byId.has(el.id)) next.push(el);
      else {
        const k = this.known.get(el.id);
        if (k) next.push(k.el);
      }
    }
    this.host.replaceElements(next);
    const r = refused[0];
    this.host.notice(
      refused.length === 1
        ? `That change could not be saved (${r.reason}), so it was undone.`
        : `${refused.length} changes could not be saved (for example ${r.reason}), so they were undone.`,
    );
  }

  private dropLocal(ids: ReadonlySet<string>) {
    const { elements } = this.host.scene();
    this.host.replaceElements(elements.filter((e) => !ids.has(e.id)));
  }

  private enqueue(ops: Op[]) {
    this.queue.push({ kind: "ops", pushId: newPushId(), baseRev: this.rev, ops, sent: false });
  }

  private writeMirror() {
    const batches: MirrorBatch[] = [];
    const unsent: Op[] = [];
    for (const q of this.queue) {
      if (q.kind !== "ops") continue;
      if (q.sent) batches.push({ pushId: q.pushId, baseRev: q.baseRev, ops: q.ops });
      else unsent.push(...q.ops);
    }
    const r = this.mirror.write(batches, unsent);
    const warning = !r.ok
      ? `Changes made now are not protected against a reload: ${r.reason}.`
      : !r.complete
        ? "Some older unsaved changes are no longer protected against a reload."
        : null;
    if (warning !== this.lastProtection) {
      this.lastProtection = warning;
      this.host.protection(warning);
    }
  }

  private pump(keepalive: boolean) {
    if (this.inflight || !this.queue.length || this.stopped || this.retryTimer) return;
    const item = this.queue[0];
    this.inflight = true;
    if (!item.sent) {
      item.sent = true;
      // mirrored with its pushId before it leaves
      this.writeMirror();
    }
    const req =
      item.kind === "import"
        ? this.api.importScene(this.sessionId, item.body)
        : this.api.push(
            this.sessionId,
            { pushId: item.pushId, baseRev: item.baseRev, ops: item.ops },
            { keepalive: keepalive && jsonBytes(item.ops) <= KEEPALIVE_BYTES },
          );
    req.then(
      (ack) => this.onAck(item, ack),
      (err: unknown) => this.onError(item, err),
    );
  }

  private onAck(item: QueueItem, ack: Ack) {
    this.inflight = false;
    this.offline = false;
    this.backoff = 0;
    this.rev = Math.max(this.rev, ack.rev);
    const puts =
      item.kind === "import"
        ? item.body.elements.map((e) => e.el)
        : item.ops.flatMap((o) => (o.t === "put" ? [o.el] : []));
    const rejected = new Set(ack.rejected.map((r) => r.id));
    for (const el of puts) {
      const v = ack.versions[el.id];
      const k = this.known.get(el.id);
      if (v !== undefined && k && k.el === el && !rejected.has(el.id)) k.version = v;
    }
    if (item.kind === "ops") {
      for (const o of item.ops)
        if (o.t === "del" && ack.versions[o.id] !== undefined && !this.known.has(o.id))
          this.tomb.set(o.id, ack.versions[o.id]);
    } else if (item.body.mode === "replace") {
      for (const [id, v] of Object.entries(ack.versions))
        if (!this.known.has(id) && this.tomb.has(id)) this.tomb.set(id, v);
    }
    if (ack.rejected.length) {
      const r = ack.rejected[0];
      if (item.kind === "import") {
        this.resyncAll = true;
        this.host.notice(
          `The import was refused (${r.message ?? r.reason}), so nothing was imported.`,
        );
      } else {
        for (const id of rejected) this.resyncIds.add(id);
        this.host.notice(
          `${ack.rejected.length === 1 ? "A change was" : `${ack.rejected.length} changes were`} refused by the server (${r.message ?? r.reason}) and undone.`,
        );
      }
    }
    this.queue.shift();
    this.afterSettled();
  }

  private onError(item: QueueItem, err: unknown) {
    this.inflight = false;
    const e = err instanceof ApiError ? err : new ApiError(0, "network", String(err));
    if (e.retry) {
      this.offline = true;
      this.backoff = Math.min(15000, this.backoff ? this.backoff * 2 : 1000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.pump(false);
      }, this.backoff);
      this.updateStatus();
      return;
    }
    if (e.status === 404) {
      this.stopped = "gone";
      this.host.notice("This board no longer exists on the server, so changes are not saved.");
    } else if (e.status === 507) {
      this.stopped = "full";
      this.host.notice(`The server could not save: ${e.message}`);
    } else {
      // refused for good (for example too large): drop it and take the server's version
      this.queue.shift();
      if (item.kind === "import") this.resyncAll = true;
      else
        for (const o of item.ops)
          if (o.t === "put") this.resyncIds.add(o.el.id);
          else if (o.t === "del") this.resyncIds.add(o.id);
      this.host.notice(`A change could not be saved: ${e.message}`);
    }
    this.afterSettled();
  }

  private afterSettled() {
    this.writeMirror();
    if (this.queue.length) this.pump(false);
    else if (this.resyncAll || this.resyncIds.size) void this.resync();
    this.updateStatus();
  }

  /** Takes the server's version of refused elements. */
  private async resync() {
    const all = this.resyncAll;
    const ids = this.resyncIds;
    this.resyncAll = false;
    this.resyncIds = new Set();
    let snap: SceneSnapshot;
    try {
      snap = await this.api.scene(this.sessionId);
    } catch {
      return;
    }
    const server = new Map(snap.elements.map((e) => [e.el.id, e]));
    const { elements } = this.host.scene();
    if (all) {
      this.load(snap);
      this.host.replaceElements(snap.elements.map((e) => e.el));
      this.updateStatus();
      return;
    }
    const next: SceneElement[] = [];
    for (const el of elements) {
      if (!ids.has(el.id)) next.push(el);
      else if (server.has(el.id)) next.push(server.get(el.id)!.el);
    }
    for (const id of ids) {
      const s = server.get(id);
      if (s) {
        this.known.set(id, { el: s.el, json: toJson(s.el), version: s.version });
        this.keys.set(id, s.idx);
        if (!elements.some((e) => e.id === id)) next.push(s.el);
      } else {
        this.known.delete(id);
        this.keys.delete(id);
      }
    }
    this.rev = Math.max(this.rev, snap.rev);
    this.host.replaceElements(next);
    this.order = next.filter((e) => this.known.has(e.id));
    this.updateStatus();
  }

  private updateStatus() {
    const s: SaveStatus =
      this.stopped ??
      (this.offline ? "offline" : this.isIdle() && !this.retryTimer ? "saved" : "saving");
    if (s !== this.lastStatus) {
      this.lastStatus = s;
      this.host.status(s);
    }
    if (this.isIdle() && this.idleWaiters.length) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((f) => f());
    }
  }
}
