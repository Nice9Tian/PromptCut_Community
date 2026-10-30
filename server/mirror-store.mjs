import { applyProjectPatch, projectHash } from "../src/render/changedClips.mjs";

/**
 * 镜像的存储本体(A7)。纯逻辑、没有 vite / http 依赖 —— `server/vite-plugin-mirror.ts`
 * 只是把它接到中间件上,两个进程(编辑器 / 预渲染)各挂一份。
 *
 * # 键是 `{session, localRev}`,不是「最新的那份」
 *
 * 帧请求的 body 里只有这个键(`frameClient.ts`)。留最近 8 版是因为请求和推送会交错:
 * 页面推到第 12 版时,一个 2 秒前发出的取帧请求还在路上,它要的是第 9 版 ——
 * 只留最新一份的话那个请求就得整份重来。8 版够覆盖一次拖动里在飞的全部请求。
 *
 * # 两种拒收
 *
 * - **stale**:同一个 session 里 `localRev` 不大于已存的最大号。页面那边一次只推一个,
 *   这里再兜一道:两次推送乱序到达时旧的盖不掉新的。回 200 + `stale: true`,不是错。
 * - **resync**(409):补丁的基线滑出了 8 版窗口,或者应用完哈希和页面算的对不上。
 *   页面收到就整份重推。哈希这一道是**唯一**能发现「两层 diff 自己写错了」的地方,
 *   没有它,镜像会带着一个悄悄错掉的项目一直服务下去。
 */

/** 每个 session 留几版 */
export const MAX_VERSIONS = 8;
/** 一次播放头推送里最多带几条 `wanted`(C4) */
export const MAX_WANTED = 8;

