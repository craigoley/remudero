import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  applyVerdictStability,
  detectInstrumentEntanglement,
  ENTANGLEMENT_EXEMPT_INSTRUMENTS,
  failSummary,
  INSTRUMENT_SURFACE,
  judgeReview,
  type CriterionVerdict,
  type PriorReviewVerdict,
  type ReviewVerdict,
} from "../src/lib/review.js";
import { runFixRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

// W1-T297 (Standing rule 25 — INSTRUMENT CHANGES RIDE ALONE): "the instrument
// is right" and "the code is right" are two independently falsifiable claims;
// a PR shipping both proves neither, because the code's own falsifiers were
// graded by the very instrument version that shipped beside them (the
// #585/#586 arc this task's rationale documents). These fixtures cover the
// six acceptance criteria: the entangled-diff refusal, its binding into
// state/floorState (never suppressible), the false-positive falsifiers (the
// sanctioned shapes that must stay cheap), the fix rung's zero-strike
// escalation, the taught resolution, and the shared, single path-set constant.

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const reviewSrc = readFileSync(fileURLToPath(new URL("../src/lib/review.ts", import.meta.url)), "utf8");

// A criterion satisfied purely by the REPORT text (judgeCriterion never reads
// the diff to decide keyword coverage) — decouples "is this diff entangled"
// from "are the named criteria met", so every fixture below can hold the
// criteria constant and vary only the diff.
const SIMPLE_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the change is safe", proof: "widget frobnicate implemented" },
];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

// ── Diff fixtures ────────────────────────────────────────────────────────

// THE DANGEROUS SHAPE: a ratchet script (instrument) recaptured alongside a
// src/ product change, in one PR — the #585/#586 arc's own fixture.
const ENTANGLED_DIFF = `
diff --git a/scripts/coverage-ratchet.mjs b/scripts/coverage-ratchet.mjs
+++ b/scripts/coverage-ratchet.mjs
@@
-const FLOOR = 89.64;
+const FLOOR = 82.75;
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();

// THE SANCTIONED SHAPE: an instrument-only PR, carrying its OWN test/
// falsifier (W1-T212's test/diff-coverage.test.ts) and a docs/ update.
const INSTRUMENT_ONLY_DIFF = `
diff --git a/scripts/coverage-ratchet.mjs b/scripts/coverage-ratchet.mjs
+++ b/scripts/coverage-ratchet.mjs
@@
-const FLOOR = 89.64;
+const FLOOR = 82.75;
diff --git a/test/diff-coverage.test.ts b/test/diff-coverage.test.ts
+++ b/test/diff-coverage.test.ts
@@
+import assert from "node:assert/strict";
+test("ratchet floor lowered intentionally", () => {
+  assert.equal(FLOOR, 82.75);
+});
diff --git a/docs/review-gate.md b/docs/review-gate.md
+++ b/docs/review-gate.md
@@
+Recorded the new floor and why.
`.trim();

// Instrument + its OWN test fixture, with NO docs and NO src/ product file —
// the carve-out most likely to be got wrong (design's own words): a test/
// file must never count as the product half.
const INSTRUMENT_PLUS_TEST_ONLY_DIFF = `
diff --git a/scripts/coverage-ratchet.mjs b/scripts/coverage-ratchet.mjs
+++ b/scripts/coverage-ratchet.mjs
@@
-const FLOOR = 89.64;
+const FLOOR = 82.75;
diff --git a/test/diff-coverage.test.ts b/test/diff-coverage.test.ts
+++ b/test/diff-coverage.test.ts
@@
+import assert from "node:assert/strict";
+test("ratchet floor lowered intentionally", () => {
+  assert.equal(FLOOR, 82.75);
+});
`.trim();

const SRC_ONLY_DIFF = `
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();

const PLAN_ONLY_DIFF = `
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
+- id: W1-T999
+  title: "a filed task"
`.trim();

const DOCS_ONLY_DIFF = `
diff --git a/docs/review-gate.md b/docs/review-gate.md
+++ b/docs/review-gate.md
@@
+A docs-only clarification.
`.trim();

// ── Criterion 6: ONE PATH SET, EXPORTED ─────────────────────────────────

