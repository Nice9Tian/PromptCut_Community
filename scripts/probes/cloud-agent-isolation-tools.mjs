/**
 * 云端 Agent 隔离验收里「工具」的那几组(`cloud-agent-isolation-probe.mjs` 调;任务书 `docs/plan/cloud-agent-task.md` J 与完成条件第 4 条)。
 *
 * 用「越权探测」的办法(定义见 `docs/plan/sound-online-render-task.md` 文末「越权探测卡」一节):这是给我们自己的隔离做验收的
 * 防御性测试。探针让对话里的工具逐项**尝试**读写本不该碰到的东西,记下每一项「做成了 / 被拒了」,并事先在这些位置放好
 * **只属于测试的假凭证**(一眼能认出的占位字符串),断言一个都没被带回来。只读、只报告:不删、不改被探测的位置,
 * 不用任何真实凭证、真实项目、真实外部地址——「外部地址」是探针自己在本机回环上起的收集站,经出网闸的测试例外放行。
 *
 *   T1 素材写入按成员本人的权限:读写成员导入成功、别的成员凭自己的票据取得回同样的字节;只读成员写不进(不下载、不入库、项目不变);
 *      别的项目的素材读不到(知道哈希、直接打同机素材服务也被出网闸拒)。
 *   T2 工具的文件读写按「项目 × 对话」隔离:别的项目的工作目录、同一成员的另一个对话、Agent 服务的私钥与数据目录、
 *      托管服务的数据目录、系统文件——逐条读不到;带路径的附件名写不出自己的目录;工作目录里放一个指到外面的链接也出不去。
 *   T3 出网闸:本机回环、内网地址、169.254.169.254、同机的文档服务 / 素材服务 / Agent 服务自己 / 别的服务的端口,
 *      含换写法、经主机名指到本机、经放行地址重定向过去——全部被拒且根本没连过去;测试专用的外部地址能通(闸不是一刀切)。
 *   T4 花钱的调用记用量:替身配音服务收到一次请求,用量记录里有这一行(项目、成员、服务、计量);只读成员不花钱。
 *   T5 建卡改卡:卡片源码经内容库到别的成员;这张卡只在本项目里认得;只读成员建不了;卡片代码没有在 Agent 服务进程里执行。
 *   T6 音效合成与测响度:生成的音效只进本项目、别的成员取得到;另一个项目的对话看不到、查不到、取消不了这边的作业,量不了、
 *      重生成不了这边的素材与片段;只读成员生成不了;量完对话的工作目录里不留取来的素材。
 *      (卡片声音的代码不在 Agent 服务进程里执行,由 `cloud-agent-sound-probe.mjs` 的 S5 对着真的隔离工作进程验。)
 *   T7 网页采集(下载器是替身 `fixtures/cloud-collect/fake-collect.mjs`:说同一份命令行,只按环境里的代理出网):
 *      子进程的工作目录是对话的工作目录、环境里没有任何 `PROMPTCUT_*` 与假凭证;经出网闸的代理到得了测试专用的外部地址、
 *      到不了本机回环、内网、元数据地址与同机各服务(替身服务一次也没被连到);下载物入库后别的成员取得到同样的字节;
 *      只读成员在下载之前被拒;另一个项目的对话查不到这边的作业;记了用量。子进程不经代理自己去连、往工作目录以外写,
 *      代码这一层拦不住(靠节点上的非特权用户与系统级限制,见契约第 9.5、9.6 节),这里不断言。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sealKey } from '../../server/runners/config-crypt.mjs';
import { mockScript, sleep } from './cloud-agent-probe-lib.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 一张能认出宽高的小 PNG(文件头是真的,后面跟随机字节:每次哈希不同) */
export function tinyPng(width = 3, height = 2) {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, randomBytes(48)]);
}

