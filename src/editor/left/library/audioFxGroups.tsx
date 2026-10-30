import { useState } from "react";
import { actions, getState, useStore } from "../../../store/project";
import { findClip } from "../../../kernel/project";
import { AUDIO_FX_KINDS, AUDIO_FX_PRESETS, describeAudioFx, isAudioFxAnimated } from "../../../kernel/audioFx.mjs";
import { createAudioFxTools, audioFxUsesOf } from "../../right/audioFxTools";
import { AudioStrip } from "./AudioStrip";
import { useReadOnly } from "../../readOnly";
import type { GroupData, GroupItem } from "./groups";

/** 和 Agent 的 apply_audio_fx / remove_audio_fx 同一份校验 */
const tools = createAudioFxTools({ getState, actions });

/** 选中的片段能不能挂音频效果:得是视频或声音素材段,图片和卡片段没有声音 */
function useSelectedAudioClip() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const sel = selection[0] ? findClip(project, selection[0]) : null;
  const selClip = sel && sel.clip.mediaId && !sel.clip.cardId ? sel.clip : null;
  const selMedia = selClip ? project.media.find((m) => m.id === selClip.mediaId) : null;
  return { project, selClip, selMedia };
}

/**
 * 特效 → 音频效果组:项目的音频效果库。
 * 效果大多是 Agent 用 create_audio_fx 建的;这里让人看得到、能挂到选中的视频 / 音频片段上复用、能删。
 * 每条的「挂到选中 / 删除」只在悬停或键盘聚焦时露出来。
 */
