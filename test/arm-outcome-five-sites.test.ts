import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  armAndLogOutcome,
  armIfVerdictPermits,
  armReportPhrase,
  armAutoMerge,
  type ArmDeps,
  type ArmOutcome,
} from "../src/run-task.js";
import { isInPlanScope, ORIENTATION_DOC } from "../src/lib/plan-architect.js";

// ── THE DEFECT ────────────────────────────────────────────────────────────────────────
// `armAutoMerge` RETURNS which of its seven branches it took; it never throws. Five of the
// seven armed NOTHING. PR #968 taught the SWEEP to read that value. Five Architect lanes —
// dep-review, retro, triage, plan, approve — each still did `armAutoMerge(...)` followed by
// an unconditional `log("automerge.armed", {})`, so the ledger recorded an arm for PRs that
// had been explicitly refused, and the console printed "gated + armed" on a refusal.
//
// The worst instance was not intermittent, it was total: `retroCommand` armed with the
// hardcoded literal "RETRO" while `reviewCommand` keyed its verdict to the full run id off
// the PR trailer. Counted over the live ledger unioned with all 660 rotations, `review.posted`
// rows keyed exactly "RETRO" = 0 and rows keyed RETRO* = 7795 — the literal never matched a
// verdict once, so every retro PR in this repo's history was refused and then logged as armed.

const SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

/** The window of source around a lane's own console line — where that lane's arm site lives. */
function laneWindow(anchor: string, before = 14): string {
  const at = SRC.indexOf(anchor);
  assert.ok(at > 0, `anchor not found, the test is stale: ${anchor}`);
  const head = SRC.slice(0, at).split("\n");
  return head.slice(Math.max(0, head.length - before)).join("\n") + "\n" + anchor;
}

/** Records every ledger step a site emitted, so a test asserts the CALL, not that code ran. */
function recorder() {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { steps, log: (step: string, extra?: Record<string, unknown>) => void steps.push({ step, extra }) };
}

const NON_ARMING: ArmOutcome[] = [
  "no-task-id",
  "head-unavailable",
  "ledger-refused",
  "direct-merge-failed",
  "arm-error-ignored",
];

// ── 1: a non-arming outcome ledgers the skip, never the arm ─────────────────────────
test("armAndLogOutcome ledgers automerge.arm_skipped with the outcome when the arm refused", () => {
  for (const outcome of NON_ARMING) {
    const r = recorder();

    const got = armAndLogOutcome("https://github.com/craigoley/remudero/pull/974", "RETRO-1785456064479", r.log, () => outcome);

    assert.equal(got, outcome, `${outcome}: the caller is handed the real outcome, not a boolean`);
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["automerge.arm_skipped"],
      `${outcome}: exactly one line, and it is the SKIP — logging automerge.armed here is what made that step meaningless`,
    );
    assert.equal(r.steps[0].extra?.outcome, outcome, `${outcome}: the reason travels on the line, not only to stdout`);
    assert.equal(r.steps[0].extra?.task_id, "RETRO-1785456064479", `${outcome}: attributable to the task it was refused for`);
  }
});

// ── 2: REGRESSION LOCK — an arming outcome still logs the arm ───────────────────────
test("armAndLogOutcome ledgers automerge.armed only when the outcome actually armed", () => {
  for (const outcome of ["armed", "direct-merged"] as ArmOutcome[]) {
    const r = recorder();

    const got = armAndLogOutcome("https://github.com/craigoley/remudero/pull/974", "W1-T195", r.log, () => outcome);

    assert.equal(got, outcome);
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["automerge.armed"],
      `${outcome}: this did NOT turn every lane into a reporter of failure — a real arm still reads as one`,
    );
    assert.equal(r.steps[0].extra?.outcome, outcome);
  }
});

// ── 3: no site anywhere still logs the unconditional bare line ──────────────────────
test("no lane logs a bare unconditional automerge.armed anywhere across run-task", () => {
  const bare = SRC.split('log("automerge.armed", {});').length - 1;

  assert.equal(bare, 0, "every one of the five sites used this exact pair; none may remain");
});

// ── 4-8: PER SITE — each lane reads the outcome ─────────────────────────────────────
test("SITE dep-review reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`remudero-review=success posted + auto-merge ${armReportPhrase(armOutcome)}: ${view.url}`");

  assert.match(w, /armAndLogOutcome\(view\.url, taskId, log, deps\.arm\)/, "the dep-review lane arms through the reporting wrapper");
  assert.doesNotMatch(w, /armAutoMerge\(view\.url/, "and no longer calls armAutoMerge with its outcome dropped");
});

