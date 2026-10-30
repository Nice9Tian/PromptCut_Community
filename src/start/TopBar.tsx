/**
 * 横向贯穿整页的顶栏(用户 2026-10-23 定):压在侧栏和主区之上,所以**收起键和产品标识的位置是固定的** ——
 * 侧栏收起来、换页、进聊天都不会动。
 *
 * 左边恒定是「回首页」「收起侧栏」加 Logo,三样的位置不随页面变;中间 `center` 由页面给(聊天页放对话名);
 * 右边先是账号(用户要求摆在「共有」左边),再是 `right` 由页面给的那几颗。
 */
import type { JSX, ReactNode } from "react";
import { Logo } from "../ui/Logo";
import { hueOf } from "./hue";

export function TopBar(props: {
  /** 现在就在开始页(首页按钮标成当前项) */
  atHome: boolean;
  onHome: () => void;
  collapsed: boolean;
  onToggleSide: () => void;
  /** 账号那一块:在线浏览器才有。桌面版没有账号,两样都不给,这一块整个不出现 */
  accountName?: string | null;
  onSignOut?: () => void;
  center?: ReactNode;
  right?: ReactNode;
}): JSX.Element {
  const seed = props.accountName ?? "guest";
  const account = !!props.onSignOut;
  return (
    <header className="ps-top" data-pc="start-top">
      {/* 首页:原来聊天页那颗返回键,用户 2026-10-23 换成小房子并挪到收起键左边 */}
      <button
        type="button"
        className="ps-top-home"
        data-pc="start-home"
        aria-label="回到开始页"
        aria-current={props.atHome ? "page" : undefined}
        title="开始页"
        onClick={props.onHome}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 10.6 12 3.8l8.5 6.8" />
          <path d="M5.6 9.2v10h12.8v-10" />
          <path d="M9.9 19.2v-5.4h4.2v5.4" />
        </svg>
      </button>

      <button
        type="button"
        className="ps-top-collapse"
        data-pc="start-side-collapse"
        /* 点亮(强调色)=列表栏开着,灰=关着(2026-10-23 用户定:原先反了,收起来时才亮) */
        aria-pressed={!props.collapsed}
        aria-label={props.collapsed ? "展开侧栏" : "收起侧栏"}
        title={props.collapsed ? "展开侧栏" : "收起侧栏"}
        onClick={props.onToggleSide}
      >
        {/* 一个带左栏的面板:左栏实心表示侧栏在,空心表示收起来了 */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <rect x="3" y="4.5" width="18" height="15" rx="2" />
          <path d="M9 4.5v15" />
          {!props.collapsed && <path d="M3 4.5h6v15H3z" fill="currentColor" stroke="none" opacity="0.55" />}
        </svg>
      </button>

      <Logo size={20} />

      {props.center}

      <span className="ps-top-spacer" />

      {/* 账号:摆在右边那几颗的左侧(用户 2026-10-23 定,原来在侧栏底下)。桌面版没有账号,这一块不出现 */}
      {account && <div className="ps-top-account" data-pc="start-top-account">
        <span
          className="ps-avatar"
          style={{ background: `hsl(${hueOf(seed)} 45% 32%)`, color: `hsl(${hueOf(seed)} 60% 88%)` }}
          aria-hidden="true"
        >
          {(props.accountName ?? "?").slice(0, 1)}
        </span>
        <span className="ps-top-account-name" data-pc="start-account-name">{props.accountName ?? "未登录"}</span>
        <button type="button" className="ps-link" data-pc="start-sign-out" onClick={props.onSignOut}>
          退出
        </button>
      </div>}

      {props.right}
    </header>
  );
}
