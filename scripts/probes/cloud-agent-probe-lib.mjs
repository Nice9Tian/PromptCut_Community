/**
 * 云端 Agent 两个端到端探针(`cloud-agent-isolation-probe.mjs`、`cloud-agent-ux-probe.mjs`)共用的搭法。
 *
 * 全部是**真进程、真握手**:托管组合(文档 + 素材)是 `server/hosted/main.mjs` 起的进程,本机信任关着(与云节点同样的配置);
 * Agent 服务是 `server/agent-service/main.mjs` 起的进程,凭 keygen 生成的服务私钥连文档服务的控制连接;成员由 Node 里的
 * WebSocket 扮演(真口令握手、真向文档服务要委托票据与对话委托);模型是仓库里的模拟模型提供方(照提示词里的脚本走)。
 * 只绑 127.0.0.1,数据全在调用方给的临时目录里;不连任何远端。不打印口令、票据、私钥。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildAuthProtocols, deriveKey, adminProof } from '../../server/auth/client.mjs';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const KDF = { alg: 'pbkdf2-sha256', iter: 100_000 };
export const sleep = delay;

export async function waitFor(fn, ms, what, every = 100) {
  const until = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > until) throw new Error(`等「${what}」超时(${ms} ms)`);
    await delay(every);
  }
}

/** 端口此刻有没有人在听 */
export async function portBusy(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/** 结束一个子进程的整棵树(Windows 上 `kill` 只结束它自己) */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } }
}

/** 起一个子进程,收它的输出(一行一条 JSON 的进 `logs`)。回 `{ child, logs, text(), exited, stop(), kill() }` */
export function startProcess(file, { env = {}, args = [], nodeArgs = [], ipc = false, cwd = ROOT } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, file, ...args], {
    cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  const logs = [];
  let raw = '';
  let tail = '';
  const take = (b) => {
    const s = b.toString('utf8');
    raw = (raw + s).slice(-200_000);
    const lines = (tail + s).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) { try { const j = JSON.parse(line); if (j && typeof j === 'object') logs.push(j); } catch { /* 不是 JSON 的行 */ } }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child, logs, exited,
    text: () => raw,
    /** 让它自己收尾;到时不退就结束整棵树 */
    async stop(ms = 8000) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { if (ipc && child.connected) child.send({ type: 'shutdown' }); else child.kill(); } catch { /* 已经没了 */ }
      const done = await Promise.race([exited.then(() => true), delay(ms).then(() => false)]);
      if (!done) { killTree(child.pid); await Promise.race([exited, delay(3000)]); }
    },
    /** 真的结束它(SIGKILL;Windows 上是 TerminateProcess),不给收尾的机会 */
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      await Promise.race([exited, delay(5000)]);
    },
  };
}

