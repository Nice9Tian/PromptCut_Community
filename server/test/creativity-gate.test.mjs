/**
 * 计划 agent-workflow-plan.md A1:创造力等级与堵 set_project_meta 口子。
 *
 * 用例 CR-1～CR-10:
 *   CR-1 页面侧:set_project_meta 经路由表(页面 mcpExecutor 走的那张表)带未声明字段整次被拒,项目对象不变;
 *   CR-2 两份清单一致:实现层的 SET_PROJECT_META_FIELDS 与工具 schema 的 properties 相同;
 *   CR-3 服务端侧:Agent 服务端执行器(agent-exec 的 runRoute)执行 set_project_meta 带未声明字段被拒,不提交;
 *        只带声明过的字段照常提交;
 *   CR-4 创造力等级字段写不进(页面侧、服务端侧、入口三处都拒);
 *   CR-5 入口的严格检查(callToolInternal 用的 strict-args):只管 set_project_meta,别的工具不受影响;
 *   CR-6 三档 × 对照表:低档 create_card 被拒、中档能改代码(edit_card、改已有效果)不能新建、高档全放行;
 *   CR-7 create_card 按卡在不在判:同名用户卡已存在(整篇重写)= 中,不存在 = 高;非法 id 不去问文件系统;
 *   CR-8 被拒的报错写明当前等级、要的等级、怎么调;
 *   CR-9 会话登记表:对话覆盖优先于项目默认;没覆盖跟项目;没登记的 / 无头实例 = 桌面 APP 会话跟项目;
 *   CR-10 旧项目缺字段按「高」;不认识的值按「高」;
 *   CR-11 自定义测量 measure_audio_js(计划 A6)只在「高」放行,低、中档回统一格式的越级错误,内置的 measure_audio 三档都放行。
 *
 * 跑:node --test server/test/creativity-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { createAgentExecutor } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { checkCreativity, requiredCreativity, TOOL_CREATIVITY } from '../agent/creativity-gate.mjs';
import { createAgentSessions } from '../agent/agent-sessions.mjs';
import { undeclaredArgs, undeclaredArgsError } from '../agent/strict-args.mjs';
import { projectCreativity, effectiveCreativity, normalizeCreativity, creativityAllows, CREATIVITY_LEVELS } from '../../src/kernel/creativity.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

let vitePromise = null;
function vite() {
  vitePromise ??= createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  return vitePromise;
}
test.after(async () => { if (vitePromise) await (await vitePromise).close(); });

const baseProject = () => ({
  version: 1, id: 'p-cr', name: '原名', width: 1920, height: 1080, fps: 30, duration: 10, themeId: 'midnight',
  media: [], tracks: [{ id: 't1', name: '序列 1', clips: [] }],
});

/* ------------------------------------------------------------------ CR-1 / CR-2 / CR-4 页面侧 */

test('CR-1 页面侧:set_project_meta 经路由表带未声明字段整次被拒,项目对象不变(tracks、media 这类键不能借它写)', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const host = await loadSsrHost(load);
  const core = await load('/src/store/core.ts');
  const before = baseProject();
  host.setProject(before);
  // 页面 mcpExecutor 走的就是这张路由表 → editorApi(与 Agent 服务端同一份实现)
  await assert.rejects(() => host.callRoute('set_project_meta', { name: '新名', tracks: [] }), (err) => {
    assert.match(err.message, /不认这些字段:tracks/);
    assert.match(err.message, /整个没有执行/);
    return true;
  });
  assert.equal(core.getState().project, before, '被拒时项目对象不能换');
  assert.equal(core.getState().project.name, '原名', '同一次调用里声明过的字段也不写');
  await assert.rejects(() => host.callRoute('set_project_meta', { media: [{ id: 'x' }], fooBar: 1 }), /media、fooBar/);
  // 声明过的字段照常
  const out = await host.callRoute('set_project_meta', { name: '新名', fps: 25 });
  assert.equal(out.ok, true);
  assert.equal(core.getState().project.name, '新名');
  assert.equal(core.getState().project.fps, 25);
});

test('CR-2 实现层的 SET_PROJECT_META_FIELDS 与工具 schema 的 properties 一致', async () => {
  const v = await vite();
  const mod = await v.ssrLoadModule('/src/mcp/handlers/project.ts');
  const schemaKeys = Object.keys(toolDef('set_project_meta').inputSchema.properties).sort();
  assert.deepEqual([...mod.SET_PROJECT_META_FIELDS].sort(), schemaKeys);
  assert.ok(!schemaKeys.includes('creativity'), 'schema 里不能声明创造力等级');
});

