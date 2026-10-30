// SKILL 悬浮窗预览的落盘路由:SKILL 模式开着时页面 POST /api/skill-mode/last-action(桌面会话上一步动作的画面,
// 编辑器进程经 SSE 的 skill.preview 要的),写 skillRoot/last-action.{png,json};SKILL 模式关着时什么都不写。
// 顺带锁住 close 路由的返回形状。跑法:node --test server/test/skill-last-action.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skill-last-action-'));
const SKILL_DIR = path.join(OUT, 'skill');
process.env.PROMPTCUT_SKILL_DIR = SKILL_DIR;

// 转译到临时目录:插件里两处动态 import 用的是相对 import.meta.url 的路径,改成仓库里的绝对地址
const gateUrl = pathToFileURL(path.join(ROOT, 'server', 'skill-gate.mjs')).href;
const projectsUrl = pathToFileURL(path.join(ROOT, 'server', 'vite-plugin-projects.ts')).href;
let src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-skill-state.ts'), 'utf8');
src = src.split('new URL("./skill-gate.mjs", import.meta.url).href').join(JSON.stringify(gateUrl));
src = src.split('new URL("./vite-plugin-projects.ts", import.meta.url).href').join(JSON.stringify(projectsUrl));
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const file = path.join(OUT, 'skill-state.mjs');
fs.writeFileSync(file, js);
const { skillStatePlugin } = await import(pathToFileURL(file).href);

/** 把挂在 /api/skill-mode 上的那个中间件拿出来(插件用的是 use(路径, 函数) 的形式) */
function handlerOf() {
  const handlers = new Map();
  skillStatePlugin().configureServer({
    config: { root: OUT },
    middlewares: { use(p, f) { handlers.set(typeof p === 'string' ? p : '*', f ?? p); } },
  });
  const fn = handlers.get('/api/skill-mode');
  assert.ok(fn, '插件没有挂 /api/skill-mode');
  return fn;
}

/** connect 会把挂载前缀剥掉,所以这里 url 直接给剥掉之后的部分 */
function call(fn, method, url, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = url;
  req.method = method;
  req.headers = body == null ? {} : { 'content-type': 'application/json' };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {},
      end(payload) { this.headersSent = true; resolve({ status: this.statusCode, json: JSON.parse(String(payload)) }); },
    };
    fn(req, res);
  });
}

// 一张最小的合法 png(1×1,pngjs 不需要,只要文件头对)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const gate = await import(gateUrl);

test('SKILL-LA-1 SKILL 模式开着时上报:png 和 json 都落到 skillRoot,json 带工具名 / 时间点 / 时刻', async () => {
  gate.openGate();
  try {
    const fn = handlerOf();
    const r = await call(fn, 'POST', '/last-action', { tool: 'add_clip', clipId: 'c-1', t: 3.5, base64: PNG_1x1.toString('base64') });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.tool, 'add_clip');
    assert.equal(r.json.t, 3.5);
    assert.equal(r.json.bytes, PNG_1x1.length);

    const png = fs.readFileSync(path.join(SKILL_DIR, 'last-action.png'));
    assert.ok(png.equals(PNG_1x1), 'png 原样落盘');
    const meta = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'last-action.json'), 'utf8'));
    assert.equal(meta.tool, 'add_clip');
    assert.equal(meta.clipId, 'c-1');
    assert.equal(meta.t, 3.5);
    assert.ok(Date.parse(meta.at) > 0);
    // 临时文件不能留下来
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'last-action.png.tmp')));
    assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'last-action.json.tmp')));
  } finally {
    gate.closeGate('test');
  }
});

test('SKILL-LA-2 不是 png 的内容拒收', async () => {
  gate.openGate();
  try {
    const fn = handlerOf();
    const r = await call(fn, 'POST', '/last-action', { tool: 'add_clip', base64: Buffer.from('hello').toString('base64') });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /png/);
  } finally {
    gate.closeGate('test');
  }
});

test('SKILL-LA-3 SKILL 模式关着时上报被跳过,不写文件', async () => {
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/last-action', { tool: 'add_clip', base64: PNG_1x1.toString('base64') });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.skipped, 'skill-off');
  assert.ok(!fs.existsSync(path.join(SKILL_DIR, 'last-action.png')));
});

test('SKILL-LA-4 close 路由:返回 ok 和关掉之后的状态,closedBy 记的是谁关的', async () => {
  const fn = handlerOf();
  const r = await call(fn, 'POST', '/close', { by: 'user' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state.active, false);
  assert.equal(r.json.state.closedBy, 'user');
  assert.ok(Date.parse(r.json.state.closedAt) > 0);
});
