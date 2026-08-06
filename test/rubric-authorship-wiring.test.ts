import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, isDispatchedRunBranch, type ArmOutcome } from "../src/run-task.js";
import { checkSatisfiedByGuard } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * test/rubric-authorship-wiring.test.ts — W1-T385.
 *
 * THE DEFECT: `checkSatisfiedByGuard` exempts on `planOnly && humanAuthored`, but NOTHING in
 * the tree ever set `humanAuthored`. It was permanently `undefined`, so the exemption could
 * never fire and the advisory reported a worker-authored edit on hand-opened plan-only PRs —
 * the opposite of the truth. Two sessions re-derived that from source before it was fixed.
 *
 * WHY THIS DRIVES THE REAL `runReview` AND NOT A SEAM. The bug WAS the production default: the
 * field's value came from `runReview`'s own `rubricInput` literal, which no test had ever
 * observed. Every pre-existing test injected `humanAuthored` straight into
 * `checkSatisfiedByGuard`, so all four passed against a field production never populated —
 * exactly the shape CLAUDE.md records for the preflight spawn (every test supplied its own
 * seam, so the default never ran) and the plan-reloader that threw on every tick behind six
 * seam-injected tests. A test that injects `judgeRubricFn` or calls the guard directly would
 * reproduce that failure, so this file does neither.
 *
 * WHAT IT DRIVES INSTEAD: the REAL exported `runReview`, against a PATH-stubbed `gh` (the
 * technique test/run-review-holdout-integration.test.ts and test/review-status-gate.test.ts
 * already use). The only value supplied is `headRefName` — a genuine `runReview` argument that
 * `reviewCommand` already passes from `gh pr view` — and the assertion is made on the ADVISORY
 * TEXT the real code renders and hands to `gh pr comment`. Nothing between the argument and
 * the observation is stubbed: `judgeReview`, `judgeRubric`, `checkSatisfiedByGuard` and
 * `rubricAdvisorySection` all really run. What IS stubbed sits strictly AFTER the observation —
 * the post-verdict `arm`/`disarm`, for the reason spelled out at their call site below.
 *
 * LEFT UNPROVEN, NAMED RATHER THAN GLOSSED: that `reviewCommand` passes `headRefName` from a
 * LIVE `gh pr view` is read from source (`reviewViewArgs` requests the field and the
 * `runReviewDep({...})` literal forwards it), not exercised here — driving `reviewCommand`
 * end-to-end needs a real PR. The third case below covers the OTHER production call site
 * (`runFixRung`, which passes no head ref) by supplying none.
 */

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** The changeset every case shares: a PLAN-ONLY diff that edits an acceptance criterion —
 *  `criterionFieldTampered`'s removed-field arm, on `plan/tasks.yaml`. This is the withdrawal
 *  shape (W1-T229) an operator runs by hand and a worker must never run on its own task. */
const CRITERION_EDIT_DIFF = [
  "diff --git a/plan/tasks.yaml b/plan/tasks.yaml",
  "--- a/plan/tasks.yaml",
  "+++ b/plan/tasks.yaml",
  "@@ -1,3 +1,3 @@",
  "   acceptance:",
  '-      proof: "unit test: test/old.test.ts"',
  '+      proof: "grep: WITHDRAWN AS ALREADY SATISFIED in plan/tasks.yaml"',
].join("\n");

/** A `gh` stub answering what `runReview` drives, and CAPTURING the `pr comment` body — the
 *  channel the advisory actually reaches an operator through. */
