import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import type { RubricInput } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import { runReview } from "../src/run-task.js";

// ── W1-T2232 — behaviour, not source text ───────────────────────────────────────────
//
// THE DEFECT this shard fixes (three call sites, all inside `runReview`'s own body):
//   - test/review.test.ts's "W1-T359 wiring: …" test read `src/run-task.ts` as text and
//     compared `indexOf("const computed = judgeReview(")` against `indexOf("judgeRubric(")`.
//   - test/arm-ordering.test.ts's "ORDERING: withdraw precedes the status post, …" test and
//     test/arm-on-passing-verdict.test.ts's "ORDERING: runReview withdraws BEFORE posting …"
//     test both did the same thing to `withdrawArmIfVerdictRefuses(`, `await
//     postReviewStatusGuarded({`, `log("review.posted", {` and `armIfVerdictPermits(`.
//
// Moving any one of those four call sites — reordering statements, extracting a helper,
// renaming a local — breaks the STRING POSITION without breaking the INVARIANT the test
// exists to protect (exactly the shape test/review.test.ts:1324's own comment names: "W1-T434
// WIDENED THIS GATE, AND THE INVARIANT DID NOT BREAK — only this test's literal encoding of
// it did"). `runReview`'s own args already expose an injectable observer for every one of
// these effects (`judgeRubricFn`, `disarm`, `log`, `arm`, and the real ledger file
// `ledgerPath` points at) — see W1-T359 (judgeRubricFn), impl-BF/impl-BG (disarm/arm) — so
// this rewrite needs no new seam: it drives `runReview` end-to-end (PATH-stubbed `gh`, the
// #2735 pattern) and asserts on the EFFECTS those calls have, in the order they actually
// happen at runtime, never on where their source text sits.
//
// TWO TRAPS, BOTH FROM W1-T2232'S OWN NOTE. (a) A green must never survive the ordered
// effect not running at all (W1-T1051) — every test below asserts the effect was REACHED
// (a captured call count, a ledgered step, a file that must exist) as well as its order, so
// deleting the call site fails the test on "never reached", not just leaves it vacuously
// green. (b) `live-write-guard` refuses `gh-pr-merge`/`gh-pr-merge --disable-auto` by
// checking the CALL, not the destination — a PATH-stubbed `gh` alone is not enough, so every
// scenario below injects a no-op `disarm`/`arm` unless that scenario is the one observing it.

/** A `gh` fake on PATH, the same "temp-dir fake gh" pattern test/review.test.ts already uses
 *  to drive `runReview` end-to-end without a real spawn or a real network call. `orderLog`
 *  additionally records the STATUS POST's own argv (never a marker standing in for it) —
 *  distinguished from every other `gh api` call by the one substring only a
 *  `repos/.../statuses/<sha>` URL carries. */
