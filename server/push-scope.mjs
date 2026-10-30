/**
 * 推送队列只推绑定项目的产物(交接文件 `HANDOFF-2026-09-29.md` 第 4 节第三条;报告 `docs/archive/agent-reports/AGENT-push-scope.md`)。
 *
 * 预渲染进程的帧库是本机所有项目共用的:同时开着的别的本机项目写进帧库的帧,也会经推送钩子进推送队列。
 * 推送队列连的是共享项目的素材服务(云端、局域网主机),别的项目的帧不该到那里 —— 素材服务的票据「只在这个项目内有效」
 * (`product/asset-service.md`「凭票据读写」),纯浏览器节点那条「不让别人的项目内容进用户的浏览器」同理。
 * 这里按「这一段属于哪个项目文档」判断进不进队:
 *
 *   - 快照本地档:`entryKey` 那一版 entry 的 `project.id`;
 *   - 快照共享档:键是内容寻址的,几个项目可能共用同一份;只要**绑定项目**里有一版 entry 的 card plan 用到这个快照键就算
 *     (内容相同,推上去也就是绑定项目自己的内容);
 *   - 轨道流:生产者手里这条流的 state 记着它属于哪一版 entry(`entryKey`);对不上时再看流的成员卡的内容键
 *     是否出现在绑定项目的 card plan 里(同上,内容寻址)。
 *   - 层表(`layers:<项目 id>`):按项目 id 直接判。
 *
 * 找不到 entry(已经被换掉、进程刚起还没有)按「不属于」算:别的项目的内容宁可留在本机,也不推错地方。
 * 已经在推送队列文件里的段不重新判(队列文件按项目分目录,里面只有这个项目的段)。
 *
 * `contentIds()` 回:
 *   - `ALL`:不限(没有共享项目的边界:本机身份连本机或自己集群的文档服务;或老路径的配置里没写项目文档 id);
 *   - `null`:还不知道(页面还没交项目文档 id)—— 判不了,回 null,由推送队列先扣着,知道了再判;
 *   - 字符串数组:只认这几个项目文档 id。
 */
export const ALL = 'all';

const controlKeyOf = (control) => control?.contentKey ?? control?.snapshotKey ?? null;

/**
 * @param {object} options
 * @param {any} options.pipeline  `FramePipeline`(读 `entries`、`streamProducer()`)
 * @param {() => (typeof ALL | string[] | null)} options.contentIds
 */
export function createPushScope({ pipeline, contentIds }) {
  if (!pipeline) throw new TypeError('createPushScope 要 pipeline');
  if (typeof contentIds !== 'function') throw new TypeError('createPushScope 要 contentIds()');
  const ids = () => {
    let v;
    try { v = contentIds(); } catch { v = null; }
    if (v === ALL) return ALL;
    if (!Array.isArray(v)) return null;
    const list = v.filter(id => typeof id === 'string' && id);
    return list.length ? list : null;
  };
  const entries = () => { try { return [...(pipeline.entries?.values?.() ?? [])]; } catch { return []; } };
  const inScope = (list, entry) => !!entry && typeof entry.project?.id === 'string' && list.includes(entry.project.id);

  /** 项目文档 id 在不在范围里:true / false / null(还不知道) */
  function acceptsProject(projectId) {
    const list = ids();
    if (list === ALL) return true;
    if (list === null) return null;
    return typeof projectId === 'string' && list.includes(projectId);
  }

  /** 推送队列的一段(`artifact-push.mjs` 的 `normalizeUnit` 之后)在不在范围里:true / false / null(还不知道) */
  function accepts(unit) {
    const list = ids();
    if (list === ALL) return true;
    if (list === null) return null;
    if (!unit || typeof unit !== 'object') return false;
    if (unit.kind === 'snapshot') {
      if (unit.tier === 'local') {
        const entry = pipeline.entries?.get?.(unit.entryKey);
        return inScope(list, entry);
      }
      const key = unit.dirKey ?? unit.resultKey;
      for (const entry of entries()) {
        if (!inScope(list, entry) || !Array.isArray(entry.cardPlan)) continue;
        if (entry.cardPlan.some(control => control && control.snapshotKey === key)) return true;
      }
      return false;
    }
    if (unit.kind === 'stream') {
      let state = null;
      try { state = pipeline.streamProducer?.()?.streams?.get?.(unit.resultKey) ?? null; } catch { state = null; }
      if (!state) return false;
      if (state.entryKey && inScope(list, pipeline.entries?.get?.(state.entryKey))) return true;
      const members = new Set((state.spec?.members ?? []).map(controlKeyOf).filter(Boolean));
      if (!members.size) return false;
      for (const entry of entries()) {
        if (!inScope(list, entry) || !Array.isArray(entry.cardPlan)) continue;
        if (entry.cardPlan.some(control => members.has(controlKeyOf(control)))) return true;
      }
      return false;
    }
    return false;
  }

  return { accepts, acceptsProject, describe: () => { const list = ids(); return list === ALL ? ALL : list === null ? 'pending' : [...list]; } };
}
