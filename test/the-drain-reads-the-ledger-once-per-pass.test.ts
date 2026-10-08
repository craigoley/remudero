import assert from "node:assert/strict";
import fs, { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { nextRunnable, runDrain, runnableCandidateIds, runnableCandidates, type NextRunnableOpts } from "../src/lib/drain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { auditedLifetimeTalliesFromArchives, breakerGateFor } from "../src/run-task.js";
import { ledgerIndexBuildCount } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}drain-ledger-pass-`));
  const path = join(root, "ledger.ndjson");
  writeFileSync(path, "");
  const planPath = join(root, "tasks.yaml");
  const ids = ["W1-T1", "W1-T2", "W1-T3", "W1-T4"];
  writeFileSync(planPath, ids.map(id => `- id: ${id}\n  title: ${id}\n  type: implement\n  repo: remudero\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  return { path, plan: loadPlan(planPath), ids };
}

function selectionOpts(gate: ReturnType<typeof breakerGateFor>): Pick<NextRunnableOpts, "beginSelectionPass" | "isIndeterminate" | "isCircuitTripped" | "isLifetimeCapExceeded"> {
  return {
    beginSelectionPass: gate.beginSelectionPass,
    isIndeterminate: gate.isIndeterminate,
    isCircuitTripped: gate.isTripped,
    isLifetimeCapExceeded: gate.isLifetimeCapExceeded,
  };
}

