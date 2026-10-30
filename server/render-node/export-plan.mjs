/**
 * 导出专用的逐帧位图(`../export-frames.mjs`)在节点编排这一层要的几样:认任务、认计划、切分给的名次、计划完成时回给页面的索引。
 * 纯函数,不引文件系统、不引 `node:crypto`(`local-node.mjs`、`split.mjs` 引它)。
 */

/** 导出位图任务的名次:用户正等着导出,排在锚帧(50)、稀疏流(30)、普通任务(10)前面 */
export const EXPORT_FRAMES_PRIORITY = 60;
/** 计划完成时回给页面的索引的版本 */
export const EXPORT_INDEX_VERSION = 1;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 这个任务(入站任务、TaskView、sink 收到的引用)是不是导出位图任务:流任务,`input.exportFrames` 为真 */
export const isExportFramesTask = task => isObj(task) && task.kind === 'stream' && isObj(task.input) && task.input.exportFrames === true;

/** 清单计划是不是只为导出发的(`input.exportOnly: true`):只切导出位图任务,不切快照、不切轨道流、不写层表 */
export const isExportOnlyPlan = task => isObj(task) && task.kind === 'plan' && isObj(task.input) && task.input.exportOnly === true;

/**
 * 只为导出的计划完成时回给页面的索引(随 `task.complete` 的 `result.exportIndex`,页面从 `task.done` 读):
 *
 *   { v, projectRev, streams: [{ clipId, kind, plane, solo?, resultKey, envFingerprint, originFrame, lastFrame, lastSegment, segmentsPerTask,
 *                                fps, rect, offset, inputSig?, tasks }], unsupported: [{ clipId, reason }] }
 *
 * `tasks`:这条流的每一份导出位图任务原样带上(发布时的那一份)。页面等清单的时候隔一会儿把还没到的任务原样再发布一次:
 * 回包里的状态告诉它任务失败了没有(失败的不会再有通知);任务已经不在了(页面断线太久,订阅被清、任务被删)就此重建。
 *
 * `streams` 只列任务全部发布成功的那几条(每条流的每一段任务都在 `published` 里);没发全的记进 `unsupported`(`publish-failed`)。
 * `projectRev` 是切分实际按的那一版(项目往前走了时不是计划指的那一版);页面拿 `inputSig` 和自己手里那一版项目算的比。
 */
export function exportIndexOf({ exportStreams = [], exportUnsupported = [], published = [], projectRev = null, segmentsPerTask }) {
  const per = Math.max(1, Math.floor(Number(segmentsPerTask) || 0) || 8);
  const byKey = new Map();
  for (const task of Array.isArray(published) ? published : []) {
    if (!isExportFramesTask(task) || typeof task.input.exportKey !== 'string') continue;
    const list = byKey.get(task.input.exportKey) ?? [];
    list.push(task);
    byKey.set(task.input.exportKey, list);
  }
  const streams = [];
  const unsupported = (Array.isArray(exportUnsupported) ? exportUnsupported : [])
    .filter(item => isObj(item) && typeof item.clipId === 'string' && item.clipId)
    .map(item => ({ clipId: item.clipId, reason: typeof item.reason === 'string' && item.reason ? item.reason : 'unknown' }));
  for (const stream of Array.isArray(exportStreams) ? exportStreams : []) {
    if (!isObj(stream) || typeof stream.clipId !== 'string' || typeof stream.exportKey !== 'string') continue;
    const tasks = byKey.get(stream.exportKey) ?? [];
    const want = Math.floor(stream.lastSegment / per) + 1;
    const first = tasks[0];
    if (!first || tasks.length < want) { unsupported.push({ clipId: stream.clipId, reason: 'publish-failed' }); continue; }
    streams.push({
      clipId: stream.clipId, kind: stream.kind, plane: stream.plane, ...(stream.solo ? { solo: stream.solo } : {}),
      resultKey: first.resultKey, envFingerprint: first.requires?.envFingerprint ?? null,
      originFrame: stream.originFrame, lastFrame: stream.lastFrame, lastSegment: stream.lastSegment, segmentsPerTask: per,
      fps: stream.fps, rect: stream.rect, offset: stream.offset ?? null,
      ...(stream.inputSig ? { inputSig: stream.inputSig } : {}),
      tasks: tasks.map(t => ({ id: t.id, kind: t.kind, resultKey: t.resultKey, range: t.range, source: t.source, input: t.input, weight: t.weight, requires: t.requires, priority: t.priority })),
    });
  }
  return { v: EXPORT_INDEX_VERSION, projectRev: Number.isSafeInteger(projectRev) ? projectRev : null, streams, unsupported };
}
