import { STREAM_SEGMENT_FRAMES, streamSegmentOf } from '../src/render/streamSegments.mjs';

/** Deadline planning is independent of Chrome and of the client clock. Costs
 * are wall milliseconds; rate is timeline seconds per wall second. */
export function planPlaybackBatch({ frame, fps, rate = 1, count, workers = 3, firstMs = 500, frameMs = 60, jitterMs = 0, deliveryMs = 250, ready = () => false, reserved = new Set() }) {
  let batchSize = 6, stride, lead;
  for (; batchSize >= 1; batchSize--) {
    stride = Math.max(1, Math.ceil((frameMs + firstMs / batchSize) * fps * rate / (1000 * workers * 0.8)));
    const debtMs = (batchSize - 1) * Math.max(0, frameMs - stride * 1000 / (fps * rate));
    lead = Math.ceil((firstMs + debtMs + jitterMs + deliveryMs) * fps * rate / 1000);
    // Near the end, do not reserve debt for screenshots outside the timeline.
    if (batchSize === 1 || Math.ceil((frame + lead) / stride) * stride + (batchSize - 1) * stride < count) break;
  }
  const start = Math.max(0, Math.ceil(frame + lead));
  const end = Math.min(count - 1, start + Math.max(batchSize * stride * workers, Math.ceil(fps * rate * 3)));
  const frames = [];
  // Contiguous blocks minimize duplicate simulation history. Forecast the
  // whole batch's deadline debt: aggregate worker throughput alone would let
  // the later screenshots in this block miss their presentation time.
  for (let n = Math.ceil(start / stride) * stride; n <= end && frames.length < batchSize; n += stride) {
    // Warm-cache holes must not turn six captures into a huge history replay.
    if (frames.length && n - frames[0] > (batchSize - 1) * stride) break;
    if (!ready(n) && !reserved.has(n)) frames.push(n);
  }
  // Do not pay page-reset/history cost for each newly exposed far-edge frame.
  // Wait for a batch there; nearby holes and the tail still run immediately.
  if (frames.length < batchSize && frames[0] > start + fps * rate / 2 && end < count - 1) frames.length = 0;
  return { frames, stride, lead, end };
}

