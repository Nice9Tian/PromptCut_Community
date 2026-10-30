/**
 * 开始页顶上那个输入框:写一句话就建一个项目。
 *
 * 按回车或点箭头把文字和画幅交给上层(`OnlineStart.tsx`):上层新建一个云端项目(在线浏览器里项目一律放云端,
 * `product/platforms.md`「能新建放云端的项目」)、按画幅定好尺寸、进它的聊天页,再把这句话作为第一条消息发给云端 Agent
 * (`workflow/production.md`「用户发送指令」)。没登录、游客已经建过项目时上层给 `disabled`,这里置灰并说为什么。
 *
 * 「＋ 素材」:点了由上层开选文件框,挑好的素材先记在页面上(这颗上标出几个),发出这句话、项目建好之后
 * 经编辑界面同一套导入(`src/editor/left/importAssets.ts` 的 `importMediaFiles`)传进这个项目,再发消息。
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { Ratio } from "./types";

const RATIOS: Ratio[] = ["16:9", "9:16", "1:1"];
/** 和 CSS 里的 max-height 对齐:再长就自己滚,不把首屏顶走 */
const MAX_H = 180;

export function PromptBox(props: { onSubmit: (text: string, ratio: Ratio) => void; onUpload: () => void; fileCount?: number; disabled?: string | null; busy?: boolean }): JSX.Element {
  const [text, setText] = useState("");
  const [ratio, setRatio] = useState<Ratio>("16:9");
  const area = useRef<HTMLTextAreaElement>(null);

  // 输入框跟着内容长高。不用 rows:换行、粘贴一大段都要立刻对
  const fit = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
  };

  const send = () => {
    const t = text.trim();
    if (!t || props.disabled || props.busy) return;
    props.onSubmit(t, ratio);
    setText("");
    // 清空之后高度也要缩回去,否则留着一个空的大框
    requestAnimationFrame(fit);
  };

  return (
    <div className="ps-prompt" data-pc="start-prompt">
      <textarea
        ref={area}
        className="ps-prompt-input"
        data-pc="start-prompt-input"
        value={text}
        placeholder={props.disabled ?? "说一句你想要的片子：主题、镜头、或者直接把文案贴进来"}
        disabled={!!props.disabled}
        aria-label="描述你想要的片子"
        onChange={(e) => {
          setText(e.target.value);
          fit();
        }}
        onKeyDown={(e) => {
          // 回车发送、Shift+回车换行;输入法组合中的回车不算(中文输入按回车是在选字)
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="ps-prompt-foot">
        {/* 这一颗是行动点:用强调色把人往「传素材」上引,所以和右边那排画幅 chip 不是一个分量 */}
        <button
          type="button"
          className="ps-chip is-cta"
          data-pc="start-prompt-upload"
          aria-label="上传素材"
          onClick={props.onUpload}
        >
          <span className="ps-chip-plus" aria-hidden="true">＋</span>素材{props.fileCount ? ` · ${props.fileCount}` : ""}
        </button>
        {RATIOS.map((r) => (
          <button
            key={r}
            type="button"
            className="ps-chip"
            aria-pressed={r === ratio}
            onClick={() => setRatio(r)}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          className="ps-prompt-send"
          data-pc="start-prompt-send"
          disabled={!text.trim() || !!props.disabled || props.busy}
          aria-label="按这句话新建项目"
          title={props.busy ? "正在新建项目…" : undefined}
          onClick={send}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
