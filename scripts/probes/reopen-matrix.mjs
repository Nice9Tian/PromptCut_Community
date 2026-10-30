/** Additional isolated desktop acceptance. Invoked by reopen-e2e --matrix. No user data or networking changes. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function runRecoveryMatrix(o) {
  let { host, member, hostRuntime, memberRuntime } = o;
  const { root, roomId, where, mode, hostFile, memberFile, password, creatorPassword, editor, page, stop, open, saved, connected, name, sees, phase } = o;
  const evidence = {};
  const clickText = (p, selector, text) => p.evaluate((s, t) => {
    const b = [...document.querySelectorAll(s)].find(b => b.textContent?.trim() === t);
    if (!b) throw new Error(`Missing UI action: ${t}`); b.click();
  }, selector, text);
  const waitJournal = () => member.waitForFunction(async () => {
    const sync = window.probe.sync, descriptor = sync.getSyncView().association;
    // 本机存储暂时忙时这次查询会失败,在时限内再查,不当成断言失败
    try {
      const r = await sync.recoveryRequest('select', descriptor, { contentId: window.probe.store.getState().project.id });
      return r.journal?.pending?.length > 0;
    } catch { return false; }
  }, { timeout: 15000 });
  // 2026-10-22 起:离线批次被拒后逐项转进「冲突合并」(conflict-merge 报告第十节),DocSync 只停一下就回到云端现状;等的是窗口
  const mergeWindow = () => member.waitForSelector('[data-pc="conflict-merge"]', { timeout: 20000 });
  const mergeAll = async (button) => {
    await member.evaluate(() => { for (const i of document.querySelectorAll('[data-pc="merge-thing-check"]')) if (!i.checked) i.click(); });
    await member.evaluate((b) => document.querySelector(`[data-pc="${b}"]`)?.click(), button);
    await member.waitForFunction(() => document.querySelector('[data-pc="merge-close"]')?.textContent?.trim() === '完成', { timeout: 10000 });
    await member.evaluate(() => document.querySelector('[data-pc="merge-close"]')?.click());
  };
  const screenshot = async (p, file) => {
    await p.evaluate(() => { for (const i of document.querySelectorAll('input[type="password"]')) i.value = ''; });
    await p.screenshot({ path: path.join(root, file + '.png') });
  };
  const authenticate = async () => {
    await member.locator('[data-pc="recovery-auth-open"]').click();
    await member.waitForSelector('form[aria-label="恢复原协作身份"]');
    await member.type('#pc-recovery-username', 'member'); await member.type('#pc-recovery-password', password);
    await member.click('form[aria-label="恢复原协作身份"] button[type="submit"]'); await connected(member, roomId, 'member');
  };
  // Several deliberately invalid identities share this probe's source address. Preserve the
  // production limiter and allow its advertised 60 s cooldown before judging authentication.
  const needsAuth = async () => {
    await member.waitForFunction(() => ['needs-auth', 'damaged'].includes(window.probe.sync.getSyncView().reopenState), { timeout: 120000 });
    assert.equal(await member.evaluate(() => window.probe.sync.getSyncView().reopenState), 'needs-auth');
  };
  const adminFlow = async text => {
    await host.locator('[data-pc="members-button"]').click();
    await host.waitForSelector('[data-pc="members-pop"]');
    await clickText(host, '[data-pc="members-pop"] button', text);
    await host.waitForSelector('[data-pc="creator-verify"]');
    await host.type('#pc-cv-pw', creatorPassword);
    await clickText(host, '[data-pc="creator-verify"] button', '验证');
  };

  phase('existing collaboration settings never generate replacement passwords');
  const generations = await host.evaluate(() => window.recoveryPasswordGenerations);
  await host.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  try {
    await host.waitForSelector('[data-pc="collab-section"]');
    await host.waitForFunction(() => document.querySelector('[data-pc="collab-project-name"]'));
  } finally { await clickText(host, '.pc-dialog button', '取消'); }
  assert.equal(await host.evaluate(() => window.recoveryPasswordGenerations), generations);
  evidence.recoveredSettingsDoNotGeneratePasswords = true;

  phase('temporary local storage failure keeps the identity and retries through the actual editor');
  await member.setRequestInterception(true); let storageAttempts = 0, firstStorageAt, retryStorageAt;
  const storageIntercept = req => {
    if (new URL(req.url()).pathname === '/api/collaboration/select') {
      if (++storageAttempts === 1) {
        firstStorageAt = Date.now();
        void req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'recovery-storage-busy', retryAfter: 2 }) }).catch(() => {});
        return;
      }
      retryStorageAt ??= Date.now();
    }
    void req.continue().catch(() => {});
  };
  member.on('request', storageIntercept);
  try {
    await open(member, memberFile);
    await member.waitForSelector('[data-pc="collaboration-recovery"][data-kind="waiting-storage"]');
    await screenshot(member, 'matrix-storage-waiting');
    await connected(member, roomId, 'member');
    assert.ok(storageAttempts >= 2); assert.ok(retryStorageAt - firstStorageAt >= 2000 - 100, 'storage retry must honor Retry-After');
    evidence.transientStorageRetryUi = { identityPreserved: true, retryAfterSeconds: 2, observedDelayMs: retryStorageAt - firstStorageAt };
  } finally { member.off('request', storageIntercept); await member.setRequestInterception(false); }

  phase('offline edit survives real member process stop and conflict replay UI');
  await member.evaluate(() => window.probe.sync.currentSharedLink().dropFor(60000));
  await member.waitForFunction(() => !window.probe.sync.currentSharedLink().connected);
  await name(member, 'matrix-offline-replay'); await waitJournal();
  await name(host, 'matrix-remote-replay'); await saved(host);
  const beforePid = memberRuntime.pid;
  await member.close(); await stop(memberRuntime.child);
  memberRuntime = await editor('member', 5206); assert.notEqual(memberRuntime.pid, beforePid);
  member = await page(memberRuntime.base); await open(member, memberFile); await mergeWindow();
  // 离线时改的名称在窗口里是「项目设置」一条、二级「名称」,冲突(主机也改了名);本机先回到云端现状
  const replayRow = await member.evaluate(() => document.querySelector('[data-pc="merge-thing"][data-key="offline:settings"]')?.innerText ?? null);
  assert.ok(replayRow && replayRow.includes('matrix-offline-replay') && replayRow.includes('matrix-remote-replay'), `conflict row: ${replayRow}`);
  assert.equal(await member.evaluate(() => window.probe.store.getState().project.name), 'matrix-remote-replay');
  await screenshot(member, 'matrix-conflict-replay');
  await mergeAll('merge-apply');
  await connected(member, roomId, 'member'); await sees(host, 'matrix-offline-replay'); await saved(member);
  evidence.crashRetainsOfflineQueue = true; evidence.conflictReplayUi = true;

  phase('conflict discard UI retains a real local backup');
  // 离线窗口要盖住「成员的离线修改落盘 + 主机的修改保存」:成员先重连的话冲突不会发生。1.2 秒在机器忙时不够(实测落盘 1.7 秒、主机保存 3.4 秒)
  await member.evaluate(() => window.probe.sync.currentSharedLink().dropFor(8000));
  await member.waitForFunction(() => !window.probe.sync.currentSharedLink().connected);
  await name(member, 'matrix-offline-discard'); await waitJournal();
  await name(host, 'matrix-remote-discard'); await saved(host);
  assert.equal(await member.evaluate(() => window.probe.sync.currentSharedLink().connected), false, 'the member reconnected before the remote edit was saved; the conflict cannot occur');
  await mergeWindow();
  await screenshot(member, 'matrix-conflict-discard');
  await mergeAll('merge-delete');
  await connected(member, roomId, 'member'); await sees(member, 'matrix-remote-discard');
  await member.waitForFunction(async room => {
    const list = await (await fetch('/api/project-backups')).json();
    for (const b of list.backups ?? []) if (b.kind === 'offline-discard' && b.projectId === room) {
      const full = await (await fetch(`/api/project-backups/${b.id}`)).json();
      if (full.project?.name === 'matrix-offline-discard' && full.batch?.length) return true;
    }
    return false;
  }, { timeout: 10000 }, roomId);
  evidence.conflictDiscardUi = true; evidence.discardBackupPersisted = true;

  phase('two actual browser windows share the room without re-creating it');
  const sibling = await page(memberRuntime.base); await open(sibling, memberFile); await connected(sibling, roomId, 'member');
  await name(sibling, 'matrix-other-window'); await sees(member, 'matrix-other-window'); await sees(host, 'matrix-other-window');
  await name(member, 'matrix-first-window'); await sees(sibling, 'matrix-first-window'); await saved(member); await sibling.close();
  evidence.multipleWindowsBidirectional = true;

  phase('late device identity answer cannot rejoin after opening another project');
  await member.setRequestInterception(true); let held;
  const intercept = req => { if (!held && new URL(req.url()).pathname === '/api/collaboration/select') held = req; else void req.continue().catch(() => {}); };
  member.on('request', intercept); await open(member, memberFile);
  await new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => {
    if (held) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('No isolated identity request to delay')); }
  }, 20); });
  await member.evaluate(() => window.probe.proc.newProject('matrix-local-project'));
  await held.continue().catch(() => {}); member.off('request', intercept); await member.setRequestInterception(false);
  await member.waitForFunction(() => !window.probe.sync.getSyncView().association && window.probe.sync.getSyncView().kind === 'local');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await member.evaluate(() => window.probe.store.getState().project.name), 'matrix-local-project');
  phase('new collaboration still offers generated defaults in its actual creation UI');
  const localGenerations = await member.evaluate(() => window.recoveryPasswordGenerations);
  await member.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  try {
    await member.waitForSelector('[data-pc="collab-section"]');
    await member.click('[data-pc="collab-toggle"]');
    await member.waitForFunction(() => document.querySelector('#pc-collab-cpw')?.value.length === 16 && document.querySelector('#pc-collab-ppw')?.value.length === 16);
  } finally { await clickText(member, '.pc-dialog button', '取消'); }
  assert.equal(await member.evaluate(() => window.recoveryPasswordGenerations > 0), true);
  assert.equal(await member.evaluate(n => window.recoveryPasswordGenerations > n, localGenerations), true);
  evidence.newCollaborationDefaultPasswordsPreserved = true;
  await open(member, memberFile); await connected(member, roomId, 'member');
  evidence.lateIdentityAfterProjectSwitchIgnored = true;

  phase('actual Home UI clears the old browser recovery entry');
  member.on('dialog', d => void d.accept());
  await member.click('button[title="首页"]');
  await member.waitForFunction(() => !window.probe.sync.getSyncView().shared && !sessionStorage.getItem('pc.shared.resume'));
  assert.equal(new URL(member.url()).searchParams.has('editor'), false);
  await member.reload({ waitUntil: 'domcontentloaded' }); await member.waitForSelector('[data-pc="start-join"]');
  await member.close(); member = await page(memberRuntime.base); await open(member, memberFile); await connected(member, roomId, 'member');
  const pathFile = path.join(root, 'matrix-home.proc'); fs.writeFileSync(pathFile, memberFile);
  const pathPage = await page(memberRuntime.base, pathFile); await connected(pathPage, roomId, 'member');
  pathPage.on('dialog', d => void d.accept()); await pathPage.click('button[title="首页"]');
  await pathPage.waitForSelector('[data-pc="start-join"]'); assert.equal(new URL(pathPage.url()).searchParams.has('open'), false);
  await pathPage.reload({ waitUntil: 'domcontentloaded' }); await pathPage.waitForSelector('[data-pc="start-join"]'); await pathPage.close();
  evidence.homeUiClearsResume = true; evidence.homeAfterSystemPathRefreshStaysHome = true;

  phase('unknown format preserves the association and project in actual editor');
  const future = JSON.parse(memberFile); future.collaboration.version = 2; future.collaboration.future = { preserved: true };
  await open(member, JSON.stringify(future)); await member.waitForSelector('[data-pc="collaboration-recovery"][data-kind="unsupported"]');
  const reserialized = JSON.parse(await saved(member)); assert.deepEqual(reserialized.collaboration, future.collaboration);
  await screenshot(member, 'matrix-unsupported');
  await open(member, memberFile); await connected(member, roomId, 'member'); evidence.unknownFormatUiPreserved = true;

  phase('legacy browser identity migrates to an independent device protected store');
  const legacy = await member.evaluate(async () => {
    const sync = window.probe.sync, descriptor = sync.getSyncView().association;
    const r = await sync.recoveryRequest('select', descriptor, { contentId: window.probe.store.getState().project.id }); return r.selected;
  });
  const legacyRuntime = await editor('legacy-member', 5215), legacyPage = await page(legacyRuntime.base);
  try {
    await legacyPage.evaluate(({ record, roomId, password, where, mode }) => {
      sessionStorage.setItem('pc.shared.resume', JSON.stringify(record));
      localStorage.setItem('pc.shared.local', JSON.stringify({ [roomId]: { projectId: roomId, name: 'legacy-isolated-room', where, mode, projectPassword: password } }));
    }, { record: legacy, roomId, password, where, mode });
    await open(legacyPage, memberFile); await connected(legacyPage, roomId, 'member'); await saved(legacyPage);
    assert.equal(await legacyPage.evaluate(() => JSON.parse(sessionStorage.getItem('pc.shared.resume')).key), 'device-vault');
    assert.equal(await legacyPage.evaluate(async ({ roomId, password }) => {
      const sync = window.probe.sync, v = sync.getSyncView();
      const r = await sync.recoveryRequest('select', v.association, { contentId: window.probe.store.getState().project.id });
      return !JSON.parse(localStorage.getItem('pc.shared.local') ?? '{}')[roomId] && r.settings?.projectPassword === password;
    }, { roomId, password }), true, 'legacy secret view migrates only after reliable protected storage write');
    if (mode === 'free') {
      await legacyPage.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
      try {
        await legacyPage.waitForSelector('[data-pc="collab-project-password"]');
        assert.equal(await legacyPage.evaluate(pw => document.querySelector('[data-pc="collab-project-password"] code')?.textContent === pw, password), true);
      } finally { await clickText(legacyPage, '.pc-dialog button', '取消'); }
      evidence.legacyPasswordViewPreserved = true;
    }
  } finally { await legacyPage.close(); await stop(legacyRuntime.child); }
  const migratedRuntime = await editor('legacy-member', 5215), migratedPage = await page(migratedRuntime.base);
  try { await open(migratedPage, memberFile); await connected(migratedPage, roomId, 'member'); }
  finally { await migratedPage.close(); await stop(migratedRuntime.child); }
  evidence.legacyIdentityMigratedAcrossProcessRestart = true; evidence.legacySecretSettingsMigrated = true;

  phase('previously invited member recovers after invitation revoke and expiry');
  const invite = await host.evaluate(async creatorPassword => {
    const sync = window.probe.sync, v = sync.getSyncView(), r = await sync.adminOp('invite-create', { password: creatorPassword });
    if (!r.ok || !r.reply.code) throw new Error('Isolated invite issuance failed');
    return { code: r.reply.code, candidate: { where: v.shared.where, base: v.shared.base, service: v.association.service, name: v.shared.name, mode: v.shared.mode, projectId: v.shared.projectId } };
  }, creatorPassword);
  const invitedRuntime = await editor('invited-member', 5215), invited = await page(invitedRuntime.base);
  let invitedFile;
  const invitedUser = mode === 'free' ? 'invited-member' : 'member';
  try {
    phase('actual invited identity redemption and first join');
    const joined = await invited.evaluate(async ({ invite, username, password }) => {
      const sync = window.probe.sync, client = await import('/server/auth/client.mjs'), device = await sync.ensureDevice();
      const redeemed = await client.redeemInvite({ base: invite.candidate.base, code: invite.code, username, deviceId: device.deviceId });
      return (await sync.enterShared(invite.candidate, { as: 'member', username, password: redeemed.key ? '' : password, ...(redeemed.key ? { key: redeemed.key } : {}) })).ok;
    }, { invite, username: invitedUser, password }); assert.equal(joined, true);
    await connected(invited, roomId, invitedUser); invitedFile = await saved(invited);
    phase('revoked invitation rejected by the normal client endpoint');
    const revoked = await host.evaluate(async pw => (await window.probe.sync.adminOp('invite-revoke', { password: pw })).ok, creatorPassword); assert.equal(revoked, true);
    const status = await invited.evaluate(async ({ base, code }) => {
      const client = await import('/server/auth/client.mjs'); try { await client.resolveInvite({ base, code }); return 200; } catch (e) { return e.status ?? 'unreachable'; }
    },
      { base: invite.candidate.base, code: invite.code }); assert.equal(status, 404);
    phase('expired invitation rejected by the normal client endpoint');
    const expiring = await host.evaluate(async pw => {
      const r = await window.probe.sync.adminOp('invite-create', { password: pw }, { expiresInSec: 10 });
      if (!r.ok) throw new Error('Isolated expiring invite failed'); return r.reply.code;
    }, creatorPassword);
    await new Promise(r => setTimeout(r, 10500));
    const expiredStatus = await invited.evaluate(async ({ base, code }) => {
      const client = await import('/server/auth/client.mjs'); try { await client.resolveInvite({ base, code }); return 200; } catch (e) { return e.status ?? 'unreachable'; }
    },
      { base: invite.candidate.base, code: expiring }); assert.equal(expiredStatus, 404);
  } finally { await invited.close(); await stop(invitedRuntime.child); }
  const restoredInviteRuntime = await editor('invited-member', 5215), restoredInvite = await page(restoredInviteRuntime.base);
  phase('invited identity persisted before revoke and expiry rejoins from an old file');
  try { await open(restoredInvite, invitedFile); await connected(restoredInvite, roomId, invitedUser); }
  finally { await restoredInvite.close(); await stop(restoredInviteRuntime.child); }
  evidence.invitedIdentitySurvivesRevokeAndExpiry = true;

  phase('actual creator UI kicks the member and shows the refused identity');
  await host.locator('[data-pc="members-button"]').click(); await host.waitForSelector('[data-pc="members-pop"]');
  await host.evaluate(() => {
    const actual = window.probe.sync.getSyncView().members.find(r => r.username === 'member' && r.deviceId === 'probe-member-device-000001');
    const row = [...document.querySelectorAll('.pc-members-row')].find(r => r.querySelector('.pc-members-name')?.textContent?.trim() === actual?.displayName);
    const button = row?.querySelector('.pc-members-kick'); if (!button) throw new Error('No current member kick UI'); button.click();
  });
  await host.waitForSelector('[data-pc="creator-verify"]'); await host.type('#pc-cv-pw', creatorPassword);
  await clickText(host, '[data-pc="creator-verify"] button', '验证'); await host.waitForSelector('[data-pc="kick-dialog"]');
  await clickText(host, '[data-pc="kick-dialog"] button', '踢出');
  await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'rejected');
  await screenshot(member, 'matrix-kicked');
  await open(member, memberFile); await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'rejected');
  await adminFlow('已禁入的设备'); await host.waitForSelector('[data-pc="bans-dialog"]');
  await clickText(host, '[data-pc="bans-dialog"] button', '撤销'); await clickText(host, '[data-pc="bans-dialog"] button', '返回');
  await open(member, memberFile); await connected(member, roomId, 'member');
  evidence.kickAndUnbanUi = true;

  phase('actual creator UI changes member credentials; old file requires authentication');
  if (mode === 'free') {
    // Change and restore the isolated password; the first reopen must reject the cached K.
    const temporaryPassword = 'isolated-matrix-password-' + Date.now();
    for (const next of [temporaryPassword, password]) {
      await adminFlow('改项目密码'); await host.waitForSelector('[data-pc="project-password"]');
      await host.type('#pc-pw-a', next); await host.type('#pc-pw-b', next);
      await clickText(host, '[data-pc="project-password"] button', '确认修改');
      await host.waitForFunction(() => !document.querySelector('[data-pc="project-password"]'));
      if (next === temporaryPassword) {
        await open(member, memberFile); await needsAuth();
        await screenshot(member, 'matrix-password-expired');
      }
    }
    await open(member, memberFile); await needsAuth();
    await authenticate(); evidence.projectPasswordUi = true;
  } else {
    await adminFlow('改名单'); await host.waitForSelector('[data-pc="list-dialog"]');
    await host.click('[data-pc="list-dialog"] button[aria-label="删除 member"]');
    await clickText(host, '[data-pc="list-dialog"] button', '确认修改');
    await member.waitForFunction(() => window.probe.sync.getSyncView().reopenState === 'rejected');
    await open(member, memberFile); await member.waitForFunction(() => ['needs-auth', 'rejected'].includes(window.probe.sync.getSyncView().reopenState));
    const added = await host.evaluate(async pw => {
      const sync = window.probe.sync, cred = await sync.makeCredential(pw.password);
      return (await sync.adminOp('set-list', { password: pw.creatorPassword }, { list: [{ username: 'member', ...cred }] })).ok;
    }, { password, creatorPassword }); assert.equal(added, true);
    await open(member, memberFile); await needsAuth();
    await authenticate(); evidence.listRemovalUi = true;
  }

  const limited = member.recoveryHttpEvidence.filter(r => r.status === 429);
  const cooldowns = limited.map(r => {
    const next = member.recoveryHttpEvidence.find(n => n.route === r.route && n.status !== 204 && n.at > r.at);
    assert.equal(r.retryAfter > 0 && !!next, true, 'observed cooldown must advertise a delay and eventually retry');
    const elapsedMs = next.at - r.at;
    assert.equal(elapsedMs >= r.retryAfter * 1000 - 200, true, 'automatic recovery must not retry before Retry-After');
    return { retryAfterSeconds: r.retryAfter, observedDelayMs: elapsedMs };
  });
  evidence.authenticationRateLimit = { observed: limited.length > 0, cooldowns, eventualReauthentication: true };

  if (where === 'lan') {
    phase('missing original host operation log shows damaged and never seeds an empty room');
    await saved(host); await host.close(); await stop(hostRuntime.child);
    const projects = path.join(root, 'host', 'docservice', 'tenants', roomId, 'projects');
    const ops = fs.readdirSync(projects).find(f => f.endsWith('.ops.ndjson')); assert.ok(ops);
    const file = path.join(projects, ops), backup = file + '.probe-backup'; fs.renameSync(file, backup);
    hostRuntime = await editor('host', 5209); host = await page(hostRuntime.base); await open(host, hostFile);
    await host.waitForSelector('[data-pc="collaboration-recovery"][data-kind="damaged"]');
    assert.equal(fs.existsSync(file), false); await screenshot(host, 'matrix-host-data-missing');
    await host.close(); await stop(hostRuntime.child); fs.renameSync(backup, file);
    hostRuntime = await editor('host', 5209); host = await page(hostRuntime.base); await open(host, hostFile); await connected(host, roomId, 'host');
    await connected(member, roomId, 'member'); evidence.missingHostDataUiNoEmptyRoom = true;
  }
  phase('corrupt protected identity shows damaged and preserves original bytes');
  await saved(member); await member.close(); await stop(memberRuntime.child);
  const vaultFile = path.join(root, 'member', 'collaboration', 'identities.json'), original = fs.readFileSync(vaultFile);
  const corrupted = Buffer.from('{"version":1,"protection":"corrupt"}'); fs.writeFileSync(vaultFile, corrupted);
  memberRuntime = await editor('member', 5206); member = await page(memberRuntime.base); await open(member, memberFile);
  await member.waitForSelector('[data-pc="collaboration-recovery"][data-kind="damaged"]');
  assert.equal(createHash('sha256').update(fs.readFileSync(vaultFile)).digest('hex'), createHash('sha256').update(corrupted).digest('hex'));
  await screenshot(member, 'matrix-corrupt-vault'); await member.close(); await stop(memberRuntime.child); fs.writeFileSync(vaultFile, original);
  memberRuntime = await editor('member', 5206); member = await page(memberRuntime.base); await open(member, memberFile); await connected(member, roomId, 'member');
  evidence.corruptVaultUiPreservesBytes = true;
  await name(host, 'host-edit-after-reopen'); await sees(member, 'host-edit-after-reopen'); await saved(host); await saved(member);
  evidence.finalRevision = await member.evaluate(async () => {
    const sync = window.probe.sync, v = sync.getSyncView();
    return (await sync.recoveryRequest('select', v.association, { contentId: window.probe.store.getState().project.id })).journal.rev;
  });
  return { host, member, hostRuntime, memberRuntime, evidence };
}