test("SITE retro reads the arm outcome and passes runId, never the literal RETRO", () => {
  const w = laneWindow("`retro PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`", 20);

  assert.match(w, /armAndLogOutcome\(prUrl, runId, log\)/, "the id passed is runId — the one the trailer and the verdict agree on");
  assert.equal(SRC.includes('armAutoMerge(prUrl, "RETRO")'), false, "the hardcoded literal that never matched a verdict is gone");
  assert.equal(SRC.includes('ensureTaskTrailer(prUrl, "RETRO")'), false, "and the fallback trailer stamp uses the same id");
});

test("SITE triage reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`triage PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`");

  assert.match(w, /armAndLogOutcome\(prUrl, taskId, log\)/);
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

test("SITE plan reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`plan PR gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${prUrl}`");

  assert.match(w, /armAndLogOutcome\(prUrl, taskId, log\)/);
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

test("SITE approve reads the arm outcome rather than discarding it", () => {
  const w = laneWindow("`rmd approve: ${proposalId} gated — ${armReportPhrase(armOutcome)} (review ${reviewCode === 0 ? \"success\" : \"failure\"}): ${result.prUrl}`", 18);

  assert.match(w, /armAndLogOutcome\(result\.prUrl, `PR-\$\{prNum\}`, log\)/);
  assert.doesNotMatch(w, /log\("automerge\.armed"/, "the unconditional ledger line is gone from this lane");
});

// ── 9: the SIXTH site the brief did not name — #968 was inert without it ────────────
test("SITE sweep adapter returns the arm outcome so the sweep can read it at all", () => {
  assert.match(
    SRC,
    /arm: \(pr\) => armAutoMerge\(pr\.prUrl, pr\.taskId\),/,
    "the adapter RETURNS the outcome — as a braced body it resolved to undefined, which armOutcomeArmed treats as armed, so the sweep's own check could never fire",
  );
  assert.equal(
    SRC.includes("arm: (pr) => {\n      armAutoMerge(pr.prUrl, pr.taskId);\n    },"),
    false,
    "the discarding form is gone",
  );
});

// ── 10: THE KEY — the same ledger, two ids, opposite outcomes ───────────────────────
test("THE KEY: the literal RETRO is refused where runId arms, against one identical ledger", () => {
  const HEAD = "5596ab04802a916c740858e75bc950774d38c504";
  const RUN_ID = "RETRO-1785456064479";
  // The shape PR #974 actually wrote: `reviewCommand` keyed the verdict to the full run id.
  const ledger = [{ step: "review.posted", task_id: RUN_ID, head_sha: HEAD, state: "success" }];
  const said: string[] = [];
  let armCalls = 0;
  const deps: ArmDeps = {
    headSha: () => HEAD,
    ledgerLines: () => ledger,
    armAuto: () => void armCalls++,
    mergeDirect: () => assert.fail("no direct merge should be reached by this fixture"),
    disableAuto: () => assert.fail("nothing is disarmed here"),
    say: (m) => void said.push(m),
  };

  const withLiteral = armAutoMerge("https://github.com/craigoley/remudero/pull/974", "RETRO", deps);
  const armsAfterLiteral = armCalls;
  const withRunId = armAutoMerge("https://github.com/craigoley/remudero/pull/974", RUN_ID, deps);

  assert.equal(withLiteral, "ledger-refused", "the literal finds no verdict — this is every retro PR ever opened");
  assert.equal(armsAfterLiteral, 0, "and nothing was armed on that path, whatever the ledger line claimed");
  assert.match(said[0], /no ledgered review.posted verdict found/, "the refusal names itself, to stdout only");
  assert.equal(withRunId, "armed", "the id the trailer actually carries finds the verdict and arms");
  assert.equal(armCalls, 1, "exactly one real arm was issued — the key repair proven against one unchanged ledger");
});

// ── 11: the console string ──────────────────────────────────────────────────────────
test("the console phrase on a refusal never claims the PR was armed", () => {
  for (const outcome of NON_ARMING) {
    const phrase = armReportPhrase(outcome);

    assert.equal(phrase, `NOT armed (${outcome})`, `${outcome}: says what happened, and names which branch`);
    assert.doesNotMatch(phrase, /^armed/, `${outcome}: cannot be read as an arm`);
  }
  assert.equal(armReportPhrase("armed"), "armed (armed)");
  assert.equal(armReportPhrase("direct-merged"), "armed (direct-merged)", "a clean-status direct merge IS a success");
});

// ── 12: the seventh site — #975's own post-verdict arm named its step unconditionally ─
test("armIfVerdictPermits names its ledger step from the outcome rather than always the arm", () => {
  const ctx = {
    prUrl: "https://github.com/craigoley/remudero/pull/974",
    taskId: "PR-974",
    headSha: "5596ab0",
    ledgerPath: "/dev/null",
    log: recorder().log,
  };
  const refusedSteps = recorder();
  const armedSteps = recorder();

  armIfVerdictPermits({ state: "success", capped: false, planOnly: false }, { ...ctx, log: refusedSteps.log }, {
    arm: () => "ledger-refused",
    ledgerLines: () => [],
  });
  armIfVerdictPermits({ state: "success", capped: false, planOnly: false }, { ...ctx, log: armedSteps.log }, {
    arm: () => "armed",
    ledgerLines: () => [],
  });

  assert.deepEqual(
    refusedSteps.steps.map((s) => s.step),
    ["automerge.arm_skipped"],
    "a head-drift or missing-verdict refusal here used to still read as automerge.armed",
  );
  assert.deepEqual(armedSteps.steps.map((s) => s.step), ["automerge.armed"], "a real arm is unchanged");
});

// ── 13: the plan-scope half, proven to be exactly one named path ────────────────────
test("plan scope admits the regenerated ORIENTATION doc as one named path, never a docs prefix", () => {
  assert.equal(ORIENTATION_DOC, "docs/ORIENTATION.md");

  assert.equal(isInPlanScope(ORIENTATION_DOC), true, "the file rmd retro regenerates on every run is plan scope");
  assert.equal(isInPlanScope("MASTER-PLAN.md"), true, "unchanged");
  assert.equal(isInPlanScope("plan/tasks.yaml"), true, "unchanged");
  // NO PREFIX WIDENING. A `docs/` prefix would hand the W1-T205 arm-without-proof carve-out to
  // every documentation change; only this one regenerated projection is admitted.
  assert.equal(isInPlanScope("docs/README.md"), false, "a sibling doc stays out of scope");
  assert.equal(isInPlanScope("docs/orientation.md"), false, "the match is exact, not case-folded");
  assert.equal(isInPlanScope("docs/ORIENTATION.md.bak"), false, "and not a prefix of the named path");
  assert.equal(isInPlanScope("src/run-task.ts"), false, "code is still never plan scope");
});

// ── 14: dep-review's ARM BRANCH, driven for real ────────────────────────────────────
// The one lane this PR touched that no test could previously reach: `ghJson`, `gh pr diff` and
// `postReviewStatusGuarded` were all hardcoded, so `diff-coverage` correctly reported the changed
// arm lines as adding uncovered source. impl-BI gave it the same optional-deps seam PR #964 gave
// triage/plan. Nothing here touches the network: every effect is injected, and `config` is passed
// because `loadConfig()` shells `which claude`, which no CI runner has (W1-T2 / PR #18).
test("dep-review drives its arm branch to a real outcome and reports that outcome, not a fixed string", async () => {
  const { depReviewCommand } = await import("../src/run-task.js");
  const tmp = mkdtempSync(join(tmpdir(), "rmd-bi-depreview-"));
  // ledgerPathFor(config) is `<root>/state/ledger.ndjson` — read the real path, do not guess it.
  const ledgerPath = join(tmp, "state", "ledger.ndjson");
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));

  let code: number;
  try {
    code = await depReviewCommand("80", ["--repo", "remudero"], {
      config: { root: tmp, ledger: ledgerPath } as never,
      gh: () => ({
        number: 80,
        url: "https://github.com/craigoley/remudero/pull/80",
        title: "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to 0.3.210 in the npm-minor-and-patch group",
        body: "Updates `@anthropic-ai/claude-agent-sdk` from 0.3.209 to 0.3.210",
        headRefOid: "beefcafe1234",
        author: { login: "app/dependabot" },
        statusCheckRollup: [
          { name: "ci", conclusion: "SUCCESS" },
          { name: "Review", conclusion: "SUCCESS" },
          { name: "scan-pr", conclusion: "SKIPPED" },
        ],
      }),
      prDiff: () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n",
      postStatus: (async () => ({ posted: true })) as never,
      // THE ARM IS REFUSED — the shape that used to print "auto-merge armed" regardless.
      arm: () => "ledger-refused",
      // impl-FR: a refused arm now ALSO escalates (nothing else can arm a Dependabot PR), so this
      // test needs a gateway or it would file a real issue — the live-write-guard caught exactly
      // that. Injecting one keeps the assertions below unchanged and the boundary offline.
      issues: { create: () => "https://github.com/craigoley/remudero/issues/999", ensureLabel: () => true } as never,
    });
  } finally {
    console.log = realLog;
  }

  assert.equal(code, 0, "the lane still completes — reporting the refusal is not the same as failing");
  const steps = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const armLines = steps.filter((s) => String(s.step).startsWith("automerge."));
  assert.deepEqual(
    armLines.map((s) => s.step),
    ["automerge.arm_skipped"],
    "the refusal is ledgered as a skip — this lane wrote automerge.armed here whatever happened",
  );
  assert.equal(armLines[0].outcome, "ledger-refused", "carrying the branch armAutoMerge actually took");
  const line = printed.find((p) => p.includes("remudero-review=success posted"));
  assert.match(String(line), /NOT armed \(ledger-refused\)/, "and the console says so too");
  assert.doesNotMatch(String(line), /auto-merge armed:/, "never the old fixed claim");
  rmSync(tmp, { recursive: true, force: true });
});

