/**
 * 本机协作恢复信息的保护存储(`server/recovery/vault.mjs`)装得下大项目的离线修改记录。
 *
 * 原问题(做「搬到云端」时撞上的,两处):Windows 上保护存储经 PowerShell 调 DPAPI,
 *   一 `spawnSync` 的输出上限是缺省的 1 MiB:房间里的项目正文一过约 780 KB,离线修改记录就写不进去
 *      (ENOBUFS → 接口回 503「无法可靠读取或保存协作恢复信息」),页面的保存、取消多用户协作、搬到云端都跟着失败;
 *   二 核对输出是不是 base64 的那条正则带分组重复,输出到几 MB 时把调用栈撑爆(RangeError)。
 *
 *   RVL-01 正文 160 万字符的离线修改记录:写得进去;另开一个实例(等于重启)读回来一字不差
 *   RVL-02 输出上限是个明确的数(与恢复接口请求体同一个量级),不是缺省值
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRecoveryVault, PROTECT_MAX_BUFFER } from '../recovery/vault.mjs';

test('RVL-01 大项目的离线修改记录写得进保护存储、重开读得回来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-vault-large-'));
  try {
    const descriptor = { version: 1, roomId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', service: 'http://127.0.0.1:1', where: 'lan' };
    const project = { id: 'content', name: '大正文', tracks: [], media: [], note: '正文'.repeat(800_000) };
    const journal = { version: 1, projectId: descriptor.roomId, project, rev: 7, offlineRev: null, pending: [] };
    assert.ok(Buffer.byteLength(JSON.stringify(journal)) > 4 * 1024 * 1024, '记录本身大于 4 MiB');
    openRecoveryVault({ dir }).journal(descriptor, 'content', journal);
    const back = openRecoveryVault({ dir }).select(descriptor, 'content').journal;
    assert.equal(back.rev, 7);
    assert.equal(back.project.note.length, 1_600_000);
    assert.deepEqual(back, journal);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RVL-02 保护存储的输出上限是个明确的数', () => {
  assert.equal(PROTECT_MAX_BUFFER, 256 * 1024 * 1024);
  assert.ok(PROTECT_MAX_BUFFER >= 64 * 1024 * 1024, '不小于恢复接口请求体的上限');
});