function writeGhScript(binDir: string, opts: { sha: string; diff: string; commentFile: string; orderLog?: string }): void {
  const orderLog = opts.orderLog;
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *statuses/*) ${orderLog ? `echo "GH $*" >> ${orderLog}; ` : ""}echo '{}' ;;
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"${opts.sha}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"${opts.sha}"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") cat <<'DIFF'
${opts.diff}
DIFF
    ;;
  "pr comment")
    shift 3
    printf '%s' "$2" > ${opts.commentFile}
    ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
}

/** One scratch root + fake-gh bin dir per scenario, so no two runs share a ledger, a lock
 *  dir or a posted-comment file. */
function harness(name: string, sha: string, diff: string, orderLog = false) {
  const root = mkdtempSync(join(tmpdir(), `rmd-wob-${name}-`));
  const binDir = mkdtempSync(join(tmpdir(), `rmd-wob-${name}-gh-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(join(root, "settings.json"), "{}", "utf8");
  const commentFile = join(root, "comment.txt");
  const orderLogPath = orderLog ? join(root, "order.log") : undefined;
  if (orderLogPath) writeFileSync(orderLogPath, "", "utf8");
  writeGhScript(binDir, { sha, diff, commentFile, orderLog: orderLogPath });
  return { root, binDir, ledgerPath, commentFile, orderLogPath };
}

/** Runs `run(prUrl)` with PATH pointed at `binDir`, restoring PATH unconditionally after —
 *  the same try/finally shape test/review.test.ts's own PATH-stubbed tests already use. */
async function withStubbedGh<T>(binDir: string, run: () => Promise<T>): Promise<T> {
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}:${oldPath}`;
    return await run();
  } finally {
    process.env.PATH = oldPath;
  }
}

const REVIEWER_MOUNT = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** `runReview`'s `log` callback is CALLER-OWNED — production callers append each step to the
 *  REAL ledger file themselves (see arm-ordering.test.ts's own harness); `runReview` never
 *  writes `ledgerPath` on `log`'s behalf. Tests that observe an effect through the real
 *  ledger file (TRAP 2's withdrawal, THE FIX's arm) need a `log` that does what every
 *  production caller already does. */
function ledgerLog(ledgerPath: string, runId: string, taskId: string): (step: string, extra?: Record<string, unknown>) => void {
  return (step, extra = {}) => {
    appendLedger(ledgerPath, { run_id: runId, task_id: taskId, step, ...extra });
  };
}

// A diff touching ONLY a plan/** path — no other file in it — so `judgeReview` computes
// `planOnly: true` deterministically (`diffFiles.every(isInPlanScope)`, lib/review.ts). This
// value cannot exist before `judgeReview` has run, so an injected `judgeRubricFn` that
// receives it is proof by DATA DEPENDENCY that the call happened after judgeReview's own
// call completed — never a proof by string position.
const PLAN_ONLY_DIFF = ["diff --git a/plan/tasks.yaml b/plan/tasks.yaml", "+++ b/plan/tasks.yaml", "@@", "+- id: W1-TFAKE-RUBRIC", "+  title: fake"].join(
  "\n",
);
// A never-substantiated criterion, so `hasUnmet` is true and the PR comment always posts —
// same fixture shape test/review.test.ts's own W1-T359 tests already use.
const UNMET_CRITERIA = [{ claim: "a claim the report never substantiates", proof: "unit test: no-such-test-title-xyzzy" }];
const UNMET_REPORT = "This report deliberately substantiates nothing.";

test("judgeRubric ordering: the injectable judgeRubricFn receives judgeReview's OWN computed planOnly — proof by data dependency, not text position", async () => {
  const h = harness("rubric-order", "cafe000000000000000000000000000000000001", PLAN_ONLY_DIFF);
  const rubricCalls: RubricInput[] = [];

  await withStubbedGh(h.binDir, () =>
    runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2001",
      task: { id: "W1-T2232-ORDER", acceptance: UNMET_CRITERIA },
      report: UNMET_REPORT,
      settingsFile: join(h.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: h.root } as never,
      log: () => {},
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      ledgerPath: h.ledgerPath,
      runId: "WOB-ORDER-1",
      disarm: () => "disarmed",
      judgeRubricFn: (input: RubricInput) => {
        rubricCalls.push(input);
        return undefined; // clean — this test is about ORDER, not content
      },
    } as never),
  );

  // REACHED-NESS: if the call site were ever deleted, this is 0, not "vacuously ordered".
  assert.equal(rubricCalls.length, 1, "the injectable judgeRubricFn must actually be reached");
  // ORDER: `planOnly` only exists once `judgeReview` has returned `computed` — receiving it
  // at all, let alone correctly, is only possible strictly after that call completed.
  assert.equal(rubricCalls[0].planOnly, true, "judgeRubricFn must receive judgeReview's own computed planOnly");
  // `gh pr diff`'s fake heredoc round-trips a trailing newline — trim, this is not the property
  // under test.
  assert.equal(rubricCalls[0].diff.trimEnd(), PLAN_ONLY_DIFF, "judgeRubricFn judges the SAME diff judgeReview just judged");
});

test("judgeRubric independence: the binding verdict and the non-advisory part of the posted comment are byte-identical whatever the rubric finds", async () => {
  const clean = harness("rubric-indep-clean", "cafe000000000000000000000000000000000002", PLAN_ONLY_DIFF);
  const violating = harness("rubric-indep-violating", "cafe000000000000000000000000000000000003", PLAN_ONLY_DIFF);
  let cleanCalls = 0;
  let violatingCalls = 0;

  const resultClean = await withStubbedGh(clean.binDir, () =>
    runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2002",
      task: { id: "W1-T2232-INDEP", acceptance: UNMET_CRITERIA },
      report: UNMET_REPORT,
      settingsFile: join(clean.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: clean.root } as never,
      log: () => {},
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      ledgerPath: clean.ledgerPath,
      runId: "WOB-INDEP-CLEAN-1",
      disarm: () => "disarmed",
      judgeRubricFn: () => {
        cleanCalls++;
        return undefined;
      },
    } as never),
  );
  const resultViolating = await withStubbedGh(violating.binDir, () =>
    runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2003",
      task: { id: "W1-T2232-INDEP", acceptance: UNMET_CRITERIA },
      report: UNMET_REPORT,
      settingsFile: join(violating.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: violating.root } as never,
      log: () => {},
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      ledgerPath: violating.ledgerPath,
      runId: "WOB-INDEP-VIOLATING-1",
      disarm: () => "disarmed",
      judgeRubricFn: () => {
        violatingCalls++;
        return { items: [], failures: [{ key: "one-concern", pass: false, reason: "test-injected rubric finding" }], pass: false } as never;
      },
    } as never),
  );

  assert.equal(cleanCalls, 1, "reached-ness: the clean run's judgeRubricFn must fire");
  assert.equal(violatingCalls, 1, "reached-ness: the violating run's judgeRubricFn must fire");
  assert.equal(resultViolating.state, resultClean.state, "the rubric result must never change the binding verdict's state");

  const postedClean = readFileSync(clean.commentFile, "utf8");
  const postedViolating = readFileSync(violating.commentFile, "utf8");
  const rubricHeader = "**Rubric (advisory";
  const separator = "\n\n---\n\n";
  assert.equal(postedClean.includes(rubricHeader), false, "a clean rubric adds nothing to the posted comment");
  assert.ok(postedViolating.includes(rubricHeader), "a violating rubric's section actually rides in the posted comment");
  // A violating run's comment is `<binding block><separator><rubric section>` (run-task.ts joins
  // `parts` with this exact separator) — strip BOTH the rubric section and its own separator so
  // what remains is only the binding block a clean run also produced.
  const sepBeforeRubric = postedViolating.indexOf(separator + rubricHeader);
  assert.ok(sepBeforeRubric > -1, "the rubric section must be joined onto the binding block by the standard separator");
  const violatingWithoutRubric = postedViolating.slice(0, sepBeforeRubric).trimEnd();
  assert.equal(
    violatingWithoutRubric,
    postedClean.trimEnd(),
    "the binding content of the comment (everything before the advisory section) must be byte-identical " +
      "regardless of what the rubric found",
  );
});

