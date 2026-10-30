/**
 * 聊天页的输入框。拆出来是因为它要在**两个地方**出现(用户 2026-10-26 定,issue #4):
 *
 *   - 平时在聊天列底部(`.ps-chat-foot`);
 *   - 「详细编辑」展开、右侧拓展栏也开着时，搬进拓展栏里那块聊天面板(`ExtChatPanel.tsx`)的底部 ——
 *     详细编辑要占满整个聊天区，输入框留在时间轴正下方不合适(issue #4 的原话)。
 *
 * 两处是**同一个** React 状态，所以搬家时打了一半的草稿自己跟着走，不用另写搬运逻辑；换地方之后
 * textarea 会重挂，焦点由调用方(`ChatView.tsx`)补回来。
 *
 * `narrow` 只管窄栏里那一套外框和自增高上限，发不发得出去、停止键什么时候出现，两处规则完全一样。
 */
import { useLayoutEffect } from "react";
import type { JSX, RefObject } from "react";

/** 自增高的上限，和 CSS 里 `.ps-chat-input` / 窄栏那一条的 max-height 对齐 */
const MAX_H = 200;
const MAX_H_NARROW = 110;

export function Composer(props: {
  text: string;
  onText: (t: string) => void;
  /** 发出输入框里这一句 */
  onSend: () => void;
  /** 停止这一轮(输入框空着、又正在跑的时候，发送键换成它) */
  onStop: () => void;
  area: RefObject<HTMLTextAreaElement | null>;
  canSend: boolean;
  canStop: boolean;
  stopMode: boolean;
  placeholder: string;
  /** 输入框底下那一行小字:为什么发不了、排了几条、引用放进去了 */
  note: string;
  /** 在右侧拓展栏那块面板里(窄) */
  narrow: boolean;
}): JSX.Element {
  const max = props.narrow ? MAX_H_NARROW : MAX_H;

  // 文字变了、或者整个框换了地方，都重算一次高度 —— 搬过去之后不能停在上一处算出来的高度上
  useLayoutEffect(() => {
    const el = props.area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [props.text, props.narrow, props.area, max]);

  return (
    <div className={props.narrow ? "ps-ext-chat-foot" : "ps-chat-foot"}>
      <div className="ps-chat-box">
        <textarea
          ref={props.area}
          className="ps-chat-input"
          data-pc="start-chat-input"
          value={props.text}
          disabled={!props.canSend}
          placeholder={props.placeholder}
          aria-label="写一条消息"
          onChange={(e) => props.onText(e.target.value)}
          onKeyDown={(e) => {
            // 回车发送、Shift+回车换行;输入法组合中的回车不算(中文输入按回车是在选字)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              props.onSend();
            }
          }}
        />
        {props.stopMode ? (
          <button
            type="button"
            className="ps-prompt-send"
            data-pc="start-chat-stop"
            disabled={!props.canStop}
            aria-label="停止这一轮"
            title={props.canStop ? "停止这一轮" : "只能停止自己发起的任务"}
            onClick={props.onStop}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        ) : (
          <button
            type="button"
            className="ps-prompt-send"
            data-pc="start-chat-send"
            disabled={!props.text.trim() || !props.canSend}
            aria-label="发送"
            onClick={props.onSend}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      <p className="ps-chat-note" role="status" data-pc="start-chat-note">{props.note}</p>
    </div>
  );
}
