/**
 * For testing only: in-memory mock document service, implemented per project commit protocol in
 * c65-design.md section 3 and docs/plan/c65-ops-spec.md section 5
 * (project.open / project.op → state / ok / rejected / ops / overwritten).
 *
 * Messages are not delivered directly, but enter queues: upstream (page → service) has one queue per
 * connection, downstream (service → page) has one queue per connection, each FIFO; `step(r)` randomly
 * picks a non-empty queue to deliver one message, simulating network interleaving. `drain()` delivers
 * until empty.
 *
 * Path operations use applyOps from src/kernel/diffProject.ts: what is tested here is the page side;
 * general engine of real document service is written separately on c65-docservice branch per the same
 * spec.
 */
import { applyOps, entitiesOf } from "../kernel/diffProject.ts";

export class MemDocService {
  constructor({ project = null, rev = 0, overwriteWindowMs = 0, now = () => Date.now() } = {}) {
    this.project = project;
    this.rev = rev;
    /** Each applied commit */
    this.log = [];
    this.appliedRev = new Map();
    this.conns = new Set();
    this.overwriteWindowMs = overwriteWindowMs;
    this.now = now;
    /** entity → { session, rev, at, conn } */
    this.lastWriter = new Map();
    this.seq = 0;
  }

  /** Open a new connection; onMessage receives downstream messages */
  connect(session, onMessage) {
    const conn = { id: ++this.seq, session, actor: { userId: "u", deviceId: "d", session }, up: [], down: [], subscribed: false, open: true, onMessage };
    this.conns.add(conn);
    return {
      conn,
      send: (msg) => {
        if (conn.open) conn.up.push(structuredClone(msg));
      },
    };
  }

  /** Disconnect: unprocessed upstream items are dropped according to dropUp; undelivered downstream items are always dropped */
  disconnect(conn, { dropUp = true } = {}) {
    if (dropUp) conn.up.length = 0;
    else while (conn.up.length) this.handle(conn, conn.up.shift());
    conn.down.length = 0;
    conn.open = false;
    conn.subscribed = false;
    this.conns.delete(conn);
  }

  push(conn, msg) {
    if (conn.open) conn.down.push(structuredClone(msg));
  }

  handle(conn, msg) {
    if (msg.type === "project.open") {
      conn.subscribed = true;
      this.push(conn, { type: "project.state", projectId: msg.projectId, rev: this.rev, project: this.project });
      return;
    }
    if (msg.type !== "project.op") return;
    // Idempotent by opId, before expected version check
    if (this.appliedRev.has(msg.opId)) {
      this.push(conn, { type: "project.op.ok", opId: msg.opId, rev: this.appliedRev.get(msg.opId) });
      return;
    }
    if (msg.expectRev !== undefined && msg.expectRev !== this.rev) {
      const since = this.log.filter((e) => e.rev > msg.expectRev).map((e) => ({ rev: e.rev, actor: e.actor, session: e.session, paths: e.ops.map((o) => o.path) }));
      this.push(conn, { type: "project.op.rejected", opId: msg.opId, reason: "stale", currentRev: this.rev, since });
      return;
    }
    const r = applyOps(this.project ?? {}, msg.ops);
    if (!r.ok) {
      this.push(conn, { type: "project.op.rejected", opId: msg.opId, reason: "bad-path", currentRev: this.rev });
      return;
    }
    this.project = r.value;
    this.rev++;
    this.appliedRev.set(msg.opId, this.rev);
    this.log.push({ rev: this.rev, opId: msg.opId, session: msg.session, actor: conn.actor, ops: msg.ops, expectRev: msg.expectRev, undoOf: msg.undoOf });

    // Overwrite notification
    const overwrote = [];
    if (this.overwriteWindowMs > 0) {
      const at = this.now();
      for (const entity of entitiesOf(msg.ops)) {
        const prev = this.lastWriter.get(entity);
        if (prev && prev.session !== msg.session && at - prev.at <= this.overwriteWindowMs) {
          overwrote.push({ entity, by: { actor: prev.actor, session: prev.session } });
          if (prev.conn.open) this.push(prev.conn, { type: "project.overwritten", entity, by: { actor: conn.actor, session: msg.session }, rev: this.rev });
        }
        this.lastWriter.set(entity, { session: msg.session, actor: conn.actor, rev: this.rev, at, conn });
      }
    }
    this.push(conn, { type: "project.op.ok", opId: msg.opId, rev: this.rev, ...(overwrote.length ? { overwrote } : {}) });
    for (const other of this.conns) {
      if (other === conn || !other.subscribed) continue;
      this.push(other, { type: "project.ops", rev: this.rev, opId: msg.opId, ops: msg.ops, actor: conn.actor, session: msg.session, ...(msg.undoOf ? { undoOf: msg.undoOf } : {}) });
    }
  }

  /** List of non-empty queues (upstream / downstream each count as one) */
  queues() {
    const out = [];
    for (const c of this.conns) {
      if (c.up.length) out.push(() => this.handle(c, c.up.shift()));
      if (c.down.length) out.push(() => c.onMessage(c.down.shift()));
    }
    return out;
  }

  /** Randomly deliver one item; return false if there is nothing to deliver */
  step(r) {
    const qs = this.queues();
    if (!qs.length) return false;
    (r ? qs[r.int(qs.length)] : qs[0])();
    return true;
  }

  drain(r) {
    let n = 0;
    while (this.step(r)) if (++n > 1e6) throw new Error("drain cannot stop");
    return n;
  }
}
