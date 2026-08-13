/**
 * test/worker-no-wait-contract.test.ts — W1-T465.
 *
 * THE DEFECT. A worker backgrounds a long job (`rmd preflight --ci-parity`, ~15-17 minutes, or the
 * full suite), then ENDS ITS TURN believing something will wake it. Nothing does: a headless SDK
 * run has no notification channel, so the turn ending ends the RUN. The orchestrator records
 * `implement.done` with `subtype: "success"` beside `verdict: no_pr` and `commits_ahead: 0`, and
 * the work is lost.
 *
 * WHERE THE WORKER LEARNED IT: NOWHERE. Nothing in `src/` prompt text mentions backgrounding or
 * notification (measured; positive controls in the same file confirm the query could see prompt
 * text). The worker inferred it from the harness's real backgrounding affordance, which genuinely
 * DOES notify — in an interactive session. That is why the fix is a CONTRACT THAT STATES ITS
 * MECHANISM rather than a prohibition: a rule whose reason is absent gets re-derived away by the
 * next model that reasons about it, and a worker told only "do not background" will background
 * anyway when a job takes fifteen minutes.
 *
 * THE CORPUS BELOW IS REAL, AND IT SPANS TWO HOSTS. The five `MINI_*` excerpts are the ones
 * W1-T465's shard recorded from the mini's archived ledger (all 2026-08-12). The three `AZURE_*`
 * excerpts I measured independently on the Azure host (all 2026-08-13, $49.36 between them) — a
 * second host, a different corpus, the same shape. The three `HONEST_*` controls are the shard's
 * own control group: `no_pr` runs that correctly concluded there was nothing to do.
 *
 * WHY THE CONTROLS MATTER MORE THAN THE POSITIVES. All eight observable rows carry
 * `subtype: "success"` AND `commits_ahead: 0` — INCLUDING the honest ones. So `commits_ahead: 0`
 * alone is NOT a safe discriminator; keying a retry on it would re-dispatch work that correctly
 * concluded there was nothing to do, which is this repo's recurring "bound fires on a healthy
 * condition" defect. The classifier under test is therefore CLASSIFICATION ONLY — it labels a row
 * for a reader and drives no dispatch decision whatsoever. That is asserted, not assumed, below.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { classifyNoPrShape, noPrVerdict } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The house fixture shape, mirroring `test/no-pr-verdict-report-excerpt.test.ts`'s own `result()`
 *  — a REAL `WorkerResult`, not a cast, so the row builder's own reads (`billingMode`, the token
 *  fields) run exactly as they do in production rather than throwing on an absent key. */
function workerResult(text: string, numTurns: number): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "default", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  } as WorkerResult;
}

// ── THE REAL CORPUS ─────────────────────────────────────────────────────────

/** Mini, 2026-08-12 — recorded verbatim in W1-T465's shard. */
const MINI_WAIT = [
  "I'll pause here and wait for the background test suite (task b8zoysdek) to finish; I'll be notified automatically when it completes.",
  "I'll pause here and wait for the background rmd preflight --ci-parity task to complete — the harness will notify me automatically when it finishes, so I won't poll in the meantime.",
  "I'll wait for the background preflight run to finish before proceeding.",
  "I'll pause here and wait for the rmd preflight --ci-parity background task to complete before proceeding to push and open the PR.",
  "I've launched the full test suite (npm run test:ci) and a watcher script in the background... I'll resume with rmd preflight --ci-parity, commit, and PR creation once I get the completion notification — no need to poll further.",
];

/** Azure, 2026-08-13 — measured independently for this build; $38.46 + $3.01 + $7.89. */
const AZURE_WAIT = [
  "I'll stop issuing further tool calls now and wait for the background watcher's completion notification before proceeding to preflight and push.",
  "Waiting for the background test run to complete.",
  "Waiting for the background preflight run to finish; will resume once notified.",
];

/** The control group: `no_pr` runs that were CORRECT to open no PR. */
const HONEST_NO_OP = [
  "All 2/2 acceptance tests pass, mechanically verified live",
  "Working tree is clean... No code changes needed or made",
  "this task's acceptance is already satisfied on origin/main",
];

// ── DIRECTION 1: the contract is stated, WITH its mechanism ─────────────────

test("W1-T465 (1): the output contract tells a worker that no notification arrives and a background job must be POLLED", () => {
  const text = outputContractLines("W1-T999").join("\n");
  // The MECHANISM, not merely a prohibition — each half asserted separately so a future edit
  // cannot drop the reason and keep the rule.
  assert.match(text, /no notification/i, "the contract must say no notification arrives");
  assert.match(text, /poll/i, "and must name polling as the alternative");
  assert.match(text, /ends? the run|end(s|ing)? your turn/i, "and must say that ending the turn ends the run");
});

