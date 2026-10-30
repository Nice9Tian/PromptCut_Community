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
// 同步文件源码闸门:检查点留在本文件(cardOverridesLoader),缺省全部直通放行;有云端构建扩展表时注入托管渲染的严审规则
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

/* ────────────────────────────────────────────────────────────────────
 * 0.4 起:Agent 能读、能改**所有**卡片的原始源码(内置卡也算),但改不了 HTML。
 *
 * 为什么是「改源码、不改 HTML」:舞台上的 DOM 是 React 按源码和参数渲染出来的派生物,
 * 下一次渲染就会把直接改过的 DOM 盖掉,导出时每一帧也都从源码重渲 —— 改 DOM 等于制造
 * 第二个真相。所以 DOM 只给看(inspect_card_dom,每个节点标出是源码哪一行渲染的),
 * 改动一律落回源码(edit_card)。见 docs/archive/topics/render-rebuild-plan.md「目标架构」。
 *
 * 能改的范围只开到卡片目录和卡片共用的部件库;内核、编辑器、服务端一律不开。
 * 内置文件改之前先备份到 out/card-edits/,改坏了能找回来。
 * ──────────────────────────────────────────────────────────────────── */

/** 按卡片 id 找定义文件时扫的目录(不递归:vendor/ 这类子目录是被卡片引用的实现,不是卡) */
const CARD_DEF_DIRS = ['src/cards/native', 'src/cards/magicui'];
/** Agent 能改的源码范围 */
const EDITABLE_ROOTS = ['src/cards/', 'src/parts/'];
const EDITABLE_EXT = /\.(tsx|ts|css)$/;
const MAX_EDIT_BYTES = 256 * 1024;

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** 这个相对路径 Agent 能不能改:在卡片 / 部件目录下、是源码或样式文件、不是测试 */
export function isEditablePath(rel: string): boolean {
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return EDITABLE_ROOTS.some((r) => rel.startsWith(r)) && EDITABLE_EXT.test(rel);
}

/** 卡片 id → 定义它的源码文件(相对仓库根)。用户卡优先,其次内置卡;都没有返回 null */
export function findCardFile(root: string, id: string): string | null {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) return null;
  // 有改动层时,本机原来没有的用户卡只在改动层里(见 card-overrides.mjs 文件头)
  if (effectiveIsFile(root, path.join(root, 'src', 'cards', 'user', `${id}.tsx`))) return `src/cards/user/${id}.tsx`;
  const re = new RegExp(`\\bid:\\s*["'\`]${id}["'\`]`);
  for (const dir of CARD_DEF_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.tsx')) continue;
      // 读生效内容(改动层优先):id 和导出不许改,但判断要和实际加载的那一份一致
      const src = readEffective(root, path.join(abs, f));
      if (re.test(src) && /\bCardDef\b/.test(src)) return `${dir}/${f}`;
    }
  }
  return null;
}

/** 一个文件直接用到的本地文件(相对导入,且落在可改范围内的);样式文件也算 —— 画面一半在 CSS 里 */
export function localImports(root: string, rel: string): string[] {
  // 改动层里的版本可能多 import 了别的文件:闭包、共用计数、代码哈希都得按实际加载的那一份算。
  // 「跟哪些文件」的规则与在线页面共用(`src/render/cardCodeIdentity.mjs`),这里只注入「改动层优先」的读法。
  return localImportsOf(rel, {
    read: (r: string) => readEffective(root, path.join(root, r)),
    isFile: (r: string) => effectiveIsFile(root, path.join(root, r)),
  });
}

/** 一张卡的全部本地源码:定义文件 + 它一路用到的卡片 / 部件文件(第一个是定义文件) */
export function importClosure(root: string, rel: string, limit = 60): string[] {
  const seen = [rel];
  for (let i = 0; i < seen.length && seen.length < limit; i++) {
    for (const r of localImports(root, seen[i])) if (!seen.includes(r)) seen.push(r);
  }
  return seen;
}

/** 全部卡片定义文件(用户卡 + 内置卡),给「这个文件被几张卡共用」计数用 */
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

/** 每个文件被几张卡的源码闭包包含。改一个共用文件会同时改掉这么多张卡,要告诉 Agent */
export function sharedByCounts(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of allCardFiles(root)) for (const r of importClosure(root, f)) counts.set(r, (counts.get(r) || 0) + 1);
  return counts;
}

