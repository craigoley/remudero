import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeCriterion, judgeReview, shardDeclaredFilesInDiff } from "../src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "../src/lib/sweep.js";
import { buildOpenPrViews } from "../src/run-task.js";

/**
 * W1-T456 — "a filing PR fails review for one reason and cannot be repaired for a second,
 * unrelated one". TWO INDEPENDENT DEFECTS, proved separately, plus the honest boundary between
 * them (a genuine failure must still fail):
 *
 *   DEFECT A (acceptance 1+2) — `judgeReview`/`judgeCriterion` (src/lib/review.ts): a filing
 *   PR's acceptance proof forward-references a test file the IMPLEMENTATION (a later PR) will
 *   create. That file is absent on the PR head, so the whitelisted-proof executor used to read
 *   it as a genuine test FAILURE (`executed_fail`, a hard override no report can rescue) —
 *   indistinguishable from a real defect. Now: absent-and-declared-by-this-diff's-own-shard is
 *   its own named outcome (`not_yet_built`/`forward-reference`), which degrades to the ordinary
 *   keyword floor instead of hard-blocking. Absent-and-NOT-declared is UNCHANGED — still a real
 *   failure, never a blanket excuse (acceptance 2).
 *
 *   DEFECT B (acceptance 3) — `buildOpenPrViews` (src/run-task.ts) / the fix rung's disposition
 *   rows (src/lib/sweep.ts): a filing PR deliberately carries no `Remudero-Task:` trailer
 *   (#1527), so its unmet criteria were never read from the ledger at all, and every failing
 *   filing fell straight to the escalate-only "criteria unrecoverable (no Remudero-Task:
 *   trailer to resolve them from)" row — an operator absorbs every one, even a plainly fixable
 *   defect (a malformed shard, a lint-plan violation). Now: `buildOpenPrViews` also reads the
 *   ledger through the SAME synthetic `PR-<n>` key `reviewCommand` already keys every
 *   task-id-less review under, for a POSITIVELY-marked plan-only filing PR — so a REAL failure
 *   reaches the fix rung's `blocked-fixable` row instead.
 */

// ── DEFECT A: judgeCriterion / judgeReview ──────────────────────────────────

test("acceptance 1 — a filing whose proof names a test the implementation will create is reported unbuilt, not failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w456-a-"));
  // The forward-referenced file genuinely does not exist on this "PR head" — that is the whole
  // point: the filing PR only adds the plan shard, never the test the future implementation
  // will write.
  const verdict = judgeCriterion(
    {
      claim: "W1-T999 filed as well-formed plan task shard(s), not (yet) implemented",
      proof: "unit test: test/filing-forward-reference.test.ts",
    },
    new Set(),
    undefined,
    { cwd: dir, forwardReferenceFiles: new Set(["test/filing-forward-reference.test.ts"]) },
  );
  assert.equal(verdict.proof_exec, "not_yet_built", "a named, NEW state — never a silent pass, never exec_error");
  assert.equal(verdict.proof_skip, "forward-reference");
  assert.notEqual(verdict.proof_exec, "executed_fail", "the hard override that made a filing unrepairable must not fire");
  assert.match(verdict.reason, /forward reference to work not yet built/);
});

test("acceptance 1 — end-to-end through judgeReview: the SAME diff that adds the shard exempts its own forward-referenced proof, and a report that substantiates it PASSES", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w456-a-e2e-"));
  const diff = [
    "diff --git a/plan/tasks.d/W1-T999-example.yaml b/plan/tasks.d/W1-T999-example.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/plan/tasks.d/W1-T999-example.yaml",
    "@@ -0,0 +1,3 @@",
    "+- id: W1-T999",
    "+  files: [test/filing-forward-reference.test.ts]",
    "+  status: queued",
  ].join("\n");
  const criteria = [
    {
      claim: "the forward-referenced test exists",
      proof: "unit test: test/filing-forward-reference.test.ts",
    },
  ];
  // The report pastes the proof verbatim — a real filing PR body describing its own filed
  // shard's acceptance — so the keyword floor is trivially satisfied once the hard override
  // is withdrawn.
  const report = "Filed W1-T999. Its acceptance proof: unit test: test/filing-forward-reference.test.ts";
  const verdict = judgeReview(criteria, { diff, report, headCheckoutDir: dir });
  assert.equal(verdict.criteria[0].proof_exec, "not_yet_built");
  assert.equal(
    verdict.state,
    "success",
    "a forward reference the report responsively describes is no longer hard-blocked",
  );
});