/** 托管组合(文档 + 素材)进程。`env` 里可以再加 `PROMPTCUT_AGENT_PUBLIC_URL` 等 */
export async function startHosted({ dataDir, docPort, assetPort, env = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = startProcess(path.join(ROOT, 'cloud', 'server', 'hosted', 'main.mjs'), {
    env: {
      PROMPTCUT_DATA_DIR: dataDir,
      PROMPTCUT_DOCSERVICE_PORT: String(docPort),
      PROMPTCUT_ASSET_PORT: String(assetPort),
      PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
      PROMPTCUT_TRUST_LOOPBACK: '0',
      PROMPTCUT_ASSET_PUBLIC_URL: `http://127.0.0.1:${assetPort}/api/asset`,
      // 只给这个临时实例用的随机令牌(关掉本机信任时必须有);探针自己不用它,不打印
      PROMPTCUT_CLUSTER_TOKEN: randomBytes(32).toString('base64url'),
      ...env,
    },
  });
  await waitFor(async () => {
    if (p.child.exitCode !== null) throw new Error('退出了');
    return (await fetch(`http://127.0.0.1:${docPort}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  }, 30_000, '托管组合监听').catch((err) => { throw new Error(`${err.message}:${p.text().slice(-600)}`); });
  return p;
}

/** Agent 服务进程(托管档,命令行入口)。数据目录里先写成用模拟模型提供方 */
export async function startAgent({ dataDir, secrets, docPort, port, env = {}, nodeArgs = ['--max-old-space-size=1536'] }) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(path.join(dataDir, 'config', 'ai.json'))) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'cloud', 'server', 'agent-service', 'set-key.mjs'), '--mock'], {
      cwd: ROOT, env: { ...process.env, PROMPTCUT_AGENT_DATA: dataDir }, windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`set-key --mock 失败:${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  const p = startProcess(path.join(ROOT, 'cloud', 'server', 'agent-service', 'main.mjs'), {
    nodeArgs, ipc: true,
    env: {
      PROMPTCUT_AGENT_DATA: dataDir,
      PROMPTCUT_AGENT_DOC_URL: `ws://127.0.0.1:${docPort}`,
      PROMPTCUT_AGENT_SECRETS: secrets,
      PROMPTCUT_AGENT_HOST: '127.0.0.1',
      PROMPTCUT_AGENT_PORT: String(port),
      ...env,
    },
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (p.child.exitCode !== null) throw new Error('退出了');
    return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok && p.logs.some((l) => l.event === 'service-client.up');
  }, 120_000, 'Agent 服务就绪', 200).catch((err) => { throw new Error(`${err.message}:${p.text().slice(-800)}`); });
  p.url = url;
  p.ready = p.logs.find((l) => l.event === 'agent.ready') ?? null;
  return p;
}

/* ------------------------------------------------------------------ 成员一侧的连接 */

let reqSeq = 0;
/** 一条到文档服务的 WebSocket:`ask` 按 reqId 等回包;`closed` 给关闭码与原因 */
export function wsOpen(base, protocols) {
  const ws = new WebSocket(base, protocols);
  const all = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    all.push(m);
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const opened = new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true), { once: true });
    ws.addEventListener('error', () => resolve(false), { once: true });
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true }));
  const c = {
    ws, all, opened, closed,
    next(match, ms = 8000) {
      const hit = all.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve({ type: 'timeout' }); } }, ms).unref?.();
      });
    },
    ask(message, ms = 8000) {
      const reqId = `cap-${(reqSeq += 1)}`;
      try { ws.send(JSON.stringify({ ...message, reqId })); } catch { return Promise.resolve({ type: 'error', reason: 'closed' }); }
      return Promise.race([c.next((m) => m.reqId === reqId, ms), closed.then(() => ({ type: 'error', reason: 'closed' }))]);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}

let devSeq = 0;
export const newDevice = (name) => ({ deviceId: `cap-${process.pid}-${(devSeq += 1)}-${randomBytes(6).toString('hex')}`, deviceName: name });

/** 成员(或创建者)用口令进项目,回页面连接(带 `userId`、`device`);进不去回 null */
export async function joinAs(base, proj, { username, password, as = 'member', device = newDevice(`${username}-pc`) }) {
  let protocols;
  try {
    protocols = await buildAuthProtocols({ base, projectId: proj.projectId, username, deviceId: device.deviceId, deviceName: device.deviceName, as, password, role: 'page' });
  } catch { return null; }
  const c = wsOpen(base, protocols);
  if (!(await c.opened)) return null;
  Object.assign(c, { device, username, userId: `${username}@${device.deviceId}`, projectId: proj.projectId });
  return c;
}

/** 创建者操作:同一条连接取挑战、算证明、发 shared.admin */
export async function adminOp(creator, proj, op, fields = {}) {
  const ch = await creator.ask({ type: 'shared.challenge' });
  if (ch.type !== 'shared.challenge.ok') return ch;
  const key = await deriveKey(proj.creator.password, ch.salt, ch.kdf);
  const m = await adminProof({ key, projectId: proj.projectId, username: proj.creator.username, op, nonce: ch.nonce });
  return creator.ask({ type: 'shared.admin', op, ...fields, proof: { nonce: ch.nonce, m } });
}

/** 读项目当前内容(大项目分片下发时拼起来)。回 `{ rev, project, by }` */
export async function projectOf(c, docId) {
  const st = await c.ask({ type: 'project.open', projectId: docId });
  if (st.type !== 'project.state') return { rev: null, project: null, error: st.reason ?? st.type };
  let project = st.project;
  if (project === undefined && Number.isSafeInteger(st.parts)) {
    await c.next((m) => m.type === 'project.state.end' && m.rev === st.rev, 8000);
    const parts = c.all.filter((m) => m.type === 'project.state.part' && m.rev === st.rev).sort((x, y) => x.index - y.index);
    project = JSON.parse(parts.map((m) => m.data).join(''));
  }
  return { rev: st.rev, project, by: st.by ?? st.lastWriter ?? null, state: st };
}

export async function putProject(c, docId, project) {
  const r = await c.ask({ type: 'project.op', projectId: docId, opId: `seed-${randomBytes(4).toString('hex')}`, session: 's-seed', ops: [{ op: 'set', path: '', value: project }] }, 20_000);
  if (r.type !== 'project.op.ok') throw new Error(`放项目内容失败:${JSON.stringify(r).slice(0, 200)}`);
  return r.rev;
}

