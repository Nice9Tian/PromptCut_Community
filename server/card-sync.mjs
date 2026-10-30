/**
 * 卡片源码同步（C6.6 设计稿 `docs/plan/c66-design.md` 第 5 节；`docs/plan/cloud-task.md` A6、B2）。
 *
 * 编辑器进程（不是页面）经一条自己的 WebSocket 连接，把卡片源码写进**当前项目空间**的内容库
 * （`content.put({ kind: 'card-source', key: <仓库相对路径>, body: <源码> })`），并按内容库的变化把别人的版本装到本机。
 *
 * # 写
 * - 卡片文件每次保存（`edit_card`、`create_card`、安装）后调 `saved(rel)`：记成「待上传」、马上 `content.put`，
 *   回包里的 `rev` 就是新的 `cardRev`。本机记下这个文件上次同步到的 `{ rev, hash, mine }`（`hash` 与内容库同一算法，
 *   `sha256(JSON.stringify(源码))`，源码先把 CRLF 统一成 LF）。没连上时留在「待上传」里，连上后补传。
 * - 打开共享项目时（`bind` 带 `keys`），项目用到的用户卡与改过的内置卡里服务上还没有的，也传上去。
 *
 * # 读（只在共享项目里；本机项目的 `local` 空间这一半是空操作，`cardRev` 照常自增）
 * - 连上后 `content.watch(['card-source'])`，再 `content.list('card-source')`，逐条按下面的规则处理；
 * - 之后每条 `content.changed` 同样处理（别人改了卡当场同步）。
 * - 规则（`rec` 是本机记录，`cur` 是本机此刻的内容）：
 *   - 服务上的版本不比 `rec.rev` 新：什么都不装；本机在那之后又改过就上传（本地改了则上传，A6）；
 *   - 服务上更新了：
 *     - 本机没有这个文件，或者内容已经相同 → 装上 / 只记账；
 *     - 本机没改过（`cur` 与 `rec.hash` 相同）→ 装上；
 *     - 本机改过、服务上也改过 → 最后写的赢：先把本机那份备份，再装服务上的，并给覆盖提示；
 *     - 本机那份就是自己上次写上去的（`rec.mine`），现在被别人覆盖 → 同样先备份再装，并提示（B2、B3：被覆盖方要知道）。
 *     - **断网期间的改动**（连上后对账时才看到：同步过的卡本机在那之后改过、服务上也更新了）→ 不按「最后写的赢」：先备份本机那份、装上服务上的，
 *       发一条 `conflict`（带我这边与云端两份源码），页面把它放进「冲突合并」窗口（一张卡一条），由用户选「合并」（照我这边，`takeMine`）
 *       或「删除选中」（保留云端现状）。语义 `workflow/editing.md`「撤销、重做」，`product/document-service.md`「冲突」（2026-10-22 用户定）。
 * - 自己写的那一次在频道里回来时（`actor.session` 是本实例的），`previousActor` 是别人的就提示「你覆盖了 X」（覆盖方要知道）。
 * - 同一个键有上传在途时，这个键的变化等上传回包之后再处理：先回包的那一版号就是自己的，旧的变化直接丢掉，
 *   免得把别人更早的一版错当成「服务上更新了」。
 *
 * # 范围
 * 只同步 `src/cards/`、`src/parts/` 下的 `.tsx` / `.ts` / `.css`（测试文件除外），且只同步用户卡与改过的内置卡；
 * 未改的内置卡两端都有，不同步（第 5 节〔裁〕）。「改过」由调用方的 `files.changed(rel)` 判定。
 *
 * 文件怎么读、怎么装（审查、写进改动层、热更新、重测）、怎么备份都由调用方注入（`server/vite-plugin-cards.ts`），
 * 本模块只管规则、记账与连接；只依赖 Node 内置模块，WebSocket 端点可注入（测试不必起编辑器）。
 *
 * # 连接
 * 缺省的连接是一个**会话**（`server/render-node/session-link.mjs` 的 `createDocEndpoint`，HT-a 契约
 * `docs/plan/http-transport-contract.md` 第 9 节；语义 `docs/semantics/product/document-service.md`「会话与传输」）：
 * 传输断开只让会话脱开，保留期内接续，期间发出的请求与服务端发来的 `content.changed` 都不丢不重，
 * 所以接续（`onResume`）时不重订阅、不重对账；只有会话结束（`onClose`）才算断线，之后建新会话时（`onOpen`）
 * 重新 `content.watch` 与对账。建新会话时才调 `protocols()`（共享项目要向页面要一张票据），接续不调。
 * 对没有会话层的旧服务端，端点退化为「一条传输一个会话」，行为与原来的 `createWsEndpoint` 相同。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDocEndpoint } from './render-node/session-link.mjs';

export const CARD_SOURCE = 'card-source';

export const CARD_SYNC_DEFAULTS = Object.freeze({
  /** 一次内容库请求等回包的上限 */
  requestTimeoutMs: 10_000,
  /** 上传失败（非断线）后隔多久再试 */
  retryMs: 3_000,
  /** 最近的通知留多少条（诊断接口看） */
  noticesKeep: 50,
});

