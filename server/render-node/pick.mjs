/**
 * 候选挑选(设计 4.3 末段、第 7 节「公平性」,契约 B.3)。
 *
 * 排序:优先级档(`normal` 先于 `backfill`,c10a 契约第 17 节)→ 计划先于细任务 → 档内名次(整数 `priority` 降序)
 * → `source.publishedAt` 升序 → `id` 升序(按码元比较,结果与区域设置无关)。
 * 只在排头那一档里挑:还有 `normal` 可认领时一张 `backfill` 都不碰(语义「预渲染重试排在后面」)。
 * 〔裁〕(2026-09-28,主会话;笔记本 M7-A4 查出)档内也只在排头那一个整数名次里挑:锚帧段(50)还有可认领的,
 * 普通段(10)一段都不碰。原来在前 K 个里随机、不分名次,锚帧段和普通段混在一起,锚帧优先几乎不起作用。
 * 〔裁〕(2026-10-01,`claude/m7-race`;M7-A10 抢卡查出)同一档里计划任务(`kind: 'plan'`)排在细任务前面,
 * 先于整数名次:细任务要等计划切分了才有,计划排在本节点积压的细任务后面时,新改的卡要等积压做完才有任务,
 * 不会切分的纯浏览器节点在这段时间里没活可接(实测 224～295 s)。切分本身一两秒。档仍排第一,预渲染重试的计划照旧在全部 normal 之后。
 * 然后在这一名次的前 K 个里随机取一个去认领:所有节点都抢第一名的话会互相撞出一串 `taken`。
 * 给了 `lastProjectId` 时,同优先级里先换一个项目(多项目共用一台渲染主机时的轮转)。
 *
 * 纯函数;随机源由调用方注入,测试可以固定。
 */

const priorityOf = task => (Number.isFinite(task?.priority) ? task.priority : 0);
/** 优先级档:只有 `'backfill'` 排后面;缺省、整数、`'normal'` 都是 normal(旧客户端不带这一项) */
const bandOf = task => (task?.priority === 'backfill' ? 1 : 0);
/** 同一档里计划任务先于细任务(〔裁〕见文件头) */
const classOf = task => (task?.kind === 'plan' ? 0 : 1);
// 没有发布时刻的(还没进过队列的 TaskInput)排在同优先级的最后
const publishedAtOf = task => (Number.isFinite(task?.source?.publishedAt) ? task.source.publishedAt : Infinity);
const idOf = task => String(task?.id ?? '');

function compare(a, b) {
  const byBand = bandOf(a) - bandOf(b);
  if (byBand) return byBand;
  const byClass = classOf(a) - classOf(b);
  if (byClass) return byClass;
  const byPriority = priorityOf(b) - priorityOf(a);
  if (byPriority) return byPriority;
  const pa = publishedAtOf(a), pb = publishedAtOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ia = idOf(a), ib = idOf(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** 新数组,不改入参。 */
export function rankCandidates(tasks) {
  return [...(tasks ?? [])].sort(compare);
}

/** → 任务或 `null`。`random()` 取值 `[0, 1)`。 */
export function pickCandidate(tasks, { k = 4, random = Math.random, lastProjectId = null } = {}) {
  if (!tasks?.length) return null;
  const ranked = rankCandidates(tasks);
  // 只在排头那一档、排头那一类(计划 / 细任务)、排头那一个整数名次里挑(normal 还有就不碰 backfill;锚帧段 50 还有就不碰普通段 10,〔裁〕见文件头)
  const head = bandOf(ranked[0]);
  const headClass = classOf(ranked[0]);
  const headRank = priorityOf(ranked[0]);
  const top = ranked.filter(task => bandOf(task) === head && classOf(task) === headClass && priorityOf(task) === headRank).slice(0, Math.max(1, Math.floor(Number(k) || 0)));
  let candidates = top;
  if (lastProjectId != null) {
    const headPriority = priorityOf(top[0]);
    const rotated = top.filter(task => priorityOf(task) === headPriority && task.source?.projectId !== lastProjectId);
    if (rotated.length) candidates = rotated;
  }
  const index = Math.floor(random() * candidates.length);
  return candidates[Math.min(candidates.length - 1, Math.max(0, index))] ?? null;
}
