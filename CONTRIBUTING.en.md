# Contributing to PromptCut Community

Issues and pull requests are welcome. This file covers three things: **semantics come first**, **which areas accept PRs right now**, and **what to run before you submit**.

中文： [CONTRIBUTING.md](CONTRIBUTING.md)。

## Read the semantics first

`docs/semantics/` is this project's contract, not background reading: **where the semantics and the code disagree, the semantics win.** The documents are in Chinese.

- Use the table in [docs/semantics/README.md](docs/semantics/README.md) to find which documents govern your change. You do not need to read all of them.
- The hard constraints you must respect are in [docs/semantics/guide_files/constraints.md](docs/semantics/guide_files/constraints.md). The one people trip over most is **layering**: `kernel ← render ← editor / mcp / ai`. Lower layers never import upper ones, and a gatekeeper test enforces it.
- How to verify, and which checks a given change must run, is in [docs/semantics/guide_files/verification.md](docs/semantics/guide_files/verification.md).

If your change requires the semantics themselves to change, **open an issue and settle that first** — don't edit the semantics documents as a side effect of a PR.

## Which areas accept PRs right now

This repository is upstream: the closed commercial edition and the Lite edition both inherit its code, so changes merged into `main` carry over. All the areas below take PRs.

| Area | Status |
|---|---|
| `src/kernel/`, `src/render/`, `src/store/`, `src/parts/` | PRs welcome |
| `src/cards/`, `server/catalog/` (cards and the built-in library) | PRs welcome — **easiest place to start** |
| `src/skins/`, `src/themes/`, `src/ui/` | PRs welcome |
| `src/mcp/`, `src/voice/` | PRs welcome |
| `server/bakery/`, `server/harness/`, `server/runners/`, `server/vision/`, `server/voice/`, `server/render-queue/` | PRs welcome |
| `python/`, `scripts/`, `docs/` | PRs welcome |
| `src/editor/` (including `sync/` and `right/`), `src/start/`, `src/ai/` | PRs welcome |
| `src/online/`, `src/mobile/`, `server/auth/`, `server/lan/` (LAN sharing and the phone UI) | PRs welcome |
| `desktop/` | PRs welcome, but only Windows x64 is verified |

## What to run before you submit

```bash
npx tsc -b                      # type check, must be clean
npm test                        # full unit suite, must be green (~3 minutes)
npm test src/your/thing.test.mjs  # or just part of it
```

If your PR touches anything visual (rendering, cards, preview, export), **include before/after screenshots or exported frames** in the description. Rendering in this project has determinism requirements that you cannot judge from the diff alone.

`scripts/probes/` holds per-feature probes — small end-to-end programs that drive a real browser. When you change a feature, run its probe and paste the output into the PR.

## Submitting

- **One PR, one thing.** Split drive-by refactors into their own PR.
- **Say what changed and why** in the commit message. Chinese or English is fine.
- **Sign off (DCO):** every commit needs a `Signed-off-by` line; `git commit -s` adds it. It states that you have the right to contribute that code under MIT. There is no CLA and nothing else to sign.
- **Match the surrounding code**: comment density, naming, idiom. This repository comments much more heavily than most, and the comments are part of the real documentation — please write new code to the same density.

## Licensing

Your contribution is licensed under [MIT](LICENSE). That means it also goes into the closed commercial edition, which inherits this code (MIT permits this; your attribution is kept). Opening a PR means you agree to that.
