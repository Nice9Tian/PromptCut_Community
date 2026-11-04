import type { Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { originOk as guardOriginOk, viaStagePort } from './http-guard.mjs';
import { isPrerender } from './render-role.mjs';
import { proxyToPrerender } from './prerender-client.mjs';
import {
  readEffective, writeCardFile, overridesRoot, overrideFileFor, repoFileForOverride,
  effectiveIsFile, userCardDirEntries, overlayOnlyUserFiles,
  setCardHasher, setCardIdentifier, emitCardSourceChange,
} from './card-overrides.mjs';
import { createCardSync, isSyncablePath, sourceHash } from './card-sync.mjs';
import { accountCardProtocols, accountDocUrlAllowed, cardSyncConnect } from './account-card-link.mjs';
import { cardCodePreimage, localImportsOf, CARD_CODE_ID_HEX } from '../src/render/cardCodeIdentity.mjs';
// Sync file source gate: checkpoint stays in this file (cardOverridesLoader), passing all through
// by default; injects strict review rules for hosted rendering when cloud build extension table
// is present
const { checkSyncedSource, rejectedStub, hostedWorkerKind, normalizeBrowserCssImports } = await (async () => {
  const pass = {
    hostedWorkerKind: (): 'resident' | 'isolated' | null => null,
    checkSyncedSource: (_rel: string, _source: string, _options?: { rootHas?: (p: string) => boolean }): { ok: boolean; errors: string[] } => ({ ok: true, errors: [] }),
    rejectedStub: (_rel: string, _errors: string[], _options?: { raw?: boolean }): string => 'export default null;\n',
    normalizeBrowserCssImports: (text: string): string => text,
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gateFile = fs.existsSync(path.join(here, 'vite-plugin-hosted-gate.ts'))
    ? path.join(here, 'vite-plugin-hosted-gate.ts')
    : path.resolve(process.cwd(), 'server', 'vite-plugin-hosted-gate.ts');
  if (!fs.existsSync(gateFile)) return pass;
  try {
    const mod: any = await import(pathToFileURL(gateFile).href);
    const sg = mod?.buildExtensions?.sourceGate;
    return sg ? { ...pass, ...sg } : pass;
  } catch {
    return pass;
  }
})();
import { remotionStyleErrors } from './remotion-style-check.mjs';
import { remotionLockSuffix } from '../src/online/cardRuntime/remotionLock.mjs';
import { tr } from './i18n.mjs';

/* ────────────────────────────────────────────────────────────────────
 * From 0.4: Agent can read and edit original source code of **all** cards (built-in cards
 * included), but cannot edit HTML.
 *
 * Why "edit source, not HTML": DOM on stage is a derivative rendered by React from source and
 * parameters; next render will overwrite directly edited DOM, and every frame during export also
 * re-renders from source: editing DOM is equivalent to creating a second truth. Therefore DOM is
 * inspect-only (inspect_card_dom, marking which source line rendered each node), and modifications
 * always land back in source (edit_card). See docs/archive/topics/render-rebuild-plan.md
 * "Target architecture".
 *
 * Editable scope is restricted to card directories and shared parts library; kernel, editor, and
 * server are strictly off limits. Built-in files are backed up to out/card-edits/ before edits,
 * recoverable if corrupted.
 * ──────────────────────────────────────────────────────────────────── */

/** Directories scanned when finding definition files by card id (non-recursive: subdirectories like vendor/ are implementations referenced by cards, not cards) */
const CARD_DEF_DIRS = ['src/cards/native', 'src/cards/magicui'];
/** Scope of source code that Agent can edit */
const EDITABLE_ROOTS = ['src/cards/', 'src/parts/'];
const EDITABLE_EXT = /\.(tsx|ts|css)$/;
const MAX_EDIT_BYTES = 256 * 1024;

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** Whether Agent can edit this relative path: under card / part directory, source or style file, not a test */
export function isEditablePath(rel: string): boolean {
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return EDITABLE_ROOTS.some((r) => rel.startsWith(r)) && EDITABLE_EXT.test(rel);
}

/** Card id → source file defining it (relative to repo root). User cards first, then built-in cards; returns null if neither */
export function findCardFile(root: string, id: string): string | null {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) return null;
  // When an overlay layer exists, user cards not originally on this machine exist only in the overlay
  // layer (see card-overrides.mjs file header)
  if (effectiveIsFile(root, path.join(root, 'src', 'cards', 'user', `${id}.tsx`))) return `src/cards/user/${id}.tsx`;
  const re = new RegExp(`\\bid:\\s*["'\`]${id}["'\`]`);
  for (const dir of CARD_DEF_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.tsx')) continue;
      // Read effective content (overlay layer first): id and exports cannot be edited, but checks must
      // match the copy that is actually loaded
      const src = readEffective(root, path.join(abs, f));
      if (re.test(src) && /\bCardDef\b/.test(src)) return `${dir}/${f}`;
    }
  }
  return null;
}

/** Local files directly used by a file (relative imports within editable scope); style files also count: half the visuals are in CSS */
export function localImports(root: string, rel: string): string[] {
  // The version in the overlay layer might import additional files: closure, share count, and code
  // hash must all be calculated based on the copy actually loaded.
  // Rules for "which files to track" are shared with online pages (`src/render/cardCodeIdentity.mjs`);
  // here only injecting the "overlay layer first" reading strategy.
  return localImportsOf(rel, {
    read: (r: string) => readEffective(root, path.join(root, r)),
    isFile: (r: string) => effectiveIsFile(root, path.join(root, r)),
  });
}

/** All local source of a card: definition file + card / part files it uses throughout (first is definition file) */
export function importClosure(root: string, rel: string, limit = 60): string[] {
  const seen = [rel];
  for (let i = 0; i < seen.length && seen.length < limit; i++) {
    for (const r of localImports(root, seen[i])) if (!seen.includes(r)) seen.push(r);
  }
  return seen;
}

