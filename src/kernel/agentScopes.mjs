/**
 * 多 Agent 的「范围」(计划 `docs/plan/agent-workflow-plan.md` A3;语义 `user-workflow.md`「多 Agent」「保护」)。
 *
 * 范围写成「剪辑X->序列X」,多个用逗号分开。这里只放页面与服务端共用的纯逻辑:
 *   - `diffScopes(before, after)`:一次改动前后,哪些「剪辑->序列」变了(激活的剪辑,以及被就地改了的停放剪辑);
 *   - `scopeOverlaps(a, b)` / `overlappingScopes(written, declared)`:两个范围是否重叠(同名,或一方是另一方的上级);
 *   - `splitScopes(s)`:把声明的文字拆成一条条范围;
 *   - `parkedCutsIndex(p)` / `otherCutsHint(p)`:停放剪辑里的片段索引,Agent 先读的 get_project / list_cuts / 工具回包用(文件末尾)。
 *
 * 为什么是 `.mjs`:服务端(`server/agent/agent-board.mjs`,由文档服务的提交流喂)和页面(没接文档服务时,
 * 页面执行器在工具调用前后算)用同一份口径,Node 直接 import 不了 `.ts`。
 *
 * 只看项目里的 `tracks`(激活那条剪辑的内容住在 Project 上)与 `cuts` / `activeCutId`;序列的 `clips` 数组换了引用
 * 就算改了 —— store 每次改动都产新数组,文档服务的操作引擎(写时复制)也只换改到的那一路,没改到的引用不变。
 */

/** 当前剪辑的名字;项目没有 cuts(旧文件)时就是「剪辑1」 */
export function cutNameOf(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  const hit = cuts.find((c) => c && c.id === project?.activeCutId) ?? cuts[0];
  return typeof hit?.name === 'string' && hit.name ? hit.name : '剪辑1';
}

const tracksOf = (p) => (Array.isArray(p?.tracks) ? p.tracks.filter((t) => t && typeof t === 'object') : []);

/**
 * 一次改动前后,项目里哪些「剪辑->序列」变了。切了剪辑就整条剪辑算作范围;只调了序列的上下顺序记「剪辑->序列顺序」;
 * 主题变了记「全局主题」。别的(项目名、效果库、卡片)不算范围。
 */
export function diffScopes(before, after) {
  if (!before || !after || before === after) return [];
  const out = [];
  if ((before.activeCutId ?? null) !== (after.activeCutId ?? null)) return [cutNameOf(after)];
  const name = cutNameOf(after);
  const prev = new Map(tracksOf(before).map((t) => [t.id, t]));
  for (const t of tracksOf(after)) {
    const b = prev.get(t.id);
    if (!b || b.clips !== t.clips || b.name !== t.name || !!b.hidden !== !!t.hidden || !!b.muted !== !!t.muted || !!b.locked !== !!t.locked) {
      out.push(`${name}->${t.name}`);
    }
  }
  for (const b of tracksOf(before)) {
    if (!tracksOf(after).some((t) => t.id === b.id)) out.push(`${name}->${b.name}(已删)`);
  }
  // 停放的剪辑里被就地改了(Agent 不切换剪辑直接改它的片段,store/core.ts 的 runInCutScope)也算范围:
  // 内容住在 cuts[].tracks 里,逐条停放的剪辑按同一口径比序列
  const beforeCuts = Array.isArray(before.cuts) ? before.cuts : [];
  for (const c of Array.isArray(after.cuts) ? after.cuts : []) {
    if (!c || c.id === after.activeCutId || !Array.isArray(c.tracks)) continue;
    const bc = beforeCuts.find((x) => x && x.id === c.id);
    if (!bc || !Array.isArray(bc.tracks)) continue;
    const cname = typeof c.name === 'string' && c.name ? c.name : c.id;
    const bprev = new Map(tracksOf({ tracks: bc.tracks }).map((t) => [t.id, t]));
    for (const t of tracksOf(c)) {
      const b = bprev.get(t.id);
      if (!b || b.clips !== t.clips || b.name !== t.name || !!b.hidden !== !!t.hidden || !!b.muted !== !!t.muted || !!b.locked !== !!t.locked) out.push(`${cname}->${t.name}`);
    }
    for (const b of tracksOf({ tracks: bc.tracks })) {
      if (!tracksOf(c).some((t) => t.id === b.id)) out.push(`${cname}->${b.name}(已删)`);
    }
  }
  if (out.length === 0) {
    const order = (p) => tracksOf(p).map((t) => t.id).join('\n');
    if (order(before) !== order(after)) out.push(`${name}->序列顺序`);
  }
  if (out.length === 0 && before.theme !== after.theme && JSON.stringify(before.theme ?? null) !== JSON.stringify(after.theme ?? null)) {
    out.push('全局主题');
  }
  return out;
}

