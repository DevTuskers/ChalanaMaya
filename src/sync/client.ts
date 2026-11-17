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
 *
 * Live sync (phase 3): while a socket is attached, pushes go over it and the
 * server's `changes` from other tabs and agents come back through `receive`.
 * Remote ops are applied to the current board by id (Rule B), skipping ids
 * that are busy here (changed locally and not yet sent, or in a push not yet
 * acknowledged); a skipped put is kept and applied after the ack if the
 * server's version is newer than ours. Derived fields (connector ends, label
 * boxes) are recomputed after every remote change and kept only for busy
 * elements (Rule F), so tabs converge without echo loops.
 */
import { assignKeys } from "../shared/keys";
import { newPushId } from "../shared/ids";
import type {
  Ack,
  ClientMessage,
  Op,
  RemoteOp,
  SceneSnapshot,
  ServerMessage,
  StoredFile,
} from "../shared/protocol";
import type { RemoteChange } from "../scene/rebase";
import { applyChange } from "../scene/rebase";
import { finalizeScene } from "../scene/scene";
import { validateStoredElement } from "../shared/validate";
import type { LinearElement, SceneElement } from "../scene/types";
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
  /** the live socket came up (true) or went down (false): other tabs' changes pause */
  live?(on: boolean): void;
  /** A warning that recent changes are not protected against a reload, or null. */
  protection(warning: string | null): void;
  notice(message: string): void;
  /** Ids moved in the layer order since the last call (a reorder hint). */
  takeLayerMoves(): Iterable<string>;
  /**
   * Applies a remote change (Rule B): `elements` is the new board, `change`
   * what the server sent (for the history's remote log). Without it the board
   * is replaced like `replaceElements`.
   */
  applyRemote?(
    elements: SceneElement[],
    change: RemoteChange,
    settings: Partial<SyncSettings> | null,
    files: readonly StoredFile[],
  ): void;
}

/** Sends client messages on the live socket. */
export interface Link {
  send(msg: ClientMessage): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

const MAX_REPAIR_STREAK = 3;
const TEXT_DERIVED = new Set(["x", "y", "width", "height"]);
const LINEAR_DERIVED = new Set(["x", "y", "width", "height", "points"]);
const CONTAINER_DERIVED = new Set(["height"]);

type RemotePut = Extract<RemoteOp, { t: "put" }>;

/** The notice when a change was refused because someone removed the item meanwhile. */
export const REMOVED_NOTICE = "Someone removed that item, so your change was not kept.";

interface Known {
  el: SceneElement;
  json: string;
  version: number;
}

type QueueItem =
  | {
      kind: "ops";
      pushId: string;
      baseRev: number;
      ops: Op[];
      sent: boolean;
      /** A batch from the mirror of an earlier visit, resent with `mirrored: true`. */
      mirrored?: boolean;
    }
  | { kind: "import"; body: ImportBody; sent: boolean };

/** Largest body the import endpoint takes (server `importBodyBytes`). */
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
export const THROTTLE_MS = 250;

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
 * Rule B / §3.11: every element that arrives from the server is checked with
 * the strict stored-element rules before it is applied. The server already
 * refuses such elements, so this only guards against a buggy or hostile
 * server; failures are counted and reported once in the console.
 */
export class RemoteGuard {
  invalid = 0;
  private warned = false;

  ok(el: unknown): el is SceneElement {
    const v = validateStoredElement(el);
    if (v.ok) return true;
    this.invalid += 1;
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `ChalanaMaya: an item from the server was invalid and not shown (${v.path || "element"}: ${v.reason}). Later ones are counted silently.`,
      );
    }
    return false;
  }

  /** The snapshot without elements that fail validation. */
  snapshot<T extends Pick<SceneSnapshot, "elements">>(s: T): T {
    const elements = s.elements.filter((e) => this.ok(e.el));
    return elements.length === s.elements.length ? s : { ...s, elements };
  }
}

export interface ReplayResult {
  /** Ops that were never sent; applied over the snapshot and saved normally. */
  unsent: Op[];
  /**
   * Batches the server could not take yet (network trouble, 429 or 5xx), from
   * the first failure on, in order. The sync client resends them with their
   * pushIds and baseRevs.
   */
  pending: MirrorBatch[];
  /** Changes the server did not keep (stale replays and refused ops). */
  lost: number;
}

