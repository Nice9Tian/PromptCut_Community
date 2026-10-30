import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ModelBar } from "../ModelBar";
import { IconPaperclip } from "../../../ui/icons";
import type { AiProvider, ChatAttachment, ProviderInfo, PublicAiConfig } from "../../../ai/types";
import type { Role } from "../../../ai/roles";
import { attachIcon } from "./attachIcon";
import { usePopover } from "./usePopover";
import {
  COMPOSER_MAX_RATIO,
  COMPOSER_MIN_H,
  MESSAGES_MIN_H,
  persistComposerHeight,
  resetComposerHeight,
  setComposerHeight,
  useComposerHeight,
} from "./composerHeight";
import "./chat.css";

/**
 * 云端下「一键配特效」置灰的悬停说明。它在本机只是按角色依次发两条消息(`useAiChat.ts` 的 `runWorkflow`),本身云端也做得了;
 * 卡在第一步:剪辑导演之后的特效助理要「根据他们说的内容」配字幕与动效,那得先给每个视频做语音识别(`transcribe_media`),
 * 而语音识别在云节点上这一版还没接上(`server/agent/service/cloud-tools.mjs` 里 `transcribe_media`、`auto_workflow` 记为「还没接上」)。
 * 接上之后:去掉这里的置灰,`CloudAiPanel` 的 `workflowRoles`、`onRunWorkflow` 改成按角色依次发给云端对话。
 */
export const CLOUD_NO_WORKFLOW = "一键配特效的第一步要给每个视频做语音识别,云节点上这一版还没接上语音识别(要节点上的 Python 运行环境和语音模型),接上之后才能用。现在可以改用本机接入方式";

/** 「✦」菜单里的几样:不常点、但一点就改变这一轮怎么跑的东西,原来挤在顶栏上 */
export interface ComposerMenuProps {
  /** 「一键配特效」依次跑的角色,只用来写悬停说明 */
  workflowRoles: Role[];
  onRunWorkflow: () => void;
  /** 有对话才出得了诊断报告 */
  canDiagnose: boolean;
  onOpenDiagnostics: () => void;
  onNewChat: () => void;
  /** 新对话开不了（游客每个项目只能开一个对话）时的说明：给了就把「新对话」置灰、悬停写这一句；不给照常 */
  newChatDisabledReason?: string;
  /** 「云端」接入方式:一键配特效在云端下置灰(悬停写原因);诊断报告照常可用,内容换成这段云端对话的(〔用户 2026-10-07 定〕) */
  cloudMode?: boolean;
}

/** 「云端」接入方式(契约 9.5) */
export interface ComposerCloud {
  /** 驱动下拉里要不要有「云端」这一项 */
  show: boolean;
  selected: boolean;
  /** 这一项能不能选(创建者关了开关时不能,`disabledReason` 是悬停说明) */
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
  /** 选中云端时又选了本机的某个驱动 */
  onLeave: (p: AiProvider) => void;
  /** 云端下模型那一组(`CloudModelBar`) */
  toolbar: ReactNode;
  /** 云端下附件按钮的悬停说明(附件传到云端这个对话的工作目录) */
  attachTitle?: string;
  /** 已不用(云端下附件按钮不再置灰)。`AiPanel.tsx` 里还在传一个空串,等那边顺手删掉后这一项也可以删 */
  attachReason?: string;
}