/** 声明的文字 → 一条条范围(逗号、分号、顿号分开;「(已删)」这类后缀去掉再比) */
export function splitScopes(text) {
  if (typeof text !== 'string') return [];
  return text.split(/[,,;;、]/).map((x) => x.trim()).filter(Boolean);
}

const bare = (s) => s.replace(/[((]已删[))]$/, '').trim();

/** 两段范围文字有没有重叠:同名,或一方是另一方的上级(「剪辑1」包含「剪辑1->序列2」) */
export function scopeOverlaps(a, b) {
  const xs = splitScopes(a).map(bare);
  const ys = splitScopes(b).map(bare);
  return xs.some((x) => ys.some((y) => x === y || x.startsWith(y + '->') || y.startsWith(x + '->')));
}

/** 写到的范围里,落在声明范围之内的那几条 */
export function overlappingScopes(written, declared) {
  const list = Array.isArray(written) ? written : splitScopes(written);
  return list.filter((w) => scopeOverlaps(w, declared));
}

/* ---------- 停放剪辑的片段索引(Agent 先读的 get_project / list_cuts / 工具回包用) ---------- */

/**
 * 停放剪辑的片段索引:给 Agent 先读的那几样东西(get_project、list_cuts、工具回包里的 timeline)用。
 *
 * 为什么有它:这些读出来的 tracks / timeline 都只是**激活剪辑**的。模型要改别的剪辑里的片段,先得有 clipId;
 * 没有索引时,它想「看进」剪辑2 的办法就是 switch_cut,而激活的剪辑是所有成员共享的状态,切换会让每个人的界面
 * 一起翻(`product/project-model.md` 「剪辑」,2026-10-21 用户定:按片段 id 改属性的工具就地改别的剪辑里的片段,不切换)。
 * 线上 2026-10-21:工具说明与系统提示词都写了「不用切」,模型仍 switch_cut -> update_clip -> switch_cut。
 * 把 clipId 直接摆在它第一眼读到的地方,切换就失去了理由。
 *
 * 放在本文件(而不是单开一个 .mjs)是因为 Agent 服务的独立入口只许经载入缝 `server/agent/ssr-host.mjs` 引用 `src/`,
 * 而本文件已经是那条缝转出、也随服务一起部署的共享纯逻辑(`accept-018-rest-ssr-seam.test.mjs` 的棘轮)。
 * 页面侧 handler 与服务端的 projectView 共用,不经 TS。只读,不碰 store。
 * 输出有上限(总片段数、每条剪辑片段数),超出的给计数并指向 list_cuts({cutId}) —— 那一个给整条剪辑。
 */

/** 默认上限:总共最多列这么多片段 / 每条剪辑最多这么多 / 标签最长这么多字 */
export const CUTS_INDEX_LIMITS = Object.freeze({ maxClips: 60, perCutMax: 30, labelMax: 24 });

