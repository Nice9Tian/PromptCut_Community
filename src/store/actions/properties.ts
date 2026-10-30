import { findClip } from "../../kernel/project";
import { normalizeEmphasis, type ClipEmphasis } from "../../kernel/emphasis";
import type { ClipFrame, ClipMotion, PartInstance } from "../../kernel/types";

import { state, setProject, updateTrack } from "../core";

export const properties = {
  /** 换卡片类型(保留时段)。keepParams 为 true 时,保留新卡也有的同名参数。 */
  /**
   * 组合卡的部件实例树:整棵替换。树的增删改移在 kernel/parts.ts 里算好(纯函数、已校验),这里只负责存。
   * 空数组 = 清掉字段。
   */
  setClipParts(clipId: string, parts: PartInstance[]) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!parts.length) {
          const { parts: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, parts };
      }),
    })));
    return true;
  },
  /**
   * 给一段加 / 去掉强调(阴影、描边)。传 null 就是去掉。
   * 参数在 kernel/emphasis.ts 里补全和夹范围,kind 不认识就当没设。
   */
  setClipEmphasis(clipId: string, emphasis: Partial<ClipEmphasis> | null): { ok: boolean; emphasis: ClipEmphasis | null; error?: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, emphasis: null, error: `找不到片段 ${clipId}` };
    const next = emphasis ? normalizeEmphasis(emphasis) : null;
    if (emphasis && !next) return { ok: false, emphasis: null, error: "强调只有 shadow(阴影)和 outline(描边)两种" };
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!next) {
          // 去掉时把键删掉,而不是留个 undefined —— 存进 .proc 会多一行没用的
          const { emphasis: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, emphasis: next };
      }),
    })));
    return { ok: true, emphasis: next };
  },

  /**
   * 绑定 / 解绑一条运动轨迹。传 undefined 就是解绑。
   *
   * 和 updateClip 分开而不是并进它的 patch:motion 是一坨逐帧数据,不是
   * 淡入淡出那种一眼看完的标量,混在同一个 patch 里会让「随手改个不透明度」
   * 和「换掉整条轨迹」长得一模一样。
   */
  setClipMotion(clipId: string, motion: ClipMotion | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!motion) {
          const { motion: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, motion };
      }),
    })));
    return true;
  },
  /**
   * 设 / 清卡片的框(位置、尺寸、锚点、缩放、旋转)。传 undefined 就是清掉,恢复铺满全屏。
   * 传进来的 frame 是**完整的局部坐标**,不做合并 —— 合并(只改传了的字段)和 world→local
   * 换算都在调用方(kernel/layout.ts 的 framePatchFromArgs)做完了,这里只负责存。
   * 和 motion 一样单独一个 action,不并进 updateClip 的 patch。
   */
  setClipFrame(clipId: string, frame: ClipFrame | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!frame) {
          const { frame: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, frame };
      }),
    })));
    return true;
  },
};
