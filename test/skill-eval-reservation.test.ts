import { repoRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { ReservedEvalBinding, ReservedEvalQualificationInput } from "#src/lib/skill-eval-reservation.js";

// Deferred: production acceptance executes named assertions at base, rather than failing module load.
const load = () => import("#src/lib/skill-eval-reservation.js");
const READY = 10_000_000_000;
const MINUTE = 60_000;
const binding: ReservedEvalBinding = {
  proposalId: "skill-draft:proof-preflight:2026-10-13T12:00:00.000Z",
  draftSha256: "a".repeat(64), heldOutSetHash: "b".repeat(64), stackHash: "stack-1",
  sourceHead: "c".repeat(40), nodeVersion: "v24.21.0", lockSha256: "d".repeat(64),
  host: "existing-azure", commandSha256: "e".repeat(64),
};
function fixture(): ReservedEvalQualificationInput {
  const nowMs = READY + 1_000;
  return {
    mode: "reservation-backed", nowMs, binding: { ...binding },
    ready: { requestId: "f".repeat(64), readyAtMs: READY, expiresAtMs: READY + 60 * MINUTE },
    grant: { id: "separate-grant", requestId: "f".repeat(64), binding: { ...binding }, readyAtMs: READY,
      approvedAtMs: READY + 500, admitByMs: READY + 15 * MINUTE, finishByMs: READY + 180 * MINUTE,
      minWorkers: 3, maxCostUsd: 180, perAttemptBudgetUsd: 15, state: "fresh" },
    calibration: { binding: { ...binding }, receiptSha256: "1".repeat(64), observedAtMs: nowMs - 1_000,
      workers: 3, fullRunUpperBoundMs: 80 * MINUTE, shutdownReserveMs: 30_000,
      perWorkerPeakBytes: 512 * 1024 ** 2, peakDiskBytes: 2 * 1024 ** 3, attempts: 12,
      perAttemptBudgetUsd: 15, state: "closed-native" },
    capacity: { observedAtMs: nowMs, host: binding.host, cpuFreeWorkers: 4, memoryFreeBytes: 2 * 1024 ** 3,
      diskFreeBytes: 3 * 1024 ** 3, lease: { id: "owned-lease", owned: true, workers: 3, heldThroughMs: READY + 180 * MINUTE } },
    safeguards: { holdScope: "NEW-implement-only", reservationConsumerVerified: true,
      independentReadyDeadlineVerified: true, durableEscalationAckVerified: true,
      wholeRunTerminationVerified: true, atomicGrantConsumptionVerified: true, ownLeaseReleaseVerified: true },
  };
}

test("the offline v1 eval policy agrees with the operator-approved existing executor bounds", async () => {
  const { RESERVED_EVAL_V1_POLICY } = await load();
  const ready = await import("#src/lib/heavy-build-reservation.js");
  const paired = await import("#src/lib/paired-trial.js");
  const evals = await import("#src/lib/skill-eval.js");
  assert.deepEqual(RESERVED_EVAL_V1_POLICY, { readyEscalationMs: ready.HEAVY_READY_ESCALATION_MS,
    attempts: evals.SKILL_EVAL_HELD_OUT_TASKS * evals.SKILL_EVAL_TRIALS_PER_ARM * evals.SKILL_EVAL_ARMS.length,
    perAttemptMaxUsd: paired.PAIRED_ATTEMPT_MAX_BUDGET_USD });
});

test("reservation-backed eval qualification is default-off and never dispatch permission", async () => {
  const { qualifyReservedSkillEval } = await load();
  for (const mode of [undefined, "quiet-only"] as const) {
    const poison = new Proxy({ mode } as ReservedEvalQualificationInput, {
      get(target, key) { if (key !== "mode") assert.fail(`default-off read ${String(key)}`); return target.mode; },
    });
    assert.deepEqual(qualifyReservedSkillEval(poison), { schema: "skill-eval-reservation-v1", dispatchAllowed: false,
      state: "inert", reason: "reservation-mode-disabled" });
  }
  const input = fixture(), before = structuredClone(input);
  const qualified = qualifyReservedSkillEval(input);
  assert.equal(qualified.state, "qualified");
  assert.equal(qualified.reason, "offline-qualified-not-authorized");
  assert.equal(qualified.dispatchAllowed, false);
  assert.equal(qualified.worstCaseCostUsd, 180);
  assert.equal(qualified.requiredRuntimeMs, 80 * MINUTE + 30_000);
  assert.equal(qualified.workers, 3);
  assert.deepEqual(input, before, "read-only even when evidence fits; no lease or grant is consumed");
});

test("canonical eval consumption uses a persisted approved grant and cannot renew READY on replay", async t => {
  // Keep production acceptance discriminating at the existing base test path:
  // absence of the new consumer is an assertion, never a module-load error.
  const source = pathToFileURL(`${repoRoot()}/src/lib/skill-eval-grant-consumption.ts`);
  const consumer = (existsSync(source) ? await import(source.href) : {}) as typeof import("#src/lib/skill-eval-grant-consumption.js");
  assert.equal(typeof consumer.consumeReservedEvalGrant, "function", "the canonical consumer must exist");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const input = fixture(), readyBefore = structuredClone(input.ready), grantBefore = JSON.stringify(input.grant);
  db.exec(consumer.RESERVED_EVAL_GRANT_TABLE_SQL);
  db.prepare("INSERT INTO reserved_eval_grants(id,grant_json,approval_ref,state) VALUES(?,?,?,'fresh')")
    .run(input.grant!.id, grantBefore, "private-fixture-approval");
  const opts = { enabled: true, grantId: input.grant!.id, runId: "first-fixture", input, db };
  const first = consumer.consumeReservedEvalGrant(opts);
  assert.equal(first.state, "consumed"); assert.equal(first.dispatchAllowed, false);
  assert.equal(db.isTransaction, false, "consumption must commit before returning its receipt");
  assert.deepEqual({ ...db.prepare("SELECT state,run_id,grant_json FROM reserved_eval_grants").get()! },
    { state: "consumed", run_id: "first-fixture", grant_json: grantBefore });
  input.grant!.finishByMs += 60 * MINUTE; // A caller's still-fresh assertion is not canonical authority.
  const replay = consumer.consumeReservedEvalGrant({ ...opts, runId: "replacement-fixture" });
  assert.equal(replay.state, "refused"); assert.equal(replay.dispatchAllowed, false);
  assert.deepEqual(input.ready, readyBefore, "the original READY and terminal history are unchanged");
  assert.equal(db.prepare("SELECT run_id FROM reserved_eval_grants").get()!.run_id, "first-fixture");
});

test("reservation-backed eval never renews original READY on retry or missing approval", async () => {
  const { qualifyReservedSkillEval } = await load();
  const input = fixture(); delete input.capacity;
  const before = qualifyReservedSkillEval(input);
  input.nowMs += 4 * MINUTE;
  const later = qualifyReservedSkillEval(input);
  assert.equal(before.state, "waiting"); assert.equal(later.state, "waiting");
  assert.equal(later.readyDeadlineMs, before.readyDeadlineMs);
  assert.equal(later.admissionDeadlineMs, before.admissionDeadlineMs);
  input.nowMs = input.grant!.admitByMs;
  assert.equal(qualifyReservedSkillEval(input).reason, "fixed-admission-deadline-reached");
  delete input.grant; input.nowMs = input.ready.expiresAtMs;
  assert.deepEqual(qualifyReservedSkillEval(input), { schema: "skill-eval-reservation-v1", dispatchAllowed: false,
    state: "escalate", reason: "original-ready-deadline-reached", readyDeadlineMs: READY + 60 * MINUTE });
  input.nowMs += 24 * 60 * MINUTE;
  assert.equal(qualifyReservedSkillEval(input).readyDeadlineMs, READY + 60 * MINUTE);
  assert.equal(qualifyReservedSkillEval(input).state, "escalate");
});

test("terminal READY history cannot reopen even after clock rollback", async () => {
  const { qualifyReservedSkillEval } = await load();
  for (const terminal of ["released", "escalated"] as const) {
    const input = fixture(); input.ready.terminal = terminal; input.nowMs = READY - 1;
    assert.equal(qualifyReservedSkillEval(input).state, "closed");
    assert.equal(qualifyReservedSkillEval(input).reason, `ready-${terminal}`);
  }
  const malformed = fixture(); malformed.ready.terminal = "other" as "released";
  assert.equal(qualifyReservedSkillEval(malformed).reason, "invalid-terminal-history");
});

test("reservation-backed eval rejects invalid and future original READY observations", async () => {
  const { qualifyReservedSkillEval } = await load();
  const edits: Array<(f: ReservedEvalQualificationInput) => void> = [
    f => { f.nowMs = NaN; }, f => { f.ready.requestId = "unknown"; },
    f => { f.ready.readyAtMs = -1; }, f => { f.ready.expiresAtMs++; },
    f => { f.ready.readyAtMs = Number.MAX_SAFE_INTEGER; f.ready.expiresAtMs = f.ready.readyAtMs + 60 * MINUTE; },
  ];
  for (const edit of edits) { const f = fixture(); edit(f); assert.equal(qualifyReservedSkillEval(f).reason, "invalid-original-ready"); }
  const future = fixture(); future.nowMs = READY - 1;
  assert.equal(qualifyReservedSkillEval(future).reason, "clock-before-original-ready");
  const badBinding = fixture(); badBinding.binding.nodeVersion = "unknown";
  assert.equal(qualifyReservedSkillEval(badBinding).reason, "invalid-workload-binding");
});

test("a separate fresh grant binds every workload input and the original request", async () => {
  const { qualifyReservedSkillEval } = await load();
  const f = fixture(); delete f.grant;
  assert.equal(qualifyReservedSkillEval(f).reason, "separate-live-grant-required");
  for (const state of ["consumed", "revoked"] as const) {
    const input = fixture(); input.grant!.state = state;
    assert.equal(qualifyReservedSkillEval(input).reason, "grant-not-fresh");
  }
  for (const key of Object.keys(binding) as Array<keyof ReservedEvalBinding>) {
    const input = fixture(); input.grant!.binding[key] += "different";
    assert.equal(qualifyReservedSkillEval(input).reason, "grant-workload-or-ready-mismatch", key);
  }
  for (const edit of [
    (f: ReservedEvalQualificationInput) => { f.grant!.requestId = "0".repeat(64); },
    (f: ReservedEvalQualificationInput) => { f.grant!.readyAtMs++; },
    (f: ReservedEvalQualificationInput) => { f.grant!.id = ""; },
  ]) { const input = fixture(); edit(input); assert.equal(qualifyReservedSkillEval(input).reason, "grant-workload-or-ready-mismatch"); }
});

test("fixed eval grants cannot extend READY or spend old author-gate windows", async () => {
  const { qualifyReservedSkillEval } = await load();
  const edits: Array<(f: ReservedEvalQualificationInput) => void> = [
    f => { f.grant!.approvedAtMs = f.nowMs + 1; }, f => { f.grant!.approvedAtMs = -1; },
    f => { f.grant!.admitByMs = f.ready.expiresAtMs + 1; },
    f => { f.grant!.admitByMs = f.grant!.approvedAtMs; },
    f => { f.grant!.finishByMs = f.grant!.admitByMs; }, f => { f.grant!.finishByMs = Infinity; },
    f => { f.grant!.minWorkers = 0; }, f => { f.grant!.maxCostUsd = NaN; },
    f => { f.grant!.perAttemptBudgetUsd = 16; }, f => { f.grant!.perAttemptBudgetUsd = 0; },
  ];
  for (const edit of edits) { const f = fixture(); edit(f); assert.equal(qualifyReservedSkillEval(f).reason, "invalid-fixed-grant"); }
});

test("reservation qualification requires every verified runtime safeguard and NEW-only scope", async () => {
  const { qualifyReservedSkillEval } = await load();
  const f = fixture(); delete f.safeguards;
  assert.equal(qualifyReservedSkillEval(f).reason, "runtime-safeguards-unverified");
  for (const key of Object.keys(fixture().safeguards!) as Array<keyof NonNullable<ReservedEvalQualificationInput["safeguards"]>>) {
    const input = fixture();
    Object.assign(input.safeguards!, { [key]: key === "holdScope" ? "all-work" : false });
    assert.equal(qualifyReservedSkillEval(input).reason, "runtime-safeguards-unverified", key);
  }
});

test("eval calibration requires a closed native exact-workload full-run receipt", async () => {
  const { qualifyReservedSkillEval, EVAL_CALIBRATION_MAX_AGE_MS } = await load();
  const edits: Array<(f: ReservedEvalQualificationInput) => void> = [
    f => { delete f.calibration; }, f => { f.calibration!.receiptSha256 = "not-receipted"; },
    f => { f.calibration!.state = "author-profile" as "closed-native"; },
    f => { f.calibration!.binding.commandSha256 = "2".repeat(64); },
    f => { f.calibration!.observedAtMs = f.nowMs + 1; },
    f => { f.calibration!.observedAtMs = f.nowMs - EVAL_CALIBRATION_MAX_AGE_MS - 1; },
    f => { f.calibration!.workers = 2; }, f => { f.calibration!.fullRunUpperBoundMs = 0; },
    f => { f.calibration!.shutdownReserveMs = 0; }, f => { f.calibration!.perWorkerPeakBytes = 0; },
    f => { f.calibration!.peakDiskBytes = 0; }, f => { f.calibration!.attempts = 11; },
    f => { f.calibration!.perAttemptBudgetUsd = 14; },
  ];
  for (const edit of edits) { const f = fixture(); edit(f); assert.equal(qualifyReservedSkillEval(f).reason, "native-calibration-unverified"); }
  const boundary = fixture(); boundary.calibration!.observedAtMs = boundary.nowMs - EVAL_CALIBRATION_MAX_AGE_MS;
  assert.equal(qualifyReservedSkillEval(boundary).state, "qualified");
});

test("whole eval worst-case spend and shutdown must fit the original finish deadline", async () => {
  const { qualifyReservedSkillEval } = await load();
  const spend = fixture(); spend.grant!.maxCostUsd = 179.99;
  assert.equal(qualifyReservedSkillEval(spend).reason, "approved-spend-does-not-fit");
  const time = fixture(); time.calibration!.fullRunUpperBoundMs = time.grant!.finishByMs - time.nowMs;
  assert.equal(qualifyReservedSkillEval(time).reason, "fixed-runtime-does-not-fit", "shutdown is not free");
  time.calibration!.fullRunUpperBoundMs -= time.calibration!.shutdownReserveMs;
  assert.equal(qualifyReservedSkillEval(time).state, "qualified");
  time.nowMs++; assert.equal(qualifyReservedSkillEval(time).reason, "fixed-runtime-does-not-fit");
  const overflow = fixture(); overflow.calibration!.fullRunUpperBoundMs = Number.MAX_SAFE_INTEGER;
  assert.equal(qualifyReservedSkillEval(overflow).reason, "fixed-runtime-does-not-fit");
});

test("a READY hold alone is never execution capacity and measured telemetry expires", async () => {
  const { qualifyReservedSkillEval, EVAL_CAPACITY_MAX_AGE_MS } = await load();
  const edits: Array<(f: ReservedEvalQualificationInput) => void> = [
    f => { delete f.capacity; }, f => { f.capacity!.host = "foreign-host"; },
    f => { f.capacity!.observedAtMs = f.nowMs + 1; },
    f => { f.capacity!.observedAtMs = f.nowMs - EVAL_CAPACITY_MAX_AGE_MS - 1; },
    f => { f.capacity!.cpuFreeWorkers = NaN; }, f => { f.capacity!.memoryFreeBytes = -1; },
    f => { f.capacity!.diskFreeBytes = Infinity; },
  ];
  for (const edit of edits) { const f = fixture(); edit(f); assert.equal(qualifyReservedSkillEval(f).reason, "capacity-unmeasured-or-stale"); }
  const edge = fixture(); edge.capacity!.observedAtMs = edge.nowMs - EVAL_CAPACITY_MAX_AGE_MS;
  assert.equal(qualifyReservedSkillEval(edge).state, "qualified");
  delete edge.capacity!.lease;
  assert.equal(qualifyReservedSkillEval(edge).reason, "owned-runtime-capacity-does-not-fit");
});

test("owned runtime capacity prices CPU memory disk and lease independently without worker scaling", async () => {
  const { qualifyReservedSkillEval } = await load();
  const edits: Array<(f: ReservedEvalQualificationInput) => void> = [
    f => { f.capacity!.lease!.owned = false; }, f => { f.capacity!.lease!.id = ""; },
    f => { f.capacity!.lease!.workers = 2; }, f => { f.capacity!.lease!.heldThroughMs--; },
    f => { f.capacity!.cpuFreeWorkers = 2; },
    f => { f.capacity!.memoryFreeBytes = f.calibration!.perWorkerPeakBytes * 3 - 1; },
    f => { f.capacity!.diskFreeBytes = f.calibration!.peakDiskBytes - 1; },
    f => { f.calibration!.workers = 4; },
  ];
  for (const edit of edits) { const f = fixture(); edit(f); assert.equal(qualifyReservedSkillEval(f).reason, "owned-runtime-capacity-does-not-fit"); }
  const surplus = fixture(); surplus.capacity!.lease!.workers = 8; surplus.capacity!.cpuFreeWorkers = 8;
  surplus.capacity!.memoryFreeBytes = 8 * 1024 ** 3;
  assert.equal(qualifyReservedSkillEval(surplus).requiredRuntimeMs, 80 * MINUTE + 30_000);
  assert.equal(qualifyReservedSkillEval(surplus).workers, 3, "extra workers do not invent a shorter native fit");
});
