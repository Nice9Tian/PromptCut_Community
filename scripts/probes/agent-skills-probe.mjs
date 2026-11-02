/**
 * Local end-to-end probe for skills (issue 46, semantics in docs/semantics/product/agent.md "Skills").
 * Starts a real editor process, uses real `/api/ai/chat`, uses the mock model in the repository
 * (does not call real models, consumes no quota), and does not open a browser.
 * End-to-end tests for the two cloud paths are in: CA-SKILL-01 in cloud-agent-service.test.mjs,
 * account-runner-process.test.mjs.
 *
 * Usage: node scripts/probes/agent-skills-probe.mjs [--port 5990]
 *
 * Acceptance check (one JSON line per item, last line { summary }, exit code 1 on failure):
 *   K1 Skills placed by user in skills/ in the same directory as ai.json: model can read full
 *      text, scripts explicitly state they are not run
 *   K2 Built-in skills can be read
 *   K3 On name collision, user skills override built-in ones
 *   K4 Accompanying docs can be read; paths escaping the folder are rejected
 *   K5 Malformed ones are skipped and noted in diagnostics; this round completes normally
 *   K6 Running services do not need to restart: newly added skills can be read in the next round
 *   K7 Bundling rules do not omit built-in skill files
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';
import { shouldCopyApp } from '../../desktop/scripts/prepare-runtime.mjs';

const PORT = Number(flagArg('port', 5990));
if (PORT < 5990 || PORT > 5999) throw new Error(`Port ${PORT} is not in the 5990-5999 range assigned to this probe`);

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
};
const skillMd = (name, description, body) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const put = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** Sends one round, returns events for this round */
async function chat(origin, steps, sessionId) {
  const prompt = `Follow the script.\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
  const res = await fetch(`${origin}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ provider: 'api', prompt, sessionId, conversationId: sessionId }),
  });
  const text = await res.text();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}
// tool_result sent to the page does not include output, only summary (first 1000 characters of tool result JSON)
const resultOf = (events, name = 'load_skill') => events.filter((e) => e.type === 'tool_result' && e.name === name);

let server = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-skills-'));
try {
  const skills = path.join(tmp, 'skills');
  fs.writeFileSync(path.join(tmp, 'ai.json'), JSON.stringify({ api: { vendor: 'mock', model: 'mock', source: 'custom' } }));
  put(skills, 'user-rule/SKILL.md', skillMd('user-rule', 'User\'s own skill', 'User skill body'));
  put(skills, 'user-rule/references/style.md', 'Bundled doc content');
  put(skills, 'user-rule/scripts/run.py', 'print(1)');
  put(skills, 'broken-one/SKILL.md', 'Body only, no header fields');
  // SKILL.md is a folder: raw filesystem errors when reading it contain disk paths, which must not
  // appear in diagnostics
  fs.mkdirSync(path.join(skills, 'fs-error', 'SKILL.md'), { recursive: true });
  put(tmp, 'outside.md', 'Content outside the folder');

  server = await startDevServer({
    port: PORT,
    logFile: path.join(tmp, 'vite.log'),
    env: {
      PROMPTCUT_NO_PORT_FILE: '1',
      PROMPTCUT_PUSH: '0',
      PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
      PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
      PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
      PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
    },
  });
  const { origin } = server;

  const first = await chat(origin, [
    { tool: 'load_skill', input: { name: 'user-rule' } },
    { tool: 'load_skill', input: { name: 'product-intro-video' } },
    { tool: 'load_skill', input: { name: 'user-rule', file: 'references/style.md' } },
    { tool: 'load_skill', input: { name: 'user-rule', file: '../../outside.md' } },
    { say: 'Done' },
  ], 'skills-probe-1');
  const [user, builtin, bundled, escaped] = resultOf(first);
  check('K1 user-provided skill is readable, script states it will not run', user?.ok === true && /User skill body/.test(user.summary) && /cannot run/.test(user.summary), { summary: user?.summary });
  check('K2 built-in skill is readable', builtin?.ok === true && /product intro video/.test(builtin.summary));
  check('K4 bundled doc is readable; paths escaping the folder are rejected', bundled?.ok === true && /Bundled doc content/.test(bundled.summary) && escaped?.ok === false && !/Content outside the folder/.test(JSON.stringify(escaped)), { escaped: escaped?.summary });
  const diag = first.find((e) => e.type === 'diagnostic' && e.stage === 'skills');
  check('K5 malformed ones are skipped, diagnostics say why, this round still finishes as usual', diag?.data?.skipped?.some((s) => s.folder === 'broken-one' && s.reason) && !diag.data.skills.includes('broken-one') && first.some((e) => e.type === 'done'), { skipped: diag?.data?.skipped });
  const diagText = JSON.stringify(diag?.data ?? {});
  check('K5b diagnostics for filesystem errors carry no disk path', diag?.data?.skipped?.some((s) => s.folder === 'fs-error' && s.reason === 'cannot read (EISDIR)') && !diagText.includes(path.basename(tmp)), { skipped: diag?.data?.skipped });

  put(skills, 'product-intro-video/SKILL.md', skillMd('product-intro-video', 'Intro video skill edited by user', 'User version body'));
  put(skills, 'added-later/SKILL.md', skillMd('added-later', 'Skill added later', 'Body added later'));
  const second = await chat(origin, [
    { tool: 'load_skill', input: { name: 'product-intro-video' } },
    { tool: 'load_skill', input: { name: 'added-later' } },
    { say: 'Done' },
  ], 'skills-probe-2');
  const [overridden, later] = resultOf(second);
  check('K3 user skill overrides built-in one with the same name', overridden?.ok === true && /User version body/.test(overridden.summary));
  check('K6 newly added skill is readable on the next turn', later?.ok === true && /Body added later/.test(later.summary));

  const builtinRoot = path.join(REPO, 'server', 'agent-skills');
  const files = fs.readdirSync(builtinRoot, { recursive: true }).map((rel) => path.join(builtinRoot, String(rel))).filter((f) => fs.statSync(f).isFile());
  check('K7 packaging rules do not miss built-in skills', files.length > 0 && files.every((f) => shouldCopyApp(path.basename(f), f, false)) && shouldCopyApp('agent-skills', builtinRoot, true), { files: files.length });
} catch (e) {
  check('probe finished', false, { error: String(e?.stack ?? e) });
} finally {
  server?.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Cleanup */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: { total: results.length, failed } }));
process.exit(failed ? 1 : 0);
