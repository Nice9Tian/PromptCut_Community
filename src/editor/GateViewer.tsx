import { useEffect, useState } from "react";
import { TIER_LABEL, tierName, tierState } from "../online/onlineTier";
import { stageGate, stepText } from "../online/stageGate";
import { tr } from "../i18n/index.ts";

/**
 * Read-only viewer for the three gates (`docs/plan/online-browser-task.md` step 3, item 5): when the online page URL carries `?gates=1`,
 * it shows the current result of each gate and the crash records in the top right corner, for checking on real devices
 * (semantics `mechanism/platforms.md` "Three gates", "Viewer"). Read-only: it cannot change tiers or clear records; it contains no credentials
 * (crash records only hold the time, software version, step, level, and the identity key of the card that was tested and crashed). Refreshes once per second.
 * The same content is exposed through `window.__pcGates()` for probes to read.
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
    [tr("Tier"), t.online ? `${TIER_LABEL[tierName(t)]}(${tierName(t)})` : tr("Desktop")],
    [tr("Stage gate"), tr("Target level {0}, reached level {1}, {2}{3}", t.target, t.reached, t.gate === "done" ? tr("completed") : tr("still trying"), t.lowest ? tr("; lowest tier ({0})", t.lowest === "stage" ? tr("cannot sustain even one stage") : tr("baseline card cannot run")) : "")],
    [tr("Identity"), t.identity === "phone" ? tr("Phone") : tr("Computer")],
    [tr("Baseline card"), t.benchmark],
    [tr("Path taken this time"), g ? `${g.decision.reason}:${g.decision.note}` : tr("(not opened yet)")],
    [tr("Crashed last time?"), g ? (g.judged.crashed ? tr("Crashed at \"{0}\"", stepText(g.judged.step)) : tr("No crash")) : ""],
    [tr("Current step"), g ? stepText(g.snapshot().step) : ""],
    [tr("Crash count / guard"), log ? tr("{0} times; {1}", log.device.stage.crashes, log.device.stage.guardUntil ? tr("Guard until {0}", new Date(log.device.stage.guardUntil).toLocaleTimeString()) : tr("No guard")) : ""],
    [tr("Decode limit lowered"), log ? tr("{0} levels", log.device.media.lowered) : ""],
    [tr("Cards that crashed in testing"), log ? tr("{0} cards", log.device.heavyCards.length) : ""],
  ];
  return (
    <div data-pc="gate-viewer" style={{
      position: "fixed", top: 8, right: 8, zIndex: 1000, width: open ? 420 : "auto", maxHeight: "80vh", overflow: "auto",
      background: "var(--ui-panel-2)", color: "var(--ui-fg)", border: "1px solid var(--ui-border)", borderRadius: 8, fontSize: 12, padding: 8,
    }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ fontSize: 12 }}>{open ? tr("Collapse gate viewer") : tr("Gate viewer")}</button>
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
            <summary>{tr("Full record (JSON)")}</summary>
            <pre data-pc="gate-json" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11 }}>{JSON.stringify(snap, null, 1)}</pre>
          </details>
        </>
      )}
    </div>
  );
}
