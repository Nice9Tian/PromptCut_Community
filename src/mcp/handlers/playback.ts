import { EditorApi } from "../../ai/mcpExecutor";
import { actions } from "../../store/project";


export const playbackHandlers = {
  seek: (args) => { actions.seek(args.t); return { ok: true }; },
  play: () => { actions.play(); return { ok: true }; },
  pause: () => { actions.pause(); return { ok: true }; },
} satisfies Partial<EditorApi>;
