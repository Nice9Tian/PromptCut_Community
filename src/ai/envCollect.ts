import { buildEnvReport, type EnvInput } from "./envReport";
import { getSkillSnapshot } from "../skill/skillMode";
import { getRealTabs } from "./agentTabs";
import { getState } from "../store/project";
import { tr } from "../i18n/index.ts";

/**
 * Gathers the "state at that moment" scattered across the various stores, then asks the server
 * for its half.
 *
 * The assembly logic lives in envReport.ts (a pure function, unit-testable); this file only does the
 * value collection and that single network request. There is little to test in the collection itself,
 * and each of those stores would have to be mocked in the test environment before it could run.
 *
 * **No step may block the report when it fails**. The diagnostic report is clicked only after the
 * user has already hit a problem, and by then the local service is quite likely the very thing that
 * broke; failing to export the whole report for the sake of one more piece of context would also
 * throw away the only clue. So each section has its own try, and a failure leaves one line in place.
 */

/**
 * Timeout for asking the server for environment info. It is already on this machine, so if it
 * has not replied within five seconds, it is itself in trouble
 */
const SERVER_TIMEOUT_MS = 5000;

function clientInput(): EnvInput {
  const st = getState();
  const p = st.project;
  return {
    skill: (() => { try { return getSkillSnapshot().state; } catch { return null; } })(),
    agentTabs: (() => { try { return getRealTabs().length; } catch { return 1; } })(),
    project: {
      name: p.name,
      filePath: st.filePath,
      dirty: st.dirty,
      duration: p.duration,
      width: p.width,
      height: p.height,
      fps: p.fps,
      media: p.media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind,
        duration: m.duration, width: m.width, height: m.height,
        path: m.path, hasTranscript: !!m.transcript,
      })),
      tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, clips: t.clips })),
    },
    storage: (() => { try { return localStorage; } catch { return null; } })(),
    agent: typeof navigator === "undefined" ? null
      : { userAgent: navigator.userAgent, language: navigator.language, platform: (navigator as any).platform },
    viewport: typeof window === "undefined" ? null
      : { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
  };
}

/** The server's half: Node process state, the session file cabinet, which drivers are installed */
async function serverPart(): Promise<unknown> {
  try {
    // refresh=0: do not spawn a subprocess for each of the three CLIs to check liveness for this
    // snapshot (15-second timeout each). That would let the checks drag the most valuable section,
    // sessions, into a timeout and lose it, and this button is clicked precisely when the machine is in
    // trouble.
    const res = await fetch("/api/ai/diagnostics?refresh=0", { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { error: data?.error || `HTTP ${res.status}` };
    return data;
  } catch (e) {
    // The service not being up is a clue in itself; do not swallow it
    return { error: e instanceof Error ? e.message : String(e), note: tr("Can't get server info: the local service may not be running, which may itself be the problem") };
  }
}

export async function collectEnvironment(visibleMessages: number): Promise<Record<string, unknown>> {
  let client: Record<string, unknown>;
  try {
    client = buildEnvReport({ ...clientInput(), visibleMessages });
  } catch (e) {
    client = { error: e instanceof Error ? e.message : String(e), note: tr("The snapshot on the UI side could not be collected") };
  }
  return { ...client, server: await serverPart() };
}
