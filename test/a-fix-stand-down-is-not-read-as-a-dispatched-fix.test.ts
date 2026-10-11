import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView } from "./helpers/sweep-test.js";
import type { Config } from "../src/lib/config.js";
import type { Task } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TASK = "W1-T6001";
const HEAD = "cd62a1800000000000000000000000000000000000";
const OLD_HEAD = "b95338c00000000000000000000000000000000000";
const PR = 9505;
const NOW = Date.now();
const REASON = `a needs-human escalation for this exact (task, PR, head ${HEAD}, cause) is ALREADY OPEN ` +
  "and awaiting a human (https://github.com/craigoley/remudero/issues/9507)";
const disposed = { step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD,
  disposition: "blocked-fixable", acted: true };
const stoodDown = { step: "fix.stood_down", task_id: TASK, site: "rung.strike", strike: 1, reason: REASON };
const dispatch = (head: string, step = "fix.dispatch") => ({ step, task_id: TASK, head_sha: head });

async function pass(seed: Record<string, unknown>[], over: Partial<OpenPrView> = {}, passes = 1) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6001-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  let dispatched = 0;
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/craigoley/remudero/pull/${PR}`, taskId: TASK,
    reviewState: "failure", checksState: "green",
    unmetCriteria: [{ claim: "repair", proof: "unit test: repair", met: false, reason: "unmet",
      proof_exec: "not_executable" }],
    priorStrikes: 0, lastActivityAt: new Date(NOW - 60_000).toISOString(), headSha: HEAD,
    headRefName: "run-W1-T6001-1791665642527", autoMergeArmed: false,
    ...over,
  };
  try {
    for (let n = 0; n < passes; n++) await runSweep([pr], {
      arm: () => {}, close: () => {}, escalate: () => {}, dispatchFix: () => { dispatched++; },
      ledgerPath, runId: "SWEEP-W1-T6001", now: () => NOW,
      // A different head's completion masks the stand-down in the existing task-wide stalled fold.
      readLedger: () => [...seed, { step: "fix.resolved", task_id: TASK, head_sha: OLD_HEAD },
        ...readLedgerLines(ledgerPath)],
    });
    const row = readLedgerLines(ledgerPath).findLast(line => line.step === "sweep.disposed");
    assert.ok(row, "the pass dispositions the fixture PR");
    return { row, dispatched };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("test/a-fix-stand-down-is-not-read-as-a-dispatched-fix.test.ts: a stand-down names its reason instead of a dispatch", async () => {
  for (const over of [{}, { mergeState: "dirty" as const, reviewState: "success" as const,
    unmetCriteria: [], mergeConflict: { files: [{ path: "src/a.ts", oursDeleted: 1, theirsDeleted: 1 }],
      oursLog: `${HEAD} ours`, theirsLog: `${OLD_HEAD} theirs` } }]) {
    for (const stand of [stoodDown, { ...stoodDown, pr_number: PR, head_sha: HEAD }]) {
      for (const seed of [[dispatch(OLD_HEAD), disposed, stand], [dispatch(OLD_HEAD), stand, disposed], [stand]]) {
        const next = await pass(seed, over, 2);
        assert.equal(next.dispatched, 0);
        assert.equal(next.row.acted, false);
        assert.equal(next.row.stand_down_reason, REASON);
        assert.doesNotMatch(String(next.row.reason), /fix already dispatched/);
      }
    }
  }
});

test("a real dispatch, retrigger and pending detached dispatch retain their dispatch dedup", async () => {
  for (const seed of [
    [dispatch(OLD_HEAD), disposed],
    [disposed, stoodDown, dispatch(HEAD)],
    [disposed, dispatch(HEAD), stoodDown],
    [disposed, stoodDown, dispatch(HEAD, "fix.retrigger"), dispatch(OLD_HEAD)],
  ]) {
    const next = await pass(seed);
    assert.equal(next.dispatched, 0);
    assert.match(String(next.row.stand_down_reason), /fix already dispatched/);
  }
});

test("stand-downs for another task, PR or head and ci handoffs do not become stand-down holds", async () => {
  for (const stand of [
    { ...stoodDown, task_id: "W1-T9999" },
    { ...stoodDown, pr_number: PR + 1, head_sha: HEAD },
    { ...stoodDown, head_sha: OLD_HEAD },
    { ...stoodDown, reason: REASON.replace(HEAD, OLD_HEAD) },
    { ...stoodDown, head_sha: HEAD, outcome: "handed_off" },
  ]) {
    const next = await pass([dispatch(OLD_HEAD), disposed, stand]);
    assert.match(String(next.row.stand_down_reason), /fix already dispatched/);
  }
  const fresh = await pass([dispatch(OLD_HEAD), disposed, stoodDown], { headSha: "f00dface0000000000000000000000000000000000" });
  assert.equal(fresh.dispatched, 1, "a new head re-earns its fix round");
});

test("a sweep fix stand-down records its PR and head only before a dispatch starts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6001-effects-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tmp"), { recursive: true });
  const task: Task = { id: TASK, title: "retain stand-down reason", risk: "low", acceptance: [],
    verify: "auto", files: ["src/lib/sweep.ts"], status: "queued", repo: "remudero",
    depends_on: [], type: "implement", attempts: 0 };
  const branch = "run-W1-T6001-1791665642527";
  const rows: Record<string, unknown>[] = [];
  for (const marker of [undefined, "fix.dispatch", "fix.retrigger"]) {
    rows.length = 0;
    const effects = buildSweepEffects({
      owner: "acme", repo: "remudero", config: { root } as Config, repoRoot: process.cwd(),
      ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-W1-T6001",
      plan: { tasks: [task], byId: new Map([[TASK, task]]) }, policy: DEFAULT_SWEEP_POLICY,
      log: (step, extra) => { rows.push({ step, ...extra }); },
      dispatchFixPreflightStandDownImpl: async () => undefined,
      ghJsonImpl: () => ({ headRefName: branch, headRefOid: HEAD, body: "" }),
      registeredWorktreeOwnerImpl: () => undefined,
      fixBranchClaimKeyImpl: () => "fix-t6001",
      createFixRungWorktreeImpl: () => undefined,
      captureWorktreeSnapshotImpl: () => undefined,
      buildFixRungDispatchArgsImpl: () => ({}),
      openTaskIdsFromPlanImpl: () => new Set([TASK]),
      readPackageScriptsImpl: () => ({}),
      readPreservedOwnerPatchImpl: () => undefined,
      worktreeRemoveImpl: () => {},
      runFixRungImpl: async (opts) => {
        if (marker) opts.deps.log(marker, { head_sha: HEAD });
        opts.deps.log("fix.stood_down", { site: "rung.strike", strike: 1, reason: REASON });
        return { outcome: "stood_down" };
      },
    });
    await effects.dispatchFix({ prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`,
      taskId: TASK, headSha: HEAD, headRefName: branch, priorStrikes: 0,
      checksState: "green", reviewState: "failure" } as OpenPrView,
    { unmetCriteria: [], ciFailures: [] });
    const stand = rows.find(row => row.step === "fix.stood_down");
    assert.ok(stand, "the real dispatch closure reaches the rung's logger");
    assert.equal(stand.task_id, TASK);
    assert.equal(stand.reason, REASON);
    assert.equal(stand.pr_number, marker ? undefined : PR);
    assert.equal(stand.head_sha, marker ? undefined : HEAD);
    if (!marker) {
      assert.equal(rows.some(row => row.step === "fix.dispatch"), false);
      const next = await pass([disposed, stand]);
      assert.equal(next.row.stand_down_reason, REASON);
      assert.equal(next.row.acted, false);
      assert.equal(next.dispatched, 0);
    }
  }
});