const SYNC_EXT = /\.(tsx|ts|css)$/;

/** 统一换行：本机文件可能是 CRLF，两端比内容时不该因为换行不同就当成改过 */
export function normalizeSource(source) {
  return String(source).replace(/\r\n/g, '\n');
}

/** 与内容库同一算法（`docservice-contract.md` 第 2 节：`sha256(JSON.stringify(body))`），body 就是源码字符串 */
export function sourceHash(source) {
  return createHash('sha256').update(JSON.stringify(normalizeSource(source)), 'utf8').digest('hex');
}

/** 这个仓库相对路径在不在同步范围里（只看形状，「改没改过」另判） */
export function isSyncablePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return false;
  if (rel.includes('\\') || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (!(rel.startsWith('src/cards/') || rel.startsWith('src/parts/'))) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return SYNC_EXT.test(rel);
}

/** 空间的记账文件名：本机项目一个（`local`），每个共享项目一个 */
export function spaceIdOf({ local, projectId }) {
  if (local) return 'local';
  return `shared-${createHash('sha256').update(`shared\n${projectId}`, 'utf8').digest('hex').slice(0, 16)}`;
}

/** 记账的读写：`<stateDir>/<spaceId>.json`，`{ records: { [rel]: { rev, hash, mine } }, pending: string[] }` */
function createLedger(stateDir, spaceId) {
  const file = stateDir ? path.join(stateDir, `${spaceId}.json`) : null;
  let records = {};
  let pending = new Set();
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.records === 'object' && raw.records) records = raw.records;
      if (Array.isArray(raw?.pending)) pending = new Set(raw.pending.filter(isSyncablePath));
    } catch { /* 没有或坏了：当空账，下一次同步重新记 */ }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ records, pending: [...pending].sort() }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* 记不下来只影响下次启动时的判断，不影响这次同步 */ }
  };
  return {
    get: (rel) => records[rel] ?? null,
    set(rel, rec) { records[rel] = rec; save(); },
    pending: () => [...pending],
    isPending: (rel) => pending.has(rel),
    mark(rel) { if (!pending.has(rel)) { pending.add(rel); save(); } },
    unmark(rel) { if (pending.delete(rel)) save(); },
    snapshot: () => ({ records: structuredClone(records), pending: [...pending].sort() }),
  };
}

/** 诊断里的会话状态（端点有 `stats()` 才有）：实际用的传输（脱开时为 null）、是否脱开、接续与脱开次数、是否对着旧服务端退化 */
function linkDiag(endpoint) {
  let st = null;
  try { st = typeof endpoint?.stats === 'function' ? endpoint.stats() : null; } catch { st = null; }
  if (!st) return null;
  return { transport: st.transport ?? null, detached: st.detached === true, detaches: st.detaches ?? 0, resumes: st.resumes ?? 0, legacy: st.legacy === true };
}

