/**
 * 云端 Agent 的测响度(`measure_audio`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4b 节)。
 *
 * 桌面版里 ffmpeg 直接拿本机素材服务上的地址当输入。云节点上不让 ffmpeg 自己出网:
 *
 *   「测谁」在项目副本上算(`src/mcp/common.ts` 的 `measureAudioRequest`,与桌面版同一份;只认本项目素材表里的素材)
 *     → 凭成员本人的**只读**素材票据把要测的素材取到这个对话的工作目录(`measure/` 下,取完核对内容哈希)
 *     → 用工作区的受限子进程起 ffprobe / ffmpeg 量(`server/audio-loudness.mjs`,与桌面版同一份参数与解析)
 *     → 量完删掉取来的文件。
 *
 * 子进程:工作目录是对话目录、环境变量按白名单重建、不弹窗口(`workspace.mjs` 的 `spawn`);起出来的是一棵杀得掉的进程树
 * (`perception/runner.mjs`),超时杀的是整棵树(`audio-loudness.mjs` 里的 `child.kill()` 与工作区自带的超时都是);每个输入前加
 * `-protocol_whitelist file`——素材是成员传的,伪装成媒体的播放列表不能让 ffmpeg 去连网络地址。
 * 整个进程里同时只跑一个测量(`slot`)。只读成员也能测(只读不写)。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { measureLoudness } from '../../audio-loudness.mjs';
import { ffprobeText } from '../../audio-source.mjs';

export const HOSTED_AUDIO_DEFAULTS = Object.freeze({
  /** 一次测量取来的素材合计上限 */
  maxFetchBytes: 1024 * 1024 * 1024,
  /** 取一份素材的时限 */
  fetchMs: 40_000,
  /** ffmpeg 的时限 */
  measureMs: 50_000,
  /** 时间轴档最多多少段 */
  maxEntries: 200,
});

/** 找 ffmpeg 与同目录的 ffprobe(`PROMPTCUT_FFMPEG` 或 PATH 上);找不到回 null。结果按进程缓存 */
let toolsCache;
export function findAudioTools(env = process.env) {
  if (toolsCache !== undefined) return toolsCache;
  toolsCache = null;
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const cand of [env.PROMPTCUT_FFMPEG, 'ffmpeg'].filter(Boolean)) {
    try {
      const r = spawnSync(cand, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status !== 0 || r.error) continue;
      const probeCands = [env.PROMPTCUT_FFPROBE, path.isAbsolute(cand) ? path.join(path.dirname(cand), `ffprobe${exe}`) : 'ffprobe'].filter(Boolean);
      for (const p of probeCands) {
        const pr = spawnSync(p, ['-version'], { timeout: 5000, windowsHide: true });
        if (pr.status === 0 && !pr.error) { toolsCache = { ffmpeg: cand, ffprobe: p }; return toolsCache; }
      }
    } catch { /* 下一个 */ }
  }
  return toolsCache;
}
export function _resetAudioTools() { toolsCache = undefined; }

/** 每个输入(`-i`)前加 `-protocol_whitelist file`:ffmpeg 只读本地文件 */
export function localOnlyArgs(args) {
  const out = [];
  for (const a of args) {
    if (a === '-i') out.push('-protocol_whitelist', 'file');
    out.push(a);
  }
  return out;
}

