export interface MovSample { frame: number; offset: number; size: number }
export interface PlaybackStatus {
  movie: string; key: string; epoch: number; sequence: number; frames: MovSample[];
  count: number; fps: number; width: number; height: number;
  metrics: { stride: number }; error?: string;
}

/** PNG MOV sample reader. Chromium has no native PNG-MOV decoder; ranges come
 * from the writer's committed sample table and decode through ImageBitmap.
 * Rendering remains entirely in the common server Chrome pipeline. */
export class MovPlayer {
  private status?: PlaybackStatus;
  private bitmaps = new Map<number, ImageBitmap>();
  private loading = new Set<number>();
  private failed = new Map<number, number>();
  private controller = new AbortController();
  private generation = 0;
  private displayed = -1;
  private presented = -1;
  private lastFrame = -1;
  private limit = 12;
  deliveryMs = 100;
  constructor(private canvas: HTMLCanvasElement, private error: (message: string) => void) {}
  update(status: PlaybackStatus) {
    if (this.status?.movie !== status.movie || this.status.epoch !== status.epoch) this.reset();
    this.status = status;
    this.limit = Math.max(1, Math.min(24, Math.floor(96 * 1024 * 1024 / (status.width * status.height * 4))));
  }
  private reset() {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear(); this.loading.clear(); this.failed.clear();
    this.displayed = -1; this.presented = -1; this.lastFrame = -1;
    this.canvas.dataset.frame = '-1';
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  draw(t: number) {
    const status = this.status;
    if (!status) return;
    const frame = Math.max(0, Math.min(status.count - 1, Math.round(t * status.fps)));
    // Seeks clear the old view before the server heartbeat catches up.
    if (this.lastFrame >= 0 && (frame < this.lastFrame || frame - this.lastFrame > status.fps / 4)) {
      const forward = frame > this.lastFrame, presented = this.presented;
      this.reset();
      // A delayed RAF can skip several timeline frames without a user seek.
      // Clearing the bitmap window must not allow an older decoded frame back.
      if (forward) this.presented = presented;
    }
    this.lastFrame = frame;
    const hold = Math.min(Math.max(0, status.metrics.stride - 1), status.fps);
    // The pixel budget limits bitmap count, not timeline distance. Sparse
    // playback still needs seconds of lookahead to hide PNG transfer/decode.
    const max = frame + Math.ceil(status.fps * 3);
    for (const [n, bitmap] of this.bitmaps) if (n < frame - hold || n > max) { bitmap.close(); this.bitmaps.delete(n); }
    let selected = frame;
    const oldest = Math.max(frame - hold, this.presented);
    while (selected >= oldest && !this.bitmaps.has(selected)) selected--;
    const bitmap = selected >= oldest ? this.bitmaps.get(selected) : undefined;
    const next = bitmap ? selected : -1;
    if (next !== this.displayed) {
      const ctx = this.canvas.getContext('2d');
      ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (bitmap) ctx?.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
      this.displayed = next;
      if (bitmap) this.presented = next;
      this.canvas.dataset.frame = String(next);
    }
    for (const sample of status.frames) {
      if (this.loading.size >= 2 || this.bitmaps.size + this.loading.size >= this.limit) break;
      if (sample.frame < frame - hold || sample.frame > max || this.bitmaps.has(sample.frame) || this.loading.has(sample.frame)
        || performance.now() - (this.failed.get(sample.frame) ?? -Infinity) < 1000) continue;
      this.loading.add(sample.frame);
      void this.load(sample, status.movie, this.generation, this.controller.signal);
    }
    for (const n of this.failed.keys()) if (n < frame - hold || n > max) this.failed.delete(n);
  }
  private async load(sample: MovSample, url: string, generation: number, signal: AbortSignal) {
    const started = performance.now();
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${sample.offset}-${sample.offset + sample.size - 1}` }, cache: 'no-store', signal });
      if (response.status !== 206) throw new Error(`播放帧读取失败 (${response.status})`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== sample.size) throw new Error('播放帧尚未完整写入');
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      if (generation !== this.generation || signal.aborted) { bitmap.close(); return; }
      this.deliveryMs = this.deliveryMs * 0.8 + (performance.now() - started) * 0.2;
      this.bitmaps.set(sample.frame, bitmap);
    } catch (error) {
      if (!signal.aborted && generation === this.generation) {
        this.failed.set(sample.frame, performance.now()); this.error(String(error));
      }
    } finally { if (generation === this.generation) this.loading.delete(sample.frame); }
  }
  close() { this.reset(); this.controller.abort(); this.status = undefined; }
}