test("W1-T465 (1): the contract rides the POST-COMPACTION anchor, because a long job is exactly what causes a compaction", () => {
  // A worker backgrounds a job because it is slow; slow means many turns; many turns means a
  // compaction. A contract that lived only at turn 0 would be gone precisely when it is needed.
  // `renderAnchorBlock` re-injects `outputContractLines` verbatim, so this holds by construction —
  // but it holds only while the line lives THERE, which is what this pins.
  const anchor = renderAnchorBlock({ id: "W1-T999", title: "t" } as never, "run-1");
  assert.match(anchor, /no notification/i, "the anchor must carry the contract too");
  assert.match(anchor, /poll/i);
});

// ── DIRECTION 2: wait-shaped is distinguishable from honest ─────────────────

test("W1-T465 (2): every real wait-shaped excerpt, from BOTH hosts, classifies as awaiting-notification", () => {
  for (const excerpt of [...MINI_WAIT, ...AZURE_WAIT]) {
    assert.equal(
      classifyNoPrShape(excerpt),
      "awaiting-notification",
      `should classify as a stalled wait: ${excerpt.slice(0, 70)}…`,
    );
  }
  assert.equal(MINI_WAIT.length + AZURE_WAIT.length, 8, "the observable wait-shaped population is 8 across two hosts");
});

test("W1-T465 (2): the classifier reads the REPORT, not commits_ahead — which is 0 on honest runs too", () => {
  // THE MEASURED TRAP: all eight observable rows carry commits_ahead 0 and subtype success,
  // including the honest ones. Anything keyed on those two would fire on a healthy condition.
  const waitRow = noPrVerdict(workerResult(AZURE_WAIT[2], 108), 7.89, "implement", 0);
  const honestRow = noPrVerdict(workerResult(HONEST_NO_OP[2], 12), 1.5, "implement", 0);
  assert.equal(waitRow.ledger.commits_ahead, 0);
  assert.equal(honestRow.ledger.commits_ahead, 0, "identical on both — so it cannot be the discriminator");
  assert.equal(waitRow.ledger.subtype, "success");
  assert.equal(honestRow.ledger.subtype, "success", "identical on both");
  // The rows differ ONLY in the classified shape.
  assert.equal(waitRow.ledger.no_pr_shape, "awaiting-notification");
  assert.notEqual(honestRow.ledger.no_pr_shape, "awaiting-notification");
});

// ── DIRECTION 3: the honest no-op is untouched, and nothing re-dispatches ───

test("W1-T465 (3): every honest already-satisfied-shaped excerpt is NOT labelled awaiting-notification", () => {
  for (const excerpt of HONEST_NO_OP) {
    assert.notEqual(
      classifyNoPrShape(excerpt),
      "awaiting-notification",
      `a correct no-op must not be labelled a stalled wait: ${excerpt.slice(0, 60)}…`,
    );
  }
  // Absent/empty reports are the OTHER healthy case — a genuinely silent run says nothing, and
  // saying nothing is not evidence of waiting.
  assert.notEqual(classifyNoPrShape(undefined), "awaiting-notification");
  assert.notEqual(classifyNoPrShape(""), "awaiting-notification");
});

test("W1-T465 (3): the classification drives NO dispatch decision — it cannot re-dispatch anything, honest or not", () => {
  // WHY SOURCE TEXT, AND IT SAYS SO. The safety property is an ABSENCE — that no scheduling path
  // consults this label — and an absence cannot be demonstrated by calling the function. The
  // shard's design (iv) puts retrying `no_pr` explicitly out of scope; this pins that the
  // implementation honoured it, so a later edit that wires the label into dispatch fails HERE
  // rather than by re-dispatching somebody's correct no-op in production.
  for (const rel of ["src/lib/drain.ts", "src/lib/daemon.ts"]) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.doesNotMatch(src, /classifyNoPrShape|no_pr_shape|awaiting-notification/, `${rel} must not consult the label`);
  }
});

test("W1-T465: the classifier is a PROSE matcher and its fragility is recorded where a reader will find it", () => {
  // The shard's design (iii) asked for a run-emitted signal over a prose one, and none exists:
  // the honest no-ops did NOT emit the sanctioned `ALREADY_SATISFIED:` marker (that is exactly why
  // they landed `no_pr` rather than `already_satisfied`), so there is no structured field that
  // separates them. Design (iii)'s fallback is to make the fragility EXPLICIT rather than
  // implicit — a sixth phrasing will not match, and that must be written down, not discovered.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const doc = src.slice(Math.max(0, src.indexOf("export function classifyNoPrShape") - 2600), src.indexOf("export function classifyNoPrShape"));
  assert.match(doc, /prose/i, "the doc comment must admit it is a prose matcher");
  assert.match(doc, /sixth phrasing|will not match|fragile/i, "and must state that a new phrasing escapes it");
});
