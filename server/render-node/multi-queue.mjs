/**
 * 多项目模式的队列次序（语义 `docs/semantics/product/rendering.md`「渲染服务的两种模式」：多项目模式；
 * 机制 `docs/semantics/mechanism/rendering.md`「多项目模式的做法」）。
 *
 * 每个请求只记「哪个项目、哪一类、什么时候来的」，排进同一条队列，出队次序三条规矩：
 *
 *   1. **看画面先于产流**：`look` 类的请求全部排在 `stream` 类前面（类的先后由 `classes` 定，缺省 `['look', 'stream']`）；
 *   2. **同一类里各项目轮流**：同一类里按项目轮流出队——这一类里最久没轮到的项目先出（从没轮到过的按它排头那个请求来的先后），
 *      一个项目出了一个请求就排到这一类的最后；
 *   3. **同一项目内先来先做**：同一类、同一个项目的请求按来的先后（`seq`）。
 *
 * 不让哪个项目占着：轮流按「一个请求」算，不按「一段时间」或「一轮对话」算，所以只要别的项目有请求排着，下一个就轮到它。
 *
 * 本文件只管次序，不认识工作进程、不发请求。三处用它：
 *   - 托管方渲染服务的看画面请求（`server/hosted-render/look.mjs`，`look` 类）；
 *   - 托管方渲染服务的隔离工作进程该装哪个项目（`server/hosted-render/isolation.mjs`：`look` 类的需求先，其次 `stream` 类的项目）；
 *   - 独立渲染主机各项目认领任务的先后（`server/render-node/host.mjs`，`stream` 类）。
 *
 * 纯 JS，只用内置对象；`seq` 由调用方给（登记的先后），没有就按加进来的先后自动编。
 */

/** 缺省的类先后：看画面先于产流 */
export const MULTI_QUEUE_CLASSES = Object.freeze(['look', 'stream']);

/**
 * 轮流的记账：每一类里每个项目上一次出队是第几次。数字越小越久没轮到；没轮到过的没有记录（排在所有轮到过的前面）。
 * 只记数，不记时刻：次序与时钟无关，单测里不用拨时间。
 */
export function createRotation() {
  /** kind → Map(projectId → 第几次) */
  const served = new Map();
  let tick = 0;
  return {
    /** 这一类里这个项目刚出了一个请求：排到这一类的最后 */
    served(kind, projectId) {
      if (!served.has(kind)) served.set(kind, new Map());
      tick += 1;
      served.get(kind).set(projectId, tick);
      return tick;
    },
    /** 这一类里这个项目上一次出队是第几次；没有回 null */
    lastServed(kind, projectId) { return served.get(kind)?.get(projectId) ?? null; },
    /** 项目不在了（摘掉、删掉）：清掉它的记账 */
    forget(projectId) { for (const m of served.values()) m.delete(projectId); },
    /** 诊断用：`{ kind: { projectId: n } }` */
    snapshot() {
      const out = {};
      for (const [kind, m] of served) out[kind] = Object.fromEntries(m);
      return out;
    },
  };
}

/**
 * 按三条规矩排出出队次序（不改入参）。
 * @template {{ projectId: string, kind?: string, seq: number }} T
 * @param {T[]} items 排着的请求；`kind` 不在 `classes` 里的排在所有类之后
 * @param {{ lastServed(kind: string, projectId: string): number | null }} rotation
 * @param {readonly string[]} [classes]
 * @returns {T[]}
 */
export function orderByPolicy(items, rotation, classes = MULTI_QUEUE_CLASSES) {
  const classIndex = (kind) => { const i = classes.indexOf(kind); return i < 0 ? classes.length : i; };
  /** 类号 → (项目 → 这个项目在这一类里的请求，先来的在前) */
  const byClass = new Map();
  for (const item of items ?? []) {
    if (!item || typeof item.projectId !== 'string') continue;
    const c = classIndex(item.kind);
    if (!byClass.has(c)) byClass.set(c, new Map());
    const projects = byClass.get(c);
    if (!projects.has(item.projectId)) projects.set(item.projectId, []);
    projects.get(item.projectId).push(item);
  }
  const out = [];
  for (const c of [...byClass.keys()].sort((a, b) => a - b)) {
    const kind = c < classes.length ? classes[c] : null;
    const projects = byClass.get(c);
    for (const list of projects.values()) list.sort((a, b) => a.seq - b.seq);
    // 这一类里的轮流次序：最久没轮到的先（没轮到过的最先，它们之间按排头请求来的先后）
    const turn = [...projects.entries()].map(([projectId, list]) => ({ projectId, list, last: kind === null ? null : rotation.lastServed(kind, projectId), head: list[0].seq }));
    turn.sort((a, b) => {
      if (a.last !== b.last) {
        if (a.last === null) return -1;
        if (b.last === null) return 1;
        return a.last - b.last;
      }
      if (a.head !== b.head) return a.head - b.head;
      return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
    });
    // 一轮一个：每个项目出一个就排到最后，所以整条次序就是按轮交错
    const depth = Math.max(...turn.map((t) => t.list.length));
    for (let r = 0; r < depth; r += 1) for (const t of turn) if (r < t.list.length) out.push(t.list[r]);
  }
  return out;
}

/**
 * 带记账的一条队列：登记、撤掉、看次序、取下一个。
 * @param {object} [o]
 * @param {readonly string[]} [o.classes]
 */
export function createMultiQueue({ classes = MULTI_QUEUE_CLASSES } = {}) {
  const rotation = createRotation();
  /** id → { id, projectId, kind, seq, ... } */
  const items = new Map();
  let nextSeq = 1;
  return {
    rotation,
    /**
     * 登记一个请求。同一个 `id` 再登记回原来那一条。`seq` 不给就按登记的先后编。
     * @param {{ id: string, projectId: string, kind: string, seq?: number }} item
     */
    add(item) {
      if (items.has(item.id)) return items.get(item.id);
      const seq = Number.isFinite(item.seq) ? item.seq : nextSeq;
      nextSeq = Math.max(nextSeq, seq + 1);
      const entry = { ...item, seq };
      items.set(item.id, entry);
      return entry;
    },
    remove(id) { return items.delete(id); },
    has(id) { return items.has(id); },
    get size() { return items.size; },
    /** 此刻的出队次序（不取走） */
    order() { return orderByPolicy([...items.values()], rotation, classes); },
    /**
     * 按次序找第一个此刻做得了的（`canRun` 回 true）；找到就取走并记账（这个项目排到这一类的最后），回它；都做不了回 null。
     * 排在前面的此刻做不了时不挡后面做得了的。
     */
    take(canRun = () => true) {
      for (const item of this.order()) {
        let ok = false;
        try { ok = canRun(item) === true; } catch { ok = false; }
        if (!ok) continue;
        items.delete(item.id);
        rotation.served(item.kind, item.projectId);
        return item;
      }
      return null;
    },
  };
}
