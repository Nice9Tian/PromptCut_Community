/**
 * 技能(issue 46,语义见 docs/semantics/product/agent.md「技能」,做法与数字见 mechanism/agent.md「技能的加载」):
 * 一份写好的做事说明,格式用通用的 `SKILL.md`。系统提示词里只列名称和用途,任务对得上时模型调 `load_skill` 读全文。
 *
 * 只读说明,不执行任何东西:云端没有能跑任意代码的沙盒,文件夹里带的 `scripts/` 不运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 随软件带的技能 */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('../agent-skills/', import.meta.url));

export const SKILL_LIMITS = Object.freeze({
  /** SKILL.md 与附带文档各自的上限(字);和 code_cache_read 一次交回的上限相同 */
  chars: 60000,
  descriptionChars: 1024,
  /** 一轮最多收几个 */
  skills: 32,
  /** 系统提示词里每条用途截到多少字 */
  listedChars: 300,
  /** 读全文时最多列几份附带文档、往下找几层 */
  files: 50,
  fileDepth: 3,
  /** 诊断里最多列几条跳过的 */
  skipped: 20,
});

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEXT_FILE = /\.(md|txt)$/i;
const SKILL_FILE = 'SKILL.md';

const skillError = (code, message) => Object.assign(new Error(message), { code });

/** 去掉一层引号;双引号里的 `\"` 和单引号里的 `''` 还原 */
function unquote(value) {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * 拆 `SKILL.md`:开头两行 `---` 之间的字段 + 其余的正文。只认顶层的 `键: 值`;
 * 后面缩进的行归这个字段(`|`、`>` 块写法和换行接着写的普通写法)。没有开头字段时回 null。
 */
export function parseSkillMd(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const head = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!head) return null;
  const fields = {};
  const lines = head[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!pair) continue;
    const value = pair[2].trim();
    const more = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim());
    if (/^[|>][+-]?$/.test(value)) fields[pair[1]] = more.join(value[0] === '>' ? ' ' : '\n').trim();
    else fields[pair[1]] = unquote([value, ...more].filter(Boolean).join(' '));
  }
  return { fields, body: src.slice(head[0].length).trim() };
}

/** 读一个技能文件夹;不合格时抛出原因(一句话,进诊断) */
function readSkill(dir, folder) {
  const file = path.join(dir, SKILL_FILE);
  // 按字节先挡一道:一个字最少占一个字节,4 倍以内才值得读进来再数字数
  if (fs.statSync(file).size > SKILL_LIMITS.chars * 4) throw new Error(`${SKILL_FILE} 太大`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > SKILL_LIMITS.chars) throw new Error(`${SKILL_FILE} 超过 ${SKILL_LIMITS.chars} 字`);
  const parsed = parseSkillMd(text);
  if (!parsed) throw new Error('开头没有 --- 包着的字段');
  const { name } = parsed.fields;
  const description = parsed.fields.description?.trim();
  if (!name || name.length > 64 || !NAME.test(name)) throw new Error('name 不合格:只用小写字母、数字和单个连字符,1～64 字');
  if (name !== folder) throw new Error(`name(${name})和文件夹名不一样`);
  if (!description || description.length > SKILL_LIMITS.descriptionChars) throw new Error(`description 要有,且不超过 ${SKILL_LIMITS.descriptionChars} 字`);
  return { name, description, dir, body: parsed.body };
}

/**
 * 扫技能目录。`dirs` 排在前面的优先:同名的后面不再收,所以外部根要排在内置的前面。
 * 目录不存在、某个文件夹不合格都不算错:这一轮照常跑,跳过的原因进 `skipped`。
 * 文件系统的报错原文带磁盘路径,诊断会进云端的报告,只留错误代号。
 */
export function loadSkillCatalog({ dirs = [] } = {}) {
  const skills = new Map();
  // 外部根里写坏的同名技能也占着这个名字,不悄悄退回内置的:托管方写了就该知道它没生效
  const seen = new Set();
  const skipped = [];
  const skip = (folder, reason) => { if (skipped.length < SKILL_LIMITS.skipped) skipped.push({ folder, reason }); };
  const why = (e) => (e?.code ? `读不了(${e.code})` : e?.message || String(e));
  const absent = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
  for (const root of dirs) {
    let names;
    try { names = fs.readdirSync(root).sort(); } catch (e) { if (!absent(e)) skip(path.basename(root), why(e)); continue; }
    for (const folder of names) {
      if (seen.has(folder)) continue;
      const dir = path.join(root, folder);
      // 没有 SKILL.md 的不是技能文件夹(说明文件、别的目录),不算跳过;查不了的要记原因,所以不用 existsSync
      try { fs.lstatSync(path.join(dir, SKILL_FILE)); } catch (e) { if (!absent(e)) { seen.add(folder); skip(folder, why(e)); } continue; }
      seen.add(folder);
      if (skills.size >= SKILL_LIMITS.skills) { skip(folder, `超过 ${SKILL_LIMITS.skills} 个的上限`); continue; }
      try { skills.set(folder, readSkill(dir, folder)); } catch (e) { skip(folder, why(e)); }
    }
  }
  return { skills: [...skills.values()], skipped };
}