export function useAudioFxGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // 这个项目只给了只读权限(游客):挂 / 摘音频效果、删效果都是写
  const ro = useReadOnly();
  const { project, selClip, selMedia } = useSelectedAudioClip();
  const [armed, setArmed] = useState<string | null>(null);
  const canApply = selClip && selMedia && selMedia.kind !== "image";

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok, 2000);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 2000);
    }
  };

  const rawFx = project.audioFx ?? [];
  const filtered = q
    ? rawFx.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.description && f.description.toLowerCase().includes(q)) ||
          describeAudioFx(f).toLowerCase().includes(q),
      )
    : rawFx;

  const items: GroupItem[] = filtered.map((f) => {
    const uses = audioFxUsesOf(project, f.id);
    const on = !!selClip && selClip.audioFx?.id === f.id;
    return {
      id: f.id,
      node: (
        <AudioStrip
          attrs={{ "data-pc-audiofx": f.id }}
          icon="fx"
          className={armed === f.id ? "is-armed" : undefined}
          title={`${f.description ?? f.name}\n${describeAudioFx(f)}`}
          name={
            <>
              <span className="pc-lib-ellipsis">{f.name}</span>
              {isAudioFxAnimated(f) && <span className="pc-lib-tag">随时间变化</span>}
            </>
          }
          sub={`${describeAudioFx(f)}${uses.length ? ` · 用在 ${uses.length} 段` : ""}`}
          actions={
            <>
              <button
                type="button"
                className="pc-left-btn"
                disabled={!canApply || ro.locked}
                title={ro.locked ? ro.why : canApply ? (on ? "从选中的片段上摘掉" : "挂到选中的片段上(每段只挂一个,会替换原来的)") : "先在时间轴上选中一段视频或声音"}
                onClick={() =>
                  canApply &&
                  (on
                    ? run(() => tools.applyAudioFx({ clipId: selClip.id, fxId: "" }), `已从选中的片段摘掉「${f.name}」`)
                    : run(() => tools.applyAudioFx({ clipId: selClip.id, fxId: f.id }), `已把「${f.name}」挂到选中的片段`))
                }
              >
                {on ? "摘掉" : "挂到选中"}
              </button>
              <button
                type="button"
                className={`pc-left-btn${armed === f.id ? " is-danger" : ""}`}
                disabled={ro.locked}
                title={ro.title(uses.length ? `用在 ${uses.length} 段上,删了会一起摘掉` : "从效果库删掉")}
                onClick={() => {
                  if (uses.length && armed !== f.id) {
                    setArmed(f.id);
                    flash(`「${f.name}」用在 ${uses.length} 段上;再点一次「确认删除」会把这些段上的它一起摘掉`, 2000);
                    return;
                  }
                  setArmed(null);
                  run(() => tools.removeAudioFx({ fxId: f.id, force: uses.length > 0, reason: "用户在素材库里删除" }), `已删除「${f.name}」`);
                }}
              >
                {armed === f.id ? "确认删除" : "删除"}
              </button>
            </>
          }
        />
      ),
    };
  });

  const thumbs: GroupItem[] = filtered.slice(0, 2).map((f) => ({
    id: f.id,
    node: <AudioStrip icon="fx" name={f.name} sub={describeAudioFx(f)} />,
  }));

  const detailTop = (
    <div className="pc-left-hint">
      效果大多由 Agent 用 create_audio_fx 建；这里能看、能复用、能删；预览和导出用同一套 Web Audio，听到的就是导出的。
    </div>
  );

  // 效果类的参考说明:每种效果是做什么的、有哪些参数和取值范围
  const detailBottom = (
    <details className="pc-lib-details">
      <summary>效果种类 (点击展开)</summary>
      <div className="pc-lib-details-body">
        {Object.entries(AUDIO_FX_KINDS).map(([kind, spec]) => (
          <div key={kind}>
            <div className="pc-lib-details-kind">
              {kind} <span className="pc-left-faint">{spec.label}</span>
            </div>
            <div className="pc-lib-details-hint">{spec.hint}</div>
            <div className="pc-lib-details-params">
              {Object.entries(spec.params).map(([pk, ps]) => (
                <span key={pk}>
                  {pk} ({ps.min}~{ps.max}
                  {ps.unit ? ` ${ps.unit}` : ""})
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );

  return {
    items,
    thumbs,
    detailTop,
    detailBottom,
    emptyHint: "让 AI 助手新建音频效果,或从「音频预设」新建",
    emptyDetail:
      rawFx.length === 0 ? (
        <div className="pc-left-note">
          还没有音频效果。让 Agent 建一个（比如「把配乐压低给人声让路」「给结尾的字加大厅混响」），或从「音频预设」组新建。
        </div>
      ) : (
        <div className="pc-left-note">没搜到匹配的效果。</div>
      ),
  };
}

/** 特效 → 音频预设组:AUDIO_FX_PRESETS,点一条 = 从预设新建(选中了能挂的片段就顺手挂上) */
export function useAudioPresetsGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  const ro = useReadOnly();
  const { selClip, selMedia } = useSelectedAudioClip();
  const canApply = selClip && selMedia && selMedia.kind !== "image";

  const run = (fn: () => unknown, ok: string) => {
    try {
      fn();
      flash(ok, 2000);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 2000);
    }
  };

  const hits = AUDIO_FX_PRESETS.map((preset, idx) => ({ preset, idx })).filter(
    ({ preset }) =>
      !q || preset.name.toLowerCase().includes(q) || (preset.description ?? "").toLowerCase().includes(q),
  );

  const create = (preset: (typeof AUDIO_FX_PRESETS)[number]) =>
    ro.locked ? undefined : run(
      () => tools.createAudioFx({ ...preset, createdBy: "user", ...(canApply ? { clipId: selClip.id } : null) }),
      canApply ? `已新建「${preset.name}」并挂到选中片段` : `已新建「${preset.name}」`,
    );

  const items: GroupItem[] = hits.map(({ preset, idx }) => ({
    id: `preset-${idx}`,
    node: (
      <AudioStrip
        attrs={{ "data-pc-audio-preset": String(idx) }}
        icon="plus"
        className="is-click"
        edits
        role="button"
        tabIndex={0}
        title={canApply ? `点一下:从「${preset.name}」新建并挂到选中片段` : `点一下:从「${preset.name}」新建`}
        name={preset.name}
        sub={preset.description}
        onClick={() => create(preset)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            create(preset);
          }
        }}
        actions={<span className="pc-left-btn is-label">{canApply ? "新建并挂到选中" : "新建"}</span>}
      />
    ),
  }));

  const thumbs: GroupItem[] = hits.slice(0, 2).map(({ preset, idx }) => ({
    id: `preset-${idx}`,
    node: <AudioStrip icon="plus" name={preset.name} sub={preset.description} />,
  }));

  return {
    items,
    thumbs,
    detailTop: <div className="pc-left-hint">从预设新建:点一条就在音频效果库里建一份;选中了视频 / 声音片段时会顺手挂上。</div>,
    emptyDetail: <div className="pc-left-note">没搜到匹配的预设。</div>,
  };
}
