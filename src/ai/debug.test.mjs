/**
 * 诊断报告的脱敏。跑:node --test src/ai/debug.test.mjs
 *
 * 这份报告是**要上传的**(用户点「提交」直接进 Cloudflare KV,还会往飞书推一条)。
 * 所以这里钉的不是「代码是否按预期工作」,而是一条底线:**凭据不能出机器**。
 *
 * 0.3.0 评审抓到的两个漏网口子,各有一条用例守着:
 *   - 键名正则原来带 ^…$ 锚点,`x-api-key` / `anthropic-api-key` 这些真实请求头一个都不匹配;
 *   - 查询串只列了四个固定参数名,最常见的裸 `token=` 反而漏了。
 * 同时要保证别矫枉过正:`max_tokens` 这类排查时最有用的数字不能被打掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { redactDebug } from "./debug.ts";

const BS = String.fromCharCode(92); // 反斜杠。写在字面量里容易被各种工具吃掉,这样最稳

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
  // 查询串这一路是**故意宽的**:参数名里带 key/token/secret/auth 就打码。
  // 顺带把 max_tokens= 也打掉了,这不算损失 —— 它在 URL 里从来不是排查信息,
  // 真正要看的 max_tokens 是 JSON 里的字段,走的是下面那条键名规则(不受影响)。
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
 * 环境快照(ai/envReport.ts + server/harness/env-snapshot.mjs)也走同一条脱敏管线。
 * 它里面全是路径:项目文件、素材目录、cwd、tmpdir —— 每一条都带用户名。
 * 这一段是后加的,而脱敏是「加字段时最容易忘的一步」,所以单钉一条。
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
