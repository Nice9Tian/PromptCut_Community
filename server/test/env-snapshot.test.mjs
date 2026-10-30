/**
 * node --test server/test/env-snapshot.test.mjs
 *
 * 诊断报告里服务端那一半的现场。
 *
 * 重点是**会话文件柜**:界面上的对话按项目走,而服务端接哪段历史取决于
 * localStorage 里那把会话 id,两者脱节时界面上一点症状都没有(见 81f255b)。
 * 报告要能把「这台机器上躺着几段历史、各几条」摆出来,这类串台才有物证。
 *
 * 同样重要的是它**不能报出对话内容** —— 用户点「诊断」是为了把报告发给我们,
 * 报告里多一句原话,就是多一次不该发生的外泄。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { inspectSessionStore, nodeStatus, sessionStoreDir } = await import("../harness/env-snapshot.mjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pc-envsnap-"));
}

test("目录不存在时报一句人话,而不是抛异常把整份报告带走", () => {
  const missing = path.join(tmpDir(), "nope");
  const r = inspectSessionStore(missing);
  assert.equal(r.exists, false);
  assert.equal(r.files, 0);
  assert.match(r.note, /目录不存在/);
});

test("报每段历史有几条、什么角色 —— 这就是「界面空着后端却接着旧对话」的物证", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "api-9433c3ac.json"), JSON.stringify([
    { role: "user", content: "上一个项目的第一句" },
    { role: "assistant", content: "回话" },
    { role: "user", content: "又一句" },
  ]));
  const r = inspectSessionStore(dir);
  assert.equal(r.exists, true);
  assert.equal(r.files, 1);
  assert.equal(r.recent[0].sessionId, "api-9433c3ac", "文件名去掉 .json 就是会话 id,要能和 localStorage 那把对上");
  assert.equal(r.recent[0].messages, 3);
  assert.deepEqual(r.recent[0].roles, { user: 2, assistant: 1 });
});

test("绝不能把对话内容带进报告", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "s.json"), JSON.stringify([{ role: "user", content: "喝完野生狗奶直接化身快乐小狗" }]));
  const dumped = JSON.stringify(inspectSessionStore(dir));
  assert.ok(!dumped.includes("快乐小狗"), `原话漏进报告了: ${dumped}`);
});

test("坏掉的历史文件不许拖垮整个目录的统计", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify([{ role: "user" }]));
  fs.writeFileSync(path.join(dir, "broken.json"), "{ 这不是 JSON");
  fs.writeFileSync(path.join(dir, "notes.txt"), "不是 json,不该被数进去");
  const r = inspectSessionStore(dir);
  assert.equal(r.files, 2, "只数 .json");
  const broken = r.recent.find((x) => x.sessionId === "broken");
  assert.equal(broken.messages, "(读不出来)");
  assert.equal(r.recent.find((x) => x.sessionId === "good").messages, 1);
});

test("最新的排在前面 —— 排查时先看的就是刚才那一段", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "old.json"), "[]");
  fs.writeFileSync(path.join(dir, "new.json"), "[]");
  const now = Date.now();
  fs.utimesSync(path.join(dir, "old.json"), new Date(now - 86400000), new Date(now - 86400000));
  fs.utimesSync(path.join(dir, "new.json"), new Date(now), new Date(now));
  const r = inspectSessionStore(dir);
  assert.deepEqual(r.recent.map((x) => x.sessionId), ["new", "old"]);
});

test("文件多到一定数量就只细看最新的那些,并说明白截了", () => {
  const dir = tmpDir();
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `s${i}.json`), "[]");
  const r = inspectSessionStore(dir);
  assert.equal(r.files, 25, "总数照报");
  assert.equal(r.recent.length, 20);
  assert.match(r.note, /共 25 个/);
});

test("默认目录必须和 runners/api.mjs 读写的是同一个", () => {
  assert.equal(sessionStoreDir("/T"), path.join("/T", "promptcut", "harness-sessions"));
});

test("Node 进程状态要能回答「是不是刚重启过」和「是不是打包版」", () => {
  const n = nodeStatus();
  assert.match(n.version, /^v\d+/);
  assert.equal(typeof n.uptimeSeconds, "number");
  assert.equal(typeof n.packaged, "boolean");
  assert.equal(typeof n.memoryMB.rss, "number");
  assert.ok(n.osMemoryMB.total > 0);
});

test("打包版要认得出来 —— 打包版和源码版的路径行为不一样", () => {
  const fake = { version: "v24.0.0", versions: {}, pid: 1, uptime: () => 5, memoryUsage: () => ({}), execPath: "x", cwd: () => "y", env: { PROMPTCUT_RUNTIME_ROOT: "C:/app" } };
  const o = { tmpdir: () => "/t", totalmem: () => 1, freemem: () => 1, cpus: () => [], release: () => "1" };
  assert.equal(nodeStatus(fake, o).packaged, true);
  assert.equal(nodeStatus({ ...fake, env: {} }, o).packaged, false);
});