test("W1-T297 criterion 6: INSTRUMENT_SURFACE is ONE exported constant covering the design's named membership", () => {
  assert.ok(Array.isArray(INSTRUMENT_SURFACE) && INSTRUMENT_SURFACE.length > 0);
  const combined = new RegExp(INSTRUMENT_SURFACE.join("|"));
  assert.match(".github/workflows/ci-gate.yml", combined);
  assert.match("scripts/coverage-ratchet.mjs", combined);
  assert.match("scripts/diff-coverage.mjs", combined);
  assert.match("scripts/coverage-baseline.json", combined);
  assert.match("scripts/mutation-relevant-paths.json", combined);
  assert.match("stryker.conf.json", combined);
  assert.doesNotMatch("src/lib/review.ts", combined, "src/ modules are not instrument paths (out of scope, (a))");
  // Not a second hand-maintained copy: USER_VISIBLE_SURFACE_RE's own source
  // spreads this constant rather than re-listing the instrument entries.
  assert.match(reviewSrc, /\.\.\.INSTRUMENT_SURFACE/, "USER_VISIBLE_SURFACE_RE must be DERIVED FROM INSTRUMENT_SURFACE");
});

// ── Criteria 1-2: the entangled diff fails, bound into state AND floorState ──

test("W1-T297 criterion 1: an instrument path changed alongside a src/ path in one PR FAILS the review floor as ENTANGLED, stated as such rather than an ordinary unmet criterion", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: ENTANGLED_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, true);
  assert.deepEqual(v.instrumentEntanglementPaths?.instrumentPaths, ["scripts/coverage-ratchet.mjs"]);
  assert.deepEqual(v.instrumentEntanglementPaths?.srcPaths, ["src/lib/widget.ts"]);
  assert.equal(v.state, "failure");
  assert.match(v.summary, /entangled/i);
  assert.doesNotMatch(v.summary, /unmet:/, "an entanglement failure is not rendered as an ordinary unmet criterion");
});

test("W1-T297 criterion 2: instrumentEntangled binds BOTH state and floorState, so a verdict-stability re-review of an unchanged head can never suppress it", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: ENTANGLED_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.state, "failure");
  assert.equal(v.floorState, "failure", "diff-derived, never suppressible — exactly like criteriaTampered");
  const prior: PriorReviewVerdict = { headSha: "deadbeef", state: "success", capped: false, planOnly: false };
  const { verdict, suppressed } = applyVerdictStability(v, "deadbeef", prior);
  assert.equal(suppressed, false, "floorState already fails, so the semantic-downgrade suppression never engages");
  assert.equal(verdict.state, "failure");
});

// ── Criterion 3: THE FALSE-POSITIVE FALSIFIERS ──────────────────────────────

test("W1-T297 criterion 3: an instrument-only PR (instrument + its own test/ falsifier + docs) PASSES", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: INSTRUMENT_ONLY_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false);
  assert.equal(v.state, "success", v.summary);
});

test("W1-T297 criterion 3 (the carve-out most likely to be got wrong): instrument + its OWN test/ fixture, no docs, no src/ product file — the test/ half never counts as product", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: INSTRUMENT_PLUS_TEST_ONLY_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false);
  assert.equal(v.state, "success", v.summary);
});

test("W1-T297 criterion 3: a src-only PR PASSES", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: SRC_ONLY_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false);
  assert.equal(v.state, "success", v.summary);
});

test("W1-T297 criterion 3: a plan-only PR PASSES", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: PLAN_ONLY_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false);
  assert.equal(v.planOnly, true);
  assert.equal(v.state, "success", v.summary);
});