export class FramePlayback {
  constructor({ entry, movie, render, cached, stop, clock = () => performance.now(), wallClock = () => Date.now(), workers = 3 }) {
    Object.assign(this, { entry, movie, render, cached, stop, clock, wallClock, workers });
    this.fps = entry.project.fps || 30;
    this.count = Math.max(1, Math.floor(entry.project.duration * this.fps));
    this.firstMs = 1000; this.frameMs = 150; this.jitterMs = 100;
    this.deliveryMs = 250;
    this.reserved = new Set(); this.jobs = new Set(); this.checked = new Map();
    this.incomplete = new Map();
    this.sequence = -1; this.epoch = 0; this.playing = false;
    this.rendered = 0; this.cacheHits = 0; this.error = null;
  }
  position(now = this.clock()) {
    return Math.min(this.count - 1, Math.max(0, this.frame + (this.playing ? (now - this.at) * this.rate * this.fps / 1000 : 0)));
  }
  update({ sequence, t, playing, rate = 1, deliveryMs = 250, sentAt }) {
    if (sequence <= this.sequence) return false;
    // The desktop client and service share the host's wall clock. A heartbeat
    // reports t at send time, not at the end of HTTP/event-loop queuing.
    const age = playing && Number.isFinite(sentAt) ? Math.min(5000, Math.max(0, this.wallClock() - sentAt)) : 0;
    const now = this.clock(), frame = Math.min(this.count - 1, Math.max(0, (t + age * rate / 1000) * this.fps));
    const changed = this.at === undefined || playing !== this.playing || Math.abs(frame - this.position(now)) > Math.max(3, this.fps * 0.25) || Math.abs(rate - this.rate) > 0.05;
    if (changed) this.cancel();
    this.sequence = sequence; this.frame = frame; this.at = now; this.rate = rate; this.playing = playing;
    this.deliveryMs = deliveryMs;
    this.expires = now + 5000;
    if (changed) { this.checked.clear(); this.error = null; }
    if (playing && !this.timer) {
      this.timer = setInterval(() => { void this.pump(); }, 40);
      this.timer.unref?.();
    }
    return true;
  }
  cancel() {
    this.epoch++;
    clearInterval(this.timer); this.timer = null;
    for (const job of this.jobs) job.controller.abort();
    this.reserved.clear();
  }
  setWorkers(count) {
    this.workers = count;
    const jobs = [...this.jobs].sort((a, b) => b.frames[0] - a.frames[0]);
    for (const job of jobs.slice(0, Math.max(0, jobs.length - count))) job.controller.abort();
  }
  async pump() {
    if (this.pumping || !this.playing) return;
    if (this.clock() >= this.expires) { this.playing = false; this.cancel(); await this.stop(); return; }
    if (this.preparing) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      const current = Math.floor(this.position());
      // Hydrate the entire near window, including deadlines too close for a
      // live render. A warm movie must play immediately, with zero Chromes.
      const forecast = planPlaybackBatch({ frame: current, fps: this.fps, rate: this.rate, count: this.count, workers: this.workers,
        firstMs: this.firstMs, frameMs: this.frameMs, jitterMs: this.jitterMs, deliveryMs: this.deliveryMs });
      const end = Math.min(this.count - 1, Math.max(forecast.end, current + Math.ceil(this.fps * this.rate * 3)));
      for (let n = current; n <= end; n++) {
        if (epoch !== this.epoch || !this.playing) return;
        if (this.movie.has(n) || this.clock() - (this.checked.get(n) ?? -Infinity) < 1000) continue;
        this.checked.set(n, this.clock());
        const buffer = await this.cached(n);
        if (buffer && epoch === this.epoch) { await this.movie.put(n, buffer); this.cacheHits++; }
      }
      for (const n of this.checked.keys()) if (n < current || n > end) this.checked.delete(n);
      while (epoch === this.epoch && this.playing && this.jobs.size < this.workers) {
        const plan = planPlaybackBatch({ frame: this.position(), fps: this.fps, rate: this.rate, count: this.count, workers: this.workers,
          firstMs: this.firstMs, frameMs: this.frameMs, jitterMs: this.jitterMs, deliveryMs: this.deliveryMs,
          ready: n => this.movie.has(n) || this.clock() - (this.incomplete.get(n)?.at ?? -Infinity) < 1000, reserved: this.reserved });
        this.stride = plan.stride; this.lead = plan.lead;
        if (!plan.frames.length) break;
        const job = { controller: new AbortController(), frames: plan.frames };
        plan.frames.forEach(n => this.reserved.add(n)); this.jobs.add(job);
        void this.run(job, epoch);
      }
    } catch (error) { if (epoch === this.epoch) this.error = String(error.message || error); }
    finally { this.pumping = false; }
  }
  async run(job, epoch) {
    const started = this.clock();
    let lastLive, live = 0;
    try {
      await this.render(job.frames.map(n => n / this.fps), { lane: 'playback', signal: job.controller.signal,
        onFrame: async (frame, value) => {
          if (epoch !== this.epoch || job.controller.signal.aborted) return;
          const now = this.clock();
          if (value.incomplete || value.unconfirmedClear) {
            // A placeholder must never become a published MOV sample, and an
            // empty render is only waiting for a confirming second render.
            this.incomplete.set(frame, { at: now, missing: value.missing || [] });
            return;
          }
          this.incomplete.delete(frame);
          if (value.source === 'live' || value.source === 'html') {
            const cost = now - (lastLive ?? started);
            if (lastLive === undefined) {
              this.jitterMs = this.jitterMs * 0.8 + Math.abs(cost - this.firstMs) * 0.2;
              this.firstMs = Math.max(cost, this.firstMs * 0.9 + cost * 0.1);
            } else this.frameMs = Math.max(cost, this.frameMs * 0.9 + cost * 0.1);
            lastLive = now; live++; this.rendered++;
          } else this.cacheHits++;
          await this.movie.put(frame, value.buf);
          // If the measured cost makes the rest of this batch obsolete, yield
          // after a completed screenshot. This preserves the healthy Chrome
          // and lets the next reservation use the updated sampling interval.
          const next = job.frames.find(n => n > frame);
          if (next !== undefined && next < this.position() + (this.frameMs + this.deliveryMs) * this.fps * this.rate / 1000) {
            throw Object.assign(new Error('Playback deadlines changed'), { replan: true });
          }
        },
      });
      if (epoch === this.epoch) this.error = null;
    } catch (error) {
      if (epoch === this.epoch && !job.controller.signal.aborted && !error.replan) {
        this.error = String(error.message || error);
        // Include stalls in the forecast; otherwise a cold Chrome repeatedly
        // times out while aiming at the same already-passed deadlines.
        if (!live) this.firstMs = Math.min(8000, Math.max(this.firstMs * 1.5, this.clock() - started));
      }
    } finally {
      this.jobs.delete(job);
      if (epoch === this.epoch) job.frames.forEach(n => this.reserved.delete(n));
    }
  }
  status() {
    const frame = Math.floor(this.position());
    for (const n of this.incomplete.keys()) if (n < frame - this.fps || this.movie.has(n)) this.incomplete.delete(n);
    // Only frames with missing cards have a placeholder image to show.
    const nearby = [...this.incomplete.keys()].filter(n => n <= frame && frame - n < this.fps && this.incomplete.get(n).missing?.length).sort((a, b) => b - a)[0];
    const preview = nearby === undefined ? null : { frame: nearby, missing: this.incomplete.get(nearby).missing,
      url: `/api/frames/${this.entry.key}/preview-frames/${String(nearby).padStart(6, '0')}.png` };
    return { epoch: this.epoch, sequence: this.sequence, playing: this.playing,
      preview, incomplete: !!preview,
      ...this.movie.index(frame - Math.min(this.stride || 1, this.fps), frame + Math.ceil(this.fps * this.rate * 3)),
      metrics: { firstMs: this.firstMs, frameMs: this.frameMs, deliveryMs: this.deliveryMs, lead: this.lead || 0, stride: this.stride || 1,
        workers: this.workers, inFlight: this.jobs.size, rendered: this.rendered, cacheHits: this.cacheHits }, error: this.error };
  }
}

