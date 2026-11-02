/**
 * Additions in return values of timeline tools (add_clip / update_clip / remove_clip), as well as
 * gates for batch deletion. Extracted into pure functions so behavior can be pinned down with
 * node --test.
 *
 * Why these exist: from a postmortem exported from a real chat: across 4 chat rounds and 79 tool
 * calls with only 1 failure, the user still did not get the desired result. Time was spent on
 * three things:
 *   - In the first two rounds with 47 calls, 0 see_frames calls, yet wrote "avoided human subjects"
 *     in the summary;
 *   - 18 remove_clip + 13 add_clip: round 2 deleted all 5 cards just created in round 1, then
 *     created 5 nearly identical ones;
 *   - Round 3 used clipId from round 1 for update_clip, but that id was already deleted by itself
 *     in round 2.
 * The three additions target these three issues: lookHint provides an entry point to view visuals,
 * timelineDigest keeps the ids in its hands always fresh, and createClipGuard forces "deleting
 * cards it just created" and "deleting a series consecutively" to stop and give a reason.
 */

import type { Project } from "../../kernel/project";
import { otherCutsHint } from "../../kernel/agentScopes.mjs";
import { clipSpeed, isSpeedChanged } from "../../kernel/clipTime.mjs";

export interface TimelineDigestClip {
  id: string;
  cardId?: string;
  mediaId?: string;
  /** Attached filters (ids in project.filters) */
  filterId?: string;
  /** Attached audio effects (ids in project.audioFx) */
  audioFxId?: string;
  /**
   * Appears only when speed is changed: playback speed of video clip (kernel/clipTime.mjs).
   * Speed-changed clips do not emit original audio
   */
  speed?: number;
  start: number;
  end: number;
}
export interface TimelineDigestTrack {
  trackId: string;
  name: string;
  /**
   * Appears only when true: hidden / muted / locked tracks; the model needs to know that items on
   * them cannot be seen, heard, or modified
   */
  hidden?: true;
  muted?: true;
  locked?: true;
  clips: TimelineDigestClip[];
}
export interface TimelineDigest {
  /** Total length of the video (seconds). Both preview and export stop here */
  duration: number;
  /** Where the last card / media clip ends (seconds). 0 for an empty timeline */
  contentEnd: number;
  tracks: TimelineDigestTrack[];
  /**
   * Appears only when there are other cuts with content in the project: tracks above is only for the
   * active cut; this tells the model that clips in other cuts can be modified without switch_cut
   * (indexed in parkedCuts of get_project / list_cuts). See kernel/agentScopes.mjs.
   */
  otherCuts?: { cuts: { cutId: string; name: string; clipCount: number }[]; hint: string };
}

/**
 * Timeline overview echoed in tool results. Only contains id / card or media / start and end,
 * without params, saving tokens.
 *
 * duration and contentEnd are given together: duration follows content by default and the two are
 * normally equal; duration smaller than contentEnd indicates the video is truncated (for rules see
 * kernel/duration.ts), which the model must see to know that the following section cannot play.
 */
