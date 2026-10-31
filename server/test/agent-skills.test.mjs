/**
 * 技能(issue 46):`SKILL.md` 的解析、扫描、清单、`load_skill` 与运行器的接线。
 * 语义见 docs/semantics/product/agent.md「技能」,做法与数字见 mechanism/agent.md「技能的加载」。
 *
 * 全部用假模型,不调真模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUILTIN_SKILLS_DIR, SKILL_LIMITS, loadSkillCatalog, loadSkillTool, parseSkillMd, skillCatalogPrompt } from '../tools/agent-skills.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { startRun } from '../runners/api.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skills-'));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理 */ } };
const put = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const skillMd = (name, description = `${name} 的用途`, body = `${name} 的正文`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const denied = (code) => (e) => e.code === code;

test('解析:引号、块写法、CRLF、BOM、缩进的子字段不当顶层字段', () => {
  const quoted = parseSkillMd('\uFEFF---\r\nname: "a-b"\r\ndescription: \'it\'\'s\'\r\nmetadata:\r\n  name: 不算\r\n---\r\n\r\n正文\r\n');
  assert.deepEqual(quoted.fields, { name: 'a-b', description: "it's", metadata: 'name: 不算' });
  assert.equal(quoted.body, '正文');
  const block = parseSkillMd('---\nname: x\ndescription: >-\n  第一行\n  第二行\nlicense: MIT\n---\n正文');
  assert.equal(block.fields.description, '第一行 第二行');
  assert.equal(block.fields.license, 'MIT');
  assert.equal(parseSkillMd('---\nname: x\ndescription: |\n  一\n  二\n---\n').fields.description, '一\n二');
  assert.equal(parseSkillMd('---\nname: x\ndescription:\n  换行写的用途\n  第二行\nlicense: MIT\n---\n').fields.description, '换行写的用途 第二行');
  assert.equal(parseSkillMd('---\nname: x\ndescription: 第一行\n  接着写\n---\n').fields.description, '第一行 接着写');
  assert.equal(parseSkillMd('--- \nname: x\n---\t\n正文').body, '正文', '--- 行尾带空白也认');
  assert.equal(parseSkillMd('没有开头字段'), null);
});

test('扫描:外部根排在前面就盖过内置;格式不对的跳过并给原因;没有 SKILL.md 的文件夹不算', () => {
  const external = tmp(); const builtin = tmp();
  try {
    put(builtin, 'shared/SKILL.md', skillMd('shared', '内置的用途', '内置正文'));
    put(builtin, 'only-builtin/SKILL.md', skillMd('only-builtin'));
    put(external, 'shared/SKILL.md', skillMd('shared', '外部的用途', '外部正文'));
    put(external, 'BadName/SKILL.md', skillMd('BadName'));
    put(external, 'folder-differs/SKILL.md', skillMd('another-name'));
    put(external, 'no-head/SKILL.md', '只有正文');
    put(external, 'no-description/SKILL.md', '---\nname: no-description\n---\n正文');
    put(external, 'too-long/SKILL.md', skillMd('too-long', '用途', '字'.repeat(SKILL_LIMITS.chars)));
    put(external, 'blank-description/SKILL.md', '---\nname: blank-description\ndescription: "   "\n---\n正文');
    fs.mkdirSync(path.join(external, 'skill-file-is-a-folder', 'SKILL.md'), { recursive: true });
    put(external, 'not-a-skill/notes.md', '不是技能');
    put(external, 'README.md', '说明');
    const { skills, skipped } = loadSkillCatalog({ dirs: [external, path.join(external, '不存在'), builtin] });
    assert.deepEqual(skills.map((s) => s.name).sort(), ['only-builtin', 'shared']);
    assert.equal(skills.find((s) => s.name === 'shared').body, '外部正文');
    assert.deepEqual(skipped.map((s) => s.folder).sort(), ['BadName', 'blank-description', 'folder-differs', 'no-description', 'no-head', 'skill-file-is-a-folder', 'too-long']);
    for (const s of skipped) assert.ok(s.reason, `${s.folder} 要写原因`);
    assert.match(skipped.find((s) => s.folder === 'skill-file-is-a-folder').reason, /^读不了\(EISDIR\)$/, '文件系统的报错不带磁盘路径');
  } finally { rm(external); rm(builtin); }
});

test('扫描:外部写坏的同名技能占着名字,不退回内置的;查不了的文件夹记原因,不当成没有', (t) => {
  const external = tmp(); const builtin = tmp();
  t.after(() => { rm(external); rm(builtin); });
  put(builtin, 'shared/SKILL.md', skillMd('shared', '内置的用途', '内置正文'));
  put(builtin, 'locked/SKILL.md', skillMd('locked'));
  put(external, 'shared/SKILL.md', '写坏了');
  put(external, 'locked/SKILL.md', skillMd('locked'));
  const realLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...rest) => {
    if (String(file).startsWith(external) && String(file).includes('locked')) throw Object.assign(new Error(`EACCES: permission denied, lstat '${file}'`), { code: 'EACCES' });
    return realLstat(file, ...rest);
  });
  const { skills, skipped } = loadSkillCatalog({ dirs: [external, builtin] });
  assert.deepEqual(skills, []);
  assert.deepEqual(skipped.map((s) => s.folder).sort(), ['locked', 'shared']);
  assert.equal(skipped.find((s) => s.folder === 'locked').reason, '读不了(EACCES)');
});