const sameActor =(a, b) => !!a && !!b && a.userId === b.userId && (a.deviceId ?? null) === (b.deviceId ?? null) && (a.role ?? null) === (b.role ?? null);

/**
 * @param {object} o
 * @param {string | null} o.stateDir 本机记账目录（`<root>/.pc-work/card-sync`）；null = 只记在内存（测试）
 * @param {object} o.files 文件操作（全部同步或返回 Promise 都行）：
 *   - `read(rel) → string | null`：本机此刻生效的内容（改动层优先），没有回 null；
 *   - `changed(rel) → boolean`：这个文件算不算「用户卡或改过的内置卡」（没记账的本机文件据此判断是不是自己改过的）；
 *   - `install(rel, source, { rev }) → { ok: boolean, error?: string }`：装上服务上的版本（审查、写改动层、热更新、重测），`rev` 是这一版的 cardRev；
 *   - `backup(rel, content) → string`：覆盖前把本机那份存起来，回备份的相对路径。
 * @param {(o: { url: string, protocols: () => Promise<string[]> | string[] }) => object} [o.connect]
 *   建一个端点（`server/render-node/session-link.mjs` 的 `createDocEndpoint` 形状：send、onMessage、onOpen、onClose、close，
 *   可选 onResume）；缺省就用 `createDocEndpoint`（会话：传输断开在保留期内接续；会话结束后指数退避建新会话，建前现取子协议）
 * @param {(event: object) => void} [o.notify] 覆盖提示、装上、被拒等事件（插件经 HMR 转给页面）
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {boolean} [o.readOnly]  只读(独立渲染主机用,c66-host-cards):只装服务上的版本,从不上传、不记待上传 ——
 *   主机不改卡,本机那份和服务上不同只可能是别的项目装进来的,不能反过来写进这个项目
 */
