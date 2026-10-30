/**
 * 时间轴类工具（add_clip / update_clip / remove_clip）返回值里的附加物，以及成批删除的门槛。
 * 抽成纯函数是为了能用 node --test 把行为钉住。
 *
 * 为什么要有这些——来自一份真实对话导出的复盘：4 轮对话、79 次工具调用只失败 1 次，
 * 用户还是没拿到想要的结果。时间耗在三件事上：
 *   - 前两轮 47 次调用里 0 次 see_frames，却在总结里写「已避开人物主体」；
 *   - 18 次 remove_clip + 13 次 add_clip：第 2 轮把第 1 轮刚建的 5 张卡全删了、再建 5 张几乎一样的；
 *   - 第 3 轮拿着第 1 轮的 clipId 去 update_clip，那个 id 第 2 轮已经被它自己删了。
 * 三样东西分别对着这三件事：lookHint 给它一个看画面的入口，timelineDigest 让它手里的 id 永远是新的，
 * createClipGuard 让「删自己刚建的卡」和「连着删一串」必须停下来说理由。
 */

import type { Project } from "../../kernel/project";
import { otherCutsHint } from "../../kernel/agentScopes.mjs";
import { clipSpeed, isSpeedChanged } from "../../kernel/clipTime.mjs";

export interface TimelineDigestClip {
  id: string;
  cardId?: string;
  mediaId?: string;
  /** 挂着的滤镜(project.filters 里的 id) */
  filterId?: string;
  /** 挂着的音频效果(project.audioFx 里的 id) */
  audioFxId?: string;
  /** 只在变速时出现:视频段的播放速度(kernel/clipTime.mjs)。变速段不出原声 */
  speed?: number;
  start: number;
  end: number;
}
export interface TimelineDigestTrack {
  trackId: string;
  name: string;
  /** 只在为 true 时出现:隐藏 / 静音 / 锁定的序列,模型要知道那上面的东西看不见、听不见或改不了 */
  hidden?: true;
  muted?: true;
  locked?: true;
  clips: TimelineDigestClip[];
}
export interface TimelineDigest {
  /** 整条片子多长(秒)。预览和导出都在这里停 */
  duration: number;
  /** 最后一张卡 / 一段素材结束在哪(秒)。空时间轴是 0 */
  contentEnd: number;
  tracks: TimelineDigestTrack[];
  /**
   * 只在项目里还有别的有内容的剪辑时出现:上面的 tracks 只是激活剪辑的,这里告诉模型别的剪辑的片段
   * 不用 switch_cut 就能改(索引在 get_project 的 parkedCuts / list_cuts)。见 kernel/agentScopes.mjs。
   */
  otherCuts?: { cuts: { cutId: string; name: string; clipCount: number }[]; hint: string };
}

/**
 * 工具结果里回显的时间轴一览。只有 id / 卡或素材 / 起止，不带 params，省 token。
 *
 * duration 和 contentEnd 一起给出来:时长缺省跟着内容走,平时两者相等;
 * duration 比 contentEnd 小说明片子被截断了(规则见 kernel/duration.ts),
 * 模型得看得到这件事,才知道后面那截内容播不到。
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
 * 「去看真实画面」的入口。
 * 不硬塞图：每张图要起一个渲染进程（几秒到十几秒），进上下文还烧 token。
 * 给出现成的调用，让模型在涉及位置和遮挡的决定上按需去看。
 */
export function lookHint(clipId: string) {
  return {
    tool: "see_frames",
    args: { source: "timeline", clipId },
    why: "先确认真实画面再下结论：这张卡会不会压到人物、文字会不会被别的卡盖住。要看整屏就不传 clipId、传 t。",
  };
}

export interface ClipGuardOptions {
  /** add_clip 之后多少次时间轴改动之内算「刚建的」 */
  freshWindow?: number;
  /** 连续 remove_clip 到第几张要停下来 */
  deleteStreakMax?: number;
}

export interface RemoveArgs {
  clipId: string;
  force?: boolean;
  reason?: string;
}

