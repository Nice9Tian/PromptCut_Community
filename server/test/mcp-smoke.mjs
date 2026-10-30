import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function callMcp(tool, args) {
  const res = await fetch('http://127.0.0.1:5195/api/mcp/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args })
  });
  if (!res.ok) {
    throw new Error(`MCP error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`MCP tool error: ${data.error}`);
  return data.result;
}

async function checkAuth() {
  console.log("\n--- Auth Probe ---");
  try {
    const res = await fetch('http://127.0.0.1:5195/api/ai/providers');
    if (!res.ok) {
      console.log("Failed to fetch providers");
      return;
    }
    const data = await res.json();
    if (!data.providers) return;
    for (const p of data.providers) {
       console.log(`Provider: ${p.id} (${p.label}) - Available: ${p.available}, Auth: ${p.auth ? (p.auth.loggedIn ? "Logged In" : "Not Logged In (" + p.auth.detail + ")") : "N/A"}`);
    }
  } catch(e) {
    console.log("Auth probe error:", e.message);
  }
}

async function main() {
  console.log("Waiting for Vite server to be up...");

  let serverUp = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5195/api/mcp/status');
      if (res.ok) {
        serverUp = true;
        break;
      }
    } catch {}
    await wait(1000);
  }

  if (!serverUp) {
    console.error("Vite server failed to start or /api/mcp/status not responding.");
    process.exit(1);
  }
  console.log("Vite server is up.");

  console.log("Launching puppeteer...");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('http://127.0.0.1:5195/', { waitUntil: 'networkidle2' });

  let editorConnected = false;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:5195/api/mcp/status');
      if (res.ok) {
        const data = await res.json();
        if (data.editorConnected) {
          editorConnected = true;
          break;
        }
      }
    } catch {}
    await wait(1000);
  }

  if (!editorConnected) {
    console.error("Editor failed to connect via MCP.");
    await browser.close();
    process.exit(1);
  }
  console.log("Editor connected.");


  try {
    console.log("Testing list_cards...");
    const cards = await callMcp('list_cards', {});
    console.log(`Got ${cards.length} cards.`);
    if (cards.length === 0) throw new Error("No cards returned");

    console.log("Testing get_project (before)...");
    let proj = await callMcp('get_project', {});
    let overlayTrack = proj.tracks[0];
    const initialClips = overlayTrack ? overlayTrack.clips.length : 0;
    console.log(`Initial overlay clips: ${initialClips}`);

    console.log("Testing add_clip...");
    const added = await callMcp('add_clip', { cardId: cards[0].id, start: 0, duration: 2 });
    console.log(`Added clip id: ${added.id}`);

    console.log("Testing get_project (after)...");
    proj = await callMcp('get_project', {});
    overlayTrack = proj.tracks.find(t => t.kind === "overlay");
    const newClips = overlayTrack ? overlayTrack.clips.length : 0;
    console.log(`New overlay clips: ${newClips}`);

    if (newClips !== initialClips + 1) {
      throw new Error(`Clip count did not increase by 1. Expected ${initialClips + 1}, got ${newClips}`);
    }

    await checkAuth();

    console.log("ALL PASS");
  } catch(e) {
    console.error("FAIL:", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
    setTimeout(() => process.exit(), 500);
  }
}

main();