/** 写给模型看的一句话。get_project / list_cuts 的索引里带一份 */
export const PARKED_EDIT_NOTE =
  "这些是没有激活的剪辑里的片段。改它们不用 user_interface_switch_cut:把 clipId 直接交给 update_clip / set_clip / get_clip / " +
  "set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted,它们就地改那条剪辑里的片段。" +
  "看它们的画面用 see_frames 传 cutId,也不用切。激活的剪辑是所有成员共享的,user_interface_switch_cut 会让每个人的界面一起翻,只有要在别的剪辑里新增 / 删除 / 切分 / 复制片段时才切。" +
  "trackId 要用那条剪辑自己的序列 id(下面每个片段带着)。";

const round2 = (n) => Math.round(n * 100) / 100;

function activeCutIdForIndex(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c?.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/**
 * @param {object} project
 * @param {{ maxClips?: number, perCutMax?: number, labelMax?: number, cardName?: (cardId: string) => string | undefined }} [opts]
 *   `cardName`:页面侧有卡片注册表时传,片段多带一个卡片的显示名,方便按「粒子背景」这类说法对上号
 * @returns {null | {
 *   activeCutId: string, note: string,
 *   cuts: { cutId: string, name: string, duration: number, clipCount: number, trackCount: number,
 *           clips: object[], omitted?: number, more?: string }[]
 * }} 项目只有一条剪辑(没有停放的)时返回 null
 */
export function parkedCutsIndex(project, opts = {}) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (cuts.length < 2) return null;
  const activeCutId = activeCutIdForIndex(project);
  const maxClips = Math.max(0, opts.maxClips ?? CUTS_INDEX_LIMITS.maxClips);
  const perCutMax = Math.max(0, opts.perCutMax ?? CUTS_INDEX_LIMITS.perCutMax);
  const labelMax = Math.max(1, opts.labelMax ?? CUTS_INDEX_LIMITS.labelMax);
  let budget = maxClips;
  const out = [];
  for (const c of cuts) {
    if (!c || c.id === activeCutId) continue;
    const tracks = Array.isArray(c.tracks) ? c.tracks : [];
    const flat = [];
    for (const tr of tracks) for (const cl of Array.isArray(tr?.clips) ? tr.clips : []) flat.push([tr, cl]);
    const take = Math.min(perCutMax, budget, flat.length);
    budget -= take;
    const clips = flat.slice(0, take).map(([tr, cl]) => {
      const label = typeof cl.label === "string" && cl.label ? (cl.label.length > labelMax ? `${cl.label.slice(0, labelMax)}…` : cl.label) : undefined;
      const name = cl.cardId && opts.cardName ? opts.cardName(cl.cardId) : undefined;
      return {
        id: cl.id,
        trackId: tr.id,
        ...(cl.cutId ? { cutSegmentOf: cl.cutId } : cl.cardId ? { cardId: cl.cardId } : cl.mediaId ? { mediaId: cl.mediaId } : null),
        ...(name ? { cardName: name } : null),
        ...(label ? { label } : null),
        start: round2(cl.start),
        end: round2(cl.end),
      };
    });
    const omitted = flat.length - clips.length;
    out.push({
      cutId: c.id,
      name: c.name,
      duration: round2(typeof c.duration === "number" && c.duration > 0 ? c.duration : 30),
      trackCount: tracks.length,
      clipCount: flat.length,
      clips,
      ...(omitted > 0 ? { omitted, more: `还有 ${omitted} 个片段没列出,用 list_cuts({ cutId: "${c.id}" }) 看这条的全部` } : null),
    });
  }
  return { activeCutId, note: PARKED_EDIT_NOTE, cuts: out };
}

/**
 * 工具回包里 timeline 旁边的轻量提示:有哪些别的剪辑、各有几个片段。不列片段(每次回包都带,要省),
 * 指路到 get_project 的 parkedCuts / list_cuts({ cutId })。没有别的有内容的剪辑时返回 null。
 * @param {object} project
 * @returns {null | { cuts: { cutId: string, name: string, clipCount: number }[], hint: string }}
 */
