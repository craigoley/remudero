/**
 * W1-T2742 — a proof that ran out of TIME concluded nothing; it did not fail.
 *
 * MEASURED (2026-09-03, current main): `execFileSync` kills a child at `timeoutMs` with SIGTERM,
 * but `node --test` TRAPS SIGTERM and shuts down cleanly, so the thrown error carries
 * `status: 1`, `signal: null`, `killed: undefined` — indistinguishable from an ordinary failing
 * test run by every field `execWhitelistedProof` used to consult. Its
 * `typeof err.status !== "number"` guard therefore never fired, and a proof whose only sin was
 * running longer than `proofTimeoutMs` was graded `executed_fail`, which OVERRIDES keyword
 * coverage and fails the PR outright. That is how PR #3719 was refused on
 * `test/retro-marker-atomic.test.ts` — a suite that PASSES 33/33.
 *
 * Node does set `code: "ETIMEDOUT"` on the timeout error whatever the child did with the signal,
 * and that is the one field which discriminates. These tests pin both directions: a timeout must
 * THROW (the caller's exec_error path — no conclusion), and a genuine nonzero exit must still
 * return "fail", so the fix cannot be a blanket suppression of real failures.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execWhitelistedProof, parseWhitelistedProof, type ProofSpawner } from "../src/lib/review.js";
import { loadDefaultPolicy } from "../src/lib/policy.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF = "unit test: test/a-proof-timeout-is-not-a-failed-proof.test.ts";

/** The EXACT error shape a real `execFileSync` timeout produces against `node --test` — see the
 *  file header for the measurement. `signal`/`killed` are deliberately the useless values Node
 *  actually reports, not the ones a reader would expect. */
function timedOutSpawner(): ProofSpawner {
  return () => {
    throw Object.assign(new Error("spawnSync node ETIMEDOUT"), {
      status: 1,
      signal: null,
      killed: undefined,
      code: "ETIMEDOUT",
      stdout: "TAP version 13\n",
    });
  };
}

/** A GENUINE failing run: clean nonzero exit, no timeout code. The control for the fix. */
function failedSpawner(): ProofSpawner {
  return () => {
    throw Object.assign(new Error("Command failed"), {
      status: 1,
      signal: null,
      stdout: "TAP version 13\nnot ok 1 - a real assertion failed\n1..1\n# fail 1\n",
    });
  };
}

test("W1-T2742: a proof killed by the timeout THROWS (exec_error) instead of returning a verdict", () => {
  const w = parseWhitelistedProof(PROOF);
  assert.ok(w, "the fixture proof must parse");
  assert.throws(
    () => execWhitelistedProof(w!, REPO_ROOT, 60_000, timedOutSpawner()),
    /ETIMEDOUT/,
    "a timeout must reach the caller as exec_error — grading it 'fail' asserts a criterion is unmet on a proof that never finished running",
  );
});

test("W1-T2742: a GENUINE clean nonzero exit still returns 'fail' — the fix is not a blanket suppression", () => {
  const w = parseWhitelistedProof(PROOF);
  assert.ok(w);
  assert.equal(
    execWhitelistedProof(w!, REPO_ROOT, 60_000, failedSpawner()),
    "fail",
    "a real failing test must still be a fail, or the timeout fix would hide every genuine refusal",
  );
});

test("W1-T2742: proofTimeoutMs is raised to 180000 and stays inside its own declared envelope", () => {
  const policy = loadDefaultPolicy();
  assert.equal(policy.values.proofTimeoutMs, 180_000, "the operating value moved");
  const row = (policy as unknown as { fields?: Record<string, { min?: number; max?: number }> }).fields?.proofTimeoutMs;
  if (row) {
    assert.ok(row.min === undefined || 180_000 >= row.min, "never below the ruled floor");
    assert.ok(row.max === undefined || 180_000 <= row.max, "never above the declared ceiling");
  }
});
