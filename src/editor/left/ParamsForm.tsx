import { useState, useEffect, useSyncExternalStore } from "react";
import { cardRunState, cardRunStatesGen, onCardRunStatesChanged } from "../../kernel/registry";
import { runStateMessage } from "../sync/cardRunStates";
import { actions } from "../../store/project";
import type { Control } from "../../kernel/types";
import { paramsEmptyText, paramsPartialText, paramsSkippedText, type ParamsCardView } from "./paramsView";
import { ASSET_TARGET } from "../../cards/catalogAssets";
import type { TrackClip } from "../../kernel/project";
import { SpeakerPicker } from "./SpeakerPicker";
import { NumberField } from "../fields/NumberField";
import { useReadOnly } from "../readOnly";
import { GESTURE_COMMIT_INTERVAL_MS, GESTURE_WINDOW_MS, commitMerged, createLatestThrottle, newGestureKey } from "../fields/mergedEdit";

function isSpeakerVideoControl(ctrl: Control): boolean {
  if (ctrl.type !== "text") return false;
  const keyLower = ctrl.key.toLowerCase();
  const keyMatch = /speaker|speech|talking|talkinghead|cam|video|口播/.test(keyLower);
  const labelMatch = ctrl.label.includes("口播") || ctrl.label.includes("视频");
  return keyMatch || labelMatch;
}

/**
 * 同步来的用户卡 / 素材效果卡没在这个浏览器里运行时,说明为什么(`docs/plan/online-card-exec-contract.md` 第 8 节的表)。
 * 能运行、还在载入、不是同步来的卡:什么都不画。
 */
function CardRunNote({ cardId }: { cardId: string | undefined }) {
  useSyncExternalStore(onCardRunStatesChanged, cardRunStatesGen);
  const state = cardRunState(cardId);
  const text = runStateMessage(state);
  if (!text) return null;
  return <div className="px-3 pt-2 text-left text-[11px] pc-left-muted" data-pc="params-run-state" data-state={state?.state}>{text}</div>;
}

/**
 * `cardDef`:能跑的定义,或在线页面同步来的用户卡的只读视图(`registry.syncedCardView`;没有组件,改参数照常经文档服务提交)。
 */
