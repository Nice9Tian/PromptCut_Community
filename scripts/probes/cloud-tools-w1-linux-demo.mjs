// W1(云端 Agent 的网页操作)在节点上的自验脚本:用节点上装的浏览器,把只有 Linux 上才走得到的几条路真跑一遍。
//
// 它只用回环地址上由系统分配的随机端口,只在自己的临时目录里写东西,不连任何现有服务、不出公网;跑完把自己起的进程与目录清干净。
// 不用运行授权、文档服务:授权在这里是放行的桩(授权那一面在仓库的专用测试里验过,和平台无关)。
//
// 要拷到节点临时目录的文件(保持相对路径,共 14 个;除 puppeteer-core 外只用 Node 标准库):
//   scripts/probes/cloud-tools-w1-linux-demo.mjs
//   server/test/cloud-tools-w1-site.mjs
//   server/agent/service/{hosted-browser,egress,workspace}.mjs
//   server/agent/service/perception/runner.mjs
//   server/web/{browser,session,view,hit}.mjs
//   server/web/hosted/{session,network,view,hit}.mjs
//   (加上 package.json 一份,里面只要 {"type":"module"};.mjs 其实不需要它,放着无妨)
//
// 要节点上的:Node 22 以上;一份装好的 node_modules 里有 puppeteer-core(以及它自己的依赖,整个 node_modules 目录指过去就行)。
//
// 跑法:
//   W1_BROWSER=/绝对路径/chrome-headless-shell \
//   W1_NODE_MODULES=/部署目录/node_modules \
//   [W1_EXTRA_ARGS="--no-sandbox"] \
//   node scripts/probes/cloud-tools-w1-linux-demo.mjs
//
// 期望:每一项一行「[w1-linux] 通过 …」,最后一行「[w1-linux] 全部通过」,退出码 0。有「没过」的退出码是 1。
// 末尾会打印「按目录名查残留进程:0」。Windows / macOS 上也能跑(只有 Linux 的项目会标「跳过(不是 Linux)」),用来先验脚本本身。
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEgressGate } from '../../server/agent/service/egress.mjs';
import { createHostedBrowserTools, hostedBrowserDir } from '../../server/agent/service/hosted-browser.mjs';
import { procStat, pidLive, liveGroupMembers, browserGroupLive, browserHoldsProfile } from '../../server/web/hosted/session.mjs';
import { startFakeSite, startInternalService } from '../../server/test/cloud-tools-w1-site.mjs';

const SELF = fileURLToPath(import.meta.url);
const LINUX = process.platform === 'linux';
const say = (...parts) => console.log('[w1-linux]', ...parts);
let failed = 0;
const check = (ok, what, detail = '') => { say(ok ? '通过' : '没过', what, detail); if (!ok) failed += 1; return ok; };
const skip = (what) => say('跳过(不是 Linux)', what);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms, step = 100) { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await sleep(step); } }

const executablePath = process.env.W1_BROWSER;
const extraArgs = String(process.env.W1_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean);
if (!executablePath || !fs.existsSync(executablePath)) { say('要设 W1_BROWSER 指向节点上的浏览器(绝对路径)'); process.exit(2); }

/** puppeteer-core:先按 W1_NODE_MODULES 找,找不到再按普通的模块解析找 */
async function loadPuppeteer() {
  if (process.env.W1_NODE_MODULES) {
    const require = createRequire(path.join(path.resolve(process.env.W1_NODE_MODULES), 'noop.js'));
    for (const name of ['puppeteer-core', 'puppeteer']) {
      try { return (await import(pathToFileURL(require.resolve(name)).href)).default; } catch { /* 试下一个 */ }
    }
  }
  for (const name of ['puppeteer-core', 'puppeteer']) { try { return (await import(name)).default; } catch { /* 试下一个 */ } }
  say('找不到 puppeteer-core:设 W1_NODE_MODULES 指向一份装好的 node_modules'); process.exit(2);
}

const stubResources = {
  authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }),
  register: async () => ({ signal: new AbortController().signal, closed: new Promise(() => {}) }),
};
const contextOf = (conversationId) => ({ projectId: 'sp_demo', conversationId, runId: 'run1', runGrantId: 'grant1', instanceId: 'instance1', instanceGeneration: 1, senderAccountId: 'sender', messageId: 'message1' });
const noDns = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };

/* ------------------------------------------------------------------ 子进程模式:扮「会被强杀的 Agent 服务」 */
if (process.argv[2] === '--child') {
  const [, , , dataDir, url, allow] = process.argv;
  const puppeteer = await loadPuppeteer();
  const tools = createHostedBrowserTools({ resources: stubResources, egress: createEgressGate({ testAllow: [allow], resolve: noDns }), dataDir, runtime: { executablePath, extraArgs }, puppeteer });
  const view = await tools.call('web_open', { url }, contextOf('conversation_crash'));
  const session = tools.describe().sessions[0];
  process.stdout.write(`${JSON.stringify({ ok: view.ok, browserPid: session?.browserPid, pids: session?.pids ?? [] })}\n`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

/* ------------------------------------------------------------------ 主流程 */
const puppeteer = await loadPuppeteer();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-linux-'));
const dataDir = path.join(base, 'agent');
const site = await startFakeSite(0);
const internal = await startInternalService(0);
let udp = 0;
const stun = dgram.createSocket('udp4');
stun.on('message', () => { udp += 1; });
await new Promise((r) => stun.bind(0, '127.0.0.1', r));
const allow = `127.0.0.1:${site.port}`;
say(`浏览器 ${executablePath};追加参数 ${JSON.stringify(extraArgs)};临时目录 ${base};假站 ${site.origin},「内网服务」${internal.origin}(都在回环上,端口是系统给的)`);
const cleanup = [];
const text = async (tools, context) => (await tools.call('web_read', { limit: 20000 }, context)).text ?? '';

try {
  const serviceLog = [];
  const gate = createEgressGate({ testAllow: [allow], resolve: noDns });
  const makeTools = () => createHostedBrowserTools({ resources: stubResources, egress: gate, dataDir, runtime: { executablePath, extraArgs }, puppeteer, limits: { closeMs: 30_000 }, log: (event, fields) => serviceLog.push({ event, ...fields }) });
  let tools = makeTools();
  cleanup.push(() => tools.close('demo-end'));
  const a = contextOf('conversation_a');
  const scopeA = { projectId: a.projectId, conversationId: a.conversationId };

  /* 1. 七个工具走一遍 */
  let view = await tools.call('web_open', { url: `${site.origin}/` }, a);
  if (!check(view.ok === true && view.title === 'W1 假站首页', '起得来、打得开', view.ok ? `模式 ${tools.describe().sessions[0].mode}` : `${view.error ?? ''} ${JSON.stringify(serviceLog.slice(-3))}`)) throw new Error('浏览器起不来,后面的不用跑了');
  const find = (v, name) => v.clickable.find((c) => c.n === name);
  view = await tools.call('web_click', { u: find(view, '打招呼').u }, a);
  view = await tools.call('web_type', { u: find(view, '回显框').u, text: 'linux 你好' }, a);
  view = await tools.call('web_scroll', { to: 'bottom' }, a);
  const body = await text(tools, a);
  check(/点到了:你好/.test(body) && /你输入了:linux 你好/.test(body) && view.clickable.some((c) => c.n === '底部的按钮'), '看、点、输入、滚动、读');

  /* 2. 出网:页面去连内网、metadata;WebRTC */
  const targets = [`${internal.origin}/a`, `http://localhost:${internal.port}/b`, `http://[::1]:${internal.port}/c`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/d', 'http://[fd00:ec2::254]/e'];
  await tools.call('web_open', { url: `${site.origin}/leak?${targets.map((t) => `t=${encodeURIComponent(t)}`).join('&')}` }, a);
  await until(async () => (await text(tools, a)).includes('LEAK-DONE'), 60_000, 500);
  const journal = tools.egressJournal(scopeA);
  check(internal.state.connections === 0, '页面连不到「内网服务」(零连接)');
  check(['127.0.0.1', 'localhost', '::1', '169.254.169.254', '10.0.0.1', 'fd00:ec2::254'].every((h) => journal.some((e) => !e.ok && e.host === h)), '回环、metadata、内网、IPv6 的请求都到了代理并被拒', JSON.stringify([...new Set(journal.filter((e) => !e.ok).map((e) => `${e.host}:${e.port} ${e.code}`))]));
  check(journal.filter((e) => e.ok).every((e) => `${e.host}:${e.port}` === allow), '放行的只有假站');
  await tools.call('web_open', { url: `${site.origin}/webrtc?stun=127.0.0.1:${stun.address().port}` }, a);
  await until(async () => (await text(tools, a)).includes('RTC-DONE'), 30_000, 500);
  const candidates = /RTC-DONE (\[.*\])/.exec(await text(tools, a))?.[1] ?? '?';
  check(udp === 0 && candidates === '[]', 'WebRTC:不发不走代理的 UDP,也收集不到候选', `UDP ${udp} 个,候选 ${candidates}`);
  const refused = await tools.call('web_open', { url: `${site.origin}/redir-internal` }, a);
  check(refused.ok === false, '跳转到内网被拒', String(refused.egress ?? ''));

  /* 3. 进程组(只有 Linux) */
  const session = tools.describe().sessions[0];
  const pgid = session.browserPid;
  if (LINUX) {
    const members = liveGroupMembers(pgid) ?? [];
    check(procStat(pgid)?.pgrp === pgid, '浏览器主进程是进程组的组长', `进程号 ${pgid}`);
    check(session.pids.every((pid) => procStat(pid)?.pgrp === pgid), '浏览器自己的进程表里的进程都在这个组里', `${session.pids.length} 个`);
    const extra = members.filter((pid) => !session.pids.includes(pid));
    say(`组里共 ${members.length} 个活进程;其中进程表里没有的 ${extra.length} 个:${extra.map((pid) => { try { return `${pid}(${fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').find((x) => x.startsWith('--type=')) ?? '主进程'})`; } catch { return String(pid); } }).join(' ')}`);
    check(browserGroupLive(pgid) === true, '开着的时候:组里有活进程');
    check(await browserHoldsProfile(pgid, path.join(hostedBrowserDir(dataDir, scopeA), 'profile')), '按 /proc 里的命令行认得出它用的是这份用户数据目录');
  } else skip('进程组、/proc 命令行');

  /* 4. web_close:整棵树退出 */
  const beforeClose = LINUX ? liveGroupMembers(pgid) ?? [] : session.pids;
  const closed = await tools.call('web_close', {}, a).then((r) => r, (error) => ({ ok: false, error: String(error?.message ?? error) }));
  check(closed.ok === true, 'web_close 拿到了退出凭据', closed.error ?? '');
  check(beforeClose.every((pid) => !pidLive(pid)), `关之前组里的 ${beforeClose.length} 个进程都不再活着`);
  if (LINUX) check(browserGroupLive(pgid) === false, '关了以后:进程组空了(僵尸不算)');

  /* 5. 设为私有:目录里只剩版本计数 */
  const dirA = hostedBrowserDir(dataDir, scopeA);
  say('关了以后会话目录里有:', JSON.stringify(fs.readdirSync(dirA)));
  const priv = await tools.closeConversation(scopeA, { reason: 'private' });
  check(priv.profileRemoved === true && JSON.stringify(fs.readdirSync(dirA)) === '["rev"]', '设为私有:除版本计数外全删(含 .pki、.cache、.config)', JSON.stringify(fs.readdirSync(dirA)));

  /* 6. 服务关闭:两个浏览器都退 */
  await tools.call('web_open', { url: `${site.origin}/` }, a);
  await tools.call('web_open', { url: `${site.origin}/page2` }, contextOf('conversation_b'));
  const groups = tools.describe().sessions.map((s) => s.browserPid);
  const receipt = await tools.close('demo-shutdown');
  check(receipt.childrenClosed === true && receipt.streamsClosed === true && receipt.workPending === 0, '服务关闭的回执', JSON.stringify(receipt));
  if (LINUX) check(groups.every((g) => browserGroupLive(g) === false), '两个浏览器的进程组都空了');

  /* 7. 服务进程被强杀:浏览器自己退(管道断) */
  const crashDir = path.join(base, 'crash');
  const child = spawn(process.execPath, [SELF, '--child', crashDir, `${site.origin}/`, allow], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env, windowsHide: true });
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } });
  const first = await new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (c) => { out += c; if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])); });
    child.once('exit', () => resolve({ ok: false }));
    setTimeout(() => resolve({ ok: false }), 90_000).unref();
  });
  if (check(first.ok === true && first.pids.every((pid) => pidLive(pid)), '(扮服务的子进程)起了浏览器')) {
    child.kill('SIGKILL');
    const gone = await until(() => first.pids.every((pid) => !pidLive(pid)) && (!LINUX || browserGroupLive(first.browserPid) === false), 60_000);
    check(gone, '服务进程被强杀后,浏览器整棵树自己退了', LINUX ? `组里还活着的:${JSON.stringify(liveGroupMembers(first.browserPid))}` : '');
  }

  /* 8. 残留浏览器:新服务起来时清掉;不相干的进程不误杀(只有 Linux 才有锁文件里的进程号这回事) */
  const orphanScope = { projectId: 'sp_demo', conversationId: 'conversation_orphan' };
  const orphanDir = hostedBrowserDir(dataDir, orphanScope);
  const orphanProfile = path.join(orphanDir, 'profile');
  fs.mkdirSync(orphanProfile, { recursive: true });
  // 造一个没人管的浏览器:不开调试口它会自己退,所以给它一个回环上由系统分配的调试口(只为了让它挂着)
  const orphan = spawn(executablePath, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${orphanProfile}`, '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--no-first-run', ...extraArgs, 'about:blank'],
    { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
  orphan.unref();
  cleanup.push(() => { try { process.kill(process.platform === 'win32' ? orphan.pid : -orphan.pid, 'SIGKILL'); } catch { /* 已经退了 */ } });
  await until(() => browserHoldsProfile(orphan.pid, orphanProfile), 60_000, 500);
  fs.writeFileSync(path.join(orphanDir, 'owner.json'), JSON.stringify({ servicePid: 999_999, browserPid: orphan.pid, pids: [orphan.pid], at: Date.now() }));
  let bystander = null;
  let staleDir = null;
  if (LINUX) {
    // 一个不相干的进程,它的进程号被写在另一个对话的过期锁和登记里(模拟「号被系统分给了别人」)
    bystander = spawn('sleep', ['300'], { stdio: 'ignore', detached: true, windowsHide: true });
    bystander.unref();
    cleanup.push(() => { try { process.kill(bystander.pid, 'SIGKILL'); } catch { /* 已经退了 */ } });
    staleDir = hostedBrowserDir(dataDir, { projectId: 'sp_demo', conversationId: 'conversation_stale' });
    fs.mkdirSync(path.join(staleDir, 'profile'), { recursive: true });
    fs.symlinkSync(`${os.hostname()}-${bystander.pid}`, path.join(staleDir, 'profile', 'SingletonLock'));
    fs.writeFileSync(path.join(staleDir, 'owner.json'), JSON.stringify({ servicePid: 999_999, browserPid: bystander.pid, pids: [bystander.pid], at: Date.now() }));
  }
  tools = makeTools();
  cleanup.push(() => tools.close('demo-end'));
  const reaped = await tools.ready;
  check(reaped === 1, '新服务起来时清掉了一个残留浏览器', `清了 ${reaped} 个`);
  check(await until(() => !pidLive(orphan.pid), 30_000), '残留浏览器不再活着');
  if (LINUX) {
    check(pidLive(bystander.pid), '锁文件与登记里写着的那个不相干的进程没有被杀');
    check(!fs.existsSync(path.join(staleDir, 'profile', 'SingletonLock')) && !fs.existsSync(path.join(staleDir, 'owner.json')), '过期的锁与登记清掉了');
    const reopened = await tools.call('web_open', { url: `${site.origin}/page2` }, contextOf('conversation_stale'));
    check(reopened.ok === true && pidLive(bystander.pid), '那个对话照常能打开网页,不相干的进程还在');
  } else skip('过期锁里的进程号被别的进程占用');
  const again = await tools.call('web_open', { url: `${site.origin}/page2` }, contextOf('conversation_orphan'));
  check(again.ok === true, '清掉残留之后,那个对话照常能打开网页');
  const end = await tools.close('demo-end');
  check(end.childrenClosed === true, '收尾:浏览器都退了', JSON.stringify(end));
} catch (error) {
  failed += 1;
  say('没过 脚本中途出错:', String(error?.stack ?? error).split('\n').slice(0, 4).join(' | '));
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* 尽力而为 */ } }
  await site.close(); await internal.close(); await new Promise((r) => stun.close(r));
  await sleep(500);
  let leftover = '(查不了)';
  if (LINUX) {
    leftover = String(fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(base) && Number(pid) !== process.pid && procStat(Number(pid))?.state !== 'Z'; } catch { return false; } }).length);
  }
  say('按目录名查残留进程:', leftover);
  if (LINUX && leftover !== '0') failed += 1;
  for (let i = 0; i < 30 && fs.existsSync(base); i += 1) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { await sleep(200); } }
  say(fs.existsSync(base) ? `临时目录没删干净:${base}` : '临时目录已删');
  say(failed ? `有 ${failed} 项没过` : '全部通过');
  process.exit(failed ? 1 : 0);
}
