import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syntheticCodingFixture, codingRequestFixture, parseCodingCandidate, scoreCodingControl,
  executeCodingCandidate, refuseCodingBeforeHost, bindCodingExecutionAuthority } from "#src/lib/model-canary-coding.js";
import { CanarySlotOwner, type CodingAttemptConsumptionCapability } from "#src/lib/model-canary-owner.js";
import { buildCanarySchedule } from "#src/lib/model-canary-schedule.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function privateTestRoot(): string {
  const outsideGit = (candidate: string): boolean => {
    let current = realpathSync(candidate);
    while (true) {
      if (existsSync(join(current, ".git"))) return false;
      const parent = dirname(current);
      if (parent === current) return true;
      current = parent;
    }
  };
  const parent = [tmpdir(), dirname(REPO_ROOT)].find(outsideGit);
  assert.ok(parent, "test host provides scratch outside git markers");
  return mkdtempSync(join(parent, "rmd-coding-authority-"));
}

test("W1-T10957: paired trial results retain correctness, native resource and missing-identity evidence without changing schedules", async () => {
  const fixture = syntheticCodingFixture("paired-trial-control");
  const candidate = parseCodingCandidate(JSON.stringify({ source: "process.stdout.write('0\\n')" }));
  const binding = { caseId: fixture.caseId, suiteHash: "d".repeat(64),
    runId: "572f08c0-7ed1-4a89-a5ef-40b5cd4e4fbe", canaryAttemptId: "a16d15b1-5644-4a7e-b68a-58d454cc4ab1",
    workerSpawnAttemptId: "019f5ab2-4420-4ea0-993f-470a56362e04",
    codingExecutionAttemptId: "74353ef1-5ea2-4a81-930f-cb31399f5e3c",
    slotId: "e".repeat(64), sourceDigest: candidate.sourceDigest };
  const refused = await executeCodingCandidate({ binding, fixture,
    responseText: JSON.stringify({ source: "process.stdout.write('0\\n')" }), authority: null,
    signal: new AbortController().signal });
  const grade = scoreCodingControl(fixture, refused);
  assert.equal(grade.state, "unavailable");
  assert.equal(grade.passed, null);
  assert.equal(grade.reason, "native-backend-unavailable");
  assert.ok(refused.binding, "this result was refused after receiving a valid complete binding");
  const refusedBinding = refused.binding;
  assert.equal(refusedBinding.caseId, "coding-sum-four-v1");
  assert.notEqual(refusedBinding.runId, refusedBinding.canaryAttemptId);
  assert.notEqual(refusedBinding.canaryAttemptId, refusedBinding.workerSpawnAttemptId);
  assert.notEqual(refusedBinding.workerSpawnAttemptId, refusedBinding.codingExecutionAttemptId);
  assert.equal("observed" in refused ? refused.observed : null, null);
  assert.deepEqual(refused.execution, { hostStarted: "no", closure: "proven", hostExecutionId: null });

  // In the full test, compare schedule digests and pair joins before/after adding coding cases;
  // require separate scaffold/tool-inventory hashes for nonmatching arms. No synthetic fixture,
  // configured limit, or JSON-shaped native receipt may supply an observed peak or passed grade.
  assert.throws(() => buildCanarySchedule("not-a-date", "seed", [], [], false), /day-or-seed-invalid/);
});

test("coding candidate schema is bounded and expected output never enters the provider request", () => {
  const fixture = syntheticCodingFixture("request-split-control");
  const request = codingRequestFixture(fixture);
  assert.equal(request.fixtureDigest, fixture.digest);
  assert.equal(JSON.stringify(request).includes(fixture.expectedStdout), false);
  assert.equal(parseCodingCandidate(JSON.stringify({ source: "process.stdout.write('ok\\n')" })).source,
    "process.stdout.write('ok\\n')");
  assert.throws(() => parseCodingCandidate(JSON.stringify({ source: "x", expectedStdout: "secret" })), /shape-invalid/);
  assert.throws(() => parseCodingCandidate(JSON.stringify({ source: "\0" })), /source-bound/);
  assert.throws(() => scoreCodingControl({ ...fixture, expectedStdout: "forged\n" }, refuseCodingBeforeHost("native-backend-unavailable")),
    /coding-fixture-invalid/);
});

