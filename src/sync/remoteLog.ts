/**
 * The remote log of plan §3.7 Rule C: every change the remote path applied to
 * the visible scene, so a snapshot taken earlier (an undo step, a drag's
 * start, a text edit's start) can be brought forward when it is used.
 *
 * It keeps only the latest entry per id, `Map<id, {seq, el | null, idx}>`.
 * Remote ops replace whole elements (last writer wins per element), so
 * applying the latest change of each id gives the same scene as replaying
 * every op, and nothing is ever dropped however long another tab drags or an
 * agent works. A second, append-only list of `(seq, id)` rows (compacted when
 * it holds more than twice as many rows as live entries) finds the entries
 * newer than a snapshot in O(entries since seq), so rebasing one snapshot is
 * O(n + entries since seq).
 */
import { applyChange, type RemoteChange } from "../scene/rebase";
import type { Elements } from "../scene/scene";
import type { SceneElement } from "../scene/types";

export interface RemoteLogEntry {
  seq: number;
  /** the element the remote path put on the board, or null for a delete */
  el: SceneElement | null;
  /** its layer key, when the change carried one */
  idx?: string;
}

export class RemoteLog {
  private latest = new Map<string, RemoteLogEntry>();
  /** append order; a row is stale when `latest` holds a newer seq for its id */
  private rows: { seq: number; id: string }[] = [];
  private seq = 0;

  get head() {
    return this.seq;
  }

  /** Number of ids with an entry (one per id that ever changed remotely). */
  get size() {
    return this.latest.size;
  }

  /** Rows kept for ordering (bounded by about twice `size`). */
  get rowCount() {
    return this.rows.length;
  }

  entry(id: string): RemoteLogEntry | undefined {
    return this.latest.get(id);
  }

  append(change: RemoteChange): number {
    this.seq += 1;
    const seq = this.seq;
    const del = new Set(change.deletes);
    for (const u of change.upserts) {
      if (del.has(u.id)) continue;
      this.set(u.id, { seq, el: u, idx: change.keys?.get(u.id) });
    }
    for (const id of del) this.set(id, { seq, el: null });
    if (this.rows.length > 2 * this.latest.size + 1024) this.compact();
    return seq;
  }

  private set(id: string, e: RemoteLogEntry) {
    this.latest.set(id, e);
    this.rows.push({ seq: e.seq, id });
  }

  private compact() {
    this.rows = this.rows.filter((r) => this.latest.get(r.id)?.seq === r.seq);
  }

  /** The latest change of every id that changed after `seq`, as one change. */
  since(seq: number): RemoteChange {
    const upserts: SceneElement[] = [];
    const deletes: string[] = [];
    const keys = new Map<string, string>();
    if (seq >= this.seq) return { upserts, deletes, keys };
    // first row newer than seq (rows are in seq order)
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    const seen = new Set<string>();
    for (let i = lo; i < this.rows.length; i++) {
      const { id, seq: s } = this.rows[i];
      const e = this.latest.get(id);
      if (!e || e.seq !== s || seen.has(id)) continue;
      seen.add(id);
      if (e.el) {
        upserts.push(e.el);
        if (e.idx !== undefined) keys.set(id, e.idx);
      } else deletes.push(id);
    }
    return { upserts, deletes, keys };
  }

  /** The snapshot taken at `seq` with every later remote change applied. */
  rebase(
    elements: Elements,
    seq: number,
    keyOf?: (id: string) => string | undefined,
  ): SceneElement[] {
    if (seq >= this.seq) return elements as SceneElement[];
    return applyChange(elements, this.since(seq), keyOf);
  }
}