export interface ComposerProps {
  /** 草稿文字。状态在 AiPanel:预览右键引用卡片、空状态的示例句都要往里写 */
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachments: ChatAttachment[];
  uploading: boolean;
  /** 点曲别针:AiPanel 去点它自己那个隐藏的 file input */
  onPickFiles: () => void;
  onRetryAttachment: (id: string, srcPath: string | null) => void;
  onRemoveAttachment: (idx: number) => void;
  /**
   * Enter、「发送」「加入队列」按钮都走这里,交上去的是此刻输入框里的原文(没 trim)。
   * 直接发还是进队列由 AiPanel 看这一页忙不忙决定
   */
  onSubmit: (text: string) => void;
  /** 运行中「■ 停止」 */
  onStop: () => void;
  /** Optional authority gate for shared cloud runs; omitted local callers keep their historical stop behavior. */
  canStop?: boolean;
  stopDisabledReason?: string;
  streaming: boolean;
  /** 快捷键被别处接管(对话框开着之类)时 Enter 只是换行 */
  hotkeysOff?: boolean;
  /** 这一页不在前台时 Enter 也只是换行 */
  active?: boolean;
  provider: AiProvider | null;
  providers: ProviderInfo[];
  onSetProvider: (p: AiProvider) => void;
  config: PublicAiConfig | null;
  menu: ComposerMenuProps;
  /**
   * 「云端」接入方式:不给就与原来逐条相同。给了,驱动下拉里多一项「云端」(`show`),选中时模型那一组换成 `toolbar`,
   * 附件按钮照常可用(传到云端);「一键配特效」置灰并写原因。在线页面没有本机驱动,下拉里只有这一项。
   */
  cloud?: ComposerCloud;
  /** 这一页的 id:运行选项里的创造力等级按页存 */
  tabId?: string;
  /** 开始页上的引导(StartHero.tsx):"input" = 输入框描边脉动;"send" = 发送按钮闪;不给 = 不引导 */
  guide?: "input" | "send" | null;
  /** 禁用输入框与发送按钮（如当前对话已无读取权限） */
  disabled?: boolean;
  disabledReason?: string;
  /**
   * 这个项目只给了只读权限（游客，`editor/readOnly.ts`）：不能给 Agent 发消息，也不能停别人的任务；
   * 一键配特效、新对话置灰，没有引导输入的脉动。对话历史照常读。`readOnlyReason` 是置灰说明（`viewOnlyText()` 那一句），
   * 由面板（AiPanel / CloudAiPanel）读出来传进来：这里不自己订阅权限，输入区的渲染不依赖同步管理。
   * 和 `disabled` 并存时，「对话没有读取权限」那一条原因优先。
   */
  readOnly?: boolean;
  readOnlyReason?: string;
}

function providerLabel(p: ProviderInfo): string {
  return p.label || (p.id === "claude" ? "Claude Code" : p.id === "agy" ? "Antigravity" : p.id === "codex" ? "Codex" : p.id);
}

/** 工具条上的「✦」菜单 */
function ComposerMenu(props: ComposerMenuProps & { streaming: boolean; readOnly?: boolean; readOnlyReason?: string }) {
  const { workflowRoles, onRunWorkflow, canDiagnose, onOpenDiagnostics, onNewChat, newChatDisabledReason, streaming, cloudMode } = props;
  const pop = usePopover();
  // 这个项目只给了只读权限(游客):一键配特效、新对话都是要给 Agent 发话,置灰;诊断报告只读对话内容,照常
  const ro = { locked: !!props.readOnly, why: props.readOnlyReason ?? "", title: (own?: string) => (props.readOnly ? props.readOnlyReason : own) };
  /** 点了一项就收起菜单 */
  const pick = (fn: () => void) => () => {
    pop.setOpen(false);
    fn();
  };
  return (
    <div className="ai-pop-anchor" ref={pop.anchorRef}>
      <button
        type="button"
        className="pc-icon-btn ai-bar-btn ai-spark-btn"
        data-pc="ai-menu"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-label="更多操作"
        title="更多操作:一键配特效、诊断报告、新对话"
        onClick={pop.toggle}
      >
        <span aria-hidden="true">✦</span>
      </button>
      <div className="ai-pop ai-menu" role="menu" aria-label="更多操作" data-pop style={{ display: pop.open ? undefined : "none" }}>
        <button
          type="button"
          role="menuitem"
          className="ai-menu-item"
          data-pc="ai-auto-workflow"
          title={ro.locked ? ro.why : cloudMode ? CLOUD_NO_WORKFLOW : `依次跑：${workflowRoles.map((r) => r.name).join(" → ")}`}
          disabled={streaming || cloudMode || ro.locked}
          onClick={pick(onRunWorkflow)}
        >
          <span className="ai-menu-icon" aria-hidden="true" />
          一键配特效
        </button>
        <button
          type="button"
          role="menuitem"
          className="ai-menu-item"
          data-pc="ai-diagnostics"
          title={cloudMode ? "把这段云端对话的过程、出错原因和客户端信息收成 JSON(不含任何凭证),在子窗口里复制 / 存文件 / 提交" : "把这段对话和每一步执行事件收成 JSON(不含密钥),在子窗口里复制 / 存文件 / 提交"}
          disabled={!canDiagnose}
          onClick={pick(onOpenDiagnostics)}
        >
          <span className="ai-menu-icon" aria-hidden="true">⎘</span>
          诊断报告
        </button>
        <div className="ai-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="ai-menu-item" data-pc="ai-new-chat" disabled={ro.locked || !!newChatDisabledReason} title={ro.locked ? ro.title() : newChatDisabledReason ?? undefined} onClick={pick(onNewChat)}>
          <span className="ai-menu-icon" aria-hidden="true">＋</span>
          新对话
        </button>
      </div>
    </div>
  );
}

