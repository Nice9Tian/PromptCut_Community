/**
 * 卡片代码身份(C6.6 c66-host-cards):用户卡、改动层里改过的卡不再进全局代码版本(`frame-code.mjs`),
 * 改为「这张卡的代码」单独算一个身份,用在三处:
 *
 *   1. **任务要求**:用到这些卡的细任务在 `requires.cardSources` 里写 `{ [cardId]: 身份 }`(`split.mjs`,契约 B.4);
 *   2. **节点能力**:节点的 `cardSourceVersions[cardId]` 回本机此刻这张卡的身份,认领时由 `filter.mjs` 规则 1 比对,
 *      本机没有这份代码(没有这张卡,或版本不同)就不认领、不报错;装上之后下一拍就能认领;
 *   3. **整场景键**:`frameIdentity` 的 `code` = 全局代码版本 + 本项目用到的这些卡的身份(`cardEntryCode`)。
 *      全局代码版本不再覆盖用户卡,整场景的帧库、本地档的内容键(`<entry.key>/<共享键>`)靠这一段区分卡片代码。
 *      共享档的键本来就带这张卡的源码版本(`card-identity.mjs` 的 `sourceVersion`),不受影响。
 *
 * 身份怎么算由调用方注入(`identityOf(cardId) → { version, custom } | null`,`vite-plugin-cards.ts` 的
 * `cardCodeIdentity`:定义文件加它一路 import 到的卡片 / 部件文件,改动层优先,换行统一成 LF)。
 * `custom` 为真的卡(用户卡,或闭包里有改动层文件的卡)才进任务要求与整场景键;没改过的内置卡由全局代码版本覆盖。
 *
 * 缓存:身份按卡缓存,卡片源码一变(`card-overrides.mjs` 的 `onCardSourceChange`,在 Vite 自己作废模块之后才发)
 * 整表清空、`epoch` 加一。刚变过的一小段时间(`settleMs`)里节点一张卡也不报(认领侧宁可晚一拍):
 * 新写进来的卡要等 Vite 的文件监听把模块作废之后,预渲染间载入的才是新代码,早认领就会按旧代码渲。
 *
 * 只用 Node 内置模块。
 */
import { createHash } from 'node:crypto';

/** 卡片源码变了之后,多久之内节点不报任何卡的身份(见文件头) */
export const CARD_CODE_SETTLE_MS = 1500;

/**
 * 项目用到的卡片 id(升序):所有剪辑(激活的 `tracks`、停放的 `cuts[].tracks`)里片段的 `cardId`,
 * 以及卡片图节点(`cardNodes`,数组或对象)的 `cardId`。口径同页面的 `projectCardIds`(`src/editor/sync/cardSync.ts`)
 * 去掉归属表那一项(归属表是本机的旁表,不属于这一版项目)。
 */
export function projectCardIds(project) {
  const ids = new Set();
  const scan = (tracks) => {
    for (const track of Array.isArray(tracks) ? tracks : []) {
      for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
        if (typeof clip?.cardId === 'string' && clip.cardId) ids.add(clip.cardId);
      }
    }
  };
  scan(project?.tracks);
  for (const cut of Array.isArray(project?.cuts) ? project.cuts : []) scan(cut?.tracks);
  const nodes = project?.cardNodes;
  const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === 'object' ? Object.values(nodes) : [];
  for (const node of list) if (typeof node?.cardId === 'string' && node.cardId) ids.add(node.cardId);
  return [...ids].sort();
}

/** 对象按键排序后的稳定 JSON(只处理 `{ string: string }`) */
const stableMap = (map) => JSON.stringify(Object.keys(map).sort().map((key) => [key, map[key]]));

/**
 * 整场景键的 `code`:全局代码版本,后面接本项目用到的定制卡身份的摘要。没有定制卡时就是全局代码版本本身。
 * @param {string} globalCode  `frameCode(root)`
 * @param {Record<string, string>} versions  `{ cardId: 身份 }`(`customVersions` 的结果)
 */
export function cardEntryCode(globalCode, versions) {
  const map = versions && typeof versions === 'object' ? versions : {};
  if (Object.keys(map).length === 0) return globalCode;
  return `${globalCode}:cards:${createHash('sha256').update(stableMap(map)).digest('hex').slice(0, 32)}`;
}

/**
 * @param {object} options
 * @param {(cardId: string) => ({ version: string, custom: boolean } | null | undefined)} options.identityOf
 *   回 undefined 表示算法还没就绪,不缓存
 * @param {() => number} [options.now]
 * @param {number} [options.settleMs]
 */
export function createCardCodeIndex({ identityOf, now = Date.now, settleMs = CARD_CODE_SETTLE_MS } = {}) {
  if (typeof identityOf !== 'function') throw new TypeError('createCardCodeIndex:identityOf 必须是函数');
  /** cardId → { version, custom } | null */
  const cache = new Map();
  let epoch = 0;
  let changedAt = -Infinity;

  function identity(cardId) {
    if (typeof cardId !== 'string' || !cardId) return null;
    if (cache.has(cardId)) return cache.get(cardId);
    let got;
    try { got = identityOf(cardId); } catch { got = null; }
    // undefined = 算法还没注入(卡片插件还没起来):不记缓存,下次再问
    if (got === undefined) return null;
    const value = got && typeof got.version === 'string' && got.version ? { version: got.version, custom: got.custom === true } : null;
    cache.set(cardId, value);
    return value;
  }

  /** 这些卡里定制卡(用户卡、改过的卡)的 `{ cardId: 身份 }`;找不到定义的卡不列(交给全局代码版本与执行器的核对) */
  function customVersions(cardIds) {
    const out = {};
    for (const id of cardIds ?? []) {
      const got = identity(id);
      if (got?.custom) out[id] = got.version;
    }
    return out;
  }

  const settled = () => now() - changedAt >= settleMs;

  /**
   * 节点描述里的 `cardSourceVersions`(契约 B.2 的 `Record<cardId, string[]>`):取哪张卡就当场算哪张。
   * 卡片源码刚变过、还没稳下来时一律回空数组(见文件头)。
   */
  const view = new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      if (!settled()) return [];
      const got = identity(key);
      return got ? [got.version] : [];
    },
    has(_target, key) { return typeof key === 'string'; },
  });

  return {
    identity,
    customVersions,
    /** 项目用到的定制卡:`{ cardId: 身份 }` */
    projectVersions: (project) => customVersions(projectCardIds(project)),
    /** 卡片源码变了:清缓存、`epoch` 加一、重新计稳定期 */
    invalidate() {
      cache.clear();
      epoch += 1;
      changedAt = now();
    },
    /** 马上要改卡片文件(主机装同步来的卡之前调):只重新计稳定期 */
    touch() { changedAt = now(); },
    settled,
    get epoch() { return epoch; },
    view,
  };
}
