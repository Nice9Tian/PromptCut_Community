import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropClose } from "../ui/backdropClose";
import { actions, useStore } from "../store/project";
import "./ProjectSettingsDialog.css";
import { CollabSection, type CollabHandle } from "./sync/CollabSection";
import { ReadOnlyFence } from "./ReadOnlyFence";
import { useReadOnly } from "./readOnly";
import { CREATIVITY_HINT, CREATIVITY_LABEL, CREATIVITY_LEVELS, CREATIVITY_SHORT, DEFAULT_CREATIVITY, normalizeCreativity, projectCreativity, type CreativityLevel } from "../kernel/creativity.mjs";

export interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type AspectRatio = "16:9" | "4:3";
/** pinned 架构 7：项目选项里可切的帧率。新项目默认 30（`src/kernel/project.ts`） */
const FPS_OPTIONS = [24, 25, 30, 60] as const;
type Fps = (typeof FPS_OPTIONS)[number];
const FALLBACK_FPS: Fps = 30;
/** 项目里存着的帧率不在选项里（手改过工程文件）时退回 30，不悄悄改掉用户的值以外的东西 */
const asFps = (value: number): Fps => (FPS_OPTIONS as readonly number[]).includes(value) ? (value as Fps) : FALLBACK_FPS;
type Orientation = "horizontal" | "vertical";

const RESOLUTION_MAP: Record<AspectRatio, Record<Orientation, { width: number; height: number }>> = {
  "16:9": {
    horizontal: { width: 1920, height: 1080 },
    vertical: { width: 1080, height: 1920 },
  },
  "4:3": {
    horizontal: { width: 1440, height: 1080 },
    vertical: { width: 1080, height: 1440 },
  },
};

/** 根据当前画幅尺寸反推比例与方向,推导失败默认 16:9 横版 */
function inferSettings(w: number, h: number): { ratio: AspectRatio; orientation: Orientation } {
  if (w === 1920 && h === 1080) return { ratio: "16:9", orientation: "horizontal" };
  if (w === 1080 && h === 1920) return { ratio: "16:9", orientation: "vertical" };
  if (w === 1440 && h === 1080) return { ratio: "4:3", orientation: "horizontal" };
  if (w === 1080 && h === 1440) return { ratio: "4:3", orientation: "vertical" };
  if (w > 0 && h > 0) {
    const isHorizontal = w >= h;
    const r = isHorizontal ? w / h : h / w;
    if (Math.abs(r - 16 / 9) < 0.05) {
      return { ratio: "16:9", orientation: isHorizontal ? "horizontal" : "vertical" };
    }
    if (Math.abs(r - 4 / 3) < 0.05) {
      return { ratio: "4:3", orientation: isHorizontal ? "horizontal" : "vertical" };
    }
  }
  return { ratio: "16:9", orientation: "horizontal" };
}

/**
 * 项目设置对话框:配置视频画幅比例与方向,实时预览分辨率;底下一段「多用户协作」(C10a 契约第 6 节,`sync/CollabSection.tsx`)。
 * 房间关联与项目元数据分开保存:「确定」先写项目元数据,再交给协作段做开启 / 取消;它有动作在做时对话框留着显示进度与结果。
 */
