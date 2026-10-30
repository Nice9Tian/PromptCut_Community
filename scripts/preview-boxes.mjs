/**
 * 离线生成卡片 / 部件的预览包围盒静态表 → src/cards/preview-boxes.json
 *
 *   node scripts/preview-boxes.mjs                # 自己起一份 vite(端口 5198)再量
 *   node scripts/preview-boxes.mjs --url http://127.0.0.1:5190   # 用现成的开发服务器
 *   node scripts/preview-boxes.mjs --out src/cards/preview-boxes.json --timeout 900
 *
 * 做的事:开一个看不见的编辑器页面,让页面里的后台补量(src/editor/left/prewarmBoxes.tsx)
 * 把每张卡、每个部件在屏幕外渲染一遍、按动效整段量出最大包围盒,量完把结果导出来写成 JSON。
 * 量法和悬停时那条路**是同一份代码**,所以静态表和现场量的结论一致,只是不用用户等。
 *
 * 表随包发出去,用户第一次悬停就一步到位;表里没有的(用户 / AI 现场建的卡)照旧现场量。
 * 卡片改了默认参数、改了动画,重跑一次这个脚本即可。
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
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
      // 还没起来
    }
    await wait(300);
  }
  throw new Error(`等不到 ${target}`);
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
  log(`vite 就绪 ${target}`);
  return target;
}

function stopVite() {
  if (!vite) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(vite.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else vite.kill("SIGTERM");
  } catch {
    // 进程自己没了最好
  }
  vite = null;
}

/** 进编辑器(开始页就点「开始创作」),等预览那套模块加载出来 */
async function enterEditor(page) {
  await page.waitForFunction(
    () => !!document.querySelector('[data-pc="editor"]') || [...document.querySelectorAll("*")].some((e) => e.childElementCount === 0 && e.textContent.trim() === "开始创作"),
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    if (document.querySelector('[data-pc="editor"]')) return;
    const el = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "开始创作");
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      if (n.tagName === "BUTTON" || n.getAttribute("role") === "button" || n.onclick) break;
      n = n.parentElement;
    }
    (n || el)?.click();
  });
  await page.waitForFunction(() => !!window.__pcPreviewBoxes, { timeout: 60000 });
}

/** 催一遍:force = 静态表里已有的也重量(否则重跑这个脚本会把表越量越空);已经量到的仍跳过 */
async function arm(page) {
  await enterEditor(page);
  return page.evaluate(() => {
    window.__pcPreviewBoxes.start(true);
    return window.__pcPreviewBoxes.pending;
  });
}

/** 还剩几张;页面正在重载 / 模块还没加载就返回 -1 */
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
    // 舞台按 1920×1080 量,视口给够,免得布局被挤变形
    await page.setViewport({ width: 1600, height: 1000 });
    page.on("pageerror", (e) => log("页面报错:", String(e).slice(0, 200)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const total = await arm(page);
    log(`开始量 ${total} 张`);

    const deadline = Date.now() + TIMEOUT_S * 1000;
    let last = -1;
    let pending = total;
    while (Date.now() < deadline) {
      pending = await peek(page);
      if (pending < 0) {
        // 页面重载了(共享工作区里别的会话一改文件,vite 就把页面刷了)。
        // 量到的都在 localStorage 里,重新进编辑器接着量即可。
        log("页面重载了,接着量");
        await wait(1000);
        pending = await arm(page);
        continue;
      }
      if (pending !== last) {
        last = pending;
        if (pending % 10 === 0) log(`还剩 ${pending}`);
      }
      if (pending === 0) break;
      await wait(500);
    }
    if (pending > 0) log(`超时,还剩 ${pending} 张没量完,先把量到的写出去`);

    const data = await page.evaluate(() => window.__pcPreviewBoxes.dump());
    const keys = Object.keys(data.boxes ?? {});
    if (keys.length === 0) throw new Error("一张都没量到,不覆盖原来的表");
    keys.sort();
    // rev:这一版表的印记,页面上的本机缓存靠它作废旧结论(previewBoxes.ts)
    const sorted = { rev: Date.now(), stage: data.stage, boxes: {} };
    for (const k of keys) sorted.boxes[k] = data.boxes[k];
    fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    const tight = keys.filter((k) => sorted.boxes[k]).length;
    log(`写入 ${path.relative(ROOT, OUT)}:${keys.length} 张,其中 ${tight} 张能推近,${keys.length - tight} 张本来就铺满整幅`);
  } finally {
    await browser.close().catch(() => {});
    stopVite();
  }
}

main().catch((e) => {
  console.error("[preview-boxes] 失败:", e);
  stopVite();
  process.exit(1);
});
