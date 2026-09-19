import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { auditLedgerUnion } from "../src/lib/ledger-union.js";
import { MAX_RETAINED_LINES_PER_STEP } from "../src/lib/ledger.js";
import { auditedLifetimeTalliesFromArchives, MAX_LIFETIME_ARCHIVE_START_IDENTITIES } from "../src/run-task.js";
import {
  DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
  effectiveLifetimeDispatches,
  isLifetimeDispatchCapExceeded,
  lifetimeDispatchTally,
} from "../src/lib/status.js";

function runStart(taskId: string, n: number): Record<string, unknown> {
  return { ts: `2026-09-17T00:00:${String(n).padStart(2, "0")}.000Z`, task_id: taskId, run_id: `${taskId}-${n}`, step: "run.start" };
}

function capacityBlocked(taskId: string, n: number): Record<string, unknown> {
  return {
    ts: `2026-09-17T00:01:${String(n).padStart(2, "0")}.000Z`,
    task_id: "DAEMON",
    task: taskId,
    step: "daemon.spawn_infra_blocked",
    reason: "no configured worker subscription has readable headroom",
  };
}

test("W1-T3758: a capacity-blocked dispatch is not charged to the task", () => {
  const taskId = "W1-T3758-CAPACITY";
  const lines = Array.from({ length: DEFAULT_MAX_TASK_LIFETIME_DISPATCHES }, (_, n) => [runStart(taskId, n), capacityBlocked(taskId, n)]).flat();
  const tally = lifetimeDispatchTally(lines, taskId);
  assert.deepEqual(tally, { starts: DEFAULT_MAX_TASK_LIFETIME_DISPATCHES, capacityBlocked: DEFAULT_MAX_TASK_LIFETIME_DISPATCHES });
  assert.equal(effectiveLifetimeDispatches(tally), 0, "each daemon-stamped capacity refusal cancels only its fleet-wide attempt");
  assert.equal(isLifetimeDispatchCapExceeded(lines, taskId), false, "the outage must not permanently cap its victims");
});

test("W1-T3758: a worker that exits on its own still counts", () => {
  const taskId = "W1-T3758-OWN-EXIT";
  const lines = Array.from({ length: DEFAULT_MAX_TASK_LIFETIME_DISPATCHES }, (_, n) => [
    runStart(taskId, n),
    { task_id: taskId, run_id: `${taskId}-${n}`, step: "implement.done", verdict: "failed" },
  ]).flat();
  assert.equal(lifetimeDispatchTally(lines, taskId).capacityBlocked, 0, "a task-owned failure carries no daemon capacity receipt");
  assert.equal(isLifetimeDispatchCapExceeded(lines, taskId), true, "the lifetime cap still protects against a worker that repeatedly dies on its own");
});

test("W1-T3758: the outage-capped population clears", () => {
  // Live ledger reconciliation, 2026-09-18. Each member reached the raw ten-dispatch cap during
  // the squeeze, but its daemon-stamped capacity receipts leave fewer than ten task-attributable
  // attempts. The residual rows deliberately remain task-owned: this is not a capacity-only toy
  // population that could hide the W1-T3523 regression above.
  const observedOutageCapped = [
    ["W1-T3673", 14, 13, 1],
    ["W1-T3674", 13, 12, 1],
    ["W1-T3675", 19, 17, 2],
    ["W1-T3676", 16, 14, 2],
    ["W1-T3677", 11, 10, 1],
    ["W1-T3678", 11, 10, 1],
    ["W1-T3679", 13, 9, 4],
    ["W1-T3718", 12, 10, 2],
    ["W1-T3719", 11, 10, 1],
  ] as const;
  for (const [taskId, starts, blocked, effective] of observedOutageCapped) {
    const lines = Array.from({ length: starts }, (_, n) => [
      runStart(taskId, n),
      ...(n < blocked ? [capacityBlocked(taskId, n)] : [{ task_id: taskId, run_id: `${taskId}-${n}`, step: "implement.done", verdict: "failed" }]),
    ]).flat();
    assert.deepEqual(lifetimeDispatchTally(lines, taskId), { starts, capacityBlocked: blocked }, `${taskId} retains its own non-capacity outcomes`);
    assert.equal(effectiveLifetimeDispatches(lifetimeDispatchTally(lines, taskId)), effective, `${taskId} keeps only its task-attributable attempts`);
    assert.equal(isLifetimeDispatchCapExceeded(lines, taskId), false, `${taskId} is dispatchable after its capacity-only history is re-derived`);
  }
});

