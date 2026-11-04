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
import { tr } from "../../../i18n/index.ts";

/**
 * Hover tooltip for "One-click effects" when it is grayed out under Cloud. Locally it just sends two messages
 * in role order (`runWorkflow` in `useAiChat.ts`), so the cloud could do it too;
 * it is stuck on the first step: after the cut director, the effects assistant has to set up captions and
 * motion graphics "based on what they say", which needs speech recognition on every video first (`transcribe_media`),
 * and speech recognition is not hooked up on cloud nodes in this version (`server/agent/service/cloud-tools.mjs`
 * marks `transcribe_media` and `auto_workflow` as "not hooked up yet").
 * Once it is hooked up: remove the gray-out here, and change `workflowRoles` and `onRunWorkflow` in `CloudAiPanel`
 * to send to the cloud chat in role order.
 */
export const CLOUD_NO_WORKFLOW = tr("The first step of one-click effects is running speech recognition on each video. This version of the cloud node does not support speech recognition yet (it needs a Python runtime and a speech model on the node), so the feature is unavailable until it does. For now you can switch to the local connection type");

/** A few items in the "✦" menu: rarely clicked, but one click changes how this round runs; they used to crowd the top bar */
export interface ComposerMenuProps {
  /** The roles that "One-click effects" runs in order, used only to write the hover tooltip */
  workflowRoles: Role[];
  onRunWorkflow: () => void;
  /** A diagnostic report can only be produced when there is a chat */
  canDiagnose: boolean;
  onOpenDiagnostics: () => void;
  onNewChat: () => void;
  /** Explanation for when a new chat cannot be opened (a guest can only open one chat per project): if given, "New chat" is grayed out and the hover shows this sentence; if not given, behaves as usual */
  newChatDisabledReason?: string;
  /** "Cloud" connection type: One-click effects is grayed out under Cloud (hover shows the reason); the diagnostic report still works, with the content switched to this cloud chat's (user decision, 2026-10-07) */
  cloudMode?: boolean;
}

/** "Cloud" connection type (contract 9.5) */
export interface ComposerCloud {
  /** Whether the driver dropdown should have a "Cloud" entry */
  show: boolean;
  selected: boolean;
  /** Whether this entry can be selected (not when the creator turned the switch off; `disabledReason` is the hover tooltip) */
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
  /** A local driver was selected while Cloud is selected */
  onLeave: (p: AiProvider) => void;
  /** The model group under Cloud (`CloudModelBar`) */
  toolbar: ReactNode;
  /** Hover tooltip of the attachment button under Cloud (attachments go to this chat's working directory in the cloud) */
  attachTitle?: string;
  /** No longer used (the attachment button is no longer grayed out under Cloud). `AiPanel.tsx` still passes an empty string; once it is removed there, this entry can be removed too */
  attachReason?: string;
}

export interface ComposerProps {
  /** Draft text. The state lives in AiPanel: quoting a card via the preview right-click and the example sentences in the empty state both write into it */
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachments: ChatAttachment[];
  uploading: boolean;
  /** Click the paperclip: AiPanel clicks its own hidden file input */
  onPickFiles: () => void;
  onRetryAttachment: (id: string, srcPath: string | null) => void;
  onRemoveAttachment: (idx: number) => void;
  /**
   * Enter and the "Send" and "Add to queue" buttons all go through here, submitting the raw text currently in the input (not trimmed).
   * Whether it is sent directly or queued is decided by AiPanel, depending on whether this tab is busy
   */
  onSubmit: (text: string) => void;
  /** "■ Stop" while running */
  onStop: () => void;
  /** Optional authority gate for shared cloud runs; omitted local callers keep their historical stop behavior. */
  canStop?: boolean;
  stopDisabledReason?: string;
  streaming: boolean;
  /** When the shortcut is taken over elsewhere (a dialog is open, for example), Enter just inserts a newline */
  hotkeysOff?: boolean;
  /** When this tab is not in the foreground, Enter also just inserts a newline */
  active?: boolean;
  provider: AiProvider | null;
  providers: ProviderInfo[];
  onSetProvider: (p: AiProvider) => void;
  config: PublicAiConfig | null;
  menu: ComposerMenuProps;
  /**
   * "Cloud" connection type: if not given, identical to before. If given, the driver dropdown gets an extra "Cloud" entry (`show`),
   * and when selected the model group is replaced with `toolbar`; the attachment button still works (uploads to the cloud);
   * "One-click effects" is grayed out with a reason. The online page has no local driver, so the dropdown has only this entry.
   */
  cloud?: ComposerCloud;
  /** The id of this tab: the creativity level in the run options is stored per tab */
  tabId?: string;
  /** Guidance on the start page (StartHero.tsx): "input" = the input box outline pulses; "send" = the send button flashes; not given = no guidance */
  guide?: "input" | "send" | null;
  /** Disable the input box and the send button (for example when the current chat no longer has read permission) */
  disabled?: boolean;
  disabledReason?: string;
  /**
   * This project only has read-only permission (guest, `editor/readOnly.ts`): cannot send messages to the Agent, nor stop other people's tasks;
   * One-click effects and New chat are grayed out, and there is no input guidance pulse. Chat history can still be read. `readOnlyReason` is the gray-out explanation
   * (the `viewOnlyText()` sentence), read out by the panel (AiPanel / CloudAiPanel) and passed in: this component does not subscribe to permissions itself,
   * so rendering the input area does not depend on the sync manager.
   * When it coexists with `disabled`, the "chat has no read permission" reason takes priority.
   */
  readOnly?: boolean;
  readOnlyReason?: string;
}

