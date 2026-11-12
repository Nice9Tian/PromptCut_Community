/**
 * Generates offline static table of preview bounding boxes for cards / parts → src/cards/preview-boxes.json
 *
 *   node scripts/preview-boxes.mjs                # Spin up its own vite (port 5198) before measuring
 *   node scripts/preview-boxes.mjs --url http://127.0.0.1:5190   # Use an existing dev server
 *   node scripts/preview-boxes.mjs --out src/cards/preview-boxes.json --timeout 900
 *
 * What it does: opens an invisible editor page and lets background prewarming in the page
 * (src/editor/left/prewarmBoxes.tsx) render each card and part offscreen, measuring the maximum
 * bounding box across the entire motion graphics sequence, then exports the results to JSON.
 * The measurement method **shares the exact same code** as the hover path, so conclusions from
 * the static table match on-the-fly measurements, without making the user wait.
 *
 * The table is shipped with the package so the user's first hover is instant; items not in the table
 * (cards created on the fly by user / AI) are measured on the fly as usual. If card default
 * parameters or animations change, simply rerun this script.
 */
import './lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(ROOT, arg("out", path.join("src", "cards", "preview-boxes.json")));
const PORT = Number(arg("port", "5198"));
const TIMEOUT_S = Number(arg("timeout", "900"));
let url = arg("url", "");

const log = (...a) => console.log("[preview-boxes]", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(target, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target);
      if (res.ok) return true;
    } catch {
      // Not up yet
    }
    await wait(300);
  }
  throw new Error(`timed out waiting for ${target}`);
}

let vite = null;
async function startVite() {
  const bin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  vite = spawn(process.execPath, [bin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  const target = `http://127.0.0.1:${PORT}/`;
  await waitHttp(target, 90000);
  log(`vite ready ${target}`);
  return target;
}

function stopVite() {
  if (!vite) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else vite.kill("SIGTERM");
  } catch {
    // Best if the process exited on its own
  }
  vite = null;
}

/** Enters the editor (clicks "Start creating" on start page), and waits for preview modules to load */
async function enterEditor(page) {
  await page.waitForFunction(
    () => !!document.querySelector('[data-pc="editor"]') || [...document.querySelectorAll("*")].some((e) => e.childElementCount === 0 && e.textContent.trim() === "Start creating"),
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    if (document.querySelector('[data-pc="editor"]')) return;
    const el = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "Start creating");
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      if (n.tagName === "BUTTON" || n.getAttribute("role") === "button" || n.onclick) break;
      n = n.parentElement;
    }
    (n || el)?.click();
  });
  await page.waitForFunction(
    () => !!document.querySelector('[data-pc="editor"]') || !!document.querySelector('[data-pc="new-project-local-confirm"]'),
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    document.querySelector('[data-pc="new-project-local-confirm"]')?.click();
  });
  await page.waitForFunction(() => !!window.__pcPreviewBoxes, { timeout: 60000 });
}

/** Triggers a pass: force = re-measure entries already in static table (otherwise rerunning empties table); measured items still skipped */
async function arm(page) {
  await enterEditor(page);
  return page.evaluate(() => {
    window.__pcPreviewBoxes.start(true);
    return window.__pcPreviewBoxes.pending;
  });
}

/** How many cards remain; returns -1 if the page is reloading or modules have not loaded yet */
async function peek(page) {
  try {
    return await page.evaluate(() => (window.__pcPreviewBoxes ? window.__pcPreviewBoxes.pending : -1));
  } catch {
    return -1;
  }
}

async function main() {
  if (!url) url = await startVite();

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300000,
    args: ["--window-position=-32000,-32000", "--hide-scrollbars", "--no-first-run", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    // Measure stage at 1920×1080 with ample viewport so layout is not distorted
    await page.setViewport({ width: 1600, height: 1000 });
    page.on("pageerror", (e) => log("Page error:", String(e).slice(0, 200)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const total = await arm(page);
    log(`Start measuring ${total} cards`);

    const deadline = Date.now() + TIMEOUT_S * 1000;
    let last = -1;
    let pending = total;
    while (Date.now() < deadline) {
      pending = await peek(page);
      if (pending < 0) {
        // The page reloaded (another session in the shared workspace modified a file, so vite refreshed the page).
        // Measured data is in localStorage; re-enter the editor and resume measuring.
        log("Page reloaded, resuming measurement");
        await wait(1000);
        pending = await arm(page);
        continue;
      }
      if (pending !== last) {
        last = pending;
        if (pending % 10 === 0) log(`${pending} left`);
      }
      if (pending === 0) break;
      await wait(500);
    }
    if (pending > 0) log(`Timed out, ${pending} cards not measured yet, writing out what was measured`);

    const data = await page.evaluate(() => window.__pcPreviewBoxes.dump());
    const keys = Object.keys(data.boxes ?? {});
    if (keys.length === 0) throw new Error("No cards were measured, not overwriting the existing table");
    keys.sort();
    // rev: stamp for this table version; local cache on the page relies on it to invalidate old
    // results (previewBoxes.ts)
    const sorted = { rev: Date.now(), stage: data.stage, boxes: {} };
    for (const k of keys) sorted.boxes[k] = data.boxes[k];
    fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    const tight = keys.filter((k) => sorted.boxes[k]).length;
    log(`Wrote ${path.relative(ROOT, OUT)}: ${keys.length} cards, ${tight} can zoom in, ${keys.length - tight} already fill the whole frame`);
  } finally {
    await browser.close().catch(() => {});
    stopVite();
  }
}

main().catch((e) => {
  console.error("[preview-boxes] failed:", e);
  stopVite();
  process.exit(1);
});
