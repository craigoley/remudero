import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertGateProbeRan } from "#test/helpers/gate-probe-evidence.js";

test("gate probe diagnostics preserve the real missing-executable refusal", () => {
  const native = spawnSync(join(tmpdir(), `rmd-absent-probe-${randomUUID()}`), [], { stdio: "ignore", timeout: 2000, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(native.error && "code" in native.error ? native.error.code : undefined, "ENOENT");
  assert.ok(native.stdout === null || native.stdout === undefined);
  assert.ok(native.stderr === null || native.stderr === undefined);
  assert.throws(() => assertGateProbeRan("fixture", native), /status null; signal none; code ENOENT/);
});

test("gate probe diagnostics preserve the real native timeout and signal", () => {
  const native = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", timeout: 100, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(native.error && "code" in native.error ? native.error.code : undefined, "ETIMEDOUT");
  assert.equal(native.signal, "SIGTERM");
  assert.equal(native.stdout, null);
  assert.equal(native.stderr, null);
  assert.throws(() => assertGateProbeRan("fixture", native), /status null; signal SIGTERM; code ETIMEDOUT/);
});

test("gate probe diagnostics retain ordinary real zero and one exits", () => {
  for (const code of [0, 1]) {
    const native = spawnSync(process.execPath, ["-e", `process.exit(${code})`], { stdio: "ignore", timeout: 2000, env: { ...process.env, NODE_V8_COVERAGE: "" } });
    assert.equal(native.status, code);
    assert.doesNotThrow(() => assertGateProbeRan("fixture", native));
  }
});

test("gate probe diagnostics do not retain child output above the old capture ceiling", () => {
  const native = spawnSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024))"], { stdio: "ignore", timeout: 5000, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(native.status, 0);
  assert.equal(native.stdout, null);
  assert.equal(native.stderr, null);
  assert.doesNotThrow(() => assertGateProbeRan("fixture", native));
});

test("gate probe diagnostics retain unknown native evidence without arbitrary error text", () => {
  const secret = "arbitrary-private-error-text";
  for (const error of [new Error(secret), Object.assign(new Error(secret), { code: secret })]) {
    assert.throws(() => assertGateProbeRan("fixture", { status: null, signal: null, error }), failure => {
      assert(failure instanceof Error);
      assert.match(failure.message, /status null; signal none; code unclassified/);
      assert(!failure.message.includes(secret));
      return true;
    });
  }
});

test("gate probe diagnostics refuse a missing status without inventing a native error", () => {
  assert.throws(() => assertGateProbeRan("fixture", { status: null, signal: null }), /status null; signal none; code none/);
});


test("gate probe diagnostics distinguish an unclassified signal from no signal", () => {
  assert.throws(() => assertGateProbeRan("fixture", { status: null, signal: "SIG_PRIVATE_PAYLOAD" as NodeJS.Signals }), /status null; signal unclassified; code none/);
});