test("judgeRubric's advisory section is a top-level disjunct of the comment gate — it posts even on an otherwise-passing review with no unmet criteria", async () => {
  const h = harness("rubric-gate-disjunct", "cafe000000000000000000000000000000000004", [
    "diff --git a/src/lib/alpha.ts b/src/lib/alpha.ts",
    "+++ b/src/lib/alpha.ts",
    "@@",
    "+export function alpha(): number {",
    "+  return 1;",
    "+}",
  ].join("\n"));
  let rubricCalls = 0;

  await withStubbedGh(h.binDir, () =>
    runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2004",
      // satisfied_by: an ARCHITECT-only override the deterministic judge treats as MET —
      // so hasUnmet is false and the ordinary unmet-criteria block never fires.
      task: {
        id: "W1-T2232-GATE",
        acceptance: [{ claim: "already covered", proof: "unit test: test/existing-coverage.test.ts", satisfied_by: "https://github.com/acme/remudero/pull/1200" }],
      },
      report: "N/A — satisfied_by architect override",
      settingsFile: join(h.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: h.root } as never,
      log: () => {},
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      ledgerPath: h.ledgerPath,
      runId: "WOB-GATE-1",
      arm: () => "armed",
      judgeRubricFn: (input: RubricInput) => {
        rubricCalls++;
        assert.equal(input.planOnly, false, "this diff touches src/, so judgeReview must compute planOnly:false");
        return { items: [], failures: [{ key: "one-concern", pass: false, reason: "test-injected rubric finding" }], pass: false } as never;
      },
    } as never),
  );

  assert.equal(rubricCalls, 1, "reached-ness: judgeRubricFn must fire even on a passing review");
  // REACHED-NESS for the comment gate itself: if `rubricSection` stopped being a disjunct,
  // the gate would never open (hasUnmet is false here) and `commentFile` would never be
  // written — this read throws ENOENT rather than silently passing.
  const posted = readFileSync(h.commentFile, "utf8");
  assert.ok(posted.includes("**Rubric (advisory"), "the rubric section must post on its own, independent of hasUnmet");
});

