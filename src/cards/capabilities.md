# Card classification registry (annotated edition of `capabilities.json`)

JSON cannot hold comments, so the conclusions and reasons for each entry are written here. **Any change to `capabilities.json` must be accompanied by a change to this document.**

The three axes are defined in `docs/semantics/mechanism/cards.md`, section "The three dividing axes". This table registers every built-in card's value on the three axes in one place.

- First review: 2026-09-17, which registered only "whether it depends on the lower layer" and "whether it is a canvas card".
- 2026-10-12 (render refactor "Ding", `docs/plan/render-refactor-task.md`): all three items registered, four more cards added to the registry, gatekeeper test added.
- 2026-10-13 (render refactor, "the clean-version merge"): for `cardCapabilities`, the writing style is taken only from the card's declaration; whether a card is a canvas card is now derived from `surface`, and `canvasHeavy` is removed from the table.

## 1. What this table covers

The scope is **built-in cards**: the four groups registered together with `registerCards` in `src/cards/index.ts`, currently 101 cards.

| Group | Count | Location |
|---|---:|---|
| In-house cards | 27 | `src/cards/native/` |
| MagicUI | 5 | `src/cards/magicui/` |
| Media wrapper cards | 58 | `src/cards/assets/`, generated from the asset catalog: 5 Lottie cards, 53 particle cards |
| Probe cards | 11 | `src/cards/_probe/`, used only by probe scripts |

Cards created by users (including cards embedded in a project) are not in this table, see section 8.

### Three items per entry

| Field | Axis | Values | Who decides |
|---|---|---|---|
| `writing` | Axis 1: which writing style | `remotion` / `motion` | **The card's declaration**. `remotion` corresponds to `frameMode: "direct"` in the declaration, `motion` to `"stateful"`. The value registered in the table is taken from the declaration; if the two do not match it counts as an error, the gatekeeper test goes red, and you change the table, not the card |
| `surface` | Axis 2: what it is drawn on | `dom` / `canvas2d` / `webgl` / `none` | **This table** |
| `compositing` | Axis 3: whether it depends on the lower layer | `independent` / `sourceDependent` / `belowDependent`, plus two markers `unknown` and `fromParts` | **This table**. These three values written in the source code are always ignored |

Whether a card is a canvas card is derived from `surface`: `canvas2d` or `webgl` means a canvas card. The old field `canvasHeavy` must no longer be written into the table (the gatekeeper test blocks it); for how this came about, see section 3.

The four values of `surface`:

- `dom`: drawn on the DOM. SVG counts too (Lottie uses SVG rendering, see axis 2 in `mechanism/cards.md`).
- `canvas2d`: drawn on a 2D canvas.
- `webgl`: drawn on WebGL (three.js, etc.).
- `none`: no picture, a card that only produces sound.

The values of `compositing`:

- `independent`: draws only itself. Can be prerendered on its own and shared through the asset service.
- `sourceDependent`: takes another specified piece of footage as input (a transition). Tracing the whole chain upward, it becomes invalid when the parameter hash of any control on the chain changes.
- `belowDependent`: frosted glass, post-processing. It becomes invalid when the parameter hash of any control in the lower layers at the same moment changes.
- `unknown` (marker): registered, but **deliberately not reviewed**. Used only by three probe cards (`r6-unknown`, `probe-css`, `probe-motion-js`), whose whole purpose is to be "a card that has not been reviewed". At runtime it behaves the same as not being in the table: it is handled as a below-dependent card, and does not go into the shared cache or into the stream. No other card may use it.
- `fromParts` (marker): for the composite card `composite` only; axis 3 is derived from its parts, see section 6.

`context` is the old umbrella name for `sourceDependent` / `belowDependent`, kept only to read declarations in old `.proc` files; **it must not be written in the table**.

### Wildcards

A key can be written as `prefix-*`. Lookup order: exact id first, then the **longest** `prefix-*`.
The table has only one wildcard, `"particles-*"`, which covers the 53 particle media wrapper cards. The prefix of `particles-*` includes a hyphen,
so it does **not** match the generic particle card `particles` (which has an entry of its own).

### Who reads it