/* ======================================================================== *
 * Scheduling for track streams (R8 / G4): pure function, same basis as `planPlaybackBatch` above:
 * `frameMs` / `resetMs` / `jitterMs` / `deliveryMs` are wall-clock milliseconds on the **production side**,
 * `rate` is timeline seconds / wall-clock seconds.
 * ======================================================================== */

/** 15 frames per segment (G2; stream's final segment can be partial). Values and conversions taken from `src/render/streamSegments.mjs` */
export const STREAM_SEGMENT = STREAM_SEGMENT_FRAMES;

/**
 * G4's `firstMs` (**not a constant**): only paid when the lease is broken:
 * `firstMs = resetMs + fixedMs + (runStartFrame − earliest mount frame across cards in this stream) × frameMs`.
 * `fixedMs` is the fixed per-pass mount / warmup overhead added by G0-b Conclusion 7 (measured at ~80 ms).
 * When the lease holds (same stream, immediately following the end of the previous pass), only 0 remains.
 */
export function streamFirstMs({ leaseContinues = false, runStartFrame, mountFrame = 0, resetMs = 400, fixedMs = 80, frameMs = 30 }) {
  if (leaseContinues) return 0;
  return resetMs + fixedMs + Math.max(0, runStartFrame - mountFrame) * frameMs;
}

/**
 * G4 feasibility condition: `firstMs + n × 15 × frameMs / stride ≤ n × (15000 / fps) × workers`.
 * **`frameMs` must use the value when an encoder is running** (G0-b Conclusion 7: 2.26x the idle value).
 * When not met, switch to producing a sparse version (each segment captures only the first frame,
 * `stride` = segment frame count; only this tier), then merge streams: here only returns the
 * decision and recommended `stride`.
 */
export function streamFeasibility({ n = 1, firstMs = 0, frameMs, fps, workers = 1, stride = 1 }) {
  const need = (s) => firstMs + n * STREAM_SEGMENT * frameMs / s;
  const budget = n * (STREAM_SEGMENT * 1000 / fps) * Math.max(1, workers);
  const feasible = need(stride) <= budget;
  let suggest = stride;
  if (!feasible && STREAM_SEGMENT > stride && need(STREAM_SEGMENT) <= budget) suggest = STREAM_SEGMENT;
  if (!feasible && need(suggest) > budget) suggest = null;
  return { feasible, needMs: need(stride), budgetMs: budget, stride: suggest };
}

/**
 * G4's `planStreamSegments` (one per stream): how many segments of lead margin to keep ahead of the
 * playhead, and which segment this stream should produce next.
 *
 *   `leadSegments = ceil((firstMs + segMs + jitterMs + deliveryMs) × rate × fps / (15 × 1000))`
 *   `segMs = 15 × frameMs / stride`
 *
 * Segment selection rules (workers rotate between streams by "unready segment closest to playhead",
 * **but prioritize extending their own lease**):
 *   1. If the lease holds (`leaseLastSegment + 1` is unready and not taken by others), continue working
 *      on it: do not break the lease for newly exposed distant segments;
 *   2. Otherwise look forward starting from playhead segment + `leadSegments` for the first unready one;
 *   3. Once later ones are all ready, look forward from the stream's first segment (filling holes
 *      before the playhead).
 *
 * `ready(n)` / `reserved` are provided by the caller (`ready` already accounts for "sparse or full density").
 *
 * `playheadFrame` is the project frame number, and `originFrame` is this stream's own first frame
 * (segments count from it, `streamSegments.mjs`):
 * when the playhead has not yet reached this stream, it counts as its segment 0.
 */
export function planStreamSegments({ playheadFrame = 0, originFrame = 0, fps, rate = 1, firstSegment = 0, lastSegment, stride = 1,
  frameMs = 30, firstMs = 0, jitterMs = 100, deliveryMs = 250, ready = () => false, reserved = new Set(), leaseLastSegment = null }) {
  const segMs = STREAM_SEGMENT * frameMs / Math.max(1, stride);
  const leadSegments = Math.max(0, Math.ceil((firstMs + segMs + jitterMs + deliveryMs) * rate * fps / (STREAM_SEGMENT * 1000)));
  const free = (n) => n >= firstSegment && n <= lastSegment && !ready(n) && !reserved.has(n);
  if (leaseLastSegment !== null && free(leaseLastSegment + 1)) return { segment: leaseLastSegment + 1, leadSegments, continues: true };
  const head = Math.max(0, streamSegmentOf(Math.max(0, playheadFrame), originFrame));
  const from = Math.max(firstSegment, Math.min(lastSegment, head + leadSegments));
  for (let n = from; n <= lastSegment; n++) if (free(n)) return { segment: n, leadSegments, continues: false };
  for (let n = firstSegment; n < from; n++) if (free(n)) return { segment: n, leadSegments, continues: false };
  return { segment: null, leadSegments, continues: false };
}