test('CR-4a 页面侧:创造力等级字段写不进', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const host = await loadSsrHost(load);
  const core = await load('/src/store/core.ts');
  const before = { ...baseProject(), creativity: 'low' };
  host.setProject(before);
  await assert.rejects(() => host.callRoute('set_project_meta', { creativity: 'high' }), (err) => {
    assert.match(err.message, /creativity/);
    assert.match(err.message, /Agent 不能写/);
    return true;
  });
  assert.equal(core.getState().project.creativity, 'low');
  assert.equal(core.getState().project, before);
});

/* ------------------------------------------------------------------ CR-3 / CR-4 服务端侧 */

/** 假的文档服务链接:副本就是一份项目,提交都记下来、都落地 */
function fakeLink(project) {
  const commits = [];
  const replica = { project, rev: 1, hasBody: true, waitRev: async () => {}, offer: (rev) => { replica.rev = rev; } };
  return {
    commits,
    link: {
      projectId: 'p-cr', replica,
      ready: async () => {},
      conversation: () => ({
        request: async (msg) => { commits.push(msg); return { type: 'project.op.ok', rev: replica.rev + 1 }; },
      }),
    },
  };
}

test('CR-3 服务端侧:执行器执行 set_project_meta 带未声明字段被拒、不提交;只带声明过的字段照常提交', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const { link, commits } = fakeLink(baseProject());
  const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
  const def = toolDef('set_project_meta');
  await assert.rejects(() => executor.execute('set_project_meta', { name: 'x', cuts: [] }, 'conv-A', def, {}), /不认这些字段:cuts/);
  assert.equal(commits.length, 0, '被拒的调用不能提交');
  await executor.execute('set_project_meta', { name: '服务端改名' }, 'conv-A', def, {});
  assert.equal(commits.length, 1);
  assert.ok(commits[0].ops.some((op) => op.path === 'name' || String(op.path).endsWith('name')), JSON.stringify(commits[0].ops));
});

test('CR-4b 服务端侧:创造力等级字段写不进(不提交)', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const { link, commits } = fakeLink({ ...baseProject(), creativity: 'low' });
  const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
  await assert.rejects(() => executor.execute('set_project_meta', { creativity: 'high' }, 'conv-A', toolDef('set_project_meta'), {}), /Agent 不能写/);
  await assert.rejects(() => executor.execute('set_project_meta', { name: 'y', creativity: 'high' }, 'conv-A', toolDef('set_project_meta'), {}), /creativity/);
  assert.equal(commits.length, 0);
  assert.equal(link.replica.project.creativity, 'low');
});

/* ------------------------------------------------------------------ CR-5 入口 */

test('CR-5 入口的严格检查只管 set_project_meta;CR-4c 入口也拒创造力等级', () => {
  const def = toolDef('set_project_meta');
  assert.deepEqual(undeclaredArgs('set_project_meta', def, { name: 'a', width: 1, height: 2, fps: 30, duration: 3, themeId: 'x' }), []);
  assert.deepEqual(undeclaredArgs('set_project_meta', def, { name: 'a', creativity: 'high', tracks: [] }), ['creativity', 'tracks']);
  assert.deepEqual(undeclaredArgs('set_project_meta', def, undefined), []);
  assert.deepEqual(undeclaredArgs('set_project_meta', def, [1]), ['(参数不是对象)']);
  // 别的工具带多余参数不归这里管
  assert.deepEqual(undeclaredArgs('add_clip', toolDef('add_clip'), { cardId: 'x', start: 0, extra: 1 }), []);
  const msg = undeclaredArgsError('set_project_meta', def, ['creativity']);
  assert.match(msg, /不认这些字段:creativity/);
  assert.match(msg, /Agent 不能写/);
  assert.match(msg, /name、width、height、fps、duration、themeId/);
});

/* ------------------------------------------------------------------ CR-6 / CR-7 / CR-8 对照表 */

const exists = (ids) => ({ cardExists: (id) => ids.includes(id) });

