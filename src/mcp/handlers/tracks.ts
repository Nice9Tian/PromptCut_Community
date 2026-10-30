import { EditorApi } from "../../ai/mcpExecutor";

import { clipGuard, trackTools } from "../common";

export const tracksHandlers = {
  addTrack: (args) => { const r = trackTools.addTrack(args); clipGuard.noteMutation(); return r; },
  listTracks: () => trackTools.listTracks(),
  removeTrack: (args) => { const r = trackTools.removeTrack(args); clipGuard.noteMutation(); return r; },
  updateTrack: (args) => { const r = trackTools.updateTrack(args); clipGuard.noteMutation(); return r; },
  moveTrack: (args) => { const r = trackTools.moveTrack(args); clipGuard.noteMutation(); return r; },
} satisfies Partial<EditorApi>;