test("acceptance 2 — a filing that fails for a real reason still fails: an undeclared absent path is unaffected (no blanket excuse)", () => {
  // forwardReferenceFiles IS populated (this review context IS a filing PR's own diff), but the
  // proof under judgment names a DIFFERENT path — one no shard in the diff ever declared. This
  // is exactly a fabricated/mistaken proof, and it must still hard-fail like today.
  const verdict = judgeCriterion(
    { claim: "some future work is proven", proof: "unit test: test/totally-unrelated-fabricated.test.ts" },
    new Set(),
    undefined,
    { cwd: "/nonexistent", exec: () => "fail", forwardReferenceFiles: new Set(["test/filing-forward-reference.test.ts"]) },
  );
  assert.equal(verdict.proof_exec, "executed_fail");
  assert.equal(verdict.met, false);
});

test("acceptance 2 — a declared path that is actually PRESENT and genuinely fails is never excused as a forward reference (absence is a necessary condition, not just declaration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w456-present-fail-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "filing-forward-reference.test.ts"), "// present but genuinely failing\n");
  const verdict = judgeCriterion(
    { claim: "the shard's own test passes", proof: "unit test: test/filing-forward-reference.test.ts" },
    new Set(),
    undefined,
    { cwd: dir, exec: () => "fail", forwardReferenceFiles: new Set(["test/filing-forward-reference.test.ts"]) },
  );
  assert.equal(verdict.proof_exec, "executed_fail", "the file EXISTS, so this is a real, observed failure");
});

test("acceptance 2 — judgeReview end-to-end: a filing PR whose OTHER criterion fails for a real reason still yields state=failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w456-a-genuine-"));
  const diff = [
    "diff --git a/plan/tasks.d/W1-T999-example.yaml b/plan/tasks.d/W1-T999-example.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/plan/tasks.d/W1-T999-example.yaml",
    "@@ -0,0 +1,2 @@",
    "+- id: W1-T999",
    "+  files: [test/filing-forward-reference.test.ts]",
  ].join("\n");
  const criteria = [
    { claim: "the forward-referenced test exists", proof: "unit test: test/filing-forward-reference.test.ts" },
    { claim: "a real defect", proof: "unit test: test/some-other-genuinely-fabricated-name.test.ts" },
  ];
  const report =
    "Filed W1-T999. unit test: test/filing-forward-reference.test.ts. unit test: test/some-other-genuinely-fabricated-name.test.ts";
  const verdict = judgeReview(criteria, {
    diff,
    report,
    headCheckoutDir: dir,
    execProof: (whitelisted) => (whitelisted.label.includes("filing-forward-reference") ? "pass" : "fail"),
  });
  assert.equal(verdict.criteria[0].proof_exec, "not_yet_built", "the declared forward reference is exempted");
  assert.equal(verdict.criteria[1].proof_exec, "executed_fail", "the undeclared, genuinely-fabricated proof still fails");
  assert.equal(verdict.state, "failure", "one real failure still fails the whole review — never a blanket excuse");
});

