import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { assertGateProbeRan } from "#test/helpers/gate-probe-evidence.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Added test helpers are overlaid onto the base by the proof runner. Exercise the existing
// caller in its own checkout too, so a copied helper cannot certify an unchanged caller.
let callerOutput: string | undefined;
function runRealGateCaller(): string {
  if (callerOutput !== undefined) return callerOutput;
  const scratch = mkdtempSync(join(tmpdir(), "rmd-gate-probe-caller-"));
  try {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const absentInterpreter = "/rmd-absent-probe-" + randomUUID();
    assert.equal(existsSync(absentInterpreter), false);
    writeFileSync(join(bin, "npm"), "#!" + absentInterpreter + "\n", { mode: 0o755 });
    const title = "W1-T2791 (acceptance 1): running the fast gate's OWN source-size step leaves the tracked tree byte-identical";
    const pattern = "^W1-T2791 [(]acceptance 1[)]: ";
    const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", "tsx", "--test",
      "--test-name-pattern=" + pattern, "test/a-gate-run-leaves-the-tracked-tree-clean.test.ts"], {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024,
      env: { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? ""), NODE_V8_COVERAGE: "", NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(child.error, undefined, "the actual gate fixture must start");
    assert.equal(child.signal, null);
    assert.equal(child.status, 1, "the unexecutable npm probe must fail the actual gate fixture");
    assert.ok(child.stdout.includes("not ok 1 - " + title), "the named real caller must fail");
    assert.match(child.stdout, /^# fail 1$/m);
    callerOutput = child.stdout;
    return callerOutput;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}


test("gate probe diagnostics preserve the real missing-executable refusal", () => {
  const native = spawnSync(join(tmpdir(), `rmd-absent-probe-${randomUUID()}`), [], { stdio: "ignore", timeout: 2000, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(native.error && "code" in native.error ? native.error.code : undefined, "ENOENT");
  assert.ok(native.stdout === null || native.stdout === undefined);
  assert.ok(native.stderr === null || native.stderr === undefined);
  assert.throws(() => assertGateProbeRan("fixture", native), /status null; signal none; code ENOENT/);
  assert.match(runRealGateCaller(), /source-size-signal ran \(status null; signal none; code ENOENT\)/);
});

test("gate probe diagnostics preserve the real native timeout and signal", () => {
  const native = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", timeout: 100, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(native.error && "code" in native.error ? native.error.code : undefined, "ETIMEDOUT");
  assert.equal(native.signal, "SIGTERM");
  assert.equal(native.stdout, null);
  assert.equal(native.stderr, null);
  assert.throws(() => assertGateProbeRan("fixture", native), /status null; signal SIGTERM; code ETIMEDOUT/);
  assert.match(runRealGateCaller(), /source-size-signal ran \(status null; signal none; code ENOENT\)/);
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
