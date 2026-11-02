/**
 * ?audioMix=1&plan=<plan.json URL>&out=<POST URL>: the export mix page.
 *
 * server/bakery/audio-mix.mjs opens it with puppeteer and waits for window.__pcAudioMix to appear.
 * The page does only one thing: read plan.json → renderMix (OfflineAudioContext, the same effect
 * chain as the preview) → 32-bit float wav → POST it back to the server, which writes it as
 * export-<id>/audio/mix.wav, and ffmpeg then merges it into preview.mp4.
 *
 * It does not use ExportView's virtual clock: this page has no picture, and offline rendering has
 * its own timeline.
 */
import { useEffect, useState } from "react";
// Audio media effect cards are evaluated in this page, so the registry and configureCardAudio must
// run first. App / ExportView / StageView in the same module tree have each already imported it;
// this line just makes the dependency explicit.
import "./cards";
import { encodeWavFloat32, peakOf, renderMix, type MixPlan } from "./audio/renderMix";
import { tr } from "./i18n/index.ts";

declare global {
  interface Window {
    __pcAudioMix?: { ok: boolean; error?: string; seconds?: number; peak?: number; renderMs?: number; notes?: string[] };
  }
}

export default function AudioMixView() {
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const planUrl = q.get("plan") || "";
    const outUrl = q.get("out") || "";
    const say = (s: string) => setLog((l) => [...l, s]);
    (async () => {
      try {
        if (!planUrl || !outUrl) throw new Error(tr("Missing plan or out parameter"));
        const res = await fetch(planUrl);
        if (!res.ok) throw new Error(tr("Failed to read plan: HTTP {0}", res.status));
        const plan = (await res.json()) as MixPlan;
        say(tr("{0} clips, {1} s, {2} Hz", plan.clips.length, plan.duration, plan.sampleRate));
        const { buffer, ms, notes } = await renderMix(plan);
        for (const n of notes) say(n);
        const peak = peakOf(buffer);
        say(tr("Render finished in {0} s, peak {1} dBFS", (ms / 1000).toFixed(2), (20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1)));
        const wav = encodeWavFloat32(buffer);
        const up = await fetch(outUrl, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: wav });
        if (!up.ok) throw new Error(tr("Failed to upload mix.wav: HTTP {0}", up.status));
        say(tr("Handed back to the server"));
        window.__pcAudioMix = { ok: true, seconds: buffer.duration, peak, renderMs: ms, notes };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        say(tr("Failed: {0}", msg));
        window.__pcAudioMix = { ok: false, error: msg };
      }
    })();
  }, []);
  return (
    <pre style={{ font: "12px/1.5 monospace", padding: 16, color: "#ccc", background: "#111", minHeight: "100vh", margin: 0 }}>
      {tr("PromptCut mix\n")}
      {log.join("\n")}
    </pre>
  );
}