test("judgeRubric fail-open: a throwing judgeRubricFn is ledgered and degrades to today's review — the binding post is byte-identical to a non-throwing baseline", async () => {
  const baseline = harness("rubric-throw-baseline", "cafe000000000000000000000000000000000005", PLAN_ONLY_DIFF);
  const throwing = harness("rubric-throw", "cafe000000000000000000000000000000000006", PLAN_ONLY_DIFF);
  const baselineSteps: string[] = [];
  const throwingSteps: string[] = [];

  const runOnce = (h: ReturnType<typeof harness>, runId: string, steps: string[], judgeRubricFn: () => unknown) =>
    withStubbedGh(h.binDir, () =>
      runReview({
        owner: "acme",
        repo: "remudero",
        prUrl: `https://github.com/acme/remudero/pull/${runId === "WOB-THROW-BASE-1" ? 2005 : 2006}`,
        task: { id: "W1-T2232-THROW", acceptance: UNMET_CRITERIA },
        report: UNMET_REPORT,
        settingsFile: join(h.root, "settings.json"),
        config: { claudeBin: "/bin/true", root: h.root } as never,
        log: (step: string) => void steps.push(step),
        say: () => {},
        account: (r: never) => r,
        spawnReviewer: false,
        reviewerMount: REVIEWER_MOUNT,
        ledgerPath: h.ledgerPath,
        runId,
        disarm: () => "disarmed",
        judgeRubricFn: judgeRubricFn as never,
      } as never),
    );

  await runOnce(baseline, "WOB-THROW-BASE-1", baselineSteps, () => undefined);
  await runOnce(throwing, "WOB-THROW-1", throwingSteps, () => {
    throw new Error("rubric exploded");
  });

  // REACHED-NESS: the catch's own ledger step, never inferred from silence.
  assert.ok(throwingSteps.includes("review.rubric.error"), "a thrown judgeRubricFn must be ledgered, never swallowed silently");
  assert.equal(baselineSteps.includes("review.rubric.error"), false, "the non-throwing baseline never logs the error step");

  const postedBaseline = readFileSync(baseline.commentFile, "utf8");
  const postedThrowing = readFileSync(throwing.commentFile, "utf8");
  assert.equal(
    postedThrowing.trimEnd(),
    postedBaseline.trimEnd(),
    "FAIL-OPEN: a throw drops only the advisory section — the binding post must be unaffected",
  );
});

