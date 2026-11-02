import { useSyncExternalStore } from "react";

/**
 * Script: a passage handwritten by the user explaining what this video is about and in what order
 * to tell it.
 *
 * It is **spliced into the system prompt on every round**, rather than being stated once in the
 * first message: over many rounds the model easily drifts further and further along its
 * intermediate results, and only having it in front of its eyes each round keeps it on track.
 * The arrangement written by the editing director should also be written back here, and the
 * effects assistant then follows it later.
 *
 * Stored in localStorage: the script is "what is being written for this project on this machine",
 * and it has not yet entered the .proc project format (a file another session is changing), so
 * leave that alone for now.
 */

const KEY = "pc.ai.script";

let current = read();
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function getScript(): string {
  return current;
}

export function setScript(next: string) {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* Cannot be saved in incognito mode; it still takes effect in memory */
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useScript(): string {
  return useSyncExternalStore(subscribe, getScript, getScript);
}
