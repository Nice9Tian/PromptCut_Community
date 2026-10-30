/**
 * 仅供测试，生产代码不得引用。
 *
 * C10a 契约测试（`server/test/c10a-*.test.mjs`、`src/**\/c10a-*.test.mjs`、`scripts/probes/c10a-*.mjs`）的公共件。
 * 依据只有 `docs/plan/c10a-contract.md`（第 2、5、8、9、11.1、12 节）与它引的 `docs/plan/auth-contract.md`；
 * 测试方没看实现（`claude/c10a-web`、`claude/c10a-lowmem`）。
 *
 * 契约没写死的模块路径、函数名、参数与回包形状全部集中在本文件，集成时对账只改这里。
 * 每一处假设用「假设 K<n>」标出，报告 `docs/archive/agent-reports/AGENT-c10a-tests.md` 按同样的编号列出。
 *
 * # 实现不在时怎么办
 *
 * 每组用例开头调本文件的 `*Support()` 探测接口在不在：不在就把这组用例标成 `node:test` 的 skip，
 * 原因写「接口缺失：…」。探测只看「实现有没有」，不看「实现对不对」：接口一旦出现，用例就真跑，
 * 名字或形状和假设对不上会直接失败（由集成方改本文件对账），不会被静默跳过。
 * 所以集成前 `npm test` 的跳过数会多出这些；集成后必须回到只跳过需要 5190 的那 1 条。
 *
 *   K1  邀请码（契约第 5 节）：挂在现有的共享项目 HTTP 端点旁边，独立模式 `shared/invite/resolve`、
 *       `shared/invite/redeem`，挂载模式 `<WS 路径>/shared/invite/…`；服务端就是 `auth-kit.mjs` 组装的那一套
 *       （`createSharedDocService`），不另起入口。
 *       - 探测：对随机邀请码 `POST shared/invite/resolve`，回 404 `{ error: 'invite-invalid' }` 算实现在；
 *         现在的实现对不认识的 `shared/…` 路径回 404 `not-found`，据此判为缺失。
 *       - `shared.admin` 的 `invite-create` / `invite-revoke` / `invite-status` 回包字段平铺在
 *         `shared.admin.ok` 上（与 C6.5 的 `list-bans` 回 `bans` 同一做法）；`invite-status` 也接受包在 `status` 里。
 *       - `expiresAt`、`revokedAt` 是毫秒时间戳（同 auth 契约第 8 节票据的 `exp`）。
 *       - 签发、过期按文档服务注入的时钟（`auth-kit.mjs` 的 `testClock`）算。
 *   K2  旧档位的判定（契约第 8 节）：2026-10-07 用户定撤销，2026-10-22（`claude/online-browser`）连同它的用例删掉，见下文「K2 / K3 档位」。
 *   K3  能力闸（契约第 8 节）：`src/render/mediaTier.ts` 的「只用小尺寸」分支（现名 `opts.smallOnly`，最低一档）与 `src/editor/stageSwap.ts`
 *       的单舞台闸（现名 `SwapHost.singleStage()`）。探测：`src/online/onlineTier.ts` 存在。
 *   K4  预渲染小尺寸（契约第 9 节）：
 *       - 尺寸规则是一个纯函数 `(width, height) → { width, height }`，在 `SMALL_SIZE_FILES` 之一里，名字取
 *         `SMALL_SIZE_NAMES` 之一；探测：找得到这个函数。
 *       - 快照清单（C6.2 的 `SnapshotResult`）另带 `small: [[帧, 哈希, 字节数], …]`，块是 WebP，推到 `px`
 *         （`client.put('px', bytes, { ext: 'webp' })`）；`pushResult` 两档都推成功才返回，任何一块失败就抛。
 *       - 就绪索引（`server/ready-index.mjs`）的小尺寸是单独的 `kind`（`READY_KINDS` 里名字含 `small` 的那个），
 *         与 `html` 层互不覆盖。
 *   K5  MP4 封装器（契约第 11 节〔裁〕）：`src/export/` 下某个 `.ts` 导出类或工厂，名字取 `MUXER_NAMES` 之一；
 *       构造参数 `{ video: { codec: 'avc', width, height, frameRate }, audio?: { codec: 'aac', sampleRate, numberOfChannels }, fastStart? }`；
 *       方法 `addVideoChunk(chunk, meta?)`、`addAudioChunk(chunk, meta?)`、`finalize()`。`chunk` 是 WebCodecs 的
 *       `EncodedVideoChunk` / `EncodedAudioChunk` 形状（`type`、`timestamp`/`duration` 微秒、`byteLength`、`copyTo`），
 *       `meta.decoderConfig.description` 是 avcC / AudioSpecificConfig。产物取 `finalize()` 的返回值
 *       （Uint8Array / ArrayBuffer / Blob），没有就取 `muxer.target.buffer`。
 *   K6  `/api` 守卫（契约第 2 节）：`src/online/` 下某个 `.ts` 导出名字含 `guard`（不分大小写）的函数，调用后
 *       在 `ONLINE` 时让 `fetch('/api/…')` 抛错（同步抛或 reject 都算），别的地址照常转给原来的 `fetch`；
 *       `ONLINE` 为 false 时不拦。
 *       在线构建的静态检查：产物里以 `/api/` 开头、后面紧跟地址的字面量（`apiLiterals`）为 0；守卫判前缀用的 `"/api/"` 不算。
 *   K7  单舞台（契约第 8.1 节）：仍由 `src/editor/previewMode.ts` 定开几个舞台；2026-10-22 起由舞台闸门的档位定（停在第一级只开跨源 A），
 *       `stageSrc('A')` 一律跨源、带 `preview=stage`。探测：`src/online/onlineTier.ts` 存在。
 *
 * # 集成对账（`claude/c10a-integ`，2026-09-27；逐条理由见 `docs/archive/agent-reports/AGENT-c10a-integ.md`）
 *
 *   K1  与实现一致，未改。
 *   K2  （已删，见上）
 *   K3  `mediaTier` 的「只用小尺寸」分支与 `stageSwap` 的单舞台闸，见 `singleStageSwapHost`（2026-10-22 改名）。
 *   K4  尺寸规则 `server/bakery/small-bitmap.mjs` 的 `smallSize({ projectWidth, projectHeight })`；清单 `small`、推 `px`
 *       与假设一致；就绪索引不收小尺寸，两档分开记在清单里（导出前核对 `src/export/originals.ts` 只认 `frames`）。
 *   K5  `src/export/mp4Mux.ts` 的 `Mp4Muxer` + `MemorySink`，构造时就要解码配置；见 `muxerAdapter`。
 *   K6  `src/online/apiGuard.ts` 的 `bootApiGuard(online)`；静态检查改棘轮（`ONLINE_API_RATCHET_FILE`）。
 *   K7  与实现一致，未改。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));

/** `node:test` 的 skip 选项：接口在就是 false（真跑），不在就是「接口缺失：…」 */
export const skipIf = (missing, what) => (missing ? `接口缺失：${what}（C10a 实现未集成，集成后自动转为真跑）` : false);