test("W1-T3758: the archive tally streams both rotation forms and refuses an unread archive", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-capacity-history-"));
  const taskId = "W1-T3758-ARCHIVE";
  try {
    const gzipRows = [runStart(taskId, 0), capacityBlocked(taskId, 0)].map((row) => JSON.stringify(row)).join("\n") + "\n";
    const plainRows = [runStart(taskId, 1), capacityBlocked(taskId, 1)].map((row) => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson.gz"), gzipSync(gzipRows));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-01-00-000Z.ndjson"), plainRows);
    const seen: string[] = [];
    const result = await auditLedgerUnion(stateDir, {
      step: ["run.start", "daemon.spawn_infra_blocked"],
      dedupeWindowPerStep: 200,
      onRecord: (row) => seen.push(String(row.step)),
    });
    assert.equal(result.ok, true);
    assert.equal(result.archiveCount, 2, "the control proves both gzip and plain rotations were opened");
    assert.deepEqual(seen, ["run.start", "daemon.spawn_infra_blocked", "run.start", "daemon.spawn_infra_blocked"]);

    const tallied = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.deepEqual(tallied.history?.tallyFor(taskId), { starts: 2, capacityBlocked: 2 }, "an absent live file leaves the complete archive projection intact");
    writeFileSync(join(stateDir, "ledger.ndjson"), `${plainRows}not json\n`);
    assert.deepEqual(
      tallied.history?.tallyFor(taskId),
      { starts: 2, capacityBlocked: 2 },
      "the archive snapshot and its retained live copy are charged exactly once while a torn live line stays inert",
    );
    appendFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify(runStart(taskId, 2))}\n${JSON.stringify(capacityBlocked(taskId, 2))}\n`);
    assert.deepEqual(
      tallied.history?.tallyFor(taskId),
      { starts: 3, capacityBlocked: 3 },
      "a later live attempt is incorporated once without re-reading the archive corpus",
    );

    writeFileSync(join(stateDir, "ledger.2026-09-17T00-02-00-000Z.ndjson.gz"), "not gzip");
    const partial = await auditLedgerUnion(stateDir, {
      step: "run.start",
      dedupeWindowPerStep: 200,
      onRecord: () => undefined,
    });
    assert.equal(partial.ok, false, "an unread archive must prevent a retrospective cap exemption");
    assert.equal(partial.unread.length, 1);
    const unavailable = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(unavailable.history, undefined, "the command layer keeps the pre-existing live-only cap when one archive is unreadable");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T3758: the archive projection rolls its bounded replay window without losing rows", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-capacity-history-window-"));
  const taskId = "W1-T3758-ARCHIVE-WINDOW";
  try {
    const rows = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 1 }, (_, n) => [
      runStart(taskId, n),
      capacityBlocked(taskId, n),
    ]).flat();
    const content = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-03-00-000Z.ndjson"), content);

    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(result.records, rows.length, "the full archive remains visible after the ring advances");
    assert.deepEqual(
      result.history?.tallyFor(taskId),
      { starts: MAX_RETAINED_LINES_PER_STEP + 1, capacityBlocked: MAX_RETAINED_LINES_PER_STEP + 1 },
      "the bounded replay window must not drop distinct historical rows from the tally",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T3780: replayed start identity survives the raw replay window", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-capacity-identity-replay-"));
  const taskId = "W1-T3780-REPLAY";
  try {
    const first = [runStart(taskId, 0), capacityBlocked(taskId, 0)].map((row) => JSON.stringify(row)).join("\n") + "\n";
    const noise = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 1 }, (_, n) => runStart(`W1-T3780-NOISE-${n}`, n))
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), first);
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-01-00-000Z.ndjson"), noise);
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-02-00-000Z.ndjson"), `${JSON.stringify(runStart(taskId, 0))}\n`);

    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.deepEqual(result.history?.tallyFor(taskId), { starts: 1, capacityBlocked: 1 });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T3780: distinct starts and task-owned exits remain charged", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-capacity-identity-distinct-"));
  const taskId = "W1-T3780-DISTINCT";
  try {
    const rows = [runStart(taskId, 0), capacityBlocked(taskId, 0), runStart(taskId, 1)];
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const tally = (await auditedLifetimeTalliesFromArchives(stateDir)).history?.tallyFor(taskId);
    assert.deepEqual(tally, { starts: 2, capacityBlocked: 1 });
    assert.equal(effectiveLifetimeDispatches(tally!), 1, "the second, task-owned attempt remains charged");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T3780: outage replay clears without mutating evidence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-capacity-identity-outage-"));
  const taskId = "W1-T3722";
  try {
    const attempts = Array.from({ length: DEFAULT_MAX_TASK_LIFETIME_DISPATCHES }, (_, n) => [runStart(taskId, n), capacityBlocked(taskId, n)]).flat();
    const noise = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 1 }, (_, n) => runStart(`W1-T3780-NOISE-${n}`, n));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), attempts.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-01-00-000Z.ndjson"), noise.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-02-00-000Z.ndjson"), attempts.filter((row) => row.step === "run.start").map((row) => JSON.stringify(row)).join("\n") + "\n");

    const result = await auditedLifetimeTalliesFromArchives(stateDir);
    const tally = result.history?.tallyFor(taskId);
    assert.deepEqual(tally, { starts: 10, capacityBlocked: 10 });
    assert.equal(effectiveLifetimeDispatches(tally!), 0, "the historical projection clears only duplicated capacity-outage attempts");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T3780: unindexable archive history fails closed", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-capacity-identity-refusal-"));
  try {
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"), `${JSON.stringify({ step: "run.start", task_id: "W1-T3780-MISSING" })}\n`);
    const missing = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(missing.history, undefined);
    assert.equal(missing.unavailableReason, "start_identity_missing");

    rmSync(join(stateDir, "ledger.2026-09-17T00-00-00-000Z.ndjson"));
    const rows = Array.from({ length: MAX_LIFETIME_ARCHIVE_START_IDENTITIES + 1 }, (_, n) => runStart("W1-T3780-CEILING", n));
    writeFileSync(join(stateDir, "ledger.2026-09-17T00-01-00-000Z.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const capped = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(capped.history, undefined);
    assert.equal(capped.unavailableReason, "start_identity_ceiling");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
