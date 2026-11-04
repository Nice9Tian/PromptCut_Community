/**
 * Checkbox rows for host services in project settings "Multi-user collaboration" (contract
 * `docs/plan/hosted-render-contract.md` section 3; semantics `workflow/project.md`).
 *
 * One row is rendered per service name: it appears only if the project is in the cloud and this
 * hosted side has the service (`available`). The creator can change it (after ticking, creator
 * authentication runs, see `CreatorFlow` in `MembersPanel.tsx`); other members see it read-only.
 * Projects kept on this machine have no such group.
 * Under a service row, its sub-options hang indented (the render node's "Generate track stream",
 * `hostedOptionRowsOf`): they appear only if the document service reported the option; while the
 * service row is off, this row is greyed out and cannot be clicked; the creator can change it,
 * other members see it read-only.
 *
 * The component does not read the sync manager itself: data and actions all come from props, and
 * unit tests render it directly.
 */
import { HOSTED_SERVICE_TEXT, hostedOptionRowsOf, hostedOptionText, hostedRowsOf, type HostedOptionName, type HostedServiceName, type HostedView } from "./hostedServices";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

export function HostedServiceRows({ where, hosted, creator, busy = false, onToggle, onToggleOption }: {
  where: "lan" | "hosted" | null | undefined;
  hosted: HostedView | null;
  /** I am the creator: can change it; otherwise read-only */
  creator: boolean;
  busy?: boolean;
  onToggle: (service: HostedServiceName, enabled: boolean) => void;
  /** Checkbox for the sub-option (the render node's "Generate track stream"); if not given, treated as not changeable */
  onToggleOption?: (service: HostedServiceName, option: HostedOptionName, enabled: boolean) => void;
}) {
  const rows = hostedRowsOf(where, hosted);
  if (!rows.length) return null;
  const optionRows = hostedOptionRowsOf(where, hosted);
  return (
    <div className="pc-collab-hosted" data-pc="collab-hosted-services">
      {rows.map((row) => (
        <div key={row.service} data-pc={`collab-hosted-${row.service}`}>
          <label className="pc-collab-head">
            <input
              type="checkbox"
              data-pc={`collab-hosted-${row.service}-toggle`}
              checked={row.enabled}
              disabled={!creator || busy}
              onChange={(e) => onToggle(row.service, e.target.checked)}
            />
            {row.label}
          </label>
          <div className="pc-sync-hint" data-pc={`collab-hosted-${row.service}-hint`}>
            {HOSTED_SERVICE_TEXT[row.service]?.hint(row.enabled)}
            {creator ? "" : tr("(only the creator can change this)")}
          </div>
          {optionRows.filter((o) => o.service === row.service).map((o) => (
            <div
              key={o.option}
              className={`pc-collab-hosted-sub${o.parentOff || o.notAllowed ? " pc-collab-hosted-sub--off" : ""}`}
              data-pc={`collab-hosted-${o.service}-${o.option}`}
              data-state={o.parentOff || o.notAllowed ? "disabled" : o.enabled ? "on" : "off"}
            >
              <label className="pc-collab-head">
                <input
                  type="checkbox"
                  data-pc={`collab-hosted-${o.service}-${o.option}-toggle`}
                  checked={o.enabled}
                  disabled={!creator || busy || o.parentOff || o.notAllowed || !onToggleOption}
                  onChange={(e) => onToggleOption?.(o.service, o.option, e.target.checked)}
                />
                {o.label}
              </label>
              <div className="pc-sync-hint" data-pc={`collab-hosted-${o.service}-${o.option}-hint`}>
                {o.notAllowed ? tr("Your account does not have permission to enable this option. Please contact the host.") : (
                  <>
                    {hostedOptionText(o.service, o.option)?.hint(o.enabled)}
                    {o.parentOff ? tr("(render node is off, not in effect for now)") : ""}
                    {creator ? "" : tr("(only the creator can change this)")}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