function providerLabel(p: ProviderInfo): string {
  return p.label || (p.id === "claude" ? "Claude Code" : p.id === "agy" ? "Antigravity" : p.id === "codex" ? "Codex" : p.id);
}

/** The "✦" menu on the toolbar */
function ComposerMenu(props: ComposerMenuProps & { streaming: boolean; readOnly?: boolean; readOnlyReason?: string }) {
  const { workflowRoles, onRunWorkflow, canDiagnose, onOpenDiagnostics, onNewChat, newChatDisabledReason, streaming, cloudMode } = props;
  const pop = usePopover();
  // This project only has read-only permission (guest): One-click effects and New chat both send messages to the Agent, so they are grayed out; the diagnostic report only reads chat content, so it works as usual
  const ro = { locked: !!props.readOnly, why: props.readOnlyReason ?? "", title: (own?: string) => (props.readOnly ? props.readOnlyReason : own) };
  /** Clicking an item closes the menu */
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
        aria-label={tr("More actions")}
        title={tr("More actions: one-click effects, diagnostic report, new chat")}
        onClick={pop.toggle}
      >
        <span aria-hidden="true">✦</span>
      </button>
      <div className="ai-pop ai-menu" role="menu" aria-label={tr("More actions")} data-pop style={{ display: pop.open ? undefined : "none" }}>
        <button
          type="button"
          role="menuitem"
          className="ai-menu-item"
          data-pc="ai-auto-workflow"
          title={ro.locked ? ro.why : cloudMode ? CLOUD_NO_WORKFLOW : tr("Runs in order: {0}", workflowRoles.map((r) => r.name).join(" → "))}
          disabled={streaming || cloudMode || ro.locked}
          onClick={pick(onRunWorkflow)}
        >
          <span className="ai-menu-icon" aria-hidden="true" />
          {tr("One-click effects")}
        </button>
        <button
          type="button"
          role="menuitem"
          className="ai-menu-item"
          data-pc="ai-diagnostics"
          title={cloudMode ? tr("Collect this cloud chat's progress, error causes and client info into JSON (no credentials included); copy / save to file / submit from a child window") : tr("Collect this chat and every execution event into JSON (no keys included); copy / save to file / submit from a child window")}
          disabled={!canDiagnose}
          onClick={pick(onOpenDiagnostics)}
        >
          <span className="ai-menu-icon" aria-hidden="true">⎘</span>
          {tr("Diagnostic report")}
        </button>
        <div className="ai-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="ai-menu-item" data-pc="ai-new-chat" disabled={ro.locked || !!newChatDisabledReason} title={ro.locked ? ro.title() : newChatDisabledReason ?? undefined} onClick={pick(onNewChat)}>
          <span className="ai-menu-icon" aria-hidden="true">{tr("+")}</span>
          {tr("New chat")}
        </button>
      </div>
    </div>
  );
}