/** The notice shown when a replay could not keep everything (plan §3.7 step 3). */
export const LOST_NOTICE =
  "Some changes from your last visit were not kept, because the board was changed since then.";

const countLost = (ack: Ack) =>
  ack.rejected.length + ack.ignored.filter((i) => i.reason === "stale_replay").length;

/**
 * Replays the mirrored pushes of a session in their original order, with
 * their original pushIds and baseRevs and `mirrored: true`. A retryable
 * failure (network, 429, 5xx) stops the replay without throwing: that batch
 * and the later ones are returned as `pending`, so the board still opens and
 * the sync client resends them. A batch refused for good is dropped. The
 * mirror is rewritten to what is still pending, so acknowledged batches are
 * not replayed again on the next load.
 */
export const replayMirror = async (api: Api, mirror: PendingMirror): Promise<ReplayResult> => {
  const data = mirror.read();
  if (!data) return { unsent: [], pending: [], lost: 0 };
  const pending: MirrorBatch[] = [];
  let lost = 0;
  for (const b of data.batches) {
    if (pending.length) {
      pending.push(b);
      continue;
    }
    try {
      const ack = await api.push(mirror.sessionId, {
        pushId: b.pushId,
        baseRev: b.baseRev,
        ops: b.ops,
        mirrored: true,
      });
      lost += countLost(ack);
    } catch (e) {
      if (!(e instanceof ApiError) || e.retry) pending.push(b);
      else lost += b.ops.length; // refused for good: nothing to replay
    }
  }
  mirror.write(pending, data.unsent);
  return { unsent: data.unsent, pending, lost };
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
  /** True while a remote change is being applied to the board. */
  private applying = false;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private backoff = 0;
  private lastStatus: SaveStatus | null = null;
  private lastProtection: string | null = null;
  private stopped: SaveStatus | null = null;
  private offline = false;
  private moves = new Set<string>();
  private resyncIds = new Set<string>();
  private resyncAll = false;
  private idleWaiters: (() => void)[] = [];
  /** the live socket, while connected */
  private link: Link | null = null;
  /** the socket was lost (or never came up): the chip says offline */
  /** last rev seen in order on the socket (for `hello` after a reconnect) */
  private liveRev = 0;
  private waiting = new Map<string, { resolve(a: Ack): void; reject(e: unknown): void }>();
  /** ids in queued or unacknowledged pushes, with how many pushes hold them */
  private busy = new Map<string, number>();
  /** remote puts skipped because the id was busy; applied after the ack when newer */
  private deferred = new Map<string, RemotePut>();
  /** busy ids whose remote delete was already announced (the put's reject is then quiet) */
  private removedNoticed = new Set<string>();
  /** Rule F: consecutive repairs of an element no local edit is behind. */
  private repairStreak = new Map<string, number>();
  /** settings fields in queued or unacknowledged pushes */
  private busySettings = new Map<string, number>();
  private readonly timers: Timers;
  readonly clientId = newPushId();
  /** remote elements that failed validation (Rule B) */
  readonly guard: RemoteGuard;

  constructor(
    readonly sessionId: string,
    private readonly api: Api,
    private readonly host: SyncHost,
    private readonly mirror: PendingMirror,
    snapshot: SceneSnapshot,
    pending: readonly MirrorBatch[] = [],
    opts: { timers?: Timers; guard?: RemoteGuard } = {},
  ) {
    this.timers = opts.timers ?? realTimers;
    this.guard = opts.guard ?? new RemoteGuard();
    this.settings = { viewBackgroundColor: "", gridEnabled: false, title: "" };
    this.load(snapshot);
    this.adoptPending(pending);
  }

  /**
   * Takes batches a replay could not deliver (the board already shows them
   * over the snapshot): they are queued as sent, with their original pushIds
   * and baseRevs, and resent with back-off. The known state assumes they are
   * applied, so the board does not diff into duplicate ops.
   */
  private adoptPending(pending: readonly MirrorBatch[]) {
    if (!pending.length) return;
    for (const b of pending) {
      for (const op of b.ops) {
        if (op.t === "put") {
          this.known.set(op.el.id, { el: op.el, json: toJson(op.el), version: op.baseVersion + 1 });
          this.keys.set(op.el.id, op.idx);
          this.tomb.delete(op.el.id);
        } else if (op.t === "del") {
          this.known.delete(op.id);
          this.keys.delete(op.id);
          this.tomb.set(op.id, op.baseVersion + 1);
        } else if (op.t === "settings") {
          const s = op.settings;
          if (s.viewBackgroundColor !== undefined)
            this.settings.viewBackgroundColor = s.viewBackgroundColor;
          if (s.gridEnabled !== undefined) this.settings.gridEnabled = s.gridEnabled;
          if (s.title !== undefined) this.settings.title = s.title;
        }
      }
      this.push({
        kind: "ops",
        pushId: b.pushId,
        baseRev: b.baseRev,
        ops: b.ops,
        sent: true,
        mirrored: true,
      });
    }
    const order = [...this.keys].sort((a, b) =>
      a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1,
    );
    this.order = order.map(([id]) => ({ id }));
    // the server could not be reached while the board was opening
    this.offline = true;
  }

  /** Takes a snapshot as the server's state. */
  load(snap: SceneSnapshot) {
    const s = this.guard.snapshot(snap);
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
    this.liveRev = s.rev;
  }

  /** The layer key the server has for an element (tests and import). */
  keyOf(id: string) {
    return this.keys.get(id);
  }

  /**
   * Call after every board change. A throttle, not a debounce: the first
   * change starts a 250 ms timer and later changes ride along, so a long drag
   * is pushed and mirrored at most every 250 ms instead of only when the
   * pointer pauses. A committed step calls `flush()` right away.
   */
  schedule() {
    if (this.stopped) return;
    if (this.applying) return;
    for (const id of this.host.takeLayerMoves()) this.moves.add(id);
    this.timer ??= this.timers.setTimeout(() => this.flush(), THROTTLE_MS);
    this.updateStatus();
  }

  /** Diffs the board against the server state and queues the changes. */
  flush(opts: { keepalive?: boolean; exclude?: ReadonlySet<string> } = {}) {
    if (this.timer) this.timers.clearTimeout(this.timer);
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
    this.push({ kind: "import", body, sent: false });
    this.pump(false);
    this.updateStatus();
    return true;
  }

  /** Stops timers (the app is going away). */
  dispose() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  // ---------------------------------------------------------------- live sync

  /** The first message on a new socket: who we are and the last rev we saw. */
  hello(): ClientMessage {
    return { type: "hello", clientId: this.clientId, sinceRev: this.liveRev };
  }

  /**
   * A socket is open (hello already sent). Unacknowledged pushes are resent
   * with their pushIds; the server answers a repeat with the stored ack.
   */
  attach(link: Link) {
    this.link = link;
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = 0;
    this.host.live?.(true);
    this.pump(false);
    this.updateStatus();
  }

  /** The socket closed: pushes waiting for an ack are retried (same pushId). */
  detach() {
    this.link = null;
    const w = [...this.waiting.values()];
    this.waiting.clear();
    for (const p of w) p.reject(new ApiError(0, "network", "the connection was lost"));
    this.host.live?.(false);
    this.updateStatus();
  }

  get connected() {
    return this.link !== null;
  }

  /** A message from the server on the socket. */
  receive(msg: ServerMessage) {
    switch (msg.type) {
      case "ack": {
        this.liveRev = Math.max(this.liveRev, msg.rev);
        const w = this.waiting.get(msg.pushId);
        if (w) {
          this.waiting.delete(msg.pushId);
          const ack: Partial<typeof msg> = { ...msg };
          delete ack.type;
          w.resolve(ack as Ack);
        }
        return;
      }
      case "error": {
        const w = msg.pushId ? this.waiting.get(msg.pushId) : undefined;
        if (w) {
          this.waiting.delete(msg.pushId!);
          w.reject(new ApiError(msg.status, msg.code, msg.message));
        } else if (msg.status === 404) {
          this.stopped = "gone";
          this.host.notice("This board no longer exists on the server, so changes are not saved.");
          this.updateStatus();
        }
        return;
      }
      case "pong":
        return;
      case "snapshot": {
        this.liveRev = Math.max(this.liveRev, msg.rev);
        this.rev = Math.max(this.rev, msg.rev);
        const ops: RemoteOp[] = [
          { t: "settings", settings: { ...msg.settings, title: msg.title } },
        ];
        const present = new Set<string>();
        for (const e of msg.elements) {
          // an invalid element is neither shown nor deleted here
          present.add((e.el as { id?: string })?.id ?? "");
          if (!this.guard.ok(e.el)) continue;
          ops.push({
            t: "put",
            el: e.el,
            idx: e.idx,
            version: e.version,
            needsLayout: e.needsLayout,
          });
        }
        const tombs = new Map(msg.tombstones.map((t) => [t.id, t.version]));
        for (const [id, k] of this.known)
          if (!present.has(id) && !this.busy.has(id))
            ops.push({ t: "del", id, version: tombs.get(id) ?? k.version + 1 });
        this.applyRemote(ops, msg.files);
        this.updateStatus();
        return;
      }
      case "changes": {
        this.liveRev = Math.max(this.liveRev, msg.rev);
        this.rev = Math.max(this.rev, msg.rev);
        this.applyRemote(msg.ops, msg.files ?? []);
        this.updateStatus();
        return;
      }
    }
  }

  /** True when the id has local changes the server has not acknowledged. */
  isBusy(id: string) {
    if (this.busy.has(id)) return true;
    const el = this.host.scene().elements.find((e) => e.id === id);
    return this.isDirty(id, el);
  }

  /**
   * True when the board's element differs from the confirmed one only in
   * fields other elements derive (a container's height from its label, a
   * label's box, a bound connector's path): such an element takes remote
   * edits, and Rule F recomputes the derived fields afterwards.
   */
  private derivedOnly(el: SceneElement | undefined, id: string) {
    const k = this.known.get(id);
    if (!el || !k) return false;
    const fields =
      el.type === "text" && el.containerId
        ? TEXT_DERIVED
        : (el.type === "arrow" || el.type === "line") &&
            ((el as LinearElement).startBinding || (el as LinearElement).endBinding)
          ? LINEAR_DERIVED
          : CONTAINER_DERIVED;
    const a = el as unknown as Record<string, unknown>;
    const b = k.el as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (!fields.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
    return true;
  }

  private isDirty(id: string, el: SceneElement | undefined) {
    const k = this.known.get(id);
    return el ? !k || toJson(el) !== k.json : k !== undefined;
  }

  /**
   * Rule B + Rule F: applies remote ops to the current board by id. Busy ids
   * are skipped in the board (their confirmed state still moves forward);
   * then derived fields are recomputed for the touched ids and kept only for
   * elements that are busy here, which then go out as ordinary puts.
   */
  applyRemote(ops: readonly RemoteOp[], files: readonly StoredFile[] = []) {
    if (this.stopped === "gone") return;
    const { elements, settings: local } = this.host.scene();
    const byId = new Map<string, SceneElement>();
    for (const e of elements) byId.set(e.id, e);
    const dirty = new Map<string, boolean>();
    const busyNow = (id: string) => {
      if (this.busy.has(id)) return true;
      let d = dirty.get(id);
      if (d === undefined) dirty.set(id, (d = this.isDirty(id, byId.get(id))));
      return d;
    };
    const upserts: SceneElement[] = [];
    const deletes: string[] = [];
    const keys = new Map<string, string>();
    const log: { upserts: SceneElement[]; deletes: string[]; keys: Map<string, string> } = {
      upserts: [],
      deletes: [],
      keys: new Map(),
    };
    const touched = new Set<string>();
    const layout: string[] = [];
    let settings: Partial<SyncSettings> | null = null;
    let lostEdit = false;
    for (const op of ops) {
      if (op.t === "put") {
        if (!this.guard.ok(op.el)) continue;
        const id = op.el.id;
        const t = this.tomb.get(id);
        if (t !== undefined && t >= op.version) continue; // we know of a later delete
        touched.add(id);
        if (this.busy.has(id)) {
          const d = this.deferred.get(id);
          if (!d || d.version < op.version) this.deferred.set(id, op);
          continue;
        }
        const k = this.known.get(id);
        if (k && k.version > op.version) continue; // older than what we have
        const json0 = toJson(op.el);
        if (k && k.json === json0 && this.keys.get(id) === op.idx) {
          // our own write coming back (a REST push or import while the socket was up)
          k.version = Math.max(k.version, op.version);
          continue;
        }
        const wasDirty = busyNow(id) && !this.derivedOnly(byId.get(id), id);
        const prevKey = this.keys.get(id);
        const json = json0;
        this.known.set(id, { el: op.el, json, version: op.version });
        this.keys.set(id, op.idx);
        this.tomb.delete(id);
        log.upserts.push(op.el);
        log.keys.set(id, op.idx);
        // a local edit not sent yet wins: it goes out with this version as its base
        if (wasDirty) continue;
        const cur = byId.get(id);
        if (op.needsLayout) layout.push(id);
        if (cur && toJson(cur) === json && prevKey === op.idx) continue;
        upserts.push(op.el);
        if (!cur || prevKey !== op.idx) keys.set(id, op.idx);
      } else if (op.t === "del") {
        const k = this.known.get(op.id);
        if (k && !this.busy.has(op.id) && k.version >= op.version) continue;
        if (!k && !byId.has(op.id) && this.tomb.has(op.id)) {
          // gone here already (our own delete coming back): nothing to replay on undo
          this.tomb.set(op.id, Math.max(op.version, this.tomb.get(op.id)!));
          this.deferred.delete(op.id);
          continue;
        }
        touched.add(op.id);
        // Deleting wins over local edits at once (plan §3.7, documented
        // deviation): the item leaves the board now instead of after its
        // refused put comes back, so a drag cannot show it a moment longer.
        // The local edit is lost either way; the notice says so.
        if (byId.has(op.id) && busyNow(op.id)) {
          lostEdit = true;
          this.removedNoticed.add(op.id);
        }
        this.known.delete(op.id);
        this.keys.delete(op.id);
        this.deferred.delete(op.id);
        this.tomb.set(op.id, Math.max(op.version, this.tomb.get(op.id) ?? 0));
        log.deletes.push(op.id);
        if (byId.has(op.id)) deletes.push(op.id);
      } else if (op.t === "settings") {
        for (const f of ["viewBackgroundColor", "gridEnabled", "title"] as const) {
          const v = op.settings[f];
          if (v === undefined || this.busySettings.has(f)) continue;
          const dirtyField = local[f] !== this.settings[f];
          (this.settings as unknown as Record<string, unknown>)[f] = v;
          if (!dirtyField && local[f] !== v)
            (settings ??= {} as Record<string, unknown>)[f] = v as never;
        }
      }
    }
    const next = applyChange(elements, { upserts, deletes, keys }, (id) => this.keys.get(id));
    let final = next;
    let repaired = false;
    if (next !== elements && touched.size) {
      final = this.repair(next, touched, busyNow);
      repaired = final !== next;
    }
    if (layout.length) final = this.layoutCorrection(final, layout);
    const changed =
      final !== elements || log.upserts.length || log.deletes.length || settings || files.length;
    if (changed) {
      // nothing to send for a remote change, so a watching tab does not flash "Saving"
      this.applying = true;
      try {
        if (this.host.applyRemote) this.host.applyRemote(final, log, settings, files);
        else if (final !== elements) this.host.replaceElements(final);
      } finally {
        this.applying = false;
      }
    }
    this.order = final.filter((e) => this.known.has(e.id));
    if (repaired) this.schedule();
    if (lostEdit) this.host.notice(REMOVED_NOTICE);
  }

  /** Rule F: recompute derived fields after a remote change; keep them for busy elements only. */
  private repair(
    next: SceneElement[],
    touched: ReadonlySet<string>,
    busyNow: (id: string) => boolean,
  ): SceneElement[] {
    const fin = finalizeScene(next, touched);
    if (fin === next) return next;
    const finById = new Map(fin.map((e) => [e.id, e]));
    const busyLabelHosts = new Set<string>();
    for (const e of next)
      if (e.type === "text" && e.containerId && busyNow(e.id)) busyLabelHosts.add(e.containerId);
    const present = new Set(next.map((e) => e.id));
    // a reference to an item removed meanwhile is cleared the same way in every tab
    const dangling = (el: SceneElement) => {
      const l = el as Partial<LinearElement> & { containerId?: string | null };
      return (
        (l.startBinding && !present.has(l.startBinding.elementId)) ||
        (l.endBinding && !present.has(l.endBinding.elementId)) ||
        (l.containerId && !present.has(l.containerId))
      );
    };
    let any = false;
    const out = next.map((el) => {
      const f = finById.get(el.id);
      if (!f || f === el) {
        if (touched.has(el.id)) this.repairStreak.delete(el.id);
        return el;
      }
      if (busyNow(el.id) || busyLabelHosts.has(el.id) || dangling(el)) {
        any = true;
        return f;
      }
      // A remote change to what this element depends on (the other end of a
      // connector, a label's box or path) and not to the element itself: its
      // writer could not have finalised it, so the repair is always kept.
      if (!touched.has(el.id)) {
        this.repairStreak.delete(el.id);
        any = true;
        return f;
      }
      // The element itself arrived with stale derived fields (two tabs each
      // moved one end, or one moved a box while the other restyled its label):
      // every tab computes the same repair, so sending it converges. A tab
      // whose repair keeps being overwritten (different text metrics) stops
      // after a few rounds instead of fighting.
      const streak = this.repairStreak.get(el.id) ?? 0;
      if (streak < MAX_REPAIR_STREAK) {
        this.repairStreak.set(el.id, streak + 1);
        any = true;
        return f;
      }
      return el;
    });
    return any ? out : next;
  }

  /**
   * The `needs_layout` correction (§3.6): a text the server laid out with
   * estimated metrics is measured here and sent back as a layout-only put.
   */
  private layoutCorrection(scene: SceneElement[], ids: readonly string[]): SceneElement[] {
    const fin = finalizeScene(scene, ids);
    const finById = new Map(fin.map((e) => [e.id, e]));
    const want = new Set(ids);
    for (const id of ids) {
      const el = finById.get(id);
      if (el && el.type === "text" && el.containerId) want.add(el.containerId);
    }
    const ops: Op[] = [];
    const out = scene.map((el) => {
      if (!want.has(el.id)) return el;
      const f = finById.get(el.id) ?? el;
      const k = this.known.get(el.id);
      if (!k) return el;
      if (f === el && !ids.includes(el.id)) return el;
      ops.push({
        t: "put",
        el: f,
        idx: this.keys.get(el.id)!,
        baseVersion: k.version,
        layout: true,
      });
      this.known.set(el.id, { el: f, json: toJson(f), version: k.version + 1 });
      return f;
    });
    if (ops.length) {
      this.enqueue(ops);
      this.writeMirror();
      this.pump(false);
    }
    return out;
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
    this.push({ kind: "ops", pushId: newPushId(), baseRev: this.rev, ops, sent: false });
  }

  private itemIds(item: QueueItem): { ids: string[]; settings: string[] } {
    if (item.kind === "import")
      return {
        ids: item.body.elements.map((e) => (e.el as SceneElement).id),
        settings: Object.keys(item.body.settings ?? {}),
      };
    const ids: string[] = [];
    const settings: string[] = [];
    for (const o of item.ops)
      if (o.t === "put") ids.push(o.el.id);
      else if (o.t === "del") ids.push(o.id);
      else if (o.t === "settings") settings.push(...Object.keys(o.settings));
    return { ids, settings };
  }

  private track(item: QueueItem, delta: 1 | -1) {
    const { ids, settings } = this.itemIds(item);
    for (const [map, list] of [
      [this.busy, ids],
      [this.busySettings, settings],
    ] as const)
      for (const id of list) {
        const n = (map.get(id) ?? 0) + delta;
        if (n > 0) map.set(id, n);
        else map.delete(id);
      }
  }

  private push(item: QueueItem) {
    this.queue.push(item);
    this.track(item, 1);
  }

  /** Drops the first queue item; returns deferred remote puts now due (Rule B). */
  private shift(ack: Ack | null): RemoteOp[] {
    const item = this.queue.shift();
    if (!item) return [];
    this.track(item, -1);
    const due: RemoteOp[] = [];
    const rejected = new Set(ack?.rejected.map((r) => r.id));
    for (const id of this.itemIds(item).ids) {
      const d = this.deferred.get(id);
      if (!d || this.busy.has(id)) continue;
      this.deferred.delete(id);
      if (!ack || rejected.has(id)) continue; // the resync takes the server's version
      const mine = ack.versions[id] ?? 0;
      if (d.version > mine || (ack.duplicate && d.version >= mine)) due.push(d);
    }
    return due;
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
    const viaSocket = item.kind === "ops" && !keepalive && this.link !== null;
    const req =
      item.kind === "import"
        ? this.api.importScene(this.sessionId, item.body)
        : viaSocket
          ? this.sendLive({
              pushId: item.pushId,
              baseRev: item.baseRev,
              ops: item.ops,
              ...(item.mirrored ? { mirrored: true as const } : {}),
            })
          : this.api.push(
              this.sessionId,
              {
                pushId: item.pushId,
                baseRev: item.baseRev,
                ops: item.ops,
                ...(item.mirrored ? { mirrored: true as const } : {}),
              },
              { keepalive: keepalive && jsonBytes(item.ops) <= KEEPALIVE_BYTES },
            );
    req.then(
      (ack) => this.onAck(item, ack),
      (err: unknown) => this.onError(item, err),
    );
  }

  private sendLive(body: {
    pushId: string;
    baseRev: number;
    ops: Op[];
    mirrored?: true;
  }): Promise<Ack> {
    const link = this.link!;
    return new Promise<Ack>((resolve, reject) => {
      this.waiting.set(body.pushId, { resolve, reject });
      try {
        link.send({ type: "push", ...body });
      } catch (e) {
        this.waiting.delete(body.pushId);
        reject(new ApiError(0, "network", String(e)));
      }
    });
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
    const revived: RemoteOp[] = [];
    if (item.kind === "ops") {
      // A put that landed after a remote delete we already applied (someone
      // put the item back in between, so the server took it): the server holds
      // our version, so it comes back on this board too.
      for (const o of item.ops) {
        if (o.t !== "put" || rejected.has(o.el.id) || this.known.has(o.el.id)) continue;
        const v = ack.versions[o.el.id];
        const t = this.tomb.get(o.el.id);
        if (v === undefined || (t !== undefined && t >= v)) continue;
        this.tomb.delete(o.el.id);
        revived.push({ t: "put", el: o.el, idx: o.idx, version: v });
      }
    }
    if (item.kind === "ops") {
      for (const o of item.ops)
        if (o.t === "del" && ack.versions[o.id] !== undefined && !this.known.has(o.id))
          this.tomb.set(o.id, ack.versions[o.id]);
    } else if (item.body.mode === "replace") {
      for (const [id, v] of Object.entries(ack.versions))
        if (!this.known.has(id) && this.tomb.has(id)) this.tomb.set(id, v);
    }
    if (item.kind === "ops" && item.mirrored) {
      const stale = ack.ignored.filter((i) => i.reason === "stale_replay");
      // the server kept newer versions: take them back
      for (const i of stale) if (i.id !== "settings") this.resyncIds.add(i.id);
      if (stale.length) this.host.notice(LOST_NOTICE);
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
        const allDeleted = ack.rejected.every((x) => x.reason === "deleted");
        const announced = allDeleted && ack.rejected.every((x) => this.removedNoticed.has(x.id));
        for (const x of ack.rejected) this.removedNoticed.delete(x.id);
        if (!announced)
          this.host.notice(
            allDeleted
              ? REMOVED_NOTICE
              : `${ack.rejected.length === 1 ? "A change was" : `${ack.rejected.length} changes were`} refused by the server (${r.message ?? r.reason}) and undone.`,
          );
      }
    }
    const due = this.shift(ack);
    if (due.length || revived.length) this.applyRemote([...revived, ...due]);
    this.afterSettled();
  }

  private onError(item: QueueItem, err: unknown) {
    this.inflight = false;
    const e = err instanceof ApiError ? err : new ApiError(0, "network", String(err));
    if (e.retry) {
      this.offline = true;
      this.backoff = Math.min(15000, this.backoff ? this.backoff * 2 : 1000);
      this.retryTimer = this.timers.setTimeout(() => {
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
      this.shift(null);
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
    else if (!this.busy.size) this.removedNoticed.clear();
    if (!this.queue.length && (this.resyncAll || this.resyncIds.size)) void this.resync();
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
      snap = this.guard.snapshot(await this.api.scene(this.sessionId));
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
