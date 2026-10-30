/**
 * 隔离单卡工程:把一张独立卡单独渲出来用的项目变换 —— 桌面预渲染(`server/frame-pipeline.mjs` 的
 * `FramePipeline#isolatedCardProject`)与在线页面的纯浏览器节点(后台舞台生成快照,M7 契约第 4.3 节)共用的**唯一一份**。
 *
 * 为什么放在 kernel、写成 .mjs:服务端直接 import(Node 读不了 .ts),页面构建也引它;纯数据变换,不引任何模块,
 * 没有 `node:` 内置模块。两边各写一遍的话,改一处漏一处不报错,只是浏览器生成的快照与桌面的悄悄对不上。
 *
 * 目标片段平移到 `-phase` 起(`phase = sampling.phase.numerator / denominator`),是唯一可见输出;同轨的兄弟片段挪进一条
 * 隐藏的源轨(素材效果卡输入还要能解到),别的轨一律隐藏、只作源。`control` 要 `clipId`、`start`、`end`、`count`、`sampling.phase`。
 */
export function isolatedCardProject(project, control) {
  const targetId = control.clipId;
  const phase = Number(control.sampling.phase.numerator) / Number(control.sampling.phase.denominator);
  const duration = control.end - control.start;
  let found = false;
  const tracks = [];
  const sourceTrackIds = new Set((project.tracks || []).map(track => track.id));
  for (const track of project.tracks || []) {
    const target = (track.clips || []).find(clip => clip.id === targetId);
    if (target) {
      found = true;
      // The target is the only visible output.  Siblings can nevertheless be
      // raw graph inputs (especially multi-input 素材效果卡), so retain
      // them in a separate hidden source track rather than dropping them.
      tracks.push({ ...structuredClone(track), hidden: false, sourceOnly: false,
        clips: [{ ...structuredClone(target), start: -phase, end: duration - phase }] });
      const siblings = (track.clips || []).filter(clip => clip.id !== targetId);
      if (siblings.length) {
        let id = `__pc_source_${track.id}`; let suffix = 1;
        while (sourceTrackIds.has(id)) id = `__pc_source_${track.id}_${suffix++}`;
        sourceTrackIds.add(id);
        tracks.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(siblings) });
      }
      continue;
    }
    // Keep original clips available to 素材效果卡 source resolution without
    // letting them paint.  The browser's source-only tracks are deliberately
    // explicit rather than attempting to infer graph dependencies here.
    tracks.push({ ...structuredClone(track), hidden: true, sourceOnly: true });
  }
  if (!found) throw new Error(`Independent card clip is missing: ${targetId}`);
  return { ...structuredClone(project), duration: Math.max(duration, control.count / (Number(project.fps) || 30)), tracks, _cardRender: { mode: 'final', frames: {}, missing: {} } };
}