- `src/kernel/frameMode.mjs`: `reviewedCard(id)` returns the entry as is; `reviewedCanvas(id)` derives from `surface` whether a card is a canvas card; `cardCapabilities` uses `compositing` and `surface` from it (`surface` only to derive whether it is a canvas card or not).
- `server/vision-project.mjs`: the Node side has a separate loader. `reviewedCapabilities(id)` returns the original entry; `reviewedClassification(id)` puts the three items together (writing style, the corresponding `frameMode`, what it is drawn on, whether it is a canvas card, axis 3). The value tables of the three items are also constants there.

The gatekeeper test verifies that both places find the same thing.

## 2. Which keys change when this table changes

The whole return value of `cardCapabilities` goes into the digest of the card identity (`src/kernel/cardGraph.mjs` writes it on the node's `capabilities`). It has only five items: `frameMode`, `need_prerendering`, `compositing`, `canvasHeavy`, `independentCache`.

- **Changing a card's `compositing` or whether it is a canvas card**: this card's capability table changes, so the keys of its prerender output and its cost key are all renewed, and the old cache no longer hits.
- **`writing` does not go into the digest**: it is only a registration, and the writing style is taken only from the card's declaration. **`surface` goes into the digest only through the single bit "whether it is a canvas card"**: swapping `dom` and `none`, or `canvas2d` and `webgl`, leaves the digest unchanged. The gatekeeper test watches that the return value of `cardCapabilities` still has only those five items.
- **Adding an entry**: only affects cards that could not be found before and can be found now.

How to verify: `node scripts/probes/card-table-digest-compare.mjs` computes the capability table, source version and three keys once for all built-in cards at the baseline commit and in the current working tree, and compares card by card. Run it after changing the table and write the result into the report.

## 3. How the two places in `frameMode.mjs` were cleaned up

`src/kernel/frameMode.mjs` is in the **source import closure** of every built-in card (card → `kernel/types.ts` → `frameMode.mjs`, with only a type import in between). A card's source version is the full text of all files in the closure (`src/render/cardSourceVersion.mjs`); it goes into the key of every prerender output and also into the identity of the card's sound. So if you **change a single character** in this file, the keys of all built-in cards whose own source file can be found by id all change, and generated card sounds are judged "expired, please regenerate" once (measured 2026-10-12: adding just one comment line changed the keys of 42 cards; the rest are the 58 media wrapper cards and `composite`, whose hardcoded id cannot be found in their source files and whose source version uses a different algorithm, so they did not change). `src/kernel/cardGraph.mjs` is also in this closure, and the same applies.

On 2026-10-12, in "Ding", to avoid changing other cards' keys, not a single character of these two files was touched, which left two places that were not clean. On 2026-10-13 the user agreed to let card sounds expire once (`docs/plan/user-decisions-2026-10-13.md`, section 1, item 14, option B), and both were cleaned up together in "the clean-version merge":

1. **The writing style is taken from the declaration only.** `cardCapabilities` used to contain a line of old code: if the table had `frameMode`, it overrode the card's declaration. That line is deleted. As before, the key `frameMode` must not appear in the table (nobody reads it if you write it); use `writing` to register the writing style.
2. **Canvas cards are derived from `surface`.** At runtime, whether a card is a canvas card used to be decided by reading `canvasHeavy` in the table, which duplicated `surface`. Now `reviewedCanvas(id)` in `frameMode.mjs` derives it from `surface` (`canvas2d` / `webgl`), `canvasHeavy` is deleted from the table, and the gatekeeper test blocks writing it again. `canvasHeavy` on the card definition (`CardDef.canvasHeavy`) is still there: for cards that are not canvas cards in the table or are not registered, the card's own value of this item is still used as before (user cards take this path).

Neither change alters any card's capability object (compared card by card before and after, see `docs/reports/AGENT-rr-clean.md`). Any future change to these two files likewise requires the user's consent first: the gatekeeper test `src/render/audioCardSourceVersion.test.mjs` pins it.

## 4. Summary of conclusions (101 built-in cards)

| Writing style | Count | Cards |
|---|---:|---|
| `remotion` | 11 | `caption-track`, `av-pulse`, `sound-notification`, `sound-keyboard`, `probe-slow`, plus the 6 Lottie cards: `lottie`, `lottie-adrock`, `lottie-bodymovin`, `lottie-gatin`, `lottie-happy2016`, `lottie-navidad` (on 2026-10-13 the render refactor "Gui" changed their declarations to remotion-style) |
| `motion` | 90 | All the rest |

| Drawn on | Count | Cards |
|---|---:|---|
| `dom` | 43 | All except the three rows below (including the 6 Lottie cards) |
| `canvas2d` | 55 | The generic particle card `particles`, the 53 particle media wrapper cards (wildcard), the probe card `r6-canvas` |
| `webgl` | 1 | `scene-3d` |
| `none` | 2 | `sound-notification`, `sound-keyboard` |

| Depends on lower layer | Count | Cards |
|---|---:|---|
| `independent` | 85 | All except the three rows below |
| `belowDependent` | 12 | The 12 in-house cards that use `hud-glass` |
| `sourceDependent` | 0 | No built-in card currently "takes another piece of footage as input" |
| `unknown` (deliberately not reviewed) | 3 | `r6-unknown`, `probe-css`, `probe-motion-js` |
| `fromParts` | 1 | `composite` |

The table also has one entry that is not among these 101: `mu-animated-shiny-text`. It is a card under `src/cards/user/` that ships with the repository (it used to be counted under MagicUI); its registration is kept, and the three items are filled in according to its declaration and how it draws.

## 5. Criteria

**The only source of `belowDependent` is `hud-glass`.** The `.hud-glass` in `src/cards/native/hud.css`
has `backdrop-filter: blur(var(--pc-glass-blur, 24px))`, and it samples the already-composited picture behind itself,
so if the parameters of any card in the lower layers change, this card's prerender output no longer counts. This is the only place in the whole repository with `backdrop-filter`.
Exactly 12 card files use `className="hud-glass"`.

**Zero hits for reading pixels.** No card under `src/cards` uses `getImageData` or cross-layer `drawImage(`.
The `drawImage(canvas)` that appears in `scene-3d.tsx` is a comment, and it is about the **editor** reading this card's canvas,
the opposite direction, so it is not a dependency on the lower layer.

**The criterion for a canvas card is "the picture is carried by canvas / WebGL"**, not "heavy".
`particles` (tsParticles, 2D canvas, `canvas.kind` is `dom2d` in the declaration) and `scene-3d` (three.js, WebGL, `canvas.kind` is `three`);
The 3D look of `terminal-3d` comes from CSS perspective, **it has no canvas**; Lottie uses SVG rendering and is counted as a DOM card;
What `focus-card` has is a `<video>`, not a canvas. For a card whose declaration has a canvas contract (`canvas`), the `surface` in the table must match it, and the gatekeeper test checks this.

**A card's own `filter: blur()` does not count as depending on the lower layer.** The `blur()` in `punch-pill.tsx` and `blur-text.tsx`
blurs its own element and does not sample the picture behind it. `blur-text` is classified as `belowDependent` because it additionally uses `hud-glass`,
not because of this `filter`.

**The writing style is not judged here.** It is taken from the card's declaration; whether the declaration is correct is the responsibility of the card-creation check and the card author.

### Card by card

**MagicUI (5 cards, all `motion` / `dom` / `independent`)**

| id | Reason |
|---|---|
| `mu-number-ticker` | Motion spring changes the number, pure DOM text |
| `mu-blur-fade` | Motion applies `filter: blur` plus translation to itself, does not sample what is behind |
| `mu-circular-progress` | rAF interpolation plus SVG stroke |
| `mu-typing` | rAF changes the displayed characters, plain text |
| `mu-word-rotate` | AnimatePresence swaps words |

`mu-animated-shiny-text` (the one under `src/cards/user/`): CSS keyframe highlight, `background-clip` acts on itself, the three items are the same as above.

**In-house cards (27 cards)**

| id | Writing style | Drawn on | Depends on lower layer | Reason |
|---|---|---|---|---|
| `composite` | motion | dom | `fromParts` | See section 6 |
| `lottie` | remotion | dom | independent | `LottieView` uses SVG rendering and draws only itself. Every frame converts `t` into a frame number and jumps straight to it; the random numbers in the playback library and "property values keeping the old number" are pinned down in `loadLottie`, so stepping forward and jumping directly give the same picture (registration changed 2026-10-13) |
| `particles` | motion | canvas2d | independent | tsParticles draws on its own canvas; outside the opaque area of the canvas it is transparent, and it does not read the lower layer |
| `scene-3d` | motion | webgl | independent | three.js WebGL, computes the pose from `t` and then renders explicitly; draws only itself |
| `caption-track` | remotion | dom | independent | Plain-text captions; although it imports `hud.css`, it does not use `hud-glass` |
| `av-pulse` | remotion | dom | independent | A ring whose size and opacity are computed from `t` (its own border), does not sample what is behind; the same clip also has sound (added to the registry on 2026-10-12) |
| `sound-notification` | remotion | none | independent | Only `audio()`, no picture (added to the registry on 2026-10-12) |
| `sound-keyboard` | remotion | none | independent | Same as above (added to the registry on 2026-10-12) |
| `entity-chips` | motion | dom | independent | Imports `hud.css` but uses the positioning classes, not the glass panel |
| `pin-board` | motion | dom | independent | Same as above |
| `punch-pill` | motion | dom | independent | Same as above; `filter: blur(32px)` is its own glow base |
| `quote-lockup` | motion | dom | independent | Same as above |
| `type-shift` | motion | dom | independent | Same as above |
| `ui-callout` | motion | dom | independent | Same as above (DOM plus SVG leader lines) |
| `focus-card` | motion | dom | independent | The person window uses `<video>` plus Motion and draws itself. It plays the media from its own parameters, not the picture of another clip, so it is not `sourceDependent` |
| `blur-text` | motion | dom | **belowDependent** | Uses `hud-glass` |
| `chapter-bar` | motion | dom | **belowDependent** | Same as above |
| `checklist` | motion | dom | **belowDependent** | Same as above |
| `growth-curve` | motion | dom | **belowDependent** | Same as above |
| `odometer` | motion | dom | **belowDependent** | Same as above |
| `rank-bars` | motion | dom | **belowDependent** | Same as above |
| `ring-metric` | motion | dom | **belowDependent** | Same as above |
| `stat-proof` | motion | dom | **belowDependent** | Same as above |
| `step-timeline` | motion | dom | **belowDependent** | Same as above |
| `term-card` | motion | dom | **belowDependent** | Same as above |
| `terminal-3d` | motion | dom | **belowDependent** | Same as above; its 3D is CSS perspective, not canvas |
| `versus-card` | motion | dom | **belowDependent** | Same as above, two glass panels |

**Lottie media wrapper cards (5 cards, all `remotion` / `dom` / `independent`)**

`lottie-adrock`, `lottie-bodymovin`, `lottie-gatin`, `lottie-happy2016`, `lottie-navidad`.
All five share `LottieView` (SVG rendering); each draws only its own animation, they do not sample each other, and none is a canvas card. The writing style follows the generic Lottie card and was changed to remotion-style together with it on 2026-10-13.

**Particle media wrapper cards (53 cards, wildcard `particles-*`, all `motion` / `canvas2d` / `independent`)**

All 53 share `ParticlesView` plus `translateParticlesConfig` and differ only in the JSON config: the same renderer,
the same own canvas, the same "draws only itself" conclusion, and the declarations are generated by the same piece of code, so they are merged into one wildcard.

> `mouse*`, `clickPause` and `lightHover` in the config names are interaction demos from the upstream examples. There is no mouse on the stage,
> so these interactions are never triggered; they still draw only their own canvas, and `independent` is unaffected.

**Probe cards (11 cards)**

| id | Writing style | Drawn on | Depends on lower layer | Notes |
|---|---|---|---|---|
| `probe` | motion | dom | independent | An absolutely positioned text div |
| `probe-countdown`, `probe-typewriter` | motion | dom | independent | Timer probes, draw only their own text |
| `probe-slow` | remotion | dom | independent | A probe card with adjustable cost (busy-waits `burnMs` milliseconds on every render), draws only its own color block (added to the registry on 2026-10-12) |
| `probe-slow-stepped` | motion | dom | independent | The frame-push version of the previous card, same way of drawing |
| `r6-stateful`, `r6-huge` | motion | dom | independent | Draws only itself |
| `r6-canvas` | motion | canvas2d | independent | Its own 2D canvas |
| `r6-unknown` | motion | dom | `unknown` | Deliberately not reviewed: the probe needs "a card that has not been reviewed" |
| `probe-css`, `probe-motion-js` | motion | dom | `unknown` | Deliberately not reviewed: these two need to take the path of "handled as a below-dependent card, live-rendered if classified as light" |

## 6. Composite cards

`composite` is registered as `fromParts` in the table: axis 3 is derived from the part tree, and the most conservative one wins
(conservativeness: `independent` < `sourceDependent` < `belowDependent` < `context` < `unknown`).
Implementation: `derivedCompositing(parts)` in `frameMode.mjs` plus `DERIVED_FROM_PARTS`. Registering it in the table does not change the derivation: `fromParts` is not a review conclusion, and `cardCapabilities` still goes through derivation as before.

The derivation takes the **card id a part comes from** (`PartDef.from`).
But what `clip.parts` stores is `PartInstance.partId` (the part id), and converting it into a card id requires looking up the part registry
(`src/kernel/partRegistry.ts`, which only `.tsx` files on the browser side can load). `cardGraph.mjs` runs on both ends,
**it cannot be found on one end and not on the other**, otherwise the identity digest would fork between the browser and Node.
So `cardGraph.mjs` just passes `clip.parts` in as is, and a part whose card id cannot be resolved counts as `unknown`:

- A composite card without parts (only placeholder text) is `independent`;
- A composite card with parts is `unknown`, to be tightened once the part registry is wired to both ends.

`surface` is registered as `dom`: composite cards are now never treated as canvas cards, even if a part contains a canvas.

If a case really shows up where "the table says independent but there is actually frosted glass", the runtime fallback in section 7 catches it.

## 7. Runtime fallback

`src/render/capabilityGuard.ts` scans the computed styles of the subtree after a card is mounted,
and if it measures `backdrop-filter !== 'none'` while the table says `independent`, it runs `console.warn` and calls
`degradeCard(id)`. `cardCapabilities` reads this downgrade table and treats the card as `belowDependent` for the rest of this session.
It runs only in dev mode and when the URL has none of `export=` / `frames=` / `bake=`;
Each card is measured only once. On the export, prerender and generate snapshots path, not a single `getComputedStyle` runs, so the pixel-by-pixel baseline is unaffected.

## 8. Cards that are not in this table

**Cards created by users, cards embedded in a project.** This table ships with the repository and cannot be rewritten by a project on any one machine. Their writing style is taken from the declaration in the source code;
whether they depend on the lower layer is always treated as `unknown`, which is more conservative than a reviewed conclusion: it never draws wrong, it just stays out of the shared cache. Syncing review results along with the source code is a separate dedicated item in `docs/plan/TODO.md`.

**Parts (`src/parts/lib/*`)** are not card definitions and do not go into this table; their axis 3 is carried over from the card they come from through the derivation in section 6.

## 9. When adding or changing a built-in card

1. Add an entry in `capabilities.json` with all three items filled in (do not write `canvasHeavy`). A media wrapper card whose id falls under an existing wildcard does not need one.
2. Fill in `writing` according to the card's declaration. If the card's declaration is changed later, change the table along with it.
3. `compositing` needs a review conclusion: review it by the criteria in section 5 and write the reason into this document's card-by-card tables.
4. Run the gatekeeper test `node --test src/cards/capabilities.test.mjs`. It goes red if a card is not registered, if the three items are incomplete, if the writing style does not match the declaration, if what it is drawn on conflicts with the card's declaration, if `frameMode` or `canvasHeavy` is written in the table, or if the table has a key that matches no card.
5. If you changed an existing card's `compositing` or whether it is a canvas card, run the comparison script from section 2 and write into the report which cards' keys changed.