/** 源码里新增的 `compositing: 'independent'` —— 这个值的唯一权威是审阅表(A0.2) */
const COMPOSITING_INDEPENDENT = /compositing\s*:\s*['"`]independent['"`]/g;

/**
 * 这个文件里有没有 CardDef **对象**的具名导出。
 *
 * `export const nativeCards: CardDef<any>[] = [...]` 这 7 个聚合数组文件也长得像
 * `export const xxx: CardDef`,但它们没有对象可以写字段 —— frameMode 必填不能套到它们头上,
 * 否则一编辑就被无条件拒绝。所以按「`:` 和 `=` 之间是不是 `[]` 结尾」把数组声明排除掉。
 */
const CARDDEF_DECL = /export\s+const\s+\w+\s*:\s*CardDef\b([^=]*)=/g;
export function hasCardDefObject(source: string): boolean {
  for (const m of source.matchAll(CARDDEF_DECL)) {
    if (!/\[\s*\]\s*$/.test(m[1])) return true;
  }
  return false;
}

/** 改完之后不许**新**出现的写法:导出按帧推时间,这些东西不跟着帧走。已有的不追究(那是原作者的事) */
const RISKY_PATTERNS: [RegExp, string][] = [
  [/\bDate\.now\s*\(/g, 'Date.now():要读时间就用组件收到的 t'],
  [/\bnew\s+Date\s*\(\s*\)/g, 'new Date():要读时间就用组件收到的 t'],
  [/\bsetTimeout\s*\(|\bsetInterval\s*\(/g, 'setTimeout / setInterval 驱动动画:用 motion 的 animate,或者读 t'],
  [/\bIntersectionObserver\b/g, 'IntersectionObserver:卡片挂载即播放,没有「滚进视口」'],
  [/\bsetAnimationLoop\b/g, 'setAnimationLoop:三维画面写成 t 的纯函数,t 变了再显式 render 一次(照 scene-3d.tsx)'],
  [COMPOSITING_INDEPENDENT, "compositing: 'independent':「只画自己、能单独预渲染上云」是审阅结论,只能写进审阅表 src/cards/capabilities.json(A0.2),源码里声明不作数"],
];

/** 内置 / 共用文件的一次编辑能不能落盘 */
export function checkSourceEdit(rel: string, before: string, after: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (Buffer.byteLength(after, 'utf8') > MAX_EDIT_BYTES) errors.push(`改完超过 ${MAX_EDIT_BYTES / 1024}KB,太大了。`);
  if (/\.(tsx|ts)$/.test(rel)) {
    const out = ts.transpileModule(after, {
      reportDiagnostics: true,
      fileName: rel,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    });
    for (const d of out.diagnostics || []) {
      const pos = d.start !== undefined ? after.slice(0, d.start).split('\n').length : undefined;
      errors.push(`语法错误${pos ? `(第 ${pos} 行)` : ''}:${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
  /*
   * 声明成 remotion 式(`frameMode: "direct"`)的卡片文件:按 remotion 式的规矩查(`remotion-style-check.mjs`),每条带行号。
   * 内置卡都不是用框架写的,所以这里是差量口径:只拒绝这次编辑新增的违规,原来就有的不追究。
   * 这类文件上,下面那张表里说时间与定时器的几条由它代替(那几条的文案在劝人用 Motion,对 remotion 式的卡不对)。
   */
  const remotion = /\.(tsx|ts)$/.test(rel) && hasCardDefObject(after)
    ? remotionStyleErrors(after, { before, fileName: rel, legacyAbsolute: false })
    : null;
  if (remotion) errors.push(...remotion.errors);
  for (const [re, why] of RISKY_PATTERNS) {
    if (remotion?.remotionStyle && re !== COMPOSITING_INDEPENDENT) continue;
    const n0 = (before.match(re) || []).length;
    const n1 = (after.match(re) || []).length;
    if (n1 > n0) errors.push(`这次编辑新加了 ${why}。`);
  }
  // 卡片定义文件:CardDef 的具名导出和 id 不能被改掉,不然注册表认不出它、或者换了身份
  if (/export\s+const\s+\w+\s*:\s*CardDef/.test(before)) {
    if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(after)) errors.push('改完没有 `export const xxx: CardDef` 了 —— 注册表靠它认卡。');
    const idOf = (s: string) => (s.match(/\bid:\s*["'`]([^"'`]+)["'`]/) || [])[1];
    if (idOf(before) !== idOf(after)) errors.push(`CardDef 的 id 从 "${idOf(before)}" 变成了 "${idOf(after)}" —— 卡片 id 不能改,时间轴上的片段靠它找卡。`);
    // frameMode 是绝对检查,不是差量:A0.1 已经把 31 个 CardDef 对象文件全写上了,
    // 改完不能把它丢掉 —— 丢了就退回「按 timing 动态推导」,调度会静悄悄换一条路。
    if ((hasCardDefObject(before) || hasCardDefObject(after)) && !/\bframeMode\s*:/.test(after)) {
      errors.push('CardDef 里缺少 frameMode 字段 —— 帧怎么得到(direct / stateful)必须写死,不能靠推导。');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 改卡片文件之前留一份原样,返回备份的相对路径。内置 / 共用文件、用户卡都备(`cloud-task.md` B2:用户卡也备份);
 * 同步覆盖本机那份之前也用它(C6.6 第 5 节,卡级复用 edit_card 的备份机制)。
 */
export function backupBeforeEdit(root: string, rel: string, content: string): string {
  const dir = path.join(root, 'out', 'card-edits');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}__${rel.replace(/\//g, '__')}`);
  fs.writeFileSync(file, content, 'utf8');
  return toRel(root, file);
}

/* ── source map:把 React 记下的「转换后」行号换回源码行号 ──
 * React 19 开发版在每个 fiber 上留了 _debugStack,里面是渲染这个节点的那一行 JSX 的位置 ——
 * 但行号是 Vite 转换后代码的(实测 rank-bars.tsx:59 在原文件里是一个 animate 属性)。
 * 经 source map 换算后 6/6 准确。自己解 VLQ 而不是引第三方包:几十行的事,安装包里不一定带那个包。 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 解 mappings:返回每一行(生成代码)的段 [生成列, 源文件下标, 原行, 原列],全部 0 起 */
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

/** 生成代码的第 line 行第 col 列(都 1 起)→ 原始位置(1 起);找不到返回 null */
export function originalPosition(decoded: number[][][], line: number, col: number): { line: number; col: number } | null {
  const segs = decoded[line - 1];
  if (!segs || !segs.length) return null;
  let hit: number[] | null = null;
  for (const s of segs) { if (s[0] <= col - 1) hit = s; else break; }
  hit = hit || segs[0];
  return { line: hit[2] + 1, col: hit[3] + 1 };
}

/** 只读 DOM 树的一个节点(页面里采出来,服务端补上源码位置) */
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
 * 把节点表排成给模型看的文本:从 fromRef 起、往下 depth 层,超出的标「…还有 N 个后代 [ref_x]」。
 * 同一行源码在兄弟节点里出现多次(.map 生成的列表)就标出来 —— 改那一行会同时改掉它们。
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
      sameSite > 1 ? `(同一行源码生成了 ${sameSite} 个兄弟节点)` : '',
      n.wrap ? `(折叠了 ${n.wrap} 层包装)` : '',
      `${n.rect[2]}×${n.rect[3]}@${n.rect[0]},${n.rect[1]}`,
    ].filter(Boolean);
    if (d >= depth && n.children.length) parts.push(`…还有 ${n.desc} 个后代,传 ref:${n.ref} 往下看`);
    out.push('  '.repeat(d) + parts.join(' '));
    if (d < depth) for (const c of n.children) walk(c, d + 1);
  };
  walk(fromRef, 0);
  if (truncated) out.push(`…输出到 ${maxLines} 行为止,还有 ${truncated} 个节点没列出;挑一个 ref 往下看`);
  return out.join('\n');
}

/**
 * 在导出页里采舞台的 DOM 树(页面里执行)。折叠「只有一个子节点、自己又没字」的包装层 ——
 * 实测卡片内容都在第 6~7 层以下,前几层全是 ExportView / Stage 的外壳,不折叠的话「看三层」什么都看不到。
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
  // _debugStack 第一帧是 jsxDEV 自己,往下找第一个落在 /src/ 里的调用点
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

/** 只留下 clipId 那一段(和 vite-plugin-vision 的 isolateClip 同一个做法,各写一份免得两边互相牵制) */
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
 * 建卡端点。
 *
 * AI 的文件工具被锁在 exports/ai-workspace/ 里(见 harness/tools/textEditor.mjs),
 * 够不到 src/cards/。这个端点是唯一的口子,而且只开到 src/cards/user/ 这一个目录、
 * 只允许 .tsx、一次一个文件 —— 建卡不该顺带获得改整个代码库的能力。
 *
 * 桌面版跑的是真的 vite dev server(见 desktop/src-tauri/src/lib.rs),
 * 所以文件落盘后 HMR 会直接编译加载,不需要重启也不需要重新打包。
 */

const MAX_SOURCE_BYTES = 64 * 1024;
/** kebab-case,且不能以 mu- 开头(那是 Magic UI 的前缀) */
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/**
 * 只认同源请求,和 ai 那几个写端点一致。走 http-guard 的同一份判定:预渲染进程还要放行编辑器那一端的源
 * (/api/cards/dom 在预渲染上跑,编辑器页面的兜底路径会跨源直连过来),两处各写一份迟早对不上。
 */
function originOk(req: { headers: Record<string, any> }): boolean {
  return guardOriginOk(req);
}

/** 审查发现的一条不合规。tier 决定它属于哪一类问题,给调用方(通常是模型)分门别类地看 */
export interface CardFinding {
  /**
   * 2 = 管线还接不住的机制(canvas / 随机 / 逐帧累加),要等导出脚本那边收紧;
   * 3 = 鼠标 / 滚动 / 点击驱动,导出里没有输入,只会停在初态,要改成参数驱动;
   * deps = 引了没装的第三方库;keyframes = 用了没定义的 animate-* 动画;
   * license = 搬来的代码没声明来源和许可证,或许可证不允许分发。
   */
  tier: 2 | 3 | 'deps' | 'keyframes' | 'license';
  rule: string;
  detail: string;
}

export interface CardCheck {
  ok: boolean;
  errors: string[];
  /** 审查门给出的分档发现;没问题时为空数组 */
  findings?: CardFinding[];
}

/* ────────────────────────────────────────────────────────────────────
 * 翻译器:把第三方组件(MagicUI 等)的源码变成能落进 src/cards/user/ 的卡。
 *
 * 分两半。**机械的一半**在这里:去掉 Next.js 的指令、把 @/lib/utils 这类别名
 * 指到本地、按已验证的机制清单审查、从 props 类型推 controls。**语义的一半**
 * (useWhen 怎么写、哪个常量该提成参数、部件怎么切)交给模型在导入时做一次 ——
 * 那部分没法从代码里机械推出来。
 *
 * 审查的分档来自实测:11 张卡(6 张自家 + 5 张 MagicUI)在 openBakery/bakeFrames
 * 管线上做过「新鲜 vs 复用 vs 静态跳过」逐字节比对,Motion 的 WAAPI 与 JS 两条路、
 * CSS 动画、React 状态、rAF、useInView、useSpring 全是 0 差异;canvas 粒子、
 * Math.random、逐帧累加的 rAF 循环则还接不住(截图窗口那段自由跑的虚拟时间会
 * 让它们推进不确定的步数)。鼠标 / 滚动驱动的在导出里没有输入源,是另一类。
 * ──────────────────────────────────────────────────────────────────── */

/** 能 import 的模块:这几个之外的第三方库都没装,写了就是编译失败 */
const ALLOWED_IMPORTS: RegExp[] = [
  /^react$/, /^react\/jsx-runtime$/, /^react-dom$/,
  /^motion\/react$/, /^motion$/,
  /^lottie-web$/, /^@tsparticles\/(engine|slim)$/,   // 已装、已在导出管线上验证过的两个库
  /^three$/, /^three\/.+$/,         // 三维:已装,且在导出管线上验证过逐字节一致(见下面第二档那段)
  /^\.\.?\//,                       // 相对路径(kernel/types、native/hud、magicui/vendor/*)
];

/** Tailwind v4 自带的 animate-* */
const BUILTIN_ANIMATES = new Set(['spin', 'ping', 'pulse', 'bounce', 'none']);
/** 已经搬进 src/cards/magicui/vendor/magicui-animations.css 的 MagicUI 动画 */
const VENDORED_ANIMATES = new Set([
  'accordion-down', 'accordion-up', 'gradient', 'meteor', 'marquee', 'marquee-vertical',
  'spin-around', 'shiny-text', 'shimmer-slide', 'ripple', 'rippling', 'line', 'orbit',
  'background-position-spin', 'shine', 'pulse', 'pulse-ripple', 'rainbow', 'line-shadow',
  'aurora', 'ping', 'blink-cursor',
]);

/** 能随安装包分发的许可证 */
const LICENSE_OK = /\b(MIT|Apache[- ]2\.0|BSD[- ][23][- ]Clause|\bBSD\b|ISC|CC0|Unlicense|0BSD)\b/i;
/** 明确不能搬的:Commons Clause 禁止再分发组件本身;Hippocratic 非 OSI;GSAP 禁止用于无代码动画工具 */
const LICENSE_BAD = /Commons[- ]Clause|Hippocratic|Aceternity|\bGSAP\b|proprietary|All rights reserved|专有/i;

/* ── 可搬目录:MagicUI 全部组件的原始源码 + 审查门跑出来的档位 ──
 * 放在 server/catalog/magicui/(不在 src 下,tsc 和 vite 都不会去编译那些原始文件)。
 * 模型通过 card_authoring_guide 看到目录,通过 get_card_source({cardId:"mu-<name>"}) 拿源码,
 * 包成 CardDef 后用同一个 id 走 create_card —— 不需要新工具,也不用上网。
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

/** 目录源码:只认 mu-<name>,name 必须在 index.json 里,防止拿 id 去读别的文件 */
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

/** 把目录渲染成 guide 末尾的一节。按档位分组,每行一个组件:id、一句话、搬时要注意什么 */
export function renderCatalog(): string {
  const cat = loadCatalog();
  if (!cat) return '';
  const groups: Record<string, CatalogEntry[]> = { 1: [], deps: [], 3: [], 2: [] };
  for (const c of cat.components) (groups[String(c.tier)] ||= []).push(c);
  const line = (c: CatalogEntry) =>
    `- \`${c.id}\` —— ${c.description}${c.imported ? `(已在库里:\`${c.imported}\`)` : ''}${c.props.length ? `;上游 props:${c.props.join('、')}` : ''}${c.blockers.length ? `;要处理:${c.blockers.join('、')}` : ''}`;
  return [
    '## 附:Magic UI 可搬目录',
    '',
    `来源 ${cat.license},${cat.components.length} 个组件,源码在本地。想用其中一个:\`get_card_source({ cardId: "mu-<name>" })\` 读原始源码 → 按上面「搬第三方组件」包成 CardDef、文件头写来源 → \`create_card\` 用同一个 id 建卡。档位是审查门跑出来的。`,
    '',
    `### 现在就能搬(${groups[1].length})`, ...groups[1].map(line), '',
    `### 引了没装的库,搬时要把用到的几行带进来或去掉(${groups.deps.length})`, ...groups.deps.map(line), '',
    `### 交互 / 滚动驱动,要改成由 t 驱动的参数才能进导出(${groups[3].length})`, ...groups[3].map(line), '',
    `### 管线暂不支持(${groups[2].length})`, ...groups[2].map(line), '',
    renderAssets(),
  ].join('\n');
}

/** Lottie 与粒子的素材目录:都是现成文件,不用建卡,直接 add_clip 现有的卡并把 URL 填进参数 */
function renderAssets(): string {
  const read = (kind: string) => {
    try { return JSON.parse(fs.readFileSync(new URL(`./catalog/${kind}/index.json`, import.meta.url), 'utf8')); } catch { return null; }
  };
  const out: string[] = [];
  // note 是模型看 6 帧拼图写的观察,比人写的 description 具体;有就优先用,use 是它建议的场合
  const desc = (i: any) => (i.note ? `${i.note}${i.use ? `(${i.use})` : ''}` : i.description);
  const lottie = read('lottie');
  if (lottie) {
    out.push(`## 附:Lottie 素材(${lottie.items.length},${lottie.license})`, '',
      '用法:`add_clip({ cardId: "lottie", params: { src: "<url>" } })`,clip 时长照着 seconds 给;想循环就加 `loop: "yes"`。', '',
      ...lottie.items.map((i: any) => `- \`${i.url}\` —— ${desc(i)};${i.seconds}s,${i.w}×${i.h}`), '');
  }
  const particles = read('particles');
  if (particles) {
    const featured = particles.items.filter((i: any) => i.featured);
    const rest = particles.items.filter((i: any) => !i.featured);
    out.push(`## 附:粒子配置(${particles.items.length},${particles.license})`, '',
      '用法:`add_clip({ cardId: "particles", params: { config: "<url>", seed: 1 } })`。都是背景,通常盖住整段时长放最底层;换 seed 换排布。每个都在导出管线上实跑验证过。', '',
      `### 推荐(${featured.length})`, ...featured.map((i: any) => `- \`${i.url}\` —— ${desc(i)}`), '',
      `### 其他(${rest.length},多是同一外观的变体)`,
      rest.map((i: any) => `\`${i.name}\`(${i.note || i.description})`).join('、'), '');
  }
  return out.join('\n');
}

/**
 * 机械翻译:只做不需要判断的替换。返回改过的源码和「改了什么」的清单,
 * 清单会原样回给调用方 —— 模型得知道文件和它交上来的不一样在哪。
 */
export function translateCardSource(source: string): { source: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = source.replace(/\r\n/g, '\n');

  // Next.js 的客户端指令,Vite 里没意义,留着会被当成一个没用的字符串表达式
  if (/^\s*["']use client["'];?\s*$/m.test(out)) {
    out = out.replace(/^\s*["']use client["'];?\s*\n?/m, '');
    rewrites.push('去掉了 "use client" 指令(Next.js 专用)');
  }
  // shadcn / MagicUI 生态的 cn 别名 → 本地那份(文件落在 src/cards/user/,所以往上一级再进 magicui)
  if (/from\s+["']@\/lib\/utils["']/.test(out)) {
    out = out.replace(/from\s+["']@\/lib\/utils["']/g, 'from "../magicui/vendor/cn"');
    rewrites.push('@/lib/utils → ../magicui/vendor/cn(本地的 cn)');
  }
  return { source: out, rewrites };
}

/** 文件头(前 40 行)里有没有「来源:」声明,以及看起来像不像从 shadcn/MagicUI 生态搬来的 */
function provenance(source: string): { declared: boolean; looksVendored: boolean; header: string } {
  const header = source.split('\n').slice(0, 40).join('\n');
  return {
    declared: /来源\s*[:：]/.test(header) || /@source\b|Source:\s*https?:/i.test(header),
    // 只认别名和站点/仓库名,不认路径片段 —— 本地的 ../magicui/vendor/cn 也含 "magicui",那是我们自己的
    looksVendored: /@\/lib\/utils|@\/components\/|magicui\.design|magicuidesign|shadcn|aceternity|react-bits/i.test(source),
    header,
  };
}

/**
 * 审查门:按实测过的机制清单分档。这里**只管新增的几类**,Date.now / 定时器 /
 * IntersectionObserver 三条老规矩仍在 checkCardSource 里,报错文案不变。
 */
/**
 * 去掉注释,只留代码。给「有没有用某个 API」这类判断用 ——
 * 注释里提到一个名字不等于用了它,尤其是那些**专门解释「为什么不用它」**的注释。
 * 字符串里的 // 不该被当成注释起点,所以要跟着引号状态走,不能拿正则一把梭。
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote = "";      // 当前在哪种引号里("" = 不在)
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
      // 用一个换行顶替,免得把注释两边的记号粘成一个
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

  // ── 第二档:管线接不住 ──
  // canvas 和 Math.random 曾经在这一档,现在不在了:导出页把 Math.random 钉成带种子的、截图期间
  // 关掉脚本执行(exportClock.ts / server/bakery/bake.mjs 的 shoot),静态跳过的探针也看得见 canvas。
  // 实测 tsParticles 粒子卡「新鲜 vs 复用 vs 跳过」逐字节 0 差异。
  //
  // WebGL 也曾经在这一档,现在不在了。当初的理由(「走 GPU 路径,两次不完全一致」)其实是**反的**:
  // 导出那套 --disable-gpu 根本没让它走 GPU,而是把它整个关死 —— getContext("webgl") 返回 null,
  // 画面是一张空画布,还不报错。现在加了 --enable-unsafe-swiftshader 走 SwiftShader 软件光栅,
  // 实测 scene-3d 卡(three.js)在真导出管线上两趟 20/20 帧逐字节相同,老基线 15/15 不受影响。
  //
  // 剩下真正接不住的不是 WebGL,是**按 delta 累积的帧循环**:截图窗口里那段自由跑的虚拟时间
  // 会让它多推进不确定的步数,而且往回拖播放头没有倒带。所以这一档现在拦的是那个模式。
  /*
   * 只匹配字面量 `setAnimationLoop(` 是拦不住的。实测四个样例:
   *   裸 requestAnimationFrame + performance.now() 累积 delta(three)  → 放行
   *   renderer.setAnimationLoop(...)                                   → 拦住
   *   requestAnimationFrame + 自增计数器(连时钟都不读)                → 放行 ← 最阴的一个
   *   const fn = "setAnimationLoop"; renderer[fn](...)                 → 放行
   *
   * 但也不能见 rAF 就拦:rAF 本身在这条管线上是**验证过没问题**的(Motion 的 JS 动画就走它,
   * 逐字节 0 差异),一刀切会把一大批本来好好的卡挡在门外。
   * 真正接不住的是「自己驱动一个三维场景」这个组合 —— 所以两个条件同时成立才拦。
   */
  /*
   * 认**名字本身**,不认调用形式:`const fn = "setAnimationLoop"; renderer[fn](cb)` 这种
   * 拐一手的写法,只匹配 `setAnimationLoop(` 是抓不住的。
   *
   * 但只看代码、不看注释 —— 这条规则的报错文案让作者「照 scene-3d.tsx 的写法」,
   * 而那张卡的注释里恰恰在解释为什么**不能**用 setAnimationLoop。连注释一起匹配的话,
   * 照着抄的人会被这条规则拒掉,理由还是它自己推荐的那份参考。
   */
  const code = stripComments(source);
  const usesRaf = /\brequestAnimationFrame\b|\bsetAnimationLoop\b/.test(code);
  const uses3D = /\bfrom\s+["']three(\/[^"']*)?["']|\bnew\s+THREE\.|\bWebGLRenderer\b|getContext\s*\(\s*["']webgl2?["']/.test(code);
  if (/\bsetAnimationLoop\b/.test(code) || (usesRaf && uses3D)) {
    push(2, '自带帧循环', '三维场景自己跑帧循环(setAnimationLoop / requestAnimationFrame)在这条管线上接不住:导出时截图窗口里那段自由跑的虚拟时间会让它多走不确定的步数,两趟导出对不上;往回拖播放头也回不到原样。把画面写成 t 的纯函数(比如 rotation.y = t * 转速 * 2π),在 t 变了的时候显式 render 一次 —— 照 src/cards/native/scene-3d.tsx 的写法,那张卡一次 rAF 都不注册。');
  }
  if (/\bfrom\s+["'](@react-three\/[^"']+|cobe|@react-three-fiber[^"']*)["']/.test(source)) {
    push(2, '三维框架', '@react-three/fiber 和 cobe 都自带 rAF 帧循环(理由同上),而且都没装。要做三维直接用 three(已装),照 src/cards/native/scene-3d.tsx 那样按 t 渲染。');
  }

  // ── 第三档:靠输入驱动,导出里没有输入 ──
  if (/addEventListener\s*\(\s*["'](mousemove|pointermove|mouseenter|mouseleave|wheel|scroll|touchmove)["']/.test(source)
    || /\bon(MouseMove|PointerMove|MouseEnter|MouseLeave|Wheel|TouchMove)\s*=/.test(source)) {
    push(3, '鼠标/滚动事件', '导出时没有鼠标也没有滚动,这类效果只会停在初态。把「光标在哪」「滚到哪」改成一个由 t 驱动的参数,效果就能进导出。');
  }
  if (/\bwhile(Hover|Tap|Drag|Focus|InView)\s*=/.test(source)) {
    // remotion 式的卡不许用 Motion,文案不往 Motion 上引(那边另有带行号的一条,见 remotion-style-check.mjs)
    push(3, 'whileHover/whileTap/whileInView', hints?.remotionStyle
      ? '同上:hover / tap / 进入视口在导出里都不会发生。要它出现就写成 t 的条件,不要挂在交互上。'
      : '同上:hover / tap / 进入视口在导出里都不会发生。要它播就用 initial + animate,不要挂在交互上。');
  }
  if (/\buse(Scroll|Velocity)\s*\(|window\.scrollY|scrollTop/.test(source)) {
    push(3, '滚动驱动', '同上:导出页不会滚动。');
  }

  // ── 依赖:没装的库 ──
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) {
      push('deps', `import "${spec}"`, spec.startsWith('@/')
        ? `别名 ${spec} 指向的是原项目的文件,这里没有。@/lib/utils 会自动改到本地的 cn;别的要么去掉,要么把用到的那几行搬进来。`
        : hints?.remotionStyle
          ? `没装 ${spec}。remotion 式的卡能引用的是框架 "../../kernel/remotionStyle"、react,以及相对路径引的 kernel/types、kernel/frameReady、kernel/soundEffects、render/cards/graphValues、native/hud、native/sound-effects、magicui/vendor/cn。`
          : `没装 ${spec}。装了的是 react、motion/react、three、lottie-web、@tsparticles/engine|slim,加上 Tailwind class 和相对路径引的 kernel/types、native/hud、magicui/vendor/*。`);
    }
  }

  // ── 动画 class:用了没定义的 animate-* ──
  const usedAnimates = new Set<string>();
  for (const m of source.matchAll(/\banimate-([a-z][a-z0-9-]*)/g)) usedAnimates.add(m[1]);
  for (const name of usedAnimates) {
    if (BUILTIN_ANIMATES.has(name) || VENDORED_ANIMATES.has(name)) continue;
    push('keyframes', `animate-${name}`, hints?.remotionStyle
      ? `这个动画 class 没有定义(Tailwind 自带的只有 spin/ping/pulse/bounce,MagicUI 那 22 组已经搬进 magicui-animations.css)。remotion 式的卡不用 CSS 动画:把随时间变的样式写成 t 的函数。`
      : `这个动画 class 没有定义(Tailwind 自带的只有 spin/ping/pulse/bounce,MagicUI 那 22 组已经搬进 magicui-animations.css)。把它的 @keyframes 和 .animate-${name} 写进那个文件,或改用 motion/react。`);
  }

  // ── 来源与许可证:搬来的代码必须声明,且许可证要能分发 ──
  const p = provenance(source);
  if (p.declared || p.looksVendored || hints?.vendored) {
    if (!p.declared) {
      push('license', '来源未声明', '这段代码看起来是从 shadcn / MagicUI 生态搬来的。文件头必须写「来源: <URL>」和许可证(照 src/cards/magicui/vendor/word-rotate.tsx 的写法),否则不知道能不能随安装包分发。');
    } else if (LICENSE_BAD.test(p.header)) {
      push('license', '许可证不允许分发', '声明的许可证不能搬:React Bits 的 Commons Clause 禁止再分发组件本身,Aceternity 是专有协议,animate.css 的 Hippocratic 不是 OSI 许可,GSAP 禁止用于无代码动画工具。换一个来源。');
    } else if (!LICENSE_OK.test(p.header)) {
      push('license', '许可证不在白名单', '文件头没有写出能识别的许可证。能搬的是 MIT / Apache-2.0 / BSD / ISC / CC0;把原仓库 LICENSE 里的名字写进来源那一行。');
    }
  }

  return f;
}

/** 从源码里第一个 *Props 接口推 controls 建议;推不出来就返回空 */
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
        else if (ts.isArrayTypeNode(t) && t.elementType.kind === ts.SyntaxKind.StringKeyword) out.push({ key, label: key, type: 'text', hint: '上游是 string[],用 | 分隔,组件里 split("|")' });
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
 * 落盘前的静态检查。这里挡住的是「写进去就会让编辑器白屏」的几类错误,
 * 剩下的运行时问题交给 vite 的编译报错和用户预览。
 */
export function checkCardSource(
  id: string,
  source: string,
  existingIds: string[],
  /**
   * mode 没有默认值,三个生产调用点各自写死(A0.1(c)):
   *   - `author`:Agent / 用户现写的卡(create_card、用户卡 edit_card)。frameMode 必填,
   *     而且不许新增 `compositing: 'independent'` —— `before` 是编辑前的源码,新建卡传空串。
   *   - `install`:装机时把随包的卡铺开(installBundledCards)。这两条都不查:
   *     那些源码是仓库里审过的,装机不是一次创作。
   * vendored:翻译器已经确认这是搬来的代码(改写过 @/lib/utils 之类),来源声明就是必填
   */
  hints: { mode: 'author' | 'install'; before?: string; vendored?: boolean },
): CardCheck {
  const errors: string[] = [];
  const authoring = hints.mode === 'author';

  if (!ID_RE.test(id)) {
    errors.push(`卡片 id "${id}" 不合法:要用小写 kebab-case(例如 my-title-card),只能有字母、数字和连字符。`);
  }
  // mu- 是 Magic UI 的命名空间。手写的卡不能占;翻译器从 magicui.design 搬来、
  // 文件头声明了来源的可以用 —— 这样 id 前缀仍然可信:mu- 就是「来自 MagicUI」,不论谁搬的。
  if (id.startsWith('mu-') && !/来源\s*[:：][^\n]*magicui/i.test(source.split('\n').slice(0, 40).join('\n'))) {
    errors.push('mu- 前缀留给 Magic UI 适配卡,换一个 id。(从 magicui.design 搬来、文件头写了「来源: …magicui…」的可以用。)');
  }
  // lottie- / particles- 是素材封装卡(src/cards/assets,由素材目录构建时生成)的命名空间,手写的卡不能占
  if (/^(lottie|particles)-/.test(id)) {
    errors.push('lottie- / particles- 前缀留给素材目录翻译出来的封装卡,换一个 id。');
  }
  if (existingIds.includes(id)) {
    errors.push(`已经有 id 为 "${id}" 的卡片了。卡片 id 必须唯一,换一个;想改现有的卡请直接改它的文件。`);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    errors.push(`源码超过 ${MAX_SOURCE_BYTES / 1024}KB,太大了。`);
  }

  // 必须真的导出一个 CardDef,否则 glob 收集时会静默跳过,建了个寂寞
  if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(source)) {
    errors.push('源码里没有 `export const xxx: CardDef<Params> = { ... }` 形式的具名导出 —— 自动注册靠它识别卡片。');
  }
  const idInSource = source.match(/\bid:\s*["'`]([^"'`]+)["'`]/);
  if (!idInSource) {
    errors.push('CardDef 里没有 id 字段。');
  } else if (idInSource[1] !== id) {
    errors.push(`CardDef 里的 id 是 "${idInSource[1]}",和传进来的 id "${id}" 不一致,两者必须相同。`);
  }
  const required = ['name', 'description', 'defaults', 'controls'];
  // frameMode:现写的卡必须自己声明帧怎么得到;装机铺开随包卡时不查(A0.1(c))
  if (authoring) required.push('frameMode');
  for (const field of required) {
    if (!new RegExp(`\\b${field}\\s*:`).test(source)) {
      errors.push(`CardDef 里缺少 ${field} 字段。`);
    }
  }

  /*
   * 画面从哪来:DOM 卡写 `Component`,素材效果卡写 `card`(视觉)或 `audio`(音频),三者至少一个。
   * 不能只认 `Component` —— 素材效果卡按 H1 就是不写它的,认死了三张示例素材效果卡在 create_card 就被 400 拒掉。
   */
  if (!/\bComponent\s*:/.test(source) && !/\bcard\s*:/.test(source) && !/\baudio\s*:/.test(source)) {
    errors.push('CardDef 里 Component / card / audio 一个都没有 —— DOM 卡写 Component,素材效果卡写 card(视觉)或 audio(音频),三者至少出现一个。');
  }

  // 和 checkSourceEdit 同一条差量规则:新建卡 before = '',所以出现即拒
  if (authoring) {
    const n0 = ((hints.before ?? '').match(COMPOSITING_INDEPENDENT) || []).length;
    const n1 = (source.match(COMPOSITING_INDEPENDENT) || []).length;
    if (n1 > n0) {
      errors.push("不要在源码里写 compositing: 'independent':「只画自己、能单独预渲染上云」是审阅结论,由审阅表 src/cards/capabilities.json 说了算,写在这里不作数。");
    }
  }

  /*
   * remotion 式的卡(`frameMode: "direct"`)另有一套带行号的检查(`remotion-style-check.mjs`):只许引用框架、不读真实时间、
   * 不用定时器与逐帧回调、不用 Motion 与 CSS 动画、不用不带种子的随机、不把东西带到下一帧、顶层只写常量。
   * 只在建卡、改卡时查(`author`);装卡不查,已经在库里的卡照旧载入。声明成 motion 式的卡不走这一套,检查和原来一样。
   */
  const remotion = authoring
    ? remotionStyleErrors(source, { before: hints.before, fileName: `src/cards/user/${ID_RE.test(id) ? id : 'card'}.tsx` })
    : null;
  const remotionStyle = remotion?.remotionStyle === true;

  // 这几条是硬约束:导出时用的是虚拟时钟,拿真实时间的卡导出会不同步。
  // remotion 式的卡由上面那一套查(同样出现即拒,带行号,文案不往 Motion 上引),这里不重复报
  if (!remotionStyle) {
    if (/\bDate\.now\s*\(/.test(source)) {
      errors.push('不要用 Date.now():导出时走的是虚拟时间,会和画面对不上。动画交给 motion/react,需要读时间就用组件收到的 t。');
    }
    if (/\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(source)) {
      errors.push('不要用 setTimeout / setInterval 驱动动画:导出时它们不受虚拟时钟控制。用 motion/react 的 animate,或读组件参数 t。');
    }
    if (/\bIntersectionObserver\b/.test(source)) {
      errors.push('不要用 IntersectionObserver:卡片挂载即播放,不存在「滚动进入视口」这回事。');
    }
  }

  // 语法检查:让写坏的文件在这里就被挡住,而不是存进去把 HMR 打挂
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  for (const d of out.diagnostics || []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const pos = d.start !== undefined ? source.slice(0, d.start).split('\n').length : undefined;
    errors.push(`语法错误${pos ? `(第 ${pos} 行)` : ''}:${msg}`);
  }

  // 审查门:分档的发现也算拒绝理由,并且把档位写进文案 —— 模型只看得到 error 字符串,
  // 得让它一眼分清「这是管线的限制」「这是要改成参数驱动」「这是许可证问题」。
  if (remotion) errors.push(...remotion.errors);
  // remotion 式的检查已经带行号拒过的导入与 CSS 动画,审查门那两类笼统的发现不再重复报
  const rejectedRules = new Set((remotion?.violations ?? []).map((v) => v.rule));
  const findings = reviewCardSource(source, { ...hints, remotionStyle }).filter((x) => !(
    (x.tier === 'deps' && (rejectedRules.has('import') || rejectedRules.has('motion')))
    || (x.tier === 'keyframes' && rejectedRules.has('css-animation'))
  ));
  const TIER_LABEL: Record<string, string> = {
    2: '[第二档·管线暂不支持]', 3: '[第三档·交互驱动]', deps: '[依赖]', keyframes: '[动画 class]', license: '[来源/许可证]',
  };
  for (const x of findings) errors.push(`${TIER_LABEL[String(x.tier)]} ${x.rule}:${x.detail}`);

  return { ok: errors.length === 0, errors, findings };
}

/**
 * 把一次 find/replace 应用到源码上。
 *
 * 独立成纯函数不是为了复用,是为了能测:命中次数、$ 记号、空改这几种情形出错时
 * 都不会报错,只会静静地把文件改成别的样子 —— 那正是这个功能要根治的毛病。
 */
export function applyCardPatch(
  before: string,
  find: string,
  replace: string,
  replaceAll?: boolean,
): { ok: true; after: string; replaced: number } | { ok: false; error: string } {
  if (!find) return { ok: false, error: 'find 不能是空串,那会匹配到每一个位置。' };

  const hits = before.split(find).length - 1;
  if (hits === 0) {
    return {
      ok: false,
      error: 'find 在源码里一次都没匹配到 —— 你手上的版本和文件里的对不上。先调 get_card_source 读回当前源码,照着它写 find(缩进和空格都要一致)。',
    };
  }
  if (hits > 1 && !replaceAll) {
    return {
      ok: false,
      error: `find 匹配到 ${hits} 处,分不清要改哪一处。把 find 写长一点、带上周围几行让它唯一;确实要全改就传 replaceAll: true。`,
    };
  }

  // 用 split/join 而不是 String.replace:后者会把 replace 里的 $& $` $' $$ 当成
  // 「引用匹配内容」的替换记号展开,而这里的 replace 是模型逐字写好的源码,必须原样落盘。
  const after = before.split(find).join(replace);
  if (after === before) {
    return { ok: false, error: 'replace 和 find 完全一样,这次编辑什么都没改。' };
  }
  return { ok: true, after, replaced: hits };
}

/** 一份 .proc 最多带多少张定制卡。再多就不像一个项目了,多半是文件被人动过 */
export const MAX_BUNDLED_CARDS = 200;

export interface CardInstallResult {
  id: string;
  status: 'written' | 'updated' | 'unchanged' | 'rejected';
  error?: string;
  /** updated 时本机旧版的备份(相对项目根) */
  backup?: string;
  /** 实际写到的文件;和底版不同说明写进了改动层,要手动触发热更新 */
  written?: string;
  abs?: string;
}

/**
 * 把 .proc 里带的定制卡装回 src/cards/user/(打开项目时调,见 src/editor/io/procCards.ts)。
 *
 * 规矩:
 *   - 和 create_card **同一道审查**(翻译器 + checkCardSource):.proc 可能是别人发来的,
 *     里面的源码会在编辑器里执行。不过审的那张不装,本机已有的版本原样留着;
 *   - existingIds 只该放**内置卡**的 id:同名内置卡是撞车,同名用户卡是「更新」;
 *   - 本机没有 → 经 writeCardFile 写:有改动层写改动层(检出目录一个文件都不写,装载入口经 userOverlay 收它),
 *     没有改动层(开发期)写底版;
 *   - 本机有且一样 → 不动;
 *   - 本机有但不一样 → **以项目里存的为准**。打开一个项目看到的应该是它存下来的样子;
 *     本机旧版先按内容哈希备份到 historyDir(同一份只备一次),两个项目来回开不会越积越多。
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
      out.push({ id: String(id ?? '?'), status: 'rejected', error: 'id 和 source 都必须是字符串' });
      continue;
    }
    // 先过 id 白名单再碰文件系统:这道校验挡的是路径穿越
    if (!ID_RE.test(id)) {
      out.push({ id, status: 'rejected', error: `卡片 id "${id}" 不合法` });
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
      out.push({ id, status: 'rejected', error: '非法的文件路径' });
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
    /** 仓库里的那个文件(src/cards/user/<id>.tsx) */
    target: string;
    /** 实际写到的文件 */
    written: string;
    already: boolean;
    translated: ReturnType<typeof translateCardSource>;
    finalSource: string;
    suggestedControls: ReturnType<typeof suggestControls>;
  };

/**
 * create_card 的落盘部分(`/api/cards/create` 调;归属戳、热更新、同步上传留在接口里)。
 * 已存在(生效的那一份,改动层优先)又没说 overwrite → 409;过不了翻译器 + 审查 → 400;其余经 writeCardFile 写:
 * 有改动层写改动层(检出目录不写),没有改动层(开发期)写 `src/cards/user/`。
 */
export function createUserCard(opts: { root: string; id: unknown; source: unknown; existingIds?: unknown; overwrite?: unknown }): CreateUserCardResult {
  const { root, id, source, existingIds, overwrite } = opts;
  if (typeof id !== 'string' || typeof source !== 'string') {
    return { ok: false, code: 400, body: { ok: false, error: 'id 和 source 都必须是字符串' } };
  }
  const userDir = path.join(root, 'src', 'cards', 'user');
  const target = path.join(userDir, `${id}.tsx`);
  // id 已经过 kebab-case 白名单,这里再确认一次落点没跑出 user 目录
  if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
    return { ok: false, code: 400, body: { ok: false, error: '非法的文件路径' } };
  }

  // 已存在按生效的那一份判:有改动层时,本机原来没有的用户卡只在改动层里
  const already = effectiveIsFile(root, target);
  if (already && !overwrite) {
    // 这句话出现的时机,正是模型「想改一张已有的卡」的那一刻 —— 全仓库
    // 最该把它引到 edit_card 上的地方。原来这里写的是「传 overwrite: true」,
    // 等于在决策点上教它整篇重写。
    return {
      ok: false,
      code: 409,
      body: {
        ok: false,
        error: `src/cards/user/${id}.tsx 已存在。要改它请用 get_card_source 读回源码、再用 edit_card 改那一处;确实要整张推倒重来才传 overwrite: true。`,
      },
    };
  }

  // 先过翻译器的机械一半(去 "use client"、@/lib/utils 指到本地),再审查。
  // 翻译改过什么要回给调用方,不然模型手上的版本和落盘的对不上。
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

  // 上游 props 里有、controls 里没露出来的,列出来供模型决定要不要提成参数
  const declared = new Set([...finalSource.matchAll(/\bkey:\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const suggestedControls = suggestControls(finalSource).filter((s) => !declared.has(s.key));

  // 经 writeCardFile 写(改动层优先)。以前直接写底版:改动层里有这张卡的旧版(edit_card 改过、同步装过)时,
  // 加载钩子交出的仍是改动层那一份,overwrite 的新内容被盖住;本机原来没有的卡还会写进检出目录。
  const written = writeCardFile(root, target, finalSource);
  return { ok: true, target, written, already, translated, finalSource, suggestedControls };
}

/** 内置卡的 id(user 以外的定义目录里 `id: "..."` 的那些):装用户卡时撞名检查用 */
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
  /** 仓库里的那个文件 */
  abs?: string;
  /** 实际写到的文件;和 abs 不同说明写进了改动层 */
  written?: string;
  /** 用户卡的定义文件:卡片 id */
  userCardId?: string;
}

/**
 * 装一个从内容库同步来的卡片文件(C6.6 第 5 节;`server/card-sync.mjs` 调)。和打开 .proc 装卡走同一条路:
 *   - 用户卡的定义文件(`src/cards/user/<id>.tsx`)交给 installBundledCards:同一道审查(翻译器 + checkCardSource),
 *     一律经 writeCardFile 写:有改动层写改动层(本机没有的也是),没有改动层的开发期写仓库文件,和 edit_card 一样;
 *   - 其余文件(改过的内置卡、部件、用户卡用到的文件)走 edit_card 的那道检查(checkSourceEdit:语法、不许新加不跟帧走的写法、
 *     CardDef 导出和 id 不许动),再经 writeCardFile 写(改动层优先,不碰仓库里的原卡)。
 * 备份不在这里做:要不要备份由同步规则定(本机那份是不是自己的),见 card-sync.mjs。
 */
export function installSyncedFile(opts: { root: string; historyDir: string; rel: string; source: string; existingIds?: string[] }): SyncedInstallResult {
  const { root, rel } = opts;
  if (!isEditablePath(rel)) return { ok: false, status: 'rejected', error: `"${rel}" 不是可同步的卡片文件` };
  if (typeof opts.source !== 'string') return { ok: false, status: 'rejected', error: 'source 必须是字符串' };
  const after = opts.source.replace(/\r\n/g, '\n');
  const user = /^src\/cards\/user\/([^/]+)\.tsx$/.exec(rel);
  if (user && ID_RE.test(user[1])) {
    const [r] = installBundledCards({
      root,
      historyDir: opts.historyDir,
      cards: [{ id: user[1], source: after }],
      existingIds: opts.existingIds ?? builtinCardIds(root),
    });
    if (!r) return { ok: false, status: 'rejected', error: '没有装卡结果' };
    return { ok: r.status !== 'rejected', status: r.status, error: r.error, abs: r.abs, written: r.written, userCardId: user[1] };
  }
  const abs = path.join(root, rel);
  if (!path.resolve(abs).startsWith(path.resolve(root) + path.sep)) return { ok: false, status: 'rejected', error: '非法的文件路径' };
  let before: string | null = null;
  try { before = readEffective(root, abs); } catch { before = null; }
  if (before !== null && before.replace(/\r\n/g, '\n') === after) return { ok: true, status: 'unchanged' };
  const check = checkSourceEdit(rel, before ?? '', after);
  if (!check.ok) return { ok: false, status: 'rejected', error: check.errors.join('\n') };
  const written = writeCardFile(root, abs, after);
  return { ok: true, status: before === null ? 'written' : 'updated', abs, written };
}

/**
 * 项目用到的卡 → 卡片源码同步要带上的文件(C6.6 第 5 节「范围」):每张卡的源码闭包(定义文件 + 用到的卡片 / 部件文件)里,
 * `changed(rel)` 认为是「用户卡或改过的内置卡」的那些。未改的内置卡两端都有,不同步。
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
 * 一张卡的代码身份(c66-host-cards;用法见 `server/card-code.mjs` 文件头):定义文件加它一路 import 到的卡片 / 部件文件
 * (`importClosure`),每个文件记「仓库相对路径 + 生效内容(改动层优先)的内容哈希」,再整体取 sha256 的前 32 位。
 * 内容哈希和内容库同一算法(`card-sync.mjs` 的 `sourceHash`,换行先统一成 LF):同步过来的卡在两端算出同一个身份。
 *
 * `custom`:用户卡(定义或闭包里有 `src/cards/user/` 下的文件),或闭包里有改动层文件 —— 这些卡不在全局代码版本里,
 * 任务要求与整场景键要单独带上它们的身份。找不到定义文件回 null。
 */
export function cardCodeIdentity(root: string, id: string): { version: string; custom: boolean; files: string[] } | null {
  let def = findCardFile(root, id);
  if (!def && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id)) {
    // 用户卡的文件名不一定等于 id(手放进来的文件):按定义里的 `id:` 找
    const userDir = path.join(root, 'src', 'cards', 'user');
    const re = new RegExp(`\\bid:\\s*["'\`]${id}["'\`]`);
    try {
      for (const f of userCardDirEntries(root)) {
        if (!f.endsWith('.tsx')) continue;
        let src = '';
        try { src = readEffective(root, path.join(userDir, f)); } catch { continue; }
        if (re.test(src)) { def = `src/cards/user/${f}`; break; }
      }
    } catch { /* 没有用户卡目录 */ }
  }
  if (!def) return null;
  const files = importClosure(root, def);
  const sha = crypto.createHash('sha256');
  // 取摘要之前的文本与在线页面同一份写法(`cardCodePreimage`):两端算出同一个身份
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

/** 独立渲染主机的一条卡片同步(`createHostCardSync` 的结果) */
export interface HostCardSync {
  status(): Record<string, unknown>;
  idle(): Promise<void>;
  close(): void;
}

/**
 * 独立渲染主机的卡片源码同步(c66-host-cards;C6.6 设计稿第 5 节「读」那一半):主机加入共享项目时经内容库
 * `card-source` 拉下用户卡与改过的卡,装进它自己的改动层;别人改了卡按 `content.watch` 当场同步。
 *
 * - 连接就用这个项目的 `render` 连接(队列节点那一条,`endpoint`),不另开:主机只凭配置里的项目凭证进入,
 *   没有页面替它签票据。解绑时不关这条连接(它归队列节点)。
 * - 只读(`readOnly`):主机不改卡,从不上传。
 * - 装卡走 `installSyncedFile`(和编辑器同步、打开 .proc 装卡同一条路):一律写进改动层(`PROMPTCUT_DATA_DIR`
 *   下的 `card-overrides/`,`render-host.mjs` 指到 `--data` 里),本机原来没有的用户卡也是;检出目录一个文件都不写
 *   (用户卡装载入口经 `src/cards/userOverlay.ts` 收到改动层里的卡)。备份与装卡历史放在主机自己的数据目录。
 * - 装卡之前调 `before()`(卡片代码身份的稳定期重新计时,见 `card-code.mjs`);装完不手动发变更通知,
 *   交给这个进程的 Vite 文件监听(它先作废模块、再发 `emitCardSourceChange`),节点据此清身份缓存,下一拍按新代码认领。
 */
export function createHostCardSync(opts: {
  root: string;
  dataDir: string;
  projectId: string;
  url: string;
  endpoint: { send(m: object): unknown; onMessage(h: (m: any) => void): void; onOpen(h: () => void): void; onClose(h: (info: any) => void): void; onResume?(h: () => void): void; stats?(): any; connected?: boolean };
  before?: () => void;
  /** 装一个文件之前的预检(托管方的隔离工作进程给 `hosted-render/source-gate.mjs` 的 `checkSyncedSource`);不过就不装 */
  precheck?: (rel: string, source: string) => { ok: boolean; errors: string[] };
  log?: (event: string, fields?: object) => void;
}): HostCardSync {
  const { root, dataDir, endpoint } = opts;
  const shared = {
    send: (m: object) => endpoint.send(m),
    onMessage: (h: (m: any) => void) => endpoint.onMessage(h),
    onOpen: (h: () => void) => {
      endpoint.onOpen(h);
      // 同步挂上来时连接可能已经连上了:补一次「连上」,不然要等下一次重连才对账
      if (endpoint.connected === true) queueMicrotask(h);
    },
    onClose: (h: (info: any) => void) => endpoint.onClose(h),
    // 会话端点(`createDocEndpoint`)的接续与诊断照转:接续只记数,诊断里看得到传输脱开与接续
    onResume: (h: () => void) => endpoint.onResume?.(h),
    stats: () => endpoint.stats?.() ?? null,
    close: () => { /* 连接归队列节点 */ },
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
        // 托管方的隔离工作进程:装之前先过同步文件预检(调用方给了 `precheck` 才有;桌面版与普通的独立渲染主机不给)
        if (opts.precheck) {
          let verdict: { ok: boolean; errors: string[] };
          try { verdict = opts.precheck(rel, source); } catch (error: any) { verdict = { ok: false, errors: [String(error?.message ?? error)] }; }
          if (!verdict.ok) return { ok: false, error: `同步文件预检不过:${verdict.errors.slice(0, 5).join(';')}` };
        }
        try { opts.before?.(); } catch { /* 计时出错不挡装卡 */ }
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

/** 改动层里「底版没有」的用户卡清单模块(相对仓库根);磁盘上那份是空表,有改动层时加载钩子换成真实清单 */
export const USER_OVERLAY_MODULE = 'src/cards/userOverlay.ts';

/**
 * 改动层里有、底版没有的卡片 / 部件文件的解析:底版没有这个文件,Vite 自己解析不到,这里把它解析成**仓库里对应的路径**
 * (文件不存在),加载时由 load 钩子交出改动层那一份。模块 id 与底版文件同形,热更新、作废、`?raw` 都照改动层已有文件的老路走。
 * 管三种写法:根相对(`/src/cards/user/x.tsx`,清单模块用)、相对导入(`./x`、`../x`,改动层里的卡互相引用)、绝对路径。
 * 底版有(或没有改动层、不在卡片 / 部件目录下)回 null,交给 Vite。
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
 * 清单模块(`USER_OVERLAY_MODULE`)的内容:改动层里有、底版没有的用户卡文件,形状和 `src/cards/user/index.ts` 的三个 glob 一样
 * (键是 `./<相对用户卡目录的路径>`):入口卡(一层的 .tsx)的模块与源码原文,以及全部源码文件的原文(缓存身份用)。
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
    '// 由 vite-plugin-cards 的 cardOverridesLoader 生成:改动层里有、底版没有的用户卡',
    ...lines,
    `export const overlayModules = { ${modules.join(', ')} };`,
    `export const overlayRaws = { ${raws.join(', ')} };`,
    `export const overlayDependencyRaws = { ${deps.join(', ')} };`,
    '',
  ].join('\n');
}

/**
 * 卡片改动层(card-overrides.mjs)的加载钩子:装机版里改过的卡 / 部件,加载时交出改动层那一份,
 * 仓库里的原文件当只读底版。编辑器的 Vite 和预渲染的 Vite 都挂这个插件,所以两边看到的是同一份。
 *
 * 单独一个 `enforce: 'pre'` 的插件(C6.6 实测):`?raw` 的加载由 vite 自己的 `vite:asset` 插件答,它排在普通插件前面,
 * 原来挂在主插件上的这个钩子对 `?raw` 从来没轮到过——注册表里的定制卡源码(打包 .proc、源码版本、身份键)读到的一直是底版,
 * 改动层里的改动在画面上生效了,身份键却不变,探针不补测。挪到 pre 才先于它。
 * 主插件不能整体改成 pre:它的接口中间件要排在 `/api/**` 同源守卫之后。
 */
function cardOverridesLoader(): Plugin {
  let projectRoot = process.cwd();
  /** 托管方渲染服务的工作进程才有值(`resident` / `isolated`);别的进程是 null,下面那段预检不走 */
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
       * 托管方渲染服务的工作进程(`docs/plan/hosted-render-contract.md` 第 7.5 节):改动层里的文件是项目带来的代码,交给 Vite 与
       * Tailwind 在 Node 一侧处理之前先过同步文件预检(`hosted-render/source-gate.mjs`),不过的换成一段报错的桩——装卡时已经拦过一遍,
       * 这里是第二道(文件不经卡片同步落到改动层里的情况)。常驻工作进程本来就不该有改动层文件,一律不载入。别的进程不走这一段。
       */
      if (hostedKind) {
        const rel = toRel(projectRoot, file);
        const verdict = hostedKind === 'isolated' ? checkSyncedSource(rel, text, { rootHas: (p: string) => fs.existsSync(path.join(projectRoot, p)) }) : { ok: false, errors: ['常驻工作进程不载入任何项目带来的代码'] };
        if (!verdict.ok) {
          console.log(`[page-gate] source-rejected ${JSON.stringify({ rel, errors: verdict.errors.slice(0, 3) })}`);
          return rejectedStub(rel, verdict.errors, { raw: /[?&]raw\b/.test(id) });
        }
      }
      // `?raw` 要的是源码字符串(cards/user/index.ts 打包 .proc 用),不是模块本身。
      // 原样交出去的话,Vite 会把 TSX 源码当成这个 ?raw 模块的 JS 来跑。
      // 换行统一成 LF(同 `raw-eol.mjs`):源码版本 / 身份键不随检出方式变
      if (/[?&]raw\b/.test(id)) return `export default ${JSON.stringify(text.replace(/\r\n/g, "\n"))}`;
      if (hostedKind === 'isolated' && file.endsWith('.css')) return normalizeBrowserCssImports(text);
      return text;
    },
    /*
     * 载入时把顶层锁成只读(remotion 式的框架,三道只读里的第二道):用户卡目录下「声明成 remotion 式并且引用了框架」的文件,
     * 在源码末尾接一句调用,模块载入时把文件顶层的对象冻住(运行时那一半在 `src/kernel/remotionStyle/lock.ts`,
     * 接什么由 `src/online/cardRuntime/remotionLock.mjs` 定,在线页面转译时接的是同一段)。只接在末尾、前面一个字符都不动,
     * 所以不交新的源码映射(`map: null` = 沿用原来的),`inspect_card_dom` 的行号不受影响。
     * 别的文件一律原样:框架出现之前建的卡不可能引用它,内置卡不在用户卡目录下。
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
       * 卡片代码的哈希 → 渲染缓存的键(card-overrides.mjs 的 cardCodeHash)。
       * 按「定义文件 + 依赖闭包」的生效内容算;任何卡片 / 部件源码一变整表清空,下次用到再算。
       */
      const hashCache = new Map<string, string>();
      // 卡片代码身份(c66-host-cards):帧管线的整场景键、队列切分的 requires.cardSources、节点的 cardSourceVersions 都用它
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
            try { sha.update(readEffective(root, path.join(root, f))); } catch { /* 读不到的文件不算进去 */ }
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
          // 改动层里的文件变了:Vite 盯着的是原文件,手动作废对应模块,再按原文件走一遍热更新
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
       * 改动层里「底版没有」的用户卡清单(`src/cards/userOverlay.ts`,由 cardOverridesLoader 生成):
       * 用户卡目录(底版或改动层)里多了、少了文件,清单变了就重载这个模块,热更新沿用户卡装载入口冒到 src/cards/index.ts 接住。
       * 清单没变(改的是已有文件的内容,或多了少了的不是源码,如归属表)不重载:那条由上面 onSource 按文件走。
       * 「清单」就按生成出来的模块正文比。
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
          void server.reloadModule(m).catch(() => { /* 页面没开就没有要热更新的 */ });
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
        try { fs.mkdirSync(top, { recursive: true }); server.watcher.add(top); } catch { /* 建不了就只是没有热更新 */ }
      }

      /*
       * 卡片归属表:哪张定制卡属于哪个项目。
       *
       * 为什么需要它:src/cards/user/ 是**一个全局目录**,index.ts 用 import.meta.glob 扫全目录,
       * 所以从前 Agent 给 A 项目建的卡,打开 B 项目照样出现在 list_cards 里。用户的原话是
       * 「ThreeJS 的资产又从上一个项目泄露给他了」—— 那张 logo-3d-9tian 是给某个客户做的,
       * 串到别人的片子里既是噪音也是风险。
       *
       * 为什么不写进卡片文件本身:注册表拿到的是 import 出来的 CardDef 对象,不是文件文本,
       * 读不到文件头的注释。放一张旁表最直接。
       *
       * 归属只记「谁建的」,**要不要共享是另一回事**(scope 字段),因为跨项目复用有时正是想要的
       * (自己的品牌卡下个片子还想用)。默认 project = 不共享,用户可以在聊天面板里改成共享。
       *
       * 和卡片文件一样走改动层(读生效的那一份,写经 writeCardFile):有改动层时检出目录一个文件都不写,
       * 归属表和它登记的卡(本机原来没有的用户卡也只在改动层里)放在一起。改动层里还没有时读到的是检出里那份,
       * 第一次写就连同原有条目一起写进改动层。
       */
      const scopeFile = path.join(server.config.root, 'src', 'cards', 'user', '_scopes.json');
      type CardScope = { scope: 'project' | 'custom'; projectId?: string; createdAt?: string };
      const readScopes = (): Record<string, CardScope> => {
        try { return JSON.parse(readEffective(server.config.root, scopeFile)); } catch { return {}; }
      };
      const writeScopes = (m: Record<string, CardScope>) => {
        try { writeCardFile(server.config.root, scopeFile, JSON.stringify(m, null, 2)); } catch { /* 写不进去不该让建卡失败 */ }
      };

      /** 写完一个卡片文件之后的热更新:写进改动层时 Vite 盯着的底版没变,手动作废、再按底版变了走一遍 */
      const afterWrite = (abs: string, written: string | undefined) => {
        if (written && written !== abs) {
          for (const m of server.moduleGraph.getModulesByFile(abs.split(path.sep).join('/')) ?? []) server.moduleGraph.invalidateModule(m);
          server.watcher.emit('change', abs);
          // 本机原来没有的用户卡只写进了改动层:装载入口的清单(userOverlay)跟着换,不等文件监听的 add
          reloadUserOverlay();
        }
        emitCardSourceChange(abs);
        // 项目对象没有变；页面须在 HMR 落地后显式重排这张卡的测量。
        server.ws.send({ type: 'custom', event: 'pc:card-sync', data: { type: 'changed', key: toRel(server.config.root, abs) } });
      };

      /*
       * ---------------- 卡片源码同步(C6.6 第 5 节,server/card-sync.mjs) ----------------
       *
       * 编辑器进程自己连文档服务,卡片文件每次保存(edit_card、create_card、安装)后 content.put 进当前项目空间的内容库;
       * 共享项目里另外 content.list / content.watch,按规则把别人的版本装进来(installSyncedFile,和打开 .proc 装卡同一条路),
       * 装完照 edit_card 的做法热更新、发变更通知(渲染 worker 扔掉备用页、预渲染的代码哈希跟着变),再经 HMR 告诉页面重测。
       *
       * 绑定由页面给(和 /api/agent/bind 同一时机,见 src/editor/sync/cardSync.ts):
       *   POST /api/cards/sync/bind   { mode: 'local' | 'ticket', projectId?, url?, ticket?, cardIds? }
       *     - local:本机项目,连本机 /docservice 的 local 空间,只上传(同步那一半是空操作,cardRev 照常自增);
       *     - ticket:共享项目,凭页面签的 page 角色连接票据连过去;票据两分钟过期,重连时经 HMR 向页面再要一张
       *       (`pc:card-sync` 的 { type: 'ticket', reqId, projectId },页面 POST /api/cards/sync/ticket 交回);
       *     - account:账号云端项目,规则与 ticket 相同,只是票据是页面凭登录向账号会话接口取的那种
       *       (子协议 `promptcut.account.<票据>`,`server/account-card-link.mjs`),每建一个新会话现要一张;
       *       这种连接只能用到票据到期(账号访问令牌的寿命),页面交回票据时带上 `expiresAt`,到期前换一个会话;
       *     - cardIds:项目用到的卡,其中的用户卡与改过的内置卡(连同它们用到的文件)服务上还没有的会传上去。
       *   POST /api/cards/sync/unbind  回到本机空间
       *   GET  /api/cards/sync/status  诊断:绑定、记账、最近的通知
       * 页面没绑之前挂在本机空间(编辑器一起来就连)。预渲染进程不同步。
       */
      const syncEnabled = !isPrerender && process.env.PROMPTCUT_CARD_SYNC !== '0';
      // 记账跟着改动层走:装机版的改动层在数据目录里(补丁整个覆盖 runtime/app 时不丢),记账也放那儿,两者才对得上
      const overTop = overridesRoot();
      const syncDir = overTop ? path.join(path.dirname(overTop), 'card-sync') : path.join(server.config.root, '.pc-work', 'card-sync');
      const editedFile = path.join(syncDir, 'edited.json');
      const readEdited = (): Set<string> => {
        try { return new Set((JSON.parse(fs.readFileSync(editedFile, 'utf8')) as unknown[]).filter((x): x is string => typeof x === 'string')); } catch { return new Set(); }
      };
      /** 开发期没有改动层:改过的内置文件记在这里(装机版看改动层里有没有就够了) */
      const noteEdited = (rel: string) => {
        if (rel.startsWith('src/cards/user/') || overridesRoot()) return;
        const s = readEdited();
        if (s.has(rel)) return;
        s.add(rel);
        try { fs.mkdirSync(syncDir, { recursive: true }); fs.writeFileSync(editedFile, JSON.stringify([...s].sort(), null, 2), 'utf8'); } catch { /* 记不下来只影响「改过没有」的判断 */ }
      };
      /** 用户卡(存在就算)或改过的内置卡 / 部件(改动层里有,或开发期记过) */
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
      /** 向页面要一张 page 角色的连接票据(页面在自己那条共享项目连接上签) */
      let ticketSeq = 0;
      type PageTicket = { ticket: string; expiresAt?: number };
      const ticketWaiters = new Map<string, { resolve: (t: PageTicket) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const requestPageTicket = (projectId: string) => new Promise<PageTicket>((resolve, reject) => {
        const reqId = `ct${++ticketSeq}`;
        const timer = setTimeout(() => {
          ticketWaiters.delete(reqId);
          reject(new Error('页面 10 秒内没有交回连接票据'));
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
              // 本机原来没有的用户卡:记在这个共享项目名下(存 .proc 时一起带走)
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
          try { server.ws.send({ type: 'custom', event: 'pc:card-sync', data: { type: 'notice', notice: e } }); } catch { /* 没有页面就算了,诊断接口里还看得到 */ }
        },
        // 账号云端项目的连接有寿命、要按票据到期换会话(`server/account-card-link.mjs`);别的空间与缺省端点相同
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
      /** 本机保存了一个卡片文件:记账、上传 */
      const savedCardFile = (rel: string) => {
        if (!rel.startsWith('src/cards/user/')) noteEdited(rel);
        cardSync?.saved(rel);
      };

      /*
       * 绑定、解绑、交票据这三个口只给编辑器页面用,舞台窗口里的代码(用户卡,可能是别的成员写的)不许碰:
       * 它们决定编辑器进程凭成员本人的连接票据连到哪里去。舞台端口对舞台窗口是同源,`originOk` 拦不住,所以另按「是不是经舞台端口来的」拦。
       */
      const fromStage = (req: any, res: any): boolean => {
        if (!viaStagePort(req)) return false;
        sendJson(res, 403, { ok: false, error: '舞台窗口不能调这个接口' });
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
            if (!projectId) return sendJson(res, 400, { ok: false, error: 'projectId 不合法' });
            if (typeof input.url !== 'string' || !/^wss?:\/\//.test(input.url)) return sendJson(res, 400, { ok: false, error: 'mode 为 ticket 时要给文档服务的 ws(s):// 地址' });
            // 账号项目:只能连账号云端的文档服务(票据是成员本人权限的凭证,不能送到绑定请求随便说的地址去)
            if (mode === 'account' && !accountDocUrlAllowed(input.url)) return sendJson(res, 400, { ok: false, error: '账号项目只能连账号云端的文档服务' });
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
          try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }); }
          const w = typeof data?.reqId === 'string' ? ticketWaiters.get(data.reqId) : undefined;
          if (!w) return sendJson(res, 404, { ok: false, error: '没有在等这张票据' });
          ticketWaiters.delete(data.reqId);
          clearTimeout(w.timer);
          if (typeof data.ticket === 'string' && data.ticket.length > 0 && data.ticket.length <= 2048) w.resolve({ ticket: data.ticket, ...(Number.isSafeInteger(data.expiresAt) ? { expiresAt: data.expiresAt } : {}) });
          else w.reject(new Error(typeof data.error === 'string' ? `页面没签出票据:${data.error}` : '页面交回的票据不合法'));
          sendJson(res, 200, { ok: true });
        });
      });
      // 「冲突合并」里对一张卡点了「合并」:照我这边的源码装回本机并传上去(`card-sync.mjs` 的 takeMine;页面一侧 `src/editor/sync/cardSync.ts`)
      server.middlewares.use('/api/cards/sync/take-mine', (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        if (fromStage(req, res)) return;
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          let data: any = {};
          try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是 JSON' }); }
          if (!cardSync) return sendJson(res, 409, { ok: false, error: '卡片源码同步没开' });
          void cardSync.takeMine(String(data?.key ?? ''), data?.source).then((r: { ok: boolean; error?: string }) => sendJson(res, r.ok ? 200 : 400, r));
        });
      });
      server.middlewares.use('/api/cards/sync/status', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, cardSync ? { ok: true, enabled: true, ...cardSync.status() } : { ok: true, enabled: false });
      });

      // GET 读全表 / POST { cardId, scope } 改一张卡的档位(聊天面板那两个勾选框用)
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
              return sendJson(res, 400, { ok: false, error: 'cardId 必填,scope 只能是 project 或 custom' });
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

      // 建卡规则单独用一个端点按需取,而不是塞进每次对话的系统提示里 ——
      // 它只在「要建新卡」时才用得上,常驻会白白占掉几千 token。
      /**
       * 素材文件:/catalog/lottie/<name>.json、/catalog/particles/<name>.json。
       * Lottie 卡的 src、粒子卡的 config 直接填这个 URL,编辑器预览和导出页都从这里取
       * (同源 fetch,导出脚本的 pauseIfNetworkFetchesPending 会等它取完再推进虚拟时间)。
       * 只放行 index.json 里登记过的名字,不拿 URL 去读别的文件。
       */
      server.middlewares.use('/catalog', (req, res, next) => {
        const m = /^\/(lottie|particles)\/([A-Za-z0-9-]+)\.json$/.exec((req.url || '').split('?')[0]);
        if (!m) return next();
        const [, kind, name] = m;
        try {
          const index = JSON.parse(fs.readFileSync(new URL(`./catalog/${kind}/index.json`, import.meta.url), 'utf8'));
          if (!index.items.some((it: { name: string }) => it.name === name)) return sendJson(res, 404, { ok: false, error: `${kind} 素材目录里没有 "${name}"` });
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
          // 附上可搬目录:模型只看得见库里已有的卡,不知道 MagicUI 还有哪些没搬、各干什么。
          // 目录是审查门跑出来的(server/catalog/magicui/index.json),档位不是手写的。
          res.end(guide + '\n' + renderCatalog());
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) });
        }
      });

      /**
       * 读回一张卡的源码。0.4 起内置卡也能读(理由见文件头「Agent 能读、能改所有卡片的原始源码」)。
       *
       * 没有这个口子的时候,改卡只能走 create_card + overwrite —— 那是整篇重写,
       * 模型手上没有当前版本,只能凭记忆重建,没被提到的细节每轮都会漂。先读回来,才谈得上「改」。
       *
       * 返回定义文件的源码,外加 files:这张卡一路用到的卡片 / 部件文件,每个带 sharedBy(被几张卡共用)。
       * 传 file 就读其中那一个 —— inspect_card_dom 标出来的源码位置常常落在共用部件或 vendor 文件里。
       * 既不是用户卡、也不是已注册卡片的 id,仍然回落到 Magic UI 可搬目录(给「搬第三方组件」用)。
       */
      server.middlewares.use('/api/cards/source', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const q = new URL(req.url || '', 'http://x').searchParams;
        const id = q.get('id') || '';
        const wantFile = q.get('file') || '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });
        const root = server.config.root;
        const defFile = findCardFile(root, id);
        if (!defFile) {
          // 不是卡 → 看看是不是可搬目录里的 MagicUI 组件。返回的是**上游原始源码**,
          // 还没包成 CardDef,模型拿到后按 guide 的「搬第三方组件」包好、用同一个 id 走 create_card。
          const cat = readCatalogSource(id);
          if (cat) {
            return sendJson(res, 200, {
              ok: true, id, file: cat.entry.file, source: cat.source, lines: cat.source.split('\n').length,
              catalog: true, tier: cat.entry.tier, blockers: cat.entry.blockers, props: cat.entry.props,
              hint: `这是 Magic UI 目录里的原始源码(MIT),还不是卡。包成 CardDef、文件头写「来源: https://magicui.design/docs/components/${cat.name}」和 MIT,再用 create_card 以 id "${id}" 建卡。${cat.entry.blockers.length ? '要先处理:' + cat.entry.blockers.join('、') : ''}`,
            });
          }
          return sendJson(res, 404, {
            ok: false,
            error: `找不到卡片 "${id}" 的源码。先用 list_cards 确认 id;Magic UI 目录里还没搬的组件用 mu-<name> 读(见 card_authoring_guide 末尾的目录)。素材封装卡(lottie-* / particles-*)是按素材目录生成的,没有单独的源码文件 —— 要改它们的画法,读 lottie / particles 这两张卡。`,
          });
        }
        const closure = importClosure(root, defFile);
        const target = wantFile || defFile;
        if (!closure.includes(target)) {
          return sendJson(res, 400, { ok: false, error: `"${target}" 不在卡片 ${id} 的源码文件里。能读的是:${closure.join('、')}` });
        }
        const counts = sharedByCounts(root);
        // 生效内容:装机版里改过的卡读的是改动层那一份(见 card-overrides.mjs)
        const source = readEffective(root, path.join(root, target));
        const builtin = !defFile.startsWith('src/cards/user/');
        sendJson(res, 200, {
          ok: true, id, file: target, source, lines: source.split('\n').length, builtin,
          files: closure.map((f) => ({ file: f, sharedBy: counts.get(f) || 1 })),
          ...(builtin ? { hint: '这是内置卡。改它用 edit_card(可以带 file 改它用到的部件 / vendor 文件);sharedBy > 1 的文件是多张卡共用的,改了它们都会跟着变。改完用 see_frames 看一眼画面。' } : {}),
        });
      });

      /**
       * 局部替换式改卡:给一段 find、一段 replace,只动那一处。用户卡和内置卡都行,带 file 可以改部件文件。
       *
       * 相对 create_card + overwrite 的意义不在省字数,在于**没提到的地方一定不变**。
       * 所以 find 必须唯一命中:命中 0 次说明调用方手上的版本是旧的,命中多次说明
       * 它想改哪一处根本没说清 —— 两种都该报错让它先读回源码,而不是替它猜。
       *
       * 能改的只有这张卡的源码闭包(定义文件 + 它用到的卡片 / 部件文件),而且只能是源码 / 样式文件。
       * 用户卡的定义文件走和建卡一样的校验;内置 / 共用文件走 checkSourceEdit(语法 + 不许新加不跟帧走的写法
       * + CardDef 导出和 id 不许动),改之前备份到 out/card-edits/。
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
              return sendJson(res, 400, { ok: false, error: 'id、find、replace 都必须是字符串' });
            }
            if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });

            const root = server.config.root;
            const defFile = findCardFile(root, id);
            if (!defFile) {
              return sendJson(res, 404, { ok: false, error: `找不到卡片 "${id}" 的源码。先用 get_card_source 确认 id 和能改的文件。` });
            }
            const closure = importClosure(root, defFile);
            const target = typeof file === 'string' && file ? file : defFile;
            if (!closure.includes(target) || !isEditablePath(target)) {
              return sendJson(res, 400, { ok: false, error: `"${target}" 不是卡片 ${id} 的源码文件,不能改。能改的是:${closure.join('、')}` });
            }

            const abs = path.join(root, target);
            // 改的是生效的那一份:装机版里上一次改动在改动层,接着改要从它往下改,不是从底版
            const before = readEffective(root, abs);
            const patch = applyCardPatch(before, find, replace, replaceAll === true);
            if (!patch.ok) return sendJson(res, 400, { ok: false, error: patch.error });
            const { after, replaced } = patch;

            const isUserDef = target === defFile && defFile.startsWith('src/cards/user/');
            // 用户卡的定义文件和 create 走同一套校验:局部替换一样能把文件改到编译不过
            const check = isUserDef ? checkCardSource(id, after, [], { mode: 'author', before }) : checkSourceEdit(target, before, after);
            if (!check.ok) {
              return sendJson(res, 400, { ok: false, error: check.errors.join('\n'), errors: check.errors });
            }

            // B2(cloud-task.md):用户卡也备份。被同步覆盖、被改坏时都从 out/card-edits/ 找回
            const backup = backupBeforeEdit(root, target, before);
            /*
             * 写到哪儿由 card-overrides 决定:装机版写改动层(补丁覆盖 runtime/app 时改动不丢),
             * 开发期直接写仓库文件。写进改动层时 Vite 盯着的原文件没变,它自己不会热更新 ——
             * 手动把那个模块作废,再按「原文件变了」走一遍同样的热更新(load 钩子会交出改动层的内容)。
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
                ? `已改写并热更新。这个文件被 ${sharedBy} 张卡共用,它们都会跟着变。改完用 see_frames 看一眼画面。`
                : '已改写并热更新。改完用 see_frames 看一眼画面,再决定要不要接着调。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * 只读 DOM 树(inspect_card_dom 的服务端)。
       *
       * 用导出同一条渲染管线(server/bakery/)把单独这一个片段渲到指定那一帧,
       * 在页面里采出折叠过包装层的树,再用 source map 把每个节点的渲染位置换回源码行号。
       * **借 agent lane 的那一个 bakery**(`FramePipeline.runAgentTask`,T1a 审查 #12):和 `see_frames` 的
       * agent 批、`/api/cards/layout`、D3 的实体矩形排同一条队,同一时刻只有一个任务驱动那个页面;
       * 空闲关闭也由 pipeline 统一管(cloud-task.md I1:一个 Chrome、空闲 10 分钟关)。
       * 以前这里自己留一个 bakery、自己一条 `domChain`,会和在飞的 `see_frames` 各开一个 Chrome、互不排队。
       * 同一时刻的树缓存起来:模型「往下看」一个 ref 时不用重渲一遍。源码一改,缓存全清。
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
        } catch { /* 拿不到就退回转换后的行号,并标出来 */ }
        mapCache.set(urlPath, decoded);
        return decoded;
      };
      /*
       * 项目 JSON 放在内存里按短 id 供页面拉取,和 vite-plugin-vision 的 /@export/<id>/project.json 同一个做法。
       * 不塞进 URL:卡片 props 里有长文本或 data: 图片时,请求行超过 Node 的 16 KB 头部上限,页面直接 431。
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
       * 本进程的 FramePipeline(和 vite-plugin-frames 的 `/api/frames/*`、`/api/cards/layout` 同一个实例)。
       * 惰性 import:单测把本文件单独转译到临时目录再 import,静态 import 兄弟 .ts 会解析失败。
       */
      const agentPipeline = async () => {
        const { frameService } = await import('./vite-plugin-frames');
        const port = (server.httpServer?.address() as any)?.port;
        return frameService(server.config.root, `http://127.0.0.1:${port}`);
      };
      /** `lease`:`runAgentTask` 交进来的借 bakery 函数;bakery 的还和空闲关闭都归 pipeline */
      const renderDomTree = async (origin: string, isoProject: any, frame: number, lease: (project: any, opts?: { asIs?: boolean }) => Promise<any>): Promise<DomNode[]> => {
        const pid = crypto.randomBytes(8).toString('hex');
        domProjects.clear(); // 一次只渲一个(agent lane 排队),上一份用不着了
        domProjects.set(pid, JSON.stringify(isoProject));
        const url = `${origin}/?export=1&timeline=/@cards-dom/${pid}/project.json`;
        const mod = await import(pathToFileURL(path.join(server.config.root, 'server', 'bakery', 'index.mjs')).href);
        // `asIs`:马上就 reset 到 DOM 页,不用先按项目重置一遍。`project` 必须是这里的对象
        // (`acquire` 冷启动时读 `project.width`),不能从 `domProjects` 取字符串(cloud-task.md I1)。
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
          n.where = `${n.site.path.slice(1)}:${o ? o.line : `${n.site.line}(转换后行号)`}`;
        }
        return nodes;
      };

      server.middlewares.use('/api/cards/dom', (req, res) => {
        // 编辑器这一端不渲:原样转给预渲染进程(它有自己的 Chrome,不占编辑器这边的进程和连接)
        if (!isPrerender) return proxyToPrerender(req, res);
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 32 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
          // 一次只渲一个:借 agent lane 的 bakery,和 see_frames / layout 排同一条队(#12)
          void agentPipeline().then(pipeline => pipeline.runAgentTask(async (lease: any) => {
            try {
              const { project, clipId, t, ref, depth } = JSON.parse(body || '{}');
              if (!project || typeof clipId !== 'string') return sendJson(res, 400, { ok: false, error: 'project 和 clipId 必填' });
              const iso = isolateClipForDom(project, clipId);
              if (!iso) return sendJson(res, 404, { ok: false, error: `项目里找不到片段 ${clipId}` });
              const fps = Number(project.fps) || 30;
              const { clip } = iso;
              const tt = typeof t === 'number' && Number.isFinite(t)
                ? Math.min(Math.max(t, clip.start), clip.end - 1 / fps)
                : (clip.start + clip.end) / 2;
              const frame = Math.max(0, Math.round(tt * fps));
              /*
               * 挪到固定起跑线上再渲:导出从第 0 帧顺推,片段排在第 50 秒就得先推一千多帧。卡片画面和它在
               * 时间轴上的绝对位置无关(提交 4edf40e 逐卡验过 34/34),所以把它挪到 0.5 秒处 ——
               * 不挪到 0 是因为第 0 帧上有预热,压着第 0 帧的卡会多经历一段(同一个提交里实测过)。
               * 片内位置用整数帧号换算,不用秒相减(浮点减法会让同一帧算出两个键)。
               */
              const LEAD_IN = 15; // 0.5 秒 @30fps;按帧数给,换 fps 也是整数帧
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
                entry = { nodes, header: `片段 ${clipId}(${clip.cardId ?? '素材'})第 ${frame} 帧(t=${(frame / fps).toFixed(3)}s,片内第 ${inClip} 帧),折叠包装层后 ${nodes.length} 个节点。` };
                domTrees.set(key, entry);
                if (domTrees.size > 20) domTrees.delete(domTrees.keys().next().value as string);
              }
              const refNum = typeof ref === 'string' ? Number(ref.replace(/^ref_/, '')) : ref;
              const from = Number.isInteger(refNum) && entry.nodes[refNum] ? refNum : 0;
              const d = Math.max(1, Math.min(8, Number(depth) || 3));
              const text = entry.nodes.length
                ? formatDomTree(entry.nodes, from, d)
                : '(舞台上什么都没有 —— 这一刻这张卡还没进场或已经退场)';
              sendJson(res, 200, {
                ok: true, clipId, frame, t: frame / fps, nodes: entry.nodes.length, cached,
                text: `${entry.header}${from ? `从 ref_${from} ` : ''}往下 ${d} 层:\n${text}`,
                hint: '这棵树只能看、不能改:舞台上的 HTML 是源码渲染出来的。要改哪个节点,用 get_card_source 读它标出的那个文件,再用 edit_card(带 file)改那一行。',
              });
            } catch (e: any) {
              sendJson(res, 500, { ok: false, error: e?.message || String(e) });
            }
          })).catch((e: any) => {
            // 进不了队(比如这个进程没有 Agent lane)就如实回
            sendJson(res, Number(e?.status) || 500, { ok: false, code: e?.code, retryable: e?.retryable, error: e?.message || String(e) });
          });
        });
      });

      /**
       * `/api/cards/audio`:替云端 Agent 生成一段卡片声音(`render_card_audio` 的云端路;契约 cloud-agent-contract.md 第 9.4c 节)。
       *
       * 卡片的 `audio()` 在**渲染页**里求值(`src/audio/cardAudioHost.ts`,与桌面版同一份求值与记录),不在 Node 里、
       * 更不在 Agent 服务进程里。和 `/api/cards/dom` 一样借 agent lane 的那一个 bakery、排同一条队;托管方的工作进程里
       * 这条接口只认管理进程转来的(`hosted-render/vite-gate.mjs`:看画面那一批接口的口令),浏览器发来的照旧 403。
       * 回 `{ ok, clipId, expectedClip, reusable? | { name, bytes, rendition, wav: <base64> } }`;WAV 分块从页面取回。
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
              if (!project || typeof clipId !== 'string') return sendJson(res, 400, { ok: false, error: 'project 和 clipId 必填' });
              const pid = crypto.randomBytes(8).toString('hex');
              domProjects.clear();
              domProjects.set(pid, JSON.stringify(project));
              const bakery = await lease(project, { asIs: true });
              await bakery.reset(null, `http://${req.headers.host}/?export=1&timeline=/@cards-dom/${pid}/project.json`);
              // 页面里跑的那两段写成字符串:不经转译器,动态 import 的地址也不被打包工具当成本文件的依赖
              const arg = JSON.stringify({ url: `/@cards-dom/${pid}/project.json`, clipId, force: force === true, maxBytes: CARD_AUDIO_MAX_BYTES });
              const meta: any = await bakery.page.evaluate(`(async () => { const a = ${arg}; try {
                const mod = await import('/src/audio/cardAudioHost.ts');
                const p = await (await fetch(a.url)).json();
                return await mod.renderClipCardAudio(p, a.clipId, { force: a.force, maxBytes: a.maxBytes });
              } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 400) }; } })()`);
              if (!meta || meta.ok !== true) return sendJson(res, 200, { ok: false, code: 'CARD_AUDIO_FAILED', error: meta?.error || '卡片声音没有生成' });
              if (meta.reusable) return sendJson(res, 200, meta);
              const total = Number(meta.bytes);
              if (!Number.isSafeInteger(total) || total < 45 || total > CARD_AUDIO_MAX_BYTES) return sendJson(res, 200, { ok: false, code: 'CARD_AUDIO_FAILED', error: '卡片声音的大小不对' });
              const CHUNK = 3 * 1024 * 1024;
              const parts: string[] = [];
              for (let from = 0; from < total; from += CHUNK) {
                parts.push(await bakery.page.evaluate(`import('/src/audio/cardAudioHost.ts').then((m) => m.takeCardAudioChunk(${from}, ${CHUNK}))`));
              }
              // 每块 3 MiB 是 3 的倍数:各块的 base64 没有填充,可以直接拼
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
       * 打开项目时把 .proc 里带的定制卡装回来。规矩在 installBundledCards;
       * 这里只管三件事:收请求、写进改动层的手动触发热更新、给本机原来没有的卡盖归属戳。
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
              // 写进改动层时 Vite 盯着的底版没变,和 edit_card 一样手动作废、再按底版变了走热更新
              afterWrite(r.abs, r.written);
              // 打开 .proc 装上 / 更新的卡也算一次保存:进当前空间的内容库
              if (r.status === 'written' || r.status === 'updated') savedCardFile(`src/cards/user/${r.id}.tsx`);
            }
            // 本机原来没有的卡:记在这个项目名下。已有条目不动 —— 用户设过的共享不该被一次打开冲掉
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
             * 盖归属戳。默认 project = 只在建它的这个项目里出现 —— 这是止血的那一下:
             * 定制卡多半是给某个客户/某条片子做的,默认共享才是反直觉的那个选择。
             * 想跨项目复用,在聊天面板里把它改成「自定义素材」即可。
             * 覆盖重写(overwrite)时不动已有的档位,免得用户设过的共享被一次改卡冲掉。
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
              // 把落盘后的源码原样回给调用方。少了这一步,模型下次想改这张卡时手上
              // 没有当前版本,只能凭记忆整篇重写 —— 实测那会让没被提到的细节每重写
              // 一次就漂一点(同一张卡的字号一路 42→56→42→32)。
              source: finalSource,
              lines: finalSource.split('\n').length,
              hint: '已写入并热更新。要再改它请用 edit_card 做局部替换,不要用 create_card 整篇重写。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  }];
}
