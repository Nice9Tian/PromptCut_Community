/**
 * The top bar that runs across the whole page horizontally (user decision, 2026-10-23): it sits above
 * the sidebar and the main area, so **the positions of the collapse button and the product logo are
 * fixed**: they do not move when the sidebar collapses, when the page changes, or when entering a chat.
 *
 * The left side is always "Home", "Collapse sidebar" and the Logo, and the positions of these three do
 * not change with the page; the middle `center` is supplied by the page (the chat page puts the chat
 * name there); the right side is first the account (the user asked for it to be placed to the left of
 * "Shared"), then the buttons supplied by the page through `right`.
 */
import type { JSX, ReactNode } from "react";
import { Logo } from "../ui/Logo";
import { LanguageMenu } from "../ui/LanguageMenu";
import { hueOf } from "./hue";
import { tr } from "../i18n/index.ts";

export function TopBar(props: {
  /** It is currently on the start page (the Home button is marked as the current item) */
  atHome: boolean;
  onHome: () => void;
  collapsed: boolean;
  onToggleSide: () => void;
  /** The account section: only in the online browser. The desktop app has no account, so neither is passed and this section does not appear at all */
  accountName?: string | null;
  onSignOut?: () => void;
  /**
   * Logged out (online browser only): the account slot shows "Sign in", which opens the login dialog
   * (issue #2, 2026-11-03). Passed instead of `onSignOut`.
   */
  onSignIn?: () => void;
  center?: ReactNode;
  right?: ReactNode;
  /** Saves the open project before a language switch reloads the page */
  prepareLanguageSwitch?: (url: URL) => Promise<boolean>;
}): JSX.Element {
  const seed = props.accountName ?? "guest";
  const account = !!props.onSignOut;
  return (
    <header className="ps-top" data-pc="start-top">
      {/* Home: the back button that used to be on the chat page; the user replaced it with a little house on
   2026-10-23 and moved it to the left of the collapse button */}
      <button
        type="button"
        className="ps-top-home"
        data-pc="start-home"
        aria-label={tr("back to the start page")}
        aria-current={props.atHome ? "page" : undefined}
        title={tr("start page")}
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
        /* Lit (emphasis color) = the list bar is open, gray = closed (user decision, 2026-10-23: it used to be
           the other way round, lit only when collapsed) */
        aria-pressed={!props.collapsed}
        aria-label={props.collapsed ? tr("Expand sidebar") : tr("Collapse sidebar")}
        title={props.collapsed ? tr("Expand sidebar") : tr("Collapse sidebar")}
        onClick={props.onToggleSide}
      >
        {/* A panel with a left rail: a solid left rail means the sidebar is present, a hollow one means it is collapsed */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <rect x="3" y="4.5" width="18" height="15" rx="2" />
          <path d="M9 4.5v15" />
          {!props.collapsed && <path d="M3 4.5h6v15H3z" fill="currentColor" stroke="none" opacity="0.55" />}
        </svg>
      </button>

      <Logo size={20} />

      {props.center}

      <span className="ps-top-spacer" />

      <LanguageMenu className="ps-ghost-btn" prepare={props.prepareLanguageSwitch} />

      {/* Account: placed to the left of the buttons on the right (user decision, 2026-10-23; it used to be at
   the bottom of the sidebar). The desktop app has no account, and this section does not appear */}
      {account && <div className="ps-top-account" data-pc="start-top-account">
        <span
          className="ps-avatar"
          style={{ background: `hsl(${hueOf(seed)} 45% 32%)`, color: `hsl(${hueOf(seed)} 60% 88%)` }}
          aria-hidden="true"
        >
          {(props.accountName ?? "?").slice(0, 1)}
        </span>
        <span className="ps-top-account-name" data-pc="start-account-name">{props.accountName ?? tr("Not logged in")}</span>
        <button type="button" className="ps-link" data-pc="start-sign-out" onClick={props.onSignOut}>
          {tr("Exit")}
        </button>
      </div>}

      {!account && props.onSignIn && (
        <div className="ps-top-account" data-pc="start-top-signed-out">
          <button type="button" className="ps-top-sign-in" data-pc="start-sign-in" aria-haspopup="dialog" onClick={props.onSignIn}>
            {tr("Sign in")}
          </button>
        </div>
      )}

      {props.right}
    </header>
  );
}
