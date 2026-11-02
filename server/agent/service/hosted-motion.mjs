/**
 * 云端 Agent 的 `attach_clip_motion`:把一条追踪轨迹绑到卡片段上,让卡片跟着画面里的目标走
 * (拆包表 P3 一行;依赖同包的 `perception/track.mjs`,它交出轨迹)。
 *
 * 绑定的计算和校验不在这里重写,走**现有的项目副本工具**:
 *
 *   - 在服务端项目副本上调同一份 `src/mcp/handlers/ai.ts` 的 `attachClipMotion`(经路由表 `host.callRoute`),
 *     由它核「是卡片段不是素材段」「卡片和这段素材在时间轴上真的重叠」「pointIndex 存在且不是追失败的点」,
 *     再用 `src/kernel/motion.ts` 的 `buildClipMotion` 算逐帧位移(时间对齐、舞台换算、锚点归零);
 *   - 轨迹不经模型:本模块从持久的结果表取出(项目 × 对话 × 素材 × 版本),只在副本的页面状态槽里放一次
 *     (`host.setPageState`,出锁时撤掉),handler 照旧从那里读;
 *   - 改动由宿主给的 `commit` 提交:算差异、带期望版本提交给文档服务,落到这个 run 的 opId 上。
 *     本模块在提交之前再核一次 write 授权,并把当时的 fence 交给 `commit`,让宿主在提交时对账。
 *
 * 没有轨迹(没追过、还在跑、失败了、素材换版过期了)一律拒绝并说明,不伪造 motion,也不提交任何改动。
 * 不引用 `src/`;不碰渲染和舞台。
 */
import { TrackToolError } from './perception/track.mjs';

export const MOTION_TOOL_NAMES = Object.freeze(['attach_clip_motion']);

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<{ fenceRevision: number, grantState: string }> }} d.contextAccess F0 `tool-context`
 * @param {{ readResult(context: object, o: { mediaId: string }): Promise<object> }} d.tracks `createTrackTools(...)` 的返回值(取轨迹)
 * @param {(o: { context: object, fenceRevision: number, tool: string, apply: (host: object) => any }) => Promise<any>} d.commit
 *   在项目副本上执行 `apply(host)` 并把改动带期望版本提交给文档服务。生产上是 `agent-exec` 的 `mutate(tool, conversationId, track, apply)`
 */
export function createMotionTools({ contextAccess, tracks, commit } = {}) {
  if (typeof contextAccess?.authorize !== 'function') throw new TrackToolError('TRACK_UNCONFIGURED', 'createMotionTools is missing contextAccess');
  if (typeof tracks?.readResult !== 'function') throw new TrackToolError('TRACK_UNCONFIGURED', 'createMotionTools is missing tracks');
  if (typeof commit !== 'function') throw new TrackToolError('TRACK_UNCONFIGURED', 'createMotionTools is missing commit');
  let closing = false;
  const pending = new Set();

  function parse(args) {
    const clipId = args?.clipId;
    if (typeof clipId !== 'string' || !ID_RE.test(clipId)) throw new TrackToolError('MOTION_BAD_ARGS', 'clipId is required: the card clip to follow');
    const mediaId = args?.mediaId;
    if (typeof mediaId !== 'string' || !ID_RE.test(mediaId)) throw new TrackToolError('MOTION_BAD_ARGS', 'mediaId is required: which media the trajectory comes from');
    const pointIndex = args?.pointIndex === undefined ? 0 : args.pointIndex;
    if (!Number.isSafeInteger(pointIndex) || pointIndex < 0) throw new TrackToolError('MOTION_BAD_ARGS', 'pointIndex is an integer starting from 0 (as many points as track_points was given, that many trajectories)');
    const whenHidden = args?.whenHidden === undefined ? 'hold' : args.whenHidden;
    if (whenHidden !== 'hold' && whenHidden !== 'hide') throw new TrackToolError('MOTION_BAD_ARGS', 'whenHidden must be hold (stay at the last visible position when the target is occluded) or hide (the whole card is not shown)');
    return { clipId, mediaId, pointIndex, whenHidden };
  }

  async function attachClipMotion(context, rawArgs) {
    const args = parse(rawArgs);
    const track = await tracks.readResult(context, { mediaId: args.mediaId });
    const point = track.points[args.pointIndex];
    if (!point) throw new TrackToolError('MOTION_BAD_POINT', `This tracking has only ${track.points.length} points, no point number ${args.pointIndex}`);
    if (point.note) throw new TrackToolError('MOTION_BAD_POINT', `Point ${args.pointIndex} failed to track: ${point.note}`);
    const auth = await contextAccess.authorize(context, 'write');
    if (closing) throw new TrackToolError('TRACK_CLOSED', 'Service is shutting down, try again later');

    const legacy = {
      engine: track.engine, createdAt: new Date(track.createdAt ?? 0).toISOString(),
      width: track.width, height: track.height, frames: track.frames, points: track.points,
    };
    const work = commit({
      context, fenceRevision: auth.fenceRevision, tool: 'attach_clip_motion',
      apply: async (host) => {
        const media = host.getProject().media.find((m) => m.id === args.mediaId);
        if (!media) throw new TrackToolError('MOTION_MEDIA_NOT_FOUND', `No media ${args.mediaId} in the project`);
        // 素材换过版:追踪时看的不是现在这段画面,绑上去会让卡片跟着别的内容走
        if (track.mediaHash && media.hash && media.hash !== track.mediaHash) {
          throw new TrackToolError('TRACK_STALE', `${media.name ?? args.mediaId} was replaced after tracking, so this trajectory was tracked on an older version of the picture. Please re-track with track_points({ force: true }).`);
        }
        // 轨迹放进副本的页面状态槽,让现成的 handler 照旧去读;出锁(或抛错)时撤掉
        const cleanup = host.setPageState({ track: { mediaId: args.mediaId, result: legacy, running: false } });
        try {
          return await host.callRoute('attach_clip_motion', args);
        } finally {
          cleanup();
        }
      },
    });
    pending.add(work);
    try { return await work; } finally { pending.delete(work); }
  }

  const TOOLS = { attach_clip_motion: attachClipMotion };
  return {
    handles: new Set(MOTION_TOOL_NAMES),
    async call(name, args, context) {
      if (!Object.hasOwn(TOOLS, name)) throw new TrackToolError('TRACK_UNKNOWN_TOOL', `The motion provider does not handle ${name}`);
      if (closing) throw new TrackToolError('TRACK_CLOSED', 'Service is shutting down, try again later');
      return TOOLS[name](context, isPlain(args) ? args : {});
    },
    async close(reason = 'close') {
      closing = true;
      await Promise.allSettled([...pending]);
      return { childrenClosed: true, streamsClosed: true, workPending: pending.size, reason };
    },
  };
}
