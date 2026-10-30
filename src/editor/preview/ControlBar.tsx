/**
 * 预览播放栏(配色诊断与修正 v2 整屏,中栏底部)。
 * 一张 L1 卡片:上面一条 3px 进度线(强调色填充 + 主文字色圆点),
 * 下面一行:上一段 / 播放 / 下一段 / 重播 四个 28 方钮(播放键是卡片里唯一的实心强调色),
 * 当前时间(等宽 15px,点一下能直接输入跳转)+ 总时长,右侧扬声器 + 64px 音量滑条。
 */
import React, { useEffect, useRef, useState } from "react";
import { actions, useStore } from "../../store/project";
import {
  IconLoop,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward,
  IconVolume,
  IconVolumeMute,
} from "../../ui/icons";
import "./preview.css";

function parseTime(str: string): number {
  const s = str.trim();
  if (!s) return NaN;
  if (s.includes(":")) {
    const [m, sec] = s.split(":").map(parseFloat);
    if (!isNaN(m) && !isNaN(sec)) return m * 60 + sec;
    return NaN;
  }
  return parseFloat(s);
}

export function ControlBar() {
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => s.project.duration);
  const t = useStore((s) => s.t);
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);

  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const submit = () => {
    if (!editing) return;
    setEditing(false);
    const parsed = parseTime(val);
    if (!isNaN(parsed)) actions.seek(Math.max(0, Math.min(parsed, duration)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") setEditing(false);
  };

  /** 进度线:按下即定位,按住可拖 */
  const scrubTo = (clientX: number) => {
    const el = progressRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    actions.seek(ratio * duration);
  };
  const onProgressDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    scrubTo(e.clientX);
    const onMove = (ev: PointerEvent) => scrubTo(ev.clientX);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const ratio = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
  const shownVolume = muted ? 0 : volume;

  return (
    <div className="pc-pv-ctrl" data-pc="control-bar">
      <div ref={progressRef} className="pc-pv-progress" onPointerDown={onProgressDown} title="拖动 = 定位播放头">
        <div className="pc-pv-progress-fill" style={{ right: `${(1 - ratio) * 100}%` }} />
        <div className="pc-pv-progress-knob" style={{ left: `${ratio * 100}%` }} />
      </div>

      <div className="pc-pv-row">
        <div className="pc-pv-btns">
          <button type="button" className="pc-pv-btn" onClick={() => actions.seek(0)} title="跳到开头">
            <IconSkipBack size={14} />
          </button>
          <button
            type="button"
            className="pc-pv-btn pc-pv-btn--play"
            onClick={() => actions.togglePlay()}
            title={playing ? "暂停" : "播放"}
          >
            {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
          </button>
          <button type="button" className="pc-pv-btn" onClick={() => actions.seek(duration)} title="跳到结尾">
            <IconSkipForward size={14} />
          </button>
          <button type="button" className="pc-pv-btn" onClick={() => actions.replay()} title="重播">
            <IconLoop size={14} />
          </button>
        </div>

        <span className="pc-pv-time" title="点击输入秒数跳转">
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onBlur={submit}
              onKeyDown={onKeyDown}
            />
          ) : (
            <span
              onClick={() => {
                setVal(t.toFixed(2));
                setEditing(true);
              }}
            >
              {t.toFixed(2)}
            </span>
          )}
        </span>
        <span className="pc-pv-time-total">/ {duration.toFixed(2)} s</span>

        <div className="pc-pv-vol">
          <button
            type="button"
            className="pc-pv-vol-btn"
            onClick={() => actions.toggleMute()}
            title={muted ? "取消静音" : "静音"}
            aria-pressed={muted}
          >
            {muted || volume === 0 ? <IconVolumeMute size={14} /> : <IconVolume size={14} />}
          </button>
          <div className="pc-pv-vol-track" style={{ position: "relative" }}>
            <div className="pc-pv-vol-fill" style={{ right: `${(1 - shownVolume) * 100}%` }} />
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(shownVolume * 100)}
              onChange={(e) => actions.setVolume(Number(e.target.value) / 100)}
              aria-label="预览音量"
              title="预览音量(不影响导出)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
