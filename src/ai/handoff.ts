import type { AiProvider, ChatMessage } from "./types";
import { reportsOf, reportText } from "./progressReport.ts";
import { tr } from "../i18n/index.ts";

/**
 * The "prior context" when a different model takes over.
 *
 * Each CLI's history hangs on its own session id (aiSession:<provider>), and a request carries only
 * what was said in this round. So when the model is switched in the panel, the new model gets only
 * a "you take over and continue": what the user complained about and wanted in the earlier rounds
 * is all unknown to it. In one real chat Opus took over exactly like this: it could not see the
 * user's line "there are no videos or images at all", could only find work to do from the project's
 * current state, and even went digging through the disk for "handoff notes".
 *
 * This condenses **the rounds this provider's model has not seen** into one passage and prepends it
 * to this round's prompt (it goes to the model only, not to the screen).
 * "Not seen" = the messages after this provider's last reply; if this provider has no session id
 * yet, it is the whole chat.
 */

const LABEL: Record<AiProvider, string> = {
  claude: "Claude",
  agy: "Antigravity",
  codex: "Codex",
  api: tr("Direct API"),
};

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? tr("{0}…(rest omitted)", t.slice(0, max)) : t;
}

/**
 * What this message is condensed into in the prior context.
 *
 * Since the redesign, the Agent's text replies are not shown to the user by default, and it may
 * say nothing at all and only submit report_progress. Judged by m.text alone, such a reply is empty
 * and the prior context would look as if it did nothing: after a fallback, the model in the new
 * session would not know what the earlier rounds had already finished. When the text is empty, a
 * line "Done: …; To do: …; Issues: …" assembled from the report is used instead.
 */
function spokenText(m: ChatMessage): string {
  const text = m.text?.trim() ?? "";
  if (text || m.role !== "assistant") return text;
  return reportsOf(m).map(reportText).filter(Boolean).join(" / ");
}

export function buildHandoff(
  history: ChatMessage[],
  provider: AiProvider,
  hasSession: boolean,
  opts: { maxChars?: number; perMessage?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 6000;
  const perMessage = opts.perMessage ?? 1200;

  let from = 0;
  if (hasSession) {
    let lastOwn = -1;
    history.forEach((m, i) => {
      if (m.role === "assistant" && m.runtime?.provider === provider) lastOwn = i;
    });
    from = lastOwn + 1;
  }
  const unseen = history.slice(from).filter((m) => !m.pending);

  // When there is a session id, prior context counts only if another provider has actually spoken;
  // this provider's own errors and several messages sent in a row by the user need no catching up.
  // A reply that only submitted a progress report and wrote no text also counts as having spoken
  const othersSpoke = unseen.some((m) => m.role === "assistant" && spokenText(m) && m.runtime?.provider !== provider);
  const anySpoke = unseen.some((m) => m.role === "assistant" && spokenText(m));
  if (hasSession ? !othersSpoke : !anySpoke) return "";

  const lines: string[] = [];
  for (const m of unseen) {
    const text = spokenText(m);
    if (!text) continue;
    if (m.role === "user") lines.push(tr("User: {0}", clip(text, perMessage)));
    else if (m.role === "assistant") {
      const who = m.runtime?.provider ? LABEL[m.runtime.provider] ?? m.runtime.provider : tr("Assistant");
      lines.push(tr("Assistant ({0}{1}): {2}", who, m.runtime?.model ? ` · ${m.runtime.model}` : "", clip(text, perMessage)));
    }
  }

  // Collect from the most recent backwards until full; the earliest few yield, since the user's
  // latest request matters more than the opening pleasantries
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > maxChars && kept.length > 0) break;
    kept.unshift(lines[i]);
    size += lines[i].length;
  }
  const dropped = lines.length - kept.length;

  return [
    tr("[Background: attached automatically by the system, not something the user said this round. Before this conversation you were not the one handling it (or your session record is gone),"),
    tr("so you can't see that history. Below is an excerpt in chronological order. Requests the user made in it still count; for the current state of the timeline and media library, trust what the tools read.]"),
    ...(dropped > 0 ? [tr("({0} earlier items omitted)", dropped)] : []),
    ...kept,
    tr("[/Background]"),
  ].join("\n");
}
