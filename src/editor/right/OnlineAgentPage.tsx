import type { ReactNode } from "react";
import { useCloudAgent, useCloudNotices } from "../../ai/extensions";
import { CloudAiPanel } from "./CloudAiPanel";

/**
 * Agent page for online browser mode (contract `docs/plan/cloud-agent-contract.md` 9.5): an AI panel
 * with the "Cloud" connection type, where chat and tools are run by the Agent service on a cloud
 * node, and the page only calls the same-origin `/agent/v1/*`. No distinction by identity or tier
 * (`product/platforms.md` "AI panel"; the old approach of swapping in a placeholder per tier was
 * withdrawn 2026-10-07).
 * `placeholder` is kept for old callers and is no longer used.
 */
export function OnlineAgentPage(props: { tabId: string; active: boolean; placeholder?: ReactNode }) {
  return <OnlineCloudPanel tabId={props.tabId} active={props.active} />;
}

/** The chat page of the Cloud Agent itself. The mobile app UI (`src/mobile/`) mounts it directly: the AI panel connects to the cloud, with no distinction by identity (`product/platforms.md` "AI panel") */
export function OnlineCloudPanel(props: { tabId: string; active: boolean }) {
  const cloud = useCloudAgent();
  useCloudNotices(cloud, cloud.available);
  return <CloudAiPanel tabId={props.tabId} active={props.active} cloud={cloud} />;
}
