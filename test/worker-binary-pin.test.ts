import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBinaryPin } from "../src/lib/env.js";

// W1-T236: the binary content pin. `config.claudeBin` records a PATH once;
// a path is not content, so the same path can resolve to a rewritten binary
// between runs (a deliberate `npm i -g`, or an autoupdate race — the same
// vanished/rewritten-binary class W1-T113 already distrusts the disk cache
// for). `checkBinaryPin` is the pure comparison a preflight call site wires
// against the recorded and observed `claude --version` strings.

test("a matching binary passes preflight silently — no drift, no reason", () => {
  const result = checkBinaryPin("2.1.216 (Claude Code)", "2.1.216 (Claude Code)");
  assert.deepEqual(result, {
    drift: false,
    recordedVersion: "2.1.216 (Claude Code)",
    actualVersion: "2.1.216 (Claude Code)",
  });
  assert.equal(result.reason, undefined, "the common case must not fabricate a drift reason");
});

test("a version mismatch is ledgered with a named drift reason naming both versions", () => {
  const result = checkBinaryPin("2.1.216 (Claude Code)", "2.1.217 (Claude Code)");
  assert.equal(result.drift, true);
  assert.equal(result.recordedVersion, "2.1.216 (Claude Code)");
  assert.equal(result.actualVersion, "2.1.217 (Claude Code)");
  assert.match(result.reason ?? "", /2\.1\.216 \(Claude Code\)/, "reason must name the recorded version");
  assert.match(result.reason ?? "", /2\.1\.217 \(Claude Code\)/, "reason must name the observed version");
});

test("drift does not throw — it ledgers and lets the caller continue (T197 doctrine, not a hard-fail)", () => {
  assert.doesNotThrow(() => checkBinaryPin("1.0.0", "2.0.0"));
});

test("an empty recorded version (never resolved before) still compares — any observed version is a drift", () => {
  const result = checkBinaryPin("", "2.1.217 (Claude Code)");
  assert.equal(result.drift, true);
  assert.match(result.reason ?? "", /observed 2\.1\.217 \(Claude Code\)/);
});
