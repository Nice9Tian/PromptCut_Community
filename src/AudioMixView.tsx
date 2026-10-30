/**
 * ?audioMix=1&plan=<plan.json 地址>&out=<POST 地址>:导出的混音页。
 *
 * server/bakery/audio-mix.mjs 用 puppeteer 打开它,等 window.__pcAudioMix 出现。页面做的事只有一件:
 * 读 plan.json → renderMix(OfflineAudioContext,和预览同一套效果链)→ 32 位浮点 wav → POST 回服务端,
 * 服务端写成 export-<id>/audio/mix.wav,ffmpeg 再把它合进 preview.mp4。
 *
 * 不走 ExportView 的虚拟时钟:这一页没有画面,离线渲染自己有时间轴。
 */
import { useEffect, useState } from "react";
// 音频素材效果卡在这一页里求值,注册表和 configureCardAudio 必须先跑过。同一棵模块树里
// App / ExportView / StageView 已经各自 import 过它了,这行只是把依赖写明。
import "./cards";
import { encodeWavFloat32, peakOf, renderMix, type MixPlan } from "./audio/renderMix";

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
        if (!planUrl || !outUrl) throw new Error("缺 plan 或 out 参数");
        const res = await fetch(planUrl);
        if (!res.ok) throw new Error(`读 plan 失败:HTTP ${res.status}`);
        const plan = (await res.json()) as MixPlan;
        say(`${plan.clips.length} 段,${plan.duration} 秒,${plan.sampleRate} Hz`);
        const { buffer, ms, notes } = await renderMix(plan);
        for (const n of notes) say(n);
        const peak = peakOf(buffer);
        say(`渲染完成 ${(ms / 1000).toFixed(2)} s,峰值 ${(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1)} dBFS`);
        const wav = encodeWavFloat32(buffer);
        const up = await fetch(outUrl, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: wav });
        if (!up.ok) throw new Error(`上传 mix.wav 失败:HTTP ${up.status}`);
        say("已交回服务端");
        window.__pcAudioMix = { ok: true, seconds: buffer.duration, peak, renderMs: ms, notes };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        say(`失败:${msg}`);
        window.__pcAudioMix = { ok: false, error: msg };
      }
    })();
  }, []);
  return (
    <pre style={{ font: "12px/1.5 monospace", padding: 16, color: "#ccc", background: "#111", minHeight: "100vh", margin: 0 }}>
      {"PromptCut 混音\n"}
      {log.join("\n")}
    </pre>
  );
}