test("W1-T297 criterion 3: a docs-only PR PASSES", () => {
  const v = judgeReview(SIMPLE_CRITERIA, { diff: DOCS_ONLY_DIFF, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false);
  assert.equal(v.state, "success", v.summary);
});

// ── W1-T941 prerequisite: ENTANGLEMENT_EXEMPT_INSTRUMENTS narrows, never widens ─────────────
//
// scripts/knowledge-budget-baseline.json matches INSTRUMENT_SURFACE by filename alone, but no
// .github/workflows/ job ratchets against it — its only reader is a pinned product constant
// (src/lib/learnings.ts) and its own test/ falsifier, both of which MUST land beside it for the
// pin to mean anything. Unlike every other *-baseline.json, that product-constant line can never
// be isolated into its own instrument-only PR, so it earns a narrow, named exemption.

test("detectInstrumentEntanglement: an EXEMPT baseline changed alongside a src/ path does NOT entangle", () => {
  const r = detectInstrumentEntanglement(["scripts/knowledge-budget-baseline.json", "src/lib/learnings.ts"]);
  assert.equal(r.entangled, false);
  assert.deepEqual(r.instrumentPaths, []);
  assert.deepEqual(r.srcPaths, ["src/lib/learnings.ts"]);
});

test("detectInstrumentEntanglement: the exemption is NARROW — a DIFFERENT baseline (not exempt) still entangles alongside a src/ path", () => {
  const r = detectInstrumentEntanglement(["scripts/coverage-baseline.json", "src/lib/widget.ts"]);
  assert.equal(r.entangled, true, "coverage-baseline.json is a REAL CI ratchet — nothing exempts it");
  assert.deepEqual(r.instrumentPaths, ["scripts/coverage-baseline.json"]);
});

test("detectInstrumentEntanglement: an exempt path changed ALONE (no src/ path) still reports zero instrument paths, not a stray survivor", () => {
  const r = detectInstrumentEntanglement(["scripts/knowledge-budget-baseline.json"]);
  assert.equal(r.entangled, false);
  assert.deepEqual(r.instrumentPaths, []);
});

test("detectInstrumentEntanglement: a diff mixing an exempt AND a non-exempt instrument path alongside src/ still entangles on the non-exempt one", () => {
  const r = detectInstrumentEntanglement([
    "scripts/knowledge-budget-baseline.json",
    "scripts/coverage-baseline.json",
    "src/lib/widget.ts",
  ]);
  assert.equal(r.entangled, true);
  assert.deepEqual(r.instrumentPaths, ["scripts/coverage-baseline.json"], "the exempt path never re-enters the evidence");
});

test("judgeReview: a PR pinning DEFAULT_KNOWLEDGE_BUDGET_CHARS beside its baseline PASSES the entanglement floor", () => {
  const diff = `
diff --git a/scripts/knowledge-budget-baseline.json b/scripts/knowledge-budget-baseline.json
+++ b/scripts/knowledge-budget-baseline.json
@@
+{ "capChars": 8148 }
diff --git a/src/lib/learnings.ts b/src/lib/learnings.ts
+++ b/src/lib/learnings.ts
@@
-export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = 1800;
+export const DEFAULT_KNOWLEDGE_BUDGET_CHARS = 8148;
diff --git a/test/knowledge-budget-derivation.test.ts b/test/knowledge-budget-derivation.test.ts
+++ b/test/knowledge-budget-derivation.test.ts
@@
+test("drift pin", () => {
+  assert.equal(DEFAULT_KNOWLEDGE_BUDGET_CHARS, 8148);
+});
`.trim();
  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false, v.summary);
  assert.equal(v.state, "success", v.summary);
});

// W1-T2526 added the SECOND entry, and this guard is why that could not happen quietly: it names
// every exempt path verbatim, so widening the set is a diff a reviewer must approve by hand. Kept
// in exactly that shape — the assertion is the enumeration, never a size or a predicate, because a
// looser form would let a third path in without anyone reading its reason. Each entry carries its
// OWN justification at the declaration (W1-T941: nothing in CI ratchets against it; W1-T2526: it
// IS read in CI, but it is a size LEDGER and not a score FLOOR, so raising an entry cannot make a
// failing falsifier pass), and test/a-size-ledger-is-not-a-score-floor.test.ts pins that the two
// reasons stay distinct.
test("ENTANGLEMENT_EXEMPT_INSTRUMENTS: exactly the two named, reviewed paths — no blanket widening", () => {
  assert.deepEqual(
    [...ENTANGLEMENT_EXEMPT_INSTRUMENTS],
    ["scripts/knowledge-budget-baseline.json", "scripts/source-size-baseline.json"],
  );
});

// ── Criterion 5: THE MESSAGE MUST TEACH THE ESCAPE ──────────────────────────

