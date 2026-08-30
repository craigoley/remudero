import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import { CLAUDE_BIN_ENV_OVERRIDE } from "../src/lib/worker.js";
import { runReview } from "../src/run-task.js";
import { judgeReview, planOnlyDiff, reviewerOutcome } from "../src/lib/review.js";

/**
 * W1-T2472: a PLAN-ONLY review spawned an advisory reviewer worker to discover there was nothing
 * to execute. The spawn is now skipped on a plan-only diff.
 *
 * The load-bearing claim is NOT "fewer spawns" — it is that skipping cannot change the verdict.
 * `judgeReview` decides a plan-only diff's state on `floorUnmet`, and `floorMet` is captured
 * before the semantic downgrade arm, so the reviewer's only output (`semantic[]`) is inert there.
 * The first test below proves that directly, without any harness: the same diff judged WITH a
 * full set of semantic downgrades and WITHOUT any semantic input at all must produce a
 * byte-identical summary and state.
 */

const PLAN_ONLY_DIFF = [
  "diff --git a/plan/tasks.d/W1-T9999-x.yaml b/plan/tasks.d/W1-T9999-x.yaml",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/plan/tasks.d/W1-T9999-x.yaml",
  "@@ -0,0 +1,2 @@",
  "+- id: W1-T9999",
  "+  title: a filing",
].join("\n");

