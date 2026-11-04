/**
 * Items needed by export-dedicated frame-by-frame bitmaps (`../export-frames.mjs`) at the node
 * arrangement layer: task identification, plan identification, rank assigned by splitting, and
 * index returned to the page upon plan completion.
 * Pure function, does not import the file system or `node:crypto` (`local-node.mjs` and
 * `split.mjs` import it).
 */

/** Rank of export bitmap tasks: user is waiting for export, ahead of anchor frames (50), sparse streams (30), normal tasks (10) */
export const EXPORT_FRAMES_PRIORITY = 60;
/** Version of the index returned to the page upon plan completion */
export const EXPORT_INDEX_VERSION = 1;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether task (inbound, TaskView, ref received by sink) is export bitmap task: stream task, truthy `input.exportFrames` */
export const isExportFramesTask = task => isObj(task) && task.kind === 'stream' && isObj(task.input) && task.input.exportFrames === true;

/** Whether manifest plan is export-only (`input.exportOnly: true`): splits only export bitmap tasks, no snapshots, no track streams, no layer tables */
export const isExportOnlyPlan = task => isObj(task) && task.kind === 'plan' && isObj(task.input) && task.input.exportOnly === true;

/**
 * Index returned to the page when an export-only plan completes (sent with `result.exportIndex`
 * of `task.complete`; the page reads it from `task.done`):
 *
 *   { v, projectRev, streams: [{ clipId, kind, plane, solo?, resultKey, envFingerprint, originFrame, lastFrame, lastSegment, segmentsPerTask,
 *                                fps, rect, offset, inputSig?, tasks }], unsupported: [{ clipId, reason }] }
 *
 * `tasks`: Carries each export bitmap task for this stream as-is (the copy from publishing).
 * While waiting for the manifest, the page re-publishes tasks that have not arrived yet as-is at
 * intervals: the status in the response indicates whether the task has failed (failed tasks receive
 * no further notifications); if the task no longer exists (the page was disconnected too long,
 * subscriptions cleared, tasks deleted), it is rebuilt accordingly.
 *
 * `streams` only lists streams whose tasks were all published successfully (every segment task for
 * each stream is in `published`); those not fully published are recorded in `unsupported`
 * (`publish-failed`).
 * `projectRev` is the version actually used for splitting (when the project has advanced, it is not
 * the version specified by the plan); the page compares `inputSig` against the value computed from
 * its own project version.
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
