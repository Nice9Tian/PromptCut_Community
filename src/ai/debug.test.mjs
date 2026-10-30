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

test("带前缀的凭据请求头也要打码(原来 ^…$ 锚点让它们全部漏网)", () => {
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
    assert.equal(v, "[REDACTED]", `${k} 该被打码,实际是 ${JSON.stringify(v)}`);
  }
});

test("排查要用的计数不能被误伤", () => {
  const out = redactDebug({ max_tokens: 4096, promptTokens: 120, totalTokens: 999, tokenizer: "cl100k" });
  assert.deepEqual(out, { max_tokens: 4096, promptTokens: 120, totalTokens: 999, tokenizer: "cl100k" });
});

test("查询串里的凭据:裸 token= 也要打掉", () => {
  // 查询串这一路是**故意宽的**:参数名里带 key/token/secret/auth 就打码。
  // 顺带把 max_tokens= 也打掉了,这不算损失 —— 它在 URL 里从来不是排查信息,
  // 真正要看的 max_tokens 是 JSON 里的字段,走的是下面那条键名规则(不受影响)。
  const out = redactDebug({ url: "https://api.x.com/v1?token=SECRET123&api_key=AAA&access_token=BBB&stream=true" });
  assert.ok(!/SECRET123|AAA|BBB/.test(out.url), `还留着凭据:${out.url}`);
  assert.match(out.url, /stream=true/, "不相干的参数要留着");
});

test("文本里的 Bearer / sk- / 机器码", () => {
  const out = redactDebug({ text: "Bearer abcdefg, sk-abcdefghijklmnop, PCM-ABCDE-FGHJK-MNPQR-STVWX" });
  assert.ok(!/abcdefg,/.test(out.text), "Bearer 后面的串该没了");
  assert.ok(!/sk-abcdefghijklmnop/.test(out.text), "sk- 开头的 Key 该没了");
  assert.match(out.text, /PCM-ABCDE-…/, "机器码只留第一组");
  assert.ok(!/FGHJK/.test(out.text), "机器码后面几组该没了");
});

test("本机路径只抹用户名,目录结构留着", () => {
  const win = `C:${BS}Users${BS}admin${BS}Documents${BS}PromptCut${BS}x.proc`;
  const out = redactDebug({ win, posix: "/home/admin/work/a.txt" });
  assert.ok(!/admin/.test(out.win), `用户名该没了:${out.win}`);
  assert.match(out.win, /Documents/, "后面的目录结构要留着 —— 排查靠它");
  assert.equal(out.posix, "/home/[USER]/work/a.txt");
});

test("嵌套结构和数组一起走一遍", () => {
  const out = redactDebug({ list: [{ headers: { "x-api-key": "s1" }, ok: true }] });
  assert.equal(out.list[0].headers["x-api-key"], "[REDACTED]");
  assert.equal(out.list[0].ok, true);
});

/*
 * 环境快照(ai/envReport.ts + server/harness/env-snapshot.mjs)也走同一条脱敏管线。
 * 它里面全是路径:项目文件、素材目录、cwd、tmpdir —— 每一条都带用户名。
 * 这一段是后加的,而脱敏是「加字段时最容易忘的一步」,所以单钉一条。
 */
test("环境快照里的路径同样要脱敏,并且原样留在报告里", async () => {
  const { conversationReport } = await import("./debug.ts");
  const report = JSON.parse(conversationReport([{ role: "user", content: "hi" }], "api", null, {
    project: { filePath: `C:${BS}Users${BS}admin${BS}Documents${BS}片子${BS}a.proc` },
    media: { dirs: [`C:${BS}Users${BS}admin${BS}AppData${BS}Local${BS}Temp${BS}promptcut`] },
    server: { node: { cwd: "/home/admin/PromptCut" }, headers: { "x-api-key": "sk-abcdefghijklmnop" } },
  }));
  assert.ok(report.environment, "环境快照必须真的进报告 —— 少了它就只能靠来回问用户");
  assert.ok(!/admin/.test(JSON.stringify(report.environment)), "用户名该没了");
  assert.match(report.environment.project.filePath, /片子/, "目录结构要留着");
  assert.equal(report.environment.server.headers["x-api-key"], "[REDACTED]");
});

test("没传环境快照时报告照样出得来(旧调用方 / 采集失败)", async () => {
  const { conversationReport } = await import("./debug.ts");
  const report = JSON.parse(conversationReport([{ role: "user", content: "hi" }], "api", null));
  assert.equal(report.environment, undefined);
  assert.equal(report.messages.length, 1);
});
