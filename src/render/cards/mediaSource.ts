import { mediaTierPolicy, remoteMediaUrl } from "../mediaTier";

/**
 * 卡片自己引用的素材地址:桌面原样(`/@media/<hash>`);在线浏览器模式没有本机编辑器进程,换成远程素材服务上的
 * 原尺寸(带只读票据;卡片画进画布、导出都要原尺寸)。远程地址还没就绪时给 "",解码当场失败,不发请求。
 * (素材效果卡在在线的预览里跑不了时不挂,由渲染节点出;这里管的是其余会走到这条路的调用。)
 */
function cardMediaUrl(url: string): string {
  const p = mediaTierPolicy();
  if (!p.online) return url;
  return p.remote ? remoteMediaUrl(url, p.remote) : "";
}

/**
 * seek 目标比要取的时刻 t 晚一点点(秒)。规则是「取素材里时间戳不超过 t 的最后一帧;t 正好落在帧边界时取边界上这一帧」:
 * 原样把 t 设给 `currentTime`,落在帧边界上的 t(慢放、变速、片段起点不在 0 时常见)经浮点误差和浏览器换算成微秒时的截断,
 * 会比那一帧的时间戳早不到一微秒,取到的是前一帧 —— 取前一帧还是本帧随误差摆,慢放段因此一顿一顿。
 * 统一加 2 ms,不依赖素材帧率:小于任何常见素材的一帧(500 fps 以下),和 `src/render/frameMedia.ts` 同一个数。
 */
export const CARD_SEEK_LEAD = 0.002;

/** 取时刻 `time` 那一帧时实际设给 `currentTime` 的值:加 `CARD_SEEK_LEAD`,夹在 [0, 时长 − 0.1 ms] 里(时长未知时不夹上限)。 */
export function cardSeekTarget(time: number, duration: number): number {
  const target = Math.max(0, time) + CARD_SEEK_LEAD;
  return Number.isFinite(duration) ? Math.min(target, Math.max(0, duration - .0001)) : target;
}

/** seek 之后等新帧成为元素当前帧:每次复查间隔(ms)与单帧最多等多久(ms)。见 `CardMediaSource.frame` 的注释。 */
const SETTLE_POLL_MS = 1;
const SETTLE_LIMIT_MS = 500;
/**
 * 同一个素材连续这么多帧等满 `SETTLE_LIMIT_MS` 仍对不上,就暂停等待(退回只等 seeked),直到某一帧当场对上再恢复。
 * 例如视频轨比素材时长短、目标落在最后一帧之后:帧槽一直是最后一帧,怎么等都对不上,不该每帧白等。
 */
const SETTLE_GIVE_UP = 2;

/**
 * 视频元素此刻的「当前帧」(`createImageBitmap(video)` 取到的那一帧)是不是 `currentTime` 所在的那一帧。
 * 帧的起止取自 `new VideoFrame(video)` 的 `timestamp` / `duration`(微秒);`currentTime` 按 Chrome 的做法截断到微秒,
 * 两边各留 1 µs 给四舍五入。返回 true / false;没法判断时(没有 WebCodecs、元素读不出帧、帧没有时长而时间戳又不晚于
 * 目标)返回 null,调用方按「对上了」处理,即退回只等 seeked 的老行为。
 */
export function currentFrameCovers(video: HTMLVideoElement): boolean | null {
  if (typeof VideoFrame === "undefined") return null;
  let frame: VideoFrame;
  try { frame = new VideoFrame(video); } catch { return null; }
  try {
    const at = Math.trunc(video.currentTime * 1e6);
    const start = frame.timestamp, length = frame.duration;
    if (start > at + 1) return false;
    if (!length) return null;
    return at < start + length + 1;
  } finally { frame.close(); }
}

/** A decoder belongs to one card canvas. Seeking it never touches a timeline
 * media element or another card's source cursor. GPU registration can therefore
 * sample video locally without a server round trip or per-frame PNG transfer. */