/**
 * 成批删除的门槛。两条规则都能用 force:true + reason 越过，但理由会原样回显给用户看——
 * 目的不是禁止删除，是逼它在「推倒重来」之前停一下、说清楚。
 * 默认值来自那份复盘：一轮里删到第 5 张，基本就是清空重铺的形状了。
 */
export function createClipGuard(opts: ClipGuardOptions = {}) {
  const freshWindow = opts.freshWindow ?? 30;
  const deleteStreakMax = opts.deleteStreakMax ?? 5;
  /** clipId → 建它时的改动序号 */
  const born = new Map<string, number>();
  let seq = 0;
  let deleteStreak = 0;

  return {
    /** add_clip / duplicate_clip / split_clip 产生新 clip 之后记一笔 */
    noteCreated(clipId: string) {
      seq++;
      deleteStreak = 0;
      born.set(clipId, seq);
    },
    /** 任何不是删除的时间轴改动（update / add_track …）都打断连删计数 */
    noteMutation() {
      seq++;
      deleteStreak = 0;
    },
    /**
     * remove_clip 之前调。不放行就抛错；错误文案是写给模型看的，要告诉它该怎么办。
     * 放行返回 { reason }：force 越过门槛时的理由，工具结果里原样回显。
     */
    checkRemove(args: RemoveArgs): { reason?: string } {
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (args.force) {
        if (!reason) throw new Error("传了 force:true 就必须在 reason 里写明为什么要删这张卡，用户会看到这句话。");
        return { reason };
      }
      const b = born.get(args.clipId);
      if (b !== undefined && seq - b < freshWindow) {
        throw new Error(
          `clip ${args.clipId} 是你刚用 add_clip 建的（之后只过了 ${seq - b} 次改动）。` +
            `要改它（参数、时段、换卡）用 update_clip，不要删了重建——重建会丢掉这次没提到的细节，` +
            `也会让你手里的 clipId 失效。确实要删就传 force:true 并在 reason 里说明。`,
        );
      }
      if (deleteStreak >= deleteStreakMax) {
        throw new Error(
          `已经连续删了 ${deleteStreak} 张。先停一下：用 get_project 看清现在还剩什么、哪些才是用户说的冗余；` +
            `确实要继续删就传 force:true 并在 reason 里逐条说明。`,
        );
      }
      return {};
    },
    /** remove_clip 成功后记一笔 */
    noteRemoved(clipId: string) {
      seq++;
      deleteStreak++;
      born.delete(clipId);
    },
  };
}
export type ClipGuard = ReturnType<typeof createClipGuard>;

/**
 * update_clip 改完参数后回显「这次真正变了什么」。
 *
 * 为什么:params 是增量补丁(store 的 setClipParams 默认合并),但模型常凭几轮前的记忆把整份参数带回来;
 * 线上 2026-10-21 它在只想改大小的一轮里把 color 带成了旧值,把用户刚点「撤销这步」撤掉的颜色悄悄写了回去。
 * 回包里列出每个真正变了的键(from → to),带回旧值的那一刻它自己就看得见;`params` 给改完后的全貌,
 * 下一轮不必再靠记忆。太大的值只给摘要、太大的整份只给键名,不撑爆上下文。
 */
const ECHO_VALUE_MAX = 80;
const ECHO_PARAMS_MAX = 2000;

function briefValue(v: unknown): unknown {
  if (typeof v === "string") return v.length > ECHO_VALUE_MAX ? `${v.slice(0, ECHO_VALUE_MAX)}…(共 ${v.length} 字)` : v;
  if (v === null || typeof v !== "object") return v;
  const text = JSON.stringify(v);
  return text.length > ECHO_VALUE_MAX ? `${text.slice(0, ECHO_VALUE_MAX)}…(共 ${text.length} 字)` : v;
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
    ...(whole.length <= ECHO_PARAMS_MAX ? { params: a } : { paramKeys: Object.keys(a), paramsNote: "参数太长没有全部回显,用 get_clip 读" }),
  };
}
