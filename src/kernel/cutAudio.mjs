/**
 * Cut segment audio (`kernel/cutSegments.ts` file header "How audio is output") and envelopes.
 *
 * On the audio side, there is no "nested scene" to mount, so clips producing sound in the
 * referenced cut are shifted in time and trimmed into the segment's window, assembled into a
 * project used solely for mixing. Fade-in and fade-out of each cut segment layer are written into
 * an envelope (`cutEnv`), multiplied by `opacityAt` and respective mixers (`gainCurve` in
 * `audioPlan.mjs`, afade chains in `server/bakery/mux-audio.mjs`).
 *
 * Pure JS (.mjs): export mixing is imported directly on the server without TS. Same convention as
 * the storage format in `cutSegments.ts`.
 */

/** Same value as the default duration of new cuts in cuts.ts */
import { clipSpeed } from "./clipTime.mjs";

const FALLBACK_CUT_DURATION = 30;
const MAX_DEPTH = 32;

/** Value of one envelope layer at time t: 0 outside the window; opacity × fade-in × fade-out inside the window */
export function envelopeAt(e, t, withOpacity = true) {
  if (t < e.start || t >= e.end) return 0;
  let a = withOpacity ? e.opacity ?? 1 : 1;
  const fin = e.fadeIn ?? 0;
  const fout = e.fadeOut ?? 0;
  if (fin > 0 && t < e.start + fin) a *= (t - e.start) / fin;
  if (fout > 0 && t > e.end - fout) a *= (e.end - t) / fout;
  return Math.max(0, Math.min(1, a));
}

const isSeg = (c) => typeof c?.cutId === "string" && c.cutId.length > 0;

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/** Subproject of the referenced cut (for audio only, not memoized); returns null on cycles, dangling references, or excessive depth */
function subOf(p, cutId) {
  if (!Array.isArray(p.cuts)) return null;
  const root = activeIdOf(p);
  const path = p.cutPath ?? (root ? [root] : []);
  if (path.includes(cutId) || path.length >= MAX_DEPTH) return null;
  const entry = p.cuts.find((c) => c.id === cutId);
  if (!entry) return null;
  let content;
  if (cutId === activeIdOf(p)) content = { tracks: p.tracks, duration: p.duration };
  else if (Array.isArray(entry.tracks)) content = { tracks: entry.tracks, duration: typeof entry.duration === "number" && entry.duration > 0 ? entry.duration : FALLBACK_CUT_DURATION };
  else return null;
  return {
    ...p, tracks: content.tracks, duration: content.duration, transitions: entry.transitions ?? [],
    activeCutId: cutId, cuts: p.cuts.map((c) => (c.id === cutId ? { id: c.id, name: c.name } : c)), cutPath: [...path, cutId],
  };
}

const memo = new WeakMap();

/**
 * Project solely for mixing: each cut segment in the active cut is replaced with clips from the
 * referenced cut, shifted to the segment's time, and trimmed into the segment's window; nested cut
 * segments are expanded recursively. Expanded clips are placed in their own new tracks (different
 * subtracks of the same cut segment will overlap in time), with track ids and clip ids carrying
 * the cut segment's path prefix to avoid colliding with existing ones.
 *
 * - Volume = subclip's own volume × each cut segment layer's volume (`audioVolume`);
 * - Mute: if any cut segment layer is muted or its track is muted, the expanded clip is muted;
 * - Fade-in/fade-out: both the subclip's own (per its original start/end) and each cut segment
 *   layer's are written into `cutEnv` (excluding segment opacity: that belongs to visuals);
 * - Trimmed portion: both media clips and card clips shift their source clock (`mediaOffset`; if
 *   omitted on card clips, use its node's timeOffset) backward by the same amount, matching the
 *   split convention;
 * - Referenced cut shortens later: window is capped at its total duration, with silence beyond it.
 *
 * Projects without cut segments return the same object as is (mixing for legacy projects is
 * unchanged byte-for-byte).
 */
