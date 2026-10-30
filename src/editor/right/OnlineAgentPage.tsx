import type { ReactNode } from "react";
import { useCloudAgent, useCloudNotices } from "../../ai/extensions";
import { CloudAiPanel } from "./CloudAiPanel";

/**
 * 在线浏览器模式的 Agent 页(契约 `docs/plan/cloud-agent-contract.md` 9.5):挂「云端」接入方式的 AI 栏,对话与工具由云节点上的
 * Agent 服务执行,页面只打同源的 `/agent/v1/*`。不分身份、不分档(`product/platforms.md`「AI 栏」;原来按档换成占位的做法 2026-10-07 撤销)。
 * `placeholder` 留着给旧调用方,不再用。
 */
export function OnlineAgentPage(props: { tabId: string; active: boolean; placeholder?: ReactNode }) {
  return <OnlineCloudPanel tabId={props.tabId} active={props.active} />;
}

/** 云端 Agent 的对话页本体。手机版界面(`src/mobile/`)直接挂它:AI 栏接入云端、不分身份(`product/platforms.md`「AI 栏」) */
export function OnlineCloudPanel(props: { tabId: string; active: boolean }) {
  const cloud = useCloudAgent();
  useCloudNotices(cloud, cloud.available);
  return <CloudAiPanel tabId={props.tabId} active={props.active} cloud={cloud} />;
}
