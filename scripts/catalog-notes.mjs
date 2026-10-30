/**
 * 给素材目录(server/catalog/{lottie,particles})生成「模型看图写的说明」的两步工具。
 *
 * 流程一共三步,中间那步靠外部模型,不在这个脚本里:
 *   1. node scripts/catalog-notes.mjs sheets --url http://127.0.0.1:<自己起的 dev server 端口>/?export=1 [--out <dir>] [--only lottie:gatin,particles:snow]
 *      每个素材在导出管线上预渲染一段(Lottie 3 秒、粒子 2 秒),按时间顺序抽 6 帧,横排拼成一张
 *      带序号和时间戳的长图(深底,粒子的白点看得见),写到 <out>/<kind>__<name>.png。
 *   2. 把 <out> 交给会看图的模型(用 subagent-agy 技能派 manager 跑 gemini-3.8-flash),
 *      让它对每张写 note(6 帧里发生了什么,≤40 字)、use(适合什么场合)、3 个 tags,
 *      汇总成 <out>/notes.json:{ "<kind>__<name>": { note, use, tags } }。
 *   3. node scripts/catalog-notes.mjs merge --notes <out>/notes.json
 *      把 note / use / tags 合并进两个 index.json;人写的 description 保留作兜底。
 *      card_authoring_guide 末尾的目录优先显示 note(见 server/vite-plugin-cards.ts 的 renderAssets)。
 *
 * 为什么是 6 帧拼图而不是整段视频:模型看一张图比看视频便宜得多,6 帧带时间戳足够说清
 * 「什么东西、怎么动」;首次跑 58 个素材时 manager 抽 3 张人工对照,2 条属实、1 条运动方向
 * 写反(已返工),说明这个粒度够用但要抽查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { openBakery, bakeFrames } from '../server/bakery/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'server', 'catalog');
const KINDS = {
  lottie: { seconds: 3, clip: (it) => ({ cardId: 'lottie', params: { json: '', src: it.url, loop: 'yes' } }) },
  particles: { seconds: 2, clip: (it) => ({ cardId: 'particles', params: { config: it.url, seed: 1 } }) },
};

function readIndex(kind) {
  return JSON.parse(fs.readFileSync(path.join(CATALOG, kind, 'index.json'), 'utf8'));
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else o._.push(argv[i]);
  }
  return o;
}

async function sheets(o) {
  // 地址必须显式给(--url 或环境变量 PROMPTCUT_BASE),不缺省连用户常驻的编辑器(5190～5192)
  const base = process.env.PROMPTCUT_BASE ? `${process.env.PROMPTCUT_BASE.replace(/\/+$/, '')}/?export=1` : '';
  const url = typeof o.url === 'string' ? o.url : base;
  if (!url) {
    console.error('用法: node scripts/catalog-notes.mjs sheets --url <导出页URL>(或设环境变量 PROMPTCUT_BASE)\n不给地址不跑:不缺省连用户常驻的编辑器。');
    process.exit(2);
  }
  const out = path.resolve(o.out || path.join(ROOT, 'out', 'catalog-sheets'));
  const only = o.only ? new Set(String(o.only).split(',')) : null;
  fs.mkdirSync(out, { recursive: true });
  const framesRoot = path.join(out, '.frames');

  const items = [];
  for (const [kind, spec] of Object.entries(KINDS)) {
    for (const it of readIndex(kind).items) {
      if (only && !only.has(`${kind}:${it.name}`)) continue;
      items.push({ kind, name: it.name, seconds: spec.seconds, clip: spec.clip(it) });
    }
  }
  console.log(`${items.length} 个素材,每个渲染一段再抽 6 帧…`);

  const bakery = await openBakery({ url });
  const sheetBrowser = await puppeteer.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await sheetBrowser.newPage();
  await page.setViewport({ width: 2940, height: 360, deviceScaleFactor: 1 });
  try {
    for (const it of items) {
      const dir = path.join(framesRoot, `${it.kind}__${it.name}`);
      fs.rmSync(dir, { recursive: true, force: true });
      await bakery.reset({
        version: 1, name: 'sheet', width: 1920, height: 1080, fps: 30, duration: it.seconds, themeId: 'midnight', media: [],
        tracks: [{ id: 't1', name: 's1', clips: [{ id: 'c1', start: 0, end: it.seconds, ...it.clip }] }],
      });
      const r = await bakeFrames(bakery, { out: dir, format: 'png' });
      const frames = fs.readdirSync(r.framesDir).filter((f) => f.endsWith('.png')).sort();
      const N = frames.length;
      const picks = [0, 1, 2, 3, 4, 5].map((i) => Math.round((i * (N - 1)) / 5));
      const cells = picks.map((fi, i) => {
        const b64 = fs.readFileSync(path.join(r.framesDir, frames[fi])).toString('base64');
        const t = ((fi / (N - 1)) * it.seconds).toFixed(2);
        return `<div class=c><img src="data:image/png;base64,${b64}"><div class=l>${i + 1}  ·  t=${t}s (第 ${fi} 帧)</div></div>`;
      }).join('');
      await page.setContent(
        `<html><body style="margin:0;background:#141414;font-family:system-ui"><div style="display:flex;gap:10px;padding:10px">${cells}</div>` +
        `<style>.c{width:470px}.c img{width:470px;height:264px;display:block;background:#1e1e1e;border:1px solid #333}.l{color:#ddd;font:600 22px system-ui;padding:6px 0 0}</style></body></html>`,
        { waitUntil: 'load' },
      );
      const file = path.join(out, `${it.kind}__${it.name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 2900, height: 320 } });
      fs.rmSync(dir, { recursive: true, force: true });   // 帧只为拼图,拼完就删
      console.log(`  ✓ ${it.kind}__${it.name}`);
    }
  } finally {
    await sheetBrowser.close();
    await bakery.close();
    fs.rmSync(framesRoot, { recursive: true, force: true });
  }
  console.log(`拼图完成 → ${out}\n下一步:把这个目录交给会看图的模型写 notes.json,再跑 merge。`);
}

function merge(o) {
  if (!o.notes) throw new Error('要 --notes <notes.json>');
  const notes = JSON.parse(fs.readFileSync(path.resolve(String(o.notes)), 'utf8'));
  let hit = 0;
  const miss = [];
  for (const kind of Object.keys(KINDS)) {
    const p = path.join(CATALOG, kind, 'index.json');
    const j = readIndex(kind);
    for (const it of j.items) {
      const n = notes[`${kind}__${it.name}`];
      if (n && n.note) {
        it.note = String(n.note);
        it.use = String(n.use || '');
        it.tags = Array.isArray(n.tags) ? n.tags.map(String) : [];
        hit++;
      } else miss.push(`${kind}__${it.name}`);
    }
    j.notes_by = '模型看 6 帧拼图写的观察(note/use/tags),见 scripts/catalog-notes.mjs;description 是人写的兜底';
    fs.writeFileSync(p, JSON.stringify(j, null, 1));
  }
  console.log(`合并 ${hit} 条${miss.length ? `;没有 note 的 ${miss.length} 条:${miss.join(' ')}` : ''}`);
}

const o = parseArgs(process.argv.slice(2));
const cmd = o._[0];
if (cmd === 'sheets') await sheets(o);
else if (cmd === 'merge') merge(o);
else {
  console.log('用法:\n  node scripts/catalog-notes.mjs sheets --url <导出页URL> [--out <dir>] [--only lottie:gatin,particles:snow]\n  node scripts/catalog-notes.mjs merge --notes <notes.json>');
  process.exit(1);
}