/** All card definition files (user cards + built-in cards), used to count "how many cards share this file" */
function allCardFiles(root: string): string[] {
  const out: string[] = [];
  for (const f of userCardDirEntries(root)) if (f.endsWith('.tsx')) out.push(`src/cards/user/${f}`);
  for (const dir of CARD_DEF_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.tsx') && /\bCardDef\b/.test(fs.readFileSync(path.join(abs, f), 'utf8'))) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** How many cards' source closures contain each file. Editing a shared file modifies that many cards; tell Agent */
export function sharedByCounts(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of allCardFiles(root)) for (const r of importClosure(root, f)) counts.set(r, (counts.get(r) || 0) + 1);
  return counts;
}

/** Newly added `compositing: 'independent'` in source: sole authority for this value is review table (A0.2) */
const COMPOSITING_INDEPENDENT = /compositing\s*:\s*['"`]independent['"`]/g;

/**
 * Whether this file has a named export of a CardDef **object**.
 *
 * The 7 aggregate array files like `export const nativeCards: CardDef<any>[] = [...]` also look
 * like `export const xxx: CardDef`, but they have no object to write fields on: requiring frameMode
 * cannot be applied to them, otherwise any edit is rejected unconditionally. Array declarations are
 * therefore excluded based on "whether the space between `:` and `=` ends with `[]`".
 */
const CARDDEF_DECL = /export\s+const\s+\w+\s*:\s*CardDef\b([^=]*)=/g;
export function hasCardDefObject(source: string): boolean {
  for (const m of source.matchAll(CARDDEF_DECL)) {
    if (!/\[\s*\]\s*$/.test(m[1])) return true;
  }
  return false;
}

/** Patterns forbidden to **newly** appear after edits: export pushes time by frame; these don't follow frames. Existing spared (author's business) */
const RISKY_PATTERNS: [RegExp, string][] = [
  [/\bDate\.now\s*\(/g, 'Date.now(): to read the time, use the t passed to the component'],
  [/\bnew\s+Date\s*\(\s*\)/g, 'new Date(): to read the time, use the t passed to the component'],
  [/\bsetTimeout\s*\(|\bsetInterval\s*\(/g, 'setTimeout / setInterval driving animation: use motion\'s animate, or read t'],
  [/\bIntersectionObserver\b/g, 'IntersectionObserver: a card plays as soon as it mounts, there is no "scroll into viewport"'],
  [/\bsetAnimationLoop\b/g, 'setAnimationLoop: write the 3D scene as a pure function of t, and call render explicitly again when t changes (follow scene-3d.tsx)'],
  [COMPOSITING_INDEPENDENT, "compositing: 'independent': \"draws only itself, can be prerendered separately and moved to the cloud\" is a review conclusion and can only be written in the review table src/cards/capabilities.json (A0.2); a declaration in the source does not count"],
];

/** Whether a single edit to a built-in / shared file can be written to disk */
export function checkSourceEdit(rel: string, before: string, after: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (Buffer.byteLength(after, 'utf8') > MAX_EDIT_BYTES) errors.push(`The edit is over ${MAX_EDIT_BYTES / 1024}KB, too large.`);
  if (/\.(tsx|ts)$/.test(rel)) {
    const out = ts.transpileModule(after, {
      reportDiagnostics: true,
      fileName: rel,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    });
    for (const d of out.diagnostics || []) {
      const pos = d.start !== undefined ? after.slice(0, d.start).split('\n').length : undefined;
      errors.push(`Syntax error${pos ? ` (line ${pos})` : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
  /*
   * Card files declared as remotion-style (`frameMode: "direct"`): checked by remotion-style rules
   * (`remotion-style-check.mjs`), each with line numbers. Built-in cards are not written with
   * frameworks, so this uses delta criteria: only violations newly added in this edit are rejected;
   * pre-existing ones are not penalized.
   * On such files, it replaces the entries about time and timers in the table below (the copy for
   * those entries advises using Motion, which is incorrect for remotion-style cards).
   */
  const remotion = /\.(tsx|ts)$/.test(rel) && hasCardDefObject(after)
    ? remotionStyleErrors(after, { before, fileName: rel, legacyAbsolute: false })
    : null;
  if (remotion) errors.push(...remotion.errors);
  for (const [re, why] of RISKY_PATTERNS) {
    if (remotion?.remotionStyle && re !== COMPOSITING_INDEPENDENT) continue;
    const n0 = (before.match(re) || []).length;
    const n1 = (after.match(re) || []).length;
    if (n1 > n0) errors.push(`This edit newly added ${why}.`);
  }
  // Card definition files: CardDef named export and id cannot be changed; otherwise the registry
  // will not recognize it, or its identity changes
  if (/export\s+const\s+\w+\s*:\s*CardDef/.test(before)) {
    if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(after)) errors.push('After the edit there is no `export const xxx: CardDef` anymore. The registry relies on it to recognize the card.');
    const idOf = (s: string) => (s.match(/\bid:\s*["'`]([^"'`]+)["'`]/) || [])[1];
    if (idOf(before) !== idOf(after)) errors.push(`The id of CardDef changed from "${idOf(before)}" to "${idOf(after)}". A card id cannot change, clips on the timeline use it to find the card.`);
    // frameMode is an absolute check, not delta: A0.1 has already filled in all 31 CardDef object files;
    // it must not be dropped after editing: losing it falls back to "dynamically derived from timing",
    // and scheduling will quietly take a different path.
    if ((hasCardDefObject(before) || hasCardDefObject(after)) && !/\bframeMode\s*:/.test(after)) {
      errors.push('The frameMode field is missing in CardDef. How frames are obtained (direct / stateful) must be hard-coded, not inferred.');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Save an original copy before modifying card files, returning relative path of the backup.
 * Both built-in / shared files and user cards are backed up (`cloud-task.md` B2: user cards are
 * also backed up); also used before sync overwrites the local copy (C6.6 Section 5, card-level
 * reuse of edit_card backup mechanism).
 */
export function backupBeforeEdit(root: string, rel: string, content: string): string {
  const dir = path.join(root, 'out', 'card-edits');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}__${rel.replace(/\//g, '__')}`);
  fs.writeFileSync(file, content, 'utf8');
  return toRel(root, file);
}

/* ── source map: map "transformed" line numbers recorded by React back to source line numbers ──
 * React 19 dev build leaves _debugStack on each fiber, containing the JSX line location that
 * rendered this node: but the line number is from Vite-transformed code (in testing,
 * rank-bars.tsx:59 is an animate property in the original file). After source map conversion,
 * it is 6/6 accurate. Decode VLQ ourselves instead of pulling in a third-party package:
 * it is only a few dozen lines, and the install package might not include that package. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode mappings: return [gen col, source file index, orig line, orig col] per line (generated code), all 0-based */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let src = 0, oLine = 0, oCol = 0;
  for (const lineStr of mappings.split(';')) {
    const segs: number[][] = [];
    let gCol = 0;
    if (lineStr) {
      for (const segStr of lineStr.split(',')) {
        const vals: number[] = [];
        let shift = 0, value = 0;
        for (const ch of segStr) {
          let d = B64.indexOf(ch);
          const cont = d & 32;
          d &= 31;
          value += d << shift;
          if (cont) shift += 5;
          else { vals.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
        }
        if (!vals.length) continue;
        gCol += vals[0];
        if (vals.length >= 4) { src += vals[1]; oLine += vals[2]; oCol += vals[3]; segs.push([gCol, src, oLine, oCol]); }
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** Generated code line and col (both 1-based) → original position (1-based); returns null if not found */
export function originalPosition(decoded: number[][][], line: number, col: number): { line: number; col: number } | null {
  const segs = decoded[line - 1];
  if (!segs || !segs.length) return null;
  let hit: number[] | null = null;
  for (const s of segs) { if (s[0] <= col - 1) hit = s; else break; }
  hit = hit || segs[0];
  return { line: hit[2] + 1, col: hit[3] + 1 };
}

/** A node in the read-only DOM tree (collected from the page, with source location filled in by server) */
export interface DomNode {
  ref: number;
  parent: number;
  tag: string;
  cls: string;
  text: string;
  owner: string | null;
  site: { path: string; line: number; col: number } | null;
  where?: string;
  rect: number[];
  wrap: number;
  desc: number;
  children: number[];
}

/**
 * Format the node table into text for the model: from fromRef down depth levels, labeling
 * anything beyond as "…N more descendants [ref_x]".
 * Flag when the same source line appears multiple times among siblings (lists generated by .map):
 * modifying that line will change all of them simultaneously.
 */
export function formatDomTree(nodes: DomNode[], fromRef: number, depth: number, maxLines = 160): string {
  const out: string[] = [];
  let truncated = 0;
  const walk = (ref: number, d: number) => {
    const n = nodes[ref];
    if (!n) return;
    if (out.length >= maxLines) { truncated++; return; }
    const siblings = n.parent >= 0 ? nodes[n.parent].children.map((c) => nodes[c]) : [];
    const sameSite = n.where ? siblings.filter((s) => s.where === n.where).length : 0;
    const parts = [
      `[ref_${n.ref}]`,
      n.tag + (n.cls ? '.' + n.cls : ''),
      n.text ? JSON.stringify(n.text) : '',
      n.owner ? `‹${n.owner}›` : '',
      n.where || '',
      sameSite > 1 ? `(the same source line produced ${sameSite} sibling nodes)` : '',
      n.wrap ? `(collapsed ${n.wrap} wrapper layers)` : '',
      `${n.rect[2]}×${n.rect[3]}@${n.rect[0]},${n.rect[1]}`,
    ].filter(Boolean);
    if (d >= depth && n.children.length) parts.push(`...${n.desc} more descendants, pass ref:${n.ref} to look further down`);
    out.push('  '.repeat(d) + parts.join(' '));
    if (d < depth) for (const c of n.children) walk(c, d + 1);
  };
  walk(fromRef, 0);
  if (truncated) out.push(`...output stops at ${maxLines} lines, ${truncated} more nodes are not listed; pick a ref to look further down`);
  return out.join('\n');
}

/**
 * Collect stage DOM tree in export page (executed inside the page). Collapse wrapper layers that
 * "have only one child and no text of their own":
 * In testing, card content is always below levels 6-7, and top levels are shells of ExportView /
 * Stage; without collapsing, "inspecting three levels" yields nothing.
 */
function EXTRACT_DOM(): DomNode[] {
  const stage = document.getElementById('root')?.firstElementChild;
  if (!stage) return [];
  const fiberOf = (el: Element): any => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? (el as any)[k] : null;
  };
  const ownerName = (el: Element) => {
    let f = fiberOf(el);
    while (f) { if (typeof f.type === 'function') return f.type.displayName || f.type.name || null; f = f.return; }
    return null;
  };
  // The first frame of _debugStack is jsxDEV itself; look down for the first call site inside /src/
  const siteOf = (el: Element) => {
    const f = fiberOf(el);
    const s = f && f._debugStack ? String(f._debugStack.stack || f._debugStack) : '';
    for (const l of s.split('\n').slice(1)) {
      if (/jsx-dev-runtime|react-dom|react_stack_bottom_frame/.test(l)) continue;
      const m = l.match(/https?:\/\/[^/]+(\/src\/[^?:)\s]+)(?:\?[^:)\s]*)?:(\d+):(\d+)/);
      if (m) return { path: m[1], line: Number(m[2]), col: Number(m[3]) };
    }
    return null;
  };
  const ownText = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
  const nodes: DomNode[] = [];
  const visit = (el: Element, parent: number): number => {
    let cur = el;
    let wrap = 0;
    while (cur.children.length === 1 && !ownText(cur)) { cur = cur.children[0]; wrap++; }
    const r = cur.getBoundingClientRect();
    const node: DomNode = {
      ref: nodes.length, parent,
      tag: cur.tagName.toLowerCase(),
      cls: (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.'),
      text: ownText(cur).slice(0, 40),
      owner: ownerName(cur), site: siteOf(cur),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      wrap, desc: cur.querySelectorAll('*').length, children: [],
    };
    nodes.push(node);
    for (const c of [...cur.children]) node.children.push(visit(c, node.ref));
    return node.ref;
  };
  visit(stage, -1);
  return nodes;
}

/** Only keep clip for clipId (same approach as isolateClip in vite-plugin-vision, written separately to avoid coupling) */
export function isolateClipForDom(project: any, clipId: string): { project: any; clip: any } | null {
  for (const track of project?.tracks || []) {
    for (const clip of track.clips || []) {
      if (clip.id !== clipId) continue;
      const keepMedia = clip.mediaId ? (project.media || []).filter((m: any) => m.id === clip.mediaId) : [];
      return { clip, project: { ...project, media: keepMedia, tracks: [{ ...track, hidden: false, clips: [clip] }] } };
    }
  }
  return null;
}

/**
 * Card creation endpoint.
 *
 * AI file tools are locked inside exports/ai-workspace/ (see harness/tools/textEditor.mjs) and
 * cannot reach src/cards/. This endpoint is the only opening, and is strictly limited to the
 * src/cards/user/ directory, allows only .tsx, and one file at a time: creating cards should
 * not grant the ability to modify the entire codebase.
 *
 * The desktop app runs a real vite dev server (see desktop/src-tauri/src/lib.rs), so once files
 * are written to disk, HMR compiles and loads them directly, with no restart or repackaging needed.
 */

const MAX_SOURCE_BYTES = 64 * 1024;
/** kebab-case, and cannot start with mu- (that is the Magic UI prefix) */
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/**
 * Only accept same-origin requests, consistent with AI write endpoints. Uses the same check
 * in http-guard: the prerender process must also allow the origin from the editor side
 * (/api/cards/dom runs on prerender, and the editor page fallback path will connect directly
 * cross-origin); writing separate versions in two places will inevitably lead to discrepancies.
 */
function originOk(req: { headers: Record<string, any> }): boolean {
  return guardOriginOk(req);
}

/** A non-compliance issue found in review. tier determines the problem category for the caller (usually the model) */
export interface CardFinding {
  /**
   * 2 = mechanisms the pipeline cannot handle yet (canvas / random / frame-by-frame accumulation),
   * waiting for tightening on the export script side;
   * 3 = mouse / scroll / click driven; export has no input and stays at initial state, needs to be
   * converted to parameter-driven;
   * deps = imported uninstalled third-party libraries; keyframes = used undefined animate-* animations;
   * license = ported code lacks source and license declarations, or license prohibits distribution.
   */
  tier: 2 | 3 | 'deps' | 'keyframes' | 'license';
  rule: string;
  detail: string;
}

export interface CardCheck {
  ok: boolean;
  errors: string[];
  /** Tiered findings from the review gate; empty array when there are no issues */
  findings?: CardFinding[];
}

/* ────────────────────────────────────────────────────────────────────
 * Translator: converts third-party component (MagicUI, etc.) source code into cards for
 * src/cards/user/.
 *
 * Split into two halves. The **mechanical half** is here: strip Next.js directives, point aliases
 * like @/lib/utils locally, review against the verified mechanism manifest, and infer controls from
 * props types. The **semantic half** (how to write useWhen, which constants to extract as
 * parameters, how to split parts) is delegated to the model once during import: that part cannot
 * be inferred mechanically from code.
 *
 * Review tiers come from testing: 11 cards (6 built-in + 5 MagicUI) underwent byte-for-byte
 * comparisons of "fresh vs reused vs static skip" on the openBakery/bakeFrames pipeline; Motion's
 * WAAPI and JS paths, CSS animations, React state, rAF, useInView, and useSpring all had 0 diff;
 * canvas particles, Math.random, and rAF loops accumulating frame-by-frame cannot be handled yet
 * (free-running virtual time during screenshot capture advances them an indeterminate number of
 * steps). Mouse / scroll driven components have no input source during export and are another class.
 * ──────────────────────────────────────────────────────────────────── */

/** Importable modules: third-party libraries outside these are not installed; importing them fails compilation */
const ALLOWED_IMPORTS: RegExp[] = [
  /^react$/, /^react\/jsx-runtime$/, /^react-dom$/,
  /^motion\/react$/, /^motion$/,
  /^lottie-web$/, /^@tsparticles\/(engine|slim)$/,   // Two libraries that are installed and verified on the export pipeline
  /^three$/, /^three\/.+$/,         // 3D: installed, and verified byte-for-byte identical on the export pipeline (see tier 2 section below)
  /^\.\.?\//,                       // Relative paths (kernel/types, native/hud, magicui/vendor/*)
];

/** Tailwind v4 built-in animate-* */
const BUILTIN_ANIMATES = new Set(['spin', 'ping', 'pulse', 'bounce', 'none']);
/** MagicUI animations already ported into src/cards/magicui/vendor/magicui-animations.css */
const VENDORED_ANIMATES = new Set([
  'accordion-down', 'accordion-up', 'gradient', 'meteor', 'marquee', 'marquee-vertical',
  'spin-around', 'shiny-text', 'shimmer-slide', 'ripple', 'rippling', 'line', 'orbit',
  'background-position-spin', 'shine', 'pulse', 'pulse-ripple', 'rainbow', 'line-shadow',
  'aurora', 'ping', 'blink-cursor',
]);

/** Licenses that can be distributed with the install package */
const LICENSE_OK = /\b(MIT|Apache[- ]2\.0|BSD[- ][23][- ]Clause|\bBSD\b|ISC|CC0|Unlicense|0BSD)\b/i;
/** Cannot be ported: Commons Clause forbids redistributing components; Hippocratic is non-OSI; GSAP forbids no-code animation tools */
const LICENSE_BAD = /Commons[- ]Clause|Hippocratic|Aceternity|\bGSAP\b|proprietary|All rights reserved|专有/i; // i18n-allow

/* ── Portable catalog: raw source for all MagicUI components + review gate tiers ──
 * Located in server/catalog/magicui/ (not under src, so tsc and vite will not compile those raw files).
 * Models view the catalog via card_authoring_guide and fetch source via get_card_source({cardId:"mu-<name>"}),
 * wrap it into a CardDef, and use the same id with create_card: no new tools needed, no internet required.
 */
const catalogDir = new URL('./catalog/magicui/', import.meta.url);

interface CatalogEntry {
  name: string; id: string; file: string; description: string;
  tier: 1 | 2 | 3 | 'deps'; blockers: string[]; props: string[]; imported: string | null;
}

function loadCatalog(): { license: string; components: CatalogEntry[] } | null {
  try {
    return JSON.parse(fs.readFileSync(new URL('./index.json', catalogDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Catalog source: only accepts mu-<name>, where name must be in index.json to prevent reading other files with the id */
export function readCatalogSource(id: string): { name: string; source: string; entry: CatalogEntry } | null {
  const m = /^mu-([a-z0-9-]+)$/.exec(id);
  const cat = m && loadCatalog();
  const entry = cat && cat.components.find((c) => c.name === m![1]);
  if (!entry) return null;
  try {
    return { name: entry.name, source: fs.readFileSync(new URL(`./${entry.name}.tsx`, catalogDir), 'utf8'), entry };
  } catch {
    return null;
  }
}

/** Render catalog as guide end section. Grouped by tier, one component per line: id, one sentence, porting notes */
export function renderCatalog(): string {
  const cat = loadCatalog();
  if (!cat) return '';
  const groups: Record<string, CatalogEntry[]> = { 1: [], deps: [], 3: [], 2: [] };
  for (const c of cat.components) (groups[String(c.tier)] ||= []).push(c);
  const line = (c: CatalogEntry) =>
    `- \`${c.id}\` —— ${c.description}${c.imported ? `(already in the library: \`${c.imported}\`)` : ''}${c.props.length ? `; upstream props: ${c.props.join(', ')}` : ''}${c.blockers.length ? `; to handle: ${c.blockers.join(', ')}` : ''}`;
  return [
    '## Appendix: movable Magic UI catalog',
    '',
    `Source ${cat.license}, ${cat.components.length} components, source code is local. To use one: read the original source with \`get_card_source({ cardId: "mu-<name>" })\` → wrap it into a CardDef following "Moving third-party components" above, write the source in the file header → create the card with the same id using \`create_card\`. The tier comes from the review gate.`,
    '',
    `### Ready to move now (${groups[1].length})`, ...groups[1].map(line), '',
    `### Imports libraries that are not installed; when moving, bring in the lines used or remove them (${groups.deps.length})`, ...groups.deps.map(line), '',
    `### Interaction / scroll driven; must be changed to parameters driven by t to enter export (${groups[3].length})`, ...groups[3].map(line), '',
    `### Not supported by the pipeline yet (${groups[2].length})`, ...groups[2].map(line), '',
    renderAssets(),
  ].join('\n');
}

/** Lottie and particle asset catalog: ready files, no card creation; directly add_clip existing cards with URL in parameters */
function renderAssets(): string {
  const read = (kind: string) => {
    try { return JSON.parse(fs.readFileSync(new URL(`./catalog/${kind}/index.json`, import.meta.url), 'utf8')); } catch { return null; }
  };
  const out: string[] = [];
  // note is model observation from 6-frame montage, more specific than human description; prefer if present; use is suggested scenario
  const desc = (i: any) => (i.note ? `${i.note}${i.use ? `(${i.use})` : ''}` : i.description);
  const lottie = read('lottie');
  if (lottie) {
    out.push(`## Appendix: Lottie assets (${lottie.items.length}, ${lottie.license})`, '',
      'Usage: `add_clip({ cardId: "lottie", params: { src: "<url>" } })`; set the clip duration to match seconds; to loop, add `loop: "yes"`.', '',
      ...lottie.items.map((i: any) => `- \`${i.url}\` —— ${desc(i)};${i.seconds}s,${i.w}×${i.h}`), '');
  }
  const particles = read('particles');
  if (particles) {
    const featured = particles.items.filter((i: any) => i.featured);
    const rest = particles.items.filter((i: any) => !i.featured);
    out.push(`## Appendix: particle configs (${particles.items.length}, ${particles.license})`, '',
      'Usage: `add_clip({ cardId: "particles", params: { config: "<url>", seed: 1 } })`. All are backgrounds, usually placed on the bottom track covering the whole duration; change seed to change the layout. Each one has been verified by running it on the export pipeline.', '',
      `### Recommended (${featured.length})`, ...featured.map((i: any) => `- \`${i.url}\` —— ${desc(i)}`), '',
      `### Others (${rest.length}, mostly variants of the same look)`,
      rest.map((i: any) => `\`${i.name}\`(${i.note || i.description})`).join(', '), '');
  }
  return out.join('\n');
}

/**
 * Mechanical translation: performs only deterministic replacements. Returns modified source
 * code and a manifest of "what changed", which is returned as-is to the caller: the model
 * needs to know how the file differs from what it submitted.
 */
export function translateCardSource(source: string): { source: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = source.replace(/\r\n/g, '\n');

  // Next.js client directive; meaningless in Vite and, if kept, would be treated as an unused string expression
  if (/^\s*["']use client["'];?\s*$/m.test(out)) {
    out = out.replace(/^\s*["']use client["'];?\s*\n?/m, '');
    rewrites.push('Removed the "use client" directive (Next.js only)');
  }
  // cn alias from shadcn / MagicUI ecosystem → local copy (files in src/cards/user/, so go up one level then into magicui)
  if (/from\s+["']@\/lib\/utils["']/.test(out)) {
    out = out.replace(/from\s+["']@\/lib\/utils["']/g, 'from "../magicui/vendor/cn"');
    rewrites.push('@/lib/utils → ../magicui/vendor/cn (local cn)');
  }
  return { source: out, rewrites };
}

/** Whether file header (first 40 lines) has "Source:" declaration, and whether it looks ported from shadcn/MagicUI ecosystem */
function provenance(source: string): { declared: boolean; looksVendored: boolean; header: string } {
  const header = source.split('\n').slice(0, 40).join('\n');
  return {
    declared: /^\s*(?:\/\/+|\/?\*+)\s*(?:来源|source)\s*[:：]/im.test(header) || /@source\b|Source:\s*https?:/i.test(header), // i18n-allow
    // Only matches alias and site/repo names, not path fragments: local ../magicui/vendor/cn also contains "magicui", which is our own
    looksVendored: /@\/lib\/utils|@\/components\/|magicui\.design|magicuidesign|shadcn|aceternity|react-bits/i.test(source),
    header,
  };
}

/**
 * Review gate: tiered based on the tested mechanisms manifest. Here it **only handles newly added
 * categories**; the three legacy rules for Date.now / timers / IntersectionObserver remain in
 * checkCardSource, with unchanged error messages.
 */
/**
 * Strip comments and keep only code. Used for checks like "whether an API is used": mentioning
 * a name in comments does not mean it was used, especially comments that **specifically explain
 * "why not to use it"**. A // inside a string should not be treated as a comment start, so quote
 * state must be tracked rather than relying blindly on regular expressions.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote = "";      // Which quote type currently inside ("" = none)
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
      if (c === quote) quote = "";
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      // Replace with a newline to avoid merging tokens on either side of the comment
      out += "\n";
      continue;
    }
    out += c; i++;
  }
  return out;
}

export function reviewCardSource(source: string, hints?: { vendored?: boolean; remotionStyle?: boolean }): CardFinding[] {
  const f: CardFinding[] = [];
  const push = (tier: CardFinding['tier'], rule: string, detail: string) => f.push({ tier, rule, detail });

  // ── Tier 2: pipeline cannot handle ──
  // canvas and Math.random used to be in this tier, but are no longer: the export page pins
  // Math.random to a seeded version, disables script execution during screenshot capture
  // (exportClock.ts / server/bakery/bake.mjs shoot), and the static-skip probe can also see canvas.
  // In testing, the tsParticles particle card showed 0 byte-for-byte diff across "fresh vs reused vs skipped".
  //
  // WebGL used to be in this tier too, but is no longer. The original reasoning ("taking the GPU path
  // yields slight inconsistencies between runs") was actually the **opposite**: the export setup's
  // --disable-gpu did not make it take GPU paths at all, but shut it down completely: getContext("webgl")
  // returned null, producing an empty canvas without even throwing an error. Now with
  // --enable-unsafe-swiftshader using SwiftShader software rasterization, testing shows the scene-3d
  // card (three.js) is byte-for-byte identical across 20/20 frames in two passes on the real export
  // pipeline, and the old 15/15 baseline is unaffected.
  //
  // What remains truly unhandled is not WebGL, but **frame loops that accumulate by delta**: the
  // free-running virtual time during screenshot capture advances them an indeterminate number of
  // steps, and scrubbing the playhead backward does not rewind. Therefore, this tier now blocks that pattern.
  /*
   * Matching only the literal `setAnimationLoop(` is not sufficient. In testing four cases:
   *   bare requestAnimationFrame + performance.now() accumulating delta (three)  → allowed
   *   renderer.setAnimationLoop(...)                                             → blocked
   *   requestAnimationFrame + auto-incrementing counter (without even reading clocks) → allowed ← the trickiest one
   *   const fn = "setAnimationLoop"; renderer[fn](...)                           → allowed
   *
   * But we cannot block on sight whenever rAF is seen: rAF itself is **verified to work fine** on this
   * pipeline (Motion's JS animations use it, with 0 byte-for-byte diff), and a blanket ban would shut
   * out a large number of cards that are otherwise fine.
   * What is truly unhandled is the combination of "driving a 3D scene by itself": so it is only blocked
   * when both conditions hold simultaneously.
   */
  /*
   * Match the **name itself**, not invocation form: indirection like `const fn = "setAnimationLoop"; renderer[fn](cb)`
   * cannot be caught by matching only `setAnimationLoop(`.
   *
   * But inspect only code, not comments: the error message for this rule directs authors to
   * "follow the implementation in scene-3d.tsx", yet that card's comments explain precisely
   * why setAnimationLoop **cannot** be used. If comments were matched as well, anyone following
   * that reference would be rejected by this rule, citing the very reference it recommended.
   */
  const code = stripComments(source);
  const usesRaf = /\brequestAnimationFrame\b|\bsetAnimationLoop\b/.test(code);
  const uses3D = /\bfrom\s+["']three(\/[^"']*)?["']|\bnew\s+THREE\.|\bWebGLRenderer\b|getContext\s*\(\s*["']webgl2?["']/.test(code);
  if (/\bsetAnimationLoop\b/.test(code) || (usesRaf && uses3D)) {
    push(2, 'Own frame loop', 'A 3D scene running its own frame loop (setAnimationLoop / requestAnimationFrame) cannot be handled by this pipeline: during export, the freely running virtual time inside the screenshot window makes it advance an uncertain number of steps, so two export passes do not match; dragging the playhead back also does not restore the original state. Write the picture as a pure function of t (e.g. rotation.y = t * rotation speed * 2π) and call render explicitly once when t changes. Follow the approach in src/cards/native/scene-3d.tsx, whose card never registers a single rAF.');
  }
  if (/\bfrom\s+["'](@react-three\/[^"']+|cobe|@react-three-fiber[^"']*)["']/.test(source)) {
    push(2, '3D framework', '@react-three/fiber and cobe both ship their own rAF frame loop (same reason as above), and neither is installed. For 3D, use three directly (installed) and render by t as in src/cards/native/scene-3d.tsx.');
  }

  // ── Tier 3: driven by input, but export has no input ──
  if (/addEventListener\s*\(\s*["'](mousemove|pointermove|mouseenter|mouseleave|wheel|scroll|touchmove)["']/.test(source)
    || /\bon(MouseMove|PointerMove|MouseEnter|MouseLeave|Wheel|TouchMove)\s*=/.test(source)) {
    push(3, 'Mouse/scroll events', 'There is no mouse and no scrolling during export, so such effects only stay in their initial state. Change "where the cursor is" and "how far it is scrolled" into a parameter driven by t, and the effect can enter export.');
  }
  if (/\bwhile(Hover|Tap|Drag|Focus|InView)\s*=/.test(source)) {
    // remotion-style cards cannot use Motion; copy avoids mentioning Motion (another line-numbered rule exists in remotion-style-check.mjs)
    push(3, 'whileHover/whileTap/whileInView', hints?.remotionStyle
      ? 'Same as above: hover / tap / entering the viewport never happen in export. To make it appear, write it as a condition on t; do not hang it on interaction.'
      : 'Same as above: hover / tap / entering the viewport never happen in export. To make it play, use initial + animate; do not hang it on interaction.');
  }
  if (/\buse(Scroll|Velocity)\s*\(|window\.scrollY|scrollTop/.test(source)) {
    push(3, 'Scroll driven', 'Same as above: the export page does not scroll.');
  }

  // ── Dependencies: uninstalled libraries ──
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) {
      push('deps', `import "${spec}"`, spec.startsWith('@/')
        ? `Alias ${spec} points to a file in the original project, which is not present here. @/lib/utils is automatically rewritten to the local cn; for anything else, either remove it or move the lines used into this file.`
        : hints?.remotionStyle
          ? `${spec} is not installed. A remotion-style card can import the framework "../../kernel/remotionStyle", react, and, by relative path, kernel/types, kernel/frameReady, kernel/soundEffects, render/cards/graphValues, native/hud, native/sound-effects, magicui/vendor/cn.`
          : `${spec} is not installed. Installed are react, motion/react, three, lottie-web, @tsparticles/engine|slim, plus Tailwind classes and, by relative path, kernel/types, native/hud, magicui/vendor/*.`);
    }
  }

  // ── Animation classes: used undefined animate-* ──
  const usedAnimates = new Set<string>();
  for (const m of source.matchAll(/\banimate-([a-z][a-z0-9-]*)/g)) usedAnimates.add(m[1]);
  for (const name of usedAnimates) {
    if (BUILTIN_ANIMATES.has(name) || VENDORED_ANIMATES.has(name)) continue;
    push('keyframes', `animate-${name}`, hints?.remotionStyle
      ? `This animation class is not defined (Tailwind only ships spin/ping/pulse/bounce; the 22 MagicUI groups have already been moved into magicui-animations.css). Remotion-style cards do not use CSS animation: write time-varying styles as functions of t.`
      : `This animation class is not defined (Tailwind only ships spin/ping/pulse/bounce; the 22 MagicUI groups have already been moved into magicui-animations.css). Write its @keyframes and .animate-${name} into that file, or switch to motion/react.`);
  }

  // ── Source and license: ported code must declare source, and license must permit distribution ──
  const p = provenance(source);
  if (p.declared || p.looksVendored || hints?.vendored) {
    if (!p.declared) {
      push('license', 'Source not declared', 'This code looks like it was moved over from the shadcn / MagicUI ecosystem. The file header must state "Source: <URL>" and the license (follow src/cards/magicui/vendor/word-rotate.tsx), otherwise we cannot know whether it may be distributed with the installer.');
    } else if (LICENSE_BAD.test(p.header)) {
      push('license', 'License does not allow distribution', 'The declared license cannot be moved: React Bits\' Commons Clause forbids redistributing the components themselves, Aceternity is a proprietary license, animate.css\'s Hippocratic is not an OSI license, and GSAP forbids use in no-code animation tools. Use a different source.');
    } else if (!LICENSE_OK.test(p.header)) {
      push('license', 'License not on the allowlist', 'The file header does not state a recognizable license. Allowed are MIT / Apache-2.0 / BSD / ISC / CC0; write the name from the original repo\'s LICENSE on the source line.');
    }
  }

  return f;
}

/** Infer controls suggestions from the first *Props interface in source code; returns empty if inference fails */
export function suggestControls(source: string): { key: string; label: string; type: string; hint?: string }[] {
  const sf = ts.createSourceFile('card.tsx', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const SKIP = new Set(['className', 'children', 'style', 'ref', 'key', 'id']);
  const out: { key: string; label: string; type: string; hint?: string }[] = [];

  const visit = (node: ts.Node): boolean => {
    if (ts.isInterfaceDeclaration(node) && /Props$/.test(node.name.text)) {
      for (const m of node.members) {
        if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name) || !m.type) continue;
        const key = m.name.text;
        if (SKIP.has(key)) continue;
        const t = m.type;
        if (t.kind === ts.SyntaxKind.StringKeyword) out.push({ key, label: key, type: 'text' });
        else if (t.kind === ts.SyntaxKind.NumberKeyword) out.push({ key, label: key, type: 'number' });
        else if (t.kind === ts.SyntaxKind.BooleanKeyword) out.push({ key, label: key, type: 'select', hint: 'options: true / false' });
        else if (ts.isArrayTypeNode(t) && t.elementType.kind === ts.SyntaxKind.StringKeyword) out.push({ key, label: key, type: 'text', hint: tr("Upstream is string[], separated by |, the component does split(\"|\")") });
        else if (ts.isUnionTypeNode(t) && t.types.every((u) => ts.isLiteralTypeNode(u) && ts.isStringLiteral(u.literal))) {
          const opts = t.types.map((u) => ((u as ts.LiteralTypeNode).literal as ts.StringLiteral).text);
          out.push({ key, label: key, type: 'select', hint: 'options: ' + opts.join(' / ') });
        }
      }
      return true;
    }
    return ts.forEachChild(node, visit) ?? false;
  };
  visit(sf);
  return out;
}

/**
 * Static check before writing to disk. This blocks categories of errors that "would cause a white
 * screen in the editor if written"; remaining runtime issues are left to Vite compilation errors
 * and user preview.
 */
export function checkCardSource(
  id: string,
  source: string,
  existingIds: string[],
  /**
   * mode has no default value; hardcoded across three production call sites (A0.1(c)):
   *   - `author`: cards authored on the spot by Agent / user (create_card, user card edit_card).
   *     frameMode is required, and adding new `compositing: 'independent'` is not allowed:
   *     `before` is source code before editing; pass an empty string for newly created cards.
   *   - `install`: deploy bundled cards during installation (installBundledCards). Neither rule is
   *     checked: that source code was reviewed in the repository, and installation is not an act
   *     of creation.
   * vendored: the translator has confirmed this is ported code (rewritten @/lib/utils, etc.),
   * so source declaration is required
   */
  hints: { mode: 'author' | 'install'; before?: string; vendored?: boolean },
): CardCheck {
  const errors: string[] = [];
  const authoring = hints.mode === 'author';

  if (!ID_RE.test(id)) {
    errors.push(`Card id "${id}" is invalid: use lowercase kebab-case (e.g. my-title-card), with only letters, digits and hyphens.`);
  }
  // mu- is the Magic UI namespace. Hand-written cards cannot claim it; cards ported by the
  // translator from magicui.design that declare source in the file header can use it: this keeps
  // the id prefix trustworthy: mu- means "from MagicUI", regardless of who ported it.
  if (id.startsWith('mu-') && !/^\s*(?:\/\/+|\/?\*+)\s*(?:来源|source)\s*[:：][^\n]*magicui/im.test(source.split('\n').slice(0, 40).join('\n'))) { // i18n-allow
    errors.push('The mu- prefix is reserved for Magic UI adapter cards, pick another id. (Cards ported from magicui.design whose file header says "Source: …magicui…" are allowed.)');
  }
  // lottie- / particles- are media wrapper card namespaces (src/cards/assets, from asset catalog build); hand-written cards cannot claim them
  if (/^(lottie|particles)-/.test(id)) {
    errors.push('The lottie- / particles- prefixes are reserved for wrapper cards generated from the asset catalog, pick another id.');
  }
  if (existingIds.includes(id)) {
    errors.push(`A card with id "${id}" already exists. Card ids must be unique, pick another; to change the existing card, edit its file directly.`);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    errors.push(`The source is over ${MAX_SOURCE_BYTES / 1024}KB, which is too large.`);
  }

  // Must actually export a CardDef; otherwise glob collection silently skips it, resulting in nothing created
  if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(source)) {
    errors.push('The source has no named export of the form `export const xxx: CardDef<Params> = { ... }`; auto-registration relies on it to recognize cards.');
  }
  const idInSource = source.match(/\bid:\s*["'`]([^"'`]+)["'`]/);
  if (!idInSource) {
    errors.push('CardDef has no id field.');
  } else if (idInSource[1] !== id) {
    errors.push(`The id in CardDef is "${idInSource[1]}", which does not match the id passed in, "${id}"; they must be the same.`);
  }
  const required = ['name', 'description', 'defaults', 'controls'];
  // frameMode: authored cards must declare how frames are obtained; not checked when deploying bundled cards during install (A0.1(c))
  if (authoring) required.push('frameMode');
  for (const field of required) {
    if (!new RegExp(`\\b${field}\\s*:`).test(source)) {
      errors.push(`CardDef is missing the ${field} field.`);
    }
  }

  /*
   * Where visuals come from: DOM cards specify `Component`, media effect cards specify `card`
   * (visual) or `audio` (audio); at least one of the three. We cannot only look for `Component`:
   * media effect cards per H1 simply do not write it, and being rigid rejected three sample media
   * effect cards with 400 in create_card.
   */
  if (!/\bComponent\s*:/.test(source) && !/\bcard\s*:/.test(source) && !/\baudio\s*:/.test(source)) {
    errors.push('CardDef has none of Component / card / audio: a DOM card uses Component, a media effect card uses card (visual) or audio (audio); at least one of the three must be present.');
  }

  // Same delta rule as checkSourceEdit: for new cards before = '', so reject on sight
  if (authoring) {
    const n0 = ((hints.before ?? '').match(COMPOSITING_INDEPENDENT) || []).length;
    const n1 = (source.match(COMPOSITING_INDEPENDENT) || []).length;
    if (n1 > n0) {
      errors.push("Do not write compositing: 'independent' in the source: \"draws only itself, can be prerendered alone in the cloud\" is a review conclusion decided by the review sheet src/cards/capabilities.json; writing it here has no effect.");
    }
  }

  /*
   * remotion-style cards (`frameMode: "direct"`) have another set of line-numbered checks
   * (`remotion-style-check.mjs`): only allowed to import the framework, do not read real time, do not
   * use timers or per-frame callbacks, do not use Motion or CSS animations, do not use unseeded
   * random, do not carry state over to the next frame, and only write constants at top level.
   * Checked only when creating or editing cards (`author`); not checked during card installation,
   * and cards already in the library are loaded as usual. Cards declared as motion-style do not go
   * through this suite, and checks remain the same as before.
   */
  const remotion = authoring
    ? remotionStyleErrors(source, { before: hints.before, fileName: `src/cards/user/${ID_RE.test(id) ? id : 'card'}.tsx` })
    : null;
  const remotionStyle = remotion?.remotionStyle === true;

  // These rules are hard constraints: export uses a virtual clock, so cards reading real time will
  // be out of sync during export. Remotion-style cards are checked by the ruleset above (also
  // rejected on sight, with line numbers, and messaging does not reference Motion), so do not report
  // redundantly here
  if (!remotionStyle) {
    if (/\bDate\.now\s*\(/.test(source)) {
      errors.push('Do not use Date.now(): export runs on virtual time, so it will not line up with the frames. Leave animation to motion/react, and to read the time use the t the component receives.');
    }
    if (/\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(source)) {
      errors.push('Do not drive animation with setTimeout / setInterval: during export they are not controlled by the virtual clock. Use animate from motion/react, or read the component parameter t.');
    }
    if (/\bIntersectionObserver\b/.test(source)) {
      errors.push('Do not use IntersectionObserver: a card plays as soon as it mounts, there is no such thing as "scrolling into the viewport".');
    }
  }

  // Syntax check: block malformed files here rather than saving them and crashing HMR
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  for (const d of out.diagnostics || []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const pos = d.start !== undefined ? source.slice(0, d.start).split('\n').length : undefined;
    errors.push(`Syntax error${pos ? ` (line ${pos})` : ''}: ${msg}`);
  }

  // Review gate: tiered findings also count as rejection reasons, and write the tier into the
  // message: the model only sees the error string, so it must be able to tell at a glance whether
  // "this is a pipeline limitation", "this must be changed to parameter-driven", or "this is a
  // license issue".
  if (remotion) errors.push(...remotion.errors);
  // For imports and CSS animations rejected with line numbers by remotion-style checks, review gate findings do not report redundantly
  const rejectedRules = new Set((remotion?.violations ?? []).map((v) => v.rule));
  const findings = reviewCardSource(source, { ...hints, remotionStyle }).filter((x) => !(
    (x.tier === 'deps' && (rejectedRules.has('import') || rejectedRules.has('motion')))
    || (x.tier === 'keyframes' && rejectedRules.has('css-animation'))
  ));
  const TIER_LABEL: Record<string, string> = {
    2: '[Tier 2·pipeline not supported yet]', 3: '[Tier 3·interaction-driven]', deps: '[Dependencies]', keyframes: '[Animation class]', license: '[Source/license]',
  };
  for (const x of findings) errors.push(`${TIER_LABEL[String(x.tier)]} ${x.rule}:${x.detail}`);

  return { ok: errors.length === 0, errors, findings };
}

/**
 * Apply a find/replace to source code.
 *
 * Separated into a pure function not for reuse, but for testability: error cases such as match
 * counts, $ tokens, and no-op changes do not throw errors; they just silently alter the file into
 * something else: which is precisely the defect this feature is designed to eliminate.
 */
export function applyCardPatch(
  before: string,
  find: string,
  replace: string,
  replaceAll?: boolean,
): { ok: true; after: string; replaced: number } | { ok: false; error: string } {
  if (!find) return { ok: false, error: 'find cannot be an empty string, it would match every position.' };

  const hits = before.split(find).length - 1;
  if (hits === 0) {
    return {
      ok: false,
      error: 'find did not match anywhere in the source: your version does not match the file. Call get_card_source first to read back the current source, and write find from it (indentation and spaces must match).',
    };
  }
  if (hits > 1 && !replaceAll) {
    return {
      ok: false,
      error: `find matched ${hits} places, so it is unclear which one to change. Make find longer and include the surrounding lines to make it unique; to change them all, pass replaceAll: true.`,
    };
  }

  // Use split/join instead of String.replace: the latter treats $&, $`, $', and $$ in the replacement
  // as "matched content reference" replacement tokens and expands them, whereas the replacement here
  // is verbatim source code written by the model and must be written to disk as-is.
  const after = before.split(find).join(replace);
  if (after === before) {
    return { ok: false, error: 'replace is identical to find, so this edit changed nothing.' };
  }
  return { ok: true, after, replaced: hits };
}

/** Maximum custom cards a .proc can hold. Any more no longer looks like a project; file was likely tampered with */
export const MAX_BUNDLED_CARDS = 200;

export interface CardInstallResult {
  id: string;
  status: 'written' | 'updated' | 'unchanged' | 'rejected';
  error?: string;
  /** Backup of the local previous version when updated (relative to project root) */
  backup?: string;
  /** Actual file written to; differing from base version indicates written to overlay layer, requiring manual HMR trigger */
  written?: string;
  abs?: string;
}

/**
 * Installs custom cards bundled in a .proc back into src/cards/user/ (called when opening a
 * project; see src/editor/io/procCards.ts).
 *
 * Rules:
 *   - **Same review** as create_card (translator + checkCardSource): the .proc may be sent by
 *     someone else, and the source code inside will execute in the editor. Cards failing review
 *     are not installed, leaving any existing local version intact;
 *   - existingIds should only contain IDs of **built-in cards**: matching a built-in card name is a
 *     collision; matching a user card name is an "update";
 *   - Not present locally → written via writeCardFile: with an overlay layer, write to the overlay
 *     layer (no files written to checkout directory; loading entry receives it via userOverlay);
 *     without an overlay layer (development phase), write to base version;
 *   - Present locally and identical → do nothing;
 *   - Present locally but differs → **the copy stored in the project takes precedence**. Opening a
 *     project should display how it was saved; the local previous version is first backed up to
 *     historyDir by content hash (backed up only once per copy), so toggling between two projects
 *     will not pile up backups.
 */
export function installBundledCards(opts: {
  root: string;
  historyDir: string;
  cards: unknown;
  existingIds: string[];
}): CardInstallResult[] {
  const userDir = path.join(opts.root, 'src', 'cards', 'user');
  const list = Array.isArray(opts.cards) ? opts.cards.slice(0, MAX_BUNDLED_CARDS) : [];
  const out: CardInstallResult[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const id = (raw as { id?: unknown })?.id;
    const source = (raw as { source?: unknown })?.source;
    if (typeof id !== 'string' || typeof source !== 'string') {
      out.push({ id: String(id ?? '?'), status: 'rejected', error: 'id and source must both be strings' });
      continue;
    }
    // Check ID against whitelist before touching filesystem: this check guards against path traversal
    if (!ID_RE.test(id)) {
      out.push({ id, status: 'rejected', error: `Card id "${id}" is invalid` });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const translated = translateCardSource(source);
    const finalSource = translated.source;
    const check = checkCardSource(id, finalSource, opts.existingIds, { vendored: translated.rewrites.length > 0, mode: 'install' });
    if (!check.ok) {
      out.push({ id, status: 'rejected', error: check.errors.join('\n') });
      continue;
    }

    const abs = path.join(userDir, `${id}.tsx`);
    if (path.dirname(path.resolve(abs)) !== path.resolve(userDir)) {
      out.push({ id, status: 'rejected', error: 'Invalid file path' });
      continue;
    }

    if (!effectiveIsFile(opts.root, abs)) {
      const written = writeCardFile(opts.root, abs, finalSource);
      out.push({ id, status: 'written', abs, written });
      continue;
    }

    const before = readEffective(opts.root, abs);
    if (before.replace(/\r\n/g, '\n') === finalSource) {
      out.push({ id, status: 'unchanged' });
      continue;
    }
    const hash = crypto.createHash('sha1').update(before).digest('hex').slice(0, 10);
    fs.mkdirSync(opts.historyDir, { recursive: true });
    const backupAbs = path.join(opts.historyDir, `${id}.${hash}.tsx`);
    if (!fs.existsSync(backupAbs)) fs.writeFileSync(backupAbs, before, 'utf8');
    const written = writeCardFile(opts.root, abs, finalSource);
    out.push({ id, status: 'updated', backup: toRel(opts.root, backupAbs), abs, written });
  }
  return out;
}

export type CreateUserCardResult =
  | { ok: false; code: number; body: Record<string, unknown> }
  | {
    ok: true;
    /** The file in the repository (src/cards/user/<id>.tsx) */
    target: string;
    /** Actual file written to */
    written: string;
    already: boolean;
    translated: ReturnType<typeof translateCardSource>;
    finalSource: string;
    suggestedControls: ReturnType<typeof suggestControls>;
  };

/**
 * Disk-write portion of create_card (called by `/api/cards/create`; ownership stamp, HMR, and sync
 * upload remain in the API). If already exists (the active copy, overlay layer prioritized) without
 * overwrite → 409; fails translator + review → 400; otherwise written via writeCardFile: with an
 * overlay layer, write to overlay layer (nothing written to checkout directory); without an overlay
 * layer (development phase), write to `src/cards/user/`.
 */
export function createUserCard(opts: { root: string; id: unknown; source: unknown; existingIds?: unknown; overwrite?: unknown }): CreateUserCardResult {
  const { root, id, source, existingIds, overwrite } = opts;
  if (typeof id !== 'string' || typeof source !== 'string') {
    return { ok: false, code: 400, body: { ok: false, error: 'id and source must both be strings' } };
  }
  const userDir = path.join(root, 'src', 'cards', 'user');
  const target = path.join(userDir, `${id}.tsx`);
  // ID already passed kebab-case whitelist; confirm once more here that drop target did not escape user dir
  if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
    return { ok: false, code: 400, body: { ok: false, error: 'Invalid file path' } };
  }

  // Existence judged by active copy: with overlay layer, user cards not originally local exist only in overlay layer
  const already = effectiveIsFile(root, target);
  if (already && !overwrite) {
    // This message appears right when the model "wants to modify an existing card": the single place
    // across the entire repository that most needs to steer it toward edit_card. Previously this said
    // "pass overwrite: true", which effectively taught it at the decision point to rewrite the whole thing.
    return {
      ok: false,
      code: 409,
      body: {
        ok: false,
        error: `src/cards/user/${id}.tsx already exists. To change it, read the source back with get_card_source and then change that spot with edit_card; pass overwrite: true only if you really want to redo the whole card.`,
      },
    };
  }

  // Run mechanical half of translator first (strip "use client", point @/lib/utils locally), then review.
  // Return whatever translation modified to caller; otherwise model's version won't match what is on disk.
  const translated = translateCardSource(source);
  const finalSource = translated.source;
  const check = checkCardSource(id, finalSource, Array.isArray(existingIds) && !already ? existingIds : [], {
    vendored: translated.rewrites.length > 0,
    mode: 'author',
    before: '',
  });
  if (!check.ok) {
    return {
      ok: false,
      code: 400,
      body: {
        ok: false,
        error: check.errors.join('\n'),
        errors: check.errors,
        findings: check.findings ?? [],
        rewrites: translated.rewrites,
      },
    };
  }

  // Props present upstream but omitted from controls; listed for the model to decide whether to promote to parameters
  const declared = new Set([...finalSource.matchAll(/\bkey:\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const suggestedControls = suggestControls(finalSource).filter((s) => !declared.has(s.key));

  // Written via writeCardFile (overlay layer prioritized). Previously wrote directly to base version:
  // when the overlay layer had an older version of this card (modified by edit_card, installed via sync),
  // the load hook still yielded the overlay copy, hiding overwrite's new content; cards not originally
  // local were also written into the checkout directory.
  const written = writeCardFile(root, target, finalSource);
  return { ok: true, target, written, already, translated, finalSource, suggestedControls };
}

/** Built-in card IDs (`id: "..."` in definition dirs outside user): for collision checks when installing user cards */
export function builtinCardIds(root: string): string[] {
  const ids = new Set<string>();
  for (const dir of CARD_DEF_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.tsx')) continue;
      let src = '';
      try { src = readEffective(root, path.join(abs, f)); } catch { continue; }
      if (!/\bCardDef\b/.test(src)) continue;
      for (const m of src.matchAll(/\bid:\s*["'`]([a-z][a-z0-9-]*)["'`]/g)) ids.add(m[1]);
    }
  }
  return [...ids];
}

export interface SyncedInstallResult {
  ok: boolean;
  status: 'written' | 'updated' | 'unchanged' | 'rejected';
  error?: string;
  /** The file in the repository */
  abs?: string;
  /** Actual file written to; differing from abs indicates written to overlay layer */
  written?: string;
  /** User card definition file: card ID */
  userCardId?: string;
}

/**
 * Installs a card file synced from content store (C6.6 Section 5; called by `server/card-sync.mjs`).
 * Follows the same path as installing cards when opening a .proc:
 *   - User card definition files (`src/cards/user/<id>.tsx`) are handed to installBundledCards:
 *     same review (translator + checkCardSource), consistently written via writeCardFile: with an
 *     overlay layer, write to overlay layer (including cards not present locally); without an overlay
 *     layer during development, write to repository file, same as edit_card;
 *   - Other files (modified built-in cards, parts, files used by user cards) undergo the edit_card
 *     checks (checkSourceEdit: syntax, no new non-frame-following patterns allowed, CardDef export
 *     and id must not be touched), then written via writeCardFile (overlay layer prioritized,
 *     original cards in repository left untouched).
 * Backups are not handled here: whether to back up is determined by sync rules (whether the local
 * copy is one's own), see card-sync.mjs.
 */
export function installSyncedFile(opts: { root: string; historyDir: string; rel: string; source: string; existingIds?: string[] }): SyncedInstallResult {
  const { root, rel } = opts;
  if (!isEditablePath(rel)) return { ok: false, status: 'rejected', error: `"${rel}" is not a syncable card file` };
  if (typeof opts.source !== 'string') return { ok: false, status: 'rejected', error: 'source must be a string' };
  const after = opts.source.replace(/\r\n/g, '\n');
  const user = /^src\/cards\/user\/([^/]+)\.tsx$/.exec(rel);
  if (user && ID_RE.test(user[1])) {
    const [r] = installBundledCards({
      root,
      historyDir: opts.historyDir,
      cards: [{ id: user[1], source: after }],
      existingIds: opts.existingIds ?? builtinCardIds(root),
    });
    if (!r) return { ok: false, status: 'rejected', error: 'No card install result' };
    return { ok: r.status !== 'rejected', status: r.status, error: r.error, abs: r.abs, written: r.written, userCardId: user[1] };
  }
  const abs = path.join(root, rel);
  if (!path.resolve(abs).startsWith(path.resolve(root) + path.sep)) return { ok: false, status: 'rejected', error: 'Invalid file path' };
  let before: string | null = null;
  try { before = readEffective(root, abs); } catch { before = null; }
  if (before !== null && before.replace(/\r\n/g, '\n') === after) return { ok: true, status: 'unchanged' };
  const check = checkSourceEdit(rel, before ?? '', after);
  if (!check.ok) return { ok: false, status: 'rejected', error: check.errors.join('\n') };
  const written = writeCardFile(root, abs, after);
  return { ok: true, status: before === null ? 'written' : 'updated', abs, written };
}

/**
 * Cards used by project → files to include in card source sync (C6.6 Section 5 "Scope"): in each
 * card's source closure (definition file + referenced card/part files), those considered by
 * `changed(rel)` to be "user cards or modified built-in cards". Unmodified built-in cards exist
 * on both sides and are not synced.
 */
export function cardSyncKeys(root: string, cardIds: unknown, changed: (rel: string) => boolean): string[] {
  if (!Array.isArray(cardIds)) return [];
  const out = new Set<string>();
  for (const id of cardIds.slice(0, 500)) {
    if (typeof id !== 'string' || !ID_RE.test(id)) continue;
    const def = findCardFile(root, id);
    if (!def) continue;
    for (const f of importClosure(root, def)) if (isSyncablePath(f) && changed(f)) out.add(f);
  }
  return [...out].sort();
}

/**
 * Code identity of a card (c66-host-cards; usage in `server/card-code.mjs` header): definition file
 * plus all card/part files it imports along the way (`importClosure`), recording "repo-relative path
 * + content hash of active content (overlay layer prioritized)" per file, then taking the first 32
 * characters of the overall sha256. Content hashing uses the same algorithm as content store
 * (`sourceHash` in `card-sync.mjs`, line endings normalized to LF first): synced cards compute the
 * same identity on both sides.
 *
 * `custom`: user cards (definition or closure contains files under `src/cards/user/`), or closure
 * contains overlay layer files: these cards are not in the global code version, so task requirements
 * and the whole-scene key must include their identities separately. Returns null if definition file
 * cannot be found.
 */
export function cardCodeIdentity(root: string, id: string): { version: string; custom: boolean; files: string[] } | null {
  let def = findCardFile(root, id);
  if (!def && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) {
    // User card filename may not match ID (manually placed files): find by `id:` in definition
    const userDir = path.join(root, 'src', 'cards', 'user');
    const re = new RegExp(`\\bid:\\s*["'\`]${id}["'\`]`);
    try {
      for (const f of userCardDirEntries(root)) {
        if (!f.endsWith('.tsx')) continue;
        let src = '';
        try { src = readEffective(root, path.join(userDir, f)); } catch { continue; }
        if (re.test(src)) { def = `src/cards/user/${f}`; break; }
      }
    } catch { /* No user card directory */ }
  }
  if (!def) return null;
  const files = importClosure(root, def);
  const sha = crypto.createHash('sha256');
  // Pre-digest text matches online page (`cardCodePreimage`): calculates identical identity on both sides
  sha.update(cardCodePreimage(files, (rel: string) => {
    try { return sourceHash(readEffective(root, path.join(root, rel))); } catch { return null; }
  }));
  let custom = false;
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (rel.startsWith('src/cards/user/')) custom = true;
    else {
      const o = overrideFileFor(root, abs);
      if (o && fs.existsSync(o)) custom = true;
    }
  }
  return { version: sha.digest('hex').slice(0, CARD_CODE_ID_HEX), custom, files };
}

/** Card sync instance for standalone render host (result of `createHostCardSync`) */
export interface HostCardSync {
  status(): Record<string, unknown>;
  idle(): Promise<void>;
  close(): void;
}

/**
 * Card source sync for standalone render host (c66-host-cards; C6.6 design doc Section 5 "Read"
 * half): when the host joins a shared project, it pulls down user cards and modified cards via
 * content store `card-source` and installs them into its own overlay layer; when others modify
 * cards, syncs immediately via `content.watch`.
 *
 * - Reuses the project's `render` connection (the one for the queue node, `endpoint`) without
 *   opening a new one: host enters solely with project credentials in config; no page signs tickets
 *   for it. Does not close this connection when unbinding (it belongs to the queue node).
 * - Read-only (`readOnly`): host does not modify cards and never uploads.
 * - Card installation uses `installSyncedFile` (same path as editor sync and installing cards when
 *   opening .proc): consistently written to overlay layer (`card-overrides/` under
 *   `PROMPTCUT_DATA_DIR`, pointed to `--data` by `render-host.mjs`), including user cards not
 *   originally local; not a single file is written to the checkout directory (user card loading
 *   entry receives overlay layer cards via `src/cards/userOverlay.ts`). Backups and install history
 *   are stored in host's own data directory.
 * - Calls `before()` before installing cards (resets timer for card code identity stabilization
 *   period, see `card-code.mjs`); does not manually send change notifications after install,
 *   leaving it to Vite file watcher in this process (which first invalidates modules, then emits
 *   `emitCardSourceChange`); nodes clear identity caches accordingly and claim on next tick under
 *   new code.
 */
export function createHostCardSync(opts: {
  root: string;
  dataDir: string;
  projectId: string;
  url: string;
  endpoint: { send(m: object): unknown; onMessage(h: (m: any) => void): void; onOpen(h: () => void): void; onClose(h: (info: any) => void): void; onResume?(h: () => void): void; stats?(): any; connected?: boolean };
  before?: () => void;
  /** Precheck before installing a file (host's isolated worker process passes to `checkSyncedSource` in `hosted-render/source-gate.mjs`); skip install if failed */
  precheck?: (rel: string, source: string) => { ok: boolean; errors: string[] };
  log?: (event: string, fields?: object) => void;
}): HostCardSync {
  const { root, dataDir, endpoint } = opts;
  const shared = {
    send: (m: object) => endpoint.send(m),
    onMessage: (h: (m: any) => void) => endpoint.onMessage(h),
    onOpen: (h: () => void) => {
      endpoint.onOpen(h);
      // Connection may already be up when sync attaches: add a "connected" event, otherwise reconciliation must wait for next reconnect
      if (endpoint.connected === true) queueMicrotask(h);
    },
    onClose: (h: (info: any) => void) => endpoint.onClose(h),
    // Forward session endpoint (`createDocEndpoint`) resume and diagnostics: resume only counts; diagnostics show transport detach and resume
    onResume: (h: () => void) => endpoint.onResume?.(h),
    stats: () => endpoint.stats?.() ?? null,
    close: () => { /* Connection belongs to queue node */ },
  };
  const sync = createCardSync({
    stateDir: path.join(dataDir, 'card-sync'),
    readOnly: true,
    connect: () => shared,
    files: {
      read: (rel: string) => {
        try { return readEffective(root, path.join(root, rel)); } catch { return null; }
      },
      changed: () => false,
      backup: (rel: string, content: string) => {
        const dir = path.join(dataDir, 'card-edits');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}__${rel.replace(/\//g, '__')}`);
        fs.writeFileSync(file, content, 'utf8');
        return file;
      },
      install: (rel: string, source: string) => {
        // Host's isolated worker process: precheck synced file before install (only when caller provides `precheck`; desktop app and standard standalone render hosts do not)
        if (opts.precheck) {
          let verdict: { ok: boolean; errors: string[] };
          try { verdict = opts.precheck(rel, source); } catch (error: any) { verdict = { ok: false, errors: [String(error?.message ?? error)] }; }
          if (!verdict.ok) return { ok: false, error: `Sync file preflight failed: ${verdict.errors.slice(0, 5).join(';')}` };
        }
        try { opts.before?.(); } catch { /* Timing errors do not block card installation */ }
        const r = installSyncedFile({ root, historyDir: path.join(dataDir, 'card-history'), rel, source });
        return { ok: r.ok, error: r.error };
      },
    },
    log: opts.log,
  });
  sync.bind({ projectId: opts.projectId, url: opts.url, local: false, protocols: () => [] });
  return {
    status: () => sync.status(),
    idle: () => sync.idle(),
    close: () => sync.close(),
  };
}

/** Manifest module of user cards in overlay layer "not in base version" (relative to repo root); disk copy is empty table, load hook swaps in real manifest when overlay layer exists */
export const USER_OVERLAY_MODULE = 'src/cards/userOverlay.ts';

/**
 * Resolves card/part files present in overlay layer but missing from base version: because base
 * version lacks this file, Vite cannot resolve it on its own; this resolves it to the **corresponding
 * path in the repository** (file does not exist), and load hook yields the overlay layer copy upon
 * loading. Module ID mirrors base file form; HMR, invalidation, and `?raw` follow the existing path
 * for overlay layer files. Handles three forms: root-relative (`/src/cards/user/x.tsx`, used by
 * manifest module), relative imports (`./x`, `../x`, for overlay cards referencing each other), and
 * absolute paths. Returns null and defers to Vite if present in base version (or no overlay layer,
 * or not under card/part directories).
 */
export function resolveOverlayOnly(root: string, source: string, importer?: string): string | null {
  if (!overridesRoot() || typeof source !== 'string') return null;
  const q = source.indexOf('?');
  const bare = q >= 0 ? source.slice(0, q) : source;
  const query = q >= 0 ? source.slice(q) : '';
  let abs: string;
  if (bare.startsWith('/src/')) abs = path.join(root, bare);
  else if (bare.startsWith('./') || bare.startsWith('../')) {
    if (!importer) return null;
    abs = path.resolve(path.dirname(importer.split('?')[0]), bare);
  } else if (path.isAbsolute(bare)) abs = path.resolve(bare);
  else return null;
  const rel = toRel(root, abs);
  if (rel.startsWith('..') || !(rel.startsWith('src/cards/') || rel.startsWith('src/parts/'))) return null;
  const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  for (const cand of [abs, `${abs}.tsx`, `${abs}.ts`, path.join(abs, 'index.tsx'), path.join(abs, 'index.ts')]) {
    if (isFile(cand)) return null;
    const o = overrideFileFor(root, cand);
    if (o && isFile(o)) return cand.split(path.sep).join('/') + query;
  }
  return null;
}

/**
 * Content of manifest module (`USER_OVERLAY_MODULE`): user card files present in overlay layer but
 * missing from base version, matching the shape of the three globs in `src/cards/user/index.ts`
 * (keyed by `./<path relative to user card directory>`): module and verbatim source of entry cards
 * (single-level .tsx), plus verbatim text of all source files (for identity caching).
 */
export function userOverlayModuleCode(root: string): string {
  const files: string[] = overlayOnlyUserFiles(root);
  const lines: string[] = [];
  const modules: string[] = [];
  const raws: string[] = [];
  const deps: string[] = [];
  files.forEach((rel, i) => {
    const entry = !rel.includes('/') && rel.endsWith('.tsx');
    const dep = /\.(ts|tsx|mjs|css)$/.test(rel);
    if (!entry && !dep) return;
    const key = JSON.stringify(`./${rel}`);
    lines.push(`import r${i} from ${JSON.stringify(`/src/cards/user/${rel}?raw`)};`);
    if (entry) {
      lines.push(`import * as m${i} from ${JSON.stringify(`/src/cards/user/${rel}`)};`);
      modules.push(`${key}: m${i}`);
      raws.push(`${key}: r${i}`);
    }
    deps.push(`${key}: r${i}`);
  });
  return [
    '// Generated by cardOverridesLoader in vite-plugin-cards: user cards that exist in the changes layer but not in the base version',
    ...lines,
    `export const overlayModules = { ${modules.join(', ')} };`,
    `export const overlayRaws = { ${raws.join(', ')} };`,
    `export const overlayDependencyRaws = { ${deps.join(', ')} };`,
    '',
  ].join('\n');
}

/**
 * Load hook for card overlay layer (card-overrides.mjs): for cards/parts modified in the installed
 * app, loading yields the overlay layer copy, while original repository files act as read-only base
 * versions. Both editor Vite and prerender Vite mount this plugin, so both see identical copies.
 *
 * Separate plugin with `enforce: 'pre'` (C6.6 field test): loading `?raw` is handled by Vite's own
 * `vite:asset` plugin, which runs before standard plugins. This hook, originally mounted on the
 * main plugin, was never reached for `?raw`: custom card source code in the registry (bundling
 * .proc, source version, identity key) always read the base version; changes in the overlay layer
 * took visual effect, but identity keys never changed, so probes skipped catch-up tests. Moving it
 * to pre runs it before `vite:asset`. The main plugin cannot be switched wholesale to pre: its API
 * middleware must run after the `/api/**` same-origin guard.
 */
function cardOverridesLoader(): Plugin {
  let projectRoot = process.cwd();
  /** Only set for host render service worker processes (`resident` / `isolated`); null for other processes, skipping precheck below */
  const hostedKind = hostedWorkerKind();
  return {
    name: 'promptcut-card-overrides',
    enforce: 'pre',
    configResolved(config) {
      projectRoot = config.root;
    },
    resolveId(source, importer) {
      return resolveOverlayOnly(projectRoot, source, importer);
    },
    load(id) {
      if (!overridesRoot()) return null;
      const file = id.split('?')[0];
      if (!path.isAbsolute(file)) return null;
      if (!id.includes('?') && path.resolve(file) === path.resolve(projectRoot, USER_OVERLAY_MODULE)) return userOverlayModuleCode(projectRoot);
      const o = overrideFileFor(projectRoot, file);
      if (!o || !fs.existsSync(o)) return null;
      this.addWatchFile(o);
      const text = fs.readFileSync(o, 'utf8');
      /*
       * Host render service worker process (`docs/plan/hosted-render-contract.md` Section 7.5): files in
       * the overlay layer are project-provided code, which must pass synced file precheck
       * (`hosted-render/source-gate.mjs`) before being handed to Vite and Tailwind on the Node side; files
       * that fail are replaced with an error-throwing stub. Installation already intercepted them once;
       * this is the second guard (for cases where files land in overlay layer without card sync). Resident
       * worker processes should never have overlay layer files in the first place and never load them.
       * Other processes do not run this section.
       */
      if (hostedKind) {
        const rel = toRel(projectRoot, file);
        const verdict = hostedKind === 'isolated' ? checkSyncedSource(rel, text, { rootHas: (p: string) => fs.existsSync(path.join(projectRoot, p)) }) : { ok: false, errors: ['The resident worker process does not load any code brought in by projects'] };
        if (!verdict.ok) {
          console.log(`[page-gate] source-rejected ${JSON.stringify({ rel, errors: verdict.errors.slice(0, 3) })}`);
          return rejectedStub(rel, verdict.errors, { raw: /[?&]raw\b/.test(id) });
        }
      }
      // `?raw` expects the source string (used by cards/user/index.ts when bundling .proc), not the module
      // itself. If passed as-is, Vite runs TSX source as the JS of this ?raw module. Line endings are
      // normalized to LF (same as `raw-eol.mjs`): source version / identity key does not change with
      // checkout method.
      if (/[?&]raw\b/.test(id)) return `export default ${JSON.stringify(text.replace(/\r\n/g, "\n"))}`;
      if (hostedKind === 'isolated' && file.endsWith('.css')) return normalizeBrowserCssImports(text);
      return text;
    },
    /*
     * Locks top level as read-only upon loading (remotion-style framework, second of three read-only
     * barriers): for files under user card directory "declared as remotion-style and referencing the
     * framework", appends a call at the end of source code to freeze top-level objects when module loads
     * (runtime half lives in `src/kernel/remotionStyle/lock.ts`, call target is determined by
     * `src/online/cardRuntime/remotionLock.mjs`, matching the snippet appended during online page
     * transpilation). Appended strictly at the end without altering a single character before it, so no
     * new source map is produced (`map: null` = reuse original), keeping `inspect_card_dom` line numbers
     * unaffected. Other files remain strictly as-is: cards created before the framework existed cannot
     * reference it, and built-in cards are not in the user card directory.
     */
    transform(code, id) {
      if (/[?&](raw|url|inline|worker|sharedworker)\b/.test(id)) return null;
      const file = id.split('?')[0];
      if (!/\.tsx?$/.test(file) || !path.isAbsolute(file)) return null;
      const rel = toRel(projectRoot, file);
      if (!rel.startsWith('src/cards/user/')) return null;
      const suffix = remotionLockSuffix(rel, code);
      return suffix ? { code: code + suffix, map: null } : null;
    },
  };
}

export default function vitePluginCards(): Plugin[] {
  return [cardOverridesLoader(), {
    name: 'promptcut-cards',
    configureServer(server: ViteDevServer) {
      const userDir = path.join(server.config.root, 'src', 'cards', 'user');

      /*
       * Card code hash → render cache key (cardCodeHash in card-overrides.mjs).
       * Computed from active contents of "definition file + dependency closure"; any change to card/part
       * source clears entire table, recomputed upon next use.
       */
      const hashCache = new Map<string, string>();
      // Card code identity (c66-host-cards): used by frame pipeline whole-scene key, queue split requires.cardSources, and node cardSourceVersions
      setCardIdentifier((cardId: string) => cardCodeIdentity(server.config.root, cardId));
      setCardHasher((cardId: string) => {
        const hit = hashCache.get(cardId);
        if (hit !== undefined) return hit;
        const root = server.config.root;
        const def = findCardFile(root, cardId);
        let h = '';
        if (def) {
          const sha = crypto.createHash('sha1');
          for (const f of importClosure(root, def)) {
            sha.update(f);
            try { sha.update(readEffective(root, path.join(root, f))); } catch { /* Unreadable files are not included */ }
          }
          h = sha.digest('hex').slice(0, 12);
        }
        hashCache.set(cardId, h);
        return h;
      });
      const isCardSource = (file: string) => {
        const rel = toRel(server.config.root, file);
        return rel.startsWith('src/cards/') || rel.startsWith('src/parts/');
      };
      const onSource = (file: string) => {
        const over = repoFileForOverride(server.config.root, file);
        if (over) {
          // File in overlay layer changed: Vite watches original file, so manually invalidate module and rerun HMR on original file
          for (const m of server.moduleGraph.getModulesByFile(over.split(path.sep).join('/')) ?? []) server.moduleGraph.invalidateModule(m);
          hashCache.clear();
          server.watcher.emit('change', over);
          return;
        }
        if (!isCardSource(file)) return;
        hashCache.clear();
        emitCardSourceChange(file);
      };
      server.watcher.on('change', onSource);
      server.watcher.on('add', onSource);
      server.watcher.on('unlink', onSource);

      /*
       * Manifest of user cards in overlay layer "not in base version" (`src/cards/userOverlay.ts`,
       * generated by cardOverridesLoader): when files are added or removed in user card directory (base
       * version or overlay layer), if manifest changed, reload this module, and HMR bubbles up along user
       * card loading entry to be handled by src/cards/index.ts. If manifest did not change (existing file
       * content modified, or added/removed files are not source code, e.g. ownership table), do not reload:
       * that path is handled per-file by onSource above. The "manifest" is compared by generated module body.
       */
      let overlayListing = overridesRoot() ? userOverlayModuleCode(server.config.root) : '';
      const reloadUserOverlay = () => {
        if (!overridesRoot()) return;
        const next = userOverlayModuleCode(server.config.root);
        if (next === overlayListing) return;
        overlayListing = next;
        const stub = path.join(server.config.root, USER_OVERLAY_MODULE).split(path.sep).join('/');
        for (const m of server.moduleGraph.getModulesByFile(stub) ?? []) {
          server.moduleGraph.invalidateModule(m);
          void server.reloadModule(m).catch(() => { /* Nothing to HMR if page is not open */ });
        }
      };
      const onUserDirSetChange = (file: string) => {
        const repo = repoFileForOverride(server.config.root, file) ?? file;
        if (toRel(server.config.root, repo).startsWith('src/cards/user/')) reloadUserOverlay();
      };
      server.watcher.on('add', onUserDirSetChange);
      server.watcher.on('unlink', onUserDirSetChange);
      const top = overridesRoot();
      if (top) {
        try { fs.mkdirSync(top, { recursive: true }); server.watcher.add(top); } catch { /* Failure to create just means no HMR */ }
      }

      /*
       * Card ownership table: which custom card belongs to which project.
       *
       * Why it is needed: src/cards/user/ is **a global directory**, and index.ts scans the entire
       * directory with import.meta.glob, so previously cards created by an Agent for project A would still
       * appear in list_cards when opening project B. In the user's exact words: "ThreeJS assets leaked to
       * him again from the previous project": that logo-3d-9tian card was made for a specific client;
       * crossing over into someone else's video is both noise and a risk.
       *
       * Why not write into the card file itself: the registry receives the imported CardDef object, not
       * file text, and cannot read comments in the file header. A side table is the most direct approach.
       *
       * Ownership only records "who created it"; **whether to share is another matter** (scope field),
       * because cross-project reuse is sometimes exactly what is wanted (you still want your own brand card
       * in the next video). Default project = not shared; users can change it to shared in the chat panel.
       *
       * Follows the overlay layer just like card files (reads the active copy, writes via writeCardFile):
       * with an overlay layer, not a single file is written to the checkout directory, and the ownership
       * table lives alongside the cards it registers (user cards not originally local also live only in the
       * overlay layer). When not yet in the overlay layer, reads the checkout copy; the first write writes
       * existing entries into the overlay layer together with new ones.
       */
      const scopeFile = path.join(server.config.root, 'src', 'cards', 'user', '_scopes.json');
      type CardScope = { scope: 'project' | 'custom'; projectId?: string; createdAt?: string };
      const readScopes = (): Record<string, CardScope> => {
        try { return JSON.parse(readEffective(server.config.root, scopeFile)); } catch { return {}; }
      };
      const writeScopes = (m: Record<string, CardScope>) => {
        try { writeCardFile(server.config.root, scopeFile, JSON.stringify(m, null, 2)); } catch { /* Write failure should not cause card creation to fail */ }
      };

      /** HMR after writing card file: base version watched by Vite is unchanged when written to overlay layer, so manually invalidate and rerun HMR as if base version changed */
      const afterWrite = (abs: string, written: string | undefined) => {
        if (written && written !== abs) {
          for (const m of server.moduleGraph.getModulesByFile(abs.split(path.sep).join('/')) ?? []) server.moduleGraph.invalidateModule(m);
          server.watcher.emit('change', abs);
          // User cards not originally local written only to overlay layer: update loading entry manifest (userOverlay) without waiting for watcher add
          reloadUserOverlay();
        }
        emitCardSourceChange(abs);
        // Project object has not changed; page must explicitly remeasure this card after HMR lands.
        server.ws.send({ type: 'custom', event: 'pc:card-sync', data: { type: 'changed', key: toRel(server.config.root, abs) } });
      };

      /*
       * ---------------- Card source sync (C6.6 Section 5, server/card-sync.mjs) ----------------
       *
       * The editor process connects to the document service itself; after each save of a card file
       * (edit_card, create_card, install), content.put puts it into the content store of the current
       * project space;
       * In shared projects, content.list / content.watch additionally installs other members' versions
       * according to rules (installSyncedFile, the same path as installing cards when opening .proc);
       * After installation, it hot-updates following the edit_card approach and emits change
       * notifications (render worker discards the standby page, prerender code hash changes accordingly),
       * then tells the page to retest via HMR.
       *
       * Bindings are provided by the page (at the same time as /api/agent/bind, see
       * src/editor/sync/cardSync.ts):
       *   POST /api/cards/sync/bind   { mode: 'local' | 'ticket', projectId?, url?, ticket?, cardIds? }
       *     - local: local project, connects to the local space of local /docservice, upload only
       *       (the sync half is a no-op, cardRev increments as usual);
       *     - ticket: shared project, connects with a page-role connection ticket signed by the page;
       *       tickets expire in two minutes; on reconnect, requests another ticket from the page via HMR
       *       (`pc:card-sync` with { type: 'ticket', reqId, projectId }, returned by the page via
       *       POST /api/cards/sync/ticket);
       *     - account: account cloud project, same rules as ticket, except the ticket is retrieved by
       *       the page via login from the account session API (subprotocol
       *       `promptcut.account.<ticket>`, `server/account-card-link.mjs`), requested anew whenever a new
       *       session is created;
       *       this connection can only be used until the ticket expires (the lifetime of the account
       *       access token); the page includes `expiresAt` when returning the ticket, switching to a new
       *       session before expiration;
       *     - cardIds: cards used in the project; user cards and modified built-in cards (along with
       *       files they use) that do not yet exist on the service will be uploaded.
       *   POST /api/cards/sync/unbind  returns to local space
       *   GET  /api/cards/sync/status  diagnostics: bindings, bookkeeping, recent notifications
       * Before the page binds, it is attached to local space (connected as soon as the editor starts
       * up). The prerender process does not sync.
       */
      const syncEnabled = !isPrerender && process.env.PROMPTCUT_CARD_SYNC !== '0';
      // Bookkeeping follows the overlay layer: in the installed version, the overlay layer is in the
      // data directory (not lost when patches overwrite runtime/app completely); bookkeeping is also
      // stored there so the two match up
      const overTop = overridesRoot();
      const syncDir = overTop ? path.join(path.dirname(overTop), 'card-sync') : path.join(server.config.root, '.pc-work', 'card-sync');
      const editedFile = path.join(syncDir, 'edited.json');
      const readEdited = (): Set<string> => {
        try { return new Set((JSON.parse(fs.readFileSync(editedFile, 'utf8')) as unknown[]).filter((x): x is string => typeof x === 'string')); } catch { return new Set(); }
      };
      /**
       * No overlay layer during development: modified built-in files are recorded here (in the
       * installed version, checking whether it exists in the overlay layer is enough).
       */
      const noteEdited = (rel: string) => {
        if (rel.startsWith('src/cards/user/') || overridesRoot()) return;
        const s = readEdited();
        if (s.has(rel)) return;
        s.add(rel);
        try { fs.mkdirSync(syncDir, { recursive: true }); fs.writeFileSync(editedFile, JSON.stringify([...s].sort(), null, 2), 'utf8'); } catch { /* Failure to record only affects the "has it been modified" check */ }
      };
      /**
       * User card (exists is enough) or modified built-in card / part (present in the overlay layer, or
       * recorded during development).
       */
      const locallyChanged = (rel: string): boolean => {
        const abs = path.join(server.config.root, rel);
        if (rel.startsWith('src/cards/user/')) return fs.existsSync(abs) || !!(overrideFileFor(server.config.root, abs) && fs.existsSync(overrideFileFor(server.config.root, abs)!));
        const o = overrideFileFor(server.config.root, abs);
        if (o && fs.existsSync(o)) return true;
        return readEdited().has(rel);
      };
      const keysForCards = (cardIds: unknown): string[] => cardSyncKeys(server.config.root, cardIds, locallyChanged);
      const syncLog = (event: string, fields: object = {}) => {
        try { console.info('[cards]', event, JSON.stringify(fields)); } catch { console.info('[cards]', event); }
      };
      /**
       * Requests a page-role connection ticket from the page (the page signs it on its own shared
       * project connection).
       */
      let ticketSeq = 0;
      type PageTicket = { ticket: string; expiresAt?: number };
      const ticketWaiters = new Map<string, { resolve: (t: PageTicket) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const requestPageTicket = (projectId: string) => new Promise<PageTicket>((resolve, reject) => {
        const reqId = `ct${++ticketSeq}`;
        const timer = setTimeout(() => {
          ticketWaiters.delete(reqId);
          reject(new Error('The page did not return a connection ticket within 10 seconds'));
        }, 10_000);
        ticketWaiters.set(reqId, { resolve, reject, timer });
        server.ws.send({ type: 'custom', event: 'pc:card-sync', data: { type: 'ticket', reqId, projectId } });
      });
      let syncProjectId: string | null = null;
      const cardSync = syncEnabled ? createCardSync({
        stateDir: syncDir,
        files: {
          read: (rel: string) => {
            try { return readEffective(server.config.root, path.join(server.config.root, rel)); } catch { return null; }
          },
          changed: (rel: string) => locallyChanged(rel),
          backup: (rel: string, content: string) => backupBeforeEdit(server.config.root, rel, content),
          install: (rel: string, source: string) => {
            const root = server.config.root;
            const r = installSyncedFile({ root, historyDir: path.join(root, '.pc-work', 'card-history'), rel, source });
            if (r.ok && r.abs && r.status !== 'unchanged') {
              afterWrite(r.abs, r.written);
              if (!rel.startsWith('src/cards/user/')) noteEdited(rel);
              // User cards that did not originally exist locally: recorded under this shared project (included
              // when saving .proc)
              if (r.status === 'written' && r.userCardId) {
                const m = readScopes();
                if (!m[r.userCardId]) {
                  m[r.userCardId] = { scope: 'project', createdAt: new Date().toISOString(), ...(syncProjectId ? { projectId: syncProjectId } : {}) };
                  writeScopes(m);
                }
              }
            }
            return { ok: r.ok, error: r.error };
          },
        },
        notify: (e: object) => {
          try { server.ws.send({ type: 'custom', event: 'pc:card-sync', data: { type: 'notice', notice: e } }); } catch { /* If there is no page, skip it; still visible in the diagnostics endpoint */ }
        },
        // Connections for account cloud projects have a lifespan and must switch sessions upon ticket
        // expiration (`server/account-card-link.mjs`); other spaces are the same as default endpoints
        connect: cardSyncConnect(syncLog),
        log: syncLog,
      }) : null;
      const localDocUrl = () => {
        const port = (server.httpServer?.address() as any)?.port;
        return port ? `ws://127.0.0.1:${port}/docservice` : null;
      };
      const bindLocal = () => {
        const url = localDocUrl();
        if (!cardSync || !url) return;
        syncProjectId = null;
        cardSync.bind({ local: true, url, protocols: () => ['promptcut.v1'] });
      };
      if (cardSync) {
        if (server.httpServer?.listening) bindLocal();
        else server.httpServer?.once('listening', bindLocal);
        server.httpServer?.once('close', () => cardSync.close());
      }
      /** A card file was saved locally: bookkeeping, upload */
      const savedCardFile = (rel: string) => {
        if (!rel.startsWith('src/cards/user/')) noteEdited(rel);
        cardSync?.saved(rel);
      };

      /*
       * The three endpoints bind, unbind, and submit ticket are only for the editor page; code in the
       * stage window (user cards, potentially written by other members) is not allowed to touch them:
       * they determine where the editor process connects using the member's own connection ticket. The
       * stage port is same-origin to the stage window, so `originOk` cannot block it; thus it is blocked
       * separately by checking "whether it came through the stage port".
       */
      const fromStage = (req: any, res: any): boolean => {
        if (!viaStagePort(req)) return false;
        sendJson(res, 403, { ok: false, error: tr("Stage windows cannot call this endpoint") });
        return true;
      };
      server.middlewares.use('/api/cards/sync/bind', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        if (fromStage(req, res)) return;
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            if (!cardSync) return sendJson(res, 200, { ok: true, enabled: false });
            const input = JSON.parse(body || '{}');
            const mode = input?.mode === 'ticket' ? 'ticket' : input?.mode === 'account' ? 'account' : 'local';
            if (mode === 'local') {
              bindLocal();
              return sendJson(res, 200, { ok: true, enabled: true, ...cardSync.status(), notices: undefined });
            }
            const projectId = typeof input.projectId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.projectId) ? input.projectId : null;
            if (!projectId) return sendJson(res, 400, { ok: false, error: 'projectId is invalid' });
            if (typeof input.url !== 'string' || !/^wss?:\/\//.test(input.url)) return sendJson(res, 400, { ok: false, error: 'When mode is ticket, provide the document service\'s ws(s):// address' });
            // Account project: can only connect to the account cloud document service (the ticket is a
            // credential for the member's own permissions and cannot be sent to an arbitrary address specified
            // by the bind request)
            if (mode === 'account' && !accountDocUrlAllowed(input.url)) return sendJson(res, 400, { ok: false, error: tr("Account projects can only connect to the account's cloud document service") });
            let first: string | null = typeof input.ticket === 'string' && input.ticket.length > 0 && input.ticket.length <= 2048 ? input.ticket : null;
            syncProjectId = projectId;
            cardSync.bind({
              projectId,
              url: input.url,
              local: false,
              keys: keysForCards(input.cardIds),
              protocols: mode === 'account'
                ? accountCardProtocols(() => requestPageTicket(projectId))
                : async () => {
                  const t = first ?? (await requestPageTicket(projectId)).ticket;
                  first = null;
                  return ['promptcut.v1', `promptcut.ticket.${t}`];
                },
            });
            sendJson(res, 200, { ok: true, enabled: true, ...cardSync.status(), notices: undefined });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
      server.middlewares.use('/api/cards/sync/unbind', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        if (fromStage(req, res)) return;
        req.resume();
        req.on('end', () => {
          bindLocal();
          sendJson(res, 200, { ok: true });
        });
      });
      server.middlewares.use('/api/cards/sync/ticket', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        if (fromStage(req, res)) return;
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
        req.on('end', () => {
          let data: any = {};
          try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'Request body is not JSON' }); }
          const w = typeof data?.reqId === 'string' ? ticketWaiters.get(data.reqId) : undefined;
          if (!w) return sendJson(res, 404, { ok: false, error: 'Nothing is waiting for this ticket' });
          ticketWaiters.delete(data.reqId);
          clearTimeout(w.timer);
          if (typeof data.ticket === 'string' && data.ticket.length > 0 && data.ticket.length <= 2048) w.resolve({ ticket: data.ticket, ...(Number.isSafeInteger(data.expiresAt) ? { expiresAt: data.expiresAt } : {}) });
          else w.reject(new Error(typeof data.error === 'string' ? `Page failed to sign a ticket: ${data.error}` : 'Ticket returned by the page is invalid'));
          sendJson(res, 200, { ok: true });
        });
      });
      // Clicked "Merge" on a card in "conflict merge": reinstall locally following the source code on my
      // side and upload (`card-sync.mjs` takeMine; page side `src/editor/sync/cardSync.ts`)
      server.middlewares.use('/api/cards/sync/take-mine', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        if (fromStage(req, res)) return;
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          let data: any = {};
          try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'Request body is not JSON' }); }
          if (!cardSync) return sendJson(res, 409, { ok: false, error: tr("Card source sync is not enabled") });
          void cardSync.takeMine(String(data?.key ?? ''), data?.source).then((r: { ok: boolean; error?: string }) => sendJson(res, r.ok ? 200 : 400, r));
        });
      });
      server.middlewares.use('/api/cards/sync/status', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, cardSync ? { ok: true, enabled: true, ...cardSync.status() } : { ok: true, enabled: false });
      });

      // GET reads the full table / POST { cardId, scope } modifies a card's tier (used by the two
      // checkboxes in the chat panel)
      server.middlewares.use('/api/cards/scopes', (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, scopes: readScopes() });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
          try {
            const { cardId, scope, projectId } = JSON.parse(body || '{}');
            if (typeof cardId !== 'string' || (scope !== 'project' && scope !== 'custom')) {
              return sendJson(res, 400, { ok: false, error: 'cardId is required, and scope must be project or custom' });
            }
            const m = readScopes();
            m[cardId] = { ...m[cardId], scope, ...(projectId ? { projectId } : {}) };
            writeScopes(m);
            sendJson(res, 200, { ok: true, scopes: m });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      // Card creation rules are fetched on demand via a dedicated endpoint rather than stuffed into the
      // system prompt of every chat:
      // they are only needed when "creating a new card"; keeping them resident would waste thousands of
      // tokens.
      /**
       * Asset files: /catalog/lottie/<name>.json, /catalog/particles/<name>.json.
       * The src of Lottie cards and config of particle cards directly use this URL; both editor preview
       * and the export page fetch from here (same-origin fetch; pauseIfNetworkFetchesPending in the
       * export script will wait for the fetch to complete before advancing virtual time).
       * Only names registered in index.json are allowed; URLs are not used to read other files.
       */
      server.middlewares.use('/catalog', (req, res, next) => {
        const m = /^\/(lottie|particles)\/([A-Za-z0-9-]+)\.json$/.exec((req.url || '').split('?')[0]);
        if (!m) return next();
        const [, kind, name] = m;
        try {
          const index = JSON.parse(fs.readFileSync(new URL(`./catalog/${kind}/index.json`, import.meta.url), 'utf8'));
          if (!index.items.some((it: { name: string }) => it.name === name)) return sendJson(res, 404, { ok: false, error: `The ${kind} asset catalog has no "${name}"` });
          const body = fs.readFileSync(new URL(`./catalog/${kind}/${name}.json`, import.meta.url));
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(body);
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) });
        }
      });

      server.middlewares.use('/api/cards/guide', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const guide = fs.readFileSync(new URL('./card-authoring-guide.md', import.meta.url), 'utf-8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          // Attach the porting catalog: the model only sees existing cards in the library and does not know
          // which MagicUI components have not been ported yet or what they do.
          // The catalog is produced by running the review gate (server/catalog/magicui/index.json); tiers are
          // not hand-written.
          res.end(guide + '\n' + renderCatalog());
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) });
        }
      });

      /**
       * Reads back the source code of a card. Built-in cards can also be read since 0.4 (see the header
       * "Agent can read and modify original source code of all cards" for rationale).
       *
       * Without this endpoint, modifying cards was only possible via create_card + overwrite: that was
       * a full rewrite; the model did not have the current version on hand and had to reconstruct from
       * memory, causing unmentioned details to drift each round. Only by reading back first can we
       * speak of "modifying".
       *
       * Returns definition file source code, plus files: card / part files used along the way by this
       * card, each with sharedBy (shared by how many cards).
       * Passing file reads that specific one: source locations marked by inspect_card_dom often land in
       * shared parts or vendor files.
       * If an id is neither a user card nor a registered card, it still falls back to the Magic UI
       * porting catalog (used for "port third-party components").
       */
      server.middlewares.use('/api/cards/source', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const q = new URL(req.url || '', 'http://x').searchParams;
        const id = q.get('id') || '';
        const wantFile = q.get('file') || '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `Card id "${id}" is invalid.` });
        const root = server.config.root;
        const defFile = findCardFile(root, id);
        if (!defFile) {
          // Not a card → check if it is a MagicUI component in the porting catalog. What is returned is the
          // **upstream original source**,
          // not yet wrapped into CardDef; after receiving it, the model wraps it according to "port
          // third-party components" in the guide and calls create_card with the same id.
          const cat = readCatalogSource(id);
          if (cat) {
            return sendJson(res, 200, {
              ok: true, id, file: cat.entry.file, source: cat.source, lines: cat.source.split('\n').length,
              catalog: true, tier: cat.entry.tier, blockers: cat.entry.blockers, props: cat.entry.props,
              hint: `This is raw source from the Magic UI catalog (MIT), not a card yet. Wrap it as a CardDef, write "Source: https://magicui.design/docs/components/${cat.name}" and MIT in the file header, then create the card with create_card using id "${id}". ${cat.entry.blockers.length ? 'Handle this first:' + cat.entry.blockers.join(', ') : ''}`,
            });
          }
          return sendJson(res, 404, {
            ok: false,
            error: `Cannot find the source of card "${id}". Use list_cards to confirm the id; for components in the Magic UI catalog that have not been ported yet, read them as mu-<name> (see the catalog at the end of card_authoring_guide). Media wrapper cards (lottie-* / particles-*) are generated per asset catalog and have no separate source file; to change how they draw, read the lottie / particles cards.`,
          });
        }
        const closure = importClosure(root, defFile);
        const target = wantFile || defFile;
        if (!closure.includes(target)) {
          return sendJson(res, 400, { ok: false, error: `"${target}" is not in the source files of card ${id}. Readable files: ${closure.join(', ')}` });
        }
        const counts = sharedByCounts(root);
        // Effective content: modified cards in the installed version read the copy from the overlay layer
        // (see card-overrides.mjs)
        const source = readEffective(root, path.join(root, target));
        const builtin = !defFile.startsWith('src/cards/user/');
        sendJson(res, 200, {
          ok: true, id, file: target, source, lines: source.split('\n').length, builtin,
          files: closure.map((f) => ({ file: f, sharedBy: counts.get(f) || 1 })),
          ...(builtin ? { hint: 'This is a built-in card. Change it with edit_card (you can pass file to change the parts / vendor files it uses); files with sharedBy > 1 are shared by several cards, and changing them changes all of them. After editing, check the result with see_frames.' } : {}),
        });
      });

      /**
       * In-place replacement card editing: provide a find segment and a replace segment, modifying only
       * that single location. Works for both user cards and built-in cards; passing file allows modifying
       * part files.
       *
       * Its significance compared to create_card + overwrite is not saving words, but that **unmentioned
       * parts are guaranteed to remain unchanged**.
       * Therefore find must match uniquely: 0 matches indicates the caller holds an outdated version;
       * multiple matches indicates it is unclear which occurrence was intended to be modified: both
       * should error out to ask it to read back source code first, rather than guessing on its behalf.
       *
       * Only the source closure of this card can be modified (definition file + card / part files it
       * uses), and only source / style files.
       * Definition files for user cards go through the same validation as card creation; built-in /
       * shared files go through checkSourceEdit (syntax + no newly added code that does not follow frames
       * + CardDef exports and id must not be touched), backed up to out/card-edits/ before modification.
       */
      server.middlewares.use('/api/cards/edit', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_EDIT_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const input = JSON.parse(body || '{}');
            const { id, file, find, replace, replaceAll } = input;
            if (typeof id !== 'string' || typeof find !== 'string' || typeof replace !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'id, find and replace must all be strings' });
            }
            if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `Card id "${id}" is invalid.` });

            const root = server.config.root;
            const defFile = findCardFile(root, id);
            if (!defFile) {
              return sendJson(res, 404, { ok: false, error: `Cannot find the source of card "${id}". Confirm the id and the editable files with get_card_source first.` });
            }
            const closure = importClosure(root, defFile);
            const target = typeof file === 'string' && file ? file : defFile;
            if (!closure.includes(target) || !isEditablePath(target)) {
              return sendJson(res, 400, { ok: false, error: `"${target}" is not a source file of card ${id} and cannot be changed. Editable files: ${closure.join(', ')}` });
            }

            const abs = path.join(root, target);
            // Modifying the effective copy: in the installed version, the previous modification is in the
            // overlay layer; subsequent modifications must proceed from there, not from the base file
            const before = readEffective(root, abs);
            const patch = applyCardPatch(before, find, replace, replaceAll === true);
            if (!patch.ok) return sendJson(res, 400, { ok: false, error: patch.error });
            const { after, replaced } = patch;

            const isUserDef = target === defFile && defFile.startsWith('src/cards/user/');
            // User card definition files use the same validation as create: in-place replacement can likewise
            // modify files until they fail to compile
            const check = isUserDef ? checkCardSource(id, after, [], { mode: 'author', before }) : checkSourceEdit(target, before, after);
            if (!check.ok) {
              return sendJson(res, 400, { ok: false, error: check.errors.join('\n'), errors: check.errors });
            }

            // B2 (cloud-task.md): user cards are also backed up; recovered from out/card-edits/ when overwritten
            // by sync or corrupted
            const backup = backupBeforeEdit(root, target, before);
            /*
             * Where to write is decided by card-overrides: the installed version writes to the overlay layer
             * (modifications are not lost when patches overwrite runtime/app), while development writes
             * directly to repository files. When writing to the overlay layer, the original file watched by
             * Vite does not change, so it will not hot update on its own:
             * manually invalidate that module, and then run through the same hot update as if "the original
             * file changed" (the load hook will provide the content from the overlay layer).
             */
            const written = writeCardFile(root, abs, after);
            afterWrite(abs, written);
            savedCardFile(target);
            const sharedBy = sharedByCounts(root).get(target) || 1;
            sendJson(res, 200, {
              ok: true,
              id,
              file: target,
              replaced,
              source: after,
              builtin: !defFile.startsWith('src/cards/user/'),
              sharedBy,
              ...(backup ? { backup } : {}),
              hint: sharedBy > 1
                ? `Rewritten and hot-reloaded. This file is shared by ${sharedBy} cards, and all of them will change with it. After editing, check the result with see_frames.`
                : 'Rewritten and hot-reloaded. After editing, check the result with see_frames, then decide whether to keep tuning.',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * Read-only DOM tree (server side of inspect_card_dom).
       *
       * Uses the same render pipeline as export (server/bakery/) to render this individual clip to the
       * specified frame, samples the tree with collapsed wrapper layers in the page, and uses source maps
       * to map the rendered position of each node back to source line numbers.
       * **Borrows the single bakery from agent lane** (`FramePipeline.runAgentTask`, T1a review #12):
       * queues up together with the `see_frames` agent batch, `/api/cards/layout`, and D3 entity
       * rectangles; only one task drives that page at any given moment;
       * idle shutdown is also centrally managed by the pipeline (cloud-task.md I1: one Chrome, close
       * after 10 minutes idle).
       * Previously, a bakery was kept here separately with its own `domChain`, which opened separate
       * Chrome instances with in-flight `see_frames` without queueing together.
       * Trees for the same moment are cached: when the model "looks down" at a ref, it does not need to
       * rerender. When source code changes, the cache is completely cleared.
       */
      const domTrees = new Map<string, { nodes: DomNode[]; header: string }>();
      const mapCache = new Map<string, number[][][] | null>();
      server.watcher?.on('change', () => { mapCache.clear(); domTrees.clear(); });
      const mapFor = async (urlPath: string) => {
        if (mapCache.has(urlPath)) return mapCache.get(urlPath) ?? null;
        let decoded: number[][][] | null = null;
        try {
          const env = (server as any).environments?.client;
          const r = env?.transformRequest ? await env.transformRequest(urlPath) : await server.transformRequest(urlPath);
          const m = r?.map as any;
          if (m && typeof m.mappings === 'string') decoded = decodeMappings(m.mappings);
        } catch { /* Fall back to the transformed line number if unavailable, and mark it */ }
        mapCache.set(urlPath, decoded);
        return decoded;
      };
      /*
       * Project JSON is kept in memory under a short id for the page to pull, using the same approach as
       * /@export/<id>/project.json in vite-plugin-vision.
       * Not stuffed into the URL: when card props contain long text or data: images, the request line
       * exceeds Node's 16 KB header limit, and the page returns 431 immediately.
       */
      const domProjects = new Map<string, string>();
      server.middlewares.use('/@cards-dom', (req, res, next) => {
        const id = (req.url || '').split('/')[1] || '';
        const body = domProjects.get(id);
        if (!body) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
      /*
       * FramePipeline of this process (the same instance as `/api/frames/*` and `/api/cards/layout` in
       * vite-plugin-frames).
       * Lazy import: unit tests transpile this file alone into a temporary directory before importing;
       * static import of sibling .ts files would fail to resolve.
       */
      const agentPipeline = async () => {
        const { frameService } = await import('./vite-plugin-frames');
        const port = (server.httpServer?.address() as any)?.port;
        return frameService(server.config.root, `http://127.0.0.1:${port}`);
      };
      /**
       * `lease`: bakery borrowing function passed in by `runAgentTask`; bakery return and idle shutdown
       * are both managed by pipeline.
       */
      const renderDomTree = async (origin: string, isoProject: any, frame: number, lease: (project: any, opts?: { asIs?: boolean }) => Promise<any>): Promise<DomNode[]> => {
        const pid = crypto.randomBytes(8).toString('hex');
        domProjects.clear(); // Only renders one at a time (queued in agent lane); the previous one is no longer needed
        domProjects.set(pid, JSON.stringify(isoProject));
        const url = `${origin}/?export=1&timeline=/@cards-dom/${pid}/project.json`;
        const mod = await import(pathToFileURL(path.join(server.config.root, 'server', 'bakery', 'index.mjs')).href);
        // `asIs`: resets to the DOM page immediately without needing to reset by project first. `project`
        // must be the object here (`acquire` reads `project.width` during cold start) and cannot be
        // retrieved as a string from `domProjects` (cloud-task.md I1).
        const bakery = await lease(isoProject, { asIs: true });
        await bakery.reset(null, url);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dom-'));
        try {
          await mod.bakeFrames(bakery, { out: tmp, targetFrames: [frame], format: 'jpeg', quality: 40 });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
        const nodes: DomNode[] = await bakery.page.evaluate(EXTRACT_DOM);
        for (const n of nodes) {
          if (!n.site) continue;
          const dec = await mapFor(n.site.path);
          const o = dec ? originalPosition(dec, n.site.line, n.site.col) : null;
          n.where = `${n.site.path.slice(1)}:${o ? o.line : `${n.site.line}(line number after transform)`}`;
        }
        return nodes;
      };

      server.middlewares.use('/api/cards/dom', (req, res) => {
        // The editor side does not render: forwards as-is to the prerender process (it has its own Chrome
        // and does not take up processes or connections on the editor side)
        if (!isPrerender) return proxyToPrerender(req, res);
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
          // Only renders one at a time: borrows bakery from agent lane, queueing together with
          // see_frames / layout (#12)
          void agentPipeline().then(pipeline => pipeline.runAgentTask(async (lease: any) => {
            try {
              const { project, clipId, t, ref, depth } = JSON.parse(body || '{}');
              if (!project || typeof clipId !== 'string') return sendJson(res, 400, { ok: false, error: 'project and clipId are required' });
              const iso = isolateClipForDom(project, clipId);
              if (!iso) return sendJson(res, 404, { ok: false, error: `Clip ${clipId} not found in the project` });
              const fps = Number(project.fps) || 30;
              const { clip } = iso;
              const tt = typeof t === 'number' && Number.isFinite(t)
                ? Math.min(Math.max(t, clip.start), clip.end - 1 / fps)
                : (clip.start + clip.end) / 2;
              const frame = Math.max(0, Math.round(tt * fps));
              /*
               * Shift to a fixed starting line before rendering: export advances sequentially from frame 0, so
               * a clip placed at second 50 would otherwise have to advance over a thousand frames first. The card
               * visual is independent of its absolute position on the timeline (commit 4edf40e verified 34/34
               * cards individually), so shift it to 0.5 seconds:
               * not shifting to 0 because frame 0 has warmup, and cards touching frame 0 would undergo an extra
               * segment (tested in the same commit).
               * In-clip position is converted using integer frame numbers rather than subtracting seconds
               * (floating-point subtraction can calculate two different keys for the same frame).
               */
              const LEAD_IN = 15; // 0.5s @30fps; given in frame counts so it remains an integer frame count when changing fps
              const clipStartFrame = Math.round(clip.start * fps);
              const inClip = frame - clipStartFrame;
              const shiftedStart = LEAD_IN / fps;
              const shifted = { ...clip, start: shiftedStart, end: shiftedStart + (clip.end - clip.start) };
              const renderProject = {
                ...iso.project,
                duration: shifted.end + 1,
                tracks: iso.project.tracks.map((tr: any) => ({ ...tr, clips: [shifted] })),
              };
              const renderFrame = LEAD_IN + inClip;
              const key = crypto.createHash('sha1').update(JSON.stringify(renderProject)).digest('hex') + '@' + renderFrame;
              let entry = domTrees.get(key);
              const cached = !!entry;
              if (!entry) {
                const nodes = await renderDomTree(`http://${req.headers.host}`, renderProject, renderFrame, lease);
                entry = { nodes, header: `Clip ${clipId} (${clip.cardId ?? 'media'}), frame ${frame} (t=${(frame / fps).toFixed(3)}s, frame ${inClip} within the clip), ${nodes.length} nodes after collapsing wrapper layers.` };
                domTrees.set(key, entry);
                if (domTrees.size > 20) domTrees.delete(domTrees.keys().next().value as string);
              }
              const refNum = typeof ref === 'string' ? Number(ref.replace(/^ref_/, '')) : ref;
              const from = Number.isInteger(refNum) && entry.nodes[refNum] ? refNum : 0;
              const d = Math.max(1, Math.min(8, Number(depth) || 3));
              const text = entry.nodes.length
                ? formatDomTree(entry.nodes, from, d)
                : '(Nothing on the stage: at this moment the card has not entered yet or has already exited)';
              sendJson(res, 200, {
                ok: true, clipId, frame, t: frame / fps, nodes: entry.nodes.length, cached,
                text: `${entry.header}${from ? `from ref_${from} ` : ''}down ${d} levels:\n${text}`,
                hint: 'This tree is read-only: the HTML on the stage is rendered from source. To change a node, read the file it points to with get_card_source, then edit that line with edit_card (with file).',
              });
            } catch (e: any) {
              sendJson(res, 500, { ok: false, error: e?.message || String(e) });
            }
          })).catch((e: any) => {
            // Return truthfully if unable to enter the queue (e.g. this process has no Agent lane)
            sendJson(res, Number(e?.status) || 500, { ok: false, code: e?.code, retryable: e?.retryable, error: e?.message || String(e) });
          });
        });
      });

      /**
       * `/api/cards/audio`: generates a card audio snippet on behalf of Cloud Agent (the cloud path of
       * `render_card_audio`; contract cloud-agent-contract.md Section 9.4c).
       *
       * The card's `audio()` is evaluated inside the **render page** (`src/audio/cardAudioHost.ts`, the
       * same evaluation and recording as the desktop app), not in Node, and certainly not in the Agent
       * service process. Like `/api/cards/dom`, it borrows the single bakery from agent lane and queues
       * in the same line; in the host's worker processes, this endpoint only accepts requests forwarded
       * by the manager process (`hosted-render/vite-gate.mjs`: passphrase for the visual inspection
       * endpoints), returning 403 for browser requests as usual.
       * Returns `{ ok, clipId, expectedClip, reusable? | { name, bytes, rendition, wav: <base64> } }`;
       * WAV chunks are retrieved back from the page.
       */
      const CARD_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
      server.middlewares.use('/api/cards/audio', (req, res) => {
        if (!isPrerender) return proxyToPrerender(req, res);
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
          void agentPipeline().then(pipeline => pipeline.runAgentTask(async (lease: any) => {
            try {
              const { project, clipId, force } = JSON.parse(body || '{}');
              if (!project || typeof clipId !== 'string') return sendJson(res, 400, { ok: false, error: 'project and clipId are required' });
              const pid = crypto.randomBytes(8).toString('hex');
              domProjects.clear();
              domProjects.set(pid, JSON.stringify(project));
              const bakery = await lease(project, { asIs: true });
              await bakery.reset(null, `http://${req.headers.host}/?export=1&timeline=/@cards-dom/${pid}/project.json`);
              // The two snippets running in the page are written as strings: they bypass the transpiler, and
              // dynamic import paths are not treated as dependencies of this file by the bundler
              const arg = JSON.stringify({ url: `/@cards-dom/${pid}/project.json`, clipId, force: force === true, maxBytes: CARD_AUDIO_MAX_BYTES });
              const meta: any = await bakery.page.evaluate(`(async () => { const a = ${arg}; try {
                const mod = await import('/src/audio/cardAudioHost.ts');
                const p = await (await fetch(a.url)).json();
                return await mod.renderClipCardAudio(p, a.clipId, { force: a.force, maxBytes: a.maxBytes });
              } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 400) }; } })()`);
              if (!meta || meta.ok !== true) return sendJson(res, 200, { ok: false, code: 'CARD_AUDIO_FAILED', error: meta?.error || tr("Card audio was not generated") });
              if (meta.reusable) return sendJson(res, 200, meta);
              const total = Number(meta.bytes);
              if (!Number.isSafeInteger(total) || total < 45 || total > CARD_AUDIO_MAX_BYTES) return sendJson(res, 200, { ok: false, code: 'CARD_AUDIO_FAILED', error: tr("The card audio size is wrong") });
              const CHUNK = 3 * 1024 * 1024;
              const parts: string[] = [];
              for (let from = 0; from < total; from += CHUNK) {
                parts.push(await bakery.page.evaluate(`import('/src/audio/cardAudioHost.ts').then((m) => m.takeCardAudioChunk(${from}, ${CHUNK}))`));
              }
              // 3 MiB per chunk is a multiple of 3: base64 of each chunk has no padding and can be concatenated
              // directly
              sendJson(res, 200, { ...meta, wav: parts.join('') });
            } catch (e: any) {
              sendJson(res, 500, { ok: false, error: e?.message || String(e) });
            } finally {
              domProjects.clear();
            }
          })).catch((e: any) => {
            sendJson(res, Number(e?.status) || 500, { ok: false, code: e?.code, retryable: e?.retryable, error: e?.message || String(e) });
          });
        });
      });

      /**
       * Installs back custom cards bundled in .proc when opening a project. Rules are in
       * installBundledCards;
       * only three things are handled here: receiving requests, manually triggering hot updates when
       * writing to the overlay layer, and applying ownership stamps to cards that did not originally
       * exist locally.
       */
      server.middlewares.use('/api/cards/install', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * (MAX_BUNDLED_CARDS + 4)) req.destroy(); });
        req.on('end', () => {
          try {
            const { cards, projectId, existingIds } = JSON.parse(body || '{}');
            const root = server.config.root;
            const results = installBundledCards({
              root,
              historyDir: path.join(root, '.pc-work', 'card-history'),
              cards,
              existingIds: Array.isArray(existingIds) ? existingIds.filter((x: unknown) => typeof x === 'string') : [],
            });
            for (const r of results) {
              if (!r.abs) continue;
              // When writing to the overlay layer, the base file watched by Vite does not change; like edit_card,
              // manually invalidate and then run hot update as if the base file changed
              afterWrite(r.abs, r.written);
              // Cards installed / updated by opening .proc also count as a save: enters the content store of the
              // current space
              if (r.status === 'written' || r.status === 'updated') savedCardFile(`src/cards/user/${r.id}.tsx`);
            }
            // Cards that did not originally exist locally: recorded under this project. Existing entries are
            // untouched: sharing settings configured by the user should not be wiped out by an open operation
            const m = readScopes();
            let stamped = false;
            for (const r of results) {
              if (r.status !== 'written' || m[r.id]) continue;
              m[r.id] = { scope: 'project', createdAt: new Date().toISOString(), ...(typeof projectId === 'string' && projectId ? { projectId } : {}) };
              stamped = true;
            }
            if (stamped) writeScopes(m);
            sendJson(res, 200, { ok: true, results: results.map(({ abs: _a, written: _w, ...r }) => r) });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      server.middlewares.use('/api/cards/create', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const input = JSON.parse(body || '{}');
            const { id, source, existingIds, overwrite, projectId } = input;
            const created = createUserCard({ root: server.config.root, id, source, existingIds, overwrite });
            if (!created.ok) return sendJson(res, created.code, created.body);
            const { target, written, already, translated, finalSource, suggestedControls } = created;
            afterWrite(target, written);
            savedCardFile(`src/cards/user/${id}.tsx`);

            /*
             * Apply ownership stamp. Default project = only appears in the project where it was created: this
             * is the screening safeguard:
             * custom cards are mostly made for a specific client / specific video; default sharing is the
             * counter-intuitive choice.
             * To reuse across projects, simply change it to "Custom media" in the chat panel.
             * Do not touch existing tiers during overwrite, lest sharing configured by the user be wiped out
             * by a card modification.
             */
            {
              const m = readScopes();
              if (!m[id]) {
                m[id] = { scope: "project", createdAt: new Date().toISOString(), ...(typeof projectId === "string" && projectId ? { projectId } : {}) };
                writeScopes(m);
              }
            }
            sendJson(res, 200, {
              ok: true,
              id,
              file: `src/cards/user/${id}.tsx`,
              overwritten: already,
              rewrites: translated.rewrites,
              suggestedControls,
              // Return the source code as-is to the caller after saving to disk. Without this step, the next time
              // the model wants to edit this card it will not have the current version on hand, and can only
              // rewrite the whole file from memory: in testing, that caused unmentioned details to drift slightly
              // with each rewrite (font size of the same card drifted 42→56→42→32).
              source: finalSource,
              lines: finalSource.split('\n').length,
              hint: 'Written and hot-reloaded. To change it again, use edit_card for a partial replacement; do not rewrite the whole file with create_card.',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  }];
}