test('扫描:超过上限的不收,记进跳过;跳过的条数也有上限', () => {
  const root = tmp();
  try {
    const total = SKILL_LIMITS.skills + SKILL_LIMITS.skipped + 5;
    for (let i = 0; i < total; i++) { const name = `skill-${String(i).padStart(3, '0')}`; put(root, `${name}/SKILL.md`, skillMd(name)); }
    const { skills, skipped } = loadSkillCatalog({ dirs: [root] });
    assert.equal(skills.length, SKILL_LIMITS.skills);
    assert.equal(skipped.length, SKILL_LIMITS.skipped);
    assert.match(skipped[0].reason, /上限/);
  } finally { rm(root); }
});

test('清单:没有技能时是空串;用途压成一行、过长截断', () => {
  assert.equal(skillCatalogPrompt([]), '');
  const prompt = skillCatalogPrompt([{ name: 'a', description: `第一行\n第二行${'字'.repeat(SKILL_LIMITS.listedChars)}` }]);
  assert.match(prompt, /## 技能/);
  assert.match(prompt, /load_skill/);
  const line = prompt.split('\n').find((l) => l.startsWith('- a:'));
  assert.ok(line.includes('第一行 第二行'));
  assert.ok(line.endsWith('…'));
  assert.equal(line.length, '- a:'.length + SKILL_LIMITS.listedChars + 1);
});

test('load_skill:读全文时去掉开头字段、列附带文档、脚本明说不运行', async () => {
  const root = tmp();
  try {
    put(root, 'with-files/SKILL.md', skillMd('with-files'));
    put(root, 'with-files/references/style.md', '样式');
    put(root, 'with-files/references/deep/at-limit.md', '第三层');
    put(root, 'with-files/references/deep/more/too-deep.md', '第四层');
    put(root, 'with-files/references/data.json', '{}');
    put(root, 'with-files/scripts/run.md', '脚本说明');
    put(root, 'with-files/scripts/run.py', 'print(1)');
    put(root, 'plain/SKILL.md', skillMd('plain'));
    const { skills } = loadSkillCatalog({ dirs: [root] });
    const tool = loadSkillTool(skills);
    const full = await tool.execute({ name: 'with-files' });
    assert.equal(full.text, 'with-files 的正文');
    assert.ok(!full.text.includes('description'));
    assert.deepEqual(full.files, ['references/deep/at-limit.md', 'references/style.md'], '最多三层,scripts/ 不列');
    assert.match(full.scripts, /不能运行/);
    const plain = await tool.execute({ name: 'plain', file: null });
    assert.equal(plain.text, 'plain 的正文', 'file 写成 null 当作没给');
    assert.equal(plain.files, undefined);
    assert.equal(plain.scripts, undefined);
    assert.equal((await tool.execute({ name: 'with-files', file: 'references/style.md' })).text, '样式');
    assert.equal((await tool.execute({ name: 'with-files', file: 'references\\style.md' })).text, '样式', 'Windows 写法的斜杠也认');
    await assert.rejects(tool.execute({ name: '没有这个' }), denied('skill-not-found'));
    await assert.rejects(tool.execute({ name: 'with-files', file: 'references/none.md' }), denied('skill-file-not-found'));
  } finally { rm(root); }
});

test('load_skill:读全文不怕文件夹没了;Scripts 大小写不同也按脚本算', async () => {
  const root = tmp();
  try {
    put(root, 'gone/SKILL.md', skillMd('gone'));
    put(root, 'cased/SKILL.md', skillMd('cased'));
    put(root, 'cased/Scripts/notes.md', '脚本旁边的说明');
    const tool = loadSkillTool(loadSkillCatalog({ dirs: [root] }).skills);
    const cased = await tool.execute({ name: 'cased' });
    assert.equal(cased.files, undefined);
    assert.match(cased.scripts, /不能运行/);
    rm(path.join(root, 'gone'));
    assert.equal((await tool.execute({ name: 'gone' })).text, 'gone 的正文');
  } finally { rm(root); }
});

test('load_skill:读附带文档失败时不带磁盘路径;.md 结尾的文件夹算没有', async (t) => {
  const root = tmp();
  t.after(() => rm(root));
  put(root, 'broken/SKILL.md', skillMd('broken'));
  put(root, 'broken/doc.md', '文档');
  fs.mkdirSync(path.join(root, 'broken', 'folder.md'));
  const tool = loadSkillTool(loadSkillCatalog({ dirs: [root] }).skills);
  await assert.rejects(tool.execute({ name: 'broken', file: 'folder.md' }), denied('skill-file-not-found'));
  t.mock.method(fs, 'readFileSync', (file) => { throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' }); });
  await assert.rejects(tool.execute({ name: 'broken', file: 'doc.md' }), (e) => {
    assert.equal(e.code, 'skill-file-unreadable');
    assert.ok(!e.message.includes(root), e.message);
    assert.match(e.message, /EACCES/);
    return true;
  });
});

test('load_skill:文件夹外、绝对路径、非 .md/.txt、过大的附带文档一律拒绝', async () => {
  const root = tmp(); const outside = tmp();
  try {
    put(root, 'guarded/SKILL.md', skillMd('guarded'));
    put(root, 'guarded/big.md', '字'.repeat(SKILL_LIMITS.chars + 1));
    put(root, 'guarded/scripts/run.py', 'print(1)');
    put(root, 'other-secret.md', '别的文件');
    put(outside, 'secret.md', '外面的文件');
    const tool = loadSkillTool(loadSkillCatalog({ dirs: [root] }).skills);
    const attempts = ['../other-secret.md', 'references/../../other-secret.md', '..\\other-secret.md', path.join(outside, 'secret.md'), '/etc/passwd', 'C:/Windows/win.ini', 'scripts/run.py', 'scripts/run.py:stream.md', ''];
    for (const file of attempts) await assert.rejects(tool.execute({ name: 'guarded', file }), denied('skill-file-denied'), file);
    await assert.rejects(tool.execute({ name: 'guarded', file: 'big.md' }), denied('skill-file-too-large'));
    // 目录链接:Windows 上文件符号链接要特权,junction 不要,这样这条在哪都真跑
    fs.symlinkSync(outside, path.join(root, 'guarded', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tool.execute({ name: 'guarded', file: 'linked/secret.md' }), denied('skill-file-denied'));
    assert.deepEqual((await tool.execute({ name: 'guarded' })).files, ['big.md'], '链接出去的文件夹不列');
  } finally {
    // 先拆链接再删目录,不让删除顺着链接走到外面那个目录
    try { fs.rmSync(path.join(root, 'guarded', 'linked'), { recursive: false, force: true }); } catch { /* 清理 */ }
    rm(root); rm(outside);
  }
});

test('buildTools:有技能才给 load_skill,不受开放清单限制,也不经 callTool', async () => {
  const called = [];
  const callTool = async (name) => { called.push(name); return []; };
  const none = await buildTools({ callTool, localTools: false, only: new Set(['list_cards']) });
  assert.ok(!none.some((t) => t.name === 'load_skill'));
  const skills = [{ name: 'a', description: '用途', dir: tmp(), body: '正文' }];
  try {
    const offered = await buildTools({ callTool, localTools: false, only: new Set(['list_cards']), skills });
    const tool = offered.find((t) => t.name === 'load_skill');
    assert.ok(tool, '开放清单里没写它也要给');
    called.length = 0;
    assert.equal((await tool.execute({ name: 'a' })).text, '正文');
    assert.deepEqual(called, []);
  } finally { rm(skills[0].dir); }
});

test('内置技能:全部合格,提到的工具都真实存在', () => {
  const { skills, skipped } = loadSkillCatalog({ dirs: [BUILTIN_SKILLS_DIR] });
  assert.deepEqual(skipped, []);
  assert.ok(skills.length >= 1);
  const known = new Set(mcpTools.map((t) => t.name));
  for (const skill of skills) {
    for (const [, name] of skill.body.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(known.has(name), `${skill.name} 提到的 ${name} 不是真工具`);
  }
});

/** 假的 OpenAI 兼容口:按顺序回 replies,记下每次请求的请求体。只从 startRun 进去,看真 fetch 会看到什么 */
function fakeGateway(replies) {
  const requests = [];
  const line = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const chunks = replies.shift();
    return new Response(`${chunks.map(line).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { requests, fetchImpl };
}
const callLoadSkill = (args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];
const sayDone = [{ choices: [{ delta: { content: '做完了' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];

test('运行器:云端那样只开放名单里的工具时,外部技能照样进系统提示词、模型能读,诊断写明收了哪些', async (t) => {
  const root = tmp(); const work = tmp();
  t.after(() => { rm(root); rm(work); });
  put(root, 'local-only/SKILL.md', skillMd('local-only', '只在外部目录的技能', '外部技能正文'));
  put(root, 'broken/SKILL.md', '只有正文');
  const { requests, fetchImpl } = fakeGateway([callLoadSkill({ name: 'local-only' }), sayDone]);
  const events = [];
  await startRun({
    prompt: '开始', systemPrompt: '原提示词', sessionId: 'skills-test', cwd: null, skillsDir: root,
    historyFile: path.join(work, 'history.json'), localTools: false, toolFilter: new Set(['list_cards']),
    apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
    callTool: async () => [], fetchImpl, onEvent: (ev) => events.push(ev),
  }).done;
  const failed = events.filter((e) => e.type === 'error');
  assert.deepEqual(failed, []);
  const toolResult = events.find((e) => e.type === 'tool_result' && e.name === 'load_skill');
  assert.ok(toolResult?.ok);
  assert.equal(toolResult.output.text, '外部技能正文');
  const system = requests[0].messages.find((m) => m.role === 'system').content;
  const text = typeof system === 'string' ? system : system.map((b) => b.text).join('');
  assert.ok(text.startsWith('原提示词'));
  assert.match(text, /local-only:只在外部目录的技能/);
  assert.match(text, /product-intro-video/, '内置技能也在');
  assert.ok(requests[0].tools.some((x) => x.function.name === 'load_skill'));
  assert.match(JSON.stringify(requests[1].messages), /外部技能正文/, '读到的全文交回给了模型');
  const diag = events.find((e) => e.type === 'diagnostic' && e.stage === 'skills');
  assert.ok(diag.data.skills.includes('local-only'));
  assert.equal(diag.data.skipped[0].folder, 'broken');
});

test('运行器:没给外部目录时只有内置技能;外部同名技能盖过内置的', async (t) => {
  const root = tmp(); const work = tmp();
  t.after(() => { rm(root); rm(work); });
  put(root, 'product-intro-video/SKILL.md', skillMd('product-intro-video', '托管方改过的用途', '托管方的正文'));
  const run = async (skillsDir, sessionId) => {
    const { requests, fetchImpl } = fakeGateway([sayDone]);
    await startRun({
      prompt: '开始', systemPrompt: '原提示词', sessionId, cwd: null, ...(skillsDir ? { skillsDir } : {}),
      historyFile: path.join(work, `${sessionId}.json`), localTools: false, toolFilter: new Set(),
      apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
      callTool: async () => [], fetchImpl, onEvent: () => {},
    }).done;
    return JSON.stringify(requests[0].messages[0]);
  };
  assert.match(await run(null, 'skills-builtin'), /做软件或产品的介绍片/);
  const overridden = await run(root, 'skills-external');
  assert.match(overridden, /托管方改过的用途/);
  assert.doesNotMatch(overridden, /做软件或产品的介绍片/);
});
