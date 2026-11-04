import { CLOUD_CHAT_TEXT } from "../../ai/chatTexts";
import type { CloudChatItem } from "../../ai/chatTypes";
import "./CloudAgentConsentDialog.css";

/** Confirmation before deleting a cloud chat. The texts are all in `src/ai/cloud/chatTexts.ts` (user confirmed 2026-10-13). */
export interface CloudDeleteAsk {
  item: CloudChatItem;
  /** One deletion uses the same request ID: when it was not completed (task not fully stopped), a retry reuses it */
  requestId: string;
  /** confirm = waiting for the user to click; working = submitted, waiting for the cloud; pending = task not fully stopped, can retry; error = rejected or failed */
  stage: "confirm" | "working" | "pending" | "error";
  text: string | null;
  /** The chat being deleted was opened by someone else (only the project creator gets here) */
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