/** The SAME diff plus one `src/` file — the boundary `planOnly` draws. */
const PLAN_PLUS_SRC_DIFF = [
  PLAN_ONLY_DIFF,
  "diff --git a/src/lib/worker.ts b/src/lib/worker.ts",
  "--- a/src/lib/worker.ts",
  "+++ b/src/lib/worker.ts",
  "@@ -1,1 +1,1 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

// The proof's own keywords are what the mechanical floor scores against the report (`proofKeywords`),
// so REPORT is written to cover them: without that the criterion is unmet on BOTH sides and the
// byte-identical assertion below passes by comparing two identical FAILs. Measured: with the first
// fixture tried, `met` was false and the invariant test was vacuous.
const CRITERIA = [{ claim: "the advisory reviewer spawn is skipped", proof: "the advisory reviewer spawn is skipped for a filing changeset" }];
const REPORT =
  "The advisory reviewer spawn is skipped for a filing changeset: skipped advisory reviewer, filing changeset, spawn skipped.";

test("skipping the spawn cannot change a plan-only verdict: judging WITH full semantic downgrades and WITHOUT any semantic input is byte-identical", () => {
  const evidence = { diff: PLAN_ONLY_DIFF, report: REPORT };
  const withSpawn = judgeReview(CRITERIA as never, { ...evidence, semantic: [false] } as never);
  const withoutSpawn = judgeReview(CRITERIA as never, evidence as never);

  assert.equal(withSpawn.planOnly, true, "the fixture must actually be plan-only, or this proves nothing");
  // ANTI-VACUITY: the criterion must be MET, or both sides are the same FAIL and the equality below
  // is trivially true. `semantic === false` can only downgrade something that passed.
  assert.equal(withoutSpawn.criteria?.[0]?.met, true, "the criterion must pass on the floor, or the downgrade has nothing to move");
  assert.equal(
    withoutSpawn.summary,
    withSpawn.summary,
    "the plan-only verdict STRING must not move when the advisory reviewer is skipped",
  );
  assert.equal(withoutSpawn.state, withSpawn.state, "nor may the state move");
  assert.equal(withoutSpawn.floorState, withSpawn.floorState, "nor the floor state");
});

test("CONTROL: on a diff carrying src/, a semantic downgrade DOES move the verdict — so the test above is not vacuous", () => {
  const evidence = { diff: PLAN_PLUS_SRC_DIFF, report: REPORT };
  const withSpawn = judgeReview(CRITERIA as never, { ...evidence, semantic: [false] } as never);
  const withoutSpawn = judgeReview(CRITERIA as never, evidence as never);

  assert.equal(withSpawn.planOnly, false, "the control fixture must NOT be plan-only");
  assert.equal(withoutSpawn.criteria?.[0]?.met, true, "and its criterion must also pass on the floor, so the two fixtures differ only in plan-only-ness");
  assert.notEqual(
    withoutSpawn.summary,
    withSpawn.summary,
    "a code diff must still be sensitive to the semantic lane, or the invariant above is trivially true everywhere",
  );
});

test("planOnlyDiff draws the boundary at one src/ file, in BOTH directions", () => {
  assert.equal(planOnlyDiff(PLAN_ONLY_DIFF), true, "a pure plan diff is plan-only");
  assert.equal(planOnlyDiff(PLAN_PLUS_SRC_DIFF), false, "acquiring ONE src/ file must lose it");
  assert.equal(planOnlyDiff(""), false, "an empty diff is not plan-only — the length>0 clause is preserved");
});

test("planOnlyDiff is the SAME predicate judgeReview classifies on, not a second copy", () => {
  for (const diff of [PLAN_ONLY_DIFF, PLAN_PLUS_SRC_DIFF, ""]) {
    const verdict = judgeReview(CRITERIA as never, { diff, report: "x" } as never);
    assert.equal(
      planOnlyDiff(diff),
      verdict.planOnly,
      "the spawn gate and the classification must never disagree about the same diff",
    );
  }
});

test("reviewerOutcome reports the plan-only skip DISTINCTLY, without disturbing the values it already had", () => {
  assert.equal(reviewerOutcome({ attempted: false, planOnlySkip: true }), "not_attempted_plan_only");
  // The three shipped values are unchanged — a new cause must not rename an existing one.
  assert.equal(reviewerOutcome({ attempted: false }), "not_attempted");
  assert.equal(reviewerOutcome({ attempted: true, spawnError: true }), "spawn_error");
  assert.equal(reviewerOutcome({ attempted: true, subtype: "success" }), "success");
  assert.notEqual(
    reviewerOutcome({ attempted: false, planOnlySkip: true }),
    reviewerOutcome({ attempted: false }),
    "a plan-only skip must be countable in the ledger, not folded into the generic never-dispatched case",
  );
});

// ── The driven halves: a real runReview on each side of the boundary, with the spawn COUNTED ──

type Driven = { spawns: number; outcome: string; steps: string[]; summary: string };

async function driveReview(diffText: string): Promise<Driven> {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-only-spawn-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-plan-only-spawn-gh-"));
  const oldPath = process.env.PATH;
  const oldClaudeBin = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent-reviewerQueryFn-intercepts-the-spawn";
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeClaude, 0o755);
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;

    const ledgerPath = join(root, "ledger.ndjson");
    const diffFile = join(root, "diff.txt");
    writeFileSync(diffFile, diffText, "utf8");
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"cafebabe0002"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"cafebabe0002"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") cat ${JSON.stringify(diffFile)} ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${oldPath}`;

    let spawns = 0;
    const steps: string[] = [];
    const reviewerQueryFn = (() => {
      spawns += 1;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "REVIEW_VERDICT 1: PASS",
          session_id: "s-plan-only-spawn",
          total_cost_usd: 0.01,
          num_turns: 1,
        };
      })();
    }) as unknown as Parameters<typeof runReview>[0]["reviewerQueryFn"];

    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T2472", acceptance: CRITERIA },
      report: REPORT,
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as never,
      log: (step: string) => steps.push(step),
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: true,
      reviewerQueryFn,
      // Both arm seams injected: the plan-only fixture PASSES, so runReview reaches
      // armIfVerdictPermits, which refuses to touch its production dependency under the test
      // runner without an explicit seam. Nothing live happens on either path.
      arm: () => "skipped",
      disarm: () => {},
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 },
      ledgerPath,
      runId: "REVIEW-PLAN-ONLY-SPAWN-1",
    } as never);

    // The ledger is the durable record the outcome claim rests on — read it back rather than
    // trusting only the in-process `log` callback.
    const ledgerSteps = readLedgerLines(ledgerPath).map((l) => String(l.step));
    return { spawns, outcome: verdict.reviewerOutcome, steps: [...steps, ...ledgerSteps], summary: verdict.summary };
  } finally {
    process.env.PATH = oldPath;
    if (oldClaudeBin === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaudeBin;
    if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("DRIVEN: a plan-only review spawns ZERO workers, and says so in the ledger and the outcome", async () => {
  const r = await driveReview(PLAN_ONLY_DIFF);
  console.log(`    PLAN-ONLY  spawns=${r.spawns}  outcome=${r.outcome}`);
  assert.equal(r.spawns, 0, `a plan-only review must spawn no reviewer (spawns=${r.spawns})`);
  assert.equal(r.outcome, "not_attempted_plan_only", "and the outcome must name WHY it was skipped");
  assert.ok(
    r.steps.includes("review.reviewer.skipped"),
    `the ledger must carry the skip row so the path is countable — saw: ${r.steps.join(", ")}`,
  );
  assert.ok(!r.steps.includes("review.reviewer"), "and must not claim a reviewer ran");
});

test("the outcome reports the skip only when a spawn REALLY did not happen — it is not derived from the classification alone", () => {
  // The falsifier for this suite removes the spawn gate. Before this assertion existed, that left
  // `not_attempted_plan_only` being reported on a run that HAD spawned: the ledger lying in the
  // one direction reviewerOutcome exists to prevent. `attempted` and the skip flag must disagree
  // for the skip to be claimed.
  assert.equal(reviewerOutcome({ attempted: true, subtype: "success", planOnlySkip: false }), "success");
  assert.equal(
    reviewerOutcome({ attempted: false, planOnlySkip: true }),
    "not_attempted_plan_only",
    "a genuine skip still reports distinctly",
  );
});

test("DRIVEN CONTROL: the same harness on a plan+src diff STILL spawns — the skip is scoped to plan-only", async () => {
  const r = await driveReview(PLAN_PLUS_SRC_DIFF);
  console.log(`    PLAN+SRC   spawns=${r.spawns}  outcome=${r.outcome}`);
  assert.equal(r.spawns, 1, `a diff carrying src/ must still spawn (spawns=${r.spawns})`);
  assert.notEqual(r.outcome, "not_attempted_plan_only", "and must not report the plan-only skip");
  assert.ok(!r.steps.includes("review.reviewer.skipped"), "nor emit the skip row");
});

test("DRIVEN: the plan-only verdict summary still reads as deterministically gated, unchanged by the skip", async () => {
  const r = await driveReview(PLAN_ONLY_DIFF);
  // BYTE-EXACT, not a loose match: the brief's constraint is that this sentence stays true AND
  // stays printed, so the assertion pins the whole string rather than a fragment of it.
  assert.equal(
    r.summary,
    "remudero-review: PASS — plan-only PR (1 criteria), gated deterministically " +
      "(lint-plan + the plan-PR emitter + plan-index checks); no proof execution attempted, by design (W1-T205)",
    "the plan-only verdict string must be byte-identical to what it was before the spawn was skipped",
  );
});
