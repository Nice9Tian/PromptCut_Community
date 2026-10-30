// 随机数 / 墙上时钟必须比任何第三方库先钉住,所以这一行排在最前面(见 render/stageClockEntry.ts)
import "./render/stageClockEntry";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import ExportView from "./ExportView";

/** 原型入口(proto.html):?export=1 走导出视图,否则走卡片预览 App。
 *  不包 StrictMode:它的假卸载会打断 Motion 带 delay 的进场动画(要点停在 initial),导出视图本来就不包。 */
const isExport = new URLSearchParams(location.search).has("export");
createRoot(document.getElementById("root")!).render(
  isExport ? <ExportView /> : <App />,
);
