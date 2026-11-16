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

## Interface text

The interface comes in English, Simplified Chinese and Japanese, and English is the source language.

- Write interface text in English and show it through `tr()` from `src/i18n/index.ts`. `{0}`, `{1}` mark values that are filled in.
- Add the Chinese and Japanese of every new string to `src/i18n/table.json`.
- `src/i18n/interface-text.test.mjs` fails when interface code contains Chinese or Japanese. Where a Chinese literal is data rather than text (a protocol token, a marker older projects carry, words matched in user content), keep it and put an `i18n-allow:` comment with the reason on the line above.
- Text drawn into a rendered frame never goes through `tr()`: a project must render the same pixels whatever the interface language.

## What to run before you submit

```bash
npx tsc -b                      # type check, must be clean
npm test                        # full unit suite, must be green (~3 minutes)
npm test src/your/thing.test.mjs  # or just part of it
```

If your PR touches anything visual (rendering, cards, preview, export), **include before/after screenshots or exported frames** in the description. Rendering in this project has determinism requirements that you cannot judge from the diff alone.

`scripts/probes/` holds per-feature probes — small end-to-end programs that drive a real browser. When you change a feature, run its probe and paste the output into the PR.

## Developing on Linux

The project was written on Windows, and CI ran only there until recently. `npm run build` and the test suite also run on Linux; the list below is what a Linux machine needs that a Windows one does not. It was checked on Ubuntu 26.04 with Node 24. Linux problems that are still open are in the issue tracker (search for "Linux"), and the `test-linux` job in `.github/workflows/test.yml` shows the current state.

**ffmpeg** has to be on `PATH` (`sudo apt install ffmpeg`). Export and the audio tools use it, and so do the tests for them.

**Chrome's sandbox (Ubuntu 23.10 and later).** Ubuntu only lets programs that have an AppArmor profile create unprivileged user namespaces, which Chrome's sandbox needs. It ships a profile for Google Chrome, but not for the Chrome that puppeteer downloads during `npm ci`, so that Chrome dies with `No usable sandbox!`. Give it the same profile Ubuntu gives its own:

```bash
cache="${PUPPETEER_CACHE_DIR:-$HOME/.cache/puppeteer}"
sed -e "s|^profile chrome [^ ]* |profile chrome-puppeteer $cache/{chrome,chrome-headless-shell}/linux-*/chrome{,-headless-shell}-linux64/{chrome,chrome-headless-shell} |" \
    -e 's|<local/chrome>|<local/chrome-puppeteer>|' /etc/apparmor.d/chrome | sudo tee /etc/apparmor.d/chrome-puppeteer
sudo apparmor_parser -r /etc/apparmor.d/chrome-puppeteer
```

The profile is tied to a path. With the default cache that path is in your home directory, so anything copied there may create user namespaces too. If that matters on your machine, keep the browsers in a directory only root can write (`PUPPETEER_CACHE_DIR`) and point the profile at it. `PROMPTCUT_CHROME_NO_SANDBOX=1` starts Chrome without its sandbox instead; treat it as a last resort.

**No display.** The assistant's web browser (`server/web/browser.mjs`) opens a real Chrome window, so on a machine without a desktop session start the dev server under a virtual display: `xvfb-run -a npm run dev`. The test suite does not need one.

**Python.** Speech-to-text, media collect, and shot, subject and motion detection run on Python. There is no bundled interpreter on Linux, so make a virtual environment and tell the dev server where it is:

```bash
python3 -m venv python/.venv
# Make the packages in python/ importable from the environment. Speech-to-text starts Python with -I,
# which ignores PYTHONPATH, so a .pth file is what makes them visible.
python/.venv/bin/python -c "import pathlib, sysconfig; pathlib.Path(sysconfig.get_paths()['purelib'], 'promptcut-src.pth').write_text(str(pathlib.Path('python').resolve()) + '\n')"
export PROMPTCUT_PYTHON="$PWD/python/.venv/bin/python3"
```

On Debian and Ubuntu `python3 -m venv` needs the `python3-venv` package. This does not install the heavy libraries. Speech-to-text and media collect install theirs (whisper, yt-dlp) into `out/pylibs` from their own panels.

**The dev port.** `npm run dev` listens on 5190 and refuses to start if it is taken. For a second checkout on the same machine, start vite yourself on another port: `npx vite --port 5191 --strictPort --host 0.0.0.0`.

**AI command-line tools.** One-click install in the AI service panel works on Linux and macOS as well: it runs each vendor's official shell installer. Claude Code lands in `~/.local/bin`; Codex and Antigravity go into the app's own directory, `~/promptcut/cli`. Tools you installed yourself are found on `PATH` or in `~/.local/bin`.

## Submitting

- **One PR, one thing.** Split drive-by refactors into their own PR.
- **Write in English.** Pull requests, issues and commit messages are in English: titles, descriptions and comments alike (from 2026-11-13; earlier history stays as it is).
- **Say what changed and why** in the commit message. Subjects take the form `<type>: <what was done>`; the types are listed in [docs/semantics/guide_files/git_and_release.md](docs/semantics/guide_files/git_and_release.md).
- **Sign off (DCO):** every commit needs a `Signed-off-by` line; `git commit -s` adds it. It states that you have the right to contribute that code under MIT. There is no CLA and nothing else to sign.
- **Match the surrounding code**: comment density, naming, idiom. This repository comments much more heavily than most, and the comments are part of the real documentation — please write new code to the same density.

## Licensing

Your contribution is licensed under [MIT](LICENSE). That means it also goes into the closed commercial edition, which inherits this code (MIT permits this; your attribution is kept). Opening a PR means you agree to that.
