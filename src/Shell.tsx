import { lazy, Suspense, useEffect, useState } from "react";
import type { JSX } from "react";
import Editor from "./Editor";
import { StartPage } from "./StartPage";
import { openDraft, setActiveDraftId } from "./editor/io/drafts";
import { openProcPath } from "./editor/io/openPath";
import { WindowTitleBar } from "./ui/WindowTitleBar";
import { useSkin } from "./skins/useSkin";
import { peekCapturedInvite } from "./online/invite";
import { forgetSharedResume, hasSharedResume, resumeShared } from "./editor/sync/syncManager";
import { newProject } from "./editor/io/proc";
import { currentDeviceKind, pickLayout } from "./online/deviceKind";
import { predictIdentity } from "./online/stageGate";
import { CODE_VERSION } from "./online/boot";
import { tr } from "./i18n/index.ts";

/**
 * The gate between the start page and the editor.
 *
 * The editor itself knows nothing about the start page: it just renders the current project in the
 * store. The start page has already loaded the project into the store before switching over, so
 * all that is left to do here is swap the view.
 *
 * Launch parameters:
 *   `?editor`          go straight to the editor: export, automation scripts and old bookmarks
 *                      all still point at this path;
 *   `?draft=<id>`      open a draft, then enter the editor;
 *   `?open=<path>`     open a .proc by disk path (passed in when the desktop shell opens a file by
 *                      double-click); it copies the file first, then reads the copy;
 *   `?join=<project id>`   second screen on the LAN: a second page for the same local project, goes
 *                      straight to the editor, and the content follows the local document service
 *                      (`product/platforms.md`, "Desktop app", "Second screen on the LAN"; the step
 *                      that connects to the document service is `startSync` in
 *                      `editor/sync/syncManager.ts`).
 *   `?headless=1`      automation pages (probes, tests): no demo cards, no document service, no
 *                      media migration dialog (each place recognizes this parameter on its own).
 *
 * Online browser mode (C10a contract, section 2) does not recognize these parameters: they all need
 * an editor process (drafts, disk paths). Opening it lands on the start page, and you enter the
 * editor from "Join someone else's project". In the online build these parameters, along with
 * drafts and open-by-path, are pruned (`ONLINE_BUILD`; for how it is written and why, see
 * "Online build pruning" in `src/online/pageFlag.ts`; M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * The UI follows the identity (`product/platforms.md`, "Identity"): an identity of phone gets the
 * mobile app UI (`src/mobile/`), everything else gets the desktop UI.
 * **It does not look at where the document service is**: a phone on the LAN opening a local project
 * (`?join=`, see below) also gets the mobile app UI
 * (`product/platforms.md`, "Desktop app", "Second screen on the LAN"). The desktop app's own window
 * declares itself as desktop, so it is still the desktop UI.
 * It is decided once when the page loads, for the same address; `?layout=mobile|desktop` is only for
 * development and acceptance checks (`pickLayout` in `src/online/deviceKind.ts`).
 * The iPad identity of an online page is decided by the stage gate (`predictIdentity` in
 * `src/online/stageGate.ts`: a device that stays at the first tier counts as a phone);
 * a local page has no gate record, so it goes by what the browser declares (`currentDeviceKind`).
 * The mobile app is loaded on demand; the desktop UI does not download it.
 */
const LAYOUT = pickLayout({ kind: ONLINE_BUILD ? predictIdentity(CODE_VERSION ?? "dev") : currentDeviceKind().kind, search: typeof location !== "undefined" ? location.search : "" });
const MobileApp = lazy(() => import("./mobile/MobileApp"));