/**
 * 输入区右上角的拖柄(⌝):竖着拖改输入区高度,往上拖变高;双击回到默认的三分之一。
 *
 * 高度记在 composerHeight 的模块级 store 里,所有分页一起变。上限是面板高度的 70%,
 * 在按下那一刻量面板 —— 拖动过程中面板本身不会变高变矮,不用每帧再量。
 * 拖动期间给 <body> 打 data-pc-resizing,和 ResizeHandle 一样:预览 iframe 这会儿不吃鼠标事件。
 */
function ComposerGrip({ boxRef }: { boxRef: RefObject<HTMLDivElement | null> }) {
  const [dragging, setDragging] = useState(false);
  /** 正在拖时的收尾。分页在拖动中途被关掉(组件卸载)也要执行,否则 <body> 上的拖动状态一直留着 */
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const panel = box.closest<HTMLElement>(".ai-panel");
    const panelH = panel?.clientHeight ?? window.innerHeight;
    // 同一列里别的块(顶栏、思考条、排队列表)照实扣掉,消息区至少留 MESSAGES_MIN_H;再用比例夹一道
    let others = 0;
    for (const el of Array.from(box.parentElement?.children ?? [])) {
      if (el !== box && !el.classList.contains("ai-messages")) others += (el as HTMLElement).offsetHeight;
    }
    const maxH = Math.max(COMPOSER_MIN_H, Math.min(Math.floor(panelH * COMPOSER_MAX_RATIO), panelH - others - MESSAGES_MIN_H - 10));
    const startY = e.clientY;
    const startH = box.getBoundingClientRect().height;
    const pointerId = e.pointerId;
    /** 真的拖动过才落盘:只点一下(双击复位的前两下也是)不能把默认的三分之一记成一个固定像素值 */
    let moved = false;

    try {
      grip.setPointerCapture(pointerId);
    } catch {
      // 指针已经不在了(合成事件等),没有捕获也能拖
    }
    setDragging(true);
    document.body.dataset.pcResizing = "y";
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      // 往上拖(clientY 变小)是变高
      const dy = startY - ev.clientY;
      if (!moved && dy === 0) return;
      moved = true;
      setComposerHeight(Math.min(maxH, Math.max(COMPOSER_MIN_H, startH + dy)));
    };
    const onUp = () => {
      if (endDrag.current !== onUp) return;
      endDrag.current = null;
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      grip.removeEventListener("lostpointercapture", onUp);
      try {
        grip.releasePointerCapture(pointerId);
      } catch {
        // 已经放开了
      }
      setDragging(false);
      delete document.body.dataset.pcResizing;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (moved) persistComposerHeight();
    };
    endDrag.current = onUp;
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    grip.addEventListener("lostpointercapture", onUp);
  };

  return (
    <div
      className={`ai-composer-grip${dragging ? " is-dragging" : ""}`}
      data-pc="ai-composer-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整输入框高度"
      title="拖动调整输入框高度,双击复位"
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetComposerHeight()}
    >
      {/* 一个转了 90° 的 L:上沿一横、右沿一竖,落在输入框的右上角 */}
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 3.5h7v7" />
      </svg>
    </div>
  );
}

