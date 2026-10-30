/**
 * 游客素材限额在素材服务上的接线（2026-10-23 用户定；缺省限额与判断函数内置于本模块，可通过 `registerGuestQuotaPolicy` 覆盖）。
 *
 * 用户的口径：「每一条源文件不能大于100M。总视频素材不能大于三条。」所以分两条管游客往 `media` 写的东西：
 * - **尺寸**：传上来的每一个文件（视频、图片、音频、小档）都不超过 `GUEST_LIMITS.assetBytes`；
 * - **条数**：一个项目里最多 `GUEST_LIMITS.videos` 条**不同的视频源**。图片、音频不计数。
 * 账号、本机回环来源、托管方服务一律不经这里。`snap`、`px` 是预渲染产物，不是用户传的素材，也不经这里。
 *
 * **不信页面说的**（2026-10-23 claude/guest-fix〔裁〕，审查 REVIEW-guest-identity 的 A1、A2：原先按页面报的扩展名和
 * 档位数，游客把视频报成 `jpg`、或者把每一片都标成 `X-Media-Tier: small`，5 条 mp4 全收）：
 * - **是不是视频，按文件头字节认**（`media-sniff.mjs`）。页面报的扩展名是视频的照样算；报的不是视频的，看文件头：
 *   认出是视频、或者认不出（又不是文本）的，都算一条视频。已入库的每个文件都这样认（按哈希记住结论，内容不会变）。
 * - **几条视频源，按「原尺寸档几个、小档几个，取多的那个」数**。在线编辑器传一个视频会传两个文件（小档预览和
 *   原尺寸，`src/online/mediaUploadQueue.ts`），一条视频源对应一个原件、至多一个小档，所以正常用法下这个数就是视频条数。
 *   档位仍是页面说的，但怎么报都绕不过去：全报小档，小档就有那么多个，照样数到；只有「3 个报原件、3 个报小档」
 *   能多放进 3 个文件——最坏 6 个、每个不超过 100 MB，有上限（原先是没有上限）。
 *
 * **几处闸门**：
 * - 开一个**新的**暂存（这个哈希既没入库、也没在收）、页面报的扩展名是视频时：数「已入库的（按文件头）+ 正在收的
 *   （按登记的扩展名和档位）+ 这一条」，超了当场拒，暂存不开。这是给老实的页面早点说「不行」；
 * - **收尾**是真正的闸门：先按登记的扩展名和档位数一遍（够了就不收尾，暂存留着，删掉一条之后再收尾就能进去）；
 *   放行后数据层入库，再按这一条**自己的文件头**连同已入库的重数一遍，超了就把刚入库的这一条删掉、回 403；
 * - **整件上传**（`POST /api/media/upload/<名>`）：调用方先从请求体里读出开头那几十个字节交来（`head`），按它认；
 * - 游客不能用 `POST /api/media/adopt`（给素材收集补算内容键，游客用不到；它能把还没收尾的暂存挂进库，审查 S3），
 *   在 `asset-service.ts` 的 `gateWholeMediaWrite` 里拒。
 *
 * **「已经存了几条」怎么数**：问数据层的 `inventory()`（`BlobStore` 接口，fs、memory 两种实现都有），当场数，不另记账。
 * 档位由数据层跟着哈希一起存（`blob-store.mjs`「档位」），删掉一条，下一次数自然跟着变。三天清理把项目整个
 * 从素材服务上删掉（`project-stores.mjs` 的 `removeProject`，由 `server/hosted/asset-runtime.mjs` 收到删除事件时调），
 * 清掉的项目号不再发给别人（`server/account/authority.mjs` 的 `createProject`），所以不会有人接着用上一个人的名额或字节。
 * 不用 `service-usage.mjs` 那本账：它只记托管方渲染服务的产物，而且是另一份要和数据层对齐的状态。
 *
 * 云端托管下每个项目一个独立的数据层（`project-stores.mjs`），游客自己只能建一个项目、进别人的项目只读、
 * 写不进去，所以「这个项目的 `media` 有几条视频」就是「这个游客传了几条」。
 *
 * **并发**：数和写之间有空档，两路同时开新暂存、或者同时收尾，都可能各自看到「还差一条」而一起放进去。
 * 所以游客的「数 + 开新暂存的第一片」「数 + 收尾」「数 + 整件上传」在同一个项目里排队做（`serialize`），
 * 账号的写入不排这个队。
 *
 * 只引 Node 内置模块与同目录的小模块，不引 `server/account/` 或 `cloud/`。
 */

