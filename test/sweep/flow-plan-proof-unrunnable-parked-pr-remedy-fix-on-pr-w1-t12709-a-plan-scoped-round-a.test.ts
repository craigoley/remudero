import assert from "node:assert/strict";
import { test } from "node:test";

import { PARKED_PR_REMEDY_STEP, type ParkedPrHost } from "#src/lib/parked-pr-remedy.js";
import { DEFAULT_SWEEP_POLICY, PLAN_REPAIR_STEP, runSweep, type MetadataRepairResult, type OpenPrView,
  type SweepDeps } from "#src/lib/sweep.js";

// W1-T13347: #19032, an operator plan filing, sat red 5.8 hours on `acceptance-author-gate: REFUSED (no-header)` until a
// person edited its body. The sweep named plan-repair its owner, but a plan filing never reached the title/body repair
// (W1-T13360's derived block among its cures): the plan-only branch took the PR first and parked it on fix-on-pr.

const HEAD = "c".repeat(40), NEXT = "d".repeat(40);
const NOW = Date.parse("2026-11-17T08:00:00Z");
const GATE = "acceptance-author-gate";
const NO_HEADER = "acceptance-author-gate: REFUSED (no-header) — no `## Acceptance` header and no `Remudero-Task:` trailer";
const CREDITED = "acceptance-author-gate: REFUSED (credited-test-path) — test/x.test.ts is absent at the head";
/** origin/main's judgment of this PR: the parked-pr remedy's wait, which dispatches nothing. */
const PARKED = /^parked-pr remedy fix-on-pr \(W1-T12709\): a plan-scoped round acts on 0 unmet criteria and \d+ red checks on the pull request; it replaces: plan-only PR is red on /;

function filing(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: undefined, headSha: HEAD,
    headRefName: `run-unfiled-${prNumber}`, isPlanFiling: true, autoMergeArmed: false, priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(), checksState: "red", reviewState: "none", unmetCriteria: [],
    body: "docs(plan): file three tasks\n", ciFailures: [{ name: GATE, logTail: NO_HEADER }], ...over } as OpenPrView;
}

const parkedHost: ParkedPrHost = {
  planFilingTarget: { owner: "o", repo: "r", checkoutDir: "/unused" },
  readTaskShard: async () => ({ outcome: "refused", reason: "task-absent" }),
  reserveTaskId: () => "W1-T913347",
  landTaskFiles: async () => ({ prUrl: "https://github.com/o/r/pull/99" }),
  closePr: async () => {},
};

function fixture(repair?: (pr: OpenPrView) => MetadataRepairResult, over: Partial<SweepDeps> = {}) {
  const rows: Record<string, unknown>[] = [];
  const calls: [number, readonly string[]][] = [], armed: number[] = [], asked: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/w1-t13347", runId: "w1-t13347", now: () => NOW, readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); }, close: () => {}, dispatchFix: () => {},
    arm: (pr) => { armed.push(pr.prNumber); }, escalate: (_pr, reason) => { asked.push(reason); }, parkedPr: parkedHost,
    ...(repair ? { repairMetadata: (pr: OpenPrView, checks: readonly string[]) => { calls.push([pr.prNumber, checks]); return repair(pr); } } : {}),
    ...over,
  };
  const disposed = (prNumber: number) => rows.filter(r => r.step === "sweep.disposed" && r.pr_number === prNumber).at(-1);
  return { rows, calls, armed, asked, deps, disposed,
    pass: (prs: OpenPrView[]) => runSweep(prs, deps, DEFAULT_SWEEP_POLICY),
    repairs: () => rows.filter(r => r.step === PLAN_REPAIR_STEP && r.signature === "metadata"),
    remedies: (prNumber: number) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === prNumber) };
}

const edited = (): MetadataRepairResult => ({ repaired: true, reason: "edited body through the PR REST endpoint" });
const judged = (row: Record<string, unknown> | undefined) => [row?.disposition, row?.blocker, row?.acted, row?.reason];

