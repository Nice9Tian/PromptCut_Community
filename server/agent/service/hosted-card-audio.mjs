/**
 * 云端 Agent 的卡片声音(`render_card_audio`、`cancel_card_audio`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4c 节)。
 *
 * **Agent 服务进程不执行卡片代码。** 卡片的 `audio()`(含用户卡)交给同机的渲染服务:与看画面同一条路(`POST /look`,
 * 服务私钥签名;带卡片源码的项目只由按项目隔离的工作进程碰),工作进程让渲染页求值、回一份 32 位浮点的 WAV 与它的身份记录。
 * 本模块只做:
 *
 *   确认成员写得进(只读成员在最前面被拒)→ 把此刻的项目副本与片段 id 交给渲染服务
 *     → 核对回来的 WAV 与记录的形状(渲染页跑过项目带来的代码,回来的东西只当数据,逐项核)
 *     → 凭成员本人的素材票据写进素材服务(`media`)→ 在项目副本上原子登记(`commitCardAudio`,与桌面版同一份)。
 *
 * 取消:掐掉在途的请求;已经回来的结果不上传、不提交。一位成员在一个项目里最多同时 4 个(与桌面版同一个数)。
 */

export const CARD_AUDIO_DEFAULTS = Object.freeze({
  /** 等渲染服务的时限(带用户卡的项目要等隔离工作进程起来) */
  renderMs: 150_000,
  /** 一份 WAV 的上限(与工作进程那一侧相同) */
  maxWavBytes: 32 * 1024 * 1024,
  /** 身份记录的上限(与桌面版相同) */
  maxIdentityBytes: 96 * 1024,
  pendingJobs: 4,
});

/** 一个实例(项目 × 成员)在途的卡片声音:片段 id → AbortController */
export const newCardAudioState = () => ({ pending: new Map() });

/** 「这次没看成:…」是给看画面的工具写的;卡片声音借同一条路,原因照用、开头换掉 */
const reword = (message) => `卡片声音这次没有生成:${String(message ?? '').replace(/^这次没看成[:：]\s*/, '')}`;

/**
 * 核对渲染服务回来的 WAV:RIFF / WAVE、32 位浮点、48000 Hz、声道数与帧数和记录对得上、长度一个字节不差。
 * @returns {string | null} 不对回原因
 */
export function checkCardAudioWav(wav, rendition) {
  if (!Buffer.isBuffer(wav) || wav.length < 45) return 'WAV 太短';
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE' || wav.toString('latin1', 12, 16) !== 'fmt ' || wav.toString('latin1', 36, 40) !== 'data') return '不是这条路该有的 WAV';
  const channels = wav.readUInt16LE(22);
  if (wav.readUInt16LE(20) !== 3 || wav.readUInt16LE(34) !== 32 || wav.readUInt32LE(24) !== 48000) return 'WAV 的格式不是 48000 Hz 的 32 位浮点';
  if (channels !== rendition.channels) return 'WAV 的声道数与记录不符';
  if (wav.length !== 44 + rendition.frames * channels * 4 || wav.readUInt32LE(40) !== wav.length - 44) return 'WAV 的长度与记录不符';
  return null;
}

/** 核对身份记录的形状;回收拾过的记录(只留该有的字段)或抛原因 */
export function checkRendition(r, clip, limits = CARD_AUDIO_DEFAULTS) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('渲染服务没有回声音的记录');
  if (r.version !== 1 || r.sampleRate !== 48000) throw new Error('声音记录的版本不对');
  if (typeof r.cardId !== 'string' || r.cardId !== (clip.cardId ?? '')) throw new Error('声音记录不是这张卡的');
  if (!Number.isSafeInteger(r.frames) || r.frames < 1 || r.frames > 60 * 48000) throw new Error('声音记录的长度不对');
  if (!Number.isInteger(r.channels) || r.channels < 1 || r.channels > 8) throw new Error('声音记录的声道数不对');
  if (!Number.isFinite(r.sourceOffset) || !Number.isFinite(r.duration) || Math.abs(r.duration - r.frames / 48000) > 1e-9) throw new Error('声音记录的时间不对');
  if (typeof r.sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(r.sourceKey)) throw new Error('声音记录的键不对');
  if (!r.identity || typeof r.identity !== 'object' || Array.isArray(r.identity)) throw new Error('声音记录没有身份');
  const identity = JSON.parse(JSON.stringify(r.identity));
  if (Buffer.byteLength(JSON.stringify(identity), 'utf8') > limits.maxIdentityBytes) throw new Error('卡片声音参数记录过大,请缩短片段或精简输入');
  return { version: 1, cardId: r.cardId, sourceKey: r.sourceKey, sourceOffset: r.sourceOffset, duration: r.duration, sampleRate: 48000, frames: r.frames, channels: r.channels, identity };
}

/**
 * @param {object} d
 * @param {ReturnType<typeof newCardAudioState>} d.state
 * @param {() => (null | ((path: string, body: object, opts?: object) => Promise<any>))} d.look 这个项目问渲染服务的函数;节点没配口子回 null
 * @param {() => Promise<{ project: object }>} d.snapshot
 * @param {() => Promise<any>} d.refreshCards 把这个项目的卡片源码表列到最新(渲染服务据它等隔离工作进程装到这一版)
 * @param {(track: object, apply: (host: object) => any) => Promise<any>} d.mutate
 * @param {() => Promise<void>} d.ensureCanWrite
 * @param {(wav: Buffer) => Promise<{ hash: string }>} d.put
 * @param {(hash: string) => Promise<boolean>} d.has 素材服务里有没有这份字节
 */
