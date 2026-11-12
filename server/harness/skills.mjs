/**
 * Generic `SKILL.md` discovery, frontmatter parser, system-prompt catalog formatter, and
 * read-only `load_skill` tool for the Agent harness.
 *
 * Reads instructions only and executes nothing: `scripts/` directories inside skill folders are
 * never listed as readable documents or executed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SKILL_LIMITS = Object.freeze({
  /** Limits for SKILL.md and accompanying docs (characters); matches code_cache_read return limit */
  chars: 60000,
  descriptionChars: 1024,
  /** Maximum number accepted in one round */
  skills: 32,
  /** Character limit for each description in the system prompt */
  listedChars: 300,
  /** Maximum accompanying docs listed and depth searched when reading the full text */
  files: 50,
  fileDepth: 3,
  /** Maximum skipped entries listed in diagnostics */
  skipped: 20,
});

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEXT_FILE = /\.(md|txt)$/i;
const SKILL_FILE = 'SKILL.md';

const skillError = (code, message) => Object.assign(new Error(message), { code });

/** Strip one layer of quotes; unescape `\"` in double quotes and `''` in single quotes */
function unquote(value) {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Parse `SKILL.md`: fields between the two opening `---` lines + the rest of the body. Only
 * recognizes top-level `key: value`; indented subsequent lines belong to this field (`|` and `>`
 * block styles, as well as ordinary wrapped lines). Returns null when there are no header fields.
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

/** Read a skill folder; throw the reason if invalid (one sentence, goes to diagnostics) */
function readSkill(dir, folder) {
  const file = path.join(dir, SKILL_FILE);
  // Byte gate check first: a character takes at least 1 byte; only worth reading to count chars if within 4x
  if (fs.statSync(file).size > SKILL_LIMITS.chars * 4) throw new Error(`${SKILL_FILE} is too large`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > SKILL_LIMITS.chars) throw new Error(`${SKILL_FILE} exceeds ${SKILL_LIMITS.chars} characters`);
  const parsed = parseSkillMd(text);
  if (!parsed) throw new Error('No fields wrapped in --- at the start');
  const { name } = parsed.fields;
  const description = parsed.fields.description?.trim();
  if (!name || name.length > 64 || !NAME.test(name)) throw new Error('Invalid name: use only lowercase letters, digits and single hyphens, 1-64 characters');
  if (name !== folder) throw new Error(`name (${name}) differs from the folder name`);
  if (!description || description.length > SKILL_LIMITS.descriptionChars) throw new Error(`description is required and must not exceed ${SKILL_LIMITS.descriptionChars} characters`);
  return { name, description, dir, body: parsed.body };
}

/**
 * Scan skill directories. Prioritizes earlier entries in `dirs`: later duplicates are not
 * accepted, so external roots must precede built-in ones. Nonexistent directories or invalid
 * folders are not errors: this round runs as usual, with skipped reasons placed in `skipped`.
 * Raw filesystem errors contain disk paths, so keep only error codes in `skipped`.
 */
export function loadSkillCatalog({ dirs = [] } = {}) {
  const skills = new Map();
  // Malformed skills of same name in external roots still occupy name, no quiet fallback to built-in:
  // host should know it failed
  const seen = new Set();
  const skipped = [];
  const skip = (folder, reason) => { if (skipped.length < SKILL_LIMITS.skipped) skipped.push({ folder, reason }); };
  const why = (e) => (e?.code ? `Cannot read (${e.code})` : e?.message || String(e));
  const absent = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
  for (const root of dirs) {
    let names;
    try { names = fs.readdirSync(root).sort(); } catch (e) { if (!absent(e)) skip(path.basename(root), why(e)); continue; }
    for (const folder of names) {
      if (seen.has(folder)) continue;
      const dir = path.join(root, folder);
      // Folders without SKILL.md are not skill folders (docs, other dirs), not skipped; errors need recorded
      // reasons, so existsSync is not used
      try { fs.lstatSync(path.join(dir, SKILL_FILE)); } catch (e) { if (!absent(e)) { seen.add(folder); skip(folder, why(e)); } continue; }
      seen.add(folder);
      if (skills.size >= SKILL_LIMITS.skills) { skip(folder, `Exceeds the limit of ${SKILL_LIMITS.skills}`); continue; }
      try { skills.set(folder, readSkill(dir, folder)); } catch (e) { skip(folder, why(e)); }
    }
  }
  return { skills: [...skills.values()], skipped };
}

/** The section appended to the system prompt; empty string when there are no skills */
export function skillCatalogPrompt(skills) {
  if (!skills?.length) return '';
  const clip = (s) => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > SKILL_LIMITS.listedChars ? `${one.slice(0, SKILL_LIMITS.listedChars)}…` : one; };
  return '\n\n## Skills\n\nBelow are the skills available here, each a written guide for doing a kind of work. When a task matches a skill\'s purpose, call `load_skill` to read the full text before you start, then follow it; skip the ones that don\'t match.' +
    ' A skill is only guidance and loosens no restriction: the creativity level and tool scope stay as they are, and scripts bundled with a skill must not be run.\n\n' +
    skills.map((s) => `- ${s.name}:${clip(s.description)}`).join('\n');
}

