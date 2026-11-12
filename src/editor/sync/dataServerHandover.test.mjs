import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCredentialStore } from "../../../server/auth/store.mjs";
import { KDF_DEFAULT, makeCredential } from "../../../server/auth/client.mjs";
import { fileNameOf } from "../../../server/docservice/store/index.mjs";
import {
  adoptDataServerProject,
  exportHandoverPackage,
  inspectLocalDataServer,
  mutateDataServerMembers,
  readProjectHistory,
  relinquishLocalDataServer,
} from "../../../server/data-server.mjs";

const {
  canBecomeDataServer,
  createHandoverCoordinator,
  generatePairingCode,
} = await import(srcUrl("editor/sync/dataServerHandoverCore.ts"));

test("canBecomeDataServer enforces strict creator-only and desktop-only visibility gate", () => {
  assert.equal(canBecomeDataServer({ online: true, kind: "local", shared: null, association: null }), false);
  assert.equal(canBecomeDataServer({ online: false, kind: "local", shared: null, association: null }), true);
  assert.equal(canBecomeDataServer({ online: false, kind: "local", shared: null, association: { roomId: "sp_x" } }), false);
  assert.equal(canBecomeDataServer({ online: false, kind: "shared", shared: { creator: true }, association: { roomId: "sp_x" } }), true);
  assert.equal(canBecomeDataServer({ online: false, kind: "shared", shared: { creator: false }, association: { roomId: "sp_x" } }), false);
});

test("generatePairingCode produces 6-digit numeric strings", () => {
  for (let i = 0; i < 20; i++) {
    const code = generatePairingCode();
    assert.match(code, /^\d{6}$/);
  }
});

test("createHandoverCoordinator rejects non-creator messages and handles Decline cleanly", async () => {
  const bus = [];
  const host = createHandoverCoordinator({
    getSessionId: () => "sess-host",
    getDevice: async () => ({ deviceId: "pc-host-11111111111111", deviceName: "HostStudio" }),
    getProjectContext: () => ({ projectId: "sp_room12345678901234567890", projectName: "Film A", isCreator: true, where: "lan" }),
    isCurrentHostForProject: async () => ({ isHost: true, sameServer: false }),
    sendSignal: async (data) => {
      bus.push({ from: "host", data });
      return true;
    },
    exportHandover: async () => null,
    relinquishHost: async () => {},
    adoptHost: async () => "sp_new",
  });

  const requester = createHandoverCoordinator({
    getSessionId: () => "sess-req",
    getDevice: async () => ({ deviceId: "pc-req-222222222222222", deviceName: "EditLaptop" }),
    getProjectContext: () => ({ projectId: "sp_room12345678901234567890", projectName: "Film A", isCreator: true, where: "lan" }),
    isCurrentHostForProject: async () => ({ isHost: false, sameServer: false }),
    sendSignal: async (data) => {
      bus.push({ from: "req", data });
      return true;
    },
    exportHandover: async () => null,
    relinquishHost: async () => {},
    adoptHost: async () => "sp_new",
    newRequestId: () => "req-001",
  });

  // Spoofed message from a non-creator member is ignored completely
  await host.receiveMessage({
    projectId: "sp_room12345678901234567890",
    from: { username: "Mallory", creator: false, deviceId: "pc-mallory123456789012" },
    data: { kind: "pc:data-server-handover", step: "request", requestId: "spoof-1", fromSession: "sess-bad" },
    at: Date.now(),
  });
  assert.equal(host.getState().incoming, null);

  // Genuine creator request triggers prompt on original host
  await requester.requestHandover();
  assert.equal(requester.getState().outgoing?.phase, "waiting-approval");
  const reqMsg = bus.pop();
  await host.receiveMessage({
    projectId: "sp_room12345678901234567890",
    from: { username: "Director", creator: true, deviceId: "pc-req-222222222222222" },
    data: reqMsg.data,
    at: Date.now(),
  });
  assert.equal(host.getState().incoming?.phase, "prompt");
  assert.equal(host.getState().incoming?.fromDeviceName, "EditLaptop");

  // Host declines -> requester transitions to declined
  await host.declineIncoming();
  assert.equal(host.getState().incoming, null);
  const declineMsg = bus.pop();
  await requester.receiveMessage({
    projectId: "sp_room12345678901234567890",
    from: { username: "Director", creator: true, deviceId: "pc-host-11111111111111" },
    data: declineMsg.data,
    at: Date.now(),
  });
  assert.equal(requester.getState().outgoing?.phase, "declined");
});