test("shardDeclaredFilesInDiff: reads a plan shard's files: list off an ADDED hunk only", () => {
  const diff = [
    "diff --git a/plan/tasks.d/W1-T999-example.yaml b/plan/tasks.d/W1-T999-example.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/plan/tasks.d/W1-T999-example.yaml",
    "@@ -0,0 +1,2 @@",
    "+- id: W1-T999",
    "+  files: [src/foo.ts, test/filing-forward-reference.test.ts]",
    "diff --git a/src/unrelated.ts b/src/unrelated.ts",
    "index 111..222 100644",
    "--- a/src/unrelated.ts",
    "+++ b/src/unrelated.ts",
    "@@ -1 +1 @@",
    "-  files: [src/should-not-count.ts]",
    "+  files: [src/should-not-count-either.ts]",
  ].join("\n");
  assert.deepEqual(
    [...shardDeclaredFilesInDiff(diff)].sort(),
    ["src/foo.ts", "test/filing-forward-reference.test.ts"],
    "only the ADDED line inside the plan/tasks.d/ hunk counts — a coincidental `files:` edit elsewhere never does",
  );
});

// ── DEFECT B: buildOpenPrViews (run-task.ts) + the fix rung's disposition (sweep.ts) ────────

function ledgerPath(dir: string): string {
  return join(dir, "ledger.ndjson");
}
function writeLedger(path: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
}
function restPr(over: { number: number; headRefName: string; body: string; sha: string }): Record<string, unknown> {
  return {
    number: over.number,
    html_url: `https://github.com/craigoley/remudero/pull/${over.number}`,
    head: { ref: over.headRefName, sha: over.sha },
    updated_at: "2026-08-13T18:00:00.000Z",
    body: over.body,
    auto_merge: null,
    state: "open",
  };
}
/** A REST fetch stub covering the list + per-head check-runs/combined-status reads
 *  `buildOpenPrViews` makes, so `remudero-review`'s posted state actually lands on the
 *  built `OpenPrView.reviewState` (see lib/open-prs-rest.ts's `rollupFor`). */
function fetchFor(prs: Array<Record<string, unknown>>, reviewStatusesBySha: Record<string, Array<Record<string, unknown>>>): (args: string[]) => unknown {
  return (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/pulls\?state=open/.test(path)) return prs;
    const statusMatch = path.match(/commits\/([0-9a-f]+)\/status$/);
    if (statusMatch) return { statuses: reviewStatusesBySha[statusMatch[1]] ?? [] };
    if (/check-runs/.test(path)) return { check_runs: [] };
    return []; // merge-state / other best-effort reads
  };
}

test("acceptance 3 — buildOpenPrViews resolves a plan-only filing PR's unmet criteria from the ledger without a task-id trailer", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w456-b-"));
  const lp = ledgerPath(dir);
  const prUrl = "https://github.com/craigoley/remudero/pull/900";
  const sha = "b".repeat(40);
  writeLedger(lp, [
    // The emitter's own positive record — the SAME `isPlanOnlyFilingPr` signal
    // `resolveOpenPrTaskId` already reads (W1-T453).
    { step: "pr.opened", pr_url: prUrl, plan_only: true },
    // The SAME synthetic `PR-<n>` key `reviewCommand` writes for every task-id-less review.
    {
      step: "review.posted",
      task_id: "PR-900",
      state: "failure",
      unmet_criteria: ["the filed shard's own acceptance block is well-formed"],
      reasons: ["a real defect: lint-plan flags a malformed acceptance block"],
    },
  ]);
  const prs = [restPr({ number: 900, headRefName: "chore/file-something", body: "no trailer — a filing PR", sha })];
  const reviewStatusesBySha = { [sha]: [{ context: "remudero-review", state: "failure" }] };

  const views = buildOpenPrViews("craigoley", "remudero", lp, {
    fetch: fetchFor(prs, reviewStatusesBySha),
    requiredContexts: () => [],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].taskId, undefined, "still never resolves a task id to credit — #1527 is untouched");
  assert.equal(
    views[0].criteriaRecoverable,
    false,
    "criteriaRecoverable stays keyed strictly to a resolved taskId (W1-T453's own regression lock, unchanged)",
  );
  assert.equal(views[0].unmetCriteria.length, 1, "the real ledger read now resolves without a trailer");
  assert.equal(views[0].unmetCriteria[0].claim, "the filed shard's own acceptance block is well-formed");

  // And that is what makes it RESOLVABLE, not merely observed: with strikes still available,
  // the sweep's own disposition table routes straight to the fix rung.
  const { disposition } = deriveDisposition(views[0], DEFAULT_SWEEP_POLICY, Date.parse("2026-08-13T20:00:00Z"));
  assert.equal(disposition, "blocked-fixable", "resolvable by the fix rung without a task-id trailer");
});

