/**
 * The half of read-only (`readOnly.ts`) that depends on neither React nor the sync manager: it looks only at
 * `io/viewOnly.ts`.
 * Places outside components, such as handlers, shortcut gates, drag-and-drop and import, take it from here, without
 * dragging in the whole sync manager (also easy to mock in unit tests).
 */
import { viewOnlyReason, viewOnlyText } from "./io/viewOnly";

/** Whether this project is, right now, granted read-only access only (excluding `?observe`) */
export function memberReadOnlyNow(): boolean {
  return viewOnlyReason() === "read-only-member";
}

export interface ReadOnlyState {
  /** This project is granted read-only access only: controls that modify the project should be greyed out */
  locked: boolean;
  /** The sentence shown when greyed out (`viewOnlyText()`); an empty string when not locked */
  why: string;
  /** Hover explanation: when locked it is `why`; when not locked it is the control's own original one (there may be none) */
  title(own?: string): string | undefined;
}

export function readOnlyState(locked: boolean): ReadOnlyState {
  const why = locked ? viewOnlyText() : "";
  return { locked, why, title: (own) => (locked ? why : own) };
}

/**
 * Gate in handlers: returns true when locked, and the caller just returns.
 * The controls in the UI are already greyed out, so reaching here means a path was not covered (drag-and-drop,
 * shortcuts, events dispatched elsewhere); block it once more here.
 */
export function blockedByReadOnly(): boolean {
  return memberReadOnlyNow();
}
