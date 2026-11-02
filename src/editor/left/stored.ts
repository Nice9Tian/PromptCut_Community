import { useCallback, useState } from "react";

/**
 * A few choices the left sidebar remembers in localStorage: the current section (pc.left.section),
 * the edit tab (pc.left.editTab), and the open group of each section
 * (pc.left.group.<section>). Reads and writes are wrapped in try -- private mode or full storage
 * should never make the UI report an error.
 */

export function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && allowed.includes(v)) return v;
  } catch {}
  return fallback;
}

/** Write; passing null deletes the key */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

/**
 * The group currently open in a section (null = overview).
 * The state lives in React, and localStorage only remembers it -- when something outside (such as
 * an import finishing) wants to open a group, call the returned setter. Do not write only to
 * localStorage, or the UI will not follow.
 */
export function useOpenGroup(section: string, allowed: readonly string[]): [string | null, (id: string | null) => void] {
  const key = `pc.left.group.${section}`;
  const [id, setId] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(key);
      return v && allowed.includes(v) ? v : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (next: string | null) => {
      setId(next);
      writeStored(key, next);
    },
    [key],
  );
  return [id, set];
}
