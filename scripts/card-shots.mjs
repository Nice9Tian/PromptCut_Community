/**
 * Prerenders a freeze frame for each clip on the timeline → out/card-shots/NN-<cardId>.png,
 * then stitches an overview image.
 *
 *   node scripts/card-shots.mjs                       # starts its own vite (port 5245, no global port.json)
 *   node scripts/card-shots.mjs --url http://127.0.0.1:5190   # uses an existing dev server
 *   node scripts/card-shots.mjs --at 0.75 --bg "#0b0e14"
 *
 * Difference from server/bakery/: that side requires frame-by-frame determinism, while here we
 * only need to "see what each card looks like", so instead of using virtual time, it uses the
 * page's own export clock (__pcSetT + __pcSyncAnims) to walk to the target time in fixed steps.
 *
 * Why "walk" instead of jumping in one step: __pcSyncAnims pins each Web Animation currentTime to
 * "current export ms - export ms of the frame where it first appeared". Jumping straight to the
 * middle of a card means the animation is first seen on that frame, making that moment the anchor
 * and target constantly 0: the captured image would always be the first frame of the entrance.
 * So mounting from clip.start and stepping forward to the target time allows entrance animations
 * to complete.
 *
 * The export page sets a transparent background (for compositing); viewing freeze frames directly
 * would show a transparent backdrop, so a --bg layer is applied to the root element before capture.
 */
import './lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(ROOT, arg("out", path.join("out", "card-shots")));
// 5199 was previously assigned to dev servers of other sessions; pick an unused one
const PORT = Number(arg("port", "5245"));
/** Relative position in clip (0~1); entrance animations usually finish in 1s, 0.75 is steady state */
const AT = Number(arg("at", "0.75"));
/** Step size to target time (seconds). Too large and Motion JS animations skip, too small is just slow */
const STEP = Number(arg("step", String(1 / 15)));
const BG = arg("bg", "#0b0e14");
// If unspecified, use puppeteer's bundled Chrome (previously hardcoded to the cloud Linux sandbox
// path, which fails to launch locally)
const CHROME = process.env.PC_CHROME_PATH || undefined;

const log = (...a) => console.log("[card-shots]", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(target, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(target)).ok) return;
    } catch {
      // Not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${target}`);
    await wait(300);
  }
}

let vite = null;
async function startVite() {
  const bin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  /*
   * Point TEMP / TMP to a separate directory before launching: as soon as the dev server starts, it
   * writes its port to %TEMP%\promptcut\port.json, and MCP clients without an explicit port connect
   * to it: without isolation, taking screenshots once would misdirect the AI connection of the
   * editor the user is actively using (see item 8 of docs/guides/compare-pitfalls.md).
   */
  const tmp = path.join(os.tmpdir(), "promptcut-card-shots");
  await fs.mkdir(tmp, { recursive: true });
  vite = spawn(process.execPath, [bin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
    env: { ...process.env, TEMP: tmp, TMP: tmp },
  });
  const target = `http://127.0.0.1:${PORT}/`;
  await waitHttp(target, 90000);
  log(`vite ready ${target}`);
  return target;
}

async function main() {
  let base = arg("url", "");
  if (!base) base = await startVite();
  base = base.replace(/\/$/, "");

  await fs.mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--font-render-hinting=none",
      // WebGL uses software rasterization (three.js cards like terminal-3d render an empty canvas
      // without it, with no errors raised)
      "--enable-unsafe-swiftshader",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto(`${base}/?export=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__pcReady === true, { timeout: 60000, polling: 100 });

  const timeline = await page.evaluate(() => window.__pcTimeline);
  log(`timeline ${timeline.width}x${timeline.height} ${timeline.duration}s, ${timeline.clips.length} clips`);

  const shots = [];
  for (const [i, clip] of timeline.clips.entries()) {
    const target = clip.start + (clip.end - clip.start) * AT;
    const before = errors.length;

    // Remount from the clip start, then step forward to target time (see file header for rationale)
    await page.evaluate(
      async (start, end, step, bg) => {
        document.documentElement.style.background = bg;
        window.__pcResetAnims?.();
        window.__pcSetT(start);
        window.__pcRestartCards?.();
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
        for (let t = start; t <= end + 1e-6; t += step) {
          window.__pcSetT(Math.min(t, end));
          await raf();
          window.__pcSyncAnims?.();
        }
      },
      clip.start,
      target,
      STEP,
      BG,
    );
    await page.evaluate(() => window.__pcFrameReady?.());

    const name = `${String(i).padStart(2, "0")}-${clip.cardId}.png`;
    const file = path.join(OUT, name);
    await page.screenshot({ path: file, omitBackground: false });
    const size = (await fs.stat(file)).size;
    shots.push({ name, file, clip, target, size });
    const bad = errors.slice(before);
    log(`${name}  t=${target.toFixed(2)}s  ${(size / 1024).toFixed(0)}KB${bad.length ? `  ⚠ ${bad.length} errors` : ""}`);
    for (const e of bad) log(`    ${e.slice(0, 160)}`);
  }

  // Overview image: fit all 26 images into a grid and screenshot once more
  const rows = await Promise.all(
    shots.map(async (s) => ({
      title: `${s.clip.cardId}  ·  ${s.clip.start}–${s.clip.end}s`,
      data: `data:image/png;base64,${(await fs.readFile(s.file)).toString("base64")}`,
    })),
  );
  const cols = 4;
  const cell = 440;
  const sheet = await browser.newPage();
  await sheet.setViewport({ width: cols * cell + 40, height: 100 });
  await sheet.setContent(`<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;padding:20px;background:#05070b;font:13px ui-sans-serif,system-ui,"Noto Sans CJK SC",sans-serif;color:#cbd5e1}
  .g{display:grid;grid-template-columns:repeat(${cols},${cell - 12}px);gap:12px}
  figure{margin:0}
  img{width:100%;display:block;border:1px solid #1e293b;border-radius:6px;background:${BG}}
  figcaption{padding:6px 2px 0;font-size:12px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>
<div class="g">${rows
    .map((r) => `<figure><img src="${r.data}"><figcaption>${r.title}</figcaption></figure>`)
    .join("")}</div>`);
  await sheet.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode())));
  const sheetFile = path.join(OUT, "_contact-sheet.png");
  await sheet.screenshot({ path: sheetFile, fullPage: true });
  log(`contact sheet ${sheetFile}`);

  await browser.close();
  vite?.kill();
  log(`done: ${shots.length} shots, ${errors.length} page errors in total`);
}

main().catch(async (e) => {
  console.error(e);
  vite?.kill();
  process.exit(1);
});