function writeGhStub(binDir: string, commentFile: string): void {
  const script = `#!/bin/sh
case "$1 $2" in
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"abc1234def5678"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff")
    cat <<'RMDDIFF'
${CRITERION_EDIT_DIFF}
RMDDIFF
    ;;
  "pr comment")
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--body" ]; then printf '%s' "$2" >> ${commentFile}; fi
      shift
    done ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(binDir, "gh"), script, { mode: 0o755 });
}

/** One criterion the report SUBSTANTIATES, so the binding verdict passes and the only thing
 *  left to post is the advisory — the comment body is then the advisory and nothing else. */
const ACCEPTANCE: AcceptanceCriterion[] = [
  { claim: "SUBSTANTIATED-TOKEN the record is withdrawn", proof: "grep: WITHDRAWN in plan/tasks.yaml" },
];
const REPORT = "SUBSTANTIATED-TOKEN the record is withdrawn — WITHDRAWN, verified in plan/tasks.yaml.";

/** Drive the REAL `runReview` with the given head ref and return the advisory text it rendered. */
async function advisoryFor(headRefName: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "rmd-rubric-authorship-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const commentFile = join(root, "comment.txt");
  const binDir = mkdtempSync(join(tmpdir(), "rmd-gh-stub-"));
  writeGhStub(binDir, commentFile);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const config: Config = { claudeBin: "/bin/true", root };
  try {
    await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T385", acceptance: ACCEPTANCE },
      report: REPORT,
      settingsFile: join(root, "settings.json"), // unused: spawnReviewer is false
      config,
      log: () => {},
      say: () => {},
      account: (r: WorkerResult) => r,
      spawnReviewer: false,
      reviewerMount: MOUNT,
      headRefName,
      // THE POST-VERDICT ARM IS STUBBED, AND IT MUST BE. These cases are built so the binding
      // verdict PASSES (one substantiated criterion) — which is what leaves the advisory as the
      // only thing posted — and a passing verdict carries `runReview` on into
      // `armIfVerdictPermits`. Left to its default that runs the REAL `armAutoMerge`, whose
      // `realArmDeps().ledgerLines` calls `readLedgerLines(ledgerPathFor(loadConfig()))`: it reads
      // the MACHINE's own config file, `JSON.parse`s it, and would then `gh pr merge --auto`
      // against the stub. A unit test must never reach the operator-gated arm, and depending on a
      // parseable config outside the fixture makes the test environment-dependent — it passed
      // locally on a valid config and died on CI with `SyntaxError: Unexpected end of JSON input`.
      // `arm`/`disarm` are the seams declared for exactly this ("Exists so a unit test can assert
      // the withdrawal is ISSUED rather than mocking `gh`"). NOTHING under test is stubbed here:
      // both run strictly AFTER `rubric` is computed and posted, so the advisory this file asserts
      // on is unaffected. Neither is asserted — they are silenced, not observed.
      arm: (): ArmOutcome => "ledger-refused",
      disarm: () => {},
      ledgerPath,
      runId: "REVIEW-W1-T385",
    });
    return existsSync(commentFile) ? readFileSync(commentFile, "utf8") : "";
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

// ── DIRECTION 1: the exemption is REACHABLE for the first time ──────────────────────────────

// ASSERTED AS A PAIRED CONTRAST, NOT AS AN ABSENCE. The exempted case's observable signature
// is an EMPTY advisory — the guard is the only rubric item this diff trips, so exempting it
// leaves nothing to post and `rubricAdvisorySection` returns undefined. Asserting only "the
// bad string is absent" would then pass over an empty string for any reason at all, including
// a `runReview` that never reached the rubric. Running BOTH head refs through the same diff in
// one test makes the head ref the ONLY difference, so the contrast — and not either half — is
// the evidence.
test("runReview: the head ref alone decides the exemption — hand-opened is exempted, the identical diff on a run branch is not", async () => {
  const hand = await advisoryFor("chore/plan-record-corrections-2026-08-06");
  const run = await advisoryFor("run-W1-T385-1786012345678");

  assert.equal(hand, "", `a hand-opened plan-only PR trips no rubric item, so no advisory is posted; got:\n${hand}`);
  assert.notEqual(run, "", "the identical diff on a dispatched run branch MUST still produce an advisory");
  assert.match(run, /satisfied-by-guard/, "and that advisory must be the rule-15 guard");
  assert.ok(!/worker/i.test(hand), "the advisory never asserts a worker author on a hand-opened PR");
});

// ── DIRECTION 2: THE REGRESSION LOCK — rule 15's whole reason for existing ───────────────────

test("runReview: a plan-only criteria edit off a DISPATCHED RUN BRANCH is still refused — a worker may not rewrite its own acceptance to pass", async () => {
  const advisory = await advisoryFor("run-W1-T385-1786012345678");
  assert.match(
    advisory,
    /satisfied-by-guard/,
    "the guard must still appear in the advisory for a dispatched run's own branch",
  );
  assert.match(
    advisory,
    /dispatched run branch/,
    "the refusal must name the dispatched run branch as the reason, not guess at authorship",
  );
});

test("runReview: NO head ref (runFixRung's call site) fails CLOSED — absent is never read as human", async () => {
  const advisory = await advisoryFor(undefined);
  assert.match(
    advisory,
    /satisfied-by-guard/,
    "an absent head ref must not grant the exemption — that call site is a dispatched run by construction",
  );
});

// ── The predicate itself, over the branch shapes this repo has actually produced ─────────────

test("isDispatchedRunBranch: real dispatched heads match and real hand-opened heads do not", () => {
  for (const head of ["run-W1-T324-1785861181680", "run-W1-T369-1786000549178", "run-W1-T373-1786010835344"])
    assert.equal(isDispatchedRunBranch(head), true, `${head} is a dispatched run branch`);
  for (const head of [
    "claude/withdraw-w1t369",
    "chore/plan-record-corrections-2026-08-05",
    "claude/w1t324-lint-open-default",
    "run-without-a-timestamp",
    undefined,
  ])
    assert.equal(isDispatchedRunBranch(head), false, `${String(head)} is not a dispatched run branch`);
});

// ── The refusal message names the condition that failed, in BOTH failing directions ──────────

test("checkSatisfiedByGuard: the refusal names which condition failed and never guesses the author", () => {
  const notPlanOnly = checkSatisfiedByGuard(CRITERION_EDIT_DIFF, { planOnly: false, humanAuthored: true });
  assert.equal(notPlanOnly.pass, false);
  assert.match(notPlanOnly.reason, /not plan-only/, "a non-plan-only PR is refused on the plan-only condition");
  assert.ok(!/worker/i.test(notPlanOnly.reason), "a human-authored non-plan-only PR is never called worker-authored");

  const runBranch = checkSatisfiedByGuard(CRITERION_EDIT_DIFF, { planOnly: true, humanAuthored: false });
  assert.equal(runBranch.pass, false);
  assert.match(runBranch.reason, /dispatched run branch/, "a plan-only run-branch PR is refused on the head ref");
});