export function tempDir(prefix = 'pc-c10a-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ================================================================== K1 邀请码

/** 契约第 5 节：32 字节随机数的 base64url，不带填充，43 个字符 */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
export const newInviteCode = () => randomBytes(32).toString('base64url');
export const INVITE_DEFAULT_TTL_MS = 604_800 * 1000;

let inviteProbe = null;
/**
 * 探测邀请码端点在不在（K1）。起一台临时的托管端文档服务问一次，回 `{ ok, detail }`。
 * 依赖 `auth-kit.mjs`（它本身要能起服务）；起不来就当缺失并把原因带出来。
 */
export function inviteSupport() {
  inviteProbe ??= (async () => {
    const { startHost } = await import('./auth-kit.mjs');
    let env = null;
    try {
      env = await startHost();
      const r = await env.http('shared/invite/resolve', { method: 'POST', body: { code: newInviteCode() } });
      const ok = r.status === 404 && r.json?.error === 'invite-invalid';
      return { ok, detail: ok ? '' : `POST shared/invite/resolve 回 ${r.status} ${r.text.slice(0, 120)}` };
    } catch (err) {
      return { ok: false, detail: `起托管端失败：${err?.message ?? err}` };
    } finally {
      await env?.close();
    }
  })();
  return inviteProbe;
}

export function resolveInvite(env, code, { remote } = {}) {
  return env.http('shared/invite/resolve', { method: 'POST', body: { code }, remote });
}

export function redeemInvite(env, { code, username, deviceId }, { remote } = {}) {
  return env.http('shared/invite/redeem', { method: 'POST', body: { code, username, deviceId }, remote });
}

/** `invite-status` 的回包：字段平铺，或包在 `status` 里（K1） */
export function inviteStatusOf(reply) {
  assert.equal(reply?.type, 'shared.admin.ok', `invite-status 应 shared.admin.ok：${JSON.stringify(reply)}`);
  return reply.status && typeof reply.status === 'object' ? reply.status : reply;
}

/** 目录下所有文件的全文（二进制按 latin1 读），用来查「原文不落盘」 */
export function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        if (buf.includes(Buffer.from(needle, 'utf8'))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

// ================================================================== K2 / K3 档位(旧档位判定 2026-10-07 撤销)

/**
 * 2026-10-22(`claude/online-browser`):旧档位撤销(`docs/semantics/product/platforms.md`「在线浏览器」),原来的 K2 判定
 * (原来的判定模块与设备设置「显示档」)整个删掉,测它的两份用例文件一并删除。
 * 这一档管的事拆到三处:只有一个舞台(舞台闸门第一级,`src/online/onlineTier.ts`)、最低一档(取档策略的 `smallOnly`)、身份为手机。
 * 下面的探测与桩改认 `onlineTier.ts`。
 */
export const TIER_FILE = 'src/online/onlineTier.ts';

/**
 * K3(集成对账后,2026-10-22 改名):`stageSwap.ts` 的单舞台闸在 `SwapHost.singleStage()` 上(`Preview.tsx` 按此刻挂着几个舞台给)。
 * 用例的 `setSwapHost` 经这里补上 `singleStage`。
 */
export function singleStageSwapHost(host, single = true) {
  return { ...host, singleStage: () => single };
}

// ================================================================== K4 预渲染小尺寸

/**
 * 集成对账后（K4）：尺寸规则是 `server/bakery/small-bitmap.mjs` 的 `smallSize({ projectWidth, projectHeight, boxWidth?, boxHeight? })`，
 * 回 `{ width, height }`。小位图画的是包裹层的框，框按同一个缩放比缩；不给框就是整幅，正是契约第 9 节的「项目画幅」。
 */
export const SMALL_SIZE_FILE = 'server/bakery/small-bitmap.mjs';
export const SMALL_SIZE_NAME = 'smallSize';

/** 找尺寸规则函数（K4）；回 `{ fn: (w, h) => size, file, name }`，导出了却载不进来回 `{ file, error }`，没有回 null */
export async function findSmallSize() {
  if (!exists(SMALL_SIZE_FILE)) return null;
  const src = fs.readFileSync(repoPath(SMALL_SIZE_FILE), 'utf8');
  let mod;
  try { mod = await import(repoUrl(SMALL_SIZE_FILE)); } catch (err) {
    // 文本里导出了这个名字却载不进来：不当「缺失」静默跳过，交给用例报错
    if (exportsName(src, SMALL_SIZE_NAME)) return { file: SMALL_SIZE_FILE, error: err };
    return null;
  }
  const f = mod[SMALL_SIZE_NAME];
  if (typeof f !== 'function') return null;
  return { fn: (w, h) => f({ projectWidth: w, projectHeight: h }), file: SMALL_SIZE_FILE, name: SMALL_SIZE_NAME };
}

/** 集成对账后（K4）：导出前核对与取用预渲染原尺寸的模块；它只认清单的 `frames`，`small` 不算 */
export const ORIGINALS_FILE = 'src/export/originals.ts';

/** 源码文本里有没有 `export … <name>`（粗筛：function / const / class / export { … }） */
export function exportsName(src, name) {
  const re = new RegExp(String.raw`export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+${name}\b|export\s*\{[^}]*\b${name}\b`);
  return re.test(src);
}

/** 尺寸函数可能回 `{ width, height }` 或 `[w, h]` */
export function sizeOf(r) {
  if (Array.isArray(r)) return { width: r[0], height: r[1] };
  return { width: r?.width ?? r?.w, height: r?.height ?? r?.h };
}

// ================================================================== K5 MP4 封装器

/**
 * 集成对账后（K5）：`src/export/mp4Mux.ts` 的 `Mp4Muxer` 与 `MemorySink`。实现的形状与用例假设的不同：
 * - 构造时就要 `{ video: { codec: 'avc1.…', width, height, fps, avcC }, audio?: { codec: 'mp4a.40.2', sampleRate, channels, asc }, sink }`，
 *   而 avcC / AudioSpecificConfig 要等第一个块的 `meta.decoderConfig.description` 才有；
 * - `addVideoChunk(bytes, { timestampUs, key })`、`addAudioChunk(bytes, { timestampUs, durationUs })` 收拷出来的字节；
 * - `finalize()` 回字节数，产物在 `MemorySink.bytes()`。
 * 下面的适配器照 `browserExport.ts` 的做法：先攒块，等要的解码配置都到了再建封装器、按到达顺序补进去。
 */
export const MUXER_FILE = 'src/export/mp4Mux.ts';
export const MUXER_NAMES = ['Mp4Muxer'];

const chunkBytes = (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); return b; };

function muxerAdapter(mod, opts) {
  const wantAudio = !!opts.audio;
  const sink = new mod.MemorySink();
  let real = null;
  let video = null;
  let audio = null;
  const pending = [];
  const feed = (e) => (e.kind === 'v'
    ? real.addVideoChunk(e.data, { timestampUs: e.timestampUs, key: e.key })
    : real.addAudioChunk(e.data, { timestampUs: e.timestampUs, durationUs: e.durationUs }));
  const push = (e) => {
    if (!real && video && (!wantAudio || audio)) {
      real = new mod.Mp4Muxer({ video, audio, sink });
      for (const p of pending.splice(0)) feed(p);
    }
    if (real) feed(e); else pending.push(e);
  };
  return {
    target: sink,
    addVideoChunk(chunk, meta) {
      const d = meta?.decoderConfig;
      if (d?.description && !video) video = { codec: d.codec, width: d.codedWidth ?? opts.video.width, height: d.codedHeight ?? opts.video.height, fps: opts.video.frameRate, avcC: new Uint8Array(d.description) };
      push({ kind: 'v', data: chunkBytes(chunk), timestampUs: chunk.timestamp, key: chunk.type === 'key' });
    },
    addAudioChunk(chunk, meta) {
      const d = meta?.decoderConfig;
      if (d?.description && !audio) audio = { codec: d.codec, sampleRate: d.sampleRate ?? opts.audio.sampleRate, channels: d.numberOfChannels ?? opts.audio.numberOfChannels, asc: new Uint8Array(d.description) };
      push({ kind: 'a', data: chunkBytes(chunk), timestampUs: chunk.timestamp, durationUs: chunk.duration });
    },
    async finalize() {
      assert.ok(real, `封装器没建起来：视频解码配置 ${video ? '有' : '没有'}，音频 ${wantAudio ? (audio ? '有' : '没有') : '不要'}`);
      await real.finalize();
      return sink.bytes();
    },
  };
}

/** 找封装器（K5）；回 `{ make, file, name }`，导出了却载不进来回 `{ file, error }`，没有回 null */
export async function findMuxer() {
  if (!exists(MUXER_FILE)) return null;
  const src = fs.readFileSync(repoPath(MUXER_FILE), 'utf8');
  let mod;
  try { mod = await import(repoUrl(MUXER_FILE)); } catch (err) {
    if (exportsName(src, 'Mp4Muxer')) return { file: MUXER_FILE, error: err };
    return null;
  }
  if (typeof mod.Mp4Muxer !== 'function' || typeof mod.MemorySink !== 'function') return null;
  return { file: MUXER_FILE, name: 'Mp4Muxer', make: (opts) => muxerAdapter(mod, opts) };
}

/** 封装器的产物字节（K5） */
export async function muxerBytes(muxer, finalized) {
  let out = await finalized;
  if (out === undefined || out === null) out = muxer?.target?.buffer ?? muxer?.buffer ?? muxer?.bytes;
  if (out && typeof out.arrayBuffer === 'function') out = await out.arrayBuffer();
  if (out instanceof ArrayBuffer) return Buffer.from(out);
  if (ArrayBuffer.isView(out)) return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  assert.fail(`封装器 finalize() 没交出字节：${Object.prototype.toString.call(out)}`);
}

/** WebCodecs 的 EncodedVideoChunk / EncodedAudioChunk 形状 */
export function fakeChunk({ type, timestamp, duration, data }) {
  const bytes = new Uint8Array(data);
  return {
    type, timestamp, duration, byteLength: bytes.byteLength,
    copyTo(dest) {
      const view = dest instanceof ArrayBuffer ? new Uint8Array(dest) : new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);
      view.set(bytes);
    },
  };
}

