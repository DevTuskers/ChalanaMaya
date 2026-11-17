/**
 * The pending mirror (plan §4.1): every push that has not been acknowledged
 * is kept in localStorage with its original pushId and baseRev, plus the ops
 * not yet sent. After a reload the batches are replayed in order (the server
 * recognises a pushId it already applied, and a `mirrored` replay older than
 * its push log never overwrites newer edits), then the unsent ops are applied
 * on top and saved normally. Import bodies and file bytes are never mirrored.
 */
import type { Op } from "../shared/protocol";
import { getStorage, type StorageLike } from "../io/autosave";

export interface MirrorBatch {
  pushId: string;
  baseRev: number;
  ops: Op[];
}

export interface MirrorData {
  v: 1;
  batches: MirrorBatch[];
  unsent: Op[];
}

export const MIRROR_CAP = 2 * 1024 * 1024;
/**
 * One mirror per tab (phase 3): two tabs on the same board must not overwrite
 * each other's pending changes. The tab id lives in sessionStorage, which a
 * reload keeps. Without a tab id the board-wide key is used (phase 2 layout,
 * still read so a mirror written before the update is not lost).
 *
 * A mirror left behind by a tab that was closed (or crashed) is adopted by the
 * next page that opens the board: see `TabLease` and `PendingMirror.adopt`.
 */
export const mirrorKey = (sessionId: string, tab?: string) =>
  tab ? `chalanamaya.pending.${sessionId}.${tab}` : `chalanamaya.pending.${sessionId}`;

const TAB_KEY = "chalanamaya.tab";
const TAB_RE = /^[A-Za-z0-9_-]{8,32}$/;
/** localStorage key that says a tab is alive: `{"n": nonce, "at": ms}` */
export const leaseKey = (tab: string) => `chalanamaya.tablive.${tab}`;
/** a lease not renewed for this long belongs to a tab that is gone */
export const LEASE_MS = 3 * 60_000;
/** how often a live tab renews its lease (background tabs may be throttled to 1/min) */
export const BEAT_MS = 20_000;
/** how long to wait for live tabs to answer a ping */
export const PING_MS = 250;
const CHANNEL = "chalanamaya.tabs";

const randomId = () => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

/** The part of BroadcastChannel the lease uses. */
export interface TabChannel {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close?(): void;
}

type LeaseMessage =
  { t: "who"; tabs: string[]; from: string } | { t: "here"; tab: string; to: string };

/**
 * Which tab owns which mirror. Each page holds a lease on its tab id: a
 * heartbeat in localStorage (renewed every 20 s, removed on `pagehide`) and an
 * answer to pings on a BroadcastChannel. A mirror whose tab has no fresh lease,
 * or whose fresh lease nobody answers for (a crashed tab), is unowned and is
 * adopted by the page that opens the board. A duplicated browser tab copies
 * sessionStorage and so starts with the original's tab id; the original
 * answers the ping and the copy picks a new id.
 */
export class TabLease {
  id: string | null = null;
  readonly nonce = randomId();
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private waiters = new Set<(tab: string) => void>();

