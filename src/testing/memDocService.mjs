/**
 * 仅供测试:内存里的文档服务假件,照 c65-design.md 第 3 节与 docs/plan/c65-ops-spec.md 第 5 节的
 * 项目提交协议做(project.open / project.op → state / ok / rejected / ops / overwritten)。
 *
 * 消息不直接投递,而是进队列:上行(页面 → 服务)每条连接一个队列,下行(服务 → 页面)每条连接
 * 一个队列,各自先进先出;`step(r)` 随机挑一个非空队列投一条,模拟网络交错。`drain()` 投完为止。
 *
 * 路径操作用 src/kernel/diffProject.ts 的 applyOps —— 这里测的是页面一侧,真文档服务的通用引擎
 * 由 c65-docservice 分支按同一页规范另写。
 */
import { applyOps, entitiesOf } from "../kernel/diffProject.ts";

export class MemDocService {
  constructor({ project = null, rev = 0, overwriteWindowMs = 0, now = () => Date.now() } = {}) {
    this.project = project;
    this.rev = rev;
    /** 每次落地的提交 */
    this.log = [];
    this.appliedRev = new Map();
    this.conns = new Set();
    this.overwriteWindowMs = overwriteWindowMs;
    this.now = now;
    /** entity → { session, rev, at, conn } */
    this.lastWriter = new Map();
    this.seq = 0;
  }

  /** 新开一条连接;onMessage 收下行消息 */
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

  /** 断开:上行没处理的按 dropUp 决定丢不丢,下行没投的一律丢 */
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
    // 按 opId 幂等,先于期望版本检查
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

    // 覆盖通知
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

  /** 非空队列的列表(上行 / 下行各算一个) */
  queues() {
    const out = [];
    for (const c of this.conns) {
      if (c.up.length) out.push(() => this.handle(c, c.up.shift()));
      if (c.down.length) out.push(() => c.onMessage(c.down.shift()));
    }
    return out;
  }

  /** 随机投一条;没有可投的返回 false */
  step(r) {
    const qs = this.queues();
    if (!qs.length) return false;
    (r ? qs[r.int(qs.length)] : qs[0])();
    return true;
  }

  drain(r) {
    let n = 0;
    while (this.step(r)) if (++n > 1e6) throw new Error("drain 停不下来");
    return n;
  }
}