// ---- 样本：ffmpeg 现场出 H.264 Annex B / AAC ADTS，测试自己拆成 WebCodecs 的块

export function findFfmpegSync() {
  for (const cmd of ['ffmpeg']) {
    const r = spawnSync(cmd, ['-version'], { windowsHide: true });
    if (r.status === 0) return cmd;
  }
  return null;
}
export const ffprobeOf = (ffmpeg) => ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

export function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0) resolve({ out: buf.toString('utf8'), buf, err });
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} 退出码 ${code}：${err.slice(-800)}`));
    });
  });
}

/** Annex B 拆 NAL（去掉起始码） */
export function splitAnnexB(buf) {
  const nals = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= buf.length) {
    const sc3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    const sc4 = i + 4 <= buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) nals.push(buf.subarray(start, i));
      i += sc4 ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0) nals.push(buf.subarray(start));
  // 去掉 NAL 末尾的 0（下一个起始码的前导 0）
  return nals.map((n) => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); }).filter((n) => n.length);
}

/**
 * H.264 Annex B → `{ avcC, samples: [{ key, data(AVCC 长度前缀) }] }`。
 * 要求一帧一个 slice、没有 B 帧（ffmpeg 出样本时保证）；SPS/PPS 只进 avcC，不进样本（WebCodecs `avc` 格式）。
 */
export function annexBToAvcc(buf) {
  const nals = splitAnnexB(buf);
  let sps = null, pps = null;
  const samples = [];
  let cur = [];
  let key = false;
  for (const nal of nals) {
    const t = nal[0] & 0x1f;
    if (t === 7) { sps ??= nal; continue; }
    if (t === 8) { pps ??= nal; continue; }
    if (t === 9) continue; // AUD
    cur.push(nal);
    if (t === 5) key = true;
    if (t === 1 || t === 5) {
      const len = cur.reduce((s, n) => s + 4 + n.length, 0);
      const data = Buffer.alloc(len);
      let o = 0;
      for (const n of cur) { data.writeUInt32BE(n.length, o); n.copy(data, o + 4); o += 4 + n.length; }
      samples.push({ key, data });
      cur = [];
      key = false;
    }
  }
  assert.ok(sps && pps, 'H.264 样本里没有 SPS / PPS');
  const avcC = Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]), pps,
  ]);
  const codec = `avc1.${[sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { avcC, codec, samples };
}

/** AAC ADTS → `{ asc, sampleRate, channels, frames: [Buffer] }`（去掉 ADTS 头） */
export function adtsToRaw(buf) {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const frames = [];
  let i = 0;
  let profile = 1, srIdx = 4, ch = 2;
  while (i + 7 <= buf.length) {
    assert.ok(buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0, `ADTS 同步字不对（偏移 ${i}）`);
    const protectionAbsent = buf[i + 1] & 1;
    profile = (buf[i + 2] >> 6) + 1;
    srIdx = (buf[i + 2] >> 2) & 0xf;
    ch = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
    const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    const head = protectionAbsent ? 7 : 9;
    frames.push(buf.subarray(i + head, i + len));
    i += len;
  }
  const asc = Buffer.from([(profile << 3) | (srIdx >> 1), ((srIdx & 1) << 7) | (ch << 3)]);
  return { asc, sampleRate: RATES[srIdx], channels: ch, frames };
}

// ================================================================== K6 `/api` 守卫

/**
 * 集成对账后（K6）：守卫在 `src/online/apiGuard.ts`。`installApiGuard()` 本身不看模式（调了就装）；
 * 「只在 `ONLINE` 时装」的规则是 `bootApiGuard(online, options)`，`boot.ts` 按 `ONLINE` 调它。
 * 这里照 `boot.ts` 的做法把这个进程里 `mode.ts` 的 `ONLINE`（用例已换成桩）传进去。
 */
// 2026-10-28:这个常量没跟着搬迁改,而 apiGuard.ts 已经搬到 cloud/online/ 了。
// 后果不是报错而是**静默 skip**:findApiGuard() 回 null → skipIf 为真 → C10A-API-05/06
// 从「真跑」变成「跳过」,而 skip 不计失败,所以「与基线逐条对账零回归」完全照不出来。
// 这是那次对账方法本身的一个洞:数字对得上不等于覆盖面没缩。
export const API_GUARD_FILE = 'cloud/online/apiGuard.ts';

/** 找守卫（K6）；回 `{ fn, file, name }` 或 null */
export async function findApiGuard(importer) {
  if (!exists(API_GUARD_FILE)) return null;
  const mod = await importer(API_GUARD_FILE);
  if (typeof mod.bootApiGuard !== 'function') return null;
  const { ONLINE } = await importer('src/online/mode.ts');
  return { fn: () => mod.bootApiGuard(ONLINE), file: API_GUARD_FILE, name: 'bootApiGuard' };
}

/** 目录下所有文件（递归） */
export const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/**
 * 在线构建的 `/api/` 路径棘轮〔裁，主会话 2026-09-27〕：集成时产物里已有的 `/api/` 路径记在这份清单里，
 * C10A-API-03 断言「产物里的 `/api/` 路径 ⊆ 清单」，新出现的判红。逐个置灰或换在线替代归 C10 其余，做掉一个就从清单删一个。
 * 运行时守卫加网络记录里 0 个 `/api/` 请求照旧是验收（探针）。
 */
export const ONLINE_API_RATCHET_FILE = 'server/test/c10a-online-api-paths.json';

/** 产物里 `/api/` 字面量归一成路径（取到第一个不是路径字符的地方：模板的 `${`、引号、查询串都截断）；回去重排序后的数组 */
export function apiPaths(dir) {
  const out = new Set();
  for (const file of walkFiles(dir)) {
    if (!/\.(m?js|html)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    // 与 `apiLiterals` 同一个口径（引号或反引号后紧跟 `/api/` 再紧跟地址字符），只多取出路径
    for (const m of text.matchAll(/["'`](\/api\/[A-Za-z0-9_$][A-Za-z0-9_\-./]*)/g)) out.add(m[1].replace(/\$.*$/, ''));
  }
  return [...out].sort();
}

/**
 * 构建产物里以 `/api/` 开头、后面紧跟地址的字面量（引号或反引号起头）；回 [{ file, at, context }]。
 * 守卫判前缀用的 `"/api/"`（引号紧跟在斜杠后）不算。
 */
export function apiLiterals(dir) {
  const hits = [];
  for (const file of walkFiles(dir)) {
    if (!/\.(m?js|html)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const re = /["'`]\/api\/[A-Za-z0-9_$]/g;
    let m;
    while ((m = re.exec(text))) hits.push({ file: path.relative(dir, file), at: m.index, context: text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ') });
  }
  return hits;
}