  constructor(
    private readonly local: StorageLike | null,
    private readonly session: StorageLike | null,
    private readonly opts: {
      now?: () => number;
      channel?: TabChannel | null;
      pingMs?: number;
      /** renew the lease on a timer (off in unit tests) */
      timers?: boolean;
    } = {},
  ) {
    if (opts.channel) opts.channel.onmessage = (e) => this.onMessage(e.data as LeaseMessage);
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private onMessage(m: LeaseMessage) {
    if (!m || typeof m !== "object") return;
    if (m.t === "who" && m.from !== this.nonce && this.id && m.tabs?.includes(this.id))
      this.opts.channel?.postMessage({ t: "here", tab: this.id, to: m.from });
    else if (m.t === "here" && m.to === this.nonce) for (const w of this.waiters) w(m.tab);
  }

  /** Decides this page's tab id (a new one for a duplicated tab) and takes the lease. */
  async start(): Promise<string | null> {
    if (!this.session) return null;
    let id: string | null = null;
    try {
      id = this.session.getItem(TAB_KEY);
    } catch {
      return null;
    }
    if (!id || !TAB_RE.test(id)) id = randomId();
    else {
      const lease = this.readLease(id);
      if (lease && lease.n !== this.nonce && this.fresh(lease)) {
        // another page holds this id: a duplicated tab, or a crash a moment ago
        const live = await this.liveAmong([id]);
        if (live.has(id)) id = randomId();
      }
    }
    try {
      this.session.setItem(TAB_KEY, id);
    } catch {
      return null;
    }
    this.id = id;
    this.beat();
    this.sweep();
    if (this.opts.timers) this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
    return id;
  }

  private readLease(tab: string): { n: string; at: number } | null {
    try {
      const raw = this.local?.getItem(leaseKey(tab));
      if (!raw) return null;
      const v = JSON.parse(raw) as { n?: unknown; at?: unknown };
      return typeof v.n === "string" && typeof v.at === "number" ? { n: v.n, at: v.at } : null;
    } catch {
      return null;
    }
  }

  private fresh(l: { at: number }) {
    return this.now() - l.at < LEASE_MS;
  }

  /** Renews the lease (also after the page comes back from the back/forward cache). */
  beat() {
    if (!this.id) return;
    try {
      this.local?.setItem(leaseKey(this.id), JSON.stringify({ n: this.nonce, at: this.now() }));
    } catch {
      // storage full: other pages treat this tab as gone after LEASE_MS
    }
  }

  /** The page is going away (`pagehide`): its mirror may be adopted from now on. */
  release() {
    if (!this.id) return;
    try {
      if (this.readLease(this.id)?.n === this.nonce) this.local?.removeItem?.(leaseKey(this.id));
    } catch {
      // nothing to release
    }
  }

  dispose() {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
    this.release();
    if (this.opts.channel) this.opts.channel.onmessage = null;
  }

  /** Removes leases of tabs gone for over a day (crashed tabs never release). */
  private sweep() {
    const keys = storageKeys(this.local).filter((k) => k.startsWith("chalanamaya.tablive."));
    for (const k of keys) {
      const l = this.readLease(k.slice("chalanamaya.tablive.".length));
      if (!l || this.now() - l.at > 24 * 3600_000) this.local?.removeItem?.(k);
    }
  }

  /** The tabs among `tabs` that are alive in this browser right now. */
  async liveAmong(tabs: readonly string[]): Promise<Set<string>> {
    const fresh = tabs.filter((t) => {
      const l = this.readLease(t);
      return l && l.n !== this.nonce && this.fresh(l);
    });
    const channel = this.opts.channel;
    if (!fresh.length || !channel) return new Set(fresh);
    const live = new Set<string>();
    const w = (tab: string) => void live.add(tab);
    this.waiters.add(w);
    try {
      channel.postMessage({ t: "who", tabs: fresh, from: this.nonce });
      await new Promise((r) => setTimeout(r, this.opts.pingMs ?? PING_MS));
    } finally {
      this.waiters.delete(w);
    }
    return live;
  }
}

/** Every key in a storage (empty when it cannot be enumerated). */
export const storageKeys = (s: StorageLike | null): string[] => {
  const out: string[] = [];
  try {
    const n = s?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const k = s!.key?.(i);
      if (k) out.push(k);
    }
  } catch {
    // not enumerable
  }
  return out;
};

const sessionStore = (): StorageLike | null => {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
};

let current: Promise<TabLease> | null = null;
let currentLease: TabLease | null = null;

/** This page's tab lease (started once per page). */
export const tabLease = (): Promise<TabLease> => {
  current ??= (async () => {
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? (new BroadcastChannel(CHANNEL) as unknown as TabChannel)
        : null;
    const lease = new TabLease(getStorage(), sessionStore(), { channel, timers: true });
    await lease.start();
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => lease.release());
      window.addEventListener("pageshow", () => lease.beat());
    }
    currentLease = lease;
    return lease;
  })();
  return current;
};

/** This page's tab id, once `tabLease()` has started (null before, or without sessionStorage). */
export const tabId = (): string | null => currentLease?.id ?? null;

const opKey = (op: Op): string =>
  op.t === "put"
    ? `e:${op.el.id}`
    : op.t === "del"
      ? `e:${op.id}`
      : op.t === "settings"
        ? `s:${Object.keys(op.settings).sort().join(",")}`
        : `f:${op.t}:${op.fileId}`;

/**
 * Keeps only the newest op per element (and per settings field set) across
 * the batches and the unsent ops. Retained ops keep their batch, so their
 * original pushId and baseRev are still used.
 */
