/**
 * 视频取帧节奏探针(`docs/plan/TODO.md`「用户真机缺陷」一条:素材效果卡的视频输入源在 0.5 倍慢放导出时节奏不均)。
 * 这条行为此后的回归基线;G0-R「预渲染探针」一行,改到取帧、解码、素材效果卡视频源、`src/render/frameMedia.ts` 时必跑。
 *
 *   node scripts/probes/video-source-cadence-probe.mjs [--port 6030] [--keep]
 *
 * 做法:
 *   - ffmpeg 合成两份素材:30 fps 与 25 fps,各 3 s、64×64,第 n 帧整幅灰度 = 16 × (n mod 16)(RGB 值,色度中性;
 *     阶梯 16,扛有损编码)。TODO 写的是 2 s,这里取 3 s:用例③的 mediaOffset 0.35 要取到第 69 帧,2 s 只有 60 帧。
 *   - 一份 30 fps、256×144 的项目,每个用例一段 2 s(60 帧)、首尾相接排在时间轴上:
 *       ① 素材效果卡节点(原样输出上游的直通素材效果卡 `probe-cadence-pass`)输入源 rate 0.5、offset 0 与 0.35(10.5 帧,非整帧);
 *       ② 同一素材效果卡 rate 1、offset 0;
 *       ③ 时间轴普通视频片段 mediaOffset 0 与 0.35(覆盖 `src/render/frameMedia.ts`);
 *       ④ 25 fps 素材经素材效果卡 rate 1(另加一段 25 fps 的时间轴片段,同一条规则)。
 *   - 起一台 dev server(导出目录、数据目录都是新建的临时目录;直通素材效果卡写进临时的卡片改动层 `PROMPTCUT_CARD_OVERRIDES`,
 *     检出目录一个文件都不写),`exportFrames` 单进程导出全片 PNG。
 *   - 读每帧中心 16×16 的平均灰度,四舍五入到 16 的倍数得到 n mod 16,按单调性还原成源帧号 m(n)。
 *   - 断言 m(n) = floor((offset + rate × n / 30) × 源帧率 + 1e-6)(n 是这一段里的第几帧)。
 *
 * 输出最后一行一行 JSON:`{ ok, fails: [], cases: [{ name, got, want, bad }] }`;退出码 0 当且仅当 `fails` 为空。
 * 端口:编辑器 `--port`,舞台另占 +1、+2;默认 6030。`--keep` 留下临时目录(帧、日志)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { exportFrames } from '../../server/bakery/export.mjs';

const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 6030);
const KEEP = args.includes('--keep');
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const WORK = path.join(os.tmpdir(), `pc-cadence-probe-${RUN}`);
const MEDIA_DIR = path.join(WORK, 'media');
const DATA_DIR = path.join(WORK, 'data');
const OVERRIDES = path.join(WORK, 'card-overrides');
const EXPORT_ID = 'cadence';
const OUT_DIR = path.join(WORK, `export-${EXPORT_ID}`);
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const fails = [];
const out = { ok: false, port: PORT, work: WORK };
const log = (msg) => console.log(`[cadence] ${msg}`);

const FPS = 30, SEG = 60, W = 256, H = 144, SRC_SECONDS = 3;

/* ---------------- 素材 ---------------- */

const ffmpeg = await findFfmpeg();
function makeSource(rate) {
  const tmp = path.join(WORK, `src-${rate}.mp4`);
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=black:s=64x64:r=${rate}:d=${SRC_SECONDS}`,
    '-vf', "format=rgb24,geq=r='16*mod(N\\,16)':g='16*mod(N\\,16)':b='16*mod(N\\,16)',format=yuv420p",
    '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`合成 ${rate} fps 素材失败:${r.stderr}`);
  const bytes = fs.readFileSync(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.renameSync(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: `m${rate}`, kind: 'video', name: `cadence-${rate}.mp4`, url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 64, height: 64, fps: rate };
}
const src30 = makeSource(30);
const src25 = makeSource(25);

/* ---------------- 直通素材效果卡(写进临时改动层) ---------------- */

const CARD_ID = 'probe-cadence-pass';
const cardFile = path.join(OVERRIDES, 'src', 'cards', 'user', `${CARD_ID}.tsx`);
fs.mkdirSync(path.dirname(cardFile), { recursive: true });
fs.writeFileSync(cardFile, `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** 探针用:原样输出上游(video-source-cadence-probe.mjs 临时写进改动层) */
export const probeCadencePass: CardDef<Record<string, never>> = {
  id: "${CARD_ID}",
  name: "节奏探针直通",
  description: "原样输出输入画面",
  source: "user",
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "输入画面" } },
  defaults: {},
  controls: [],
  card: (sources, t) => glsl(
    \`uniform sampler2D u_input0;
     void main() { outColor = texture(u_input0, v_uv); }\`,
    [sources.source.at(t)],
  ),
};
`);

/* ---------------- 项目 ---------------- */

/** kind: 'card' 走素材效果卡节点;'clip' 走时间轴视频片段 */
const CASES = [
  { name: '①素材效果卡 rate 0.5 offset 0', kind: 'card', media: src30, rate: 0.5, offset: 0 },
  { name: '①素材效果卡 rate 0.5 offset 0.35', kind: 'card', media: src30, rate: 0.5, offset: 0.35 },
  { name: '②素材效果卡 rate 1 offset 0', kind: 'card', media: src30, rate: 1, offset: 0 },
  { name: '③时间轴片段 mediaOffset 0', kind: 'clip', media: src30, rate: 1, offset: 0 },
  { name: '③时间轴片段 mediaOffset 0.35', kind: 'clip', media: src30, rate: 1, offset: 0.35 },
  { name: '④素材效果卡 25 fps 素材 rate 1', kind: 'card', media: src25, rate: 1, offset: 0 },
  { name: '④时间轴片段 25 fps 素材', kind: 'clip', media: src25, rate: 1, offset: 0 },
];

