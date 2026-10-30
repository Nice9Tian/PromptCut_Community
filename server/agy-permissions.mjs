import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { tools } from './mcp-tools.mjs';

export function settingsPath() {
  if (process.env.PROMPTCUT_AGY_SETTINGS) {
    return process.env.PROMPTCUT_AGY_SETTINGS;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

export function desiredRules() {
  return tools.map(t => `mcp(promptcut/${t.name})`);
}

export function status() {
  const p = settingsPath();
  const rules = desiredRules();
  
  if (!fs.existsSync(p)) {
    return { path: p, total: rules.length, granted: [], missing: rules };
  }
  
  const content = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(content);
  
  const allow = (data.permissions && data.permissions.allow) ? data.permissions.allow : [];
  
  const granted = [];
  const missing = [];
  for (const rule of rules) {
    if (allow.includes(rule)) {
      granted.push(rule);
    } else {
      missing.push(rule);
    }
  }
  
  return { path: p, total: rules.length, granted, missing };
}

export function grant() {
  const p = settingsPath();
  const st = status();
  
  if (st.missing.length === 0) {
    return { path: p, added: [], total: st.total };
  }
  
  let data = {};
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf8');
    data = JSON.parse(content);
  }
  
  if (!data.permissions) {
    data.permissions = {};
  }
  if (!data.permissions.allow) {
    data.permissions.allow = [];
  }
  
  const allow = data.permissions.allow;
  const added = [];
  
  for (const rule of st.missing) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      added.push(rule);
    }
  }
  
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  
  return { path: p, added, total: st.total };
}