export function ProjectSettingsDialog({ open, onClose }: ProjectSettingsDialogProps) {
  const curW = useStore((s) => s.project.width);
  const curH = useStore((s) => s.project.height);
  const curName = useStore((s) => s.project.name);
  const curFps = useStore((s) => s.project.fps);
  const curDuration = useStore((s) => s.project.duration);
  const curGlRoute = useStore((s) => s.project.glRoute);
  const curCreativity = useStore((s) => projectCreativity(s.project));

  const [name, setName] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [fps, setFps] = useState<Fps>(FALLBACK_FPS);
  const [duration, setDuration] = useState("");
  /** R9:canvas 卡的共享 WebGL 渲染器走哪条路线;空串 = 按宿主能力(低内存档 shared,否则 perDocument) */
  const [glRoute, setGlRoute] = useState<"" | "perDocument" | "shared">("");
  /** 创造力等级的项目默认(user-workflow.md「创造力等级」):AI 栏每个对话默认取它,桌面 APP 的会话跟随它 */
  const [creativity, setCreativity] = useState<CreativityLevel>(DEFAULT_CREATIVITY);
  const durationInputRef = useRef<HTMLInputElement>(null);
  const collabRef = useRef<CollabHandle>(null);
  // 这个项目只给了只读权限(游客):设置项照常显示,但改不了,「确定」置灰,只剩「关闭」
  const ro = useReadOnly();

  const currentRes = RESOLUTION_MAP[ratio][orientation];

  const handleConfirm = async () => {
    if (ro.locked) { onClose(); return; }
    if (!durationInputRef.current?.reportValidity()) return;
    const requestedDuration = Number(duration);
    if (!Number.isFinite(requestedDuration) || requestedDuration < 1) return;
    // 名字允许留空,但不允许真的变成空标题——空了就退回「未命名」
    actions.setProjectMeta({
      name: name.trim() || "未命名",
      width: currentRes.width,
      height: currentRes.height,
      // pinned 架构 7：所有步长按 1/fps。成本键含 fps（`cardCostKey`），换了帧率
      // 全部卡的记录都失配 —— `probeRunner` 据此重挡一次遮罩、重测一轮。
      fps,
      // 切了路线:两个舞台按新的生效路线重建连接;`device` 串跟着变,probeRunner 重挡遮罩、重测(同切 fps)
      glRoute: glRoute || undefined,
      // 出厂的「高」不落字段:旧项目没有这个字段,存盘结果和从没改过一样
      creativity: creativity === DEFAULT_CREATIVITY ? undefined : creativity,
    });
    if (requestedDuration !== curDuration) actions.setDurationManual(requestedDuration);
    // 多用户协作:勾上并保存 = 开启,取消勾选并保存 = 关闭;这一段在忙时对话框不关
    if (await collabRef.current?.apply(name.trim() || "未命名")) return;
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  const confirmRef = useRef(handleConfirm);
  const cancelRef = useRef(handleCancel);

  // 照 ConfirmDialog.tsx 的做法:在无依赖的 useEffect 里同步 ref,不在 render 期间产生副作用
  useEffect(() => {
    confirmRef.current = handleConfirm;
    cancelRef.current = handleCancel;
  });

  useEffect(() => {
    if (open) {
      const initial = inferSettings(curW, curH);
      setRatio(initial.ratio);
      setOrientation(initial.orientation);
      setName(curName);
      setFps(asFps(curFps));
      setDuration(String(curDuration));
      setGlRoute(curGlRoute ?? "");
      setCreativity(curCreativity);
    }
  }, [open, curW, curH, curName, curFps, curDuration, curGlRoute, curCreativity]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // 「多用户协作」里的输入框自己处理回车(作废并重新生成要输创建者密码),不当成整个对话框的「确定」
      if ((e.target as HTMLElement | null)?.closest?.(".pc-collab")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void confirmRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 遮罩:按下和松开都落在遮罩上才关,在输入框里拖着选文字不会误关(见 ui/backdropClose.ts)
  const backdrop = useBackdropClose(handleCancel);
  if (!open) return null;

  return createPortal(
    <div className="pc-dialog-mask" {...backdrop}>
      <div
        className="pc-dialog pc-dialog--collab"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-dialog-title-settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="pc-dialog-title-settings" className="pc-dialog-title">
          项目设置
        </div>
        <div className="pc-dialog-body">
          {ro.locked && <div className="pc-dialog-row" data-pc="settings-readonly-note">{ro.why}</div>}
          <ReadOnlyFence>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-name">项目名称</label>
            <input
              id="pc-proj-name"
              className="pc-dialog-input"
              type="text"
              value={name}
              maxLength={80}
              placeholder="未命名"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">画幅比例</span>
            <div className="pc-dialog-options">
              <button
                type="button"
                className={`pc-dialog-opt${ratio === "16:9" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setRatio("16:9")}
              >
                16:9
              </button>
              <button
                type="button"
                className={`pc-dialog-opt${ratio === "4:3" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setRatio("4:3")}
              >
                4:3
              </button>
            </div>
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">画幅方向</span>
            <div className="pc-dialog-options">
              <button
                type="button"
                className={`pc-dialog-opt${orientation === "horizontal" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setOrientation("horizontal")}
              >
                横版
              </button>
              <button
                type="button"
                className={`pc-dialog-opt${orientation === "vertical" ? " pc-dialog-opt--on" : ""}`}
                onClick={() => setOrientation("vertical")}
              >
                竖版
              </button>
            </div>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-fps">帧率</label>
            <select
              id="pc-proj-fps"
              data-pc="fps-select"
              className="pc-dialog-select"
              value={fps}
              onChange={(e) => setFps(asFps(Number(e.target.value)))}
            >
              {FPS_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} fps</option>
              ))}
            </select>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-gl-route">三维渲染</label>
            <select
              id="pc-proj-gl-route"
              data-pc="gl-route-select"
              className="pc-dialog-select"
              value={glRoute}
              onChange={(e) => setGlRoute(e.target.value as "" | "perDocument" | "shared")}
            >
              <option value="">自动(按本机内存)</option>
              <option value="perDocument">每个舞台各一个</option>
              <option value="shared">两个舞台共用一个(省内存)</option>
            </select>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-creativity">创造力等级</label>
            <select
              id="pc-proj-creativity"
              data-pc="creativity-select"
              className="pc-dialog-select"
              value={creativity}
              title={`${CREATIVITY_LABEL[creativity]}:${CREATIVITY_HINT[creativity]}。AI 栏每个对话默认取这个等级,可以单独改;桌面 APP 的会话跟随它`}
              onChange={(e) => setCreativity(normalizeCreativity(e.target.value) ?? DEFAULT_CREATIVITY)}
            >
              {CREATIVITY_LEVELS.map((lv) => (
                <option key={lv} value={lv} title={CREATIVITY_HINT[lv]}>{CREATIVITY_LABEL[lv]} · {CREATIVITY_SHORT[lv]}</option>
              ))}
            </select>
          </div>
          <div className="pc-dialog-row">
            <label className="pc-dialog-label" htmlFor="pc-proj-duration">总时长（秒）</label>
            <input
              ref={durationInputRef}
              id="pc-proj-duration"
              className="pc-dialog-input"
              type="number"
              min="1"
              step="any"
              required
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="pc-dialog-row">
            <span className="pc-dialog-label">应用分辨率</span>
            <span className="pc-dialog-res">
              {currentRes.width} × {currentRes.height}
            </span>
          </div>
          </ReadOnlyFence>
          <CollabSection ref={collabRef} open={open} />
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn" onClick={handleCancel}>
            {ro.locked ? "关闭" : "取消"}
          </button>
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            disabled={ro.locked}
            title={ro.title()}
            onClick={() => void handleConfirm()}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