test("createHandoverCoordinator requires mutual 6-digit pairing-code verification before takeover", async () => {
  const bus = [];
  let hostRelinquished = false;
  let adoptedPayload = null;
  let adoptedCallbackId = null;

  const mockRoomAuth = {
    name: "Studio Cut",
    mode: "restricted",
    kdf: { alg: "pbkdf2-sha256", iter: 1000 },
    creator: { username: "Director", salt: "s", key: "k" },
    list: [{ username: "Editor1", salt: "s2", key: "k2" }],
    bans: [],
  };

  const host = createHandoverCoordinator({
    getSessionId: () => "sess-host",
    getDevice: async () => ({ deviceId: "pc-host-11111111111111", deviceName: "HostStudio" }),
    getProjectContext: () => ({ projectId: "sp_room12345678901234567890", projectName: "Studio Cut", isCreator: true, where: "lan" }),
    isCurrentHostForProject: async () => ({ isHost: true, sameServer: false }),
    sendSignal: async (data) => {
      bus.push({ from: "host", data });
      return true;
    },
    exportHandover: async () => mockRoomAuth,
    relinquishHost: async () => {
      hostRelinquished = true;
    },
    adoptHost: async () => "unused",
    newCode: () => "482915",
  });

  const requester = createHandoverCoordinator({
    getSessionId: () => "sess-req",
    getDevice: async () => ({ deviceId: "pc-req-222222222222222", deviceName: "EditLaptop" }),
    getProjectContext: () => ({ projectId: "sp_room12345678901234567890", projectName: "Studio Cut", isCreator: true, where: "lan" }),
    isCurrentHostForProject: async () => ({ isHost: false, sameServer: false }),
    sendSignal: async (data) => {
      bus.push({ from: "req", data });
      return true;
    },
    exportHandover: async () => null,
    relinquishHost: async () => {},
    adoptHost: async (payload) => {
      adoptedPayload = payload;
      return "sp_adopted1234567890123456";
    },
    newRequestId: () => "req-mutual-1",
  });

  // 1. Requester sends request -> Host shows prompt
  await requester.requestHandover();
  await host.receiveMessage({
    projectId: "sp_room12345678901234567890",
    from: { username: "Director", creator: true, deviceId: "pc-req-222222222222222" },
    data: bus.shift().data,
    at: Date.now(),
  });
  assert.equal(host.getState().incoming?.phase, "prompt");

  // 2. Host clicks Agree -> generates 6-digit code 482915 and sends commitment hash
  const code = await host.agreeIncoming();
  assert.equal(code, "482915");
  assert.equal(host.getState().incoming?.phase, "verify-code");

  await requester.receiveMessage({
    projectId: "sp_room12345678901234567890",
    from: { username: "Director", creator: true, deviceId: "pc-host-11111111111111" },
    data: bus.shift().data,
    at: Date.now(),
  });
  assert.equal(requester.getState().outgoing?.phase, "enter-code");

  // 3. Wrong 6-digit code is rejected immediately on requester
  const wrongOk = await requester.submitPairingCode("999999");
  assert.equal(wrongOk, false);
  assert.ok(requester.getState().outgoing?.error);
  assert.equal(bus.length, 0);

  // 4. Correct 6-digit code submitted by requester -> delivered to host, but handover waits until host ALSO confirms!
  const rightOk = await requester.submitPairingCode("482915");
  assert.equal(rightOk, true);
  await host.receiveMessage({
    projectId: "sp_room12345678901234567890",
    from: { username: "Director", creator: true, deviceId: "pc-req-222222222222222" },
    data: bus.shift().data,
    at: Date.now(),
  });
  assert.equal(host.getState().incoming?.requesterVerified, true);
  assert.equal(hostRelinquished, false, "Host must not relinquish before mutual confirmation");

  // 5. Host confirms pairing -> exports auth, relinquishes old host, and requester adopts local data server!
  await host.confirmHostPairing();
  assert.equal(hostRelinquished, true);
  assert.equal(host.getState().incoming, null);

  await requester.receiveMessage(
    {
      projectId: "sp_room12345678901234567890",
      from: { username: "Director", creator: true, deviceId: "pc-host-11111111111111" },
      data: bus.shift().data,
      at: Date.now(),
    },
    (id) => {
      adoptedCallbackId = id;
    },
  );
  assert.equal(adoptedCallbackId, "sp_adopted1234567890123456");
  assert.deepEqual(adoptedPayload.roomAuth, mockRoomAuth);
  assert.equal(requester.getState().outgoing, null);
});

