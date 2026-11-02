import "./CloudAgentConsentDialog.css";
import { tr } from "../../i18n/index.ts";

export const CLOUD_AGENT_CONSENT_NOTICE = tr("The host can read your chats with the Cloud Agent, including private chats");

export function CloudAgentConsentDialog(props: { open: boolean; pending: boolean; error: string | null; onAccept: () => void; onReject: () => void }) {
  if (!props.open) return null;
  return <div className="pc-cloud-consent-backdrop" data-pc="cloud-agent-consent">
    <div className="pc-cloud-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-cloud-consent-title">
      <h2 id="pc-cloud-consent-title">{tr("Before you use the Cloud Agent")}</h2>
      <p>{CLOUD_AGENT_CONSENT_NOTICE}</p>
      {props.error && <p className="pc-cloud-consent-error" role="alert">{props.error}</p>}
      <div className="pc-cloud-consent-actions">
        <button type="button" onClick={props.onReject} disabled={props.pending}>{tr("Decline")}</button>
        <button type="button" onClick={props.onAccept} disabled={props.pending}>{tr("Got it")}</button>
      </div>
    </div>
  </div>;
}