/** 拼在系统提示词后面的那一节;一个技能都没有时是空串 */
export function skillCatalogPrompt(skills) {
  if (!skills?.length) return '';
  const clip = (s) => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > SKILL_LIMITS.listedChars ? `${one.slice(0, SKILL_LIMITS.listedChars)}…` : one; };
  return '\n\n## 技能\n\n下面是这里能用的技能,每个是一份写好的做事说明。任务和某个技能的用途对得上时,动手之前先调 `load_skill` 读全文,再照着做;对不上的不用读。' +
    '技能只是说明,不放宽任何限制:创造力等级、工具范围都照旧,技能里带的脚本不能运行。\n\n' +
    skills.map((s) => `- ${s.name}:${clip(s.description)}`).join('\n');
}

const namedLike = (name, target) => name.toLowerCase() === target.toLowerCase();

/** 文件夹里有没有 `scripts/`;大小写不敏感的系统上 `Scripts` 也算 */
function hasScripts(dir) {
  try { return fs.readdirSync(dir).some((name) => namedLike(name, 'scripts')); } catch { return false; }
}

/** 文件夹里的附带文档(相对路径,斜杠分隔)。符号链接不跟,`scripts/` 不列;读不了的子目录不列,技能全文照常给 */
function bundledFiles(root) {
  const found = [];
  const walk = (dir, prefix, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= SKILL_LIMITS.files) return;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!namedLike(rel, 'scripts') && depth < SKILL_LIMITS.fileDepth) walk(path.join(dir, ent.name), rel, depth + 1); }
      else if (ent.isFile() && TEXT_FILE.test(ent.name) && !namedLike(rel, SKILL_FILE)) found.push(rel);
    }
  };
  walk(root, '', 1);
  return found;
}

/** 读一份附带文档。路径只收文件夹内的相对路径,解析后还要真落在文件夹里(挡符号链接) */
function readBundled(skill, file) {
  const rel = String(file).replace(/\\/g, '/');
  const parts = rel.split('/');
  // 冒号挡 Windows 的盘符和备用数据流(`run.py:a.md`)
  if (!rel || rel.startsWith('/') || rel.includes(':') || parts.includes('..') || !TEXT_FILE.test(rel)) {
    throw skillError('skill-file-denied', `不能读 ${rel || '(空路径)'}:只能读这个技能文件夹里的 .md、.txt 文件,路径写相对路径。`);
  }
  let real, base;
  try { real = fs.realpathSync(path.join(skill.dir, ...parts)); base = fs.realpathSync(skill.dir); }
  catch { throw skillError('skill-file-not-found', `技能 ${skill.name} 里没有 ${rel}。`); }
  const inside = path.relative(base, real);
  if (!inside || inside.split(path.sep)[0] === '..' || path.isAbsolute(inside)) throw skillError('skill-file-denied', `不能读 ${rel}:它指向这个技能文件夹外面。`);
  // 文件夹里的链接可以指向 .py:解析之后再查一次
  if (!TEXT_FILE.test(real)) throw skillError('skill-file-denied', `不能读 ${rel}:它指向的不是 .md、.txt 文件。`);
  let stat, text;
  // 报错原文带磁盘路径,工具结果会进事件和诊断,只留错误代号
  try {
    stat = fs.statSync(real);
    if (stat.isFile() && stat.size <= SKILL_LIMITS.chars * 4) text = fs.readFileSync(real, 'utf8');
  } catch (e) { throw skillError('skill-file-unreadable', `读不了 ${rel}(${e?.code || '未知错误'})。`); }
  if (!stat.isFile()) throw skillError('skill-file-not-found', `技能 ${skill.name} 里没有 ${rel}。`);
  if (text === undefined || text.length > SKILL_LIMITS.chars) throw skillError('skill-file-too-large', `${rel} 超过 ${SKILL_LIMITS.chars} 字,读不了。`);
  return text;
}

/** `load_skill` 工具。只读说明,不经 callTool:不碰项目、素材和别的文件 */
export function loadSkillTool(skills) {
  return {
    name: 'load_skill',
    description: '读一个技能的全文。系统提示词的「技能」一节列着能用的技能;任务对得上时,动手之前先读。全文里提到附带文档时,用 file 读。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称' },
        file: { type: 'string', description: '可选:这个技能文件夹里的一份 .md、.txt 附带文档(相对路径,比如 references/style.md)。不给就读技能全文。' },
      },
      required: ['name'],
    },
    async execute(input) {
      const skill = skills.find((s) => s.name === input.name);
      if (!skill) throw skillError('skill-not-found', `没有叫 ${input.name} 的技能。能用的有:${skills.map((s) => s.name).join('、')}。`);
      // 模型常把没用到的可选参数写成 null,当作没给
      if (input.file !== undefined && input.file !== null) return { ok: true, name: skill.name, file: input.file, text: readBundled(skill, input.file) };
      const files = bundledFiles(skill.dir);
      return {
        ok: true,
        name: skill.name,
        text: skill.body,
        ...(files.length ? { files } : {}),
        ...(hasScripts(skill.dir) ? { scripts: '这个技能带了 scripts/,这里不能运行。全文里要跑脚本的步骤做不了,用现有工具完成,做不到的在收尾汇报里写明。' } : {}),
      };
    },
  };
}
