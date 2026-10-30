/**
 * 云端对话的状态(契约 `docs/plan/cloud-agent-contract.md` 第 2.4、7 节):存在节点上,不依赖发起方的连接。
 *
 * 每个对话一个目录 `tenants/<projectId>/owners/<主人键>/conversations/<对话 id>/`,这里管其中两个文件:
 *   meta.json      标题、状态、lastSeq、最近一轮的 runId、起止时刻、结束原因、发起设备名(临时文件加改名)
 *   events.jsonl   事件记录:每个事件追加一行,带递增的 `seq`(每个对话从 1 起,跨轮连续)
 * (`history.json` 由驱动写,`pending-render.json` 由 `render-request.mjs` 写。)
 *
 * **事件先存后发**:`emit` 先把事件追加进文件,再发给此刻连着的流。没有任何流连着,事件照样记。
 * **补发与实时无缺无重**:`subscribe` 在同一拍里(同步地)先把 `seq` 大于 `after` 的补发、再把回调挂进实时名单,
 * 而 `emit` 也是同步的,两者之间插不进任何事件。
 *
 * `text`、`thinking` 的增量在一轮结束时在记录里合并成整段(`compact`),免得记录被逐字的增量撑大:合并后的一行是
 * `{ …, delta: <整段>, fromSeq, seq: <最后一个的 seq>, cuts: [每个增量的字符数] }`。补发时按 `cuts` 拆回原来的一个个增量,
 * 所以看的人拿到的事件与实时流逐事件相同,`seq` 仍然连续——合并只是存法,不改变接口。
 *
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONVERSATION_STORE_DEFAULTS = Object.freeze({
  /** 事件记录到这么大就不再记 thinking 与 diagnostic */
  degradeBytes: 8 * 1024 * 1024,
  /** 再到这么大这个对话不能再发消息 */
  capBytes: 12 * 1024 * 1024,
  /** 每个主人每个项目最多这么多个对话,满了不让新建、也不自动删历史(2026-10-08 用户定);要新建先由主人自己删旧的 */
  maxPerOwner: 50,
  /** 内存里最多留这么多个没人看、不在跑的对话(别的用到时再从盘上读) */
  maxLoadedIdle: 32,
  /** 没有数据目录(只在内存里)时每个对话最多留多少条 */
  maxEventsInMemory: 5000,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEGRADED_TYPES = new Set(['thinking', 'diagnostic']);
const MERGE_TYPES = new Set(['text', 'thinking']);