test("TRAP 2 preserved: the withdrawal beats the status POST to GitHub — observed through the injected disarm and the real gh argv order log", async () => {
  const sha = "cafe000000000000000000000000000000000007";
  const diff = [
    "diff --git a/src/lib/alpha.ts b/src/lib/alpha.ts",
    "+++ b/src/lib/alpha.ts",
    "@@",
    "+export function alpha(): number {",
    "+  return 1;",
    "+}",
  ].join("\n");
  const h = harness("withdraw-before-post", sha, diff, /* orderLog */ true);
  let disarmCalls = 0;

  await withStubbedGh(h.binDir, () =>
    runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2007",
      // A never-substantiated criterion with no headCheckoutDir: `capped: true`, and a
      // CAPPED, non-plan-only verdict is exactly the "SAFETY LOCK" shape (arm-ordering.test.ts's
      // own #4) that `decideAutoMergeArm` refuses — so `withdrawArmIfVerdictRefuses` actually
      // calls `disarm` here (reached-ness for the whole test).
      task: { id: "W1-T2232-WITHDRAW", acceptance: UNMET_CRITERIA },
      report: UNMET_REPORT,
      settingsFile: join(h.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: h.root } as never,
      log: ledgerLog(h.ledgerPath, "WOB-WITHDRAW-1", "W1-T2232-WITHDRAW"),
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      ledgerPath: h.ledgerPath,
      runId: "WOB-WITHDRAW-1",
      disarm: (prUrl: string) => {
        disarmCalls++;
        appendFileSync(h.orderLogPath!, `DISARM ${prUrl}\n`);
        return "disarmed";
      },
    } as never),
  );

  // REACHED-NESS: the withdrawal actually fired, both as a JS call AND as a real ledger line.
  assert.equal(disarmCalls, 1, "reached-ness: the injectable disarm must actually be called");
  const ledgerLines = readLedgerLines(h.ledgerPath);
  assert.ok(
    ledgerLines.some((l) => l.step === "automerge.disarmed" && l.task_id === "W1-T2232-WITHDRAW"),
    "reached-ness: the withdrawal must be ledgered as `automerge.disarmed`, not merely attempted",
  );

  const orderLines = readFileSync(h.orderLogPath!, "utf8").trim().split("\n").filter(Boolean);
  const disarmIdx = orderLines.findIndex((l) => l.startsWith("DISARM"));
  const statusPostIdxs = orderLines
    .map((l, i) => ({ l, i }))
    .filter((x) => x.l.startsWith("GH") && x.l.includes("statuses/"))
    .map((x) => x.i);
  assert.ok(disarmIdx !== -1, "reached-ness: the disarm marker must be in the order log");
  assert.ok(statusPostIdxs.length >= 1, "reached-ness: the status POST's own gh argv must be in the order log");
  const lastStatusPostIdx = statusPostIdxs[statusPostIdxs.length - 1]!;
  assert.ok(
    disarmIdx < lastStatusPostIdx,
    `TRAP 2: the withdrawal (line ${disarmIdx}) must precede the status POST's own argv (line ${lastStatusPostIdx}) — ` +
      `it must beat GitHub to the merge (#973). Order log:\n${orderLines.join("\n")}`,
  );
});

test("THE FIX preserved: the arm follows the review.posted ledger write — observed through the injected arm reading the real ledger file at call time", async () => {
  const sha = "cafe000000000000000000000000000000000008";
  const diff = [
    "diff --git a/src/lib/beta.ts b/src/lib/beta.ts",
    "+++ b/src/lib/beta.ts",
    "@@",
    "+export function beta(): number {",
    "+  return 2;",
    "+}",
  ].join("\n");
  const h = harness("arm-after-ledger", sha, diff);
  let armCalls = 0;
  let sawReviewPostedAtArmTime = false;

  await withStubbedGh(h.binDir, () =>
    runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2008",
      // satisfied_by: an ARCHITECT override the deterministic judge treats as MET and excludes
      // from `executableCriteria` — so `capped: false`, `planOnly: false`, `state: "success"`,
      // and `decideAutoMergeArm` permits arming (reached-ness for the whole test).
      task: {
        id: "W1-T2232-ARM",
        acceptance: [{ claim: "already covered", proof: "unit test: test/existing-coverage.test.ts", satisfied_by: "https://github.com/acme/remudero/pull/1300" }],
      },
      report: "N/A — satisfied_by architect override",
      settingsFile: join(h.root, "settings.json"),
      config: { claudeBin: "/bin/true", root: h.root } as never,
      log: ledgerLog(h.ledgerPath, "WOB-ARM-1", "W1-T2232-ARM"),
      say: () => {},
      account: (r: never) => r,
      spawnReviewer: false,
      reviewerMount: REVIEWER_MOUNT,
      ledgerPath: h.ledgerPath,
      runId: "WOB-ARM-1",
      arm: (prUrl: string, taskId: string) => {
        armCalls++;
        // THE FIX, observed directly: read the REAL ledger file at the moment `arm` is
        // called — the `review.posted` line must already be on disk, because that line IS
        // the evidence W1-T230's own gate (armAutoMerge -> priorReviewVerdictFromLedger)
        // requires. This asserts on the FILE, never on where the call site sits in
        // run-task.ts.
        const lines = readLedgerLines(h.ledgerPath);
        sawReviewPostedAtArmTime = lines.some((l) => l.step === "review.posted" && l.task_id === taskId);
        return "armed";
      },
    } as never),
  );

  // REACHED-NESS: if the arm call site were ever deleted, armCalls stays 0.
  assert.equal(armCalls, 1, "reached-ness: the injectable arm must actually be called");
  assert.ok(sawReviewPostedAtArmTime, "THE FIX: the review.posted ledger line must already exist when arm is invoked");
});