export function ParamsForm({ clip, cardDef }: { clip: TrackClip; cardDef: ParamsCardView | undefined }) {
  const [pickerCtrlKey, setPickerCtrlKey] = useState<string | null>(null);
  // 只读项目(游客):外面有只读围栏把原生控件置灰;这里管围栏管不到的「按住标签左右拖」改数字
  const ro = useReadOnly();

  const empty = paramsEmptyText(cardDef);
  if (empty !== null || !cardDef) {
    return (
      <div className="p-4 text-center text-xs pc-left-muted" data-pc="params-empty">
        {empty}
        {paramsSkippedText(cardDef) && (
          <div className="mt-2 text-left text-[11px]" data-pc="params-skipped">{paramsSkippedText(cardDef)}</div>
        )}
        <CardRunNote cardId={clip.cardId} />
      </div>
    );
  }

  const merged: Record<string, any> = { ...cardDef.defaults, ...clip.params };

  const handlePointerDownNumber = (e: React.PointerEvent, key: string, current: number, step: number = 1, min?: number, max?: number) => {
    if (ro.locked) return;
    const el = e.currentTarget as HTMLDivElement;
    el.setPointerCapture(e.pointerId);

    const x0 = e.clientX;
    const v0 = current;

    el.classList.add("pc-left-strong");
    document.body.style.cursor = "ew-resize";

    // 一次左右拖动(按下到松开)只记一步撤销;拖动中提交限速,松手补交最后一个值
    const gestureKey = newGestureKey("params-scrub");
    const throttle = createLatestThrottle<number>(
      (v) => commitMerged(gestureKey, GESTURE_WINDOW_MS, () => actions.setClipParams(clip.id, { [key]: v })),
      GESTURE_COMMIT_INTERVAL_MS,
    );

    const onMove = (moveEvent: PointerEvent) => {
      let next = v0 + (moveEvent.clientX - x0) * step;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);

      next = Math.round(next / step) * step;
      next = Number(next.toFixed(6));

      throttle.push(next);
    };

    const onUp = (upEvent: PointerEvent) => {
      throttle.flush();
      try { el.releasePointerCapture(upEvent.pointerId); } catch { /* 已经放掉了(pointercancel) */ }
      el.classList.remove("pc-left-strong");
      document.body.style.cursor = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const isBlank = (s: any) => s == null || String(s).trim() === "";
  const isHex = (s: any) => /^#([0-9A-Fa-f]{3}){1,2}$/.test(String(s));
  const isColorOk = (s: any) => isBlank(s) || isHex(s);

  return (
    <div className="flex flex-col py-2">
      {cardDef.controls.map((ctrl: Control) => {
        const val = merged[ctrl.key];

        return (
          <div key={ctrl.key} className="flex items-center gap-2 px-3 py-1">
            {ctrl.type === "number" ? (
              <div
                data-pc-drag={ctrl.key}
                className={`w-20 shrink-0 text-[11px] pc-left-muted truncate select-none${ro.locked ? "" : " cursor-ew-resize"}`}
                title={ro.locked ? `${ctrl.label}\n${ro.why}` : `${ctrl.label} (左右拖动可以微调)`}
                onPointerDown={(e) => handlePointerDownNumber(e, ctrl.key, Number(val) || 0, ctrl.step, ctrl.min, ctrl.max)}
              >
                {ctrl.label}
              </div>
            ) : (
              <div className="w-20 shrink-0 text-[11px] pc-left-muted truncate" title={ctrl.label}>
                {ctrl.label}
              </div>
            )}

            <div className="flex-1 min-w-0 flex items-center gap-2">
              {ctrl.type === "text" && (
                isSpeakerVideoControl(ctrl) ? (
                  <div className="flex w-full items-center gap-1">
                    <input
                      data-pc-param={ctrl.key}
                      type="text"
                      value={String(val ?? "")}
                      onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                      className="flex-1 pc-left-input"
                    />
                    <button
                      type="button"
                      data-pc-pick={ctrl.key}
                      onClick={() => setPickerCtrlKey(ctrl.key)}
                      title="选择口播视频"
                      className="pc-left-btn is-icon"
                    >
                      …
                    </button>
                  </div>
                ) : (
                  <input
                    data-pc-param={ctrl.key}
                    type="text"
                    value={String(val ?? "")}
                    onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                    className="w-full pc-left-input"
                  />
                )
              )}

              {ctrl.type === "number" && (
                <NumberField
                  attrs={{ "data-pc-param": ctrl.key }}
                  min={ctrl.min}
                  max={ctrl.max}
                  step={ctrl.step ?? 1}
                  value={Number.isFinite(val) ? val : undefined}
                  onCommit={(v) => actions.setClipParams(clip.id, { [ctrl.key]: v })}
                  className="w-full pc-left-input"
                />
              )}

              {ctrl.type === "select" && (
                <select
                  data-pc-param={ctrl.key}
                  value={String(val ?? "")}
                  onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                  className="w-full pc-left-select"
                >
                  {ctrl.options.map((o: { value: string; label: string }) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}

              {ctrl.type === "asset" && (
                <div className="flex w-full flex-col gap-1">
                  <select
                    data-pc-param={ctrl.key}
                    value={ctrl.options.some((o) => o.value === String(val ?? "")) ? String(val) : ""}
                    onChange={e => actions.setClipParams(clip.id, { ...(e.target.value ? ASSET_TARGET[ctrl.kind].extra : {}), [ctrl.key]: e.target.value })}
                    className="w-full pc-left-select"
                    title="软件自带的素材;要用别的就在下面手填"
                  >
                    <option value="">{String(val ?? "").trim() && !ctrl.options.some((o) => o.value === String(val)) ? "(自定义,见下)" : "— 不用素材 —"}</option>
                    {ctrl.options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    data-pc-param-custom={ctrl.key}
                    type="text"
                    value={String(val ?? "")}
                    placeholder="或手填 URL / JSON"
                    onChange={e => actions.setClipParams(clip.id, { [ctrl.key]: e.target.value })}
                    className="w-full pc-left-input"
                  />
                </div>
              )}

              {ctrl.type === "color" && (
                <ColorControl clipId={clip.id} ctrlKey={ctrl.key} value={String(val ?? "")} isColorOk={isColorOk} isHex={isHex} />
              )}
            </div>
          </div>
        );
      })}

      <CardRunNote cardId={clip.cardId} />

      {/* 同步来的卡:源码里有控件没认出来,认出的照常画,这里说明其余的在线改不了 */}
      {paramsPartialText(cardDef) && (
        <div className="px-3 pt-2 text-[11px] pc-left-muted" data-pc="params-partial">
          {paramsPartialText(cardDef)}
          {paramsSkippedText(cardDef) && (
            <div className="mt-1" data-pc="params-skipped">{paramsSkippedText(cardDef)}</div>
          )}
        </div>
      )}

      <div className="mt-4 px-3">
        <button
          type="button"
          onClick={() => actions.setClipParams(clip.id, {}, { merge: false })}
          className="pc-left-btn"
        >
          重置为默认
        </button>
      </div>

      {pickerCtrlKey && (
        <SpeakerPicker
          open={true}
          onClose={() => setPickerCtrlKey(null)}
          onSelect={(url) => {
            actions.setClipParams(clip.id, { [pickerCtrlKey]: url });
          }}
        />
      )}
    </div>
  );
}

function ColorControl({ clipId, ctrlKey, value, isColorOk, isHex }: { clipId: string, ctrlKey: string, value: string, isColorOk: (v: string) => boolean, isHex: (v: string) => boolean }) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <div className="flex w-full items-center gap-2">
      <input
        type="color"
        value={isHex(value) ? value : "#000000"}
        onChange={e => actions.setClipParams(clipId, { [ctrlKey]: e.target.value })}
        className="pc-left-color"
      />
      <input
        data-pc-param={ctrlKey}
        type="text"
        value={local}
        onChange={e => {
          setLocal(e.target.value);
          if (isColorOk(e.target.value)) {
            actions.setClipParams(clipId, { [ctrlKey]: e.target.value });
          }
        }}
        className={`flex-1 pc-left-input${!isColorOk(local) ? " is-error" : ""}`}
      />
    </div>
  );
}
