/**
 * The switch of the "Voiceover settings" window.
 *
 * It has to be opened from two places: the voiceover card under "Extension features" on the start
 * page, and the "Voiceover settings" button in the editor's top bar. The two are not at the same
 * level of the same component tree, so the switch lives at module level and components subscribe
 * with useSyncExternalStore (the same approach as collectLoginStore).
 */
import { useSyncExternalStore } from "react";

export interface VoiceSettingsState {
  open: boolean;
  /**
   * The open sequence number, incremented on every open; the window uses it to reset its internal
   * state (re-read the settings once)
   */
  seq: number;
}

let state: VoiceSettingsState = { open: false, seq: 0 };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openVoiceSettings(): void {
  state = { open: true, seq: state.seq + 1 };
  emit();
}

export function closeVoiceSettings(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function useVoiceSettingsState(): VoiceSettingsState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}