test('CR-6 三档 × 对照表', () => {
  const ctx = exists(['my-card']);
  /** [工具, 参数, 低, 中, 高] 期望放行与否 */
  const table = [
    ['create_card', { id: 'new-card', source: 'x' }, false, false, true],
    ['create_card', { id: 'my-card', source: 'x', overwrite: true }, false, true, true],
    ['edit_card', { cardId: 'title-card', find: 'a', replace: 'b' }, false, true, true],
    ['create_filter', { name: 'f', ops: [] }, false, false, true],
    ['create_pixel_map', { name: 'p' }, false, false, true],
    ['create_audio_fx', { name: 'a', ops: [] }, false, false, true],
    ['update_filter', { filterId: 'f1', ops: [{ kind: 'brightness', value: '1+0.1*sin(t)' }] }, false, true, true],
    ['update_pixel_map', { pixelMapId: 'm1', where: 'g-r' }, false, true, true],
    ['update_audio_fx', { fxId: 'x1', params: { amount: { default: -6 } } }, false, true, true],
    ['update_filter', { filterId: 'f1', name: '改个名' }, true, true, true],
    ['update_audio_fx', { fxId: 'x1', description: '说明' }, true, true, true],
    ['apply_card', { cardId: 'title-card', clipId: 'c1', params: { text: 'hi' } }, true, true, true],
    ['apply_filter', { clipId: 'c1', filterId: 'f1', params: { amount: 0.2 } }, true, true, true],
    ['add_clip', { cardId: 'title-card', start: 0 }, true, true, true],
    ['update_clip', { clipId: 'c1', params: { text: 'x' } }, true, true, true],
    ['add_part', { clipId: 'c1', partId: 'text' }, true, true, true],
    ['measure_audio', { clipId: 'c1' }, true, true, true],
    ['measure_audio_js', { clipId: 'c1', code: 'return 1' }, false, false, true],
    ['get_project', {}, true, true, true],
  ];
  for (const [tool, args, low, medium, high] of table) {
    assert.equal(checkCreativity(tool, args, 'low', ctx).ok, low, `${tool} ${JSON.stringify(args)} @低`);
    assert.equal(checkCreativity(tool, args, 'medium', ctx).ok, medium, `${tool} ${JSON.stringify(args)} @中`);
    assert.equal(checkCreativity(tool, args, 'high', ctx).ok, high, `${tool} ${JSON.stringify(args)} @高`);
  }
  // 高档全放行:清单上每一个工具
  for (const t of tools) assert.equal(checkCreativity(t.name, {}, 'high', ctx).ok, true, `${t.name} @高`);
  // 表里的工具都真实存在(改名时对照表不会悄悄失效)
  for (const name of Object.keys(TOOL_CREATIVITY)) assert.ok(toolDef(name), `对照表里的 ${name} 不是现有工具`);
});

test('CR-7 create_card:整篇重写已有的卡 = 中,新建 = 高;非法 id 不去问文件系统', () => {
  let asked = 0;
  const ctx = { cardExists: (id) => { asked += 1; return id === 'mine'; } };
  assert.equal(requiredCreativity('create_card', { id: 'mine', overwrite: true }, ctx).level, 'medium');
  // 不带 overwrite 碰上已有的卡:实现会回 409 指向 edit_card —— 这里按「改已有」算中,让中档拿到那句更有用的话
  assert.equal(requiredCreativity('create_card', { id: 'mine' }, ctx).level, 'medium');
  assert.equal(requiredCreativity('create_card', { id: 'fresh', overwrite: true }, ctx).level, 'high');
  const before = asked;
  assert.equal(requiredCreativity('create_card', { id: '../../etc/x', overwrite: true }, ctx).level, 'high');
  assert.equal(requiredCreativity('create_card', { overwrite: true }, ctx).level, 'high');
  assert.equal(asked, before, '非法 id 不该去问文件系统');
  // 没注入 cardExists:一律按新建
  assert.equal(requiredCreativity('create_card', { id: 'mine', overwrite: true }).level, 'high');
});