test("W1-T13347: flow-plan-proof-unrunnable-parked-pr-remedy-fix-on-pr-w1-t12709-a-plan-scoped-round-a clears without a person", async () => {
  const control = fixture();
  await control.pass([filing(19032)]);
  assert.match(String(control.disposed(19032)?.reason), PARKED, "control: with no title/body repair wired the PR is parked as on #19032");

  const f = fixture(edited);
  await f.pass([filing(19032)]);
  assert.deepEqual(f.calls, [[19032, [GATE]]], "the plan filing's metadata-only red reaches the title/body repair");
  const row = f.disposed(19032)!;
  assert.deepEqual([row.disposition, row.blocker, row.blocker_owner], ["wait", "plan-proof-unrunnable", "plan-repair"],
    "the named owner acted, and the PR waits for the gate's verdict on the edited body");
  assert.match(String(row.reason), /^plan repair \(metadata\): edited body through the PR REST endpoint; awaiting the gate's verdict/);
  assert.deepEqual(f.remedies(19032), [], "no parked-pr remedy is taken for a PR its owner repaired");
  assert.deepEqual(f.asked, [], "no person is asked");
  assert.deepEqual(f.armed, [], "a body repair never arms or merges: the gate and review still judge the PR");
  assert.deepEqual(f.repairs().map(r => [r.head_sha, r.check_name, r.outcome]), [[HEAD, GATE, "repaired"]]);

  await f.pass([filing(19032)]);
  assert.equal(f.calls.length, 1, "the repair is tried once per head: a red that outlives it takes today's route");
  assert.match(String(f.disposed(19032)?.reason), PARKED);

  await f.pass([filing(19032, { headSha: NEXT })]);
  assert.deepEqual(f.calls.at(-1), [19032, [GATE]], "a new head is a new input and gets its own repair");
});

test("W1-T13347: flow-plan-proof-unrunnable-parked-pr-remedy-fix-on-pr-w1-t12709-a-plan-scoped-round-a leaves other blockers held", async () => {
  const held = [
    filing(71, { ciFailures: [{ name: GATE, logTail: NO_HEADER }, { name: "typecheck", logTail: "TS2322" }] }),
    filing(72, { ciFailures: [{ name: GATE, logTail: CREDITED }] }),
    filing(73, { ciFailures: [{ name: "commitlint", logTail: "subject may not be empty" }] }),
  ];
  const prs = [filing(70), ...held];
  const control = fixture();
  await control.pass(prs);
  const f = fixture(edited);
  await f.pass(prs);
  assert.deepEqual(f.calls, [[70, [GATE]]], "only the plan filing red on title/body checks alone gets the repair");
  for (const pr of held) {
    assert.deepEqual(judged(f.disposed(pr.prNumber)), judged(control.disposed(pr.prNumber)),
      `PR ${pr.prNumber} is held exactly as without the repair`);
    assert.deepEqual(f.remedies(pr.prNumber).map(r => [r.remedy, r.outcome]), control.remedies(pr.prNumber).map(r => [r.remedy, r.outcome]));
    assert.notEqual(f.disposed(pr.prNumber)?.disposition, "mergeable");
  }

  const refusal = { repaired: false, noCure: true, reason: "the body red has no deterministic acceptance repair" } as const;
  const refused = fixture(() => refusal);
  await refused.pass([filing(74)]);
  const before = fixture();
  await before.pass([filing(74)]);
  const [disposition, blocker, acted] = judged(refused.disposed(74));
  assert.deepEqual([disposition, blocker, acted], judged(before.disposed(74)).slice(0, 3), "a refused repair releases nothing");
  const remedy = (rows: Record<string, unknown>[]) => rows.map(r => [r.remedy, r.cause, r.outcome]);
  assert.ok(before.remedies(74).length > 0, "control: the parked-pr remedy holds this PR");
  assert.deepEqual(remedy(refused.remedies(74)), remedy(before.remedies(74)), "a refused repair keeps the PR's parked-pr remedy");
  assert.match(String(refused.disposed(74)?.reason), /plan repair \(metadata\) did not take: the body red has no deterministic acceptance repair/);
  assert.deepEqual(refused.repairs().map(r => r.outcome), ["refused"]);
  const threw = fixture(() => { throw new Error("PATCH /pulls/74 returned 502"); });
  await threw.pass([filing(74)]);
  assert.deepEqual(judged(threw.disposed(74)).slice(0, 3), judged(before.disposed(74)).slice(0, 3), "a failed edit releases nothing");
  assert.deepEqual(remedy(threw.remedies(74)), remedy(before.remedies(74)), "a failed edit keeps the PR's parked-pr remedy");
  assert.deepEqual(threw.repairs().map(r => [r.outcome, r.reason]), [["refused", "PATCH /pulls/74 returned 502"]]);

  for (const over of [{ dryRun: true }, { actionable: () => false }] as Partial<SweepDeps>[]) {
    const light = fixture(edited, over);
    await light.pass([filing(75)]);
    assert.deepEqual(light.calls, [], `no title/body edit on a ${"dryRun" in over ? "dry run" : "light pass"}`);
  }
  assert.deepEqual([...f.armed, ...refused.armed, ...threw.armed], [], "nothing is armed");
});