function countReads(t: TestContext, path: string): () => number {
  const originalRead = fs.readFileSync;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const fds = new Set<number>();
  let reads = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof originalOpen>) => {
    const fd = Reflect.apply(originalOpen, fs, args);
    if (args[0] === path) fds.add(fd);
    return fd;
  });
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof originalRead>) => {
    if (args[0] === path || (typeof args[0] === "number" && fds.has(args[0]))) reads++;
    return Reflect.apply(originalRead, fs, args);
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    fds.delete(fd);
    return originalClose(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => reads;
}

test("W1-T6358: one selection pass reads the ledger once", t => {
  const { path, plan, ids } = fixture();
  const reads = countReads(t, path);
  const gate = breakerGateFor(path, undefined);
  const builds = ledgerIndexBuildCount();
  assert.deepEqual(runnableCandidates(plan, () => false, ids.length, selectionOpts(gate)).map(task => task.id), ids);
  assert.equal(reads(), 1, "positive control: all four candidates reached the real ledger reader");
  assert.equal(ledgerIndexBuildCount() - builds, 1, "the rows are also indexed once");
});

test("W1-T6358: archive-backed lifetime pressure shares the file read and observes appends and rotations", async t => {
  const { path, plan, ids } = fixture();
  const row = JSON.stringify({ step: "run.start", task_id: ids[0], run_id: "archived" });
  writeFileSync(join(path, "..", "ledger.2026-10-08T00-00-00-000Z.ndjson"), row + "\n");
  writeFileSync(path, "");
  const audited = await auditedLifetimeTalliesFromArchives(join(path, ".."), path);
  assert.equal(audited.archiveCount, 1, "positive control: the archive was actually opened");
  assert.ok(audited.history);
  const reads = countReads(t, path);
  const gate = breakerGateFor(path, undefined, audited.history);
  const opts = selectionOpts(gate);
  runnableCandidateIds(plan, () => false, opts);
  assert.equal(reads(), 1, "neither the breaker nor the lifetime overlay rereads per candidate");
  assert.equal(gate.isLifetimeCapExceeded(ids[0]), false, "one archived attempt alone produces no pressure");
  appendFileSync(path, JSON.stringify({ step: "run.start", task_id: ids[0], run_id: "new" }) + "\n");
  runnableCandidateIds(plan, () => false, opts);
  assert.equal(reads(), 2);
  assert.equal(gate.isLifetimeCapExceeded(ids[0]), true, "the next pass includes the new attempt");
  renameSync(path, path + ".old");
  writeFileSync(path, row + "\n" + JSON.stringify({ step: "run.start", task_id: ids[0], run_id: "new" }) + "\n");
  runnableCandidateIds(plan, () => false, opts);
  assert.equal(reads(), 3);
  assert.equal(gate.isLifetimeCapExceeded(ids[0]), true);
});

for (const laneCount of [1, 2]) {
  for (const loop of ["drain", "daemon"] as const) {
    test(`W1-T6358: ${loop} forwards snapshot renewal at laneCount ${laneCount}`, async t => {
      const { path, plan, ids } = fixture();
      const reads = countReads(t, path);
      const gate = breakerGateFor(path, undefined);
      const merged = new Set<string>();
      let passes = 0;
      let refills = 0;
      const deps = {
        ...selectionOpts(gate),
        beginSelectionPass() { passes++; gate.beginSelectionPass(); },
        refreshMerged: () => (id: string) => merged.has(id),
        runOne: async (id: string) => {
          merged.add(id);
          return { taskId: id, runId: id, verdict: "merged" as const, merged: true, costUsd: 0 };
        },
        sleep: async () => {},
        log: (step: string) => { if (step === "dispatch.lane_refilled") refills++; },
      };
      const summary = loop === "drain"
        ? await runDrain(plan, deps, { max: ids.length, laneCount })
        : await runDaemon(plan, deps, { max: ids.length, laneCount });
      assert.deepEqual([...summary.merged].sort(), ids);
      assert.ok(passes >= 2, "the loop made multiple selections");
      assert.ok(reads() > 0, "the selectors reached the file");
      assert.ok(reads() <= passes, "at most one read in each selection, including daemon lane refills");
      if (loop === "daemon" && laneCount === 2) assert.ok(refills > 0, "the daemon exercised lane refill selection");
    });
  }
}

test("W1-T6358: eligibility answers are unchanged", () => {
  const { path, plan, ids } = fixture();
  const rows = [
    ...Array.from({ length: 5 }, () => ({ step: "run.start", task_id: ids[0] })),
    ...Array.from({ length: 5 }, () => ({ step: "run.start", task_id: ids[1] })),
    { step: "pr.opened", task_id: ids[1], pr_url: "u/1" },
    ...Array.from({ length: 5 }, () => ({ step: "run.start", task_id: ids[2] })),
    { step: "run.start", task_id: ids[3], run_id: "capacity" },
    { step: "daemon.spawn_infra_blocked", task: ids[3], run_id: "capacity" },
  ];
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const branches = [{ number: 3, url: "u/3", state: "OPEN", headRefName: `run-${ids[2]}-1791473309336` }];
  const expected = ids.filter(id => {
    const gate = breakerGateFor(path, branches);
    return !gate.isIndeterminate(id) && !gate.isTripped(id);
  });
  assert.deepEqual(expected, ids.slice(1), "the corpus contains both refused and admitted candidates");
  const gate = breakerGateFor(path, branches);
  assert.deepEqual([...runnableCandidateIds(plan, () => false, selectionOpts(gate))], expected);
  for (const id of ids) {
    const reference = breakerGateFor(path, branches);
    assert.deepEqual(gate.detailFor(id), reference.detailFor(id));
    assert.equal(gate.isLifetimeCapExceeded(id), reference.isLifetimeCapExceeded(id));
  }
});

test("W1-T6358: selections that reach no ledger predicate perform no read", t => {
  const { path, plan } = fixture();
  const reads = countReads(t, path);
  const gate = breakerGateFor(path, undefined);
  const opts = selectionOpts(gate);
  assert.deepEqual(runnableCandidates(plan, () => false, 0, opts), []);
  assert.equal(nextRunnable(plan, () => true, opts), undefined);
  assert.equal(reads(), 0);
  assert.ok(runnableCandidates(plan, () => false, 1, opts).length > 0);
  assert.equal(reads(), 1, "the positive control reaches the reader with the same query and corpus");
});

test("W1-T6358: a missing ledger keeps the breaker regression refusal", t => {
  const { path, plan, ids } = fixture();
  const gate = breakerGateFor(path, undefined);
  const opts = selectionOpts(gate);
  writeFileSync(path, JSON.stringify({ step: "run.start", task_id: ids[0] }) + "\n");
  assert.equal(nextRunnable(plan, () => false, opts)?.id, ids[0]);
  const reads = countReads(t, path);
  fs.unlinkSync(path);
  assert.deepEqual([...runnableCandidateIds(plan, () => false, opts)], ids.slice(1));
  assert.equal(gate.detailFor(ids[0]).state, "indeterminate");
  assert.equal(reads(), 0, "absence performs no content read");
});

test("W1-T6358: an unreadable snapshot propagates the read error and closes its descriptor", t => {
  const { path, plan } = fixture();
  const originalClose = fs.closeSync;
  let closed = 0;
  t.mock.method(fs, "readFileSync", () => { throw new Error("snapshot unreadable"); });
  t.mock.method(fs, "closeSync", (fd: number) => { closed++; originalClose(fd); });
  const gate = breakerGateFor(path, undefined);
  assert.throws(() => runnableCandidateIds(plan, () => false, selectionOpts(gate)), /snapshot unreadable/);
  assert.equal(closed, 1);
});

test("W1-T6358: the next selection refreshes even the same candidate after a reset or regression", () => {
  const { path, plan, ids } = fixture();
  writeFileSync(path, Array.from({ length: 5 }, () => JSON.stringify({ step: "run.start", task_id: ids[0] })).join("\n") + "\n");
  const gate = breakerGateFor(path, undefined);
  const opts = selectionOpts(gate);
  assert.equal(nextRunnable(plan, () => false, opts)?.id, ids[1]);
  writeFileSync(path, "");
  runnableCandidateIds(plan, () => false, opts);
  assert.equal(gate.isIndeterminate(ids[0]), true, "regression memory survives snapshot renewal");
  writeFileSync(path, JSON.stringify({ step: "pr.opened", task_id: ids[0], pr_url: "u/1" }) + "\n");
  assert.equal(nextRunnable(plan, () => false, opts)?.id, ids[0]);
  assert.equal(gate.detailFor(ids[0]).freshCount, 0);
});
