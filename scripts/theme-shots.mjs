import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const outDir = path.join(process.cwd(), 'out', 'themes');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });

  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[Browser Console Error] ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.log(`[Browser PageError] ${err.toString()}`);
  });

  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    if (/\/src\/editor\/right\/Ai\w*\.tsx/.test(u)) {
      try {
        const res = await fetch(u);
        if (res.ok) return req.continue();
      } catch {}
      const name = u.includes("AiSetupDialog") ? "AiSetupDialog" : "AiPanel";
      return req.respond({
        status: 200,
        contentType: "application/javascript",
        body: `export function ${name}(){return null}\nexport default ${name};`,
      });
    }
    req.continue();
  });

  try {
    await page.goto("http://127.0.0.1:5201/", { waitUntil: "networkidle2" });
  } catch (e) {
    console.log(`Goto caught: ${e.message}`);
  }

  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => {
    const overlay = document.querySelector('vite-error-overlay');
    if (overlay) overlay.remove();
  });

  const rootHtml = await page.evaluate(() => document.querySelector('#root')?.innerHTML);
  if (!rootHtml) {
    console.error("Error: #root is empty");
    process.exit(1);
  }

  await page.evaluate(async () => {
    const m = await import("/src/store/project.ts");
    m.actions.newProject();
    const ids = [
      "blur-text", "checklist", "odometer", "ring-metric", "step-timeline",
      "mu-number-ticker", "mu-blur-fade", "mu-circular-progress", "mu-typing", "mu-word-rotate",
    ];
    ids.forEach((id, i) => m.actions.addCardClip(id, i * 2, { duration: 2 }));
    m.actions.setProjectMeta({ duration: 20 });
  });

  await new Promise(r => setTimeout(r, 1000));

  const numClips = await page.evaluate(() => {
    return (async () => {
      const m = await import("/src/store/project.ts");
      let count = 0;
      for (const track of m.getState().project.tracks) {
        count += track.clips.length;
      }
      return count;
    })();
  });

  console.log(`Number of clips added: ${numClips}`);

  const themes = ["midnight", "ivory", "neon", "sunrise", "forest"];
  const timestamps = [1, 5, 11, 15];

  for (const themeId of themes) {
    await page.evaluate((tid) => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const hasOption = Array.from(sel.options).some(opt => opt.value === tid);
        if (hasOption) {
          sel.value = tid;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, themeId);
    
    await new Promise(r => setTimeout(r, 500));

    const accentColor = await page.evaluate(() => {
      const root = document.querySelector('.pc-stage') || document.body;
      return getComputedStyle(root).getPropertyValue('--pc-accent').trim();
    });
    console.log(`Theme ${themeId}: --pc-accent is ${accentColor}`);

    for (const t of timestamps) {
      await page.evaluate(async (time) => {
        const m = await import("/src/store/project.ts");
        m.actions.seek(time);
        
        // dismiss modal if present
        document.querySelectorAll('button').forEach(b => {
          if(b.textContent.includes('以后再说')) b.click();
        });
      }, t);
      
      await new Promise(r => setTimeout(r, 2200));
      
      const p = path.join(outDir, `${themeId}-${t}.png`);
      await page.screenshot({ path: p, fullPage: false });
      console.log(`Saved screenshot ${p}`);
    }
  }

  await browser.close();
})();