export const compactMirror = (data: MirrorData): MirrorData => {
  const seen = new Set<string>();
  const keep = (ops: Op[]) => {
    const out: Op[] = [];
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      const k = opKey(ops[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(ops[i]);
    }
    return out.reverse();
  };
  const unsent = keep(data.unsent);
  const batches: MirrorBatch[] = [];
  for (let i = data.batches.length - 1; i >= 0; i -= 1) {
    const ops = keep(data.batches[i].ops);
    if (ops.length) batches.unshift({ ...data.batches[i], ops });
  }
  return { v: 1, batches, unsent };
};

export type MirrorWrite =
  | { ok: true; complete: true }
  | { ok: true; complete: false; dropped: number }
  | { ok: false; reason: string };

/** Serialised length of one op; ops are reused between writes, so this is cached. */
const opLength = new WeakMap<Op, number>();
const lengthOf = (op: Op) => {
  let n = opLength.get(op);
  if (n === undefined) {
    n = JSON.stringify(op).length;
    opLength.set(op, n);
  }
  return n;
};

/** Exact serialised length of `data`, from cached op lengths. */
export const mirrorSize = (data: MirrorData) => {
  const list = (ops: Op[]) =>
    ops.reduce((a, o) => a + lengthOf(o), 0) + Math.max(0, ops.length - 1) + 2;
  let n = '{"v":1,"batches":[],"unsent":}'.length + list(data.unsent);
  data.batches.forEach((b, i) => {
    n += JSON.stringify({ ...b, ops: [] }).length - 2 + list(b.ops) + (i ? 1 : 0);
  });
  return n;
};

/**
 * Fits the data under `cap` characters: compacts, then drops the oldest ops.
 * Sizes come from cached per-op lengths, so a long drag over a large board
 * does not stringify megabytes of ops many times on every write.
 */
export const fitMirror = (
  data: MirrorData,
  cap = MIRROR_CAP,
): { data: MirrorData; text: string; dropped: number } => {
  if (mirrorSize(data) <= cap) return { data, text: JSON.stringify(data), dropped: 0 };
  let d = compactMirror(data);
  let size = mirrorSize(d);
  let dropped = 0;
  if (size > cap) {
    const batches = d.batches.map((b) => ({ ...b, ops: [...b.ops] }));
    const unsent = [...d.unsent];
    while (size > cap && (batches.length || unsent.length)) {
      const b = batches[0];
      const ops = b ? b.ops : unsent;
      const op = ops.shift();
      if (op) {
        dropped += 1;
        size -= lengthOf(op) + (ops.length ? 1 : 0);
      }
      if (b && !b.ops.length) {
        batches.shift();
        size = mirrorSize({ v: 1, batches, unsent });
      }
    }
    d = { v: 1, batches, unsent };
  }
  return { data: d, text: JSON.stringify(d), dropped };
};

export class PendingMirror {
  constructor(
    private readonly storage: StorageLike | null,
    readonly sessionId: string,
    private readonly cap = MIRROR_CAP,
    private readonly tab: string | null = null,
  ) {}

  private adopted: string[] = [];

  private get key() {
    return mirrorKey(this.sessionId, this.tab ?? undefined);
  }

  /** Tab ids of other mirrors of this board in this browser. */
  foreignTabs(): string[] {
    const prefix = `${mirrorKey(this.sessionId)}.`;
    return storageKeys(this.storage)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((t) => t !== this.tab && TAB_RE.test(t));
  }

  /**
   * Takes over the mirrors of tabs that are gone: `read()` merges them (before
   * this tab's own), and the next `write()` stores the merged state under this
   * tab's key and deletes theirs.
   */
  adopt(tabs: readonly string[]) {
    this.adopted = tabs.filter((t) => t !== this.tab);
  }

  read(): MirrorData | null {
    const own = this.readKey(this.key);
    if (!this.tab) return own;
    // a board-wide mirror from before per-tab mirrors, then adopted ones
    const sources = [
      this.readKey(mirrorKey(this.sessionId)),
      ...this.adopted.map((t) => this.readKey(mirrorKey(this.sessionId, t))),
      own,
    ].filter((d): d is MirrorData => d !== null);
    if (sources.length <= 1) return sources[0] ?? null;
    const seen = new Set<string>();
    const batches: MirrorBatch[] = [];
    for (const d of sources)
      for (const b of d.batches) {
        if (seen.has(b.pushId)) continue;
        seen.add(b.pushId);
        batches.push(b);
      }
    return { v: 1, batches, unsent: sources.flatMap((d) => d.unsent) };
  }

  private readKey(key: string): MirrorData | null {
    try {
      const raw = this.storage?.getItem(key);
      if (!raw) return null;
      const d = JSON.parse(raw) as Partial<MirrorData>;
      if (!d || d.v !== 1 || !Array.isArray(d.batches) || !Array.isArray(d.unsent)) return null;
      const batches = d.batches.filter(
        (b): b is MirrorBatch =>
          !!b &&
          typeof b.pushId === "string" &&
          typeof b.baseRev === "number" &&
          Array.isArray(b.ops),
      );
      return { v: 1, batches, unsent: d.unsent };
    } catch {
      return null;
    }
  }

  /** Never throws: a full or missing storage is reported, not raised. */
  write(batches: MirrorBatch[], unsent: Op[]): MirrorWrite {
    if (!this.storage) return { ok: false, reason: "this browser has no local storage" };
    const key = this.key;
    try {
      if (this.tab) this.storage.removeItem?.(mirrorKey(this.sessionId));
      if (!batches.length && !unsent.length) {
        this.storage.removeItem?.(key);
        this.dropAdopted();
        return { ok: true, complete: true };
      }
      const fitted = fitMirror({ v: 1, batches, unsent }, this.cap);
      this.storage.setItem(key, fitted.text);
      this.dropAdopted();
      return fitted.dropped
        ? { ok: true, complete: false, dropped: fitted.dropped }
        : { ok: true, complete: true };
    } catch {
      return { ok: false, reason: "the browser's local storage is full" };
    }
  }

  /** Adopted mirrors are now part of this tab's (written just before). */
  private dropAdopted() {
    for (const t of this.adopted) this.storage?.removeItem?.(mirrorKey(this.sessionId, t));
    this.adopted = [];
  }

  clear() {
    try {
      this.storage?.removeItem?.(this.key);
      if (this.tab) this.storage?.removeItem?.(mirrorKey(this.sessionId));
    } catch {
      // nothing to protect
    }
  }
}
