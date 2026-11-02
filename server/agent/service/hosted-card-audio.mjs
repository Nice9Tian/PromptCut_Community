/**
 * Cloud Agent card audio (`render_card_audio`, `cancel_card_audio`; section 9.4c of contract
 * `docs/plan/cloud-agent-contract.md`).
 *
 * **Agent service process does not execute card code.** Card `audio()` (including user cards) is
 * delegated to the co-located render service: shares the same path as viewing visuals (`POST /look`,
 * signed with the service private key; projects with card source code are only touched by worker
 * processes isolated per project). The worker process lets the render page evaluate and return
 * a 32-bit float WAV with its identity record.
 * This module only handles:
 *
 *   Confirm member can write (read-only members are rejected upfront) → hand current project
 *     replica and clip id to render service
 *     → verify shape of returned WAV and record (render page ran untrusted code from project;
 *       treat returned payload purely as data and verify field by field)
 *     → write to asset service (`media`) with member's own asset ticket → atomically register on
 *       project replica (`commitCardAudio`, identical to desktop app).
 *
 * Cancel: aborts in-flight requests; already returned results are not uploaded or committed.
 * Maximum 4 concurrent requests per member per project (same limit as desktop app).
 */

export const CARD_AUDIO_DEFAULTS = Object.freeze({
  /** Timeout waiting for render service (projects with user cards wait for worker startup). */
  renderMs: 150_000,
  /** Maximum size of a WAV (matches the worker process side). */
  maxWavBytes: 32 * 1024 * 1024,
  /** Maximum size of an identity record (matches the desktop app). */
  maxIdentityBytes: 96 * 1024,
  pendingJobs: 4,
});

/** In-flight card audio for an instance (project × member): clip id → AbortController */
export const newCardAudioState = () => ({ pending: new Map() });

/**
 * "Failed to view this time: ..." was written for the visual tool; card audio reuses
 * the same path, keeping the reason but replacing the prefix.
 */
const reword = (message) => `Card audio was not generated this time: ${String(message ?? '').replace(/^Could not view this time:\s*/, '')}`;

/**
 * Verifies WAV returned by render service: RIFF / WAVE, 32-bit float, 48000 Hz, channels and frame
 * count match the record, and byte length matches exactly.
 * @returns {string | null} Returns reason on mismatch
 */
export function checkCardAudioWav(wav, rendition) {
  if (!Buffer.isBuffer(wav) || wav.length < 45) return 'WAV is too short';
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE' || wav.toString('latin1', 12, 16) !== 'fmt ' || wav.toString('latin1', 36, 40) !== 'data') return 'Not the WAV this path should have';
  const channels = wav.readUInt16LE(22);
  if (wav.readUInt16LE(20) !== 3 || wav.readUInt16LE(34) !== 32 || wav.readUInt32LE(24) !== 48000) return 'WAV format is not 48000 Hz 32-bit float';
  if (channels !== rendition.channels) return 'WAV channel count does not match the record';
  if (wav.length !== 44 + rendition.frames * channels * 4 || wav.readUInt32LE(40) !== wav.length - 44) return 'WAV length does not match the record';
  return null;
}

/** Verifies identity record shape; returns cleaned record (only expected fields) or throws reason. */
export function checkRendition(r, clip, limits = CARD_AUDIO_DEFAULTS) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('The render service returned no audio record');
  if (r.version !== 1 || r.sampleRate !== 48000) throw new Error('Audio record has the wrong version');
  if (typeof r.cardId !== 'string' || r.cardId !== (clip.cardId ?? '')) throw new Error('Audio record does not belong to this card');
  if (!Number.isSafeInteger(r.frames) || r.frames < 1 || r.frames > 60 * 48000) throw new Error('Audio record has an invalid length');
  if (!Number.isInteger(r.channels) || r.channels < 1 || r.channels > 8) throw new Error('Audio record has an invalid channel count');
  if (!Number.isFinite(r.sourceOffset) || !Number.isFinite(r.duration) || Math.abs(r.duration - r.frames / 48000) > 1e-9) throw new Error('Audio record has an invalid time');
  if (typeof r.sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(r.sourceKey)) throw new Error('Audio record has an invalid key');
  if (!r.identity || typeof r.identity !== 'object' || Array.isArray(r.identity)) throw new Error('Audio record has no identity');
  const identity = JSON.parse(JSON.stringify(r.identity));
  if (Buffer.byteLength(JSON.stringify(identity), 'utf8') > limits.maxIdentityBytes) throw new Error('The card audio parameter record is too large. Shorten the clip or simplify the input');
  return { version: 1, cardId: r.cardId, sourceKey: r.sourceKey, sourceOffset: r.sourceOffset, duration: r.duration, sampleRate: 48000, frames: r.frames, channels: r.channels, identity };
}