// ── impl-FR: the arm-unreachable DETECTOR ───────────────────────────────────────────
// A Dependabot PR has no independent arm path (sweep's first-match-wins DISPOSITION_RULES put
// `dep-review` above both arming rows; the review lane refuses `dependabot/` heads by name), so an
// arm that does not take leaves the PR green and permanently unmerged with nothing to rescue it.
// These extend test 14 above through the SAME injected seams rather than adding a parallel harness.

/** A stateful issue gateway: `create` records, `listOpen` returns what was created — which is what
 *  makes escalate()'s (taskId, PR, headSha) dedup observable across repeated invocations. */
function issueRecorder() {
  const created: Array<{ title: string; body: string }> = [];
  const comments: string[] = [];
  return {
    created,
    comments,
    gateway: {
      create(title: string, body: string) {
        created.push({ title, body });
        return `https://github.com/craigoley/remudero/issues/${900 + created.length}`;
      },
      listOpen() {
        return created.map((c, i) => ({
          url: `https://github.com/craigoley/remudero/issues/${901 + i}`,
          title: c.title,
          body: c.body,
        }));
      },
      comment(url: string) {
        comments.push(url);
      },
      ensureLabel: () => true,
    },
  };
}

const MANIFEST_DIFF = "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n";
const GREEN_CHECKS = [
  { name: "ci", conclusion: "SUCCESS" },
  { name: "Review", conclusion: "SUCCESS" },
];

