import { useEffect, useState } from "react";
import { TIER_LABEL, tierName, tierState } from "../online/onlineTier";
import { stageGate, stepText } from "../online/stageGate";

/**
 * 三道闸门的只读查看口(`docs/plan/online-browser-task.md` 第三步第 5 条):在线页面地址里带 `?gates=1` 时,在右上角显示当前各闸门的结果与
 * 崩溃记录,供在真机上核对(语义 `mechanism/platforms.md`「三道闸门」的「查看口」)。只读:不能改档位、不能清记录;不含任何凭证
 * (崩溃记录里只有时刻、软件版本、步骤、级别、测崩的卡的身份键)。每秒刷新一次。
 * 同样的内容经 `window.__pcGates()` 给探针读。
 */
export function gateViewerWanted(): boolean {
  try { return new URLSearchParams(location.search).get("gates") === "1"; } catch { return false; }
}

type Snapshot = Record<string, unknown> | null;

export function GateViewer() {
  const [snap, setSnap] = useState<Snapshot>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const read = () => {
      const w = window as unknown as { __pcGates?: () => Snapshot };
      setSnap(w.__pcGates?.() ?? null);
    };
    read();
    const timer = window.setInterval(read, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const t = tierState();
  const g = stageGate();
  const log = g?.snapshot().log;
  const lines: [string, string][] = [
    ["档位", t.online ? `${TIER_LABEL[tierName(t)]}(${tierName(t)})` : "桌面"],
    ["舞台闸门", `目标第 ${t.target} 级,到达第 ${t.reached} 级,${t.gate === "done" ? "已走完" : "试的途中"}${t.lowest ? `;最低一档(${t.lowest === "stage" ? "一个舞台都撑不住" : "基准卡跑不动"})` : ""}`],
    ["身份", t.identity === "phone" ? "手机" : "电脑"],
    ["基准卡", t.benchmark],
    ["这次怎么走", g ? `${g.decision.reason}:${g.decision.note}` : "(还没开)"],
    ["上次崩没崩", g ? (g.judged.crashed ? `崩了,在「${stepText(g.judged.step)}」` : "没崩") : ""],
    ["此刻的一步", g ? stepText(g.snapshot().step) : ""],
    ["崩的次数 / 护栏", log ? `${log.device.stage.crashes} 次;${log.device.stage.guardUntil ? `护栏到 ${new Date(log.device.stage.guardUntil).toLocaleTimeString()}` : "没有护栏"}` : ""],
    ["解码上限调低", log ? `${log.device.media.lowered} 级` : ""],
    ["测崩的卡", log ? `${log.device.heavyCards.length} 张` : ""],
  ];
  return (
    <div data-pc="gate-viewer" style={{
      position: "fixed", top: 8, right: 8, zIndex: 1000, width: open ? 420 : "auto", maxHeight: "80vh", overflow: "auto",
      background: "var(--ui-panel-2)", color: "var(--ui-fg)", border: "1px solid var(--ui-border)", borderRadius: 8, fontSize: 12, padding: 8,
    }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ fontSize: 12 }}>{open ? "收起闸门查看口" : "闸门查看口"}</button>
      {open && (
        <>
          <table style={{ width: "100%", marginTop: 6, borderCollapse: "collapse" }}>
            <tbody>
              {lines.map(([k, v]) => (
                <tr key={k}><td style={{ opacity: 0.7, whiteSpace: "nowrap", paddingRight: 8, verticalAlign: "top" }}>{k}</td><td data-pc-gate-row={k}>{v}</td></tr>
              ))}
            </tbody>
          </table>
          <details style={{ marginTop: 6 }}>
            <summary>完整记录(JSON)</summary>
            <pre data-pc="gate-json" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11 }}>{JSON.stringify(snap, null, 1)}</pre>
          </details>
        </>
      )}
    </div>
  );
}
