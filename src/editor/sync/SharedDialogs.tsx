/**
 * 多用户协作共用的小部件(C6.5 的「新建共享项目」「打开共享项目」两个对话框已在 C10a 删掉,
 * `docs/plan/c10a-contract.md` 第 6 节「旧入口」;语义:项目只有一种新建入口)。留下还有用的:
 * - 托管地址:内置缺省值,界面上可改,记在本机(开始页「加入别人的项目」、项目设置「多用户协作」放云端共用);
 * - 名单编辑器(项目设置开启限定进入、成员浮层「改名单」);
 * - 局域网主机要重启编辑器的提示(项目设置放本机);
 * - 局域网查找:浏览器发不了 UDP,由本机编辑器替页面在本网段查找。
 */
import { pushToast } from "./syncManager";
import { hosted, type LanHost } from "./sharedApi";
import { ONLINE } from "../../online/mode";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/* ---------------- 托管地址(记在本机) ---------------- */

const HOSTED_KEY = "pc.shared.hostedUrl";

export function readHostedUrl(): string {
  try {
    return hosted.migrateHostedText(localStorage.getItem(HOSTED_KEY) || "") || hosted.DEFAULT_HOSTED_URL;
  } catch {
    return hosted.DEFAULT_HOSTED_URL;
  }
}

export function writeHostedUrl(url: string) {
  try {
    if (!url.trim() || url.trim() === hosted.DEFAULT_HOSTED_URL) localStorage.removeItem(HOSTED_KEY);
    else localStorage.setItem(HOSTED_KEY, url.trim());
  } catch {
    /* 存不了就只在这次生效 */
  }
}

/** 界面上改过的值才算「界面值」(覆盖顺序第 1 级);和缺省相同就当没改 */
export function uiHostedUrl(): string | null {
  const v = readHostedUrl();
  return v === hosted.DEFAULT_HOSTED_URL ? null : v;
}


/** 局域网模式要编辑器绑在局域网上;浏览器里重启不了编辑器,桌面壳眼下也没有重启接口(留给 C10 / 桌面壳) */
export function LanRestartHint() {
  const cmd = "PROMPTCUT_LAN_HOST=1 npm run dev";
  return (
    <div className="pc-sync-hint" data-pc="lan-restart-hint">
      {tr("The editor is currently listening on this machine only, so members on the LAN cannot connect. To be a LAN host, the editor must be restarted in LAN host mode (with PROMPTCUT_LAN_HOST=1). This window cannot restart it for you: close the editor, reopen it with the command below, then create the room.")}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <code style={{ fontFamily: "var(--ui-font-mono)", fontSize: 11.5, padding: "2px 6px", borderRadius: 4, background: "var(--ui-float)" }}>{cmd}</code>
        <button
          type="button"
          className="pc-dialog-opt"
          style={{ height: 24, padding: "0 10px", fontSize: 12 }}
          onClick={() => {
            void navigator.clipboard?.writeText(cmd).then(
              () => pushToast(tr("Startup command copied."), "info", 3000),
              () => pushToast(tr("Could not copy. Please select the command manually."), "warn", 4000),
            );
          }}
        >
          {tr("Copy command")}
        </button>
      </div>
    </div>
  );
}

/** 名单表:创建者固定第一行;下面每行可删;底部新增一行(新建对话框与「改名单」共用) */
export function ListEditor(props: {
  creatorName: string;
  list: { username: string; password?: string; kept?: boolean }[];
  onRemove: (username: string) => void;
  onChangePassword?: (username: string) => void;
  rowName: string;
  rowPw: string;
  setRowName: (v: string) => void;
  setRowPw: (v: string) => void;
  onAdd: () => void;
  rowErr: string;
  hint: string;
}) {
  return (
    <div className="pc-sync-field">
      <div className="pc-sync-list" data-pc="list-editor">
        <div className="pc-sync-list-row">
          <span>
            {props.creatorName} <span className="pc-sync-tag pc-sync-tag--creator">{tr("[creator]")}</span>
          </span>
          <span className="is-muted">{tr("Same as creator's password")}</span>
          <span />
        </div>
        {props.list.map((r) => (
          <div className="pc-sync-list-row" key={r.username}>
            <span>{r.username}</span>
            <span className="is-muted">
              {r.kept ? "••••" : "••••"}
              {props.onChangePassword ? (
                <button type="button" className="pc-sync-link-btn" style={{ marginLeft: 8 }} onClick={() => props.onChangePassword!(r.username)}>
                  {tr("Change password")}
                </button>
              ) : null}
            </span>
            <button type="button" className="pc-sync-icon-btn" title={tr("Delete")} aria-label={tr("Delete {0}", r.username)} onClick={() => props.onRemove(r.username)}>
              ✕
            </button>
          </div>
        ))}
        <div className="pc-sync-list-row">
          <input className="pc-dialog-input" placeholder={tr("Username")} value={props.rowName} onChange={(e) => props.setRowName(e.target.value)} />
          <input className="pc-dialog-input" type="password" placeholder={tr("password")} value={props.rowPw} onChange={(e) => props.setRowPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") props.onAdd(); }} />
          <button type="button" className="pc-dialog-opt" style={{ height: 26, padding: "0 8px", fontSize: 12 }} onClick={props.onAdd}>
            {tr("Add")}
          </button>
        </div>
      </div>
      {props.rowErr ? <div className="pc-sync-err">{props.rowErr}</div> : null}
      <div className="pc-sync-hint">{props.hint}</div>
    </div>
  );
}

/** 浏览器发不了 UDP:本机编辑器替页面在本网段查找(`/api/docservice/lan-discover`) */
export async function discoverViaEditor({ name }: { name: string; timeoutMs: number }): Promise<{ hosts: LanHost[]; errors?: { reason: string }[] }> {
  if (ONLINE) throw new Error(tr("The online page does not search the LAN"));
  const r = await fetch(`/api/docservice/lan-discover?name=${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`lan-discover ${r.status}`);
  const j = await r.json();
  return { hosts: Array.isArray(j.hosts) ? j.hosts : [], errors: Array.isArray(j.errors) ? j.errors : [] };
}