export function audioProjectOf(p) {
  if (!(p?.tracks ?? []).some((tr) => (tr.clips ?? []).some(isSeg))) return p;
  const hit = memo.get(p);
  if (hit) return hit;
  const tracks = [];
  for (const tr of p.tracks) {
    const plain = tr.clips.filter((c) => !isSeg(c));
    tracks.push(plain.length === tr.clips.length ? tr : { ...tr, clips: plain });
    for (const seg of tr.clips) if (isSeg(seg)) tracks.push(...expand(p, seg, tr, [], []));
  }
  const out = { ...p, tracks };
  memo.set(p, out);
  return out;
}

function fadesOf(c, start, end) {
  return { start, end, ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}) };
}

function expand(p, seg, hostTrack, prefix, outer) {
  const sub = subOf(p, seg.cutId);
  if (!sub) return [];
  const offset = Math.max(0, seg.cutOffset ?? 0);
  const shift = seg.start - offset; // Sub-cut time τ ↔ parent time τ + shift
  const w0 = seg.start;
  const w1 = Math.min(seg.end, sub.duration + shift);
  if (!(w1 > w0)) return [];
  const envs = [...outer, fadesOf(seg, seg.start, seg.end)];
  const path = [...prefix, seg.id];
  const segVolume = seg.audioVolume ?? 1;
  const segMuted = !!seg.audioMuted || !!hostTrack.muted;
  const out = [];
  for (const child of sub.tracks) {
    if (child.hidden) continue;
    const clips = [];
    const nested = [];
    for (const c of child.clips) {
      const s = c.start + shift, e = c.end + shift;
      const a = Math.max(s, w0), b = Math.min(e, w1);
      if (!(b > a)) continue;
      if (isSeg(c)) {
        // Nested cut segment: first shift and trim it into this layer's window (offsets follow), write its own fading per original start/end into envelopes, then recurse
        const moved = {
          ...c, start: a, end: b, cutOffset: Math.max(0, c.cutOffset ?? 0) + (a - s), fadeIn: undefined, fadeOut: undefined,
          audioVolume: (c.audioVolume ?? 1) * segVolume, audioMuted: !!c.audioMuted || segMuted || !!child.muted,
        };
        nested.push(...expand(sub, moved, { ...child, muted: false }, path, [...envs, fadesOf(c, s, e)]));
        continue;
      }
      const trim = a - s;
      const nodeOffset = c.nodeId ? Number((sub.cardNodes ?? []).find((n) => n.id === c.nodeId)?.timeOffset) || 0 : 0;
      const sourceOffset = c.mediaId ? (c.mediaOffset ?? 0) : (c.mediaOffset ?? nodeOffset);
      clips.push({
        ...c,
        id: `${path.join("/")}/${c.id}`,
        start: a,
        end: b,
        // Advance asset start per clip speed for trimmed portion (speed-changed clips produce no original audio themselves, here only for consistency; default 1 bitwise unchanged)
        ...(trim > 0 || c.mediaId ? { mediaOffset: sourceOffset + trim * clipSpeed(c) } : {}),
        fadeIn: undefined,
        fadeOut: undefined,
        audioVolume: (c.audioVolume ?? 1) * segVolume,
        ...(segMuted || child.muted ? { audioMuted: true } : {}),
        // Outer segment envelopes, subclip's own fading per original start/end, and this layer's window (clamped to total duration if referenced cut shortens)
        cutEnv: [...envs, fadesOf(c, s, e), { start: w0, end: w1 }],
        // cutId: which cut the original clip lives in (card audio identity and coverage checked per original clip, `cardAudioRendition.mjs`)
        cutOrigin: { clipId: c.id, segments: path, cutId: seg.cutId },
      });
    }
    if (clips.length) out.push({ ...child, id: `${path.join("/")}/${child.id}`, muted: false, clips });
    out.push(...nested);
  }
  return out;
}