import { normalizeTier } from './blob-store.mjs';
import { SNIFF_BYTES, countsAsVideoFile } from './media-sniff.mjs';

export const GUEST_ID_RE = /^gst_[0-9a-f]{24}$/;
export const isGuestId = value => typeof value === 'string' && GUEST_ID_RE.test(value);

export function guestIdOfUserId(userId) {
  if (isGuestId(userId)) return userId;
  if (typeof userId !== 'string') return null;
  const at = userId.lastIndexOf('@');
  const head = at > 0 ? userId.slice(0, at) : userId;
  const id = head.startsWith('account:') ? head.slice('account:'.length) : null;
  return isGuestId(id) ? id : null;
}

export const GUEST_LIMITS = Object.freeze({
  projects: 1,
  conversations: 1,
  videos: 3,
  assetBytes: 100 * 1024 * 1024,
  ttlMs: 3 * 24 * 60 * 60 * 1000,
  tokenTtlMs: 24 * 60 * 60 * 1000,
  renewGraceMs: 3 * 24 * 60 * 60 * 1000,
});

function defaultCheckGuestAsset({ accountId, bytes, countsAsVideo = false, storedVideos = 0 } = {}) {
  if (!isGuestId(accountId)) return { ok: true };
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, code: 'invalid-asset' };
  if (bytes > GUEST_LIMITS.assetBytes) return { ok: false, code: 'guest-file-too-large' };
  if (countsAsVideo && (storedVideos ?? 0) >= GUEST_LIMITS.videos) return { ok: false, code: 'guest-video-limit' };
  return { ok: true };
}

let customGuestQuotaPolicy = null;
export function registerGuestQuotaPolicy(fn) {
  customGuestQuotaPolicy = typeof fn === 'function' ? fn : null;
}

export function checkGuestAsset(args) {
  return customGuestQuotaPolicy ? customGuestQuotaPolicy(args) : defaultCheckGuestAsset(args);
}

/** 这次写入要不要按游客限额管：只管游客往 `media` 写 */
export const guestQuotaApplies = (accountId, ns) => ns === 'media' && isGuestId(accountId);

const DENY = code => ({ ok: false, status: 403, error: code });

/** 按哈希记住的「这个文件按文件头算不算视频」最多记多少条；满了整张清掉重来（内容寻址，重认一遍结果一样） */
const SNIFF_CACHE_MAX = 20_000;

/** 读一个已入库文件的开头。读不出（没入库、实现不给读）回 null */
async function headOf(store, hash) {
  let stream;
  try { stream = await store.read(hash, { start: 0, end: SNIFF_BYTES - 1 }); } catch { return null; }
  if (!stream) return null;
  const parts = [];
  let got = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      parts.push(buf); got += buf.length;
      if (got >= SNIFF_BYTES) break;
    }
  } catch { return parts.length ? Buffer.concat(parts) : null; }
  finally { try { stream.destroy?.(); } catch { /* 不影响 */ } }
  return Buffer.concat(parts).subarray(0, SNIFF_BYTES);
}

/**
 * 一组文件里有几条视频源：原件几个、小档几个，取多的那个。
 * @param {Array<{ video: boolean, tier: string }>} entries
 */
export function videoSourcesOf(entries) {
  let originals = 0, smalls = 0;
  for (const e of entries) {
    if (!e.video) continue;
    if (normalizeTier(e.tier) === 'small') smalls++; else originals++;
  }
  return Math.max(originals, smalls);
}

/**
 * 一个素材服务中间件一份：里面有按项目排队用的锁，和按哈希记住的文件头结论。
 * `key` 是「同一个数据层」的标识：托管下是项目编号，本机是那个数据层对象本身。
 *
 * @param {{ isVideoExt: (ext: string) => boolean }} options
 *   `isVideoExt`：这个扩展名（不含点、小写）是不是视频。必须给：缺了就等于「页面报的一样都不算视频」
 */
