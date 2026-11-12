import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCredentialStore } from "../auth/store.mjs";
import { KDF_DEFAULT, makeCredential } from "../auth/client.mjs";
import { fileNameOf } from "../docservice/store/index.mjs";
import {
  adoptDataServerProject,
  exportHandoverPackage,
  inspectLocalDataServer,
  mutateDataServerMembers,
  readProjectHistory,
  relinquishLocalDataServer,
} from "../data-server.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pc-data-server-test-"));
}

test("data-server: inspects room, mutates member accounts & permissions, and reads commit history", async () => {
  const dir = makeTempDir();
  try {
    const store = openCredentialStore({ dir: path.join(dir, "auth") });
    const creatorCred = await makeCredential("creator-secret", KDF_DEFAULT);
    const created = store.create({
      name: "Studio Documentary",
      mode: "restricted",
      kdf: KDF_DEFAULT,
      creator: { username: "director", ...creatorCred },
      list: [],
    });

    // Seed shared space commit log
    const tenantProjDir = path.join(dir, "tenants", created.projectId, "projects");
    fs.mkdirSync(tenantProjDir, { recursive: true });
    const opsFile = path.join(tenantProjDir, `${fileNameOf(`${created.projectId}.ops`)}.ndjson`);
    fs.writeFileSync(
      opsFile,
      [
        JSON.stringify({
          rev: 1,
          opId: "op-1",
          projectId: created.projectId,
          at: 1700000001000,
          actor: { userId: "director", username: "director", creator: true },
          entities: ["/meta/name"],
          ops: [{ op: "set", path: "/meta/name" }],
        }),
        JSON.stringify({
          rev: 2,
          opId: "op-2",
          projectId: created.projectId,
          at: 1700000005000,
          actor: { userId: "alice", username: "alice", creator: false },
          entities: ["/tracks/0/clips/0"],
          ops: [{ op: "insert", path: "/tracks/0/clips/0" }],
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const history = readProjectHistory(dir, created.projectId, { scope: "shared" });
    assert.equal(history.latestRev, 2);
    assert.equal(history.records.length, 2);
    assert.equal(history.records[0].rev, 2);
    assert.equal(history.records[0].actor.username, "alice");

    // Add rw and read-only member accounts
    await mutateDataServerMembers({
      store,
      projectId: created.projectId,
      action: "add-member",
      username: "alice",
      password: "pw-alice",
      access: "rw",
    });
    await mutateDataServerMembers({
      store,
      projectId: created.projectId,
      action: "add-member",
      username: "reviewer_bob",
      password: "pw-bob",
      access: "r",
    });

    const status = inspectLocalDataServer({
      store,
      dataDir: dir,
      device: { deviceId: "dev-1", deviceName: "Workstation-A" },
      lanHost: true,
      port: 5270,
      projectId: created.projectId,
    });
    assert.equal(status.isLocalHost, true);
    assert.equal(status.project.creatorUsername, "director");
    assert.deepEqual(status.project.allowlist, [
      { username: "alice", access: "rw" },
      { username: "reviewer_bob", access: "r" },
    ]);
    assert.equal(JSON.stringify(status).includes(creatorCred.key), false, "status never leaks derived keys");

    // Remove member
    await mutateDataServerMembers({
      store,
      projectId: created.projectId,
      action: "remove-member",
      username: "reviewer_bob",
    });
    const afterRemove = inspectLocalDataServer({
      store,
      dataDir: dir,
      device: { deviceId: "dev-1", deviceName: "Workstation-A" },
      projectId: created.projectId,
    });
    assert.deepEqual(afterRemove.project.allowlist, [{ username: "alice", access: "rw" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("data-server: exports handover package from host A, adopts on host B, and relinquishes host A", async () => {
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  try {
    const storeA = openCredentialStore({ dir: path.join(dirA, "auth") });
    const storeB = openCredentialStore({ dir: path.join(dirB, "auth") });
    const creatorCred = await makeCredential("creator-secret", KDF_DEFAULT);
    const memberCred = await makeCredential("member-secret", KDF_DEFAULT);
    const roomA = storeA.create({
      name: "Handover Cut",
      mode: "restricted",
      kdf: KDF_DEFAULT,
      creator: { username: "owner", ...creatorCred },
      list: [{ username: "editor1", ...memberCred, access: "rw" }],
    });

    const pkg = exportHandoverPackage({ store: storeA, projectId: roomA.projectId });
    assert.equal(pkg.name, "Handover Cut");
    assert.equal(pkg.creator.username, "owner");

    let syncedB = 0;
    const adopted = adoptDataServerProject({
      store: storeB,
      roomAuth: pkg,
      lanSync: () => { syncedB += 1; },
    });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.name, "Handover Cut");
    assert.equal(adopted.creatorUsername, "owner");
    assert.equal(adopted.creatorKey, creatorCred.key);
    assert.equal(syncedB, 1);

    const removedA = relinquishLocalDataServer({ store: storeA, projectId: roomA.projectId });
    assert.equal(removedA, true);
    assert.equal(storeA.get(roomA.projectId), null);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
