/**
 * Skills (issue 46): parsing, scanning, manifest of `SKILL.md`, and wiring `load_skill` to runner.
 * See docs/semantics/product/agent.md "Skills" for semantics, and mechanism/agent.md "Loading skills"
 * for implementation and numbers.
 *
 * Uses fake models throughout; does not call real models.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUILTIN_SKILLS_DIR, SKILL_LIMITS, loadSkillCatalog, loadSkillTool, parseSkillMd, skillCatalogPrompt } from '../tools/agent-skills.mjs';
import { buildTools } from '../agent/build-promptcut-tools.mjs';
import { tools as mcpTools } from '../mcp-tools.mjs';
import { startRun } from '../runners/api.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skills-'));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Cleanup */ } };
const put = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const skillMd = (name, description = `${name} purpose`, body = `${name} body`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const denied = (code) => (e) => e.code === code;

test('parsing: quotes, block style, CRLF, BOM, and indented subfields are not treated as top-level fields', () => {
  const quoted = parseSkillMd('﻿---\r\nname: "a-b"\r\ndescription: \'it\'\'s\'\r\nmetadata:\r\n  name: not counted\r\n---\r\n\r\nbody\r\n');
  assert.deepEqual(quoted.fields, { name: 'a-b', description: "it's", metadata: 'name: not counted' });
  assert.equal(quoted.body, 'body');
  const block = parseSkillMd('---\nname: x\ndescription: >-\n  first line\n  second line\nlicense: MIT\n---\nbody');
  assert.equal(block.fields.description, 'first line second line');
  assert.equal(block.fields.license, 'MIT');
  assert.equal(parseSkillMd('---\nname: x\ndescription: |\n  one\n  two\n---\n').fields.description, 'one\ntwo');
  assert.equal(parseSkillMd('---\nname: x\ndescription:\n  purpose on a new line\n  second line\nlicense: MIT\n---\n').fields.description, 'purpose on a new line second line');
  assert.equal(parseSkillMd('---\nname: x\ndescription: first line\n  continued\n---\n').fields.description, 'first line continued');
  assert.equal(parseSkillMd('--- \nname: x\n---\t\nbody').body, 'body', '--- is recognized even with trailing whitespace');
  assert.equal(parseSkillMd('no frontmatter'), null);
});

test('scan: an external root listed first overrides the built-in one; malformed ones are skipped with a reason; folders without SKILL.md do not count', () => {
  const external = tmp(); const builtin = tmp();
  try {
    put(builtin, 'shared/SKILL.md', skillMd('shared', 'built-in purpose', 'built-in body'));
    put(builtin, 'only-builtin/SKILL.md', skillMd('only-builtin'));
    put(external, 'shared/SKILL.md', skillMd('shared', 'external purpose', 'external body'));
    put(external, 'BadName/SKILL.md', skillMd('BadName'));
    put(external, 'folder-differs/SKILL.md', skillMd('another-name'));
    put(external, 'no-head/SKILL.md', 'body only');
    put(external, 'no-description/SKILL.md', '---\nname: no-description\n---\nbody');
    put(external, 'too-long/SKILL.md', skillMd('too-long', 'purpose', 'x'.repeat(SKILL_LIMITS.chars)));
    put(external, 'blank-description/SKILL.md', '---\nname: blank-description\ndescription: "   "\n---\nbody');
    fs.mkdirSync(path.join(external, 'skill-file-is-a-folder', 'SKILL.md'), { recursive: true });
    put(external, 'not-a-skill/notes.md', 'not a skill');
    put(external, 'README.md', 'notes');
    const { skills, skipped } = loadSkillCatalog({ dirs: [external, path.join(external, 'nonexistent'), builtin] });
    assert.deepEqual(skills.map((s) => s.name).sort(), ['only-builtin', 'shared']);
    assert.equal(skills.find((s) => s.name === 'shared').body, 'external body');
    assert.deepEqual(skipped.map((s) => s.folder).sort(), ['BadName', 'blank-description', 'folder-differs', 'no-description', 'no-head', 'skill-file-is-a-folder', 'too-long']);
    for (const s of skipped) assert.ok(s.reason, `${s.folder} must state a reason`);
    assert.match(skipped.find((s) => s.folder === 'skill-file-is-a-folder').reason, /^Cannot read \(EISDIR\)$/, 'filesystem errors carry no disk path');
  } finally { rm(external); rm(builtin); }
});

test('scan: a broken external skill with the same name keeps the name and does not fall back to the built-in one; a folder that cannot be inspected is recorded with a reason, not treated as missing', (t) => {
  const external = tmp(); const builtin = tmp();
  t.after(() => { rm(external); rm(builtin); });
  put(builtin, 'shared/SKILL.md', skillMd('shared', 'built-in purpose', 'built-in body'));
  put(builtin, 'locked/SKILL.md', skillMd('locked'));
  put(external, 'shared/SKILL.md', 'broken');
  put(external, 'locked/SKILL.md', skillMd('locked'));
  const realLstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...rest) => {
    if (String(file).startsWith(external) && String(file).includes('locked')) throw Object.assign(new Error(`EACCES: permission denied, lstat '${file}'`), { code: 'EACCES' });
    return realLstat(file, ...rest);
  });
  const { skills, skipped } = loadSkillCatalog({ dirs: [external, builtin] });
  assert.deepEqual(skills, []);
  assert.deepEqual(skipped.map((s) => s.folder).sort(), ['locked', 'shared']);
  assert.equal(skipped.find((s) => s.folder === 'locked').reason, 'Cannot read (EACCES)');
});