/**
 * Drag handle at the top right of the input area (⌝): drag vertically to change the input area height, drag up to make it taller; double-click to return to the default one third.
 *
 * The height is kept in the module-level store of composerHeight, so all tabs change together. The upper limit is 70% of the panel height,
 * measured at the moment of pressing down: the panel itself does not get taller or shorter during the drag, so there is no need to measure every frame.
 * During the drag, `<body>` gets data-pc-resizing, like ResizeHandle: the preview iframe does not take mouse events for the time being.
 */
function ComposerGrip({ boxRef }: { boxRef: RefObject<HTMLDivElement | null> }) {
  const [dragging, setDragging] = useState(false);
  /** Cleanup when a drag is in progress. It must also run if the tab is closed mid-drag (component unmounted), otherwise the drag state stays on `<body>` forever */
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const panel = box.closest<HTMLElement>(".ai-panel");
    const panelH = panel?.clientHeight ?? window.innerHeight;
    // Other blocks in the same column (top bar, thinking bar, queue list) are subtracted as they really are, and the message area keeps at least MESSAGES_MIN_H; then clamp by the ratio
    let others = 0;
    for (const el of Array.from(box.parentElement?.children ?? [])) {
      if (el !== box && !el.classList.contains("ai-messages")) others += (el as HTMLElement).offsetHeight;
    }
    const maxH = Math.max(COMPOSER_MIN_H, Math.min(Math.floor(panelH * COMPOSER_MAX_RATIO), panelH - others - MESSAGES_MIN_H - 10));
    const startY = e.clientY;
    const startH = box.getBoundingClientRect().height;
    const pointerId = e.pointerId;
    /** Persist only after a real drag: a single click (including the first two clicks of a double-click reset) must not record the default one third as a fixed pixel value */
    let moved = false;

    try {
      grip.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone (synthetic events, etc.); dragging works even without capture
    }
    setDragging(true);
    document.body.dataset.pcResizing = "y";
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      // Dragging up (clientY gets smaller) makes it taller
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
        // Already released
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
      aria-label={tr("Resize input box")}
      title={tr("Drag to resize the input box, double-click to reset")}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetComposerHeight()}
    >
      {/* An L rotated by 90°: a horizontal stroke on the top edge and a vertical one on the right edge, sitting at the top right corner of the input box */}
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 3.5h7v7" />
      </svg>
    </div>
  );
}

