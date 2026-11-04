/**
 * Gatekeeper script for J2: the driver protocol for the prerender page can only go through
 * `window.__*`, and must match word for word with the two-column manifest in
 * `docs/guides/bake-page-protocol.md`.
 *
 * Does three things:
 *   1. Scans frame capture code on the Node side and collects all reads and writes of `window.__…`;
 *   2. Parses the two tables in the doc (Required for HTML path / PNG path · puppeteer dedicated),
 *      computes the symmetric difference of both sides, and fails if not empty;
 *   3. Asserts that both the export page and the stage page attach `__pcCreateSnapshot` (the stage
 *      page also provides `__pcCreateSnapshot`).
 *
 * Run directly: `node scripts/verify-bake-protocol.mjs`. The drop target for npm test is
 * `server/test/bake-protocol.test.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Only scan these: prerender page drivers are all here (capture-snapshot.mjs has no window.__, no need to scan) */
export const SCANNED_FILES = [
  'server/bakery/chrome.mjs',
  'server/bakery/bake.mjs',
  'server/bakery/shards.mjs',
  'server/bakery/media.mjs',
  'server/bakery/ffmpeg.mjs',
  'server/bakery/export.mjs',
  'server/bakery/audio-mix.mjs',
  'server/bakery/frame-ready.mjs',
  'server/bakery/capture-frame.mjs',
  'server/bakery/frame-media.mjs',
];

export const DOC = 'docs/guides/bake-page-protocol.md';

const SECTIONS = [
  { heading: 'HTML 路必需', key: 'html' }, // i18n-allow: section titles of the Chinese doc
  { heading: 'PNG 路 / puppeteer 专用', key: 'png' }, // i18n-allow
];

/** All `window.__xxx` appearing in files, recorded along with which file it appears in */
export function scanUsage() {
  const found = new Map();
  for (const file of SCANNED_FILES) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const m of text.matchAll(/window\.(__[A-Za-z0-9_$]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(file);
    }
  }
  return found;
}

/** Names listed in the two columns of the doc. Table rows take the form `| \`__pcSetT\` | … | … |` */
export function readDocLists() {
  const text = fs.readFileSync(path.join(root, DOC), 'utf8');
  const lists = {};
  for (let i = 0; i < SECTIONS.length; i++) {
    const { heading, key } = SECTIONS[i];
    const start = text.indexOf(`## ${heading}`);
    if (start < 0) throw new Error(`${DOC} is missing section "## ${heading}"`);
    const rest = text.slice(start + heading.length + 3);
    const nextHeading = rest.indexOf('\n## ');
    const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
    const names = new Set();
    for (const m of body.matchAll(/^\|\s*`(__[A-Za-z0-9_$]+)`\s*\|/gm)) names.add(m[1]);
    if (!names.size) throw new Error(`${DOC}: the "${heading}" section has no names at all`);
    lists[key] = names;
  }
  return lists;
}

export function verifyBakeProtocol() {
  const problems = [];
  const usage = scanUsage();
  const lists = readDocLists();
  const documented = new Set([...lists.html, ...lists.png]);

  const both = [...lists.html].filter(name => lists.png.has(name));
  for (const name of both) problems.push(`\`${name}\` appears in both lists, it can belong to only one`);

  for (const [name, files] of [...usage].sort()) {
    if (!documented.has(name)) {
      problems.push(`\`${name}\` (${[...files].join(', ')}) is not in the two lists of ${DOC}`);
    }
  }
  for (const name of [...documented].sort()) {
    if (!usage.has(name)) {
      problems.push(`${DOC} lists \`${name}\`, but the scanned files do not use it`);
    }
  }

  // Stage page also provides __pcCreateSnapshot: both pages share the same src/render/createSnapshot.ts.
  for (const page of ['src/ExportView.tsx', 'src/StageView.tsx']) {
    const text = fs.readFileSync(path.join(root, page), 'utf8');
    if (!/window\.__pcCreateSnapshot\s*=/.test(text)) problems.push(`${page} does not set window.__pcCreateSnapshot`);
    if (!/createSnapshot\s*\(/.test(text)) problems.push(`${page} does not call createSnapshot()`);
    if (!/\[data-pc-scene\]/.test(text)) problems.push(`${page} calls generate snapshots without going through the [data-pc-scene] scene root`);
  }
  if (!/舞台页也提供\s*`__pcCreateSnapshot`/.test(fs.readFileSync(path.join(root, DOC), 'utf8'))) { // i18n-allow: matches the Chinese doc
    problems.push(`${DOC} is missing the line "舞台页也提供 \`__pcCreateSnapshot\`"`); // i18n-allow: quotes the Chinese doc
  }
  return { problems, usage, lists };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { problems, usage, lists } = verifyBakeProtocol();
  if (problems.length) {
    console.error('The prerender page driver protocol does not match the manifest:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`PASS: all ${usage.size} window.__* are in the two lists of ${DOC} (HTML path ${lists.html.size} / PNG path ${lists.png.size}), and both the export page and the stage page set __pcCreateSnapshot.`);
}
