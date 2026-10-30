/**
 * 用量记录(契约 `docs/plan/cloud-agent-contract.md` 第 6.3 节)。
 *
 *   usage/<yyyy-mm>.jsonl   每次模型请求一行,追加写,0600(`shared` 时 0640,见下)。不含提示词、回复、工具参数、Key
 *   usage/totals.json       各项目、各成员的累计(检查点):定时落、退出时落;起来时用它加上之后的流水重建,
 *                           坏了就从流水全量重算
 *
 * 一行的形状:
 *   {"t":毫秒,"projectId":"…","userId":"…","username":"…","conversationId":"…","runId":"…",
 *    "vendor":"…","model":"…","input":N,"output":N,"cacheRead":N,"ok":true,"ms":N}
 *
 * 要花钱的外部调用(配音等,用托管方的配置)也各记一行,多四个字段,token 数是 0、不占额度:
 *   {…同上…,"kind":"service","service":"voice","units":N,"unit":"chars"}
 * `vendor` 是服务商,`model` 是它的型号;`units` 是这次的计量(配音按字数)。汇总里单列在 `services` 下,不混进模型的调用次数。
 *
 * 额度按「输入加输出的 token 数」算(`cacheRead` 已含在 `input` 里,只是看命中率用)。窗口按 UTC:累计、当月、当天。
 *
 * 权限:缺省目录 0700、文件 0600(只有写它的那个用户读得到)。账号模式下写的是任务进程、读的是主服务(`GET /v1/usage`),
 * 两者是两个系统用户、同在一个组里:建的时候给 `shared: true`,目录 0750、流水 0640(组内只读),已有的目录和流水也补上组内可读。
 * 累计检查点(`totals.json`)只有写的一方用,仍是 0600。
 * 读不到流水时,`queryUsage` 的 `strict` 档抛 `usage-unreadable`,不拿空结果冒充「没有用量」。
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function emptyBucket() {
  return { total: { tokens: 0, calls: 0 }, month: { key: '', tokens: 0, calls: 0 }, day: { key: '', tokens: 0, calls: 0 } };
}

function add(bucket, t, tokens) {
  bucket.total.tokens += tokens;
  bucket.total.calls += 1;
  const m = monthOf(t);
  if (bucket.month.key !== m) bucket.month = { key: m, tokens: 0, calls: 0 };
  bucket.month.tokens += tokens;
  bucket.month.calls += 1;
  const d = dayOf(t);
  if (bucket.day.key !== d) bucket.day = { key: d, tokens: 0, calls: 0 };
  bucket.day.tokens += tokens;
  bucket.day.calls += 1;
}

/** 把一行流水整理成规定的字段(多的丢掉:正文之类不会经这里落盘) */
export function usageRow(row, now = Date.now()) {
  return {
    t: Number.isFinite(row?.t) ? row.t : now,
    projectId: String(row?.projectId ?? ''),
    userId: String(row?.userId ?? ''),
    username: String(row?.username ?? ''),
    conversationId: String(row?.conversationId ?? ''),
    runId: String(row?.runId ?? ''),
    vendor: String(row?.vendor ?? ''),
    model: String(row?.model ?? ''),
    input: num(row?.input),
    output: num(row?.output),
    cacheRead: num(row?.cacheRead),
    ok: row?.ok !== false,
    ms: num(row?.ms),
    ...(row?.kind === 'service' ? {
      kind: 'service',
      service: String(row?.service ?? '').slice(0, 32),
      units: num(row?.units),
      unit: String(row?.unit ?? '').slice(0, 16),
    } : {}),
  };
}

/** 这一行是不是外部服务的调用(不是模型请求) */
const isServiceRow = (r) => r?.kind === 'service';

const unreadable = (what, error) => Object.assign(new Error(`usage-unreadable: ${what}`), { code: 'usage-unreadable', cause: error, errno: typeof error?.code === 'string' ? error.code : 'error' });

/** 读一个流水文件里从 `from` 字节起的整行;回 `{ rows, bytes }`(`bytes` 是读到的最后一个整行的末尾)。`strict`:文件在但读不了就抛,不当成空的 */
function readRows(file, from = 0, { strict = false } = {}) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw unreadable('file', error);
    return { rows: [], bytes: 0 };
  }
  if (from > buf.length) from = 0;
  const end = buf.lastIndexOf(0x0a);
  if (end < from) return { rows: [], bytes: from };
  const rows = [];
  for (const line of buf.subarray(from, end).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return { rows, bytes: end + 1 };
}

/** `strict`:目录在但列不了就抛。目录还不存在(这台节点还没有任务进程起来过)是「确实没有流水」,回空 */
function listFiles(dir, { strict = false } = {}) {
  try { return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw unreadable('directory', error);
    return [];
  }
}