/**
 * Input area, taking 1/3 of the panel height: attachment cards on top, the input box fills the middle (no auto-grow; overflow scrolls inside),
 * and a 36px toolbar at the bottom: on the left the attachment (paperclip), the "✦" menu, driver + model, and the "⋯" run options; on the right Send / Stop.
 *
 * It does not touch useAiChat directly: sending and stopping are both handed to onSubmit / onStop, and the draft is controlled too,
 * so what to send and when to clear it is decided by AiPanel.
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
    stopDisabledReason: stopReasonProp = tr("You can only stop tasks you started"),
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
  // This project only has read-only permission (guest): cannot send messages to the Agent (nor stop other people's tasks). Chat history can still be read, and the whole input area is grayed out, with viewOnlyText() as the explanation.
  // The existing "chat has no read permission" reason takes priority (that is a different matter)
  const disabled = disabledProp || readOnly;
  const disabledReason = disabledProp ? disabledReasonProp : readOnly ? readOnlyReason : disabledReasonProp;
  const guide = readOnly ? null : guideProp;
  const canStop = canStopProp && !readOnly;
  const stopDisabledReason = readOnly ? readOnlyReason : stopReasonProp;
  const cloudOn = !!cloud?.selected;
  /** The verb on the attachment bar: locally it is "Import", under Cloud it is "Upload" to the cloud node */
  const verb = cloudOn ? tr("Upload") : tr("Import");

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (hotkeysOff || !active) return;
    // An Enter pressed while the IME is still composing is "commit", not send
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (disabled) return;
      onSubmit(text);
    }
  };

  /** The height the user dragged to (shared by all tabs); null if never dragged, which follows chat.css and takes one third of the panel */
  const composerH = useComposerHeight();
  const boxRef = useRef<HTMLDivElement>(null);
  // Once dragged, use this height, but allow shrinking (down to the CSS min-height): when the panel later gets shorter and the thinking bar and queue list take up more space,
  // the input box yields first and the message area keeps its min-height. Then clamp by 70%
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
              title={a.status === "error" ? (a.error || tr("{0} failed", verb)) : a.name}
              onClick={() => {
                if (a.status !== "error") return;
                // Click a failed card to retry: first turn it back to importing, then run the import again
                if (a.id) onRetryAttachment(a.id, a.srcPath ?? null);
              }}
            >
              {a.status === "importing" ? <span className="ai-spinner" aria-hidden /> : <span aria-hidden="true">{attachIcon(a.kind)}</span>}
              <span className="ai-attachment-name">{a.name}</span>
              {a.status === "importing" ? tr(" · {0}ing…", verb) : a.status === "error" ? tr(" · {0} failed{1}, click to retry", verb, cloudOn && a.error ? `:${a.error}` : "") : ""}
              <button
                type="button"
                className="ai-attachment-remove"
                aria-label={tr("Remove {0}", a.name)}
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
        aria-label={tr("Message the AI")}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? (disabledReason ?? tr("This chat no longer has read access")) : uploading ? tr("Importing...") : streaming ? tr("Agent is running, Enter to queue, Shift+Enter for new line") : tr("Type a message, Enter to send, Shift+Enter for new line")}
        disabled={uploading || disabled}
      />

      <div className="ai-composer-bar">
        <div className="ai-composer-tools">
          <button
            type="button"
            className="pc-icon-btn ai-bar-btn"
            data-pc="ai-attach"
            title={disabled ? (disabledReason ?? tr("This chat no longer has read access")) : cloudOn ? (cloud!.attachTitle ?? tr("Add attachment")) : tr("Add attachment")}
            aria-label={tr("Add attachment")}
            onClick={onPickFiles}
            disabled={uploading || disabled}
          >
            <IconPaperclip size={16} />
          </button>
          <ComposerMenu {...menu} cloudMode={cloudOn} streaming={streaming} readOnly={readOnly} readOnlyReason={readOnlyReason} />
          {/* The driver currently in use is the identity of this tab, so it stays on the toolbar even when narrow */}
          <select
            className="ai-bar-select ai-provider-select"
            data-pc="ai-provider"
            aria-label={tr("AI driver")}
            title={tr("Driver")}
            value={cloudOn ? "cloud" : provider || ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "cloud") cloud?.onSelect();
              else if (cloudOn) cloud!.onLeave(v as AiProvider);
              else onSetProvider(v as AiProvider);
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available} title={p.available ? "" : tr("Not installed")}>
                {providerLabel(p)}
              </option>
            ))}
            {cloud?.show && (
              <option value="cloud" disabled={cloud.disabled} title={cloud.disabled ? cloud.disabledReason : tr("Messages are sent to the cloud and run on a cloud node; it keeps running even if you close the app")}>
                {tr("Cloud")}
              </option>
            )}
          </select>
          {cloudOn ? cloud!.toolbar : <ModelBar provider={provider} config={config} disabled={streaming} tabId={tabId} />}
        </div>
        {streaming ? (
          <>
            {/* You can keep typing while running: if there is content, offer "Add to queue" (Enter too), and it is sent automatically in order once this round settles */}
            {(text.trim().length > 0 || attachments.length > 0) && (
              <button type="button" className="pc-btn-primary ai-send-btn" data-pc="ai-enqueue" title={tr("Sent automatically after the Agent finishes this round (Enter)")} disabled={disabled} onClick={() => !disabled && onSubmit(text)}>
                {tr("Queue")}
              </button>
            )}
            <button type="button" className="pc-btn-primary ai-send-btn is-stop" data-pc="ai-stop"
              title={canStop ? tr("Stop this round; completed changes are kept; queued messages are paused") : stopDisabledReason}
              aria-label={canStop ? undefined : stopDisabledReason} disabled={!canStop} onClick={onStop}>
              {tr("■ Stop")}
            </button>
          </>
        ) : (
          <button type="button" className="pc-btn-primary ai-send-btn" data-pc="ai-send" title={disabled ? (disabledReason ?? tr("Cannot send")) : tr("Send (Enter)")} disabled={disabled} onClick={() => !disabled && onSubmit(text)}>
            {tr("Send")}
          </button>
        )}
      </div>
    </div>
  );
}
