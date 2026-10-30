/**
 * 给时间轴上的每一个 clip 各预渲染一张定格图 → out/card-shots/NN-<cardId>.png,再拼一张总览图。
 *
 *   node scripts/card-shots.mjs                       # 自己起一份 vite(端口 5245,不写全局 port.json)
 *   node scripts/card-shots.mjs --url http://127.0.0.1:5190   # 用现成的开发服务器
 *   node scripts/card-shots.mjs --at 0.75 --bg "#0b0e14"
 *
 * 和 server/bakery/ 的区别:那边要逐帧确定性,这边只要「看一眼每张卡长什么样」,
 * 所以不上虚拟时间,而是用页面自己的导出钟(__pcSetT + __pcSyncAnims)按固定步长走到目标时刻。
 *
 * 为什么要"走"而不是一步跳过去:__pcSyncAnims 把每条 Web Animation 的 currentTime 钉到
 * 「当前导出毫秒 − 它首次出现那一帧的导出毫秒」。直接跳到卡片中段的话,动画在那一帧才第一次
 * 被看见,锚点就是当刻,target 恒为 0 —— 截出来永远是入场第一帧。所以从 clip.start 挂载,
 * 再按步长推到目标时刻,入场动画才走得完。
 *
 * 导出页把背景设成透明(合成用),定格图直接看会是一张透明底,所以截图前给根元素铺一层 --bg。
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
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
// 5199 以前分给过别的会话的 dev server;挑一个没人用的
const PORT = Number(arg("port", "5245"));
/** 取 clip 内的相对位置(0~1);入场动画一般 1 秒内走完,0.75 处基本都是稳态 */
const AT = Number(arg("at", "0.75"));
/** 走到目标时刻的步长(秒)。步子太大 Motion 的 JS 动画会跳,太小纯粹是慢 */
const STEP = Number(arg("step", String(1 / 15)));
const BG = arg("bg", "#0b0e14");
// 不指定就用 puppeteer 自带的 Chrome(原来写死的是云端 Linux 沙箱的路径,本机上起不来)
const CHROME = process.env.PC_CHROME_PATH || undefined;

const log = (...a) => console.log("[card-shots]", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(target, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(target)).ok) return;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error(`等不到 ${target}`);
    await wait(300);
  }
}

let vite = null;
async function startVite() {
  const bin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  /*
   * TEMP / TMP 指到一个单独的目录再起:dev server 一起来就把自己的端口写进 %TEMP%\promptcut\port.json,
   * 没指定端口的 MCP 客户端照它去连 —— 不隔开的话,跑一次截图就把用户正在用的编辑台的 AI 连接指歪了
   * (见 docs/guides/compare-pitfalls.md 第 8 条)。
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
  log(`vite 就绪 ${target}`);
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
      // WebGL 走软件光栅(terminal-3d 那类 three.js 卡片没它会渲成空画布,而且不报错)
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
  log(`时间轴 ${timeline.width}x${timeline.height} ${timeline.duration}s,共 ${timeline.clips.length} 个 clip`);

  const shots = [];
  for (const [i, clip] of timeline.clips.entries()) {
    const target = clip.start + (clip.end - clip.start) * AT;
    const before = errors.length;

    // 从 clip 起点重新挂载,再一步步推到目标时刻(理由见文件头)
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
    log(`${name}  t=${target.toFixed(2)}s  ${(size / 1024).toFixed(0)}KB${bad.length ? `  ⚠ ${bad.length} 个报错` : ""}`);
    for (const e of bad) log(`    ${e.slice(0, 160)}`);
  }

  // 总览图:把 26 张塞进一个网格再截一次
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
  log(`总览图 ${sheetFile}`);

  await browser.close();
  vite?.kill();
  log(`完成:${shots.length} 张,共 ${errors.length} 条页面报错`);
}

main().catch(async (e) => {
  console.error(e);
  vite?.kill();
  process.exit(1);
});