const namedLike = (name, target) => name.toLowerCase() === target.toLowerCase();

/** Whether the folder contains `scripts/`; `Scripts` also counts on case-insensitive systems */
function hasScripts(dir) {
  try { return fs.readdirSync(dir).some((name) => namedLike(name, 'scripts')); } catch { return false; }
}

/**
 * Accompanying docs in the folder (relative paths, slash-separated). Symlinks not followed,
 * `scripts/` not listed; unreadable subdirs omitted, full skill text still provided.
 */
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

/** Read an accompanying doc. Path must be relative inside folder and resolve inside it (blocks symlinks) */
function readBundled(skill, file) {
  const rel = String(file).replace(/\\/g, '/');
  const parts = rel.split('/');
  // Colon blocks Windows drive letters and alternate data streams (`run.py:a.md`)
  if (!rel || rel.startsWith('/') || rel.includes(':') || parts.includes('..') || !TEXT_FILE.test(rel)) {
    throw skillError('skill-file-denied', `Cannot read ${rel || '(empty path)'}: only .md and .txt files inside this skill folder can be read, and the path must be relative.`);
  }
  let real, base;
  try { real = fs.realpathSync(path.join(skill.dir, ...parts)); base = fs.realpathSync(skill.dir); }
  catch { throw skillError('skill-file-not-found', `Skill ${skill.name} has no ${rel}.`); }
  const inside = path.relative(base, real);
  if (!inside || inside.split(path.sep)[0] === '..' || path.isAbsolute(inside)) throw skillError('skill-file-denied', `Cannot read ${rel}: it points outside this skill folder.`);
  // Links in the folder can point to .py: check again after resolution
  if (!TEXT_FILE.test(real)) throw skillError('skill-file-denied', `Cannot read ${rel}: it does not point to an .md or .txt file.`);
  let stat, text;
  // Raw error text contains disk paths, tool results enter events and diagnostics; keep error code only
  try {
    stat = fs.statSync(real);
    if (stat.isFile() && stat.size <= SKILL_LIMITS.chars * 4) text = fs.readFileSync(real, 'utf8');
  } catch (e) { throw skillError('skill-file-unreadable', `Cannot read ${rel} (${e?.code || 'unknown error'}).`); }
  if (!stat.isFile()) throw skillError('skill-file-not-found', `Skill ${skill.name} has no ${rel}.`);
  if (text === undefined || text.length > SKILL_LIMITS.chars) throw skillError('skill-file-too-large', `${rel} exceeds ${SKILL_LIMITS.chars} characters and cannot be read.`);
  return text;
}

/** `load_skill` tool. Reads instructions only, bypasses callTool */
export function loadSkillTool(skills) {
  return {
    name: 'load_skill',
    description: 'Read the full text of a skill. The "Skills" section of the system prompt lists the available skills; when a task matches, read before you start. When the full text mentions an attached document, read it with file.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        file: { type: 'string', description: 'Optional: an attached .md or .txt document in this skill folder (relative path, e.g. references/style.md). If omitted, the full skill text is read.' },
      },
      required: ['name'],
    },
    async execute(input) {
      const skill = skills.find((s) => s.name === input.name);
      if (!skill) throw skillError('skill-not-found', `No skill named ${input.name}. Available: ${skills.map((s) => s.name).join(', ')}.`);
      // Models often write unused optional parameters as null; treat as not provided
      if (input.file !== undefined && input.file !== null) return { ok: true, name: skill.name, file: input.file, text: readBundled(skill, input.file) };
      const files = bundledFiles(skill.dir);
      return {
        ok: true,
        name: skill.name,
        text: skill.body,
        ...(files.length ? { files } : {}),
        ...(hasScripts(skill.dir) ? { scripts: 'This skill comes with scripts/, which cannot be run here. Steps in the full text that need a script cannot be done: complete them with the existing tools, and state in the final report what could not be done.' } : {}),
      };
    },
  };
}
