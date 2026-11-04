/**
 * PromptCut: scan licenses of each wheel in extension packages.
 *
 * Why it is needed: extension packages ship dozens of wheels to users (measured at 34 in the "full" tier),
 * most of which are transitive dependencies pulled in by pip that no one has reviewed individually.
 * If a GPL/AGPL/SSPL or CC-BY-NC package slips in, we are distributing without a license: and doing so
 * in an exe that installs on double-click. The pre-distribution checklist in THIRD-PARTY-LICENSES.md
 * includes "Verify licenses of wheels in extension packages"; this script executes that checklist item,
 * eliminating the need to manually inspect 34 METADATA files.
 *
 * Where data comes from: reads the wheels field from manifests (ext-<name>-<version>.json) dropped under
 * release/extensions/ during packaging to obtain "package_name==version", then queries PyPI's JSON API
 * individually for license_expression / license / classifiers. It inspects **release metadata**,
 * not the LICENSE text inside the wheel: metadata is enough to spot "there is a GPL here", but questionable
 * ones still require opening the wheel to check METADATA; the script flags suspicious lines for manual inspection.
 *
 * Usage (scans all manifests under release/extensions without arguments):
 *   node desktop/scripts/scan-wheel-licenses.mjs
 *   node desktop/scripts/scan-wheel-licenses.mjs <manifest.json> [<manifest.json> …]
 *   node desktop/scripts/scan-wheel-licenses.mjs --json      # Machine-readable, for CI
 *
 * Exit codes: 0 = nothing suspicious; 1 = suspicious entries or lookup failures (requires human review).
 * Requires network access (API via pypi.org).
 *
 * Originally a one-off script from the 2026-09-07 license verification round, solidified here to avoid
 * rewriting from scratch next time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const EXT_DIR = path.join(DESKTOP_DIR, "release", "extensions");

/**
 * Licenses that cannot be shipped with packages. A hit is a red flag: either swap dependencies,
 * or this package cannot be shipped.
 * Note that LGPL is also included: under static/bundled distribution, its obligations are not much
 * lighter than GPL, so it is better singled out for manual review.
 * MPL-2.0 is **not** here: it is a file-level copyleft, so shipping with packages is permitted as long
 * as source acquisition methods are provided (certifi / tqdm belong to this class, see
 * THIRD-PARTY-LICENSES.md Section 9).
 */
const BAD = /\b(GPL|GPLv2|GPLv3|AGPL|LGPL|non-?commercial|NonCommercial|CC[- ]BY[- ]NC|SSPL|proprietary|EUPL)\b/i;

/** wheel filename → { name, version }. PEP 427: <name>-<version>-<python tag>-… */
export function parseWheelName(file) {
  const parts = path.basename(file, ".whl").split("-");
  if (parts.length < 2) return null;
  // Underscores in package names are hyphens on PyPI (typing_extensions → typing-extensions)
  return { name: parts[0].replace(/_/g, "-").toLowerCase(), version: parts[1] };
}

/**
 * Merges multiple manifests into "package==version → { name, version, tiers }".
 * Keys include the version: the same package may be at different versions in different extensions
 * (in testing, tokenizers is 0.23.2 in stt and 0.22.2 in full), and licenses may also vary with
 * the version; checking separately by version prevents mix-ups.
 */
export function collectWheels(manifests) {
  const out = new Map();
  for (const { label, wheels } of manifests) {
    for (const w of wheels || []) {
      const parsed = parseWheelName(w);
      if (!parsed) continue;
      const key = `${parsed.name}==${parsed.version}`;
      const cur = out.get(key);
      if (cur) {
        if (!cur.tiers.includes(label)) cur.tiers.push(label);
      } else {
        out.set(key, { name: parsed.name, version: parsed.version, tiers: [label] });
      }
    }
  }
  return out;
}

/** Line check: flagged as suspicious if BAD appears in license expression or classifiers */
export function isSuspicious(row) {
  return row.license === "(not found)" || BAD.test(row.license) || BAD.test(row.classifiers);
}

async function fetchLicense(name, version) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { license: "(not found)", classifiers: `HTTP ${res.status}` };
    const info = (await res.json()).info || {};
    // license_expression is a new field in PEP 639, more reliable than free-text license; check
    // classifiers if neither is present
    let license = info.license_expression || info.license || "";
    if (license.length > 120) license = `${license.slice(0, 120).replace(/\s+/g, " ")}…`;
    const classifiers = (info.classifiers || []).filter((c) => c.startsWith("License")).join(" | ");
    return { license: license.replace(/\s+/g, " ").trim() || "(empty)", classifiers };
  } catch (e) {
    return { license: "(not found)", classifiers: String(e.message || e) };
  }
}

/** Finds all manifests under release/extensions (two tiers in _light/_full, standalone packages flat) */
function findManifests(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findManifests(full));
    else if (/^ext-.+\.json$/.test(ent.name)) out.push(full);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const given = argv.filter((a) => !a.startsWith("-"));
  const files = given.length ? given : findManifests(EXT_DIR);

  if (!files.length) {
    console.error(`[FAIL] No manifest found. Build an extension package first (node desktop/scripts/make-extension.mjs light …),`
      + `or pass the path of an ext-*.json as an argument. Locations searched: ${EXT_DIR}`);
    process.exit(1);
  }

  const manifests = files.map((f) => {
    const m = JSON.parse(fs.readFileSync(f, "utf-8"));
    return { label: m.tier || m.name, wheels: m.wheels, file: f };
  });
  if (!asJson) {
    for (const m of manifests) console.log(`manifest: ${m.file} (${m.label}, ${(m.wheels || []).length} wheels)`);
    console.log("");
  }

  const wheels = collectWheels(manifests);
  const rows = [];
  for (const info of wheels.values()) {
    const lic = await fetchLicense(info.name, info.version);
    rows.push({ name: info.name, version: info.version, tiers: info.tiers, ...lic });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const r of rows) r.suspicious = isSuspicious(r);

  const flagged = rows.filter((r) => r.suspicious);
  if (asJson) {
    console.log(JSON.stringify({ scannedAt: new Date().toISOString(), files, rows }, null, 2));
  } else {
    for (const r of rows) {
      console.log(`${r.suspicious ? "!!" : "  "} ${r.name}==${r.version}  [${r.tiers.join(",")}]`);
      console.log(`     license: ${r.license}`);
      if (r.classifiers) console.log(`     classifiers: ${r.classifiers}`);
    }
    console.log(`\n${rows.length} packages in total, ${flagged.length} suspicious.`);
    if (flagged.length) {
      console.log("Open each suspicious wheel and check METADATA / LICENSE before deciding; if it is confirmed OK to ship,"
        + "state the reason in section 9 of desktop/THIRD-PARTY-LICENSES.md.");
    } else {
      console.log("No packages with GPL / AGPL / LGPL / SSPL / non-commercial licenses."
        + " MPL-2.0 (certifi, tqdm) is not suspicious, but MPL §3.2 requires telling users how to get the source; this is already written in THIRD-PARTY-LICENSES.txt inside the package.");
    }
  }
  process.exit(flagged.length ? 1 : 0);
}

// Do not run main flow when imported (tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
