import assert from "node:assert/strict";
import test from "node:test";
import { parseSystemdDisplayTimeSpanMicros, systemdDisplayTimeSpanMatchesLimit } from "#src/lib/model-canary-systemd-bwrap-backend.js";

test("W1-T10957: systemd runtime readback accepts exact finite display spans only", () => {
  assert.equal(parseSystemdDisplayTimeSpanMicros("25s"), 25_000_000);
  assert.equal(parseSystemdDisplayTimeSpanMicros("2h 30min"), 9_000_000_000);
  assert.equal(parseSystemdDisplayTimeSpanMicros("500.001ms"), 500_001);
  assert.equal(parseSystemdDisplayTimeSpanMicros("25.000001s"), 25_000_001,
    "systemd's sub-minute display can carry microsecond precision as fractional seconds");

  for (const malformed of ["", "25seconds", "25s  1us", "1us 25s", "1.5us", "500.0001ms", "25.0000001s", "infinity", "-25s"])
    assert.equal(parseSystemdDisplayTimeSpanMicros(malformed), null, `${malformed} must not be accepted`);

  const configuredLimit = 25_000_000;
  const overCap = parseSystemdDisplayTimeSpanMicros("25.000001s");
  assert.ok(overCap !== null && overCap > configuredLimit, "a finite readback over the requested limit must remain distinguishable");
  assert.equal(systemdDisplayTimeSpanMatchesLimit("25s", configuredLimit), true);
  assert.equal(systemdDisplayTimeSpanMatchesLimit("25.000001s", configuredLimit), false,
    "a readback over the exact configured limit must fail effective-property validation");
  assert.equal(systemdDisplayTimeSpanMatchesLimit("24s", configuredLimit), false,
    "a smaller configured limit must also fail effective-property validation");
  assert.equal(systemdDisplayTimeSpanMatchesLimit("infinity", configuredLimit), false);
});