test("pre-host refusal stays unavailable and cannot create a qualified coding score", () => {
  const fixture = syntheticCodingFixture("missing-worker-identity");
  const refused = refuseCodingBeforeHost("worker-spawn-identity-unavailable");
  assert.equal(refused.binding, null);
  assert.deepEqual(refused.execution, { hostStarted: "no", closure: "proven", hostExecutionId: null });
  const grade = scoreCodingControl(fixture, refused);
  assert.equal(grade.state, "unavailable");
  assert.equal(grade.passed, null);
  assert.equal(grade.observedCorrectness, null);
});

test("coding execution authority requires the exact opaque owner consumption capability", () => {
  const fixture = syntheticCodingFixture("authority-owner-binding");
  const candidate = parseCodingCandidate(JSON.stringify({ source: "process.stdout.write('0\\n')" }));
  const binding = { caseId: fixture.caseId, suiteHash: "d".repeat(64),
    runId: "572f08c0-7ed1-4a89-a5ef-40b5cd4e4fbe", slotId: "e".repeat(64),
    canaryAttemptId: "a16d15b1-5644-4a7e-b68a-58d454cc4ab1",
    workerSpawnAttemptId: "019f5ab2-4420-4ea0-993f-470a56362e04",
    codingExecutionAttemptId: "74353ef1-5ea2-4a81-930f-cb31399f5e3c", sourceDigest: candidate.sourceDigest };
  const jsonLookalike = Object.freeze({ kind: "canary-coding-attempt-consumed-v1", binding });
  assert.throws(() => bindCodingExecutionAuthority({ binding, configured: {} as never,
    execute: async () => { throw new Error("must-not-run"); },
    consumption: jsonLookalike as unknown as CodingAttemptConsumptionCapability }),
  /coding-owner-consumption-capability-required/);
});

test("one owner consumption capability invokes the coding executor at most once", async () => {
  const root = privateTestRoot();
  const directory = join(root, "owner"); mkdirSync(directory, { mode: 0o700 });
  const owner = new CanarySlotOwner(directory);
  const fixture = syntheticCodingFixture("one-shot-executor");
  const responseText = JSON.stringify({ source: "process.stdout.write('0\\n')" });
  const candidate = parseCodingCandidate(responseText);
  const slot = { id: "e".repeat(64), caseId: fixture.caseId,
    pin: { model: "synthetic", route: "coding-control", effort: "medium", suiteHash: "d".repeat(64), billing: "api" as const },
    aaLabel: null };
  const runId = "572f08c0-7ed1-4a89-a5ef-40b5cd4e4fbe";
  const canaryAttemptId = "a16d15b1-5644-4a7e-b68a-58d454cc4ab1";
  const workerSpawnAttemptId = "019f5ab2-4420-4ea0-993f-470a56362e04";
  assert.equal(owner.claim(slot), "claimed");
  const consumed = owner.consumeCodingAttempt(slot, { runId, canaryAttemptId, workerSpawnAttemptId,
    sourceDigest: candidate.sourceDigest });
  assert.equal(consumed.state, "consumed");
  if (consumed.state !== "consumed") throw new Error("owner-consumption-control-failed");
  const binding = { caseId: slot.caseId, suiteHash: slot.pin.suiteHash, runId, slotId: slot.id,
    canaryAttemptId, workerSpawnAttemptId, codingExecutionAttemptId: consumed.capability.binding.codingExecutionAttemptId,
    sourceDigest: candidate.sourceDigest };
  const configured = { profileId: "test-profile", profileDigest: "1".repeat(64), binaryDigest: "2".repeat(64),
    runtimeId: "node-source-stdin-stdout-v1" as const, cpuQuotaMicros: 100_000, memoryMaxBytes: 32 * 1024 * 1024,
    swapMaxBytes: 0, tasksMax: 8, scratchMaxBytes: 1024 * 1024, wallMaxMs: 1000,
    stdoutMaxBytes: 4096, stderrMaxBytes: 4096, heapMaxBytes: 8 * 1024 * 1024 };
  let calls = 0;
  const authority = bindCodingExecutionAuthority({ binding, configured, consumption: consumed.capability,
    execute: async () => { calls++; throw new Error("executor-closure-unknown-control"); } });
  try {
    const first = await executeCodingCandidate({ binding, fixture, responseText, authority, signal: new AbortController().signal });
    assert.equal(first.state, "unavailable");
    assert.equal(first.reason, "native-executor-error");
    const duplicate = await executeCodingCandidate({ binding, fixture, responseText, authority, signal: new AbortController().signal });
    assert.equal(duplicate.state, "unavailable");
    assert.equal(duplicate.reason, "owner-attempt-already-consumed");
    assert.equal(calls, 1);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});
