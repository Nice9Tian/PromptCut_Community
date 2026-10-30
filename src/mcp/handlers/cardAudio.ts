import { cancelCardAudioGeneration, generateCardAudio } from "../../editor/io/cardAudioGeneration";
export const cardAudioHandlers = {
  async renderCardAudio(args: { clipId: string; force?: boolean }) {
    try { return await generateCardAudio(args.clipId, { force: args.force }); }
    catch (error) { return { ok: false, code: error instanceof DOMException && error.name === "AbortError" ? "CARD_AUDIO_CANCELLED" : "CARD_AUDIO_FAILED", error: error instanceof Error ? error.message : String(error) }; }
  },
  cancelCardAudio(args: { clipId: string }) { return { ok: true, cancelled: cancelCardAudioGeneration(args.clipId) }; },
};
