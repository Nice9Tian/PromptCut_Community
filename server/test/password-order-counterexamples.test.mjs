import test from 'node:test';
import assert from 'node:assert/strict';

// 可执行反例：断言的是错误方案确实违反尺子，不把这些桩当正确实现的证明。
const evidence = (caseId, value) => console.log(JSON.stringify({ counterexample: caseId, ...value }));
test('password-order counterexample: 独立 UTC 时钟把密码之后的接受误归密码之前', () => {
  const password = { utc: 100, order: 1 };
  const operation = { utc: 90, order: 2 };
  assert.notEqual(operation.utc > password.utc, operation.order > password.order);
  evidence('utc-reversal', { naiveSelected: false, actualAfterPassword: true });
});
test('password-order counterexample: reserve 先于改密不代表 seal 先于改密', () => {
  const trace = ['reserve', 'password', 'seal'];
  assert.equal(trace.indexOf('reserve') > trace.indexOf('password'), false);
  assert.equal(trace.indexOf('seal') > trace.indexOf('password'), true);
  evidence('reservation-is-not-acceptance', { trace, naiveSelected: false, correctSelected: true });
});
test('password-order counterexample: sealed ACK 丢失后的盲重试产生两个外部效果', () => {
  let effects = 0;
  const ledger = [];
  const naiveSubmit = (loseAck) => { effects++; ledger.push('sealed'); if (loseAck) throw new Error('ACK lost'); };
  assert.throws(() => naiveSubmit(true), /ACK lost/);
  naiveSubmit(false);
  assert.equal(effects, 2);
  assert.equal(ledger[0], 'sealed');
  evidence('lost-seal-ack', { effects, firstState: ledger[0], incorrectlyTreatAsCancelled: true });
});
test('password-order counterexample: 未核 fence 的 prepared 重放穿过 stop/private', () => {
  for (const kind of ['stop', 'private']) {
    const state = { prepared: { next: 1 }, fence: kind, visible: 0 };
    state.visible = state.prepared.next;
    assert.equal(state.visible, 1);
    evidence('prepared-crosses-fence', { kind, accepted: false, wronglyVisible: state.visible });
  }
});
test('password-order counterexample: 改密前等待离线 doc 违反先成功后选择流程', async () => {
  let passwordWritten = false;
  const naiveChange = async () => { await Promise.reject(new Error('doc 503')); passwordWritten = true; };
  await assert.rejects(naiveChange, /doc 503/);
  assert.equal(passwordWritten, false);
  evidence('password-depends-on-doc', { docOnline: false, passwordWritten, violatesPasswordFirst: true });
});
