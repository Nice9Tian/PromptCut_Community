import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

// node scripts/probes/codex-auth-state-probe.mjs [--keep-server]
// Real editor/backend with only CLI transport replaced. No account/network access.
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = path.join(root, 'work/auth-fix/browser');
const home = path.join(out, 'cli');
fs.mkdirSync(home, { recursive: true });
// Only our explicitly named simulation ledger/call log; no auth files are used.
for (const file of ['codex-home/promptcut-auth-state.json', 'calls.jsonl']) try { fs.unlinkSync(path.join(home, file)); } catch(e) { if(e.code !== 'ENOENT') throw e; }
const control = path.join(home, 'simulation.json');
const write = cfg => fs.writeFileSync(control, JSON.stringify(cfg));
write({ loggedIn: true, scenario: 'split' });
const env = { ...process.env, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_AUTH_SIMULATION_ROOT: out,
  PROMPTCUT_CLI_HOME: home, PROMPTCUT_AI_CONFIG: path.join(out, 'ai.json'),
  PROMPTCUT_DATA_DIR: path.join(out, 'data'), PROMPTCUT_EXPORT_DIR: path.join(out, 'export'),
  PROMPTCUT_CHATS_DIR: path.join(out, 'chats'), PROMPTCUT_WORK_DIR: path.join(out, 'workspace'),
  PROMPTCUT_PROJECTS_DIR: path.join(out, 'projects'), PROMPTCUT_SKILL_DIR: path.join(out, 'skill') };
