// 渲染面的时钟必须比 motion 先装好,所以这一行必须排在最前面(见 render/stageClockEntry.ts)
import "./render/stageClockEntry";
// 在线浏览器模式的 /api 守卫与读邀请码:必须在别的模块求值之前(C10a,见 online/pageBoot.ts)
import "./online/pageBoot";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./skins/skins.css";
import App from "./App";
import Shell from "./Shell";
import ExportView from "./ExportView";
import AudioMixView from "./AudioMixView";
import StageView from "./StageView";
import { installFocusZoomReset } from "./ui/focusZoomReset";
import { mountUpdateNotice } from "./editor/sync/UpdateNotice";
// 局域网的缺省成员源与加入源在**入口**注册（见 editor/sync/lanBoot.ts 的文件头）：
// 原来写在 MembersPanel / JoinPanel 的模块顶层，等于「谁 import 到就有局域网」——
// 手机端那条路上两个面板都不在闭包里，今天不坏只是因为 Shell 静态引了 Editor。
// 这是 core → lan 唯一的一条边，也是 Lite 版（只有本地、没有局域网）要剪的那一刀。
import { ONLINE } from "./online/mode";
import { registerLanDefaults } from "./editor/sync/lanBoot";

// 不包 StrictMode:它的双重挂载会打断 Motion 带 delay 的进场动画(卡片停在 initial 不动)。
// 在线构建里 `?stage` 照样要:同源单舞台是本页 `?stage=1` 的 iframe(src/editor/previewMode.ts)
const q = new URLSearchParams(location.search);
const view = q.has("audioMix") ? <AudioMixView /> : q.has("export") ? <ExportView /> : q.has("stage") ? <StageView /> : q.has("proto") ? <App /> : <Shell />;
// 手机浏览器点输入框自动放大后,失焦时拉回 100%(见 ui/focusZoomReset.ts)
// 在线浏览器模式里没有局域网：成员与加入由云端那张表注册的真实现负责
if (!ONLINE) registerLanDefaults();
installFocusZoomReset();
createRoot(document.getElementById("root")!).render(view);
// 在线浏览器的新版本提示条:只在在线构建的编辑器页挂载(见 editor/sync/UpdateNotice.tsx);
// 本文件是入口,它的 import.meta.url 就是入口脚本,拿去和服务端 version.json 的 entry 比
mountUpdateNotice(import.meta.url);