export function Shell(): JSX.Element {
  // Keep the shared --ui-* palette mounted on the start page as well as the editor.
  // The title bar is outside both routes, so its colors stay synchronized.
  useSkin();
  const [inEditor, setInEditor] = useState(() => {
    // An online page opens on the start page; only the **dev server** in online mode (for probes)
    // recognizes `?editor`. In the online build (vite build --mode online) DEV is false, and this
    // branch is pruned
    if (ONLINE_BUILD) return !!import.meta.env.DEV && new URLSearchParams(location.search).has("editor");
    try {
      const q = new URLSearchParams(location.search);
      // `?join=` is a second screen on the LAN: that page exists only to enter this project, skipping the start page
      return q.has("editor") || q.has("join");
    } catch {
      return false;
    }
  });
  const [bootError, setBootError] = useState("");

  // The "Back to home" button in the top bar dispatches this event on window, to avoid adding another layer of props to Editor
  useEffect(() => {
    const back = () => {
      // After going back to the start page, a refresh stays on the start page; for an online page, the address changes from the project's direct address back to `/editor/` (`product/platforms.md`, "Project direct address")
      forgetSharedResume();
      const url = new URL(location.href);
      if (ONLINE_BUILD) url.pathname = import.meta.env.BASE_URL;
      for (const key of ["editor", "open", "draft", "join", "project", "token", "linkToken"]) url.searchParams.delete(key);
      history.replaceState(null, "", url);
      setInEditor(false);
    };
    window.addEventListener("pc-go-home", back);
    return () => window.removeEventListener("pc-go-home", back);
  }, []);

  /*
   * After a refresh, return to the shared project that was open before the refresh (C10a r2): if this
   * tab remembers it (`resumeShared` in syncManager), it first swaps in an empty project and then
   * enters, just like "Join someone else's project", and once in it goes straight to the editor; if
   * it cannot get in (offline, credentials expired) it stays on the start page.
   * When the page was opened from an invite link (`#invite=`), the link wins and the old project is
   * not restored. A page with `?editor` is handled by the editor itself (Editor.tsx).
   */
  useEffect(() => {
    if (inEditor || !hasSharedResume() || peekCapturedInvite()) return;
    let live = true;
    newProject(tr("Untitled"));
    void resumeShared().then((ok) => {
      if (ok && live) {
        setActiveDraftId(null);
        setInEditor(true);
      }
    });
    return () => { live = false; };
    // Only checked once at startup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Launch parameters are only checked once
  useEffect(() => {
    if (ONLINE_BUILD) return;
    let q: URLSearchParams;
    try {
      q = new URLSearchParams(location.search);
    } catch {
      return;
    }
    const draft = q.get("draft");
    const open = q.get("open");
    if (draft) {
      openDraft(draft)
        .then(() => {
          setActiveDraftId(draft);
          setInEditor(true);
        })
        .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
    } else if (open) {
      openProcPath(open)
        .then(() => setInEditor(true))
        .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
    }
  }, []);

  // The desktop shell received another .proc on an already open window (a file was double-clicked): take the same "copy, then open" path
  useEffect(() => {
    if (ONLINE_BUILD) return; // An online page is not inside the desktop shell
    const tauri = (window as unknown as {
      __TAURI__?: { event?: { listen?: (e: string, cb: (ev: { payload: unknown }) => void) => Promise<() => void> } };
    }).__TAURI__;
    const listen = tauri?.event?.listen;
    if (!listen) return;
    let un: (() => void) | undefined;
    listen("pc-open-file", (ev) => {
      const p = typeof ev?.payload === "string" ? ev.payload : "";
      if (!p) return;
      openProcPath(p)
        .then(() => setInEditor(true))
        .catch((e) => alert(e instanceof Error ? e.message : String(e)));
    })
      .then((fn) => { un = fn; })
      .catch(() => {});
    return () => un?.();
  }, []);

  if (bootError) {
    return (
      <div style={{ padding: 24, color: "var(--ui-danger)", fontFamily: "var(--ui-font)" }}>
        {tr("Cannot open: {0}", bootError)}
      </div>
    );
  }
  if (LAYOUT === "mobile") {
    return (
      <Suspense fallback={null}>
        <MobileApp inEditor={inEditor} onEnterEditor={() => setInEditor(true)} />
      </Suspense>
    );
  }
  return (
    <div className="pc-app-shell">
      <WindowTitleBar />
      <div className="pc-app-content">
        {inEditor ? <Editor /> : <StartPage onEnterEditor={() => setInEditor(true)} />}
      </div>
    </div>
  );
}

export default Shell;
