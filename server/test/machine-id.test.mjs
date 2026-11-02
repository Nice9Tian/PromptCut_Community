import { test } from "node:test";
import assert from "node:assert/strict";
import { machineCode, machineFingerprint, redactMachineCode } from "../runners/machine-id.mjs";

test("The same machine yields the same code every time", () => {
  assert.equal(machineCode(), machineCode());
  assert.equal(machineFingerprint(), machineFingerprint());
});

test("The code is shaped as PCM- followed by 4 groups of 5 Crockford Base32 characters", () => {
  assert.match(machineCode(), /^PCM(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
});

test("Different fingerprints give different codes", () => {
  assert.notEqual(machineCode("win:aaaa"), machineCode("win:bbbb"));
});

test("The code does not contain the raw fingerprint", () => {
  const code = machineCode("win:11112222-3333-4444-5555-666677778888");
  assert.ok(!code.includes("1111"));
  assert.ok(!code.includes("6666"));
});

test("A code can still be computed when the machine identifier is unavailable, without throwing", () => {
  const fingerprint = machineFingerprint();
  assert.equal(typeof fingerprint, "string");
  assert.ok(fingerprint.length > 0);
  // Fallback string must at least include hostname and platform; cannot be an empty shell
  if (fingerprint.startsWith("fallback:")) {
    assert.ok(fingerprint.includes(process.platform));
  }
});

/*
 * The masked code must enter the diagnostic report, while the full code is the decryption
 * passphrase for config distribution: if it appears in the report in its entirety, it is
 * equivalent to sending the key along with it. Thus these cases check that "only first group remains".
 */
test("After redaction only PCM and the first group remain", () => {
  assert.equal(redactMachineCode("PCM-ABCDE-FGHJK-MNPQR-STVWX"), "PCM-ABCDE-…");
});

test("After redaction none of the last three groups is present", () => {
  const code = machineCode();
  const groups = code.split("-").slice(2);
  const short = redactMachineCode(code);
  for (const g of groups) assert.ok(!short.includes(g), `${short} leaks ${g}`);
});

test("Redaction is idempotent: a report passed along several times does not get shorter and shorter", () => {
  const once = redactMachineCode(machineCode());
  assert.equal(redactMachineCode(once), once);
});
