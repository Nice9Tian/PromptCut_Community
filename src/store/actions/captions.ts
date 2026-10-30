import { findClip, type Track } from "../../kernel/project";
import {
  CAPTION_CARD_ID,
  CAPTION_TRACK_NAME,
  captionsFromTranscript,
  captionsOf,
  editCaption as editCaptionLine,
  formatCaptions,
  insertCaption,
  isCaptionClip,
  removeCaption as removeCaptionLine,
} from "../../kernel/captions";

import { state } from "../core";
import { clips as clipActions } from "./clips";
import { tracks as trackActions } from "./tracks";

export const captions = {
  /**
   * 字幕专用序列:有就用,没有就建一条。
   *
   * 建在**最上面**(tracks[0]):时间轴上靠上的序列画在上层,字幕本来就该压在画面之上 ——
   * 以前用 addTrack 追加到末尾,叠放顺序翻正之后那等于把字幕塞到了所有画面底下。
   */
  ensureCaptionTrack(): Track {
    const found = state.project.tracks.find((t) => t.name === CAPTION_TRACK_NAME);
    if (found) return found;
    return trackActions.addTrack(CAPTION_TRACK_NAME, { index: 0 });
  },
  /**
   * 一键把某份素材的文字稿铺成字幕轨:字幕序列 → 一张 caption-track 卡 → 灌进 lines。
   *
   * 以前只有 AI 走 auto_workflow / fill_captions 能铺字幕,人在界面上转写完就没有下一步了。
   * 时段按这份素材在时间轴上真正铺开的范围算(认 mediaOffset,素材被挪过、修过头也对得上)。
   * 已经有一张覆盖同一段时间的字幕卡就往那张里灌,不再多建一张。
   */
  buildCaptions(mediaId: string): { ok: true; clipId: string; count: number } | { ok: false; reason: string } {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return { ok: false, reason: "找不到这份素材" };
    const segments = media.transcript?.segments ?? [];
    if (segments.length === 0) return { ok: false, reason: "这份素材还没有文字稿" };

    const clips = p.tracks.flatMap((t) => t.clips);
    const plan = captionsFromTranscript(clips, mediaId, segments);
    if (plan.lines.length === 0) return { ok: false, reason: "这份素材还没放到时间轴上,先把它拖上去再铺字幕" };

    const track = captions.ensureCaptionTrack();
    // 同一时段已经有字幕卡就复用它(重新转写之后再铺一次是常事,不该越铺越多)
    const exist = track.clips.find((c) => isCaptionClip(c) && Math.max(c.start, plan.from) < Math.min(c.end, plan.to));
    if (exist) {
      const re = captionsFromTranscript(clips, mediaId, segments, { from: exist.start, to: exist.end });
      if (re.lines.length === 0) return { ok: false, reason: "文字稿没有落在那张字幕卡的时段里" };
      clipActions.setClipParams(exist.id, { lines: formatCaptions(re.lines) });
      return { ok: true, clipId: exist.id, count: re.lines.length };
    }
    const clip = clipActions.addCardClip(CAPTION_CARD_ID, plan.from, {
      duration: plan.to - plan.from,
      trackId: track.id,
      params: { lines: formatCaptions(plan.lines), showEn: "false" },
    });
    if (!clip) return { ok: false, reason: "建字幕卡失败" };
    return { ok: true, clipId: clip.id, count: plan.lines.length };
  },
  /**
   * 改字幕卡里的一条字幕(挪位置、修边、改文字)。
   *
   * 字幕存在卡片的 lines 参数里(`起|止|中|英` 一行一条),所以这三个动作都是
   * 「解析 → 在 kernel/captions 里算 → 写回同一个字符串」。时间会被夹在左右邻居之间,
   * 不会拖出一条压着别人的字幕。返回改完之后它排到第几位,-1 = 没改成。
   */
  editCaption(clipId: string, index: number, patch: { start?: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const lines = captionsOf(hit.clip);
    const res = editCaptionLine(lines, index, patch, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    clipActions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
  /** 删掉一条字幕 */
  removeCaption(clipId: string, index: number): boolean {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return false;
    const lines = captionsOf(hit.clip);
    if (index < 0 || index >= lines.length) return false;
    clipActions.setClipParams(clipId, { lines: formatCaptions(removeCaptionLine(lines, index)) });
    return true;
  },
  /** 在字幕卡里插一条(start 是相对卡片起点的秒);挤不下返回 -1 */
  addCaption(clipId: string, at: { start: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const res = insertCaption(captionsOf(hit.clip), at, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    clipActions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
};