function listen(port, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

/**
 * 起三个只在本机回环上的替身,并在 Agent 服务起来之前把假凭证与配音配置放好。
 * @returns {Promise<object>} 夹具;`env` 是要加给 Agent 服务进程的环境变量
 */
export async function prepareToolFixtures({ tmp, agentData, agentSecrets, hostedData, assetPort, collectorPort, voicePort, decoyPort }) {
  const tag = randomBytes(5).toString('hex');
  const FAKE = {
    secrets: `FAKE-CREDENTIAL-agent-secrets-${tag}`,
    agentData: `FAKE-CREDENTIAL-agent-data-${tag}`,
    hosted: `FAKE-CREDENTIAL-hosted-data-${tag}`,
    system: `FAKE-CREDENTIAL-system-file-${tag}`,
    otherProject: `FAKE-CREDENTIAL-other-project-${tag}`,
    otherConversation: `FAKE-CREDENTIAL-other-conversation-${tag}`,
    decoy: `FAKE-CREDENTIAL-local-service-${tag}`,
    voiceKey: `FAKE-VOICE-KEY-${tag}`,
  };
  // 假凭证:放在 Agent 服务的私钥目录、数据目录、托管服务的数据目录、一个「系统文件」里
  const planted = {
    secrets: path.join(agentSecrets, 'planted-credential.txt'),
    agentData: path.join(agentData, 'config', 'planted-credential.txt'),
    hosted: path.join(hostedData, 'planted-credential.txt'),
    system: path.join(tmp, 'system', 'planted-credential.txt'),
  };
  for (const [k, file] of Object.entries(planted)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${FAKE[k]}\n`);
  }
  // 托管方的配音配置:地址指到替身,令牌是假的(与真的同一套落盘加密)
  fs.mkdirSync(path.join(agentData, 'config', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(agentData, 'config', 'voice.json'), `${JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${voicePort}`, provider: 'minimax' }, null, 2)}\n`);
  fs.writeFileSync(path.join(agentData, 'config', 'keys', 'voice.key'), `${sealKey(FAKE.voiceKey, 'voice')}\n`);

  // 测试专用的外部地址(收集站):发来的请求全记下,最后查里面有没有假凭证
  const png = tinyPng();
  const pngForReadonly = tinyPng(5, 4);
  // 采集的下载器替身从这里「下」的那段片子(随机字节,每次哈希不同)
  const clip = randomBytes(6000);
  const received = [];
  const collector = await listen(collectorPort, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: JSON.stringify(req.headers), body: Buffer.concat(chunks).toString('latin1').slice(0, 4000) });
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/redir') { res.writeHead(302, { location: u.searchParams.get('to') ?? '/' }); return res.end(); }
      if (u.pathname === '/pixel.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }); return res.end(png); }
      if (u.pathname === '/readonly.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(pngForReadonly); }
      if (u.pathname === '/clip.mp4' || u.pathname === '/readonly.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(clip); }
      res.writeHead(404); res.end();
    });
  });
  // 同机的「别的服务」:一个只该本机用的接口,回的是假凭证。出网闸应当让工具一次都连不上它
  const decoyHits = [];
  const decoy = await listen(decoyPort, (req, res) => { decoyHits.push(req.url); res.end(FAKE.decoy); });
  // 替身配音服务
  const voiceCalls = [];
  const voice = await listen(voicePort, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 不是 JSON */ }
      voiceCalls.push({ path: req.url, keyOk: req.headers.authorization === `Bearer ${FAKE.voiceKey}`, chars: [...String(body.text ?? '')].length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: Buffer.concat([Buffer.from('ID3'), randomBytes(600)]).toString('hex') }, extra_info: { usage_characters: [...String(body.text ?? '')].length } }));
    });
  });
  return {
    FAKE, planted, png, pngForReadonly, clip, received, decoyHits, voiceCalls, collectorPort, voicePort, decoyPort,
    env: {
      PROMPTCUT_AGENT_ASSET_URL: `http://127.0.0.1:${assetPort}`,
      // 网页采集:这台开发机没有 yt-dlp,用下载器替身(只按环境里的代理出网)。只给探针;`/healthz` 的 collectTestRunner 会是 true
      PROMPTCUT_AGENT_COLLECT_PYTHON: process.execPath,
      PROMPTCUT_AGENT_COLLECT_TEST_ARGS: JSON.stringify([path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cloud-collect', 'fake-collect.mjs')]),
      // 只放行收集站这一个「IP:端口」;替身配音服务是托管方的配置,不经出网闸
      PROMPTCUT_AGENT_EGRESS_TEST_ALLOW: `127.0.0.1:${collectorPort}`,
    },
    async close() { await collector.close(); await decoy.close(); await voice.close(); },
  };
}

/** 一位成员凭自己的素材票据取一件素材;回 `{ status, sha? }` */
async function fetchAsset(page, assetPort, hash) {
  const t = await page.ask({ type: 'auth.ticket', kind: 'asset', access: 'r' });
  if (t.type !== 'auth.ticket.ok') return { status: 0, reason: t.reason ?? t.type };
  const res = await fetch(`http://127.0.0.1:${assetPort}/api/asset/media/${hash}`, { headers: { Authorization: `Bearer ${t.ticket}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ...(res.status === 200 ? { sha: sha256(buf) } : {}) };
}

async function uploadAsset(page, assetPort, bytes) {
  const t = await page.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
  const hash = sha256(bytes);
  const headers = { Authorization: `Bearer ${t.ticket}` };
  const put = await fetch(`http://127.0.0.1:${assetPort}/api/asset/media/${hash}/0`, { method: 'PUT', body: bytes, headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length) } });
  const done = await fetch(`http://127.0.0.1:${assetPort}/api/asset/media/${hash}/complete`, { method: 'POST', headers });
  if (put.status !== 200 || done.status !== 200) throw new Error(`探针自己传素材失败:${put.status} / ${done.status}`);
  return hash;
}

/** 文件快照:路径 → 「大小:修改时刻:内容哈希」 */
function snapshot(dirs) {
  const out = {};
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { const st = fs.statSync(p); out[p] = `${st.size}:${sha256(fs.readFileSync(p))}`; } catch { /* 正在写 */ } }
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

/**
 * @param {object} c 探针主体给的上下文
 */
export async function runToolIsolation(c) {
  const { fx, check, A, ports, p1, p2, owner1, owner2, projectOf, historyOf, agent, agentData, agentSecrets, hostedData, tmp } = c;
  const { FAKE } = fx;
  const COLLECT = `http://127.0.0.1:${fx.collectorPort}`;
  const ASSET = `http://127.0.0.1:${ports.asset}`;
  const mediaOf = async (owner, pid) => (await projectOf(owner, pid)).project?.media ?? [];
  /** 让一位成员的云端 Agent 按脚本逐个调工具;回每一步的 `{ name, ok, summary }` */
  /** 一轮最多 24 次模型往返(服务的上限),所以步骤多的分成几轮发,结果接起来 */
  const run = async (api, conversationId, steps, extra = {}) => {
    const out = { sent: 0, code: null, done: true, results: [], events: [] };
    let after = 0;
    for (let i = 0; i < steps.length; i += 16) {
      const sent = await api.send(conversationId, mockScript([...steps.slice(i, i + 16), { say: '做完了' }]), { extra });
      out.sent = sent.status;
      out.code = sent.code ?? null;
      if (sent.status !== 202) { out.done = false; break; }
      const ev = await api.events(conversationId, { after, ms: 90_000 });
      after = ev.events.reduce((m, e) => Math.max(m, Number(e.seq) || 0), after);
      out.done = out.done && ev.done;
      out.events.push(...ev.events);
      await api.settled(conversationId, 30_000).catch(() => null);
    }
    out.results = out.events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '').slice(0, 200) }));
    return out;
  };
  const upload = async (api, page, conversationId, name, body) => {
    const d = await page.ask({ type: 'auth.ticket', kind: 'delegate', audience: 'agent' });
    const res = await fetch(`${c.agentUrl}/v1/conversations/${conversationId}/attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${d.ticket}`, 'Content-Type': 'application/octet-stream' }, body,
    });
    let json = null;
    try { json = await res.json(); } catch { /* 不是 JSON */ }
    return { status: res.status, ...(json ?? {}) };
  };
  const workDirOf = (projectId, conversationId) => {
    const base = path.join(agentData, 'work', projectId.replace(/[^A-Za-z0-9._-]/g, '_'));
    for (const owner of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      const d = path.join(base, owner, conversationId);
      if (fs.existsSync(d)) return d;
    }
    return null;
  };

  // ---------- T1 素材写入按成员本人的权限
  {
    const before1 = await mediaOf(owner1, p1.projectId);
    const ok = await run(A.jia, 'conv-t1-jia', [{ tool: 'import_media', input: { url: `${COLLECT}/pixel.png`, name: '探针图片.png' } }, { tool: 'list_media', input: {} }]);
    const after1 = await mediaOf(owner1, p1.projectId);
    const added = after1.filter((m) => !before1.some((b) => b.id === m.id));
    const hash = sha256(fx.png);
    const got = await fetchAsset(owner1, ports.asset, hash);
    const state1 = await projectOf(owner1, p1.projectId);
    check('T1a 读写成员的云端 Agent 导入素材:经出网闸下载、写进素材服务、登记进项目;别的成员凭自己的票据取得回同样的字节', ok.results[0]?.ok === true && added.length === 1 && added[0].hash === hash && added[0].kind === 'image'
      && added[0].width === 3 && added[0].height === 2 && got.status === 200 && got.sha === hash, {
      toolResults: ok.results.map((r) => `${r.name}:${r.ok ? 'ok' : `error ${r.summary}`}`), added: added.map((m) => ({ kind: m.kind, name: m.name, hashMatches: m.hash === hash, width: m.width, height: m.height, url: m.url })),
      otherMemberReads: got, writer: state1.by ? { userId: state1.by.userId, service: state1.by.service ?? null } : null,
    });

    // 只读成员(丁):写不进——不下载、不入库、项目不变
    const hitsBefore = fx.received.filter((r) => r.url === '/readonly.png').length;
    const revBefore = (await projectOf(owner1, p1.projectId)).rev;
    const ro = await run(A.ding, 'conv-t1-ding', [{ tool: 'import_media', input: { url: `${COLLECT}/readonly.png` } }]);
    const roHash = sha256(fx.pngForReadonly);
    const roGot = await fetchAsset(owner1, ports.asset, roHash);
    const revAfter = (await projectOf(owner1, p1.projectId)).rev;
    check('T1b 只读成员的云端 Agent 写不进素材:工具被拒,没有下载、没有入库,项目版本不变', ro.results[0]?.ok === false && /只读/.test(ro.results[0].summary) && roGot.status === 404 && revAfter === revBefore
      && fx.received.filter((r) => r.url === '/readonly.png').length === hitsBefore, {
      toolResult: ro.results[0] ?? null, assetStored: roGot.status, rev: [revBefore, revAfter], downloadsMade: fx.received.filter((r) => r.url === '/readonly.png').length - hitsBefore,
    });

    // 别的项目的素材:项目二的创建者自己传一件(字节里带假凭证),甲的 Agent 知道哈希也读不到
    const secretBytes = Buffer.concat([tinyPng(7, 7), Buffer.from(FAKE.otherProject)]);
    const otherHash = await uploadAsset(owner2, ports.asset, secretBytes);
    const tries = [
      `${ASSET}/api/asset/media/${otherHash}`, `http://localhost:${ports.asset}/api/asset/media/${otherHash}`, `http://[::1]:${ports.asset}/api/asset/media/${otherHash}`,
      `${COLLECT}/redir?to=${encodeURIComponent(`${ASSET}/api/asset/media/${otherHash}`)}`, `/@media/${otherHash}`, `/api/asset/media/${otherHash}`, `work:../../../media/${otherHash}`,
    ];
    const before = await mediaOf(owner1, p1.projectId);
    const cross = await run(A.jia, 'conv-t1-cross', [...tries.map((url) => ({ tool: 'import_media', input: { url, name: 'x.png' } })), { tool: 'list_media', input: {} }]);
    const after = await mediaOf(owner1, p1.projectId);
    const hist = historyOf(p1.projectId);
    check('T1c 一个项目的对话读不到另一个项目的素材:知道哈希、直接打同机的素材服务(含换写法、经放行地址重定向)全被拒,项目里没有多出素材', cross.results.slice(0, tries.length).every((r) => r.ok === false)
      && after.length === before.length && !after.some((m) => m.hash === otherHash) && !hist.includes(FAKE.otherProject) && !hist.includes(otherHash.slice(0, 0) + FAKE.otherProject), {
      attempts: tries.length, refused: cross.results.slice(0, tries.length).filter((r) => !r.ok).length, reasons: [...new Set(cross.results.slice(0, tries.length).map((r) => r.summary.slice(0, 40)))],
      mediaCount: [before.length, after.length], fakeCredentialInHistory: hist.includes(FAKE.otherProject),
    });
  }

  // ---------- T2 文件读写按「项目 × 对话」隔离
  {
    // 丙在项目二的对话里放一个附件(内容是假凭证);甲在自己的另一个对话里也放一个
    const upOther = await upload(A.bing2, c.bing2, 'conv-t2-other', 'secret.txt', FAKE.otherProject);
    const upSibling = await upload(A.jia, c.jia, 'conv-t2-sibling', 'sibling.txt', FAKE.otherConversation);
    const upOwn = await upload(A.jia, c.jia, 'conv-t2-jia', 'own.png', tinyPng(4, 4));
    const otherDir = workDirOf(p2.projectId, 'conv-t2-other');
    const siblingDir = workDirOf(p1.projectId, 'conv-t2-sibling');
    const ownDir = workDirOf(p1.projectId, 'conv-t2-jia');
    // 带路径的附件名:一律落在自己的 attachments/ 下(名字被收拾过),写不出去
    const watched = [agentSecrets, path.join(agentData, 'config'), path.join(agentData, 'usage'), hostedData, path.join(tmp, 'system')];
    const snapBefore = snapshot([agentSecrets, path.join(tmp, 'system'), path.join(agentData, 'config')]);
    const hostedPlanted = fs.readFileSync(fx.planted.hosted, 'utf8');
    const evilNames = ['../../../../config/evil.txt', '..\\..\\..\\..\\config\\evil.txt', path.join(agentSecrets, 'evil.txt'), '/etc/evil.txt', 'C:\\Windows\\Temp\\pc-probe-evil.txt', '\\\\127.0.0.1\\c$\\evil.txt', 'nul', 'evil.txt:stream', '....//....//evil.txt'];
    const writes = [];
    for (const name of evilNames) writes.push(await upload(A.jia, c.jia, 'conv-t2-jia', name, `probe-write-${name.length}`));
    const ownFiles = fs.existsSync(path.join(ownDir ?? '', 'attachments')) ? fs.readdirSync(path.join(ownDir, 'attachments')) : [];
    const strays = watched.flatMap((d) => Object.keys(snapshot([d]))).filter((p) => /evil/i.test(p));
    const outsideWrites = [path.join(agentData, 'config', 'evil.txt'), path.join(agentSecrets, 'evil.txt'), '/etc/evil.txt', 'C:\\Windows\\Temp\\pc-probe-evil.txt'].filter((p) => fs.existsSync(p));
    check('T2a 带路径的附件名写不出自己的工作目录:收下的都落在本对话的 attachments/ 下,别处没有多出文件', upOwn.status === 200 && upOther.status === 200 && upSibling.status === 200
      && writes.every((w) => w.status === 400 || (w.status === 200 && typeof w.attachment?.url === 'string' && /^work:attachments\/[^/\\]+$/.test(w.attachment.url)))
      && strays.length === 0 && outsideWrites.length === 0 && ownFiles.every((f) => !/[\\/]/.test(f)), {
      uploads: writes.map((w, i) => `${JSON.stringify(evilNames[i].slice(0, 28))} → ${w.status}${w.attachment ? ` ${w.attachment.url}` : ` ${w.code ?? ''}`}`), filesInOwnAttachments: ownFiles.length, strayFiles: strays, outsideWrites,
    });

    // 读:让甲的工具去读别的项目、别的对话、服务的私钥与数据目录、系统文件
    const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');
    const realKey = path.join(agentSecrets, 'service-key.json');
    const targets = [
      ['别的项目的工作目录(相对路径)', `work:${rel(ownDir, path.join(otherDir, 'attachments', 'secret.txt'))}`],
      ['别的项目的工作目录(绝对路径)', `work:${path.join(otherDir, 'attachments', 'secret.txt')}`],
      ['同一成员的另一个对话', `work:${rel(ownDir, path.join(siblingDir, 'attachments', 'sibling.txt'))}`],
      ['别的对话的附件地址', '/@pcwork/conv-t2-sibling/sibling.txt'],
      ['别的项目对话的附件地址', '/@pcwork/conv-t2-other/secret.txt'],
      ['Agent 服务的私钥(相对路径)', `work:${rel(ownDir, realKey)}`],
      ['Agent 服务的私钥(绝对路径)', `work:${realKey}`],
      ['私钥目录里的假凭证', `work:${rel(ownDir, fx.planted.secrets)}`],
      ['Agent 服务数据目录里的假凭证', `work:${rel(ownDir, fx.planted.agentData)}`],
      ['模型配置', `work:${rel(ownDir, path.join(agentData, 'config', 'ai.json'))}`],
      ['配音令牌的密文', `work:${rel(ownDir, path.join(agentData, 'config', 'keys', 'voice.key'))}`],
      ['别的对话的模型历史', `work:${rel(ownDir, path.join(agentData, 'tenants'))}`],
      ['托管服务数据目录里的假凭证(相对路径)', `work:${rel(ownDir, fx.planted.hosted)}`],
      ['托管服务数据目录里的假凭证(绝对路径)', `work:${fx.planted.hosted}`],
      ['系统文件(假凭证)', `work:${fx.planted.system}`],
      ['系统文件 /etc/passwd', 'work:/etc/passwd'],
      ['系统文件 win.ini', 'work:C:\\Windows\\win.ini'],
      ['盘符相对', 'work:C:secret.txt'],
      ['UNC', 'work:\\\\127.0.0.1\\c$\\Windows\\win.ini'],
      ['设备路径', 'work:\\\\?\\C:\\Windows\\win.ini'],
      ['file: 地址', `file:///${fx.planted.system.replace(/\\/g, '/')}`],
      ['file: 地址(私钥)', `file:///${realKey.replace(/\\/g, '/')}`],
      ['裸的绝对路径', fx.planted.system],
      ['带 NUL', 'work:attachments/own.png\u0000../../x'],
    ];
    // 工作目录里放一个指到 Agent 服务私钥目录的链接(模拟工作目录被人动过):经它也出不去
    let linked = false;
    try { fs.symlinkSync(agentSecrets, path.join(ownDir, 'escape'), 'junction'); linked = true; } catch { linked = false; }
    if (linked) targets.push(['工作目录里指到私钥目录的链接', 'work:escape/planted-credential.txt'], ['经链接读真私钥', 'work:escape/service-key.json']);
    const before = await mediaOf(owner1, p1.projectId);
    const read = await run(A.jia, 'conv-t2-jia', [
      ...targets.map(([, url]) => ({ tool: 'import_media', input: { url, name: 'x.png' } })),
      { tool: 'import_media', input: { url: 'work:attachments/own.png' } },
    ], { attachments: [{ url: 'work:attachments/own.png' }, { url: `work:${rel(ownDir, fx.planted.secrets)}` }, { url: 'work:attachments/../../../../config/planted-credential.txt' }] });
    const after = await mediaOf(owner1, p1.projectId);
    if (linked) { try { fs.rmdirSync(path.join(ownDir, 'escape')); } catch { try { fs.unlinkSync(path.join(ownDir, 'escape')); } catch { /* 留给清理 */ } } }
    const attempts = read.results.slice(0, targets.length);
    const allFake = [FAKE.secrets, FAKE.agentData, FAKE.hosted, FAKE.system, FAKE.otherProject, FAKE.otherConversation];
    // 真私钥的内容也不该出现在任何带得走的地方
    const keyMaterial = (() => { try { return JSON.parse(fs.readFileSync(realKey, 'utf8')).priv ?? ''; } catch { return ''; } })();
    const carried = (text) => allFake.filter((f) => text.includes(f)).length + (keyMaterial && text.includes(keyMaterial) ? 1 : 0);
    const hist1 = historyOf(p1.projectId);
    const eventsText = JSON.stringify(read.events);
    const collected = JSON.stringify(fx.received);
    const projectText = JSON.stringify((await projectOf(owner1, p1.projectId)).project);
    const snapAfter = snapshot([agentSecrets, path.join(tmp, 'system'), path.join(agentData, 'config')]);
    const changed = Object.keys({ ...snapBefore, ...snapAfter }).filter((p) => snapBefore[p] !== snapAfter[p]);
    check('T2b 工具读不到别的项目、别的对话、Agent 服务的私钥与数据目录、托管服务的数据目录、系统文件:逐条被拒,假凭证一个都没被带回来,被探测的位置没有被动', read.done
      && attempts.length === targets.length && attempts.every((r) => r.ok === false) && read.results.at(-1)?.ok === true
      && after.length === before.length + 1 && carried(hist1) === 0 && carried(eventsText) === 0 && carried(collected) === 0 && carried(projectText) === 0
      && changed.length === 0 && fs.readFileSync(fx.planted.hosted, 'utf8') === hostedPlanted, {
      attempts: targets.length, refused: attempts.filter((r) => !r.ok).length, leakedThrough: targets.filter((_, i) => attempts[i]?.ok !== false).map(([what]) => what),
      linkEscapeTried: linked, ownAttachmentStillWorks: read.results.at(-1)?.ok === true,
      fakeCredentials: { planted: allFake.length + 1, inModelHistory: carried(hist1), inEvents: carried(eventsText), atCollector: carried(collected), inProject: carried(projectText) },
      plantedFilesChanged: changed, mediaAdded: after.length - before.length,
    });
  }

  // ---------- T3 出网闸
  {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
    const D = ports.decoy;
    const targets = [
      ['本机回环上别的服务', `http://127.0.0.1:${D}/secret.png`],
      ['localhost', `http://localhost:${D}/secret.png`],
      ['IPv6 回环', `http://[::1]:${D}/secret.png`],
      ['十进制写法的回环', `http://2130706433:${D}/secret.png`],
      ['十六进制写法的回环', `http://0x7f.0.0.1:${D}/secret.png`],
      ['IPv4 映射的 IPv6', `http://[::ffff:127.0.0.1]:${D}/secret.png`],
      ['0.0.0.0', `http://0.0.0.0:${D}/secret.png`],
      ['本机主机名(解析到本机)', `http://${os.hostname()}:${D}/secret.png`],
      ...(lan ? [['本机网卡地址', `http://${lan}:${D}/secret.png`], ['本机网卡地址上的文档服务', `http://${lan}:${ports.doc}/healthz`]] : []),
      ['同机文档服务', `http://127.0.0.1:${ports.doc}/healthz`],
      ['同机素材服务', `http://127.0.0.1:${ports.asset}/api/asset/media/${'0'.repeat(64)}`],
      ['Agent 服务自己', `http://127.0.0.1:${ports.agent}/healthz`],
      ['渲染服务的状态口(缺省端口)', 'http://127.0.0.1:8791/status'],
      ['云厂商的元数据地址', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
      ['链路本地', 'http://169.254.1.1/x.png'],
      ['内网 10/8', 'http://10.0.0.1/x.png'],
      ['内网 172.16/12', 'http://172.16.0.1/x.png'],
      ['内网 192.168/16', 'http://192.168.1.1/x.png'],
      ['运营商级 NAT', 'http://100.64.0.1/x.png'],
      ['IPv6 私有段', 'http://[fd00::1]/x.png'],
      ['IPv6 链路本地', 'http://[fe80::1]/x.png'],
      ['经放行地址重定向到本机服务', `${COLLECT}/redir?to=${encodeURIComponent(`http://127.0.0.1:${D}/secret.png`)}`],
      ['经放行地址重定向到元数据地址', `${COLLECT}/redir?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`],
      ['经放行地址重定向到 localhost', `${COLLECT}/redir?to=${encodeURIComponent(`http://localhost:${ports.doc}/healthz`)}`],
      ['经放行地址重定向到 file:', `${COLLECT}/redir?to=${encodeURIComponent('file:///etc/passwd')}`],
      ['带用户名口令', `http://user:pw@127.0.0.1:${fx.collectorPort}/pixel.png`],
      ['ftp', 'ftp://127.0.0.1/x.png'],
      ['gopher', `gopher://127.0.0.1:${D}/x`],
      ['放行地址的另一个端口', `http://127.0.0.1:${fx.collectorPort + 3}/pixel.png`],
    ];
    const before = await mediaOf(owner1, p1.projectId);
    const t0 = Date.now();
    const out = await run(A.jia, 'conv-t3-jia', [
      ...targets.map(([, url]) => ({ tool: 'import_media', input: { url, name: 'x.png' } })),
      { tool: 'import_media', input: { url: `${COLLECT}/pixel.png`, name: '放行的地址.png' } },
    ]);
    const ms = Date.now() - t0;
    const after = await mediaOf(owner1, p1.projectId);
    const attempts = out.results.slice(0, targets.length);
    const hist = historyOf(p1.projectId);
    const refusedLogs = agent.logs.filter((l) => l.event === 'agent.egress.refused');
    const health = await (await fetch(`${c.agentUrl}/healthz`)).json();
    check('T3 出网闸:本机回环、内网、169.254.169.254、同机的文档服务 / 素材服务 / Agent 服务自己与别的服务(含换写法、经主机名、经放行地址重定向)全部被拒且没有连过去;测试专用的外部地址能通', out.done
      && attempts.length === targets.length && attempts.every((r) => r.ok === false) && out.results.at(-1)?.ok === true
      && fx.decoyHits.length === 0 && !hist.includes(FAKE.decoy) && after.length === before.length + 1 && refusedLogs.length >= targets.length - 4 && health.egressTestAllow === true, {
      attempts: targets.length, refused: attempts.filter((r) => !r.ok).length, gotThrough: targets.filter((_, i) => attempts[i]?.ok !== false).map(([what]) => what),
      localServiceHits: fx.decoyHits.length, fakeCredentialInHistory: hist.includes(FAKE.decoy), allowedExternalWorks: out.results.at(-1)?.ok === true,
      refusedReasons: Object.fromEntries([...new Set(refusedLogs.map((l) => l.code))].map((code) => [code, refusedLogs.filter((l) => l.code === code).length])),
      totalMs: ms, testAllowReportedByHealthz: health.egressTestAllow,
    });
  }

  // ---------- T4 花钱的调用记用量
  {
    const usageFile = () => { const dir = path.join(agentData, 'usage'); return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : ''; };
    const rowsOf = () => usageFile().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.kind === 'service');
    const before = await mediaOf(owner1, p1.projectId);
    const text = '云端配音的探针台词';
    const out = await run(A.jia, 'conv-t4-jia', [{ tool: 'voice_list', input: {} }, { tool: 'voice_generate', input: { text, start: 1 } }]);
    await sleep(200);
    const rows = rowsOf();
    const mine = rows.filter((r) => r.conversationId === 'conv-t4-jia');
    const after = await mediaOf(owner1, p1.projectId);
    const added = after.filter((m) => !before.some((b) => b.id === m.id));
    const usage = await A.jia.call('GET', '/v1/usage');
    const callsBefore = fx.voiceCalls.length;
    // 只读成员:不花钱(在向配音服务发请求之前就被拒),也不记用量
    const ro = await run(A.ding, 'conv-t4-ding', [{ tool: 'voice_generate', input: { text: '只读成员的台词' } }]);
    await sleep(200);
    const disk = usageFile() + historyOf(p1.projectId) + agent.text();
    check('T4 花钱的调用用托管方的配置并记用量:替身配音服务收到一次带托管方令牌的请求,用量记录里有这一行(项目、成员、服务、计量);只读成员不花钱;令牌不进用量、对话与日志', out.results[1]?.ok === true
      && callsBefore === 1 && fx.voiceCalls[0].keyOk === true && mine.length === 1 && mine[0].projectId === p1.projectId && mine[0].userId === c.jia.userId && mine[0].username === 'jia'
      && mine[0].service === 'voice' && mine[0].units === [...text].length && mine[0].unit === 'chars' && mine[0].ok === true && mine[0].vendor === 'minimax'
      && added.length === 1 && added[0].kind === 'audio' && Array.isArray(usage.services) && usage.services.some((s) => s.service === 'voice' && s.calls === 1 && s.units === [...text].length)
      && ro.results[0]?.ok === false && fx.voiceCalls.length === callsBefore && rowsOf().length === rows.length && !disk.includes(FAKE.voiceKey), {
      toolResults: out.results.map((r) => `${r.name}:${r.ok ? 'ok' : `error ${r.summary}`}`), voiceServiceCalls: callsBefore, usedHostConfiguredKey: fx.voiceCalls[0]?.keyOk ?? null,
      usageRow: mine[0] ? { projectId: mine[0].projectId === p1.projectId, userId: mine[0].userId === c.jia.userId, username: mine[0].username, kind: mine[0].kind, service: mine[0].service, vendor: mine[0].vendor, model: mine[0].model, units: mine[0].units, unit: mine[0].unit, ok: mine[0].ok } : null,
      usageApiServices: usage.services ?? null, audioAddedToProject: added.map((m) => m.kind),
      readonlyMember: { toolOk: ro.results[0]?.ok ?? null, summary: ro.results[0]?.summary ?? null, extraVoiceCalls: fx.voiceCalls.length - callsBefore, extraUsageRows: rowsOf().length - rows.length },
      voiceKeyOnDiskOrLog: disk.includes(FAKE.voiceKey),
    });
  }

  // ---------- T5 建卡改卡
  {
    const marker = `PC-PROBE-CARD-EXECUTED-${randomBytes(5).toString('hex')}`;
    const id = `probe-card-${randomBytes(3).toString('hex')}`;
    const source = [
      'import type { CardDef, CardProps } from "../../kernel/types";',
      `console.log(${JSON.stringify(marker)});`,
      '(globalThis as any).__PC_PROBE_CARD_EXECUTED = true;',
      'interface Params { text: string; size: number }',
      'function C({ params }: CardProps<Params>) {',
      '  return <div style={{ fontSize: params.size }}>{params.text}</div>;',
      '}',
      'export const probeCard: CardDef<Params> = {',
      `  id: "${id}", name: "探针卡", description: "隔离探针建的卡", source: "user",`,
      '  frameMode: "stateless",',
      '  defaults: { text: "你好", size: 48 },',
      '  controls: [{ key: "text", label: "文字", type: "text" }, { key: "size", label: "字号", type: "number" }],',
      '  Component: C,',
      '};',
      '',
    ].join('\n');
    const out = await run(A.jia, 'conv-t5-jia', [
      { tool: 'card_authoring_guide', input: {} },
      { tool: 'create_card', input: { id, source } },
      { tool: 'list_cards', input: { cardId: id } },
      { tool: 'add_clip', input: { cardId: id, start: 20, duration: 2, params: { text: '探针' } } },
      { tool: 'get_card_source', input: { cardId: id } },
      { tool: 'edit_card', input: { cardId: id, find: 'size: 48', replace: 'size: 64' } },
      { tool: 'create_card', input: { id, source } },
    ], { creativity: 'high' });
    const key = `src/cards/user/${id}.tsx`;
    const seenByOther = await owner1.ask({ type: 'content.get', kind: 'card-source', key });
    const inOther = await owner2.ask({ type: 'content.get', kind: 'card-source', key });
    const p1After = (await projectOf(owner1, p1.projectId)).project;
    const clip = p1After.tracks.flatMap((t) => t.clips).find((cl) => cl.cardId === id);
    // 项目二里的对话不认得这张卡;只读成员建不了
    const other = await run(A.yi, 'conv-t5-yi', [{ tool: 'list_cards', input: { cardId: id } }, { tool: 'add_clip', input: { cardId: id, start: 0, duration: 2 } }, { tool: 'get_card_source', input: { cardId: id } }], { creativity: 'high' });
    const roId = `${id}-ro`;
    const ro = await run(A.ding, 'conv-t5-ding', [{ tool: 'create_card', input: { id: roId, source: source.split(id).join(roId) } }], { creativity: 'high' });
    const roStored = await owner1.ask({ type: 'content.get', kind: 'card-source', key: `src/cards/user/${roId}.tsx` });
    const log = agent.text();
    const r = out.results;
    check('T5 建卡改卡:源码经文档服务的内容库到别的成员,这张卡只在本项目里认得,只读成员建不了;卡片代码没有在 Agent 服务进程里执行', out.done
      && r[0]?.ok && r[1]?.ok && r[2]?.ok && r[3]?.ok && r[4]?.ok && r[5]?.ok && r[6]?.ok === false
      && typeof seenByOther.body === 'string' && seenByOther.body.includes('size: 64') && seenByOther.body.includes(marker) && inOther.missing === true
      && !!clip && clip.params?.text === '探针' && other.results.every((x) => x.ok === false)
      && ro.results[0]?.ok === false && roStored.missing === true && !log.includes(marker), {
      toolResults: r.map((x) => `${x.name}:${x.ok ? 'ok' : `error ${x.summary.slice(0, 120)}`}`), repeatCreateRefused: r[6]?.ok === false ? r[6].summary.slice(0, 60) : null,
      otherMemberGetsSource: typeof seenByOther.body === 'string', editReachedOtherMember: typeof seenByOther.body === 'string' && seenByOther.body.includes('size: 64'),
      writer: seenByOther.actor ? { service: seenByOther.actor.service ?? null } : null,
      clipAddedWithCard: !!clip, otherProjectHasSource: inOther.missing !== true, otherProjectAgent: other.results.map((x) => `${x.name}:${x.ok ? 'ok' : 'error'}`),
      readonlyMember: { toolOk: ro.results[0]?.ok ?? null, summary: ro.results[0]?.summary?.slice(0, 80) ?? null, stored: roStored.missing !== true },
      cardCodeRanInAgentProcess: log.includes(marker),
    });
  }

  // ---------- T6 音效合成与测响度
  {
    const before1 = await projectOf(owner1, p1.projectId);
    const before2 = await projectOf(owner2, p2.projectId);
    const made = await run(A.jia, 'conv-t6-jia', [
      { tool: 'sound_generate', input: { preset: 'notification', start: 2, requestId: 't6-chime', name: '隔离探针提示音' } },
      { tool: 'sound_status', input: {} },
    ]);
    const jobId = /"(?:jobId|id)":"(sound-[a-f0-9]+)"/.exec(made.results[0]?.summary ?? '')?.[1] ?? null;
    const after1 = await projectOf(owner1, p1.projectId);
    const media = (after1.project?.media ?? []).find((m) => m.soundEffect?.recipe && m.name === '隔离探针提示音.wav') ?? null;
    const soundClip = (after1.project?.tracks ?? []).flatMap((t) => t.clips).find((cl) => cl.mediaId === media?.id) ?? null;
    const bytes = media?.hash ? await fetchAsset(owner1, ports.asset, media.hash) : null;
    const measured = media ? await run(A.jia, 'conv-t6-jia', [{ tool: 'measure_audio', input: { mediaId: media.id } }]) : { results: [] };
    const ffmpeg = !/没有装 ffmpeg/.test(measured.results[0]?.summary ?? '');
    const work = workDirOf(p1.projectId, 'conv-t6-jia');
    const leftovers = work && fs.existsSync(path.join(work, 'measure')) ? fs.readdirSync(path.join(work, 'measure')) : [];
    // 项目二的对话:看不到、查不到、取消不了项目一的作业;量不了、重生成不了项目一的素材与片段
    const other = await run(A.yi, 'conv-t6-yi', [
      { tool: 'sound_status', input: {} },
      { tool: 'sound_status', input: { jobId: jobId ?? 'sound-000000000000' } },
      { tool: 'sound_cancel', input: { jobId: jobId ?? 'sound-000000000000' } },
      { tool: 'measure_audio', input: { mediaId: media?.id ?? 'm-none' } },
      { tool: 'sound_generate', input: { clipId: soundClip?.id ?? 'v-none', requestId: 't6-cross', params: { frequency: 990 } } },
    ]);
    const after2 = await projectOf(owner2, p2.projectId);
    // 只读成员:生成不了
    const rev1 = (await projectOf(owner1, p1.projectId)).rev;
    const ro = await run(A.ding, 'conv-t6-ding', [{ tool: 'sound_generate', input: { preset: 'notification', start: 4, requestId: 't6-ro' } }]);
    const rev1After = (await projectOf(owner1, p1.projectId)).rev;
    const o = other.results;
    check('T6 音效合成与测响度按项目隔离:读写成员生成的音效进了本项目、别的成员取得到;另一个项目的对话看不到、查不到、取消不了这边的作业,量不了、重生成不了这边的素材与片段;只读成员生成不了;量完不留取来的素材', made.done
      && made.results[0]?.ok === true && !!jobId && !!media && !!soundClip && !!bytes && bytes.status === 200 && bytes.sha === media.hash
      && (after1.project?.media ?? []).length === (before1.project?.media ?? []).length + 1
      && (ffmpeg ? measured.results[0]?.ok === true : measured.results[0]?.ok === false) && leftovers.length === 0
      && other.done && o[0]?.ok === true && o[0].summary.includes('"jobs":[]') && o[1]?.ok === false && o[2]?.ok === false && o[3]?.ok === false && o[4]?.ok === false
      && JSON.stringify(after2.project?.media ?? []) === JSON.stringify(before2.project?.media ?? []) && after2.rev === before2.rev
      && ro.results[0]?.ok === false && /只读/.test(ro.results[0].summary) && rev1After === rev1, {
      generate: made.results.map((x) => `${x.name}:${x.ok ? 'ok' : `error ${x.summary.slice(0, 120)}`}`), jobId: jobId ? `${jobId.slice(0, 10)}…` : null,
      mediaInProject: !!media, clipInProject: !!soundClip, otherMemberFetch: bytes ? { status: bytes.status, hashMatches: bytes.sha === media?.hash } : null,
      measure: ffmpeg ? (measured.results[0]?.ok ? 'ok' : `error ${measured.results[0]?.summary?.slice(0, 120)}`) : '本机没有 ffmpeg:工具回了明确的原因', fetchedFilesLeft: leftovers,
      otherProjectAgent: o.map((x) => `${x.name}:${x.ok ? `ok ${x.summary.slice(0, 40)}` : `error ${x.summary.slice(0, 60)}`}`),
      otherProjectUnchanged: after2.rev === before2.rev,
      readonlyMember: { toolOk: ro.results[0]?.ok ?? null, summary: ro.results[0]?.summary?.slice(0, 80) ?? null, rev: [rev1, rev1After] },
    });
  }

  // ---------- T7 网页采集(下载器是替身;出网闸的代理、工作区与受限子进程是真的)
  {
    const D = ports.decoy;
    const full = (out) => out.events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '') }));
    const before1 = await projectOf(owner1, p1.projectId);
    const decoyBefore = fx.decoyHits.length;
    const refusedTargets = [
      ['本机回环上别的服务', `http://127.0.0.1:${D}/secret`],
      ['localhost', `http://localhost:${D}/secret`],
      ['同机文档服务', `http://127.0.0.1:${ports.doc}/healthz`],
      ['同机素材服务', `http://127.0.0.1:${ports.asset}/api/asset/media/${'0'.repeat(64)}`],
      ['Agent 服务自己', `http://127.0.0.1:${ports.agent}/healthz`],
      ['云厂商的元数据地址', 'http://169.254.169.254/latest/meta-data/'],
      ['内网 10/8', 'http://10.0.0.1/x'],
      ['内网 192.168/16', 'http://192.168.1.1/x'],
      ['放行地址的另一个端口', `http://127.0.0.1:${fx.collectorPort + 3}/clip.mp4`],
    ];
    const first = await run(A.jia, 'conv-t7-jia', [
      { tool: 'collect_status', input: {} },
      { tool: 'collect_install', input: {} },
      { tool: 'collect_probe', input: { url: `${COLLECT}/clip.mp4` } },
      ...refusedTargets.map(([, url]) => ({ tool: 'collect_probe', input: { url } })),
      { tool: 'collect_probe', input: { url: 'file:///etc/passwd' } },
      { tool: 'collect_download', input: { url: `${COLLECT}/clip.mp4` } },
    ]);
    const f = full(first);
    const statusText = f[0]?.summary ?? '';
    const jobId = /"jobId":"(collect-[a-f0-9]+)"/.exec(f.at(-1)?.summary ?? '')?.[1] ?? null;
    // 等下载作业做完(云端后台跑)。每次查用一个新的对话(作业表按「项目 × 成员」分,同一位成员的别的对话查得到):
    // 这里的 `run` 读事件流读到第一个 end 就停,同一个对话发第二轮读不到新的结果
    let jobDone = null;
    let lastJobText = null;
    for (let i = 0; i < 40 && jobId; i += 1) {
      const r = await run(A.jia, `conv-t7-job-${i}`, [{ tool: 'collect_job', input: { jobId } }]);
      const text = full(r).at(-1)?.summary ?? '';
      lastJobText = text;
      if (!/"status":"running"/.test(text)) { jobDone = text; break; }
      await sleep(500);
    }
    // 下载作业指向同机的替身服务:作业起得来,但子进程经代理被拒,什么都下不到
    const local = await run(A.jia, 'conv-t7-local', [{ tool: 'collect_download', input: { url: `http://127.0.0.1:${D}/secret.mp4` } }]);
    const localJob = /"jobId":"(collect-[a-f0-9]+)"/.exec(full(local).at(-1)?.summary ?? '')?.[1] ?? null;
    let localDone = null;
    for (let i = 0; i < 40 && localJob; i += 1) {
      const r = await run(A.jia, `conv-t7-local-${i}`, [{ tool: 'collect_job', input: { jobId: localJob } }]);
      const text = full(r).at(-1)?.summary ?? '';
      if (!/"status":"running"/.test(text)) { localDone = text; break; }
      await sleep(500);
    }
    const after1 = await projectOf(owner1, p1.projectId);
    const added = (after1.project?.media ?? []).filter((m) => !(before1.project?.media ?? []).some((b) => b.id === m.id));
    const got = added[0]?.hash ? await fetchAsset(owner1, ports.asset, added[0].hash) : null;
    const refused = f.slice(3, 3 + refusedTargets.length);
    const work = workDirOf(p1.projectId, 'conv-t7-jia');
    const seenCwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(statusText)?.[1]?.replace(/\\\\/g, '\\') ?? null;
    // 另一个项目的对话查不到这边的作业;只读成员在下载之前被拒
    const other = jobId ? await run(A.yi, 'conv-t7-yi', [{ tool: 'collect_job', input: { jobId } }]) : { results: [] };
    const hitsBeforeRo = fx.received.filter((r) => r.url.startsWith('/readonly.mp4')).length;
    const ro = await run(A.ding, 'conv-t7-ding', [{ tool: 'collect_download', input: { url: `${COLLECT}/readonly.mp4` } }]);
    const hitsAfterRo = fx.received.filter((r) => r.url.startsWith('/readonly.mp4')).length;
    const health = await (await fetch(`${c.agentUrl}/healthz`)).json();
    const usageDir = path.join(agentData, 'usage');
    const rows = (fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : []).flatMap((file) => fs.readFileSync(path.join(usageDir, file), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }))
      .filter((u) => u?.kind === 'service' && u.service === 'collect' && u.projectId === p1.projectId);
    const allFake = Object.values(FAKE);
    const leaked = allFake.filter((x) => f.some((r) => r.summary.includes(x))).length;
    check('T7 网页采集:下载器只经受限子进程起、只经出网闸的代理出网——到得了测试专用的外部地址,到不了回环、内网、元数据地址与同机各服务;下载物入库后别的成员取得到;只读成员下载之前被拒;别的项目查不到这边的作业;记了用量', first.done
      && f[0]?.ok === true && /"ready":true/.test(statusText) && /"promptcutEnv":\[\]/.test(statusText) && /"proxy":true/.test(statusText)
      && !!work && !!seenCwd && path.resolve(seenCwd).toLowerCase() === path.resolve(work).toLowerCase()
      && f[1]?.ok === true && /alreadyInstalled/.test(f[1].summary) && f[2]?.ok === true
      && refused.length === refusedTargets.length && refused.every((r) => r.ok === false) && f[3 + refusedTargets.length]?.ok === false
      && fx.decoyHits.length === decoyBefore && leaked === 0
      && !!jobId && !!jobDone && /"status":"done"/.test(jobDone) && added.length === 1 && added[0].kind === 'video' && !!got && got.status === 200 && got.sha === sha256(fx.clip)
      && !fs.existsSync(path.join(work, 'collect', jobId))
      && !!localJob && !!localDone && /egress refused|403/.test(localDone)
      && other.results[0]?.ok === false && ro.results[0]?.ok === false && /只读/.test(ro.results[0].summary) && hitsAfterRo === hitsBeforeRo
      && rows.some((u) => u.model === 'download' && u.ok === true && u.units === fx.clip.length) && rows.some((u) => u.model === 'probe')
      && health.collect === true && health.collectTestRunner === true, {
      tools: f.slice(0, 3).map((x) => `${x.name}:${x.ok ? 'ok' : `error ${x.summary.slice(0, 100)}`}`),
      childSees: { cwdIsConversationWorkDir: !!work && !!seenCwd && path.resolve(seenCwd).toLowerCase() === path.resolve(work).toLowerCase(), promptcutEnv: /"promptcutEnv":\[\]/.test(statusText) ? [] : '有', proxyOnly: /"proxy":true/.test(statusText) },
      refusedByProxy: refusedTargets.map(([what], i) => `${what}:${refused[i]?.ok === false ? '被拒' : '到了'}`), refusedAs: refused[0]?.summary.slice(0, 120) ?? null,
      fileUrlRefused: f[3 + refusedTargets.length]?.ok === false, decoyHits: fx.decoyHits.length - decoyBefore, fakeCredentialsInResults: leaked,
      download: { jobId: jobId ? `${jobId.slice(0, 12)}…` : null, done: jobDone ? /"status":"done"/.test(jobDone) : false, mediaAdded: added.map((m) => m.kind), otherMemberFetch: got ? { status: got.status, sameBytes: got.sha === sha256(fx.clip) } : null, jobDirRemoved: !!work && !!jobId && !fs.existsSync(path.join(work, 'collect', jobId)) },
      downloadToLocalService: localDone ? String(localDone).slice(0, 140) : '作业没有结束',
      otherProjectAgent: other.results.map((x) => `${x.name}:${x.ok ? 'ok' : 'error'}`),
      readonlyMember: { toolOk: ro.results[0]?.ok ?? null, summary: ro.results[0]?.summary?.slice(0, 80) ?? null, sourceHits: hitsAfterRo - hitsBeforeRo },
      usageRows: rows.map((u) => `${u.model}:${u.units}${u.unit}:${u.ok ? 'ok' : 'fail'}`), testRunner: health.collectTestRunner ?? null,
      jobResult: String(jobDone).slice(0, 300),
      ...(jobDone ? {} : { lastJobText: String(lastJobText).slice(0, 400), agentLog: agent.logs.filter((l) => /collect|import|asset/.test(String(l.event))).slice(-6).map((l) => JSON.stringify(l).slice(0, 200)) }),
    });
  }
}
