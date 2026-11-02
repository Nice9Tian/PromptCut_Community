import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { qrSvg } from "../../server/qr.mjs";
import { linkOnLan } from "../../server/lan-open.mjs";
import { useSync } from "./sync/syncManager";
import { localCollab } from "./sync/collab";
import { tr } from "../i18n/index.ts";

/**
 * 「在手机上打开」(语义 `workflow/editing.md`「局域网里的第二块屏」)。
 *
 * 跨设备进同一个项目走的是**共享项目**那条路:项目设成「多用户协作 + 放本机」之后,主机在本网段广播,
 * 局域网里的设备凭**邀请链接**加入(`<主机局域网源>/editor#invite=<码>`,规则见 `server/auth/invite.mjs`)。
 * 这个窗口做的就是把那条链接连同二维码摆出来,手机扫一下就进 —— 界面跟身份走,手机拿到的是手机版界面。
 *
 * 三种情况三种说法:
 *   1. 项目还不是「多用户协作 + 放本机」:说清去哪儿开(项目设置里的「多用户协作」),这里不替用户改项目;
 *   2. 是,但编辑器只绑在回环上:链接给了手机也连不上,先说怎么起(`npm run dev:lan`);
 *   3. 都齐了:给链接 + 二维码。链接的源是文档服务的 base(`collab.ts` 的 `linkOriginOf`),正常就是主机的
 *      局域网地址;主机有几块网卡时未必是用户要的那一块,所以拿 `/api/lan-open` 的地址表核对一下,不对就说明。
 *
 * 邀请码本身不在这里签:签发要当场的创建者密码,入口在项目设置的「多用户协作」里(`sync/CollabSection.tsx`
 * 的「作废并重新生成邀请码」)。这里只显示已经签好的那一张。
 */

interface LanOpenInfo {
  lanHost: boolean;
  port: number | null;
  command: string;
  addresses: { name: string; address: string }[];
}

export function LanOpenDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const shared = useSync((v) => v.shared);
  const [info, setInfo] = useState<LanOpenInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/lan-open")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((v: LanOpenInfo) => { if (alive) setInfo(v); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(key), () => setCopied(""));
  };

  const onLan = shared?.where === "lan";
  const invite = onLan && shared?.projectId ? localCollab(shared.projectId)?.invite ?? null : null;
  const linkReachable = invite ? linkOnLan(invite.link, info?.addresses ?? []) : false;

  return createPortal(
    <div className="pc-dialog-mask" role="presentation">
      <div className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-lan-open-title" data-pc="lan-open-dialog">
        <div id="pc-lan-open-title" className="pc-dialog-title">{tr("Open on your phone")}</div>
        <div className="pc-dialog-body">
          {error && <p className="text-sm mb-3" style={{ color: "var(--ui-danger)" }} data-pc="lan-open-error">{tr("Could not get this machine's network info: {0}", error)}</p>}

          {/* 1. 还不是「多用户协作 + 放本机」 */}
          {!onLan && (
            <div data-pc="lan-open-not-shared">
              <p className="text-neutral-300 text-sm mb-2">
                {tr("For a phone to join the same project as the computer, the project must first be set to \"multi-user collaboration\" with the location set to \"this machine\".")}
              </p>
              <p className="text-neutral-400 text-xs">
                {tr("Turn it on under \"Multi-user collaboration\" in project settings. When on, it gives an invite link and QR code, which you can also see again here. {0}", shared?.where === "hosted" ? tr("This project is currently in the cloud, the invite link is in its settings there.") : "")}
              </p>
            </div>
          )}

          {/* 2. 是放本机，但编辑器只绑回环 */}
          {onLan && info && !info.lanHost && (
            <div data-pc="lan-open-off">
              <p className="text-neutral-300 text-sm mb-2">{tr("The editor is currently bound only to the local loopback address, so the phone cannot connect.")}</p>
              <p className="text-neutral-400 text-xs mb-2">{tr("Restart the editor with the command below so it binds to the LAN; switching the binding requires a restart, so save your current changes first.")}</p>
              <div className="flex items-center gap-2">
                <code className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-200" data-pc="lan-open-command">{info.command}</code>
                <button type="button" className="pc-dialog-opt" data-pc="lan-open-copy-command" onClick={() => copy(info.command, "cmd")}>
                  {copied === "cmd" ? tr("Copied") : tr("Copy command")}
                </button>
              </div>
            </div>
          )}

          {/* 3. 都齐了：给链接和二维码 */}
          {onLan && info?.lanHost && (
            invite ? (
              <div data-pc="lan-open-invite">
                <p className="text-neutral-300 text-sm mb-3">{tr("Connect your phone to the same LAN, then scan the code or open this link to join this project:")}</p>
                <div className="flex items-center gap-3">
                  <div data-pc="lan-open-qr" aria-label={tr("Invite QR code")} style={{ background: "#fff", borderRadius: 4, padding: 4, lineHeight: 0, flexShrink: 0 }}
                    dangerouslySetInnerHTML={{ __html: qrSvg(invite.link, { ec: "M", quiet: 4, scale: 6 }) }} />
                  <div className="min-w-0">
                    <code className="text-xs text-neutral-200 break-all" data-pc="lan-open-link">{invite.link}</code>
                    <div className="mt-2">
                      <button type="button" className="pc-dialog-opt" data-pc="lan-open-copy-link" onClick={() => copy(invite.link, "link")}>
                        {copied === "link" ? tr("Copied") : tr("Copy invite link")}
                      </button>
                    </div>
                  </div>
                </div>
                {!linkReachable && (
                  <p className="text-xs mt-3" style={{ color: "var(--ui-warn, #e0a030)" }} data-pc="lan-open-link-warn">
                    {tr("The address in this link is not on this machine's LAN adapter (this machine's: {0}). It probably won't open on a phone; switch the address to the one above and try again.", info.addresses.map((a) => a.address).join(tr(", ")) || tr("(none)"))}
                  </p>
                )}
                <p className="text-neutral-400 text-xs mt-3" data-pc="lan-open-note">
                  {tr("Anyone with the link can enter this project. To revoke it and send a new one, go to \"Multi-user collaboration\" in project settings and click \"Revoke and regenerate invite code\".")}
                </p>
              </div>
            ) : (
              <p className="text-neutral-300 text-sm" data-pc="lan-open-no-invite">
                {tr("This project has no invite link yet. Go to \"Multi-user collaboration\" in project settings and click \"Revoke and regenerate invite code\" to issue one, then come back here to see it.")}
              </p>
            )
          )}
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-dialog-opt is-on" data-pc="lan-open-ok" onClick={onClose}>{tr("Got it")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
