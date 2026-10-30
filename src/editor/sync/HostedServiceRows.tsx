/**
 * 项目设置「多用户协作」里托管方服务的勾选行（契约 `docs/plan/hosted-render-contract.md` 第 3 节；语义 `workflow/project.md`）。
 *
 * 按服务名各渲染一行：项目放云端、且这台托管端有这个服务（`available`）才出现；创建者能改（点勾选后走创建者身份验证，
 * 见 `MembersPanel.tsx` 的 `CreatorFlow`），其他成员只读。放本机的项目没有这一组。
 * 服务那一行下面缩进挂它的子选项（渲染节点的「生成轨道流」，`hostedOptionRowsOf`）：文档服务报了这个选项才出现；服务那一行关着时
 * 这一行置灰、不可点；创建者能改，其他成员只读。
 *
 * 组件本身不读同步管理：数据与动作都从属性来，单测直接渲染它。
 */
import { HOSTED_SERVICE_TEXT, hostedOptionRowsOf, hostedOptionText, hostedRowsOf, type HostedOptionName, type HostedServiceName, type HostedView } from "./hostedServices";
import "./sync.css";

export function HostedServiceRows({ where, hosted, creator, busy = false, onToggle, onToggleOption }: {
  where: "lan" | "hosted" | null | undefined;
  hosted: HostedView | null;
  /** 我是创建者:能改;否则只读 */
  creator: boolean;
  busy?: boolean;
  onToggle: (service: HostedServiceName, enabled: boolean) => void;
  /** 子选项(渲染节点的「生成轨道流」)的勾选；不给就当不能改 */
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
            {creator ? "" : "（只有创建者能改）"}
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
                {o.notAllowed ? "你的账号没有开启这一项的权限，请联系托管方。" : (
                  <>
                    {hostedOptionText(o.service, o.option)?.hint(o.enabled)}
                    {o.parentOff ? "（渲染节点关着，暂不生效）" : ""}
                    {creator ? "" : "（只有创建者能改）"}
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
