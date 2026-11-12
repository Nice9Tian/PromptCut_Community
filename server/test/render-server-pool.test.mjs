import test from "node:test";
import assert from "node:assert/strict";
import { createRenderServerPool, parseInviteFromInput, normalizeWsUrl } from "../render-server-pool.mjs";

test("parseInviteFromInput parses valid LAN and hosted invite links and rejects bad/legacy links", () => {
  const code = "A".repeat(43);
  const lan = parseInviteFromInput(`http://192.168.1.25:5270/#invite=${code}&doc=%2Fdocservice`);
  assert.deepEqual(lan, {
    origin: "http://192.168.1.25:5270",
    code,
    doc: "/docservice",
    base: "http://192.168.1.25:5270/docservice",
  });

  const hosted = parseInviteFromInput(`Join us: https://pc.example.com/editor#invite=${code}&doc=%2Fhosted%2F now!`);
  assert.deepEqual(hosted, {
    origin: "https://pc.example.com",
    code,
    doc: "/hosted/",
    base: "https://pc.example.com/hosted/",
  });

  const legacy = parseInviteFromInput(`http://127.0.0.1:5270/#invite=${code}`);
  assert.equal(legacy.doc, null);
  assert.equal(legacy.base, null);

  assert.equal(parseInviteFromInput("http://127.0.0.1:5270/#invite=short"), null);
  assert.equal(parseInviteFromInput("not a link"), null);
});

test("normalizeWsUrl preserves trailing slash on /hosted/ and strips it on /docservice", () => {
  assert.equal(normalizeWsUrl("https://pc.example.com/hosted/"), "wss://pc.example.com/hosted/");
  assert.equal(normalizeWsUrl("http://192.168.1.5:5270/docservice/"), "ws://192.168.1.5:5270/docservice");
  assert.equal(normalizeWsUrl("ws://127.0.0.1:5270/docservice"), "ws://127.0.0.1:5270/docservice");
});

test("createRenderServerPool tracks joined & invite projects, deduplicates, and computes throughput", async () => {
  let clock = 1_000_000;
  const closed = [];
  const pool = createRenderServerPool({
    maxRecords: 5,
    now: () => clock,
    connectProject: (entry, cred) => ({
      connected: () => Boolean(cred.key || cred.password),
      state: () => "connected",
      error: () => null,
      close: () => closed.push(entry.projectId),
    }),
  });

  pool.syncCurrentBinding({
    projectId: "sp_current123456789012345678",
    url: "ws://127.0.0.1:5270/docservice",
    assetBase: "http://127.0.0.1:5270/api/asset",
  }, { name: "Current Project" });

  await pool.addJoinedProject({
    projectId: "sp_joined1234567890123456789",
    name: "Joined Team Film",
    url: "http://192.168.1.10:5270/docservice",
    mode: "free",
    username: "Alice",
    key: "k-secret-do-not-expose",
  });

  const code = "B".repeat(43);
  await pool.addInviteProject(
    { inviteLink: `http://192.168.1.20:5270/#invite=${code}&doc=%2Fdocservice`, username: "RenderBot" },
    {
      device: { deviceId: "pc-renderdevice123456", deviceName: "StudioBox" },
      resolveInvite: async () => ({ projectId: "sp_invited123456789012345678", name: "Invited Scene", mode: "free" }),
      redeemInvite: async () => ({ projectId: "sp_invited123456789012345678", name: "Invited Scene", mode: "free", key: "k-invite-secret" }),
    },
  );

  // Restricted invite without password throws password-required cleanly
  await assert.rejects(
    () => pool.addInviteProject(
      { inviteLink: `http://192.168.1.20:5270/#invite=${code}&doc=%2Fdocservice`, username: "Bob" },
      {
        device: { deviceId: "pc-renderdevice123456", deviceName: "StudioBox" },
        resolveInvite: async () => ({ projectId: "sp_restricted12345678901234", name: "Team Cut", mode: "restricted" }),
        redeemInvite: async () => ({ projectId: "sp_restricted12345678901234", name: "Team Cut", mode: "restricted" }),
      },
    ),
    (err) => err.code === "password-required" && err.project.name === "Team Cut",
  );

  // Record running -> completed tasks and check throughput calculation
  pool.recordTask({
    id: "task-1",
    projectId: "sp_joined1234567890123456789",
    kind: "snapshot",
    status: "running",
    frames: 0,
    segments: 0,
    startedAt: clock,
  });
  clock += 2000;
  pool.recordTask({
    id: "task-1",
    projectId: "sp_joined1234567890123456789",
    kind: "snapshot",
    status: "completed",
    frames: 60,
    segments: 2,
    finishedAt: clock,
  });
  clock += 1000;
  pool.recordTask({
    id: "task-2",
    projectId: "sp_invited123456789012345678",
    kind: "stream",
    status: "completed",
    frames: 30,
    segments: 1,
    startedAt: clock - 1000,
    finishedAt: clock,
  });

  const snap = pool.status({
    nodeStatus: { projectId: "sp_current123456789012345678", bound: true },
    prerenderReady: true,
  });
  assert.equal(snap.projects.length, 3);
  // Ensure no secret keys leak into status JSON
  const serialized = JSON.stringify(snap);
  assert.equal(serialized.includes("k-secret"), false);
  assert.equal(serialized.includes("k-invite-secret"), false);
  assert.equal(serialized.includes(code), false);

  assert.equal(snap.throughput.completedTasks, 2);
  assert.equal(snap.throughput.inFlightTasks, 0);
  assert.equal(snap.throughput.totalFrames, 90);
  assert.equal(snap.throughput.totalSegments, 3);
  assert.equal(snap.throughput.totalRenderMs, 3000);
  assert.equal(snap.throughput.framesPerSec, 30);
  assert.equal(snap.throughput.segmentsPerMin, 60);

  // Clearing current binding leaves joined & invite projects intact
  pool.syncCurrentBinding(null);
  assert.equal(pool.status().projects.length, 2);

  await pool.removeProject("sp_joined1234567890123456789");
  assert.deepEqual(closed, ["sp_joined1234567890123456789"]);
  assert.equal(pool.status().projects.length, 1);

  await pool.close();
  assert.deepEqual(closed, ["sp_joined1234567890123456789", "sp_invited123456789012345678"]);
});