/* ------------------------------------------------------------------ 页面打 Agent 服务 */

export const mockScript = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;

/** 页面向文档服务要委托票据(2 分钟)或对话委托(60 分钟,带对话 id);要不到回 `{ ticket: null, reason }` */
export async function delegationOf(page, conversation) {
  const r = await page.ask({ type: 'auth.ticket', kind: 'delegate', audience: 'agent', ...(conversation ? { conversation } : {}) });
  return r.type === 'auth.ticket.ok' ? { ticket: r.ticket, exp: r.exp } : { ticket: null, reason: r.reason ?? r.type };
}

/**
 * 一位成员的页面打 Agent 服务用的小客户端:每个请求现取一张委托票据放进 `Authorization`(与在线页面相同)。
 * `bearer` 给了就用它(测伪造、过期的票据)。
 */
export function agentApi(agentUrl, page) {
  const tokenOf = async (bearer) => bearer ?? (await delegationOf(page)).ticket ?? 'none';
  const api = {
    async call(method, pathname, { body, bearer } = {}) {
      const res = await fetch(`${agentUrl}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${await tokenOf(bearer)}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      let json = null;
      try { json = await res.json(); } catch { /* 不是 JSON */ }
      return { status: res.status, ...(json ?? {}) };
    },
    /** 发一条消息:现取这一轮的对话委托随消息带上。`grant` 给了就用它(测不对的委托);`null` 表示不带 */
    async send(conversationId, prompt, { grant, bearer, extra = {} } = {}) {
      const g = grant === undefined ? (await delegationOf(page, conversationId)).ticket : grant;
      return api.call('POST', `/v1/conversations/${conversationId}/messages`, { bearer, body: { prompt, ...(g ? { grant: g } : {}), ...extra } });
    },
    /** 读事件流到 `until(事件, 已收到的)` 为真(缺省到 end),或到时限。回 `{ status, events, done }` */
    async events(conversationId, { after = 0, until = (e) => e.type === 'end', ms = 60_000, bearer, onEvent, page = null } = {}) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      const out = [];
      let done = false;
      let status = 0;
      try {
        // `page`:这张「页面」的页面号(反向通道,契约第 28 节)
        const res = await fetch(`${agentUrl}/v1/conversations/${conversationId}/events?after=${after}${page ? `&page=${page}` : ''}`, { headers: { Authorization: `Bearer ${await tokenOf(bearer)}`, Accept: 'text/event-stream' }, signal: ctl.signal });
        status = res.status;
        if (status !== 200) return { status, events: out, done: false };
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        outer: for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!chunk.startsWith('data: ')) continue;
            const ev = JSON.parse(chunk.slice(6));
            ev._at = Date.now();
            out.push(ev);
            onEvent?.(ev);
            if (until(ev, out)) { done = true; await reader.cancel().catch(() => {}); break outer; }
          }
        }
      } catch { /* 到时限或服务没了 */ } finally { clearTimeout(timer); }
      return { status, events: out, done };
    },
    meta: (conversationId, o) => api.call('GET', `/v1/conversations/${conversationId}`, o),
    list: (o) => api.call('GET', '/v1/conversations', o),
    info: (o) => api.call('GET', '/v1/info', o),
    abort: (conversationId, o) => api.call('POST', `/v1/conversations/${conversationId}/abort`, o),
    /** 等这个对话不在跑了(看 meta,不开事件流:不让「等」这件事被算成发起方在线) */
    async settled(conversationId, ms = 60_000) {
      return waitFor(async () => { const m = await api.meta(conversationId); return m.status === 200 && m.meta.state !== 'running' ? m.meta : null; }, ms, `对话 ${conversationId} 收尾`, 150);
    },
  };
  return api;
}

/** 结果收集:一行一条 JSON 打到标准输出 */
export function createChecks() {
  const results = [];
  return {
    results,
    check(name, ok, detail = {}) {
      const line = { check: name, ok: !!ok, ...detail };
      results.push(line);
      process.stdout.write(`${JSON.stringify(line)}\n`);
      return !!ok;
    },
  };
}

/** 递归读目录下全部文件的文本(找有没有不该落盘的东西) */
export function readTree(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) out += readTree(p);
    else { try { out += `\n${fs.readFileSync(p, 'utf8')}`; } catch { /* 读不了的跳过 */ } }
  }
  return out;
}
