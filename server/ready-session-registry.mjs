/**
 * 页面会话的「当前版本」登记表,住在**编辑器进程**(预渲染进程的父进程)里(Item 4 方案 A)。
 *
 * # 为什么在父进程
 *
 * 会话的当前版本只由页面的 preload 设定,而 preload 直连预渲染进程 —— 预渲染进程一崩溃重启,
 * 它手里的会话表就没了,页面那边的就绪索引再也长不出来(页面就绪之后不再发 preload)。
 * 父进程负责拉起 / 重启预渲染进程、重启后补推镜像(`repushMirror`),寿命和页面、镜像一样长,
 * 所以由它记住「每个会话最后一次被接受的 preload 是哪一版」,重启后照着**重放**一遍 preload。
 * 恢复走的仍是 preload 这一条路,「当前版本以 preload 为准」不变;页面什么都不用做。
 *
 * 这张表是易失的视图状态(按页面、按机器),不进文档服务。
 *
 * # 规则
 *
 * - 缺省会话(`''`,不带 session 的脚本 / 迁移期调用方)不登记:它没有镜像,重放不出来。
 * - 同一会话只留最大的 `localRev`(页面的 localRev 单调增;上报乱序到达时不倒退)。
 * - 按最近上报排序、封顶 `READY_REGISTRY_MAX`,超了丢最久没动的。
 * - 重放**串行**:一次只发一个 preload,等它回话再发下一个 —— 刚起来的预渲染进程不会被一齐打上来;
 *   最近活跃的会话先重放,最多 `READY_REPLAY_MAX` 个。镜像里已经没有的会话跳过;记下的那一版滑出了镜像窗口就退到该会话最新的一版。
 */

export const READY_REGISTRY_MAX = 64;
/**
 * 一次重启最多重放这么多个会话(最近活跃的那些)。登记表里可能还躺着早已关掉的标签页,
 * 全部重放会为没人看的页面排满后台预渲染;更早的会话等它自己下一次 preload。
 */
export const READY_REPLAY_MAX = 8;

export function createReadySessionRegistry({ max = READY_REGISTRY_MAX, now = () => Date.now() } = {}) {
  /** session -> { session, localRev, at };Map 的插入顺序就是最近上报的顺序 */
  const sessions = new Map();

  /** 预渲染进程接受了一次 preload。回 true = 表里的版本变了 */
  function record(session, localRev) {
    if (typeof session !== 'string' || !session) return false;
    const rev = Number(localRev);
    if (localRev === null || localRev === undefined || !Number.isFinite(rev)) return false;
    const before = sessions.get(session);
    const next = { session, localRev: before && before.localRev > rev ? before.localRev : rev, at: now() };
    sessions.delete(session);
    sessions.set(session, next);
    while (sessions.size > max) sessions.delete(sessions.keys().next().value);
    return !before || before.localRev !== next.localRev;
  }

  return {
    record,
    /** 最近上报的在前 */
    list: () => [...sessions.values()].reverse().map(item => ({ ...item })),
    drop: session => sessions.delete(session),
    size: () => sessions.size,
    clear: () => sessions.clear(),
  };
}

/**
 * 预渲染进程重启、镜像补推完之后:按登记表把每个会话的 preload 串行重放一遍。
 *
 * - `sessions`:`registry.list()` 的结果(最近活跃的在前);
 * - `resolve(session, localRev)`:镜像里这个会话能用的版本号 —— 记下的那一版还在就回它,
 *   滑出窗口了回该会话最新一版,整个会话都没了回 null(跳过);
 * - `preload({ session, localRev })`:发一次 preload,回 `{ ok, status? }`;抛错算这一个失败,接着下一个;
 * - `isCurrent()`:重放途中预渲染进程又换了一个(再次重启)就停,交给下一轮。
 *
 * 回每个会话的结果,给日志 / 测试看。
 */
export async function replayReadySessions({ sessions, resolve, preload, isCurrent = () => true, limit = READY_REPLAY_MAX }) {
  const results = [];
  for (const item of (sessions ?? []).slice(0, limit)) {
    if (!isCurrent()) { results.push({ session: item.session, skipped: 'superseded' }); break; }
    let localRev = null;
    try { localRev = resolve(item.session, item.localRev); } catch { localRev = null; }
    if (localRev === null || localRev === undefined) { results.push({ session: item.session, skipped: 'no-mirror' }); continue; }
    try {
      const out = await preload({ session: item.session, localRev });
      results.push({ session: item.session, localRev, ok: out?.ok !== false, ...(out?.status !== undefined ? { status: out.status } : {}) });
    } catch (error) {
      results.push({ session: item.session, localRev, ok: false, error: String(error?.message || error) });
    }
  }
  return results;
}
