/**
 * Entry point for the sound thread (`docs/plan/online-card-exec-contract.md` 3.5): a dedicated
 * background thread spawned by the background stage; synced user card and media effect card
 * `audio()` executes only here. The thread origin is the stage origin: without `parent`,
 * `document`, or `localStorage`, unable to see any editor page storage; bootstrapping from a blob
 * URL inherits the Content Security Policy of the stage document, with the same network egress as
 * the stage (spawn logic is in `soundHost.ts` `spawn`, supplied by the stage).
 *
 * All logic resides in `soundThread.ts`; this file only receives messages and provides the
 * module table.
 */
import { createSoundThread, type SoundThreadIn } from "./soundThread.ts";
import { soundHostModules } from "./soundModules.ts";
import { CARD_RUNTIME_VERSION } from "./version.ts";
import { markOnlinePage } from "../pageFlag.ts";
import { setOnlineUserCardAudioGate } from "../soundPolicy.ts";
import { denyPersistentStorage } from "../isolation/harden.ts";
import { installScopeGuard } from "../isolation/scopeGuard.ts";

// Card `audio()` also runs on the stage origin: persistent storage, same-origin real-time channels
// (BroadcastChannel, SharedWorker, lock names), and spawning further background threads are
// likewise stripped or isolated (the same rules as the stage document, `harden.ts`, `scopeGuard.ts`).
// Ordered before any card code (card code is loaded only after messages arrive).
// Guards are installed with `strict`: this side has no fallback like stage self-checks
// (`isolationCheck.ts`); if key items fail to install, it throws an error, preventing the entire
// thread script from executing and card `audio()` from loading at all.
denyPersistentStorage(self);
installScopeGuard(self, { strict: true });

type Scope = { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null };
const scope = self as unknown as Scope;

// This is the isolated environment: enable `audio()` for user cards and media effect cards
// (`soundPolicy.ts` interface); per online page rules, asset sample chunks are not fetched
markOnlinePage();
setOnlineUserCardAudioGate(() => true);

const thread = createSoundThread({
  runtime: CARD_RUNTIME_VERSION,
  host: soundHostModules,
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
});
scope.onmessage = (event) => { void thread.handle(event.data as SoundThreadIn); };
scope.postMessage({ t: "ready" });