async function driveDepReview(opts: {
  title: string;
  body?: string;
  diff?: string;
  headSha?: string;
  arm?: () => string;
  issues?: unknown;
  tmp?: string;
}) {
  const { depReviewCommand } = await import("../src/run-task.js");
  const tmp = opts.tmp ?? mkdtempSync(join(tmpdir(), "rmd-fr-"));
  const ledgerPath = join(tmp, "state", "ledger.ndjson");
  const armCalls: string[] = [];
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  let code: number;
  try {
    code = await (depReviewCommand as never as (p: string, r: string[], d: unknown) => Promise<number>)(
      "80",
      ["--repo", "remudero"],
      {
        config: { root: tmp, ledger: ledgerPath },
        gh: () => ({
          number: 80,
          url: "https://github.com/craigoley/remudero/pull/80",
          title: opts.title,
          body: opts.body ?? "",
          headRefOid: opts.headSha ?? "beefcafe1234",
          author: { login: "app/dependabot" },
          statusCheckRollup: GREEN_CHECKS,
        }),
        prDiff: () => opts.diff ?? MANIFEST_DIFF,
        postStatus: async () => ({ posted: true }),
        arm: () => {
          armCalls.push("called");
          return (opts.arm ?? (() => "ledger-refused"))();
        },
        issues: opts.issues,
      },
    );
  } finally {
    console.log = realLog;
  }
  const steps = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { code, steps, printed, armCalls, tmp, ledgerPath };
}