export function createGuestAssetQuota({ isVideoExt } = /** @type {any} */ ({})) {
  if (typeof isVideoExt !== 'function') throw new TypeError('createGuestAssetQuota：要传 isVideoExt');
  const claimedVideo = ext => !!isVideoExt(String(ext || '').toLowerCase().replace(/^\./, ''));

  /** @type {Map<string, boolean>} 哈希 → 按文件头算不算视频（不含「页面报的扩展名」那一半） */
  const sniffed = new Map();
  /** 已入库的这一个文件算不算视频：报的扩展名是视频就算，否则按文件头 */
  async function storedIsVideo(store, entry) {
    if (claimedVideo(entry.ext)) return true;
    const hash = String(entry.hash).toLowerCase();
    if (sniffed.has(hash)) return sniffed.get(hash);
    const head = await headOf(store, hash);
    // 读不出开头：按算数办（失败闭合），也不记住，下次再读
    if (head === null) return true;
    const verdict = countsAsVideoFile(head, false);
    if (sniffed.size >= SNIFF_CACHE_MAX) sniffed.clear();
    sniffed.set(hash, verdict);
    return verdict;
  }

  /** @type {Map<unknown, Promise<unknown>>} */
  const tails = new Map();
  function serialize(key, task) {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  }
  /** 占住这个数据层的游客队，回放锁函数。占到的时候，之前排队的都做完了 */
  function acquire(key) {
    return new Promise(resolveAcquired => {
      void serialize(key, () => new Promise(release => resolveAcquired(release)));
    });
  }

  /**
   * 数据层里现有的文件，各标上算不算视频。已入库的按文件头（`except` 那个哈希除外：它是正在判的这一条）；
   * `withStaging` 时连正在收的一起，正在收的还没有完整的字节，按登记的扩展名。
   */
  async function entriesOf(store, { withStaging, except = null }) {
    const inv = await store.inventory();
    const out = [];
    for (const e of inv?.stored ?? []) {
      if (except && e.hash === except) continue;
      out.push({ video: await storedIsVideo(store, e), tier: e.tier });
    }
    if (withStaging) for (const e of inv?.staging ?? []) {
      if (except && e.hash === except) continue;
      out.push({ video: claimedVideo(e.ext), tier: e.tier });
    }
    return out;
  }
  /** 再加上 `tier` 档的这一条视频之后有几条视频源；`checkGuestAsset` 要的是「加上之前有几条」，所以减一交过去 */
  const verdictFor = ({ accountId, bytes, entries, tier }) => {
    const after = videoSourcesOf([...entries, { video: true, tier }]);
    return checkGuestAsset({ accountId, bytes, countsAsVideo: true, storedVideos: after - 1 });
  };

  return {
    acquire,

    /**
     * `PUT media/<hash>/<n>`：先看尺寸（`X-Media-Size`，每一片都带，不管什么类型），再看是不是要开一个
     * 新的、报成视频的暂存。已入库（去重，数据层回 complete）或这个哈希已经在收（续传、乱序的后几片）都不算
     * 新的一条；报成图片、音频的这里不数（收尾时按文件头再认）。要数时在队里数完再写这一片，写完才放队。
     *
     * @param {{ accountId?: string, ns: string, size: number, hash: string, ext?: string, tier?: string, store: any, key: unknown }} who
     *   `ext`、`tier` 是这一片的 `X-Media-Ext`、`X-Media-Tier`
     * @param {() => Promise<void>} put 真正写这一片（回包也在里面）
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async putChunk({ accountId, ns, size, hash, ext, tier, store, key }, put, deny) {
      if (!guestQuotaApplies(accountId, ns)) return put();
      const sized = checkGuestAsset({ accountId, bytes: size });
      if (!sized.ok) return deny(DENY(sized.code));
      if (!claimedVideo(ext)) return put();
      const known = await store.chunks(hash);
      if (known.complete || known.size !== null) return put();
      const release = await acquire(key);
      try {
        const again = await store.chunks(hash);
        if (!again.complete && again.size === null) {
          const verdict = verdictFor({ accountId, bytes: size, entries: await entriesOf(store, { withStaging: true }), tier });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        return await put();
      } finally { release(); }
    },

    /**
     * `POST media/<hash>/complete`。两道：
     * 1. 收尾前按数据层登记的扩展名和档位数（不按收尾请求说的，收尾请求不带这两样）：报成视频的、加上已入库的
     *    超了就不收尾，暂存留着。暂存里找不到这一条的登记（刚好被别处删了之类）按视频办；
     * 2. 入库后按这一条**自己的文件头**再认一遍（`gate`，由调用方在数据层收尾成功、回包之前调）：是视频、连同已入库的
     *    超了，回 `{ ok: false }`，调用方把刚入库的这一条删掉、回 403。
     * 已入库的再收尾一次照旧放行。
     *
     * @param {{ accountId?: string, ns: string, hash: string, store: any, key: unknown }} who
     * @param {(gate: (() => Promise<{ ok: true } | { ok: false, status: number, error: string }>) | null) => Promise<void>} complete
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async complete({ accountId, ns, hash, store, key }, complete, deny) {
      if (!guestQuotaApplies(accountId, ns)) return complete(null);
      const release = await acquire(key);
      try {
        const known = await store.chunks(hash);
        if (known.complete || known.size === null) return await complete(null);
        const own = String(hash).toLowerCase();
        const inv = await store.inventory();
        const mine = (inv?.staging ?? []).find(e => e.hash === own);
        const tier = mine?.tier;
        if (!mine || claimedVideo(mine.ext)) {
          const verdict = verdictFor({ accountId, bytes: known.size, entries: await entriesOf(store, { withStaging: false, except: own }), tier });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        const gate = async () => {
          const head = await headOf(store, own);
          const video = head === null ? true : countsAsVideoFile(head, !mine || claimedVideo(mine.ext));
          if (sniffed.size >= SNIFF_CACHE_MAX) sniffed.clear();
          if (head !== null) sniffed.set(own, countsAsVideoFile(head, false));
          if (!video) return { ok: true };
          const verdict = verdictFor({ accountId, bytes: known.size, entries: await entriesOf(store, { withStaging: false, except: own }), tier });
          return verdict.ok ? { ok: true } : DENY(verdict.code);
        };
        return await complete(gate);
      } finally { release(); }
    },

    /**
     * 整件上传（`POST /api/media/upload/<名>`，托管下也挂着）：扩展名从文件名拿，档位没有（整件上传只有原件），
     * 报的扩展名是视频的就算；不是的，调 `peek` 从请求体里读出开头那几十个字节，按文件头认（`peek` 在尺寸过了之后才调，
 * 报超了尺寸的请求一个字节都不读就拒）。内容哈希要读完才知道，
     * 算数的只能按「再多一条」算，已存满就拒（哪怕传的是一份已有的）；不算数的只查尺寸。
     * 尺寸看 `Content-Length`（Node 不会多收），整件上传没带它的游客请求回 411。
     * 放行时回放锁函数，调用方占到回完包再放；拒了回 `{ status, error }`。
     *
     * @param {{ accountId?: string, bytes: number | null, ext?: string, peek?: () => Promise<Buffer>, store: any, key: unknown, needsLength: boolean }} who
     * @returns {Promise<{ ok: true, release: () => void } | { ok: false, status: number, error: string }>}
     */
    async whole({ accountId, bytes, ext, peek, store, key, needsLength }) {
      if (!guestQuotaApplies(accountId, 'media')) return { ok: true, release: () => {} };
      if (needsLength && bytes === null) return { ok: false, status: 411, error: 'length-required' };
      if (bytes !== null) {
        const sized = checkGuestAsset({ accountId, bytes });
        if (!sized.ok) return DENY(sized.code);
      }
      let video = claimedVideo(ext);
      if (!video && typeof peek === 'function') {
        const head = await peek();
        video = head.length ? countsAsVideoFile(head, false) : false;
      }
      if (!video) return { ok: true, release: () => {} };
      const release = await acquire(key);
      try {
        const verdict = verdictFor({ accountId, bytes: bytes ?? 0, entries: await entriesOf(store, { withStaging: true }), tier: 'original' });
        if (!verdict.ok) { release(); return DENY(verdict.code); }
        return { ok: true, release };
      } catch (error) { release(); throw error; }
    },
  };
}
