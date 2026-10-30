import "./CloudAgentConsentDialog.css";

export const CLOUD_AGENT_CONSENT_NOTICE = "托管方能读到你和云端 Agent 的对话记录，包括私有对话";

export function CloudAgentConsentDialog(props: { open: boolean; pending: boolean; error: string | null; onAccept: () => void; onReject: () => void }) {
  if (!props.open) return null;
  return <div className="pc-cloud-consent-backdrop" data-pc="cloud-agent-consent">
    <div className="pc-cloud-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-cloud-consent-title">
      <h2 id="pc-cloud-consent-title">使用云端 Agent 前请先了解</h2>
      <p>{CLOUD_AGENT_CONSENT_NOTICE}</p>
      {props.error && <p className="pc-cloud-consent-error" role="alert">{props.error}</p>}
      <div className="pc-cloud-consent-actions">
        <button type="button" onClick={props.onReject} disabled={props.pending}>拒绝</button>
        <button type="button" onClick={props.onAccept} disabled={props.pending}>我知道了</button>
      </div>
    </div>
  </div>;
}
