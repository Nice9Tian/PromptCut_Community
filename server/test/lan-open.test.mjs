/**
 * `server/lan-open.mjs` 的单测：「在手机上打开」要的那点信息（语义 `mechanism/platforms.md`「局域网里的第二块屏」）。
 * 纯函数，不起进程、不碰网络。跨设备进项目走的是邀请链接那条路，链接由页面自己拼，本模块只答「绑没绑局域网、地址是哪几个」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAN_HOST_COMMAND, boundToLan, lanOpenInfo, linkOnLan } from '../lan-open.mjs';

test('LO1 绑没绑局域网按实际监听地址判', () => {
  for (const a of ['0.0.0.0', '::', '[::]', '', '192.168.1.23', '10.0.0.5', '::ffff:192.168.1.23']) {
    assert.equal(boundToLan(a), true, `${a} 应当算可达`);
  }
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) {
    assert.equal(boundToLan(a), false, `${a} 应当算只绑回环`);
  }
  // 判不出来按不可达算
  assert.equal(boundToLan(undefined), false);
  assert.equal(boundToLan(null), false);
  assert.equal(boundToLan(5190), false);
});

test('LO2 只绑回环时一个地址都不给,只给起法', () => {
  const info = lanOpenInfo({ bound: '127.0.0.1', port: 5190, nics: [{ name: 'Wi-Fi', address: '192.168.1.23' }] });
  assert.equal(info.lanHost, false);
  assert.deepEqual(info.addresses, [], '编辑器只绑回环时手机连不上,列地址没有意义');
  assert.equal(info.command, LAN_HOST_COMMAND);
});

test('LO3 绑了局域网:几块网卡给几条,用户自己挑网段', () => {
  const info = lanOpenInfo({
    bound: '0.0.0.0',
    port: 5190,
    nics: [{ name: 'Wi-Fi', address: '192.168.1.23' }, { name: '以太网', address: '10.0.0.5' }],
  });
  assert.equal(info.lanHost, true);
  assert.equal(info.port, 5190);
  assert.deepEqual(info.addresses, [
    { name: 'Wi-Fi', address: '192.168.1.23' },
    { name: '以太网', address: '10.0.0.5' },
  ]);
});

test('LO4 端口拿不到(服务还没监听)时不给地址', () => {
  const info = lanOpenInfo({ bound: '0.0.0.0', port: null, nics: [{ name: 'Wi-Fi', address: '192.168.1.23' }] });
  assert.equal(info.port, null);
  assert.deepEqual(info.addresses, []);
});

test('LO5 网卡表是空的、缺地址、或根本不是数组,都不抛', () => {
  assert.deepEqual(lanOpenInfo({ bound: '0.0.0.0', port: 5190, nics: [] }).addresses, []);
  assert.deepEqual(lanOpenInfo({ bound: '0.0.0.0', port: 5190, nics: null }).addresses, []);
  assert.deepEqual(lanOpenInfo({ bound: '0.0.0.0', port: 5190, nics: [{ name: '坏的' }, { address: '' }] }).addresses, []);
  assert.deepEqual(lanOpenInfo().addresses, []);
});

test('LO6 邀请链接落不落在本机网卡上:界面据此判断手机打不打得开', () => {
  const addrs = [{ address: '192.168.1.23' }, { address: '10.0.0.5' }];
  assert.equal(linkOnLan('http://192.168.1.23:5190/editor#invite=abc', addrs), true);
  assert.equal(linkOnLan('http://10.0.0.5:5190/editor', addrs), true);
  assert.equal(linkOnLan('192.168.1.23', addrs), true, '只给主机名也认');
  assert.equal(linkOnLan('http://127.0.0.1:5190/editor#invite=abc', addrs), false, '回环的链接手机打不开');
  assert.equal(linkOnLan('http://192.168.9.9:5190/editor', addrs), false);
  assert.equal(linkOnLan('', addrs), false);
  assert.equal(linkOnLan(null, addrs), false);
  assert.equal(linkOnLan('http://192.168.1.23:5190/', []), false);
  assert.equal(linkOnLan('http://192.168.1.23:5190/'), false);
});