export function createCardAudioTools({ state, look, snapshot, refreshCards = async () => {}, mutate, ensureCanWrite, put, has, record = () => {}, ToolError = Error, limits: limitsIn = {} }) {
  const limits = { ...CARD_AUDIO_DEFAULTS, ...limitsIn };
  const fail = (error, cancelled = false) => ({ ok: false, code: cancelled ? 'CARD_AUDIO_CANCELLED' : 'CARD_AUDIO_FAILED', error: String(error).slice(0, 400) });

  async function render(args, track) {
    const clipId = typeof args?.clipId === 'string' ? args.clipId : '';
    if (!clipId) throw new ToolError('要传 clipId');
    const ask = look();
    if (!ask) {
      return { ok: false, cloudUnavailable: true, error: '云端 Agent 在这台节点上生成不了卡片声音:节点没有开渲染服务的口子(卡片的声音代码只在渲染服务的隔离进程里执行)。请告诉用户在电脑上的 PromptCut 里生成。' };
    }
    await ensureCanWrite();
    await refreshCards();
    const { project } = await snapshot();
    const clip = (project.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === clipId);
    if (!clip) return fail('找不到带内嵌声音的动效卡片');
    if (!state.pending.has(clipId) && state.pending.size >= limits.pendingJobs) return fail(`最多同时排队 ${limits.pendingJobs} 个卡片声音任务,请等待或取消已有任务`);
    state.pending.get(clipId)?.abort();
    const controller = new AbortController();
    state.pending.set(clipId, controller);
    const signal = controller.signal;
    const t0 = Date.now();
    let bytes = 0;
    let ok = false;
    try {
      let force = args.force === true;
      for (let round = 0; ; round += 1) {
        let data;
        try {
          data = await ask('/api/cards/audio', { project, clipId, force }, { timeoutMs: limits.renderMs, signal });
        } catch (err) {
          if (signal.aborted) return fail('已取消,原有的卡片声音保持不变', true);
          return fail(reword(err?.message ?? err));
        }
        if (signal.aborted) return fail('已取消,原有的卡片声音保持不变', true);
        if (!data || typeof data !== 'object' || data.ok !== true) return fail(typeof data?.error === 'string' && data.error ? data.error : '卡片声音没有生成');
        if (data.reusable && round === 0 && !force) {
          // 记录还对得上:素材服务里真有这份字节才算数(只认项目素材表里那一条的哈希,不认渲染页报的)
          const media = (project.media ?? []).find((m) => m.id === clip.cardAudio?.mediaId);
          if (media && /^[a-f0-9]{64}$/.test(media.hash ?? '') && await has(media.hash)) { ok = true; return { ok: true, clipId, mediaId: media.id, reused: true }; }
          force = true;
          continue;
        }
        if (typeof data.wav !== 'string' || data.wav.length > Math.ceil(limits.maxWavBytes / 3) * 4 + 8) return fail('渲染服务回来的声音太大或不完整');
        let rendition;
        try { rendition = checkRendition(data.rendition, clip, limits); } catch (err) { return fail(err.message); }
        const wav = Buffer.from(data.wav, 'base64');
        const bad = checkCardAudioWav(wav, rendition);
        if (bad) return fail(`渲染服务回来的声音不对:${bad}`);
        bytes = wav.length;
        const asset = await put(wav);
        if (signal.aborted) return fail('已取消,原有的卡片声音保持不变', true);
        if (!/^[a-f0-9]{64}$/.test(asset?.hash ?? '')) return fail('素材服务未返回有效内容哈希');
        const name = `${String(typeof data.name === 'string' && data.name ? data.name : `${clip.label || clip.cardId} · 卡片声音.wav`).replace(/[\0-\x1f]/g, ' ').slice(0, 200)}`;
        let result = null;
        try {
          await mutate(track, (h) => {
            if (signal.aborted || state.pending.get(clipId) !== controller) throw Object.assign(new Error('已取消,原有的卡片声音保持不变'), { cancelled: true });
            result = h.cardAudio.commit({
              projectId: project.id, cutId: project.activeCutId, clipId,
              // 提交时比的是**我们自己**在取副本那一刻看到的片段,不用渲染页报的那一份
              expectedClip: JSON.stringify(clip),
              media: { kind: 'audio', name, url: `/@media/${asset.hash}`, hash: asset.hash, ext: 'wav', size: wav.length, duration: rendition.frames / 48000 },
              rendition,
            });
            return { ok: true };
          });
        } catch (err) {
          return fail(err?.message ?? err, err?.cancelled === true);
        }
        ok = true;
        return { ok: true, ...result, reused: false };
      }
    } finally {
      if (state.pending.get(clipId) === controller) state.pending.delete(clipId);
      // 复用已有的那一份没有新算、也没有新写,不记
      if (bytes > 0 || !ok) try { record({ service: 'card-audio', vendor: 'render', model: clip.cardId ?? '', units: bytes, unit: 'bytes', ok, ms: Date.now() - t0 }); } catch { /* 记用量失败不影响结果 */ }
    }
  }

  return {
    render_card_audio: (args, track) => render(args ?? {}, track ?? {}),
    cancel_card_audio: async (args) => {
      const current = state.pending.get(String(args?.clipId ?? ''));
      if (!current) return { ok: true, cancelled: false };
      current.abort();
      return { ok: true, cancelled: true };
    },
  };
}