test("impl-FR: a minor/patch bump whose arm did NOT take is detected and escalated", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.209 to 0.3.210 in the npm-minor-and-patch group",
    arm: () => "ledger-refused",
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 1, "the real arm path was driven, not stubbed around");
  const detector = r.steps.filter((s) => s.step === "dep-review.arm_unreachable");
  assert.equal(detector.length, 1, "the unreachable PR must be reported exactly once");
  assert.equal(detector[0].outcome, "ledger-refused", "carrying the outcome that actually occurred");
  assert.equal(detector[0].head_sha, "beefcafe1234");
  assert.equal(rec.created.length, 1, "and a human-visible issue was opened");
  assert.match(rec.created[0].title, /auto-merge did not arm/);
  assert.match(String(r.printed.join("\n")), /NOTHING ELSE CAN ARM THIS PR/);
  rmSync(r.tmp, { recursive: true, force: true });
});

test("impl-FR: a successful arm emits NO detector signal — the notifier must stay silent when fine", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
    arm: () => "armed",
    issues: rec.gateway,
  });
  assert.equal(r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length, 0);
  assert.equal(rec.created.length, 0, "a signal that also fires on success is one you learn to ignore");
  rmSync(r.tmp, { recursive: true, force: true });
});

// ── THE SAFETY LOCK. The most important test here. ──────────────────────────────────
test("impl-FR SAFETY: a MAJOR bump is never armed and never reaches the detector", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump @types/node from 25.4.1 to 26.1.2",
    body: "Updates `@types/node` from 25.4.1 to 26.1.2",
    arm: () => "armed", // even if arming WOULD succeed, it must never be attempted
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 0, "a major bump must never reach the arm at all");
  assert.equal(
    r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length,
    0,
    "and the detector must not fire for it — that would be the rescue path this design refuses to build",
  );
  assert.deepEqual(
    r.steps.filter((s) => String(s.step).startsWith("automerge.")).map((s) => s.step),
    [],
    "no arm line of any kind for a major bump",
  );
  const decided = r.steps.filter((s) => s.step === "dep-review.decided");
  assert.equal(decided[0].decision, "escalate", "the lane's own policy still owns this outcome");
  rmSync(r.tmp, { recursive: true, force: true });
});

test("impl-FR SAFETY: an unparseable version is likewise never armed and never detected", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump some-package to the latest release",
    body: "no parseable semver pair here",
    arm: () => "armed",
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 0, "an unparseable bump must never reach the arm");
  assert.equal(r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length, 0);
  assert.notEqual(r.steps.filter((s) => s.step === "dep-review.decided")[0].decision, "arm");
  rmSync(r.tmp, { recursive: true, force: true });
});

test("impl-FR SAFETY: a diff touching source outside the manifests is refused, never armed or detected", async () => {
  const rec = issueRecorder();
  const r = await driveDepReview({
    title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
    diff: "diff --git a/src/run-task.ts b/src/run-task.ts\n--- a/src/run-task.ts\n+++ b/src/run-task.ts\n",
    arm: () => "armed",
    issues: rec.gateway,
  });
  assert.equal(r.armCalls.length, 0, "a bump carrying source changes must never reach the arm");
  assert.equal(r.steps.filter((s) => s.step === "dep-review.arm_unreachable").length, 0);
  assert.equal(r.steps.filter((s) => s.step === "dep-review.decided")[0].decision, "refuse");
  assert.equal(rec.created.length, 0);
  rmSync(r.tmp, { recursive: true, force: true });
});

// ── THE BOUND (trap 3). The ticks are made distinguishable by HEAD SHA, which is the
// dimension escalate()'s composite key actually reads — not by wall-clock, which it ignores.
test("impl-FR: repeated dispositions of the SAME unchanged PR open exactly one issue", async () => {
  const rec = issueRecorder();
  const tmp = mkdtempSync(join(tmpdir(), "rmd-fr-bound-"));
  for (let i = 0; i < 3; i++) {
    await driveDepReview({
      title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
      arm: () => "ledger-refused",
      issues: rec.gateway,
      headSha: "sameshaAAAA",
      tmp,
    });
  }
  assert.equal(rec.created.length, 1, "three polls of one stuck PR must not open three issues");
  assert.equal(rec.comments.length, 2, "the later polls append to the open issue instead");

  // A NEW PUSH is a genuinely different state and must NOT be suppressed by the stale issue.
  await driveDepReview({
    title: "build(deps): bump left-pad from 1.0.0 to 1.0.1 in the npm-minor-and-patch group",
    arm: () => "ledger-refused",
    issues: rec.gateway,
    headSha: "differentshaBBBB",
    tmp,
  });
  assert.equal(rec.created.length, 2, "a new head sha is a distinct state and gets its own issue");
  rmSync(tmp, { recursive: true, force: true });
});