export const INTERRUPTED_MESSAGE = '云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。';

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 两个事件除了 delta 与序号之外是否相同(能不能并成一段) */
function sameShape(a, b) {
  const ka = Object.keys(a).filter((k) => k !== 'delta' && k !== 'seq' && k !== 'fromSeq' && k !== 'cuts');
  const kb = Object.keys(b).filter((k) => k !== 'delta' && k !== 'seq' && k !== 'fromSeq' && k !== 'cuts');
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** 把记录里的一行拆回实时流里的那些事件 */
export function* expandEntry(entry) {
  if (!Array.isArray(entry.cuts)) { yield entry; return; }
  const { cuts, fromSeq, delta, seq: _last, ...rest } = entry;
  let off = 0;
  for (let i = 0; i < cuts.length; i += 1) {
    yield { ...rest, delta: delta.slice(off, off + cuts[i]), seq: fromSeq + i };
    off += cuts[i];
  }
}

/** 把相邻的 text / thinking 增量并成整段(已经并过的也能接着并);回新数组 */
export function mergeDeltas(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && MERGE_TYPES.has(e.type) && prev.type === e.type && typeof e.delta === 'string' && typeof prev.delta === 'string' && sameShape(prev, e)) {
      const prevFrom = prev.fromSeq ?? prev.seq;
      const eFrom = e.fromSeq ?? e.seq;
      if (eFrom === prev.seq + 1) {
        out[out.length - 1] = {
          ...prev,
          delta: prev.delta + e.delta,
          fromSeq: prevFrom,
          seq: e.seq,
          cuts: [...(prev.cuts ?? [prev.delta.length]), ...(e.cuts ?? [e.delta.length])],
        };
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * @param {object} o
 * @param {string | null} o.dataDir 数据目录;null 时只在内存里(进程一退就没了,只给不落盘的测试用)
 */
export function createConversationStore({ dataDir = null, now = () => Date.now(), limits: limitsIn = {}, log = () => {} } = {}) {
  const limits = { ...CONVERSATION_STORE_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响对话 */ } };
  /** 「项目\n主人键\n对话 id」→ 对话 */
  const loaded = new Map();

  const keyOf = (projectId, ownerKey, id) => `${projectId}\n${ownerKey}\n${id}`;
  /** 项目号与主人键要当目录名用:只收不会走出 `tenants/` 的 */
  const seg = (name) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(name) || /^\.+$/.test(name)) throw new Error('不能当目录名的标识');
    return name;
  };
  const ownerDir = (projectId, ownerKey) => path.join(dataDir, 'tenants', seg(projectId), 'owners', seg(ownerKey), 'conversations');
  const dirOf = (projectId, ownerKey, id) => path.join(ownerDir(projectId, ownerKey), id);

  function readMeta(dir) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      return m && typeof m === 'object' && typeof m.id === 'string' ? m : null;
    } catch {
      return null;
    }
  }

  /** 读事件记录。末尾没写完的半行(进程被杀时留下的)丢掉,并把文件截到最后一个整行 */
  function readEvents(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return { entries: [], bytes: 0 }; }
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end < buf.length) {
      try { fs.truncateSync(file, end); } catch { /* 截不了也照常读 */ }
    }
    const entries = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && Number.isSafeInteger(e.seq)) entries.push(e);
      } catch { /* 坏行跳过 */ }
    }
    return { entries, bytes: end };
  }

  function saveMeta(conv) {
    conv.meta.lastSeq = conv.seq;
    conv.meta.updatedAt = now();
    if (!dataDir) return;
    try {
      fs.mkdirSync(conv.dir, { recursive: true, mode: 0o700 });
      writeJson(path.join(conv.dir, 'meta.json'), conv.meta);
    } catch (err) {
      say('agent.conversation.meta-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  function closeFd(conv) {
    if (conv.fd === null) return;
    try { fs.closeSync(conv.fd); } catch { /* 已经关了 */ }
    conv.fd = null;
  }

  function trimLoaded() {
    const idle = [...loaded.values()].filter((c) => !c.run && c.listeners.size === 0 && !c.pinned);
    if (idle.length <= limits.maxLoadedIdle) return;
    idle.sort((a, b) => a.touched - b.touched);
    for (const c of idle.slice(0, idle.length - limits.maxLoadedIdle)) {
      if (!dataDir) continue; // 只在内存里的丢了就没了,不丢
      closeFd(c);
      loaded.delete(c.key);
    }
  }

  /** 满额:不删任何对话,新建的人拿到带 `code: 'conversation-limit'` 的错误(服务层译成 409) */
  function assertRoomForNew(projectId, ownerKey) {
    if (listMetas(projectId, ownerKey).length < limits.maxPerOwner) return;
    throw Object.assign(new Error('conversation-limit'), { code: 'conversation-limit' });
  }

  function listMetas(projectId, ownerKey) {
    const byId = new Map();
    if (dataDir) {
      let names = [];
      try { names = fs.readdirSync(ownerDir(projectId, ownerKey)); } catch { /* 还没有任何对话 */ }
      for (const name of names) {
        if (!ID_RE.test(name)) continue;
        const m = readMeta(dirOf(projectId, ownerKey, name));
        if (m && m.id === name) byId.set(name, m);
      }
    }
    for (const c of loaded.values()) {
      if (c.projectId === projectId && c.ownerKey === ownerKey) byId.set(c.id, { ...c.meta, lastSeq: c.seq });
    }
    return [...byId.values()];
  }

  /**
   * 取一个对话;没有且 `create` 时新建。对话 id 先过字符集检查(它是磁盘路径的最后一段)。
   * @returns {object | null}
   */
  function get(projectId, ownerKey, id, { create = false, startedOn = null } = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const key = keyOf(projectId, ownerKey, id);
    let conv = loaded.get(key);
    if (conv) { conv.touched = now(); return conv; }
    const dir = dataDir ? dirOf(projectId, ownerKey, id) : null;
    let meta = dir ? readMeta(dir) : null;
    if (!meta && !create) return null;
    let entries = [];
    let bytes = 0;
    const fresh = !meta;
    if (meta) {
      ({ entries, bytes } = readEvents(path.join(dir, 'events.jsonl')));
    } else {
      assertRoomForNew(projectId, ownerKey);
      meta = { v: 1, id, title: '', state: 'idle', reason: null, message: null, lastSeq: 0, runId: null, startedAt: null, endedAt: null, startedOn, createdAt: now(), updatedAt: now() };
    }
    conv = {
      key, id, projectId, ownerKey, dir, meta,
      /** 记录里的行(合并过的带 fromSeq / cuts) */
      entries,
      seq: entries.length ? entries[entries.length - 1].seq : 0,
      bytes,
      fd: null,
      /** 实时名单:{ cb, userId } */
      listeners: new Set(),
      /** 进行中的一轮(由服务管):{ runId, userId, stop(kind, detail) } */
      run: null,
      pinned: false,
      touched: now(),
    };
    loaded.set(key, conv);
    if (fresh) saveMeta(conv);
    trimLoaded();
    return conv;
  }

  /** 事件先记下来,再发给此刻连着的流。记录降级后被丢掉的事件回 null(既不记也不发) */
  function emit(conv, event) {
    if (conv.bytes >= limits.degradeBytes && DEGRADED_TYPES.has(event.type)) return null;
    const ev = { ...event, seq: conv.seq + 1 };
    if (dataDir) {
      const line = `${JSON.stringify(ev)}\n`;
      try {
        if (conv.fd === null) {
          fs.mkdirSync(conv.dir, { recursive: true, mode: 0o700 });
          conv.fd = fs.openSync(path.join(conv.dir, 'events.jsonl'), 'a', 0o600);
        }
        fs.writeSync(conv.fd, line);
        conv.bytes += Buffer.byteLength(line);
      } catch (err) {
        say('agent.conversation.append-failed', { message: String(err?.message ?? err).slice(0, 120) });
      }
    } else if (conv.entries.length >= limits.maxEventsInMemory) {
      conv.entries.splice(0, conv.entries.length - limits.maxEventsInMemory + 1);
    }
    conv.seq = ev.seq;
    conv.entries.push(ev);
    conv.touched = now();
    for (const l of [...conv.listeners]) {
      try { l.cb(ev); } catch { /* 一条流坏了不影响别的 */ }
    }
    return ev;
  }

  /**
   * 看一个对话:先补发 `seq` 大于 `after` 的,再接实时的(同一拍里切换)。回退订函数。
   * @param {{ userId?: string, pageId?: string | null }} [who] 谁在看(判「发起方在线」用);`pageId` 是那张页面自报的页面号
   *   (反向通道只认发起这一轮的那一张,契约第 28 节)
   */
  function subscribe(conv, after, cb, who = {}) {
    const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
    for (const entry of conv.entries) {
      if (entry.seq <= from) continue;
      for (const ev of expandEntry(entry)) if (ev.seq > from) cb(ev);
    }
    const l = { cb, userId: who.userId ?? null, pageId: who.pageId ?? null };
    conv.listeners.add(l);
    conv.touched = now();
    const off = () => { conv.listeners.delete(l); };
    // 这条流在实时名单里的那一项(服务据它认「发给哪条流的请求」)
    off.listener = l;
    return off;
  }

  /** 改状态并落 `meta.json` */
  function setState(conv, patch) {
    Object.assign(conv.meta, patch);
    saveMeta(conv);
  }

  /** 一轮结束后:把增量并成整段,重写事件记录 */
  function compact(conv) {
    const merged = mergeDeltas(conv.entries);
    if (merged.length === conv.entries.length) { closeFd(conv); return; }
    conv.entries = merged;
    if (!dataDir) return;
    closeFd(conv);
    try {
      const file = path.join(conv.dir, 'events.jsonl');
      const text = merged.map((e) => `${JSON.stringify(e)}\n`).join('');
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      conv.bytes = Buffer.byteLength(text);
    } catch (err) {
      say('agent.conversation.compact-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  /** 删一个对话:事件记录、状态、模型历史、预渲染重试清单一起删 */
  function remove(conv) {
    closeFd(conv);
    for (const l of [...conv.listeners]) conv.listeners.delete(l);
    loaded.delete(conv.key);
    if (conv.dir) {
      try { fs.rmSync(conv.dir, { recursive: true, force: true }); } catch (err) { say('agent.conversation.remove-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
    }
  }

  /** 走一遍盘上所有对话的目录 */
  function* walk() {
    if (!dataDir) return;
    const tenants = path.join(dataDir, 'tenants');
    let projects = [];
    try { projects = fs.readdirSync(tenants); } catch { return; }
    for (const projectId of projects) {
      let owners = [];
      try { owners = fs.readdirSync(path.join(tenants, projectId, 'owners')); } catch { continue; }
      for (const ownerKey of owners) {
        let ids = [];
        try { ids = fs.readdirSync(ownerDir(projectId, ownerKey)); } catch { continue; }
        for (const id of ids) if (ID_RE.test(id)) yield { projectId, ownerKey, id, dir: dirOf(projectId, ownerKey, id) };
      }
    }
  }

  return {
    limits,
    get,
    emit,
    subscribe,
    setState,
    compact,
    remove,
    walk,

    dirOf: (projectId, ownerKey, id) => (dataDir ? dirOf(projectId, ownerKey, id) : null),

    /** 这个主人在这个项目里的对话,最近动过的在前 */
    list(projectId, ownerKey) {
      return listMetas(projectId, ownerKey).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },

    /** 这个对话还能不能再发消息(记录封顶) */
    full(conv) {
      return conv.bytes >= limits.capBytes;
    },

    /**
     * 进程起来时调(契约第 7.5 节):盘上状态还是 running 的对话,上一个进程没来得及收尾就没了——标成 interrupted,
     * 事件记录末尾补一条说明与 `end`。不自动续跑。回被标的对话数。
     */
    recover() {
      let n = 0;
      for (const at of walk()) {
        const meta = readMeta(at.dir);
        if (!meta || meta.state !== 'running') continue;
        const conv = get(at.projectId, at.ownerKey, at.id);
        if (!conv) continue;
        const runId = conv.meta.runId ?? null;
        emit(conv, { type: 'error', code: 'interrupted', runId, message: INTERRUPTED_MESSAGE });
        emit(conv, { type: 'end', runId, state: 'interrupted' });
        setState(conv, { state: 'interrupted', reason: 'interrupted', message: INTERRUPTED_MESSAGE, endedAt: now() });
        compact(conv);
        n += 1;
      }
      if (n) say('agent.conversation.recovered', { interrupted: n });
      return n;
    },

    /** 项目删除:这个项目下的对话记录与模型历史全删(用量记录是托管方的账,不在这里) */
    removeProject(projectId) {
      for (const c of [...loaded.values()]) {
        if (c.projectId !== projectId) continue;
        closeFd(c);
        loaded.delete(c.key);
      }
      if (!dataDir) return;
      try { fs.rmSync(path.join(dataDir, 'tenants', seg(projectId)), { recursive: true, force: true }); } catch (err) { say('agent.conversation.remove-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
    },

    /** 此刻载入内存的对话(诊断与收尾用) */
    loaded: () => [...loaded.values()],

    close() {
      for (const c of loaded.values()) closeFd(c);
      loaded.clear();
    },
  };
}