export function createMirrorStore() {
  /** session -> { versions: Version[](按 localRev 升序), maxRev } */
  const sessions = new Map();
  /** session -> { t, playing, at } */
  const playheads = new Map();
  let latestSession = null;
  let latestPlayheadSession = null;

  function sessionOf(session) {
    let s = sessions.get(session);
    if (!s) { s = { versions: [], maxRev: -Infinity }; sessions.set(session, s); }
    return s;
  }

  function store(session, localRev, project) {
    const s = sessionOf(session);
    const hash = projectHash(project);
    const version = { session, localRev, project, hash, at: Date.now() };
    s.versions.push(version);
    s.versions.sort((a, b) => a.localRev - b.localRev);
    while (s.versions.length > MAX_VERSIONS) s.versions.shift();
    if (localRev > s.maxRev) { s.maxRev = localRev; latestSession = session; }
    return version;
  }

  /** 整份推送 */
  function pushFull({ session, localRev, project }) {
    if (!session) throw new Error("缺少 session");
    if (!project || !Array.isArray(project.tracks)) throw new Error("缺少 project");
    const rev = Number(localRev) || 0;
    const s = sessions.get(session);
    if (s && s.versions.length && rev <= s.maxRev) return { status: "stale", localRev: s.maxRev, hash: s.versions[s.versions.length - 1].hash };
    const v = store(session, rev, project);
    return { status: "ok", localRev: v.localRev, hash: v.hash };
  }

  /**
   * 两层 diff。`hash` 是页面算的 `projectHash`;给了就校验,对不上回 resync。
   */
  function pushDiff({ session, fromLocalRev, toLocalRev, hash, patch }) {
    if (!session) throw new Error("缺少 session");
    const to = Number(toLocalRev) || 0;
    const from = Number(fromLocalRev) || 0;
    const s = sessions.get(session);
    if (!s || !s.versions.length) return { status: "resync", reason: "session", localRev: null };
    if (to <= s.maxRev) return { status: "stale", localRev: s.maxRev, hash: s.versions[s.versions.length - 1].hash };
    const base = s.versions.find((v) => v.localRev === from);
    // 基线滑出了 8 版窗口:补不回来,只能整份重推
    if (!base) return { status: "resync", reason: "window", localRev: s.maxRev };
    let project;
    try { project = applyProjectPatch(base.project, patch); }
    catch (e) { return { status: "resync", reason: "apply", error: e?.message || String(e), localRev: s.maxRev }; }
    const got = projectHash(project);
    if (hash && got !== hash) return { status: "resync", reason: "hash", localRev: s.maxRev, hash: got, expected: hash };
    const v = store(session, to, project);
    return { status: "ok", localRev: v.localRev, hash: v.hash };
  }

  /**
   * 补一版进来,**不走 `stale` 那道闸**。只给「回拉」用(预渲染进程手里缺哪一版就去
   * 编辑器要哪一版):它要的那一版按定义是旧的,走 `pushFull` 会被当成乱序推送挡掉,
   * 于是转发丢一次就再也补不回来 —— 帧请求只能一路 409 下去。
   * 已经有这一版就原样返回,不重复存。
   */
  function insert({ session, localRev, project }) {
    if (!session) throw new Error("缺少 session");
    if (!project || !Array.isArray(project.tracks)) throw new Error("缺少 project");
    const rev = Number(localRev) || 0;
    const have = getMirror(session, rev);
    if (have) return { status: "ok", localRev: have.localRev, hash: have.hash };
    const s = sessionOf(session);
    // 比窗口里最旧的还旧:存进去也会当场被挤掉,不如直说没接住
    if (s.versions.length >= MAX_VERSIONS && rev < s.versions[0].localRev) {
      return { status: "resync", reason: "window", localRev: s.maxRev };
    }
    const v = store(session, rev, project);
    return { status: "ok", localRev: v.localRev, hash: v.hash };
  }

  /** 按键取。不给 `localRev` 就是这个 session 的最新一版 */
  function getMirror(session, localRev) {
    const s = sessions.get(session);
    if (!s || !s.versions.length) return null;
    if (localRev === undefined || localRev === null || localRev === "") return s.versions[s.versions.length - 1];
    const rev = Number(localRev);
    return s.versions.find((v) => v.localRev === rev) || null;
  }

  /** 当前编辑页 session 的最新一版(Agent 取的就是它) */
  function latestMirror() {
    if (latestSession === null) return null;
    const s = sessions.get(latestSession);
    return s && s.versions.length ? s.versions[s.versions.length - 1] : null;
  }

  /** 每个 session 的最新一版,给「预渲染重启后补推」用 */
  function allLatest() {
    const out = [];
    for (const s of sessions.values()) if (s.versions.length) out.push(s.versions[s.versions.length - 1]);
    return out;
  }

  /**
   * C4 的 `wanted`:页面每帧把「播放头附近现在缺哪些层」报上来,预渲染进程在
   * 4 帧批次的边界读它、把含这些帧的批提到前面。
   *
   * **最多 8 条**(C4 原文),多的截掉:它是一份提示,不是队列 —— 报得再多也只
   * 影响下一批往哪儿跳,而每 100 ms 就会来一份新的。坏条目直接丢,不让一个
   * NaN 把整份提示作废。
   */
  function normalizeWanted(value) {
    if (!Array.isArray(value)) return undefined;
    const out = [];
    for (const item of value) {
      const clipId = typeof item?.clipId === "string" ? item.clipId : "";
      const frame = Number(item?.frame);
      if (!clipId || !Number.isInteger(frame) || frame < 0) continue;
      out.push({ clipId, frame });
      if (out.length >= MAX_WANTED) break;
    }
    return out.length ? out : undefined;
  }

  function setPlayhead(session, t, playing, wanted) {
    if (!session) throw new Error("缺少 session");
    const list = normalizeWanted(wanted);
    const previous = playheads.get(session);
    const entry = { session, t: Number.isFinite(Number(t)) ? Number(t) : 0, playing: !!playing, at: Date.now(),
      // 只带 `wanted` 的那一趟(C4 的 100 ms 节流路)不该把上一次报的 t / playing 冲掉,
      // 但 `wanted` 本身每次都以最新的为准;这一趟没带就沿用上一次的,免得拖动中
      // 两条路交替把提示抹掉。
      wanted: list ?? previous?.wanted };
    playheads.set(session, entry);
    latestPlayheadSession = session;
    return entry;
  }

  /** 当前编辑页 session 的播放头;它还没报过就退回最近报过的那个 */
  function latestPlayhead() {
    if (latestSession !== null && playheads.has(latestSession)) return playheads.get(latestSession);
    return latestPlayheadSession !== null ? playheads.get(latestPlayheadSession) || null : null;
  }

  return {
    pushFull, pushDiff, insert, getMirror, latestMirror, allLatest, setPlayhead, latestPlayhead,
    /** 测试用:看一个 session 里现在留着哪些版本号 */
    revsOf: (session) => (sessions.get(session)?.versions || []).map((v) => v.localRev),
    clear: () => { sessions.clear(); playheads.clear(); latestSession = null; latestPlayheadSession = null; },
  };
}
