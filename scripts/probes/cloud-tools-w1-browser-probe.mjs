// W1(云端 Agent 的网页操作七个工具)可重复跑的真实探针。
//
//   node scripts/probes/cloud-tools-w1-browser-probe.mjs              # 全部:窗口检查 → 五份专用测试 → 公网 → 浏览器自己不解析主机名
//   node scripts/probes/cloud-tools-w1-browser-probe.mjs --public     # 只跑「真实公网」那一段
//   node scripts/probes/cloud-tools-w1-browser-probe.mjs --no-public  # 不连公网的部分
//
// 跑之前设好 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(运行授权夹具要用,值见仓库 docs/local.md 里的说明)。
// 用到的端口:28380、28390～28393、28400、28401(专用测试)、28410～28411(本探针)。浏览器全是无头的,不开窗口。
// 截图落在 docs/reports/assets/v18-tools-w1/。证据行以 [w1] 开头,直接打在输出里。耗时只记录。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createEgressGate } from '../../server/agent/service/egress.mjs';
import { createHostedBrowserTools } from '../../server/agent/service/hosted-browser.mjs';
import { hostedNetworkArgs } from '../../server/web/hosted/network.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SHOTS = path.join(ROOT, 'docs', 'reports', 'assets', 'v18-tools-w1');
const only = process.argv.includes('--public') ? 'public' : process.argv.includes('--no-public') ? 'local' : 'all';
const say = (...parts) => console.log('[w1]', ...parts);
let failed = 0;
const check = (ok, what, detail = '') => { say(ok ? '通过' : '没过', what, detail); if (!ok) failed += 1; return ok; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; } };

/** 这几类程序此刻有没有看得见的窗口(通用规矩:探针前后各查一次) */
function visibleWindows() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg' } | ForEach-Object { \"$($_.Id) $($_.ProcessName)\" }"],
    { windowsHide: true, encoding: 'utf8' });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { return ['(查不了)']; }
}

/** 命令行里带着某个目录名的浏览器进程数(验「探针起的浏览器都收掉了」) */
function browsersUnder(needle) {
  if (process.platform !== 'win32') {
    try { return execFileSync('pgrep', ['-fc', needle], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return '0'; }
  }
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome' -and $_.CommandLine -like '*${needle}*' } | Measure-Object).Count`],
    { windowsHide: true, encoding: 'utf8' }).trim();
  } catch { return '(查不了)'; }
}

const stubResources = {
  // 这一段验的是出网,不是授权(授权在专用测试里用真的运行授权验)
  authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }),
  register: async () => ({ signal: new AbortController().signal, closed: new Promise(() => {}) }),
};
const context = { projectId: 'sp_probe', conversationId: 'conversation_probe', runId: 'run1', runGrantId: 'grant1', instanceId: 'instance1', instanceGeneration: 1, senderAccountId: 'sender', messageId: 'message1' };
const scope = { projectId: context.projectId, conversationId: context.conversationId };

async function runTests() {
  say('—— 五份专用测试(三份真浏览器 + 本地假站 + 真运行授权;两份不起浏览器的单测)——');
  fs.mkdirSync(SHOTS, { recursive: true });
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', '--test-reporter=spec',
      'cloud/server/test/cloud-tools-w1-browser.test.mjs', 'cloud/server/test/cloud-tools-w1-egress.test.mjs', 'cloud/server/test/cloud-tools-w1-restart.test.mjs',
      'cloud/server/test/cloud-tools-w1-host.test.mjs', 'server/test/cloud-tools-w1-process.test.mjs',
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, W1_VERBOSE: '1', W1_SHOT_DIR: SHOTS } });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; process.stdout.write(chunk); });
    child.once('close', (exitCode) => {
      const skipped = Number(/ℹ skipped (\d+)/.exec(text)?.[1] ?? 0);
      const pass = Number(/ℹ pass (\d+)/.exec(text)?.[1] ?? 0);
      say(`测试:通过 ${pass} 条,跳过 ${skipped} 条,退出码 ${exitCode}`);
      if (exitCode === 0 && skipped > 0) { say('有被跳过的:探针不接受跳过'); resolve(3); } else resolve(exitCode ?? 1);
    });
  });
  check(code === 0, '五份专用测试零失败、零跳过');
  say('截图:', fs.readdirSync(SHOTS).filter((f) => /^0\d-/.test(f)).join(' '));
}

