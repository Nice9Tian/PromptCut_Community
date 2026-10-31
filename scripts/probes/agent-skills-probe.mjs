/**
 * 技能的本机端到端探针(issue 46,语义见 docs/semantics/product/agent.md「技能」)。
 * 起一台真的编辑器进程,走真的 `/api/ai/chat`,模型用仓库里的模拟模型(不调真模型、不花额度),不开浏览器。
 * 云端两条路的端到端在测试里:cloud-agent-service.test.mjs 的 CA-SKILL-01、account-runner-process.test.mjs。
 *
 * 用法:node scripts/probes/agent-skills-probe.mjs [--port 5990]
 *
 * 验收(每项一行 JSON,最后一行 { summary },有失败退出码 1):
 *   K1 用户放在 ai.json 同目录 skills/ 的技能,模型能读到全文,脚本明说不运行
 *   K2 内置技能能读
 *   K3 同名时用户的盖过内置的
 *   K4 附带文档能读;跳出文件夹的路径被拒
 *   K5 格式不对的跳过,诊断里写明;这一轮照常跑完
 *   K6 跑着的服务不用重启:新放进去的技能下一轮就能读
 *   K7 打包规则不会漏掉内置技能的文件
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';
import { shouldCopyApp } from '../../desktop/scripts/prepare-runtime.mjs';

const PORT = Number(flagArg('port', 5990));
if (PORT < 5990 || PORT > 5999) throw new Error(`端口 ${PORT} 不在分给本探针的 5990～5999 里`);

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

/** 发一轮,回这一轮的事件 */
async function chat(origin, steps, sessionId) {
  const prompt = `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
  const res = await fetch(`${origin}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ provider: 'api', prompt, sessionId, conversationId: sessionId }),
  });
  const text = await res.text();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}
// 发给页面的 tool_result 不带 output,只带 summary(工具结果 JSON 的前 1000 字)
const resultOf = (events, name = 'load_skill') => events.filter((e) => e.type === 'tool_result' && e.name === name);

let server = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-skills-'));
try {
  const skills = path.join(tmp, 'skills');
  fs.writeFileSync(path.join(tmp, 'ai.json'), JSON.stringify({ api: { vendor: 'mock', model: 'mock', source: 'custom' } }));
  put(skills, 'user-rule/SKILL.md', skillMd('user-rule', '用户自己的技能', '用户技能的正文'));
  put(skills, 'user-rule/references/style.md', '附带文档的内容');
  put(skills, 'user-rule/scripts/run.py', 'print(1)');
  put(skills, 'broken-one/SKILL.md', '只有正文,没有开头字段');
  // SKILL.md 是个文件夹:读它时文件系统的报错原文带磁盘路径,诊断里不能出现
  fs.mkdirSync(path.join(skills, 'fs-error', 'SKILL.md'), { recursive: true });
  put(tmp, 'outside.md', '文件夹外面的内容');

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
    { say: '完' },
  ], 'skills-probe-1');
  const [user, builtin, bundled, escaped] = resultOf(first);
  check('K1 用户放的技能能读,脚本明说不运行', user?.ok === true && /用户技能的正文/.test(user.summary) && /不能运行/.test(user.summary), { summary: user?.summary });
  check('K2 内置技能能读', builtin?.ok === true && /产品介绍片/.test(builtin.summary));
  check('K4 附带文档能读;跳出文件夹的路径被拒', bundled?.ok === true && /附带文档的内容/.test(bundled.summary) && escaped?.ok === false && !/文件夹外面的内容/.test(JSON.stringify(escaped)), { escaped: escaped?.summary });
  const diag = first.find((e) => e.type === 'diagnostic' && e.stage === 'skills');
  check('K5 格式不对的跳过,诊断写明,这一轮照常跑完', diag?.data?.skipped?.some((s) => s.folder === 'broken-one' && s.reason) && !diag.data.skills.includes('broken-one') && first.some((e) => e.type === 'done'), { skipped: diag?.data?.skipped });
  const diagText = JSON.stringify(diag?.data ?? {});
  check('K5b 文件系统报错的诊断不带磁盘路径', diag?.data?.skipped?.some((s) => s.folder === 'fs-error' && s.reason === '读不了(EISDIR)') && !diagText.includes(path.basename(tmp)), { skipped: diag?.data?.skipped });

  put(skills, 'product-intro-video/SKILL.md', skillMd('product-intro-video', '用户改过的介绍片技能', '用户版本的正文'));
  put(skills, 'added-later/SKILL.md', skillMd('added-later', '后来放进去的技能', '后来放进去的正文'));
  const second = await chat(origin, [
    { tool: 'load_skill', input: { name: 'product-intro-video' } },
    { tool: 'load_skill', input: { name: 'added-later' } },
    { say: '完' },
  ], 'skills-probe-2');
  const [overridden, later] = resultOf(second);
  check('K3 同名时用户的盖过内置的', overridden?.ok === true && /用户版本的正文/.test(overridden.summary));
  check('K6 新放进去的技能下一轮就能读', later?.ok === true && /后来放进去的正文/.test(later.summary));

  const builtinRoot = path.join(REPO, 'server', 'agent-skills');
  const files = fs.readdirSync(builtinRoot, { recursive: true }).map((rel) => path.join(builtinRoot, String(rel))).filter((f) => fs.statSync(f).isFile());
  check('K7 打包规则不漏内置技能', files.length > 0 && files.every((f) => shouldCopyApp(path.basename(f), f, false)) && shouldCopyApp('agent-skills', builtinRoot, true), { files: files.length });
} catch (e) {
  check('探针跑完', false, { error: String(e?.stack ?? e) });
} finally {
  server?.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理 */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: { total: results.length, failed } }));
process.exit(failed ? 1 : 0);