test("server/data-server.mjs manages member accounts, history logs, and handover adoption", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ds-test-"));
  try {
    const storeA = openCredentialStore({ dir: path.join(tmp, "a", "auth") });
    const storeB = openCredentialStore({ dir: path.join(tmp, "b", "auth") });
    const kdf = KDF_DEFAULT;
    const creatorCred = await makeCredential("creator-pass", kdf);
    const created = storeA.create({
      name: "Documentary",
      mode: "restricted",
      kdf,
      creator: { username: "Director", ...creatorCred },
      list: [],
    });

    await mutateDataServerMembers({
      store: storeA,
      projectId: created.projectId,
      action: "add-member",
      username: "Colorist",
      password: "pw1",
      access: "rw",
      makeCredentialFn: (pw) => makeCredential(pw, kdf),
    });
    await mutateDataServerMembers({
      store: storeA,
      projectId: created.projectId,
      action: "add-member",
      username: "Reviewer",
      password: "pw2",
      access: "r",
      makeCredentialFn: (pw) => makeCredential(pw, kdf),
    });

    // Write synthetic ops.ndjson log in tenants/<projectId>/projects/
    const opsDir = path.join(tmp, "a", "tenants", created.projectId, "projects");
    fs.mkdirSync(opsDir, { recursive: true });
    const opsFile = path.join(opsDir, `${fileNameOf(`${created.projectId}.ops`)}.ndjson`);
    fs.writeFileSync(
      opsFile,
      [
        JSON.stringify({ projectId: created.projectId, rev: 1, opId: "op-1", at: 1000, actor: { username: "Director", creator: true }, entities: ["/meta/name"], ops: [{ op: "set", path: "/name", value: "Documentary" }] }),
        JSON.stringify({ projectId: created.projectId, rev: 2, opId: "op-2", at: 2000, actor: { username: "Colorist", creator: false }, entities: ["/tracks/0"], ops: [{ op: "set", path: "/tracks/0/clips/0/start", value: 1.5 }] }),
      ].join("\n") + "\n",
    );

    const statusA = inspectLocalDataServer({
      store: storeA,
      dataDir: path.join(tmp, "a"),
      device: { deviceId: "pc-a", deviceName: "HostA" },
      lanHost: true,
      port: 5270,
      projectId: created.projectId,
    });
    assert.equal(statusA.isLocalHost, true);
    assert.equal(statusA.project.allowlist.length, 2);
    assert.equal(statusA.history.latestRev, 2);
    assert.equal(statusA.history.records[0].actor.username, "Colorist");

    // Export from A -> adopt on B -> relinquish A
    const pkg = exportHandoverPackage({ store: storeA, projectId: created.projectId });
    const adopted = adoptDataServerProject({ store: storeB, roomAuth: pkg });
    assert.equal(adopted.name, "Documentary");
    assert.equal(storeB.get(adopted.projectId).list.length, 2);
    assert.equal(relinquishLocalDataServer({ store: storeA, projectId: created.projectId }), true);
    assert.equal(storeA.get(created.projectId), null);

    const hist = readProjectHistory(path.join(tmp, "a"), created.projectId, { scope: "shared" });
    assert.equal(hist.records.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