async function publicRound(executablePath) {
  say('—— 真实公网:经出网闸打开 https://example.com(没有任何测试例外,用系统的 DNS)——');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-probe-public-'));
  const egressLog = [];
  const gate = createEgressGate({ log: (event, fields) => egressLog.push({ event, ...fields }) });
  check(gate.testAllowActive === false, '出网闸没有开测试例外');
  const tools = createHostedBrowserTools({ resources: stubResources, egress: gate, dataDir, runtime: { executablePath, argPrefix: [...PROBE_CHROME_ARGS] } });
  let pids = [];
  try {
    const t0 = Date.now();
    const view = await tools.call('web_open', { url: 'https://example.com/' }, context);
    if (!view.ok) {
      // 网络不通是环境的事:如实记,不算探针失败
      say('公网没打开(如实记录,不算失败):', view.error, JSON.stringify(tools.egressJournal(scope).slice(-5)));
      return;
    }
    say(`打开用了 ${Date.now() - t0} 毫秒;标题「${view.title}」,地址 ${view.url},清单 ${JSON.stringify(view.clickable.map((c) => `${c.u}=${c.n}`))}`);
    fs.writeFileSync(path.join(SHOTS, '10-public-example.webp'), Buffer.from(view.__image.base64, 'base64'));
    const read = await tools.call('web_read', {}, context);
    check(view.title === 'Example Domain' && read.title === 'Example Domain' && /documentation examples/.test(read.text), '读到了真实页面的标题与正文', JSON.stringify(read.text.slice(0, 80)));
    const journal = tools.egressJournal(scope);
    const mine = journal.filter((e) => e.host === 'example.com');
    say('代理记录里 example.com 的条目:', JSON.stringify(mine.map((e) => ({ kind: e.kind, host: e.host, port: e.port, ok: e.ok, address: e.address }))));
    check(mine.some((e) => e.ok && e.kind === 'connect' && e.port === 443 && e.address), '正常出网走的是代理:记录里有这条到 example.com:443 的隧道,连的是出网闸核过的地址');
    say('代理记录(去重,含浏览器自己发起的后台请求):', JSON.stringify([...new Set(journal.map((e) => `${e.kind} ${e.host}:${e.port} ${e.ok ? 'ok' : e.code}`))]));
    pids = tools.describe().sessions[0].pids;
    // 真闸下的几条拒绝(同一个浏览器开着)
    for (const [url, code] of [['http://169.254.169.254/latest/meta-data/', 'blocked-address'], ['http://127.0.0.1:28410/', 'port'], ['http://localhost/', 'blocked-address'], ['http://[::1]/', 'blocked-address'], ['file:///etc/passwd', null]]) {
      const refused = await tools.call('web_open', { url }, context);
      check(refused.ok === false && (code ? refused.egress === code : refused.refused === 'protocol'), `真闸拒 ${url}`, refused.egress ?? refused.refused ?? '');
    }
    const still = await tools.call('web_view', {}, context);
    check(still.ok && /example\.com/.test(still.url), '被拒的地址没有把页面带走');
    const closed = await tools.call('web_close', {}, context);
    check(closed.ok === true && closed.wasOpen === true, 'web_close');
  } finally {
    const receipt = await tools.close('probe-end');
    check(receipt.childrenClosed && receipt.streamsClosed && receipt.workPending === 0, '关闭回执', JSON.stringify(receipt));
    check(pids.filter(alive).length === 0, `浏览器进程号都查不到了(${pids.length} 个)`);
    for (let i = 0; i < 25 && fs.existsSync(dataDir); i += 1) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { await sleep(200); } }
    say('按目录名查残留的浏览器进程:', browsersUnder(path.basename(dataDir)));
  }
}

/**
 * 「浏览器自己不解析主机名」这条参数的对照:不走代理、直接让浏览器去连「本机的主机名:28411」。
 * 28411 只在 127.0.0.1 上有人听,主机名解析出来的是网卡地址——所以**能解析**时报的是连不上,**不能解析**时报的是名字解析不了。
 */
async function resolverRound(executablePath) {
  say('—— 浏览器自己不解析主机名(DNS 预取等不走代理的解析都落空)——');
  const puppeteer = (await import('puppeteer')).default;
  const server = http.createServer((_q, s) => s.end('x'));
  await new Promise((r) => server.listen(28411, '127.0.0.1', r));
  const name = os.hostname();
  const rule = hostedNetworkArgs('http://127.0.0.1:9').find((a) => a.startsWith('--host-resolver-rules='));
  const attempt = async (args) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-probe-dns-'));
    const browser = await puppeteer.launch({ headless: true, executablePath, userDataDir: dir, pipe: true, args: [...PROBE_CHROME_ARGS, '--no-proxy-server', '--disable-background-networking', ...args] });
    const pid = browser.process()?.pid;
    try {
      const page = (await browser.pages())[0];
      try { const r = await page.goto(`http://${name}:28411/`, { timeout: 15_000 }); return `到了(${r?.status()})`; } catch (err) { return /net::(ERR_[A-Z_]+)/.exec(String(err?.message))?.[1] ?? String(err?.message).slice(0, 60); }
    } finally {
      await browser.close().catch(() => {});
      for (let i = 0; i < 50 && alive(pid); i += 1) await sleep(100);
      for (let i = 0; i < 25 && fs.existsSync(dir); i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await sleep(200); } }
    }
  };
  try {
    const without = await attempt([]);
    const withRule = await attempt([rule]);
    say(`不带那条参数:${without};带上:${withRule}(主机名 ${name.length} 个字符)`);
    if (without === 'ERR_NAME_NOT_RESOLVED') say('这台机器本来就解析不了自己的主机名,这条对照在本机验不了(如实记录)');
    else check(withRule === 'ERR_NAME_NOT_RESOLVED', '带上参数后浏览器解析不了任何主机名');
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
}

const before = visibleWindows();
say('探针前看得见的窗口:', JSON.stringify(before));
const puppeteer = (await import('puppeteer')).default;
const executablePath = await puppeteer.executablePath();
say('浏览器:', path.basename(path.dirname(path.dirname(executablePath))), path.basename(executablePath), fs.existsSync(executablePath) ? '(在)' : '(不在)');
if (!fs.existsSync(executablePath)) { say('puppeteer 自带的 Chrome for Testing 不在,探针跑不了'); process.exit(2); }

if (only !== 'public') await runTests();
if (only !== 'local') await publicRound(executablePath);
if (only !== 'public') await resolverRound(executablePath);

const after = visibleWindows();
say('探针后看得见的窗口:', JSON.stringify(after));
check(after.filter((w) => !before.includes(w)).length === 0, '探针没有带出新的可见窗口');
say(failed ? `有 ${failed} 项没过` : '全部通过');
process.exit(failed ? 1 : 0);
