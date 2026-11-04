import { registerCards, resetCards, allCards, setUserCardSources, getCard, userCardSources, noteCardsUpdated } from "../kernel/registry";
import { configureCardAudio } from "../audio/cardAudio";
import { cardSourceVersion } from "../render/cardSourceVersion.mjs";
import { builtinCardSourceFiles } from "../render/cardSourceFiles.mjs";
import { cyrb53 } from "../render/cyrb53.mjs";
import { magicuiCards } from "./magicui";
import { nativeCards } from "./native";
import { userCards, userCardFiles, userCardFileOf, userCardDependencies } from "./user";
import { assetCards } from "./assets";
// The parts library (the building blocks of composite cards) is installed together with the cards:
// src/parts/index.ts registers itself, and here we only need to make sure it is loaded
import "../parts";
import { probeCards } from "./_probe";

// This module is re-executed by HMR (creating or modifying a card under src/cards/user/ triggers it),
// so every time it reinstalls everything starting from empty: a deleted card file does not linger in
// the library, and registering twice does not raise an error.
resetCards();
// Media wrapper cards (translated from the Lottie / particle catalog) are registered together with
// the built-in cards: they are generated at build time, and their ids have reserved prefixes
registerCards([...magicuiCards, ...nativeCards, ...assetCards, ...probeCards]);

// Cards created by the user / AI are registered last, and ids that collide with built-in cards must
// be filtered out first.
// These files are added at runtime, and one colliding card must not keep the whole editor from
// starting: the card-creation route must not have the failure mode "one mistake and the software
// will not open".
// create_card also intercepts this once beforehand; this is the fallback.
const taken = new Set(allCards().map((c) => c.id));
const safeUserCards = userCards.filter((c) => {
  if (taken.has(c.id)) {
    console.warn(`[cards/user] 卡片 id "${c.id}" 和已有卡片重复,已跳过。改个 id 再试。`);
    return false;
  }
  taken.add(c.id);
  return true;
});
registerCards(safeUserCards);
// The original source of custom cards is handed to the registry, for packing when saving .proc (see
// registry.ts for why procCards does not import it directly)
setUserCardSources(userCardFiles, userCardFileOf, userCardDependencies);

/**
 * Audio media effect cards are evaluated in the page, and the definitions and source versions that
 * `src/audio/cardAudio.ts` needs are injected from here (at module level, not passed down layer by
 * layer). Every time HMR reruns this module it is called again, and the version number on the
 * `cardAudio` side goes up by 1: after the cards are swapped the project reference does not change,
 * and this is what makes the preview fetch chunks again.
 *
 * `userCardSources()` is **fetched only at call time**: `setUserCardSources` comes after
 * registerCards, so a snapshot taken at registration would be an empty table. The algorithm of the
 * source version follows the one in ExportView.tsx (the second argument is dependencies, not
 * files: the keys of files are bare file names with `./` and `.tsx` stripped, while
 * cardSourceVersion resolves by /src/… paths).
 */
configureCardAudio({
  getCard,
  sourceVersionOf: (id: string) => {
    const card = getCard(id);
    if (!card) return `missing:${id}`;
    const user = userCardSources();
    const file = user.fileOf[id];
    const source = file && user.files[file] !== undefined
      ? `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`
      : `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
    // Run the whole source closure text through a synchronous non-cryptographic hash (key() is
    // synchronous, there is no node:crypto in src/, and crypto.subtle.digest is a Promise)
    return cyrb53(source);
  },
});

/*
 * The boundary of hot updates (C6.6 integration 3b): as soon as a card file changes, the hot update
 * bubbles up along "card → this module" and is caught here: this module reruns (reinstalling the
 * whole set of cards from empty, above) and no longer bubbles up to Editor, Preview and StageView.
 * It used to bubble up, and then their effects reran during Fast Refresh: Preview's handshake effect
 * cleared the stage's RPC client, and since the stage did not reload and would not send
 * `pc-stage-ready` again, the stage stayed on the old picture and the preview stopped updating.
 * Every place that references this module only does `import "./cards"` for the side effect and takes
 * no bindings, so once caught there is no need to tell them to swap references; whoever wants to see
 * the new cards subscribes through the registry's `onCardsUpdated`. The notification is placed after
 * this whole batch of hot updates has landed (`vite:afterUpdate`), so subscribers do not read a
 * half-updated state (the card source table `cardSourceFiles.mjs` is updated in the same batch).
 */
if (import.meta.hot) {
  const data = import.meta.hot.data as { loaded?: boolean; changed?: boolean };
  if (data.loaded) data.changed = true;
  data.loaded = true;
  import.meta.hot.accept();
  import.meta.hot.on("vite:afterUpdate", (payload: { updates?: { timestamp?: number }[] }) => {
    if (!data.changed) return;
    data.changed = false;
    const stamp = Math.max(0, ...(payload?.updates ?? []).map((u) => Number(u.timestamp) || 0));
    noteCardsUpdated(stamp || Date.now());
  });
}