test('scan: those over the limit are not accepted and are recorded as skipped; the number of skipped entries is also capped', () => {
  const root = tmp();
  try {
    const total = SKILL_LIMITS.skills + SKILL_LIMITS.skipped + 5;
    for (let i = 0; i < total; i++) { const name = `skill-${String(i).padStart(3, '0')}`; put(root, `${name}/SKILL.md`, skillMd(name)); }
    const { skills, skipped } = loadSkillCatalog({ dirs: [root] });
    assert.equal(skills.length, SKILL_LIMITS.skills);
    assert.equal(skipped.length, SKILL_LIMITS.skipped);
    assert.match(skipped[0].reason, /limit/);
  } finally { rm(root); }
});

test('manifest: an empty string when there are no skills; the purpose is squeezed into one line and truncated if too long', () => {
  assert.equal(skillCatalogPrompt([]), '');
  const prompt = skillCatalogPrompt([{ name: 'a', description: `first line\nsecond line${'x'.repeat(SKILL_LIMITS.listedChars)}` }]);
  assert.match(prompt, /## Skills/);
  assert.match(prompt, /load_skill/);
  const line = prompt.split('\n').find((l) => l.startsWith('- a:'));
  assert.ok(line.includes('first line second line'));
  assert.ok(line.endsWith('…'));
  assert.equal(line.length, '- a:'.length + SKILL_LIMITS.listedChars + 1);
});

test('load_skill: when reading the full text it strips the frontmatter, lists the bundled documents, and states explicitly that scripts are not run', async () => {
  const root = tmp();
  try {
    put(root, 'with-files/SKILL.md', skillMd('with-files'));
    put(root, 'with-files/references/style.md', 'Style');
    put(root, 'with-files/references/deep/at-limit.md', 'third level');
    put(root, 'with-files/references/deep/more/too-deep.md', 'fourth level');
    put(root, 'with-files/references/data.json', '{}');
    put(root, 'with-files/scripts/run.md', 'script notes');
    put(root, 'with-files/scripts/run.py', 'print(1)');
    put(root, 'plain/SKILL.md', skillMd('plain'));
    const { skills } = loadSkillCatalog({ dirs: [root] });
    const tool = loadSkillTool(skills);
    const full = await tool.execute({ name: 'with-files' });
    assert.equal(full.text, 'with-files body');
    assert.ok(!full.text.includes('description'));
    assert.deepEqual(full.files, ['references/deep/at-limit.md', 'references/style.md'], 'at most three levels, scripts/ is not listed');
    assert.match(full.scripts, /cannot be run/);
    const plain = await tool.execute({ name: 'plain', file: null });
    assert.equal(plain.text, 'plain body', 'file given as null is treated as not given');
    assert.equal(plain.files, undefined);
    assert.equal(plain.scripts, undefined);
    assert.equal((await tool.execute({ name: 'with-files', file: 'references/style.md' })).text, 'Style');
    assert.equal((await tool.execute({ name: 'with-files', file: 'references\\style.md' })).text, 'Style', 'Windows-style slashes are accepted too');
    await assert.rejects(tool.execute({ name: 'no such skill' }), denied('skill-not-found'));
    await assert.rejects(tool.execute({ name: 'with-files', file: 'references/none.md' }), denied('skill-file-not-found'));
  } finally { rm(root); }
});

test('load_skill: reading the full text is safe even if the folder is gone; Scripts with different letter case still counts as scripts', async () => {
  const root = tmp();
  try {
    put(root, 'gone/SKILL.md', skillMd('gone'));
    put(root, 'cased/SKILL.md', skillMd('cased'));
    put(root, 'cased/Scripts/notes.md', 'notes next to the script');
    const tool = loadSkillTool(loadSkillCatalog({ dirs: [root] }).skills);
    const cased = await tool.execute({ name: 'cased' });
    assert.equal(cased.files, undefined);
    assert.match(cased.scripts, /cannot be run/);
    rm(path.join(root, 'gone'));
    assert.equal((await tool.execute({ name: 'gone' })).text, 'gone body');
  } finally { rm(root); }
});

test('load_skill: when reading a bundled document fails, the error carries no disk path; a folder whose name ends in .md counts as nonexistent', async (t) => {
  const root = tmp();
  t.after(() => rm(root));
  put(root, 'broken/SKILL.md', skillMd('broken'));
  put(root, 'broken/doc.md', 'document');
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

test('load_skill: bundled documents outside the folder, with absolute paths, not .md/.txt, or too large are all rejected', async () => {
  const root = tmp(); const outside = tmp();
  try {
    put(root, 'guarded/SKILL.md', skillMd('guarded'));
    put(root, 'guarded/big.md', 'x'.repeat(SKILL_LIMITS.chars + 1));
    put(root, 'guarded/scripts/run.py', 'print(1)');
    put(root, 'other-secret.md', 'another file');
    put(outside, 'secret.md', 'a file outside');
    const tool = loadSkillTool(loadSkillCatalog({ dirs: [root] }).skills);
    const attempts = ['../other-secret.md', 'references/../../other-secret.md', '..\\other-secret.md', path.join(outside, 'secret.md'), '/etc/passwd', 'C:/Windows/win.ini', 'scripts/run.py', 'scripts/run.py:stream.md', ''];
    for (const file of attempts) await assert.rejects(tool.execute({ name: 'guarded', file }), denied('skill-file-denied'), file);
    await assert.rejects(tool.execute({ name: 'guarded', file: 'big.md' }), denied('skill-file-too-large'));
    // Directory link: file symlinks require privileges on Windows while junctions do not, so this actually runs anywhere
    fs.symlinkSync(outside, path.join(root, 'guarded', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tool.execute({ name: 'guarded', file: 'linked/secret.md' }), denied('skill-file-denied'));
    assert.deepEqual((await tool.execute({ name: 'guarded' })).files, ['big.md'], 'a folder linked to outside is not listed');
  } finally {
    // Unlink first before deleting directory, preventing deletion from following link to outer directory
    try { fs.rmSync(path.join(root, 'guarded', 'linked'), { recursive: false, force: true }); } catch { /* Cleanup */ }
    rm(root); rm(outside);
  }
});

test('buildTools: load_skill is provided only when there are skills, is not restricted by the allowlist, and does not go through callTool', async () => {
  const called = [];
  const callTool = async (name) => { called.push(name); return []; };
  const none = await buildTools({ callTool, localTools: false, only: new Set(['list_cards']) });
  assert.ok(!none.some((t) => t.name === 'load_skill'));
  const skills = [{ name: 'a', description: 'purpose', dir: tmp(), body: 'body' }];
  try {
    const offered = await buildTools({ callTool, localTools: false, only: new Set(['list_cards']), skills });
    const tool = offered.find((t) => t.name === 'load_skill');
    assert.ok(tool, 'it must be provided even if the allowlist does not list it');
    called.length = 0;
    assert.equal((await tool.execute({ name: 'a' })).text, 'body');
    assert.deepEqual(called, []);
  } finally { rm(skills[0].dir); }
});

test('built-in skills: all valid, and every tool they mention really exists', () => {
  const { skills, skipped } = loadSkillCatalog({ dirs: [BUILTIN_SKILLS_DIR] });
  assert.deepEqual(skipped, []);
  assert.ok(skills.length >= 1);
  const known = new Set(mcpTools.map((t) => t.name));
  for (const skill of skills) {
    for (const [, name] of skill.body.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(known.has(name), `${name} mentioned in ${skill.name} is not a real tool`);
  }
});

/** Fake OpenAI-compatible endpoint: returns replies in sequence, records each request body. Only enters via startRun to see what real fetch will see */
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
const sayDone = [{ choices: [{ delta: { content: 'Finished' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];

test('runner: when only the tools on the list are enabled, as in the cloud, external skills still go into the system prompt and the model can read them, and the diagnostics state which ones were accepted', async (t) => {
  const root = tmp(); const work = tmp();
  t.after(() => { rm(root); rm(work); });
  put(root, 'local-only/SKILL.md', skillMd('local-only', 'skill only in the external directory', 'external skill body'));
  put(root, 'broken/SKILL.md', 'body only');
  const { requests, fetchImpl } = fakeGateway([callLoadSkill({ name: 'local-only' }), sayDone]);
  const events = [];
  await startRun({
    prompt: 'Start', systemPrompt: 'original prompt', sessionId: 'skills-test', cwd: null, skillsDir: root,
    historyFile: path.join(work, 'history.json'), localTools: false, toolFilter: new Set(['list_cards']),
    apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
    callTool: async () => [], fetchImpl, onEvent: (ev) => events.push(ev),
  }).done;
  const failed = events.filter((e) => e.type === 'error');
  assert.deepEqual(failed, []);
  const toolResult = events.find((e) => e.type === 'tool_result' && e.name === 'load_skill');
  assert.ok(toolResult?.ok);
  assert.equal(toolResult.output.text, 'external skill body');
  const system = requests[0].messages.find((m) => m.role === 'system').content;
  const text = typeof system === 'string' ? system : system.map((b) => b.text).join('');
  assert.ok(text.startsWith('original prompt'));
  assert.match(text, /local-only:skill only in the external directory/);
  assert.match(text, /product-intro-video/, 'built-in skills are there too');
  assert.ok(requests[0].tools.some((x) => x.function.name === 'load_skill'));
  assert.match(JSON.stringify(requests[1].messages), /external skill body/, 'The full text that was read was handed back to the model');
  const diag = events.find((e) => e.type === 'diagnostic' && e.stage === 'skills');
  assert.ok(diag.data.skills.includes('local-only'));
  assert.equal(diag.data.skipped[0].folder, 'broken');
});

test('Runner: with no external directory given there are only built-in skills; an external skill with the same name overrides the built-in one', async (t) => {
  const root = tmp(); const work = tmp();
  t.after(() => { rm(root); rm(work); });
  put(root, 'product-intro-video/SKILL.md', skillMd('product-intro-video', 'Purpose changed by the host', 'The host\'s body'));
  const run = async (skillsDir, sessionId) => {
    const { requests, fetchImpl } = fakeGateway([sayDone]);
    await startRun({
      prompt: 'Start', systemPrompt: 'original prompt', sessionId, cwd: null, ...(skillsDir ? { skillsDir } : {}),
      historyFile: path.join(work, `${sessionId}.json`), localTools: false, toolFilter: new Set(),
      apiConfig: { vendor: 'openai', apiKey: 'sk-t', model: 'm', baseUrl: 'https://x/v1', maxTokens: 64 },
      callTool: async () => [], fetchImpl, onEvent: () => {},
    }).done;
    return JSON.stringify(requests[0].messages[0]);
  };
  assert.match(await run(null, 'skills-builtin'), /intro video, feature demo video or promo short for software or a product/);
  const overridden = await run(root, 'skills-external');
  assert.match(overridden, /Purpose changed by the host/);
  assert.doesNotMatch(overridden, /intro video, feature demo video or promo short for software or a product/);
});
