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

/**
 * 开始页和编辑器之间的门。
 *
 * 编辑器本身不知道有开始页这回事 —— 它照旧渲染 store 里的当前项目。开始页在
 * 切过来之前就已经把项目 load 进 store 了,所以这里只管换视图。
 *
 * 几个启动参数:
 *   `?editor`          直接进编辑器:导出、自动化脚本和老书签都还指着这条路;
 *   `?draft=<id>`      打开某份草稿再进编辑器;
 *   `?open=<路径>`     按磁盘路径打开一份 .proc(桌面壳双击文件时带过来),会先复制一份再读;
 *   `?join=<项目号>`   局域网里的第二块屏:同一个本机项目的第二个页面,直接进编辑器,内容以本机文档服务为准
 *                      (`product/platforms.md`「桌面应用」的「局域网里的第二块屏」;接上文档服务那一步在
 *                      `editor/sync/syncManager.ts` 的 `startSync`)。
 *   `?headless=1`      自动化页面(探针、测试):不塞演示卡、不接文档服务、不弹素材迁移框(各处自己认这个参数)。
 *
 * 在线浏览器模式(C10a 契约第 2 节)不认这几个参数:它们都要编辑器进程(草稿、磁盘路径);
 * 打开就是开始页,从「加入别人的项目」进编辑器。在线构建里这几条连同草稿、按路径打开一起剪掉
 * (`ONLINE_BUILD`,写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」;M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * 界面跟身份走(`product/platforms.md`「身份」):身份为手机的用手机版界面(`src/mobile/`),其余用桌面界面。
 * **不看文档服务在哪**:局域网里的手机打开本机项目(`?join=`,见下)时同样是手机版界面
 * (`product/platforms.md`「桌面应用」的「局域网里的第二块屏」)。桌面应用自己的窗口报桌面声明,照旧是桌面界面。
 * 页面载入时判一次,同一个地址;`?layout=mobile|desktop` 只给开发和验收用(`src/online/deviceKind.ts` 的 `pickLayout`)。
 * 在线页面的 iPad 身份看舞台闸门(`src/online/stageGate.ts` 的 `predictIdentity`:停在第一级的算手机);
 * 本机页面没有闸门记录,按浏览器声明判(`currentDeviceKind`)。
 * 手机版按需载入,桌面界面不下载它。
 */
const LAYOUT = pickLayout({ kind: ONLINE_BUILD ? predictIdentity(CODE_VERSION ?? "dev") : currentDeviceKind().kind, search: typeof location !== "undefined" ? location.search : "" });
const MobileApp = lazy(() => import("./mobile/MobileApp"));

export function Shell(): JSX.Element {
  // Keep the shared --ui-* palette mounted on the start page as well as the editor.
  // The title bar is outside both routes, so its colors stay synchronized.
  useSkin();
  const [inEditor, setInEditor] = useState(() => {
    // 在线页面打开就是开始页;只有在线模式的**开发服务**(探针用)认 `?editor`,
    // 在线构建(vite build --mode online)里 DEV 为假,这一支被剪掉
    if (ONLINE_BUILD) return !!import.meta.env.DEV && new URLSearchParams(location.search).has("editor");
    try {
      const q = new URLSearchParams(location.search);
      // `?join=` 是局域网里的第二块屏:那张页面只为进这个项目,不经开始页
      return q.has("editor") || q.has("join");
    } catch {
      return false;
    }
  });
  const [bootError, setBootError] = useState("");

  // 顶栏的「回到首页」在 window 上派发这个事件,免得给 Editor 加一层 props
  useEffect(() => {
    const back = () => {
      // 回开始页之后再刷新就留在开始页;在线页面的地址从项目直达地址换回 `/editor/`(`product/platforms.md`「项目直达地址」)
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
   * 刷新之后回到刷新前打开的共享项目(C10a r2):这个标签页记着(syncManager 的 resumeShared)就照「加入别人的项目」
   * 那样先换一份空项目、再进去,进去了直接进编辑器;没进去(离线、凭证失效)留在开始页。
   * 打开的是邀请链接(`#invite=`)时以链接为准,不回旧项目。`?editor` 的页面由编辑器自己接(Editor.tsx)。
   */
  useEffect(() => {
    if (inEditor || !hasSharedResume() || peekCapturedInvite()) return;
    let live = true;
    newProject("未命名");
    void resumeShared().then((ok) => {
      if (ok && live) {
        setActiveDraftId(null);
        setInEditor(true);
      }
    });
    return () => { live = false; };
    // 启动时只看一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 启动参数只看一次
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

  // 桌面壳在已经开着的窗口上又收到一个 .proc(双击了文件):走同一条「复制再打开」的路
  useEffect(() => {
    if (ONLINE_BUILD) return; // 在线页面不在桌面壳里
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
        打不开:{bootError}
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