export function otherCutsHint(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (cuts.length < 2) return null;
  const activeCutId = activeCutIdForIndex(project);
  const rest = [];
  for (const c of cuts) {
    if (!c || c.id === activeCutId) continue;
    let n = 0;
    for (const tr of Array.isArray(c.tracks) ? c.tracks : []) n += Array.isArray(tr?.clips) ? tr.clips.length : 0;
    if (n > 0) rest.push({ cutId: c.id, name: c.name, clipCount: n });
  }
  if (!rest.length) return null;
  return {
    cuts: rest,
    hint: "上面的 timeline 只是激活剪辑的。别的剪辑里的片段不用 user_interface_switch_cut:clipId 在 get_project 的 parkedCuts 或 list_cuts({ cutId }) 里,直接交给 update_clip 等就地改;看画面用 see_frames 传 cutId。",
  };
}

/* ---------- 看别的剪辑的画面(see_frames 的 cutId;2026-10-21 用户定:看画面能指定剪辑,不用切换) ---------- */

/**
 * see_frames 带 `cutId` 时交给渲染的项目视图:把那条剪辑换成「激活」的样子(tracks / duration / transitions 换成它的内容,
 * 真正激活的那条退回条目里带着自己的内容,剪辑段的引用照常解析)。和 `src/kernel/cuts.ts` 的 `cutEditView` 同一个形状,
 * 这里是给服务端(Node 直接 import)和页面共用的纯 JS 版。
 *
 * 视图只在出这一次图时用:不进 store、不进文档同步、不改 activeCutId,谁的界面都不动。
 * 渲染端看到的就是一份普通项目,所以旧版本的渲染进程(只认 project、不认 cutId)也出得对图。
 *
 * @param {object} project 真实项目
 * @param {string | undefined | null} cutId 不给(或空串)就是当前激活的剪辑
 * @returns {{ project: object, cut: { id: string, name: string }, active: boolean, parkedT: number | null }}
 *   `parkedT`:那条剪辑上次离开时的播放头(停放条目里存的 `t`);激活的剪辑回 null(用页面播放头)
 * @throws 给了 cutId 但项目里没有这条剪辑时抛,错误信息列出现有的剪辑
 */
export function cutLookView(project, cutId) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts.filter((c) => c && typeof c === "object") : [];
  const activeId = activeCutIdForIndex(project) ?? "cut-1";
  const activeName = cuts.find((c) => c.id === activeId)?.name || "剪辑1";
  const want = typeof cutId === "string" ? cutId.trim() : "";
  if (!want || want === activeId) return { project, cut: { id: activeId, name: activeName }, active: true, parkedT: null };
  const target = cuts.find((c) => c.id === want);
  if (!target) {
    const list = cuts.length ? cuts.map((c) => `${c.name || c.id}(${c.id})`).join("、") : `${activeName}(${activeId})`;
    throw Object.assign(new Error(`找不到剪辑 ${JSON.stringify(want)};现有的:${list}。cutId 从 list_cuts 里拿,不传就看当前激活的剪辑。`), { code: "cut-not-found" });
  }
  const nextCuts = cuts.map((c) => {
    if (c.id === activeId) return { ...c, tracks: project.tracks ?? [], duration: project.duration, transitions: Array.isArray(project.transitions) ? project.transitions : [] };
    if (c.id === want) {
      const { tracks: _t, duration: _d, transitions: _x, t: _pt, ...rest } = c;
      return rest;
    }
    return c;
  });
  const view = {
    ...project,
    tracks: Array.isArray(target.tracks) ? target.tracks : [],
    duration: typeof target.duration === "number" && target.duration > 0 ? target.duration : 30,
    transitions: Array.isArray(target.transitions) ? target.transitions : [],
    cuts: nextCuts,
    activeCutId: want,
  };
  const parkedT = typeof target.t === "number" && Number.isFinite(target.t) && target.t >= 0 ? target.t : 0;
  return { project: view, cut: { id: target.id, name: target.name || target.id }, active: false, parkedT };
}