export class CardMediaSource {
  private sources = new Map<string, Promise<HTMLVideoElement | HTMLImageElement>>();
  /** 每个视频元素一条取帧队列:seek → 取帧必须整段独占元素,两次取帧交错会互相拿到对方的帧 */
  private queues = new Map<string, Promise<unknown>>();
  /** 每个素材连续等满上限的次数 */
  private settleMisses = new Map<string, number>();
  private disposed = false;
  /** 诊断用(`scripts/probes/video-seek-race-probe.mjs` 读):seeked 之后帧槽里还不是目标帧、多等了的次数 */
  settleWaits = 0;
  async frame(media: { url: string; kind?: string; type?: string; duration?: number }, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!this.sources.has(media.url)) {
      const image = media.kind === 'image' || media.type?.startsWith('image') || /\.(png|jpg|jpeg|webp|gif|svg)(?:[?#]|$)/i.test(media.url);
      const source = image ? new Image() : document.createElement('video');
      if (source instanceof HTMLVideoElement) { source.muted = true; source.preload = 'auto'; source.playsInline = true; }
      const ready = new Promise<HTMLVideoElement | HTMLImageElement>((resolve, reject) => {
        const event = image ? 'load' : 'loadeddata';
        source.addEventListener(event, () => resolve(source), { once: true });
        source.addEventListener('error', () => reject(new Error('Card media could not be decoded: ' + media.url)), { once: true });
        const src = cardMediaUrl(media.url);
        if (!src) { reject(new Error('Card media is not reachable yet: ' + media.url)); return; }
        source.src = src;
      });
      this.sources.set(media.url, ready);
    }
    const source = await this.sources.get(media.url)!;
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!(source instanceof HTMLVideoElement)) return createImageBitmap(source, { premultiplyAlpha: 'none' });
    const prior = this.queues.get(media.url) ?? Promise.resolve();
    const turn = prior.catch(() => {}).then(() => this.videoFrame(media.url, source, time, signal));
    this.queues.set(media.url, turn);
    return turn;
  }
  /**
   * 设 currentTime → 等 seeked → 等新帧成为元素的当前帧 → 取帧。
   *
   * 只等 seeked 不够:Chrome 里 seek 完成后,新解出的那一帧由媒体线程分两路送出 —— 一路投给合成用的帧槽
   * (`createImageBitmap(video)` 读的就是它),一路通知主线程发 seeked。两路各走各的线程,机器忙时主线程可能先收到
   * seeked,当场取帧拿到的还是 seek 之前那一帧(`scripts/probes/video-seek-race-probe.mjs` 满载下约万分之一)。
   * 所以 seeked 之后再用 `currentFrameCovers` 核对帧槽里的帧是不是 currentTime 所在那一帧,不是就隔 `SETTLE_POLL_MS`
   * 再看。核对只读帧的时间戳,不依赖合成器出帧(导出页由 beginFrame 控制出帧,等合成器回调可能和导出器互相等住)。
   */
  private async videoFrame(url: string, source: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const target = cardSeekTarget(time, source.duration);
    // 上一次取帧被取消时 seek 可能还在路上:currentTime 已是目标,但新帧还没到,也要等 seeked
    if (source.seeking || Math.abs(source.currentTime - target) > .00001) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { source.removeEventListener('seeked', done); source.removeEventListener('error', failed); signal?.removeEventListener('abort', cancelled); };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Card video seek failed')); };
      const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      source.addEventListener('seeked', done, { once: true }); source.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', cancelled, { once: true });
      if (Math.abs(source.currentTime - target) > .00001) source.currentTime = target;
    });
    const misses = this.settleMisses.get(url) ?? 0;
    let covered = currentFrameCovers(source);
    if (covered === false && misses < SETTLE_GIVE_UP) {
      this.settleWaits++;
      const start = performance.now();
      while (covered === false && performance.now() - start < SETTLE_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
        if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        covered = currentFrameCovers(source);
      }
      if (covered === false) {
        this.settleMisses.set(url, misses + 1);
        if (misses + 1 >= SETTLE_GIVE_UP) console.warn(`素材效果卡视频源的帧时间戳连续对不上 currentTime,暂停核对直到再次对上:${url}`);
      }
    }
    // 对上一次就清零(放弃核对期间也照常看一眼,对上了就恢复核对)
    if (covered === true && misses) this.settleMisses.set(url, 0);
    return createImageBitmap(source, { premultiplyAlpha: 'none' });
  }
  dispose() {
    this.disposed = true;
    for (const promise of this.sources.values()) void promise.then(source => {
      if (source instanceof HTMLVideoElement) source.pause(); source.removeAttribute('src');
      if (source instanceof HTMLVideoElement) source.load();
    }, () => {});
    this.sources.clear();
    this.queues.clear();
  }
}