export function timelineDigest(p: Project): TimelineDigest {
  const tracks = p.tracks.map((tr) => ({
    trackId: tr.id,
    name: tr.name,
    ...(tr.hidden ? { hidden: true as const } : null),
    ...(tr.muted ? { muted: true as const } : null),
    ...(tr.locked ? { locked: true as const } : null),
    clips: tr.clips.map((c) => ({
      id: c.id,
      ...(c.cardId ? { cardId: c.cardId } : { mediaId: c.mediaId }),
      ...(c.filter ? { filterId: c.filter.id } : null),
      ...(c.audioFx ? { audioFxId: c.audioFx.id } : null),
      ...(isSpeedChanged(c) ? { speed: clipSpeed(c) } : null),
      start: round2(c.start),
      end: round2(c.end),
    })),
  }));
  const ends = p.tracks.flatMap((tr) => tr.clips.map((c) => c.end));
  const otherCuts = otherCutsHint(p);
  return {
    duration: round2(p.duration),
    contentEnd: round2(ends.length ? Math.max(...ends) : 0),
    tracks,
    ...(otherCuts ? { otherCuts } : null),
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Entry point to "view real visuals".
 * Avoid forcing images: each image requires spinning up a render process (several to a dozen
 * seconds), and entering context also burns tokens. Provide ready-to-use calls so the model can
 * inspect on demand when making decisions involving positioning and occlusion.
 */
export function lookHint(clipId: string) {
  return {
    tool: "see_frames",
    args: { source: "timeline", clipId },
    why: "Confirm the actual frame before concluding: whether this card covers a person, and whether the text is covered by other cards. To view the whole screen, omit clipId and pass t.",
  };
}

export interface ClipGuardOptions {
  /** Within how many timeline changes after add_clip is considered "just created" */
  freshWindow?: number;
  /** At which count of consecutive remove_clip calls to stop */
  deleteStreakMax?: number;
}

export interface RemoveArgs {
  clipId: string;
  force?: boolean;
  reason?: string;
}

/**
 * Gate for batch deletion. Both rules can be bypassed with force:true + reason, but the reason is
 * echoed as-is for the user to see: the goal is not to forbid deletion, but to force it to pause
 * and explain before "tearing down and starting over".
 * Default values come from that postmortem: deleting up to the 5th card in one round is basically
 * the shape of clearing and rebuilding from scratch.
 */
export function createClipGuard(opts: ClipGuardOptions = {}) {
  const freshWindow = opts.freshWindow ?? 30;
  const deleteStreakMax = opts.deleteStreakMax ?? 5;
  /** clipId → change sequence number when it was created */
  const born = new Map<string, number>();
  let seq = 0;
  let deleteStreak = 0;

  return {
    /** Record an entry after add_clip / duplicate_clip / split_clip produces a new clip */
    noteCreated(clipId: string) {
      seq++;
      deleteStreak = 0;
      born.set(clipId, seq);
    },
    /**
     * Any timeline change that is not a deletion (update / add_track …) resets the consecutive
     * deletion count
     */
    noteMutation() {
      seq++;
      deleteStreak = 0;
    },
    /**
     * Called before remove_clip. Throws if not allowed; error text is written for the model, telling it
     * what to do. If allowed, returns { reason }: the reason when force bypasses the gate, echoed as-is
     * in the tool results.
     */
    checkRemove(args: RemoveArgs): { reason?: string } {
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (args.force) {
        if (!reason) throw new Error("If force:true is passed, you must state in reason why this card is being deleted; the user will see this sentence.");
        return { reason };
      }
      const b = born.get(args.clipId);
      if (b !== undefined && seq - b < freshWindow) {
        throw new Error(
          `clip ${args.clipId} was just created by you with add_clip (only ${seq - b} changes since then).` +
            ` To change it (parameters, time range, swapping the card) use update_clip; do not delete and recreate it, because recreating loses details not mentioned this time, ` +
            `and also invalidates the clipId you hold. If you really need to delete it, pass force:true and explain in reason.`,
        );
      }
      if (deleteStreak >= deleteStreakMax) {
        throw new Error(
          `${deleteStreak} cards have been deleted in a row. Stop for a moment: use get_project to see what remains and which ones the user actually called redundant; ` +
            `If you really need to keep deleting, pass force:true and explain each one in reason.`,
        );
      }
      return {};
    },
    /** Record an entry after remove_clip succeeds */
    noteRemoved(clipId: string) {
      seq++;
      deleteStreak++;
      born.delete(clipId);
    },
  };
}
export type ClipGuard = ReturnType<typeof createClipGuard>;

/**
 * Echoes "what actually changed this time" after update_clip modifies parameters.
 *
 * Why: params is a delta patch (the store's setClipParams merges by default), but the model often
 * brings back the entire parameter set based on memory from several turns ago; in production on
 * 2026-10-21, in a turn where it only wanted to resize, it brought back color with an old value,
 * quietly writing back the color that the user had just removed by clicking "Undo this step".
 * The response lists each key that actually changed (from → to), so it can see it the moment it
 * brings back an old value; `params` provides the full picture after changes, so the next turn
 * no longer needs to rely on memory. Oversized values only provide a summary, and an entire object
 * that is too large only provides key names, avoiding blowing up context.
 */
const ECHO_VALUE_MAX = 80;
const ECHO_PARAMS_MAX = 2000;

function briefValue(v: unknown): unknown {
  if (typeof v === "string") return v.length > ECHO_VALUE_MAX ? `${v.slice(0, ECHO_VALUE_MAX)}… (${v.length} characters in total)` : v;
  if (v === null || typeof v !== "object") return v;
  const text = JSON.stringify(v);
  return text.length > ECHO_VALUE_MAX ? `${text.slice(0, ECHO_VALUE_MAX)}… (${text.length} characters in total)` : v;
}

export function paramsEcho(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const b = before ?? {};
  const a = after ?? {};
  const changedParams: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    changedParams[k] = { from: briefValue(b[k]), to: briefValue(a[k]) };
  }
  const whole = JSON.stringify(a);
  return {
    changedParams,
    ...(whole.length <= ECHO_PARAMS_MAX ? { params: a } : { paramKeys: Object.keys(a), paramsNote: "Parameters are too long to echo in full; read them with get_clip" }),
  };
}
