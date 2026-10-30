import { CLOUD_CHAT_TEXT } from "../../ai/chatTexts";
import type { CloudChatItem } from "../../ai/chatTypes";
import "./CloudAgentConsentDialog.css";

/** 删除一段云端对话前的确认。文字都在 `src/ai/cloud/chatTexts.ts`（用户 2026-10-13 确认）。 */
export interface CloudDeleteAsk {
  item: CloudChatItem;
  /** 一次删除用同一个请求号：没办完（任务还没停稳）时重试沿用它 */
  requestId: string;
  /** confirm = 等用户点；working = 已提交、等云端；pending = 任务还没停稳、可重试；error = 被拒或失败 */
  stage: "confirm" | "working" | "pending" | "error";
  text: string | null;
  /** 删的是别人开的对话（只有项目创建者会走到这里） */
  others: boolean;
}

export function CloudDeleteChatDialog(props: { ask: CloudDeleteAsk | null; onConfirm: () => void; onCancel: () => void }) {
  const { ask } = props;
  if (!ask) return null;
  const working = ask.stage === "working";
  const retry = ask.stage === "pending";
  const lines: string[] = [CLOUD_CHAT_TEXT.deleteBody(ask.item.title)];
  if (ask.item.running) lines.push(CLOUD_CHAT_TEXT.deleteRunning);
  if (ask.others) lines.push(CLOUD_CHAT_TEXT.deleteOthers);
  if (ask.item.visibility !== "private") lines.push(CLOUD_CHAT_TEXT.deleteShared);
  return <div className="pc-cloud-consent-backdrop" data-pc="cloud-delete-chat" data-stage={ask.stage}>
    <div className="pc-cloud-consent-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pc-cloud-delete-title">
      <h2 id="pc-cloud-delete-title">{CLOUD_CHAT_TEXT.deleteTitle}</h2>
      {lines.map((line, i) => <p key={i} data-pc="cloud-delete-line">{line}</p>)}
      {ask.text && <p className="pc-cloud-consent-error" role="alert" data-pc="cloud-delete-error">{ask.text}</p>}
      <div className="pc-cloud-consent-actions">
        <button type="button" data-pc="cloud-delete-cancel" onClick={props.onCancel} disabled={working}>{CLOUD_CHAT_TEXT.deleteCancel}</button>
        <button type="button" data-pc="cloud-delete-confirm" onClick={props.onConfirm} disabled={working || ask.stage === "error"}>
          {working ? CLOUD_CHAT_TEXT.deleteWorking : retry ? CLOUD_CHAT_TEXT.deleteRetry : CLOUD_CHAT_TEXT.deleteConfirm}
        </button>
      </div>
    </div>
  </div>;
}
