/**
 * Small widgets shared by multi-user collaboration (the two dialogs "New shared project" and "Open shared
 * project" from C6.5 were deleted in C10a, `docs/plan/c10a-contract.md` section 6, "Old entry points";
 * semantics: a project has only one way to be created). What is still useful stays:
 * - Hosted address: a built-in default, editable in the UI and remembered on this machine (start page
 *   "Join someone else's project", project settings "Multi-user collaboration" share it for the cloud);
 * - List editor (project settings turning on restricted entry, member popover "Edit list");
 * - Prompt that the LAN host must restart the editor (project settings, local);
 * - LAN discovery: the browser cannot send UDP, so the local editor searches this subnet for the page.
 */
import { pushToast } from "./syncManager";
import { hosted, type LanHost } from "./sharedApi";
import { ONLINE } from "../../online/mode";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/* ---------------- Hosted address (remembered on this machine) ---------------- */

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
    /* If it cannot be saved, it only takes effect this time */
  }
}

/** Only a value changed in the UI counts as a "UI value" (level 1 of the override order); if it equals the default, treat it as unchanged */
export function uiHostedUrl(): string | null {
  const v = readHostedUrl();
  return v === hosted.DEFAULT_HOSTED_URL ? null : v;
}


/** LAN mode needs the editor bound to the LAN; the browser cannot restart the editor, and the desktop shell has no restart interface for now (left to C10 / the desktop shell) */
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

/** List table: the creator is fixed in the first row; every row below can be deleted; one row is added at the bottom (shared by the new dialog and "Edit list") */
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
          <input className="pc-dialog-input" type="password" placeholder={tr("Password")} value={props.rowPw} onChange={(e) => props.setRowPw(e.target.value)}
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

/** The browser cannot send UDP: the local editor searches this subnet for the page (`/api/docservice/lan-discover`) */
export async function discoverViaEditor({ name }: { name: string; timeoutMs: number }): Promise<{ hosts: LanHost[]; errors?: { reason: string }[] }> {
  if (ONLINE) throw new Error(tr("The online page does not search the LAN"));
  const r = await fetch(`/api/docservice/lan-discover?name=${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`lan-discover ${r.status}`);
  const j = await r.json();
  return { hosts: Array.isArray(j.hosts) ? j.hosts : [], errors: Array.isArray(j.errors) ? j.errors : [] };
}

