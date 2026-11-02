/**
 * Sanitization of diagnostic reports. Run: node --test src/ai/debug.test.mjs
 *
 * This report **is uploaded** (when the user clicks "Submit", it goes directly into Cloudflare KV,
 * and pushes a message to Feishu). So what is pinned here is not "whether the code works as
 * expected", but a bottom line: **credentials must not leave the machine**.
 *
 * Two loopholes caught during 0.3.0 review are each guarded by a test case:
 *   - The key name regex originally had ^…$ anchors, matching none of the real request headers
 *     like `x-api-key` / `anthropic-api-key`;
 *   - The query string only listed four fixed parameter names, missing the most common bare
 *     `token=`.
 * At the same time, avoid overcorrection: the most useful numbers for troubleshooting like
 * `max_tokens` must not be stripped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { redactDebug } from "./debug.ts";

const BS = String.fromCharCode(92); // Backslash. Writing it in a literal is easily eaten by various tools; this way is safest

test("Credential request headers with a prefix must also be masked (the old ^…$ anchors let all of them slip through)", () => {
  const out = redactDebug({
    "x-api-key": "sk-real-key-value-1234",
    "anthropic-api-key": "abc123",
    "Authorization": "Bearer xyz",
    "proxy-authorization": "Basic zzz",
    "apiKey": "k1",
    "openai_api_key": "k2",
    "set-cookie": "a=b",
    "client_secret": "cs",
  });
  for (const [k, v] of Object.entries(out)) {
    assert.equal(v, "[REDACTED]", `${k} should be masked, but it is actually ${JSON.stringify(v)}`);
  }
});

test("Counts needed for troubleshooting must not become collateral damage", () => {
  const out = redactDebug({ max_tokens: 4096, promptTokens: 120, totalTokens: 999, tokenizer: "cl100k" });
  assert.deepEqual(out, { max_tokens: 4096, promptTokens: 120, totalTokens: 999, tokenizer: "cl100k" });
});

test("Credentials in the query string: a bare token= must also be stripped", () => {
  // The query string path is **intentionally broad**: mask parameter names containing key/token/secret/auth.
  // It also masks max_tokens= along the way, which is no loss: in URLs it is never troubleshooting info,
  // the max_tokens that really matters is the field in JSON, which follows the key name rule below (unaffected).
  const out = redactDebug({ url: "https://api.x.com/v1?token=SECRET123&api_key=AAA&access_token=BBB&stream=true" });
  assert.ok(!/SECRET123|AAA|BBB/.test(out.url), `Credentials still remain: ${out.url}`);
  assert.match(out.url, /stream=true/, "Unrelated parameters must be kept");
});

test("Bearer / sk- / machine code in text", () => {
  const out = redactDebug({ text: "Bearer abcdefg, sk-abcdefghijklmnop, PCM-ABCDE-FGHJK-MNPQR-STVWX" });
  assert.ok(!/abcdefg,/.test(out.text), "The string after Bearer should be gone");
  assert.ok(!/sk-abcdefghijklmnop/.test(out.text), "The Key starting with sk- should be gone");
  assert.match(out.text, /PCM-ABCDE-…/, "Only the first group of the machine code is kept");
  assert.ok(!/FGHJK/.test(out.text), "The later groups of the machine code should be gone");
});

test("Local paths have only the user name erased, and the directory structure is kept", () => {
  const win = `C:${BS}Users${BS}admin${BS}Documents${BS}PromptCut${BS}x.proc`;
  const out = redactDebug({ win, posix: "/home/admin/work/a.txt" });
  assert.ok(!/admin/.test(out.win), `The user name should be gone: ${out.win}`);
  assert.match(out.win, /Documents/, "The directory structure after it must be kept: troubleshooting relies on it");
  assert.equal(out.posix, "/home/[USER]/work/a.txt");
});

test("Walk through nested structures and arrays together", () => {
  const out = redactDebug({ list: [{ headers: { "x-api-key": "s1" }, ok: true }] });
  assert.equal(out.list[0].headers["x-api-key"], "[REDACTED]");
  assert.equal(out.list[0].ok, true);
});

/*
 * Environment snapshots (ai/envReport.ts + server/harness/env-snapshot.mjs) also use the same
 * sanitization pipeline. It contains nothing but paths: project files, asset catalog, cwd, tmpdir:
 * every one contains a username. This part was added later, and sanitization is "the step most
 * easily forgotten when adding fields", so a dedicated test is pinned here.
 */
test("Paths in the environment snapshot must be redacted as well, and are otherwise kept in the report as they are", async () => {
  const { conversationReport } = await import("./debug.ts");
  const report = JSON.parse(conversationReport([{ role: "user", content: "hi" }], "api", null, {
    project: { filePath: `C:${BS}Users${BS}admin${BS}Documents${BS}片子${BS}a.proc` },
    media: { dirs: [`C:${BS}Users${BS}admin${BS}AppData${BS}Local${BS}Temp${BS}promptcut`] },
    server: { node: { cwd: "/home/admin/PromptCut" }, headers: { "x-api-key": "sk-abcdefghijklmnop" } },
  }));
  assert.ok(report.environment, "The environment snapshot must really be in the report: without it we can only rely on going back and forth asking the user");
  assert.ok(!/admin/.test(JSON.stringify(report.environment)), "The user name should be gone");
  assert.match(report.environment.project.filePath, /片子/, "The directory structure must be kept");
  assert.equal(report.environment.server.headers["x-api-key"], "[REDACTED]");
});

test("The report is still produced when no environment snapshot is passed (old callers / collection failure)", async () => {
  const { conversationReport } = await import("./debug.ts");
  const report = JSON.parse(conversationReport([{ role: "user", content: "hi" }], "api", null));
  assert.equal(report.environment, undefined);
  assert.equal(report.messages.length, 1);
});
