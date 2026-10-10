import assert from "node:assert/strict";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { buildSweepEffects } from "../src/run-task.js";

const now = Date.UTC(2026, 9, 5, 12);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const pr: OpenPrView = {
  prNumber: 5900, prUrl: "https://github.com/craigoley/remudero/pull/5900", taskId: "W1-T5900",
  headSha: "head", headRefName: "run-W1-T5900-1", reviewState: "success", checksState: "green",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: ago(5), autoMergeArmed: false,
};

function fixture(blocker = "awaiting-arm", minutes = 40, extra: Record<string, unknown>[] = []) {
  const ledger = writeLedger([{
    ts: ago(minutes), run_id: "old", task_id: pr.taskId, step: "sweep.disposed",
    pr_number: pr.prNumber, head_sha: pr.headSha, disposition: "mergeable", acted: false,
    blocker, blocker_since: ago(minutes),
  }, ...extra]);
  const escalations: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: ledger.path, runId: "test-stuck", now: () => now,
    arm: () => "hold-refused", close: () => {}, dispatchFix: () => {}, postReview: () => {},
    escalate: (_pr, reason, question) => { escalations.push(`${reason}\n${question.question}`); },
  };
  const rows = (step: string) => readLedgerLines(ledger.path).filter(row => row.step === step);
  return { ledger, deps, escalations, rows };
}

test("test/a-pr-whose-stage-stops-moving-is-named-within-thirty-minutes.test.ts", async () => {
  const f = fixture("awaiting-arm", 40, [
    { ts: ago(20), step: "review.posted", pr_url: pr.prUrl, task_id: pr.taskId },
    { ts: ago(10), step: "automerge.armed", pr_number: 99, task_id: pr.taskId },
  ]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  const row = f.rows("pr.stuck")[0];
  assert.equal(row.blocker, "awaiting-arm");
  assert.equal(row.blocker_since, ago(40));
  assert.equal(row.blocker_age_ms, 40 * 60_000);
  assert.equal(row.diagnosis, "review loop");
  assert.equal(f.rows("sweep.disposed").at(-1)?.stage_stuck, true);
  assert.equal(f.escalations.length, 1);
  assert.match(f.escalations[0], /5900.*awaiting-arm.*40 minutes/);
  assert.match(f.escalations[0], /DIAGNOSIS: review loop/);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.escalations.length, 1);

  await runSweep([{ ...pr, checksState: "pending", reviewState: "none" }], f.deps);
  assert.equal(f.rows("pr.stuck.resolved").length, 1);
  assert.equal(f.rows("pr.stuck.resolved")[0].blocker, "awaiting-arm");
  assert.equal(f.rows("pr.stuck.resolved")[0].resolved_blocker, "awaiting-ci");
  await runSweep([{ ...pr, checksState: "pending", reviewState: "none" }], f.deps);
  assert.equal(f.rows("pr.stuck.resolved").length, 1);
});

