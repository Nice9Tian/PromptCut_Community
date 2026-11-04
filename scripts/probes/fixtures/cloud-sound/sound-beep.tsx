/**
 * Test fixture for the "Cloud Agent sound" probe (`scripts/probes/cloud-agent-sound-probe.mjs`):
 * an audio-visual user card with `audio()`.
 *
 * The image is a solid color; the sound is a mono sine wave: sample n = sin(2π · hz · n / sample rate)
 * × gain, determined solely by parameters and sample position. The probe has the Cloud Agent create
 * it in the project content store via `create_card`, put it on the timeline, call `render_card_audio`,
 * and then verify the stored WAV sample by sample.
 *
 * Each time `audio()` is called, it records a count in `globalThis` (`__PC_SOUND_BEEP_RAN`): whichever
 * process ran this card's audio code will have it. The probe asserts based on this that it **did not**
 * execute inside the Cloud Agent service process. It probes nothing and sends no requests.
 */
import type { CardDef, CardProps } from "../../kernel/types";

type P = { hz: number; gain: number };

function SoundBeep(_props: CardProps<P>) {
  return <div className="absolute inset-0" style={{ background: "#102030" }} />;
}

export const soundBeep: CardDef<P> = {
  id: "sound-beep",
  name: "Beep card for the sound probe",
  description: "Test fixture: solid color frame plus a sine wave",
  tags: ["probe"],
  frameMode: "stateful",
  kind: "animation",
  inputs: {},
  defaults: { hz: 440, gain: 0.25 },
  controls: [{ key: "hz", label: "Frequency", type: "number", min: 50, max: 4000 }, { key: "gain", label: "Intensity", type: "number", min: 0, max: 1, step: 0.05 }],
  Component: SoundBeep,
  audio: (_sources, range, params) => {
    const g = globalThis as { __PC_SOUND_BEEP_RAN?: number };
    g.__PC_SOUND_BEEP_RAN = (g.__PC_SOUND_BEEP_RAN ?? 0) + 1;
    const out = new Float32Array(range.count);
    for (let i = 0; i < range.count; i += 1) out[i] = Math.sin(2 * Math.PI * params.hz * (range.start + i) / range.sampleRate) * params.gain;
    return out;
  },
};
