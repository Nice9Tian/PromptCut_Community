import { useEffect, useState } from "react";
import { DockHost } from "../dock/DockHost";
import { DockPages } from "../dock/DockPages";
import { RailBar } from "../dock/RailBar";
import { connectMcpExecutor } from "../../ai/mcpExecutor";
import { startUserEditing } from "../userEditing";
import { VoiceSettingsDialog } from "../../voice/VoiceSettingsDialog";

import { CollectLoginDialog } from "./CollectLoginDialog";
import { AgentBrowserFrame } from "./AgentBrowserFrame";

import { editorApi } from "../../mcp/api";

/** 在线构建的编译期常量,写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export function RightPanel() {
  const [mcpConnected, setMcpConnected] = useState(false);

  useEffect(() => {
    // 在线浏览器模式没有编辑器进程:不连 Agent 的工具通道(C10a 契约第 2 节);在线构建里连同工具执行器一起剪掉
    if (ONLINE_BUILD) return;
    const cleanup = connectMcpExecutor(() => editorApi, (s) => setMcpConnected(s.connected));
    // 「用户正在编辑」推给同一个编辑器进程(A2),Agent 读写到这些片段时工具结果带提示
    const stopEditing = startUserEditing();
    return () => { stopEditing(); cleanup(); };
  }, []);

  // 右栏整列:左边一张宿主卡片(显示右侧 rail 选中项的页面),右边贴窗口边缘的竖向 rail(侧边自由布局,editor/dock/)。

  return (
    <>
      <div className="pc-right" data-pc="right">
        <DockHost side="right" />
        <RailBar side="right" />
      </div>
      {/*
        所有页面(五个分区、剧本页、各 AiPanel)在这里各渲染一次,portal 进各自的固定节点,两侧宿主只挪 DOM 节点。
        RightPanel 在 Editor 网格里永远占同一个兄弟槽位、从不卸载,所以拖动 / 切换 / 收起都不会让 AiPanel 卸载重建。
        排在宿主后面:宿主的布局效应先跑、先登记,页面内容的布局效应跑的时候节点已经挂进文档
      */}
      <DockPages mcpConnected={mcpConnected} />
      {/*
        下面三个浮层在线页面打不开(打开它们的入口在线都置灰或不存在:网页采集、配音设置、Agent 交出浏览器),
        在线构建里不挂,连同背后的 /api 调用一起剪掉(C10 契约第 10 节;M8 遗留 L24)
      */}
      {/* 站点登录框:开始页的卡和 collect_login 工具都会打开它,挂在这里才能在编辑台里出现 */}
      {ONLINE_BUILD ? null : <CollectLoginDialog />}
      {/* 配音设置子窗口:顶栏的「配音设置」按钮开它 */}
      {ONLINE_BUILD ? null : <VoiceSettingsDialog />}
      {/* 桌面壳模式下 agent 交出浏览器时的浮层(Chrome 方案下永远不会打开) */}
      {ONLINE_BUILD ? null : <AgentBrowserFrame />}
    </>
  );
}