/**
 * 按条件汇总流水(给 `GET /v1/usage` 与 `admin.mjs usage` 用,读文件,不读内存里的累计)。
 * @param {string} dir `usage/` 目录
 * @param {{ projectId?: string | null, since?: number | null, strict?: boolean }} [q] `strict`:流水目录或文件在但读不到时抛 `usage-unreadable`
 *   (读的一方和写的一方不是同一个用户时用:读不到不等于没有用量)
 * @returns {{ calls: number, tokens: number, projects: Record<string, { tokens: number, calls: number, input: number, output: number,
 *   members: Record<string, { username: string, tokens: number, calls: number }>, models: Record<string, { tokens: number, calls: number }> }>, rows: object[] }}
 */
export function queryUsage(dir, { projectId = null, since = null, strict = false } = {}) {
  const out = { calls: 0, tokens: 0, projects: {}, rows: [] };
  const sinceMonth = Number.isFinite(since) ? monthOf(since) : null;
  for (const name of listFiles(dir, { strict })) {
    if (sinceMonth && name.slice(0, 7) < sinceMonth) continue;
    for (const r of readRows(path.join(dir, name), 0, { strict }).rows) {
      if (projectId && r.projectId !== projectId) continue;
      if (Number.isFinite(since) && !(r.t >= since)) continue;
      const tokens = num(r.input) + num(r.output);
      const p = (out.projects[r.projectId] ??= { tokens: 0, calls: 0, input: 0, output: 0, members: {}, models: {} });
      if (isServiceRow(r)) {
        // 外部服务的调用单列:按「服务 / 服务商」累计次数与计量,另按成员累计次数
        const sk = `${r.service}/${r.vendor}`;
        const sv = ((p.services ??= {})[sk] ??= { calls: 0, units: 0, unit: r.unit ?? '', members: {} });
        sv.calls += 1; sv.units += num(r.units);
        const sm = (sv.members[r.userId] ??= { username: r.username ?? '', calls: 0, units: 0 });
        sm.calls += 1; sm.units += num(r.units);
        out.rows.push(r);
        continue;
      }
      p.tokens += tokens; p.calls += 1; p.input += num(r.input); p.output += num(r.output);
      const m = (p.members[r.userId] ??= { username: r.username ?? '', tokens: 0, calls: 0 });
      m.tokens += tokens; m.calls += 1;
      const mk = `${r.vendor}/${r.model}`;
      const mo = (p.models[mk] ??= { tokens: 0, calls: 0 });
      mo.tokens += tokens; mo.calls += 1;
      out.calls += 1; out.tokens += tokens;
      out.rows.push(r);
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {string | null} o.dir `usage/` 目录;null 时只在内存里记(测试)
 * @param {boolean} [o.shared] 流水要给同组的另一个用户读(账号模式:任务进程写、主服务读)。见文件头「权限」
 */
export function createUsageLog({ dir = null, now = () => Date.now(), flushMs = 30_000, log = () => {}, shared = false } = {}) {
  const dirMode = shared ? 0o750 : 0o700;
  const rowsMode = shared ? 0o640 : 0o600;
  /** `shared` 时把已有的目录、流水补成组内可读(以前按 0700 / 0600 建的;进程的 umask 比预期严时新建的也会少给) */
  const share = (target, bits) => {
    if (!shared) return;
    try { const mode = fs.statSync(target).mode & 0o7777; if ((mode & bits) !== bits) fs.chmodSync(target, mode | bits); }
    catch (err) { log('agent.usage.share-failed', { message: String(err?.message ?? err).slice(0, 120) }); }
  };
  /** projectId → { ...bucket, members: Map(userId → bucket) } */
  const projects = new Map();
  /** 流水文件名 → 已经折进累计的字节数 */
  const offsets = {};
  let dirty = false;
  const totalsFile = dir ? path.join(dir, 'totals.json') : null;

  function fold(r) {
    if (isServiceRow(r)) return; // 外部服务的调用不占 token 额度,不进这份累计(汇总时从流水读)
    const tokens = num(r.input) + num(r.output);
    const t = Number.isFinite(r.t) ? r.t : now();
    let p = projects.get(r.projectId);
    if (!p) { p = { ...emptyBucket(), members: new Map() }; projects.set(r.projectId, p); }
    add(p, t, tokens);
    let m = p.members.get(r.userId);
    if (!m) { m = emptyBucket(); p.members.set(r.userId, m); }
    add(m, t, tokens);
  }

  function rebuild(fromScratch) {
    if (!dir) return;
    if (fromScratch) { projects.clear(); for (const k of Object.keys(offsets)) delete offsets[k]; }
    for (const name of listFiles(dir)) {
      const { rows, bytes } = readRows(path.join(dir, name), offsets[name] ?? 0);
      for (const r of rows) fold(r);
      offsets[name] = bytes;
      // 上次进程在写一行的半路被杀:末尾留着没写完的半行。补一个换行把它隔开(那半行解析不了,会被跳过),之后的行不受它连累
      try {
        const size = fs.statSync(path.join(dir, name)).size;
        if (size > bytes) { fs.appendFileSync(path.join(dir, name), '\n'); offsets[name] = size + 1; }
      } catch { /* 文件刚被拿走 */ }
    }
  }

  function loadTotals() {
    if (!totalsFile) return;
    let ok = false;
    try {
      const saved = JSON.parse(fs.readFileSync(totalsFile, 'utf8'));
      if (saved?.v === 1 && saved.files && typeof saved.files === 'object' && saved.projects && typeof saved.projects === 'object') {
        for (const [name, bytes] of Object.entries(saved.files)) {
          let size = -1;
          try { size = fs.statSync(path.join(dir, name)).size; } catch { /* 文件没了 */ }
          if (!Number.isSafeInteger(bytes) || bytes > size) throw new Error('检查点比流水新');
          offsets[name] = bytes;
        }
        for (const [id, p] of Object.entries(saved.projects)) {
          projects.set(id, { total: p.total, month: p.month, day: p.day, members: new Map(Object.entries(p.members ?? {})) });
        }
        ok = true;
      }
    } catch (err) {
      if (fs.existsSync(totalsFile)) log('agent.usage.totals-rebuild', { reason: String(err?.message ?? err).slice(0, 80) });
    }
    rebuild(!ok);
  }

  function flush() {
    if (!totalsFile || !dirty) return;
    dirty = false;
    try {
      const body = { v: 1, at: now(), files: { ...offsets }, projects: {} };
      for (const [id, p] of projects) body.projects[id] = { total: p.total, month: p.month, day: p.day, members: Object.fromEntries(p.members) };
      const tmp = `${totalsFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, totalsFile);
    } catch (err) {
      log('agent.usage.flush-failed', { message: String(err?.message ?? err).slice(0, 120) });
    }
  }

  if (dir) {
    fs.mkdirSync(dir, { recursive: true, mode: dirMode });
    share(dir, 0o050);
    for (const name of listFiles(dir)) share(path.join(dir, name), 0o040);
    loadTotals();
  }
  const timer = dir ? setInterval(flush, flushMs) : null;
  timer?.unref?.();

  const usedOf = (bucket, window, at) => {
    if (!bucket) return 0;
    if (window === 'month') return bucket.month.key === monthOf(at) ? bucket.month.tokens : 0;
    if (window === 'day') return bucket.day.key === dayOf(at) ? bucket.day.tokens : 0;
    return bucket.total.tokens;
  };

  return {
    dir,

    /** 记一次模型请求:先落流水,再进累计 */
    append(rowIn) {
      const row = usageRow(rowIn, now());
      if (dir) {
        const name = `${monthOf(row.t)}.jsonl`;
        const text = `${JSON.stringify(row)}\n`;
        try {
          const fresh = shared && !fs.existsSync(path.join(dir, name));
          fs.appendFileSync(path.join(dir, name), text, { encoding: 'utf8', mode: rowsMode });
          if (fresh) share(path.join(dir, name), 0o040);
          offsets[name] = (offsets[name] ?? 0) + Buffer.byteLength(text);
        } catch (err) {
          log('agent.usage.append-failed', { message: String(err?.message ?? err).slice(0, 120) });
        }
      }
      fold(row);
      dirty = true;
      return row;
    },

    /** 这个项目在这个窗口里已经用了多少 token */
    used(projectId, window = 'total', at = now()) {
      return usedOf(projects.get(projectId), window, at);
    },

    /** 这个项目的总量与各成员的量:有流水就读流水(带用户名、认 `since`),没有(只在内存里记)读内存里的累计 */
    summary(projectId, since = null) {
      if (dir) {
        const q = queryUsage(dir, { projectId, since }).projects[projectId];
        return {
          project: { tokens: q?.tokens ?? 0, calls: q?.calls ?? 0 },
          members: Object.entries(q?.members ?? {}).map(([userId, m]) => ({ userId, username: m.username, tokens: m.tokens, calls: m.calls })),
          services: Object.entries(q?.services ?? {}).map(([key, s]) => ({
            service: key.split('/')[0], vendor: key.split('/').slice(1).join('/'), calls: s.calls, units: s.units, unit: s.unit,
            members: Object.entries(s.members).map(([userId, m]) => ({ userId, username: m.username, calls: m.calls, units: m.units })),
          })),
        };
      }
      const p = projects.get(projectId);
      return {
        project: { tokens: p?.total.tokens ?? 0, calls: p?.total.calls ?? 0 },
        members: p ? [...p.members].map(([userId, m]) => ({ userId, tokens: m.total.tokens, calls: m.total.calls })) : [],
      };
    },

    flush,

    close() {
      if (timer) clearInterval(timer);
      flush();
    },
  };
}
