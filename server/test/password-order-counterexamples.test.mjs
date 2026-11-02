import test from 'node:test';
import assert from 'node:assert/strict';

// Executable counterexamples: asserts that wrong approaches indeed violate the ruler, without
// treating these stubs as proof of correct implementation.
const evidence = (caseId, value) => console.log(JSON.stringify({ counterexample: caseId, ...value }));
test('password-order counterexample: an independent UTC clock misattributes an acceptance after the password to before the password', () => {
  const password = { utc: 100, order: 1 };
  const operation = { utc: 90, order: 2 };
  assert.notEqual(operation.utc > password.utc, operation.order > password.order);
  evidence('utc-reversal', { naiveSelected: false, actualAfterPassword: true });
});
test('password-order counterexample: reserve preceding the password change does not mean seal precedes the password change', () => {
  const trace = ['reserve', 'password', 'seal'];
  assert.equal(trace.indexOf('reserve') > trace.indexOf('password'), false);
  assert.equal(trace.indexOf('seal') > trace.indexOf('password'), true);
  evidence('reservation-is-not-acceptance', { trace, naiveSelected: false, correctSelected: true });
});
test('password-order counterexample: a blind retry after a lost sealed ACK produces two external effects', () => {
  let effects = 0;
  const ledger = [];
  const naiveSubmit = (loseAck) => { effects++; ledger.push('sealed'); if (loseAck) throw new Error('ACK lost'); };
  assert.throws(() => naiveSubmit(true), /ACK lost/);
  naiveSubmit(false);
  assert.equal(effects, 2);
  assert.equal(ledger[0], 'sealed');
  evidence('lost-seal-ack', { effects, firstState: ledger[0], incorrectlyTreatAsCancelled: true });
});
test('password-order counterexample: a replay of prepared without a fence check passes through stop/private', () => {
  for (const kind of ['stop', 'private']) {
    const state = { prepared: { next: 1 }, fence: kind, visible: 0 };
    state.visible = state.prepared.next;
    assert.equal(state.visible, 1);
    evidence('prepared-crosses-fence', { kind, accepted: false, wronglyVisible: state.visible });
  }
});
test('password-order counterexample: waiting for an offline doc before the password change violates the succeed-first, choose-later flow', async () => {
  let passwordWritten = false;
  const naiveChange = async () => { await Promise.reject(new Error('doc 503')); passwordWritten = true; };
  await assert.rejects(naiveChange, /doc 503/);
  assert.equal(passwordWritten, false);
  evidence('password-depends-on-doc', { docOnline: false, passwordWritten, violatesPasswordFirst: true });
});