env.PROMPTCUT_PRERENDER_MODE = 'agent';
fs.writeFileSync(env.PROMPTCUT_AI_CONFIG, JSON.stringify({ version: 1, defaultProvider: 'codex', quota: { enabled: false } }));
const log = fs.openSync(path.join(out, 'server.log'), 'a');
// vite 向上解析:在 worktree 里(没有自己的 node_modules,依赖在主仓库目录)也起得来。端口缺省 5203,--port 可改(连同 +1、+2 两个舞台端口都要空着)
const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 5203;
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65533) { console.error('--port 要是端口号'); process.exit(2); }
const server = spawn(process.execPath, ['--import', './scripts/probes/codex-auth-fixture-loader.mjs', viteBin, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
const origin = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(JSON.stringify(results.at(-1))); if (!ok) throw new Error(name); };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms=30000) { const start=Date.now();while(Date.now()-start<ms) { try { if(await fn()) return; } catch {} await delay(150); } throw new Error('probe timeout'); }
let browser;
const keep = process.argv.includes('--keep-server');
try {
  await until(async()=> (await fetch(origin+'/api/ai/auth-state')).ok);
  const initial = await (await fetch(origin+'/api/ai/providers?refresh=1')).json();
  check('simulation CLI begins logged in', initial.providers.find(p=>p.id==='codex').auth.loggedIn===true);
  browser = await puppeteer.launch({ headless:true, protocolTimeout:30000, args:[...PROBE_CHROME_ARGS, '--disable-gpu'] });
  const context=await browser.createBrowserContext();
  async function page() { const p=await context.newPage();await p.setViewport({width:1600,height:1000});await p.evaluateOnNewDocument(()=>{localStorage.setItem('aiProvider','codex');localStorage.setItem('aiSetupDone','1');});await p.goto(origin+'/?editor&nosetup=1',{waitUntil:'domcontentloaded'});return p; }
  const a=await page(); const b=await page();
  const text = p=>p.evaluate(()=>document.body.innerText);
  async function screenshot(p,name) { await p.bringToFront();await p.screenshot({path:path.join(out,name+'.png'),captureBeyondViewport:false}); }
  async function click(p,label) { await p.evaluate(label=>{const el=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width>0&&(e.textContent.trim()===label||e.title===label||(label==='Codex'&&e.className.includes('ais-')&&e.textContent.includes('Codex'))));if(!el)throw new Error('button missing: '+label);el.click();},label); }
  async function settings(p) { await p.evaluate(()=>{const el=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width>0&&(/AI 设置/.test(e.title)||e.getAttribute('aria-label')==='AI 设置'));if(!el)throw new Error('AI settings trigger missing');el.click();});await until(async()=> (await text(p)).includes('Codex')); }
  await until(async()=>await a.$('.ai-panel'));
  await a.bringToFront();
  // 分页清单按项目分开(2026-10-22):新项目没有会话时只有开始页;先点发送建出第一个会话(这里直接调 agentTabs),「+」才会再开第二页
  await a.evaluate(async () => { const m = await import('/src/ai/agentTabs.ts'); m.commitDraft(m.getActiveTabId()); });
  await a.click('[data-pc="agent-tab-add"][data-pc-dock-add="right"]');
  await until(async()=> (await a.$$('.ai-panel')).length===2);
  await settings(a);
  await click(a,'Codex');
  await until(async()=> (await text(a)).includes('重新登录'));
  await screenshot(a,'logged-in');check('logged in retains re-login button', (await text(a)).includes('已登录'));
  await click(a,'使用这一项');
  const pendingResponse=a.waitForResponse(r=>r.url().endsWith('/api/ai/chat')&&r.request().method()==='POST');
  await a.type('.ai-panel:not([data-inactive]) [data-pc="ai-input"]','simulation only');
  await a.click('.ai-panel:not([data-inactive]) [data-pc="ai-send"]');
  const response=await pendingResponse;
  const stream=await response.text();check('runtime emits one auth terminal', (stream.match(/"authReason":"token_revoked"/g)||[]).length===1 && !(stream.match(/"type":"done"/g)||[]).length);
  await until(async()=> (await text(a)).includes('登录已失效')&&(await text(b)).includes('登录已失效'));
  check('same editor tabs share invalid state immediately',await a.evaluate(()=>[...document.querySelectorAll('.ai-panel .ai-banner')].filter(e=>e.textContent.includes('登录已失效')).length===2));
  await screenshot(a,'invalid-chat');
  const before=fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.args?.[0]==='exec').length;
  const blocked=await (await fetch(origin+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'codex',prompt:'must not execute'})})).text();
  check('another client is blocked before CLI startup',blocked.includes('"authReason":"token_revoked"')&&before===fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.args?.[0]==='exec').length);
  const refreshed=await (await fetch(origin+'/api/ai/providers?refresh=1')).json();check('raw Logged in cannot revive provider cache',refreshed.providers.find(p=>p.id==='codex').auth.status==='invalid');
  await screenshot(b,'invalid-other-editor');
  await settings(a);await click(a,'Codex');await until(async()=> (await text(a)).includes('登录已失效'));
  await screenshot(a,'invalid');check('all open editors synchronize invalidity',true);
  write({loggedIn:true,loginOutcome:'hang'});await click(a,'重新登录');await until(async()=> (await text(a)).includes('等待登录…'));
  await screenshot(a,'logging-in');check('login running button disabled',await a.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.includes('等待登录'))?.disabled===true));
  const jobs=await (await fetch(origin+'/api/ai/setup')).json();const id=jobs.jobs[0].id;
  const duplicate=await (await fetch(origin+'/api/ai/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'codex'})})).json();check('duplicate login reuses job',duplicate.job.id===id);
  await click(a,'取消');await until(async()=> (await text(a)).includes('已取消，可以重新尝试'));
  await screenshot(a,'cancelled');check('cancel preserves invalidity',(await text(a)).includes('登录已失效'));
  write({loggedIn:true,loginOutcome:'fail'});await click(a,'重试登录');await until(async()=> (await text(a)).includes('登录未完成'));
  await screenshot(a,'failed');check('failed login recovery/device entry',(await text(a)).includes('改用设备码登录')&&(await text(a)).includes('登录已失效'));
  write({loggedIn:true,loginDelay:250,scenario:'normal'});await click(a,'重试登录');await until(async()=> (await text(a)).includes('登录成功。')&&await a.evaluate(()=>[...document.querySelectorAll('.ais-status-ok')].some(e=>e.textContent==='已登录')&&![...document.querySelectorAll('.ai-banner')].some(e=>e.textContent.includes('登录已失效'))));
  await screenshot(a,'recovered');check('verified login updates settings',true);
  await until(async()=>!await b.evaluate(()=>[...document.querySelectorAll('.ai-banner')].some(e=>e.textContent.includes('登录已失效'))));check('other editor recovers without reload',true);
  const executions=()=> fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.args?.[0]==='exec').length;
  check('recovery never automatically replays editing instruction',executions()===1);
  const short=await (await fetch(origin+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'codex',prompt:'simulation short command'})})).text();
  check('new explicit simulated instruction succeeds',short.includes('"type":"done"')&&!short.includes('"type":"error"'));
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,serverPid:server.pid},null,2));
} catch(e) { console.error(String(e.stack||e));fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,error:String(e)},null,2));process.exitCode=1; }
finally {
  await browser?.close();
  if(!keep||process.exitCode) {
    if(process.platform==='win32') {const killer=spawn('taskkill.exe',['/PID',String(server.pid),'/T','/F'],{windowsHide:true});await new Promise(r=>killer.on('close',r));}
    else server.kill('SIGTERM');
    fs.closeSync(log);
  } else { fs.writeFileSync(path.join(out,'server-pid.txt'),String(server.pid));server.unref();fs.closeSync(log); }
}