/**
 * @param {object} d
 * @param {ReturnType<typeof newCardAudioState>} d.state
 * @param {() => (null | ((path: string, body: object, opts?: object) => Promise<any>))} d.look
 *   Function for this project to query render service; returns null if node has no endpoint configured
 * @param {() => Promise<{ project: object }>} d.snapshot
 * @param {() => Promise<any>} d.refreshCards Lists this project's card source table to the latest
 *   version (render service uses it to wait for isolated worker process to load this version)
 * @param {(track: object, apply: (host: object) => any) => Promise<any>} d.mutate
 * @param {() => Promise<void>} d.ensureCanWrite
 * @param {(wav: Buffer) => Promise<{ hash: string }>} d.put
 * @param {(hash: string) => Promise<boolean>} d.has Whether asset service contains these bytes
 */
export function createCardAudioTools({ state, look, snapshot, refreshCards = async () => {}, mutate, ensureCanWrite, put, has, record = () => {}, ToolError = Error, limits: limitsIn = {} }) {
  const limits = { ...CARD_AUDIO_DEFAULTS, ...limitsIn };
  const fail = (error, cancelled = false) => ({ ok: false, code: cancelled ? 'CARD_AUDIO_CANCELLED' : 'CARD_AUDIO_FAILED', error: String(error).slice(0, 400) });

  async function render(args, track) {
    const clipId = typeof args?.clipId === 'string' ? args.clipId : '';
    if (!clipId) throw new ToolError('clipId is required');
    const ask = look();
    if (!ask) {
      return { ok: false, cloudUnavailable: true, error: 'The Cloud Agent cannot generate card audio on this node: the node has no render service port open (card audio code only runs in the render service\'s isolated process). Tell the user to generate it in PromptCut on their computer.' };
    }
    await ensureCanWrite();
    await refreshCards();
    const { project } = await snapshot();
    const clip = (project.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === clipId);
    if (!clip) return fail('Cannot find a motion graphics card with embedded audio');
    if (!state.pending.has(clipId) && state.pending.size >= limits.pendingJobs) return fail(`At most ${limits.pendingJobs} card audio jobs can be queued at once. Wait for or cancel an existing job`);
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
          if (signal.aborted) return fail('Canceled, the existing card audio is unchanged', true);
          return fail(reword(err?.message ?? err));
        }
        if (signal.aborted) return fail('Canceled, the existing card audio is unchanged', true);
        if (!data || typeof data !== 'object' || data.ok !== true) return fail(typeof data?.error === 'string' && data.error ? data.error : 'Card audio was not generated');
        if (data.reusable && round === 0 && !force) {
          // Record still matches: only counts if asset service actually has these bytes (only trusts
          // the hash from the entry in project asset table, not what render page reports)
          const media = (project.media ?? []).find((m) => m.id === clip.cardAudio?.mediaId);
          if (media && /^[a-f0-9]{64}$/.test(media.hash ?? '') && await has(media.hash)) { ok = true; return { ok: true, clipId, mediaId: media.id, reused: true }; }
          force = true;
          continue;
        }
        if (typeof data.wav !== 'string' || data.wav.length > Math.ceil(limits.maxWavBytes / 3) * 4 + 8) return fail('The audio returned by the render service is too large or incomplete');
        let rendition;
        try { rendition = checkRendition(data.rendition, clip, limits); } catch (err) { return fail(err.message); }
        const wav = Buffer.from(data.wav, 'base64');
        const bad = checkCardAudioWav(wav, rendition);
        if (bad) return fail(`The audio returned by the render service is invalid: ${bad}`);
        bytes = wav.length;
        const asset = await put(wav);
        if (signal.aborted) return fail('Canceled, the existing card audio is unchanged', true);
        if (!/^[a-f0-9]{64}$/.test(asset?.hash ?? '')) return fail('The asset service did not return a valid content hash');
        const name = `${String(typeof data.name === 'string' && data.name ? data.name : `${clip.label || clip.cardId} · card audio.wav`).replace(/[\0-\x1f]/g, ' ').slice(0, 200)}`;
        let result = null;
        try {
          await mutate(track, (h) => {
            if (signal.aborted || state.pending.get(clipId) !== controller) throw Object.assign(new Error('Canceled, the existing card audio is unchanged'), { cancelled: true });
            result = h.cardAudio.commit({
              projectId: project.id, cutId: project.activeCutId, clipId,
              // When committing, compares against the clip seen by **ourselves** at the moment the replica
              // was taken, not the one reported by the render page
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
      // Reusing an existing one involves no new computation or write; not recorded
      if (bytes > 0 || !ok) try { record({ service: 'card-audio', vendor: 'render', model: clip.cardId ?? '', units: bytes, unit: 'bytes', ok, ms: Date.now() - t0 }); } catch { /* Failure to record usage does not affect the result */ }
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
