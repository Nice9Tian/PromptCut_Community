/**
 * `attach_clip_motion` for Cloud Agent: bind a tracking trajectory to a card clip, so the card
 * follows the target in the video (a row in package breakdown table P3; depends on
 * `perception/track.mjs` in the same package, which provides the trajectory).
 *
 * Binding computation and validation are not rewritten here; they use **existing project replica tools**:
 *
 *   - Call the same `attachClipMotion` from `src/mcp/handlers/ai.ts` on the server-side project
 *     replica (via routing table `host.callRoute`), which verifies that "it is a card clip, not a
 *     media clip", "the card and this media segment truly overlap on the timeline", and "pointIndex
 *     exists and is not a failed tracking point", then calculate frame-by-frame displacement using
 *     `buildClipMotion` from `src/kernel/motion.ts` (time alignment, stage conversion,
 *     zeroing anchor points);
 *   - Trajectories do not pass through the model: this module retrieves them from the persistent
 *     results table (project × chat × asset × version), puts them once into the replica's page state
 *     slot (`host.setPageState`, cleared when releasing the lock), and the handler reads from there
 *     as usual;
 *   - Changes are committed via `commit` provided by the host: compute diff, submit to document
 *     service with expected version, attributed to this run's opId. This module checks write
 *     authorization once more before committing, and passes the current fence to `commit` so the
 *     host can reconcile at commit time.
 *
 * If there is no trajectory (never tracked, still running, failed, or expired from asset version
 * change), reject outright and explain; do not forge motion, and do not commit any changes.
 * Does not import `src/`; does not touch rendering or the stage.
 */
import { TrackToolError } from './perception/track.mjs';

export const MOTION_TOOL_NAMES = Object.freeze(['attach_clip_motion']);

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} d
 * @param {{ authorize(context: object, action: 'read'|'write'): Promise<{ fenceRevision: number, grantState: string }> }} d.contextAccess F0 `tool-context`
 * @param {{ readResult(context: object, o: { mediaId: string }): Promise<object> }} d.tracks Return value of `createTrackTools(...)` (fetches trajectory)
 * @param {(o: { context: object, fenceRevision: number, tool: string, apply: (host: object) => any }) => Promise<any>} d.commit
 *   Executes `apply(host)` on the project replica and submits changes with expected version to document service.
 *   In production, this is `agent-exec`'s `mutate(tool, conversationId, track, apply)`
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
        // Asset version changed: tracking was not performed on the current footage, and binding it
        // would make the card follow different content
        if (track.mediaHash && media.hash && media.hash !== track.mediaHash) {
          throw new TrackToolError('TRACK_STALE', `${media.name ?? args.mediaId} was replaced after tracking, so this trajectory was tracked on an older version of the picture. Please re-track with track_points({ force: true }).`);
        }
        // Put the trajectory into the replica's page state slot for the existing handler to read
        // as usual; clear it when exiting the lock (or on error)
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