/**
 * 输入区,占面板高度的 1/3:附件卡片在最上,输入框填满中间(不自动增高,超出在里面滚),
 * 底部一条 36px 工具条 —— 左边 附件(曲别针)、「✦」菜单、驱动方式 + 模型、「⋯」运行选项,右边发送 / 停止。
 *
 * 这里不直接碰 useAiChat:发送、停止都交给 onSubmit / onStop,草稿也是受控的,
 * 发什么、什么时候清空由 AiPanel 决定。
 */
export function Composer(props: ComposerProps) {
  const {
    text,
    onTextChange,
    textareaRef,
    attachments,
    uploading,
    onPickFiles,
    onRetryAttachment,
    onRemoveAttachment,
    onSubmit,
    onStop,
    canStop: canStopProp = true,
    stopDisabledReason: stopReasonProp = "只能停止自己发起的任务",
    streaming,
    hotkeysOff,
    active = true,
    provider,
    providers,
    onSetProvider,
    config,
    menu,
    tabId,
    cloud,
    guide: guideProp = null,
    disabled: disabledProp = false,
    disabledReason: disabledReasonProp,
    readOnly = false,
    readOnlyReason = "",
  } = props;
  // 这个项目只给了只读权限(游客):不能给 Agent 发消息(也不能停别人的任务)。对话历史照常读,输入区整个置灰,说明是 viewOnlyText()。
  // 已有的「对话无读取权限」那一条原因优先(那是另一回事)
  const disabled = disabledProp || readOnly;
  const disabledReason = disabledProp ? disabledReasonProp : readOnly ? readOnlyReason : disabledReasonProp;
  const guide = readOnly ? null : guideProp;
  const canStop = canStopProp && !readOnly;
  const stopDisabledReason = readOnly ? readOnlyReason : stopReasonProp;
  const cloudOn = !!cloud?.selected;
  /** 附件条上的动词:本机是「导入」,云端是传到云节点的「上传」 */
  const verb = cloudOn ? "上传" : "导入";

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (hotkeysOff || !active) return;
    // 输入法还在拼字时按的 Enter 是「上屏」,不是发送
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (disabled) return;
      onSubmit(text);
    }
  };

  /** 用户拖过的高度(所有分页共用);没拖过是 null,照 chat.css 占面板三分之一 */
  const composerH = useComposerHeight();
  const boxRef = useRef<HTMLDivElement>(null);
  // 拖过就换成这个高度,但允许缩(最矮到 CSS 的 min-height):面板后来变矮、思考条和排队列表又占了地方时,
  // 输入框先让出来,消息区保住 min-height。再用 70% 夹一道
  const sizeStyle = composerH !== null
    ? { flex: `0 1 ${composerH}px`, maxHeight: `${Math.round(COMPOSER_MAX_RATIO * 100)}%` }
    : undefined;

  return (
    <div ref={boxRef} className={`ai-composer${streaming ? " is-streaming" : ""}${guide ? ` is-guide-${guide}` : ""}`} data-pc="ai-composer" data-pc-guide={guide || undefined} style={sizeStyle}>
      <ComposerGrip boxRef={boxRef} />
      {attachments.length > 0 && (
        <div className="ai-attachments">
          {attachments.map((a, idx) => (
            <div
              key={a.id || idx}
              className={`ai-attachment-chip${a.status === "importing" ? " is-importing" : ""}${a.status === "error" ? " is-error" : ""}`}
              title={a.status === "error" ? (a.error || `${verb}失败`) : a.name}
              onClick={() => {
                if (a.status !== "error") return;
                // 失败的卡片点一下重试:先变回导入中,再重新走一遍导入
                if (a.id) onRetryAttachment(a.id, a.srcPath ?? null);
              }}
            >
              {a.status === "importing" ? <span className="ai-spinner" aria-hidden /> : <span aria-hidden="true">{attachIcon(a.kind)}</span>}
              <span className="ai-attachment-name">{a.name}</span>
              {a.status === "importing" ? ` · ${verb}中…` : a.status === "error" ? ` · ${verb}失败${cloudOn && a.error ? `:${a.error}` : ""},点击重试` : ""}
              <button
                type="button"
                className="ai-attachment-remove"
                aria-label={`移除 ${a.name}`}
                onClick={(e) => { e.stopPropagation(); onRemoveAttachment(idx); }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="ai-composer-input"
        data-pc="ai-input"
        aria-label="给 AI 发消息"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? (disabledReason ?? "当前对话已无读取权限") : uploading ? "正在导入..." : streaming ? "Agent 正在运行,Enter 加入队列,Shift+Enter 换行" : "输入消息,Enter 发送,Shift+Enter 换行"}
        disabled={uploading || disabled}
      />

      <div className="ai-composer-bar">
        <div className="ai-composer-tools">
          <button
            type="button"
            className="pc-icon-btn ai-bar-btn"
            data-pc="ai-attach"
            title={disabled ? (disabledReason ?? "当前对话已无读取权限") : cloudOn ? (cloud!.attachTitle ?? "添加附件") : "添加附件"}
            aria-label="添加附件"
            onClick={onPickFiles}
            disabled={uploading || disabled}
          >
            <IconPaperclip size={16} />
          </button>
          <ComposerMenu {...menu} cloudMode={cloudOn} streaming={streaming} readOnly={readOnly} readOnlyReason={readOnlyReason} />
          {/* 当前用哪个驱动是这一页的身份,再窄也留在工具条上 */}
          <select
            className="ai-bar-select ai-provider-select"
            data-pc="ai-provider"
            aria-label="AI 驱动方式"
            title="驱动方式"
            value={cloudOn ? "cloud" : provider || ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "cloud") cloud?.onSelect();
              else if (cloudOn) cloud!.onLeave(v as AiProvider);
              else onSetProvider(v as AiProvider);
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available} title={p.available ? "" : "未安装"}>
                {providerLabel(p)}
              </option>
            ))}
            {cloud?.show && (
              <option value="cloud" disabled={cloud.disabled} title={cloud.disabled ? cloud.disabledReason : "消息发到云端,在云节点上执行;关掉软件也会继续"}>
                云端
              </option>
            )}
          </select>
          {cloudOn ? cloud!.toolbar : <ModelBar provider={provider} config={config} disabled={streaming} tabId={tabId} />}
        </div>
        {streaming ? (
          <>
            {/* 运行中还能接着写:有内容就给「加入队列」(Enter 也是),这一轮落定后按顺序自动发 */}
            {(text.trim().length > 0 || attachments.length > 0) && (
              <button type="button" className="pc-btn-primary ai-send-btn" data-pc="ai-enqueue" title="Agent 这一轮完成后自动发送(Enter)" disabled={disabled} onClick={() => !disabled && onSubmit(text)}>
                加入队列
              </button>
            )}
            <button type="button" className="pc-btn-primary ai-send-btn is-stop" data-pc="ai-stop"
              title={canStop ? "停止这一轮,已完成的修改保留;排队中的消息暂停发送" : stopDisabledReason}
              aria-label={canStop ? undefined : stopDisabledReason} disabled={!canStop} onClick={onStop}>
              ■ 停止
            </button>
          </>
        ) : (
          <button type="button" className="pc-btn-primary ai-send-btn" data-pc="ai-send" title={disabled ? (disabledReason ?? "无法发送") : "发送(Enter)"} disabled={disabled} onClick={() => !disabled && onSubmit(text)}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