test('CR-8 被拒的报错写明当前等级、要的等级、怎么调', () => {
  const r = checkCreativity('create_card', { id: 'new-card', source: 'x' }, 'low', { source: '跟随项目的默认等级' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.creativity, { current: 'low', required: 'high', tool: 'create_card' });
  assert.match(r.error, /当前是「低」/);
  assert.match(r.error, /新建卡片要「高」/);
  assert.match(r.error, /跟随项目的默认等级/);
  assert.match(r.error, /项目设置/);
  assert.match(r.error, /AI 栏/);
  assert.match(r.error, /停下来告诉用户/);
  const m = checkCreativity('edit_card', { cardId: 'x' }, 'low');
  assert.match(m.error, /要「中」/);
});

/* ------------------------------------------------------------------ CR-9 登记表 */

test('CR-9 会话登记表:对话覆盖优先于项目默认;没覆盖跟项目;没登记的与无头实例按桌面 APP 会话跟项目', () => {
  const s = createAgentSessions({ now: () => 1000 });
  s.register('conv-A', { type: 'cli', vendor: 'claude', creativity: 'low' });
  s.register('conv-B', { type: 'api', vendor: 'anthropic', creativity: null });
  // 覆盖优先
  assert.equal(s.creativityOf('conv-A', 'high').level, 'low');
  assert.equal(s.creativityOf('conv-A', 'medium').level, 'low');
  assert.match(s.creativityOf('conv-A', 'high').source, /这个对话单独设的/);
  // 跟项目
  assert.equal(s.creativityOf('conv-B', 'medium').level, 'medium');
  assert.equal(s.creativityOf('conv-B', 'low').level, 'low');
  // 覆盖可以比项目高(用户在对话里单独调高)
  s.register('conv-C', { type: 'cli', vendor: 'codex', creativity: 'high' });
  assert.equal(s.creativityOf('conv-C', 'low').level, 'high');
  // 再次登记改回跟项目
  s.register('conv-A', { type: 'cli', vendor: 'claude', creativity: null });
  assert.equal(s.creativityOf('conv-A', 'medium').level, 'medium');
  // 登记的结构
  const b = s.get('conv-B');
  assert.deepEqual({ type: b.type, vendor: b.vendor, role: b.role, override: b.override }, { type: 'api', vendor: 'anthropic', role: 'main', override: null });
  // 没登记的:桌面 APP 会话,跟项目,不写进表
  const d = s.creativityOf('skill-xyz', 'low');
  assert.equal(d.level, 'low');
  assert.equal(d.entry.type, 'desktop');
  assert.match(d.source, /桌面 APP/);
  assert.equal(s.list().some((e) => e.id === 'skill-xyz'), false);
  // 桌面 APP 会话不收覆盖值
  s.register('desk', { type: 'desktop', vendor: 'claude', creativity: 'high' });
  assert.equal(s.creativityOf('desk', 'low').level, 'low');
  // 不认识的覆盖值当没设
  s.register('conv-D', { type: 'cli', creativity: 'ultra' });
  assert.equal(s.creativityOf('conv-D', 'medium').level, 'medium');
});

/* ------------------------------------------------------------------ CR-10 缺省 */

test('CR-10 旧项目缺字段按「高」;不认识的值按「高」', () => {
  assert.equal(projectCreativity({ name: '旧项目' }), 'high');
  assert.equal(projectCreativity(null), 'high');
  assert.equal(projectCreativity({ creativity: 'bogus' }), 'high');
  assert.equal(projectCreativity({ creativity: 'medium' }), 'medium');
  assert.equal(effectiveCreativity(null, undefined), 'high');
  assert.equal(effectiveCreativity('low', undefined), 'low');
  assert.equal(normalizeCreativity('HIGH'), null);
  assert.deepEqual([...CREATIVITY_LEVELS], ['low', 'medium', 'high']);
  assert.equal(creativityAllows('medium', 'low'), true);
  assert.equal(creativityAllows('medium', 'high'), false);
  // 旧项目 + 没覆盖的对话:create_card 放行(出厂「高」)
  const s = createAgentSessions();
  s.register('c', { type: 'cli' });
  const level = s.creativityOf('c', projectCreativity({ name: '旧项目' })).level;
  assert.equal(checkCreativity('create_card', { id: 'n' }, level).ok, true);
});

/* ------------------------------------------------------------------ CR-11 自定义测量(计划 A6) */

test('CR-11 measure_audio_js 只在「高」放行,低、中档回统一格式的越级错误', () => {
  const args = { scope: 'timeline', code: 'return input.frames' };
  assert.deepEqual(requiredCreativity('measure_audio_js', args), { level: 'high', what: '写自定义测量代码' });
  for (const level of ['low', 'medium']) {
    const r = checkCreativity('measure_audio_js', args, level, { source: '这个对话单独设的等级' });
    assert.equal(r.ok, false, level);
    assert.deepEqual(r.creativity, { current: level, required: 'high', tool: 'measure_audio_js' });
    assert.match(r.error, /measure_audio_js 没有执行/);
    assert.match(r.error, /写自定义测量代码要「高」/);
    assert.match(r.error, /停下来告诉用户/);
  }
  assert.match(checkCreativity('measure_audio_js', args, 'low').error, /测量只用内置方法/);
  assert.equal(checkCreativity('measure_audio_js', args, 'high').ok, true);
  for (const level of CREATIVITY_LEVELS) assert.equal(checkCreativity('measure_audio', { clipId: 'c1' }, level).ok, true, `measure_audio @${level}`);
  assert.equal(toolDef('measure_audio_js')?.side, 'agent');
});