const HASH_URL = /^\/@media\/([a-f0-9]{64})(?:[/?#.]|$)/;

/**
 * @param {object} d
 * @param {() => object} d.workspace 这个对话的工作区
 * @param {() => Promise<object>} d.host `ssr-host.mjs`
 * @param {(apply: (host: object) => any) => Promise<any>} d.read 在放好项目副本的 store 上执行(只读)
 * @param {(hash: string, onChunk: (chunk: Buffer) => void, o: { maxBytes: number, timeoutMs: number }) => Promise<{ status: number }>} d.fetchAsset
 *   凭成员本人的只读素材票据按哈希取一份素材
 * @param {{ acquire(signal?: AbortSignal): Promise<() => void> }} d.slot 进程级的测量名额
 * @param {() => ({ ffmpeg: string, ffprobe: string } | null)} [d.tools]
 */
export function createAudioTools({ workspace, host, read, fetchAsset, slot, tools = findAudioTools, limits: limitsIn = {}, ToolError = Error }) {
  const limits = { ...HOSTED_AUDIO_DEFAULTS, ...limitsIn };

  async function measureAudio(args) {
    const bins = tools();
    if (!bins) throw new ToolError('这台云节点没有装 ffmpeg / ffprobe,云端 Agent 测不了响度。请告诉用户联系托管方,或在电脑上的 PromptCut 里测。', { code: 'no-ffmpeg' });
    const h = await host();
    let req = null;
    await read((hh) => { req = hh.audio.measureRequest(args ?? {}); return { ok: true }; });
    if (!req.body) return req.empty;
    const entries = req.scope === 'timeline' ? req.body.entries : [{ media: req.body.media }];
    if (entries.length > limits.maxEntries) throw new ToolError(`时间轴上出声的片段超过 ${limits.maxEntries} 段,云端一次量不了这么多;请按片段(clipId)分开量。`);

    const ws = workspace();
    const release = await slot.acquire();
    /** 素材哈希 → 工作区里的相对路径(同一份素材只取一次) */
    const fetched = new Map();
    let budget = limits.maxFetchBytes;
    const spawnIn = (cmd, a, o = {}) => ws.spawn(cmd, localOnlyArgs(a), { stdio: o.stdio, timeoutMs: limits.measureMs + 5000 });
    try {
      const resolveSource = async (m) => {
        const hash = HASH_URL.exec(String(m?.url ?? ''))?.[1];
        if (!hash) return null;
        if (fetched.has(hash)) return fetched.get(hash);
        const rel = `measure/${hash}`;
        const writer = ws.writer(rel);
        const digest = createHash('sha256');
        let size = 0;
        let res;
        try {
          res = await fetchAsset(hash, (chunk) => {
            size += chunk.length;
            if (size > budget) throw new ToolError('要测的素材太大了,云端一次量不了;请只量其中一段(clipId)。', { code: 'too-large' });
            digest.update(chunk);
            writer.write(chunk);
          }, { maxBytes: budget, timeoutMs: limits.fetchMs });
        } catch (err) {
          writer.abort();
          throw err;
        }
        if (res.status === 404) { writer.abort(); fetched.set(hash, null); return null; }
        if (res.status < 200 || res.status >= 300) {
          writer.abort();
          throw new ToolError(`素材服务拒绝了读取(HTTP ${res.status})。`, { code: res.status === 401 || res.status === 403 ? 'forbidden' : 'asset-error' });
        }
        writer.end();
        if (digest.digest('hex') !== hash) { ws.remove(rel); throw new ToolError('取回的素材与它的内容哈希不符,没有量。'); }
        budget -= size;
        const abs = ws.resolve(rel);
        fetched.set(hash, abs);
        return abs;
      };
      const out = await measureLoudness({
        body: req.body,
        resolveSource,
        ffmpeg: bins.ffmpeg,
        ffprobe: bins.ffprobe,
        timeoutMs: limits.measureMs,
        spawnImpl: spawnIn,
        hasAudio: async (src, ffprobe) => {
          const text = await ffprobeText(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', '-i', src], { spawnImpl: spawnIn });
          return !!text && text.trim().length > 0;
        },
      });
      if (out.status !== 200 || out.body?.ok === false) {
        // 报错里不带工作目录的磁盘路径
        const root = ws.dir();
        throw new ToolError(String(out.body?.error ?? `测响度失败(${out.status})`).split(root).join('<工作目录>').slice(0, 400));
      }
      return h.audio.measureFinish(req, out.body);
    } finally {
      release();
      for (const hash of fetched.keys()) { try { ws.remove(`measure/${hash}`); } catch { /* 留给对话删除时清 */ } }
    }
  }

  return { measure_audio: measureAudio };
}