test("a blocker changing before its bound raises nothing, and a fresh or dry-run stage is quiet", async () => {
  for (const [blocker, minutes, dryRun] of [["awaiting-ci", 20, false], ["awaiting-arm", 30, false],
    ["awaiting-arm", 40, true]] as const) {
    const f = fixture(blocker, minutes);
    await runSweep([pr], { ...f.deps, dryRun });
    assert.equal(f.rows("pr.stuck").length, 0);
    assert.equal(f.escalations.length, 0);
  }
  const f = fixture();
  f.ledger.append([{ ts: ago(1), step: "sweep.disposed", pr_number: pr.prNumber,
    blocker: "awaiting-arm", blocker_since: ago(1) }]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck").length, 0);
});

test("a moved blocker clock resolves its old stall and can raise a new episode", async () => {
  const f = fixture();
  await runSweep([pr], f.deps);
  f.ledger.append([{ ts: ago(35), step: "sweep.disposed", pr_number: pr.prNumber,
    blocker: "awaiting-arm", blocker_since: ago(35) }]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck.resolved").length, 1);
  assert.equal(f.rows("pr.stuck").length, 2);
  assert.equal(f.escalations.length, 2);
});

test("an observed arm excludes the review-loop diagnosis and a sibling run diagnoses duplicate build", async () => {
  const f = fixture("awaiting-arm", 40, [
    { ts: ago(20), step: "review.posted", pr_url: pr.prUrl },
    { ts: ago(10), step: "automerge.armed", pr_number: pr.prNumber },
  ]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck")[0].diagnosis, "unknown signature");
  const duplicate = fixture();
  await runSweep([pr, { ...pr, prNumber: 5901, prUrl: "url/5901", headRefName: "run-W1-T5900-2" }], duplicate.deps);
  assert.equal(duplicate.rows("pr.stuck")[0].diagnosis, "duplicate build");
  const light = fixture();
  await runSweepLightPass([pr, { ...pr, prNumber: 5901, prUrl: "url/5901", headRefName: "run-W1-T5900-2" }], light.deps);
  assert.equal(light.rows("pr.stuck")[0].diagnosis, "duplicate build");
});

test("each declared backstop fires only past its bound and fix activity suppresses repair-stage stalls", async () => {
  for (const [blocker, minutes, view] of [
    ["conflict", 30, { ...pr, mergeState: "dirty" as const }],
    ["own-red", 45, { ...pr, checksState: "red" as const }],
    ["awaiting-review", 30, { ...pr, reviewState: "none" as const }],
  ] as const) {
    for (const offset of [-1, 0, 1]) {
      const f = fixture(blocker, minutes + offset);
      await runSweep([view], { ...f.deps, actionable: () => false });
      assert.equal(f.rows("sweep.disposed").at(-1)?.blocker, blocker);
      assert.equal(f.rows("pr.stuck").length, offset > 0 ? 1 : 0, blocker);
    }
    if (blocker === "awaiting-review") continue;
    const f = fixture(blocker, minutes + 1, [{ ts: ago(5), step: "fix.dispatch", task_id: pr.taskId }]);
    await runSweep([view], { ...f.deps, actionable: () => false });
    assert.equal(f.rows("pr.stuck").length, 0);
    const pushed = fixture(blocker, minutes + 1, [{ ts: ago(5), step: "fix.done", task_id: pr.taskId, pushed_head_sha: "head" }]);
    await runSweep([view], { ...pushed.deps, actionable: () => false });
    assert.equal(pushed.rows("pr.stuck").length, 0);
  }
  const custom = fixture("awaiting-arm", 20);
  await runSweep([pr], custom.deps, { ...DEFAULT_SWEEP_POLICY,
    stageBackstops: { "awaiting-arm": { kind: "BACKSTOP", minutes: 10 } } });
  assert.equal(custom.rows("pr.stuck")[0].bound_minutes, 10);
  assert.equal(custom.rows("pr.stuck")[0].bound_kind, "BACKSTOP");
});

test("a failed escalation records its reason and a successful arm raises no stale-snapshot stall", async () => {
  const f = fixture();
  await runSweep([pr], { ...f.deps, escalate: () => { throw new Error("issue gateway unavailable"); } });
  assert.equal(f.rows("pr.stuck.escalation_failed")[0].reason, "Error: issue gateway unavailable");
  const armed = fixture();
  await runSweep([pr], { ...armed.deps, arm: () => "armed" });
  assert.equal(armed.rows("pr.stuck").length, 0);
  const overlap = fixture();
  await Promise.all([runSweep([pr], overlap.deps), runSweep([pr], overlap.deps)]);
  assert.equal(overlap.rows("pr.stuck").length, 1);
  assert.equal(overlap.escalations.length, 1);
});

test("a dirty PR with captured one-parent fix evidence diagnoses a failed merge", async () => {
  const f = fixture("conflict", 40, [
    { ts: ago(50), step: "fix.done", task_id: pr.taskId, pushed_head_sha: "head", parents: ["old-head"] },
  ]);
  await runSweep([{ ...pr, mergeState: "dirty" }], { ...f.deps, actionable: () => false });
  assert.equal(f.rows("pr.stuck")[0].diagnosis, "failed merge");
});

test("the production escalation effect opens a needs-human issue once for the stalled stage", async () => {
  const f = fixture();
  const issues: { title: string; body: string; labels: string[] }[] = [];
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: f.ledger.dir,
    config: { root: f.ledger.dir, claudeBin: "/bin/true" } as never,
    ledgerPath: f.ledger.path, runId: f.deps.runId, plan: { tasks: [], byId: new Map() } as never,
    log: () => {}, issuesImpl: {
      create: (title, body, labels) => { issues.push({ title, body, labels }); return "url/issue"; },
      listOpen: () => [],
    },
  });
  const deps = { ...f.deps, escalate: effects.escalate };
  await runSweep([pr], deps);
  await runSweep([pr], deps);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].labels.includes("needs-human"));
  assert.match(issues[0].title, /^\[MANUAL\]/);
  assert.match(issues[0].body, /awaiting-arm for 40 minutes/);
  assert.match(issues[0].body, /DIAGNOSIS: unknown signature/);
});

test("a retained disposition keeps the stall deduped after its original notification row rotates away", async () => {
  const f = fixture();
  f.ledger.append([{ ts: ago(1), step: "sweep.disposed", pr_number: pr.prNumber, head_sha: pr.headSha,
    blocker: "awaiting-arm", blocker_since: ago(40), stage_stuck: true }]);
  await runSweep([pr], f.deps);
  assert.equal(f.rows("pr.stuck").length, 0);
  assert.equal(f.rows("sweep.disposed").at(-1)?.stage_stuck, true);
  assert.equal(f.escalations.length, 0);
  await runSweep([{ ...pr, checksState: "pending", reviewState: "none" }], f.deps);
  assert.equal(f.rows("pr.stuck.resolved").length, 1);
});

test("an ordinary conflict escalation is not a started repair round", async () => {
  const f = fixture("conflict", 40);
  await runSweep([{ ...pr, mergeState: "dirty" }], f.deps);
  assert.equal(f.rows("pr.stuck").length, 1);
  assert.equal(f.rows("pr.stuck")[0].blocker, "conflict");
});