const cardNodes = [
  { id: 'src30', adapter: 'media', media: src30, inputs: {} },
  { id: 'src25', adapter: 'media', media: src25, inputs: {} },
];
const tracks = [];
CASES.forEach((c, i) => {
  const start = (i * SEG) / FPS, end = ((i + 1) * SEG) / FPS;
  c.start = start;
  const clipId = `case-${i}`;
  if (c.kind === 'card') {
    const nodeId = `pass-${i}`;
    cardNodes.push({ id: nodeId, adapter: 'card', cardId: CARD_ID, kind: 'filter', params: {},
      inputs: { source: { nodeId: c.media === src30 ? 'src30' : 'src25', offset: c.offset, rate: c.rate } } });
    tracks.push({ id: `tr-${i}`, name: `tr-${i}`, hidden: false, clips: [{ id: clipId, kind: 'card', cardId: CARD_ID, nodeId, start, end, params: {} }] });
  } else {
    tracks.push({ id: `tr-${i}`, name: `tr-${i}`, hidden: false, clips: [{ id: clipId, cardId: '', mediaId: c.media.id, mediaOffset: c.offset, start, end, volume: 0 }] });
  }
});
const PROJECT = {
  id: `cadence-${RUN}`, name: '视频取帧节奏探针', width: W, height: H, fps: FPS, duration: (CASES.length * SEG) / FPS,
  themeId: 'dark', camera3dFov: 50, media: [src30, src25], filters: [], pixelMaps: [], audioFx: [], cardNodes, style: {}, tracks,
};
fs.writeFileSync(path.join(OUT_DIR, 'project.json'), JSON.stringify(PROJECT));

/* ---------------- 导出 ---------------- */

const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1' };
let server = null;
try {
  server = await startDevServer({ env, port: PORT, logFile: path.join(WORK, 'vite.log'), log });
  log(`dev server ${server.origin}(舞台 ${server.stagePorts.join(' / ')})`);
  Object.assign(process.env, env);
  const url = `${server.origin}/?export=1&timeline=/@export/${EXPORT_ID}/project.json`;
  const t0 = Date.now();
  await exportFrames({ url, out: OUT_DIR, noVideo: true, workers: 1 });
  out.exportMs = Date.now() - t0;
  if (server.restarts()) fails.push(`导出期间 dev server 重启了 ${server.restarts()} 次`);

  /* ---------------- 读帧、还原源帧号 ---------------- */

  const framesDir = path.join(OUT_DIR, 'frames');
  const level = (frame) => {
    const file = path.join(framesDir, `${String(frame).padStart(6, '0')}.png`);
    if (!fs.existsSync(file)) return null;
    const png = PNG.sync.read(fs.readFileSync(file));
    let sum = 0, count = 0;
    for (let y = (png.height >> 1) - 8; y < (png.height >> 1) + 8; y++) {
      for (let x = (png.width >> 1) - 8; x < (png.width >> 1) + 8; x++) {
        const i = (png.width * y + x) << 2;
        sum += png.data[i] + png.data[i + 1] + png.data[i + 2]; count += 3;
      }
    }
    const mean = sum / count;
    return { mean, level: ((Math.round(mean / 16) % 16) + 16) % 16, off: Math.abs(mean - 16 * Math.round(mean / 16)) };
  };
  out.cases = [];
  CASES.forEach((c, i) => {
    const want = Array.from({ length: SEG }, (_, n) => Math.floor((c.offset + (c.rate * n) / FPS) * c.media.fps + 1e-6));
    const got = [];
    let prev = null, maxOff = 0, missing = 0;
    for (let n = 0; n < SEG; n++) {
      const l = level(i * SEG + n);
      if (!l) { missing++; got.push(null); continue; }
      maxOff = Math.max(maxOff, l.off);
      let m;
      if (prev === null) m = l.level + 16 * Math.round((want[0] - l.level) / 16); // 第一帧:取最接近期望的那一圈
      else m = prev + ((l.level - (prev % 16) + 16) % 16);                       // 之后:单调不减,每步 < 16
      got.push(m); prev = m;
    }
    const bad = want.map((w, n) => (got[n] === w ? null : { n, got: got[n], want: w })).filter(Boolean);
    out.cases.push({ name: c.name, start: c.start, maxLevelError: +maxOff.toFixed(2), missing, got: got.join(','), want: want.join(','), bad: bad.length });
    if (missing) fails.push(`${c.name}:缺 ${missing} 帧`);
    if (maxOff > 6) fails.push(`${c.name}:灰度离 16 的倍数太远(${maxOff.toFixed(1)}),读数不可信`);
    if (bad.length) fails.push(`${c.name}:${bad.length} 帧源帧号不符,前几处 ${JSON.stringify(bad.slice(0, 6))}`);
  });
} catch (e) {
  fails.push('异常:' + (e?.stack || e?.message || String(e)));
} finally {
  server?.stop();
  if (!KEEP) {
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { log(`临时目录没删掉:${e.message}`); }
  } else log(`留下临时目录 ${WORK}`);
}

out.fails = fails;
out.ok = fails.length === 0;
for (const c of out.cases ?? []) log(`${c.bad ? '✗' : '✓'} ${c.name}\n    got  ${c.got}\n    want ${c.want}`);
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
