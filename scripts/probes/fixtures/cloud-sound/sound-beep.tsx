/**
 * 「云端 Agent 的声音」探针的测试夹具(`scripts/probes/cloud-agent-sound-probe.mjs`):一张带 `audio()` 的声画用户卡。
 *
 * 画面是一块纯色;声音是一段单声道正弦波:第 n 个采样 = sin(2π · hz · n / 采样率) × gain,只由参数与采样位置决定。
 * 探针让云端 Agent 用 `create_card` 把它建进项目的内容库、放上时间轴,再 `render_card_audio`,然后逐样本核对入库的 WAV。
 *
 * `audio()` 每次被调用都往 `globalThis` 记一个数(`__PC_SOUND_BEEP_RAN`):这张卡的声音代码在哪个进程里跑过,那个进程里就有它。
 * 探针据此断言它**没有**在云端 Agent 服务的进程里执行。它什么都不探、不发任何请求。
 */
import type { CardDef, CardProps } from "../../kernel/types";

type P = { hz: number; gain: number };

function SoundBeep(_props: CardProps<P>) {
  return <div className="absolute inset-0" style={{ background: "#102030" }} />;
}

export const soundBeep: CardDef<P> = {
  id: "sound-beep",
  name: "声音探针的哔声卡",
  description: "测试夹具:纯色画面加一段正弦波",
  tags: ["探针"],
  frameMode: "stateful",
  kind: "animation",
  inputs: {},
  defaults: { hz: 440, gain: 0.25 },
  controls: [{ key: "hz", label: "频率", type: "number", min: 50, max: 4000 }, { key: "gain", label: "强度", type: "number", min: 0, max: 1, step: 0.05 }],
  Component: SoundBeep,
  audio: (_sources, range, params) => {
    const g = globalThis as { __PC_SOUND_BEEP_RAN?: number };
    g.__PC_SOUND_BEEP_RAN = (g.__PC_SOUND_BEEP_RAN ?? 0) + 1;
    const out = new Float32Array(range.count);
    for (let i = 0; i < range.count; i += 1) out[i] = Math.sin(2 * Math.PI * params.hz * (range.start + i) / range.sampleRate) * params.gain;
    return out;
  },
};