test("ordinary task-id-less PRs recover their own synthetic-key review evidence (PR #3559 regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w456-b-control-"));
  const lp = ledgerPath(dir);
  const sha = "c".repeat(40);
  // No `pr.opened{plan_only:true}` line for this PR — it is an ordinary agent-authored PR.
  writeLedger(lp, [
    { step: "review.posted", task_id: "PR-901", state: "failure", unmet_criteria: ["would-be unmet"], reasons: ["x"] },
  ]);
  const prs = [restPr({ number: 901, headRefName: "some-agent-branch", body: "no trailer, not a filing", sha })];
  const reviewStatusesBySha = { [sha]: [{ context: "remudero-review", state: "failure" }] };

  const views = buildOpenPrViews("craigoley", "remudero", lp, {
    fetch: fetchFor(prs, reviewStatusesBySha),
    requiredContexts: () => [],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].taskId, undefined);
  assert.equal(views[0].unmetCriteria.length, 1, "the PR-<n> identity written by reviewCommand is read back without a filing marker");
  assert.equal(views[0].unmetCriteria[0].claim, "would-be unmet");
  assert.equal(views[0].criteriaRecoverable, false, "synthetic review evidence never invents plan-task attribution");

  const { disposition } = deriveDisposition(views[0], DEFAULT_SWEEP_POLICY, Date.parse("2026-08-13T20:00:00Z"));
  assert.equal(disposition, "blocked-fixable", "the existing synthetic fix rung receives the observed unmet criterion");
});

test("an ordinary task-id-less PR with no matching synthetic review evidence invents no fix input", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2663-control-"));
  const lp = ledgerPath(dir);
  const sha = "d".repeat(40);
  writeLedger(lp, [
    { step: "review.posted", task_id: "PR-999", state: "failure", unmet_criteria: ["belongs elsewhere"], reasons: ["x"] },
  ]);
  const prs = [restPr({ number: 902, headRefName: "some-agent-branch", body: "no trailer", sha })];
  const reviewStatusesBySha = { [sha]: [{ context: "remudero-review", state: "failure" }] };

  const views = buildOpenPrViews("craigoley", "remudero", lp, {
    fetch: fetchFor(prs, reviewStatusesBySha),
    requiredContexts: () => [],
  });

  assert.deepEqual(views[0].unmetCriteria, [], "another PR's synthetic evidence is never borrowed");
  assert.equal(views[0].criteriaRecoverable, false);
  assert.equal(
    deriveDisposition(views[0], DEFAULT_SWEEP_POLICY, Date.parse("2026-08-13T20:00:00Z")).disposition,
    "blocked-ambiguous",
    "without observed fix evidence, the sweep retains its bounded escalation path",
  );
});

test("acceptance 3 — deriveDisposition (pure): a task-id-less PR with real unmet criteria routes blocked-fixable, never criteria-unrecoverable", () => {
  const filingPr: OpenPrView = {
    prNumber: 900,
    prUrl: "url/900",
    taskId: undefined,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      { claim: "the filed shard's acceptance block is well-formed", proof: "", met: false, reason: "malformed", proof_exec: "not_executable" },
    ],
    priorStrikes: 0,
    lastActivityAt: "2026-08-13T18:00:00.000Z",
    headSha: "b".repeat(40),
    autoMergeArmed: false,
    isPlanFiling: true,
  };
  const { disposition, reason } = deriveDisposition(filingPr, DEFAULT_SWEEP_POLICY, Date.parse("2026-08-13T20:00:00Z"));
  assert.equal(disposition, "blocked-fixable");
  assert.doesNotMatch(reason, /unrecoverable/, "never the trailer-required escalation wording");
});
