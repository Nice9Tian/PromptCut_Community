/**
 * 本地档能力闸的判据(M6c X2,`docs/plan/m6c-contract.md`):项目里哪些素材只在发布方本机,
 * 以及哪些细任务的输入用到了它们。
 *
 * **没有内容哈希的素材只在本机**:按哈希寻址的素材别的节点能经素材服务取到(J.6 的回退只认
 * `/@media/<hash>`);迁移期按文件名存的 `/@media/<文件名>`、老 `.proc` 的 `path` / `/api/media/file?path=`、
 * 这一趟导出自己的 `/@export/…` 都只在发布方这台机器上,帧管线给它们打戳也是问本机素材服务
 * (`media-stamp.mjs`)。别的节点渲这种输入,要么取不到素材、要么打出的戳不同(本地档会被 `plan-mismatch`
 * 拦下,共享档拦不住)。所以切分时给这些任务写 `requires.localMedia = <发布方 nodeId>`,只让发布方的节点认领。
 *
 * 哪些 control 算「用到」:
 *   - 本地档(整场景渲):项目里有任何一条这种素材就算,整场景的每一层都可能用到它;
 *   - 轨道流:同理,算;
 *   - 共享档(隔离单卡渲,只带这一个片段):这个片段的 JSON 里引用了这种素材的 id / url / path 才算;
 *     在项目里找不到这个片段时保守地算。
 *
 * 纯函数,不做 I/O;`vite-plugin-frames.ts` 在 `executor.plan` 之后按这一版的 entry 调 `withLocalMedia`。
 */
import { mediaHashOf } from './media-stamp.mjs';
import { snapshotTier } from './snapshot-tier.mjs';

/** 这条素材的字节是不是只在本机:没有内容哈希,而且是按本机地址取的那几种 */
function onlyLocal(media) {
  if (!media || typeof media !== 'object' || mediaHashOf(media) !== null) return false;
  if (media.path) return true;
  const url = String(media.url || '');
  return url.startsWith('/@media/') || url.startsWith('/api/media/file?') || url.startsWith('/@export/');
}

/** 项目里只在本机的素材(没有内容哈希),原样返回这些素材记录 */
export function hashlessMedia(project) {
  return (Array.isArray(project?.media) ? project.media : []).filter(onlyLocal);
}

/**
 * → `null`(项目里没有只在本机的素材,不设闸)或 `(control) => boolean`(这一项的输入用不用得到它们)。
 * `control` 是卡片计划里的一项(有 `clipId`、`tier` / `capabilities`),流任务传 `{ clipId, kind: 'stream' }`。
 */
export function localMediaGate(project) {
  const local = hashlessMedia(project);
  if (local.length === 0) return null;
  // 片段 JSON 里按「带引号的字符串」找,免得一个 id 恰好是另一个字符串的一部分
  const needles = [...new Set(local.flatMap(m => [m.id, m.url, m.path]).filter(v => typeof v === 'string' && v !== ''))]
    .map(v => JSON.stringify(v));
  const clips = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) if (clip?.id != null) clips.set(clip.id, clip);
  }
  return (control) => {
    if (control?.kind === 'stream') return true;
    const tier = control?.tier || snapshotTier(control?.capabilities);
    if (tier !== 'shared') return true;
    const clip = clips.get(control?.clipId);
    if (!clip) return true;
    const text = JSON.stringify(clip);
    return needles.some(needle => text.includes(needle));
  };
}

/**
 * 给 `executor.plan` 的 PlanContext 加上本地档能力闸(`local-node.mjs` 原样传给 `splitPlan`)。
 * `owner` 是素材所在那台机器的节点 id:plan 的发布方(`source.publisher.id`,PC 节点的发布方 id 就是它的 nodeId)。
 * 项目里没有只在本机的素材,或者没有 owner,原样返回。
 */
export function withLocalMedia(ctx, { project, owner, projectId }) {
  if (projectId && ctx?.projectId && ctx.projectId !== projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
  if (projectId) ctx = { ...ctx, projectId }; // 任务产物接收方按此可信上下文核验，非文档内自报id
  const gate = localMediaGate(project);
  if (!gate || typeof owner !== 'string' || owner === '' || !ctx || typeof ctx !== 'object') return ctx;
  return { ...ctx, localMedia: owner, usesLocalMedia: gate };
}