export function createCardSync({
  stateDir = null,
  files,
  connect = null,
  notify = () => {},
  log = () => {},
  session = `cards-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  requestTimeoutMs = CARD_SYNC_DEFAULTS.requestTimeoutMs,
  retryMs = CARD_SYNC_DEFAULTS.retryMs,
  noticesKeep = CARD_SYNC_DEFAULTS.noticesKeep,
  readOnly = false,
} = {}) {
  if (!files || typeof files.read !== 'function' || typeof files.install !== 'function' || typeof files.backup !== 'function') {
    throw new TypeError('createCardSync: files 要有 read、install、backup');
  }
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响同步 */ } };
  if (connect !== null && typeof connect !== 'function') throw new TypeError('createCardSync: connect 要是函数');
  const connectTo = connect ?? (({ url, protocols }) => createDocEndpoint({ url, protocols, log: (event, fields) => say(`doc.${event}`, fields) }));
  const changedOf = typeof files.changed === 'function' ? files.changed : () => true;
  const notices = [];
  const emit = (event) => {
    const e = { at: Date.now(), ...event };
    notices.push(e);
    if (notices.length > noticesKeep) notices.splice(0, notices.length - noticesKeep);
    try { notify(e); } catch { /* 页面收不到提示不影响同步 */ }
  };

  /** 当前绑定；null = 没绑（还没挂上任何空间） */
  let b = null;
  let reqSeq = 0;

  function makeBinding({ projectId = null, url, protocols, local = false, keys = [] }) {
    const spaceId = spaceIdOf({ local, projectId });
    const ledger = createLedger(stateDir, spaceId);
    const endpoint = connectTo({ url, protocols });
    const binding = {
      spaceId, projectId, url, local, endpoint, ledger,
      keys: new Set((keys ?? []).filter(isSyncablePath)),
      waiting: new Map(),
      /** rel → 在途上传的 Promise */
      inflight: new Map(),
      /** 串行处理：列表对账、频道变化、上传排同一条队，同一时刻只处理一件 */
      chain: Promise.resolve(),
      connected: false,
      opens: 0,
      /** 传输断开后接续上的次数（会话没断：不重订阅、不重对账） */
      resumes: 0,
      retryTimer: null,
      closed: false,
    };
    endpoint.onMessage((msg) => onMessage(binding, msg));
    endpoint.onOpen(() => {
      binding.connected = true;
      binding.opens += 1;
      say('cards.sync.open', { spaceId, projectId, opens: binding.opens });
      if (!local) binding.endpoint.send({ type: 'content.watch', kinds: [CARD_SOURCE], reqId: `cards#watch-${++reqSeq}` });
      enqueue(binding, () => reconcile(binding));
    });
    // 接续：还是那个会话，订阅还在，脱开期间的回包与变化由会话层按序补齐、去重，这里只记数
    if (typeof endpoint.onResume === 'function') {
      endpoint.onResume(() => {
        binding.resumes += 1;
        say('cards.sync.resume', { spaceId, projectId, resumes: binding.resumes });
      });
    }
    endpoint.onClose((info) => {
      binding.connected = false;
      for (const [, w] of binding.waiting) {
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error('连接断了'), { code: 'disconnected' }));
      }
      binding.waiting.clear();
      say('cards.sync.close', { spaceId, code: info?.code ?? null });
    });
    return binding;
  }

  function enqueue(binding, fn) {
    const next = binding.chain.then(() => (binding.closed ? undefined : fn())).catch((err) => {
      say('cards.sync.error', { spaceId: binding.spaceId, message: String(err?.message ?? err) });
    });
    binding.chain = next;
    return next;
  }

  function request(binding, type, fields) {
    return new Promise((resolve, reject) => {
      if (!binding.connected) return reject(Object.assign(new Error('没连上文档服务'), { code: 'disconnected' }));
      const reqId = `cards#${++reqSeq}`;
      const timer = setTimeout(() => {
        binding.waiting.delete(reqId);
        reject(Object.assign(new Error(`${type} 超时`), { code: 'timeout' }));
      }, requestTimeoutMs);
      timer.unref?.();
      binding.waiting.set(reqId, { resolve, reject, timer, type });
      let sent = false;
      try { sent = binding.endpoint.send({ type, ...fields, reqId }) !== false; } catch { sent = false; }
      if (!sent && binding.waiting.has(reqId)) {
        binding.waiting.delete(reqId);
        clearTimeout(timer);
        reject(Object.assign(new Error('没发出去'), { code: 'disconnected' }));
      }
    });
  }

  function onMessage(binding, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (typeof msg.reqId === 'string' && binding.waiting.has(msg.reqId)) {
      const w = binding.waiting.get(msg.reqId);
      binding.waiting.delete(msg.reqId);
      clearTimeout(w.timer);
      if (msg.type === 'error') w.reject(Object.assign(new Error(`${w.type}：${msg.reason ?? 'error'}`), { code: msg.reason ?? 'error', detail: msg.detail }));
      else w.resolve(msg);
      return;
    }
    if (msg.type === 'content.changed' && msg.kind === CARD_SOURCE && !binding.local) {
      const change = { key: msg.key, hash: msg.hash, rev: msg.rev, actor: msg.actor ?? null, previousActor: msg.previousActor ?? null };
      if (!isSyncablePath(change.key) || !Number.isSafeInteger(change.rev)) return;
      // 同一个键的上传在途：等它回包再处理（回包先记下自己的版本号，旧的变化就会被丢掉）
      const pending = binding.inflight.get(change.key);
      const run = () => enqueue(binding, () => onChanged(binding, change));
      if (pending) pending.finally(run);
      else run();
    }
  }

  /* ---------------- 读：对账与变化 ---------------- */

  async function hashOfLocal(rel) {
    const cur = await files.read(rel);
    return { cur: cur ?? null, curHash: cur == null ? null : sourceHash(cur) };
  }

  async function reconcile(binding) {
    const seen = new Set();
    if (!binding.local) {
      const listing = await request(binding, 'content.list', { kind: CARD_SOURCE, prefix: 'src/' });
      const items = Array.isArray(listing.items) ? listing.items : [];
      if (listing.truncated) say('cards.sync.truncated', { spaceId: binding.spaceId, shown: items.length });
      for (const item of items) {
        if (!isSyncablePath(item?.key) || !Number.isSafeInteger(item.rev)) continue;
        seen.add(item.key);
        await handleRemote(binding, item, { actor: null, previousActor: null, fromList: true });
      }
    }
    // 待上传的，以及项目用到、服务上还没有的：传上去（只读的不传）
    if (readOnly) return;
    const want = new Set(binding.ledger.pending());
    if (!binding.local) for (const k of binding.keys) if (!seen.has(k)) want.add(k);
    for (const rel of [...want].sort()) {
      if (seen.has(rel) && !binding.ledger.isPending(rel)) continue;
      await upload(binding, rel, { reason: binding.ledger.isPending(rel) ? 'pending' : 'project' });
    }
  }

  async function onChanged(binding, change) {
    const rec = binding.ledger.get(change.key);
    const own = change.actor && change.actor.session === session;
    if (own) {
      // 自己写的那一次回来了。覆盖了别人（不是本设备自己）的就告诉覆盖方
      const prev = change.previousActor;
      if (prev && prev.session !== session && !sameActor(prev, change.actor)) {
        emit({ type: 'overwrote', key: change.key, rev: change.rev, previousActor: prev });
      }
      return;
    }
    if (rec && rec.rev >= change.rev) return;
    await handleRemote(binding, { key: change.key, hash: change.hash, rev: change.rev }, change);
  }

  async function handleRemote(binding, item, { actor, previousActor, fromList = false }) {
    const rel = item.key;
    const rec = binding.ledger.get(rel);
    const { cur, curHash } = await hashOfLocal(rel);
    if (rec && rec.rev >= item.rev) {
      // 服务上不比本机记下的新：本机在那之后改过（且没在上传）就传上去
      if (!readOnly && fromList && cur !== null && curHash !== rec.hash && !binding.ledger.isPending(rel)) {
        binding.ledger.mark(rel);
      }
      return;
    }
    if (curHash !== null && curHash === item.hash) {
      binding.ledger.set(rel, { rev: item.rev, hash: item.hash, mine: false });
      binding.ledger.unmark(rel);
      return;
    }
    const got = await request(binding, 'content.get', { kind: CARD_SOURCE, key: rel });
    if (got.missing === true || typeof got.body !== 'string') {
      say('cards.sync.skip', { key: rel, reason: got.missing ? 'missing' : 'not-string' });
      return;
    }
    const rev = Number.isSafeInteger(got.rev) ? got.rev : item.rev;
    const serverHash = sourceHash(got.body);
    if (curHash === serverHash) {
      binding.ledger.set(rel, { rev, hash: serverHash, mine: false });
      binding.ledger.unmark(rel);
      return;
    }
    // 本机那份是不是「自己的」：没同步上去的改动，或者上次就是自己写上去的
    let localChanged = false;
    if (cur !== null) {
      if (rec) localChanged = curHash !== rec.hash || binding.ledger.isPending(rel);
      else localChanged = !!(await changedOf(rel));
    }
    const mineOverwritten = !!(cur !== null && rec?.mine && curHash === rec.hash);
    const overwritten = localChanged || mineOverwritten;
    // 断网(或没开着)期间的改动:连上后对账时看到本机在上次同步之后改过、服务上也更新了 → 进「冲突合并」,不按最后写的赢悄悄换掉。
    // 只认同步过的卡(`rec` 在):第一次打开项目时本机碰巧有同名的卡,照旧按覆盖办
    const conflict = !readOnly && fromList && !!rec && localChanged && cur !== null;
    let backup = null;
    if (overwritten) {
      try {
        backup = await files.backup(rel, cur);
      } catch (err) {
        // 备份不下来就不覆盖：宁可两边暂时不一致，也不能把本机那份弄丢
        say('cards.sync.backup-failed', { key: rel, message: String(err?.message ?? err) });
        emit({ type: 'rejected', key: rel, rev, error: `本机那份备份失败,没有覆盖:${err?.message ?? err}` });
        return;
      }
    }
    let res;
    try {
      res = await files.install(rel, got.body, { rev });
    } catch (err) {
      res = { ok: false, error: String(err?.message ?? err) };
    }
    if (!res?.ok) {
      // 装不上（审查不过等）：记下这一版，免得每次变化都重试；本机内容照旧
      binding.ledger.set(rel, { rev, hash: curHash, mine: false, rejected: true });
      say('cards.sync.rejected', { key: rel, rev, error: res?.error ?? null });
      emit({ type: 'rejected', key: rel, rev, error: res?.error ?? '装不上', actor });
      return;
    }
    binding.ledger.set(rel, { rev, hash: serverHash, mine: false });
    binding.ledger.unmark(rel);
    say('cards.sync.installed', { key: rel, rev, overwritten, backup, conflict });
    emit({ type: 'installed', key: rel, rev, actor, fresh: cur === null, ...(overwritten ? { backup } : {}) });
    if (conflict) emit({ type: 'conflict', key: rel, rev, actor, backup, mine: normalizeSource(cur), cloud: normalizeSource(got.body) });
    else if (overwritten) emit({ type: 'overwritten', key: rel, rev, actor, previousActor, backup });
  }

  /* ---------------- 写：上传 ---------------- */

  function upload(binding, rel, { reason }) {
    const run = (async () => {
      const content = await files.read(rel);
      if (content == null) {
        binding.ledger.unmark(rel);
        return null;
      }
      const body = normalizeSource(content);
      try {
        const stored = await request(binding, 'content.put', { kind: CARD_SOURCE, key: rel, body, session });
        const rev = Number.isSafeInteger(stored.rev) ? stored.rev : null;
        const hash = sourceHash(body);
        const prev = binding.ledger.get(rel);
        // 在途期间先到了更新的一版（别人的）：那一版已经处理过就不倒退
        if (!(prev && rev !== null && prev.rev > rev)) binding.ledger.set(rel, { rev, hash, mine: true });
        // 上传期间本机又改了：还留在待上传里
        const after = await files.read(rel);
        if (after != null && sourceHash(after) === hash) binding.ledger.unmark(rel);
        say('cards.sync.put', { key: rel, rev, reason });
        return rev;
      } catch (err) {
        say('cards.sync.put-failed', { key: rel, reason, code: err?.code ?? null, message: String(err?.message ?? err) });
        if (err?.code === 'too-large' || err?.code === 'bad-message') {
          binding.ledger.unmark(rel);
          emit({ type: 'rejected', key: rel, error: `文档服务不收这个文件(${err.code})` });
        } else if (err?.code !== 'disconnected' && !binding.retryTimer && !binding.closed) {
          binding.retryTimer = setTimeout(() => {
            binding.retryTimer = null;
            if (!binding.closed && binding.connected) enqueue(binding, () => flushPending(binding));
          }, retryMs);
          binding.retryTimer.unref?.();
        }
        return null;
      }
    })();
    binding.inflight.set(rel, run);
    run.finally(() => { if (binding.inflight.get(rel) === run) binding.inflight.delete(rel); });
    return run;
  }

  async function flushPending(binding) {
    for (const rel of binding.ledger.pending().sort()) await upload(binding, rel, { reason: 'pending' });
  }

  function saved(rel) {
    if (readOnly || !isSyncablePath(rel)) return false;
    const binding = b;
    if (!binding) return false;
    binding.ledger.mark(rel);
    if (!binding.local) binding.keys.add(rel);
    if (binding.connected) enqueue(binding, () => upload(binding, rel, { reason: 'saved' }));
    return true;
  }

  /* ---------------- 对外 ---------------- */

  function unbindCurrent(reason) {
    const cur = b;
    if (!cur) return;
    b = null;
    cur.closed = true;
    clearTimeout(cur.retryTimer);
    for (const [, w] of cur.waiting) { clearTimeout(w.timer); w.reject(Object.assign(new Error('已解绑'), { code: 'disconnected' })); }
    cur.waiting.clear();
    try { cur.endpoint.close(); } catch { /* 已经关了 */ }
    say('cards.sync.unbind', { spaceId: cur.spaceId, reason });
  }

  return {
    session,

    /**
     * 挂到一个空间：本机项目（`local: true`，只上传）或共享项目（读写都做）。同样的绑定再调只更新 `keys`。
     * `keys`：这个项目要带上的文件（用户卡与改过的内置卡），服务上没有的会传上去。
     */
    bind({ projectId = null, url, protocols, local = false, keys = [] } = {}) {
      if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new TypeError('bind: url 要 ws(s):// 地址');
      if (!local && (typeof projectId !== 'string' || !projectId)) throw new TypeError('bind: 共享项目要 projectId');
      if (b && b.url === url && b.local === local && (local || b.projectId === projectId)) {
        this.setKeys(keys);
        return { spaceId: b.spaceId, rebound: false };
      }
      unbindCurrent('rebind');
      b = makeBinding({ projectId, url, protocols, local, keys });
      say('cards.sync.bind', { spaceId: b.spaceId, projectId, local, keys: b.keys.size });
      return { spaceId: b.spaceId, rebound: true };
    },

    /** 项目要带上的文件变了（时间轴上添了卡）：新增的、服务上还没有的传上去 */
    setKeys(keys = []) {
      if (!b) return;
      const binding = b;
      const next = new Set((keys ?? []).filter(isSyncablePath));
      const added = [...next].filter((k) => !binding.keys.has(k));
      binding.keys = next;
      if (readOnly || !added.length || binding.local || !binding.connected) return;
      enqueue(binding, async () => {
        for (const rel of added.sort()) {
          if (binding.ledger.get(rel)) continue; // 同步过（服务上有）的由对账与变化处理
          await upload(binding, rel, { reason: 'project' });
        }
      });
    },

    unbind(reason = 'unbind') {
      unbindCurrent(reason);
    },

    /**
     * 本机保存了一个卡片文件（edit_card、create_card、安装）：记成待上传、马上传。
     * 不在同步范围里的路径忽略；没绑时只记不传（下次绑上同一个空间时补传）。
     */
    saved(rel) {
      return saved(rel);
    },

    /**
     * 「冲突合并」里对一张卡点了「合并」：照我这边的源码装回本机（同一套审查、写文件、热更新），再当一次本机保存传上去。
     * 回 `{ ok, error? }`。装不上（审查不过）不传。
     */
    async takeMine(rel, source) {
      if (readOnly) return { ok: false, error: '只读的同步实例不改卡' };
      if (!isSyncablePath(rel) || typeof source !== 'string') return { ok: false, error: '不是可同步的卡片文件' };
      let res;
      try { res = await files.install(rel, normalizeSource(source), { rev: null }); }
      catch (err) { res = { ok: false, error: String(err?.message ?? err) }; }
      if (!res?.ok) return { ok: false, error: res?.error ?? '装不上' };
      saved(rel);
      say('cards.sync.take-mine', { key: rel });
      return { ok: true };
    },

    /** 等手上的活（对账、上传、装卡）都做完；测试与诊断用 */
    async idle() {
      for (;;) {
        const binding = b;
        if (!binding) return;
        const chain = binding.chain;
        await chain;
        await Promise.allSettled([...binding.inflight.values()]);
        if (binding === b && binding.chain === chain && binding.inflight.size === 0) return;
      }
    },

    status() {
      const binding = b;
      return {
        bound: !!binding,
        session,
        ...(binding ? {
          spaceId: binding.spaceId,
          projectId: binding.projectId,
          local: binding.local,
          url: binding.url,
          connected: binding.connected,
          opens: binding.opens,
          resumes: binding.resumes,
          link: linkDiag(binding.endpoint),
          keys: [...binding.keys].sort(),
          ...binding.ledger.snapshot(),
        } : {}),
        notices: notices.slice(),
      };
    },

    close() {
      unbindCurrent('close');
    },
  };
}

export default createCardSync;