test("W1-T297 criterion 5: failSummary names the resolution — split (land the instrument change in its own PR, then rebase) — not just a bare refusal", () => {
  const msg = failSummary([], false, false, false, 0, [], {
    instrumentPaths: ["scripts/coverage-ratchet.mjs"],
    srcPaths: ["src/lib/widget.ts"],
  });
  assert.match(msg, /scripts\/coverage-ratchet\.mjs/);
  assert.match(msg, /src\/lib\/widget\.ts/);
  assert.match(msg, /own PR/i);
  assert.match(msg, /rebase/i);
});

// ── Criteria 4 + 5 + 7: THE FIX RUNG REFUSES, NOT FIXES ─────────────────────
// Mirrors test/run-task.test.ts's own W1-T58 rule-15 negative-control pattern
// (runFixRung's zero-strike refusal shape) exactly, for the SAME reason:
// no worker may legitimately resolve this by writing more code.

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "W1-TX",
    runId: "W1-TX-1730000000000",
    task: { id: "W1-TX", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-TX-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-instrument-isolation-")), "ledger.ndjson");
}

function fakeIssues(calls: Array<{ title: string; body: string; labels: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/9";
    },
  };
}

// W1-T2436 (capability 2 of 3): an entangled blocked_review no longer escalates STRAIGHT to an
// issue — it first dispatches a worker to build the prerequisite PR (test/entanglement-split-
// dispatches-a-worker.test.ts owns that dispatch's own contract in full). This fixture's own
// worker fake reports no pull request at all, so it still exercises exactly the escalation this
// test has always pinned: same issue body, same ledger line, same zero strikes spent — proving
// that arm is BYTE-IDENTICAL to before once the (new) prerequisite attempt itself cannot go green.
test("W1-T297 criteria 4/5/7: runFixRung never spends an ordinary add-the-work strike on an entangled blocked_review — a failed prerequisite attempt still escalates naming the instrument paths, the src paths, and the split/rebase resolution", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ledgerPath = tmpLedgerPath();

  const entangled = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  entangled.instrumentEntangled = true;
  entangled.instrumentEntanglementPaths = {
    instrumentPaths: ["scripts/coverage-ratchet.mjs"],
    srcPaths: ["src/lib/widget.ts"],
  };
  entangled.summary = "remudero-review: FAIL — entangled: instrument path(s) scripts/coverage-ratchet.mjs changed alongside src/ path(s) src/lib/widget.ts";

  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: entangled,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-spawn" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => entangled,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath,
      log: (step, extra) => logged.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  // W1-T2436: exactly ONE spawn now happens — the prerequisite-building worker this rung
  // dispatches instead of escalating straight to an issue — never the ORIGINAL entangled diff
  // being handed to an ordinary "add the work" fix worker (that invariant is what this test
  // still pins: the spawned prompt is never a repair prompt against the entangled PR itself).
  assert.equal(spawnCalls.length, 1, "the prerequisite-building worker is dispatched exactly once");
  assert.ok(
    !spawnCalls[0].prompt.includes("criterion A merges cleanly"),
    "the spawned worker is building the PREREQUISITE, never an ordinary fix against the entangled PR's own unmet criteria",
  );
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 0, "no strike is spent on a diff the rung refuses to act on");
  assert.equal(issueCalls.length, 1);
  assert.ok(issueCalls[0].labels.includes("escalation-blocked"));
  assert.match(issueCalls[0].body, /scripts\/coverage-ratchet\.mjs/, "names the observed instrument path (W1-T186)");
  assert.match(issueCalls[0].body, /src\/lib\/widget\.ts/, "names the observed src path beside it (W1-T186)");
  assert.match(issueCalls[0].body, /own PR/i, "teaches the escape: split — land the instrument change in its own PR");
  assert.match(issueCalls[0].body, /rebase/i);
  assert.ok(
    logged.some((l) => l.step === "fix.instrument_entangled"),
    "the refusal is ledgered distinctly from an ordinary exhaustion",
  );
  const ledgerLines = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    ledgerLines.some((l) => l.step === "escalation.issue_opened"),
    "the escalation itself is still ledgered via the SAME escalate() machinery every other exhaustion uses",
  );
});

test("W1-T297 criterion 7: the binding flag is computed in the review floor and CONSUMED by the run loop — wired, not dead code (Standing rule 14)", () => {
  assert.match(runTaskSrc, /review\.instrumentEntangled/, "grep proof: instrumentEntangled in src/run-task.ts");
});
