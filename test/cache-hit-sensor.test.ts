import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateCacheHitTotals, cacheHitRatio, renderDigest, summarize, type CacheHitTotals } from "../src/lib/digest.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";

// ── W1-T929: THE CACHE-HIT RATIO IS LEDGERED BUT NEVER READ ────────────────────────────────
//
// worker.ts's TokenUsage already nests `cacheRead`/`input`/`cacheCreation` on every worker AND
// brain-plane ledger line (`workerLedgerFields`, W1-T6); nothing derived a ratio from them. This
// file proves the four acceptance criteria:
//   1. cache_read/(cache_read+input+cache_creation), derived off ledger lines already written,
//      exported ONCE from digest.ts.
//   2. reported at BOTH grains — per run and per task class — over the SAME window.
//   3. a window whose lines carry no cache fields renders UNKNOWN with its coverage fraction,
//      never 0.0, and the digest OMITS the line entirely rather than printing a placeholder.
//   4. `rmd status` renders the SAME figure by importing the ONE derivation (proof: grep
//      `cacheHitRatio(` in src/lib/status-board.ts — see that file's `renderCacheHitGrains`).

/** A worker/brain-plane CALL line — carries the `model`/`effort` pair `isCallLine` keys on,
 *  plus the nested `tokens` TokenUsage shape every real ledger line spreads verbatim. */
function callLine(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: "2026-08-10T09:00:00.000Z",
    step: "recon.done",
    model: "sonnet",
    effort: "medium",
    ...overrides,
  };
}

function runStart(runId: string, taskClass: string, ts = "2026-08-10T08:00:00.000Z"): Record<string, unknown> {
  return { ts, step: "run.start", run_id: runId, task_id: `task-${runId}`, task_class: taskClass };
}

// A mixed fixture: two runs in class "src" (R1, R3), one run in class "docs" (R2) whose only
// call line reports an all-zero envelope (a genuine transport failure — TokenUsage's own
// documented "zeroed when no result envelope was ever seen" case), and one run (R4) with NO
// run.start line inside the window at all, so it falls into the "unknown" class bucket
// (mirrors retro.ts's aggregateByClass "unknown" rule, design note (ii)).
const MIXED_LINES = [
  runStart("R1", "src"),
  callLine({ run_id: "R1", tokens: { input: 100, output: 40, cacheRead: 300, cacheCreation: 20 } }),
  callLine({ run_id: "R1", step: "implement.done", tokens: { input: 50, output: 10, cacheRead: 150, cacheCreation: 0 } }),
  runStart("R2", "docs"),
  callLine({ run_id: "R2", model: "haiku", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }),
  runStart("R3", "src"),
  callLine({ run_id: "R3", tokens: { input: 0, output: 0, cacheRead: 100, cacheCreation: 0 } }),
  callLine({ run_id: "R4", tokens: { input: 10, output: 5, cacheRead: 90, cacheCreation: 0 } }),
  // Non-call lines in the SAME window — must never be mistaken for a call and never contribute
  // to any grain's callLines/coveredLines.
  { ts: "2026-08-10T09:05:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1.0 },
];

// ── Acceptance 1: the formula itself, exported once ─────────────────────────────────────────

test("cacheHitRatio: cache_read/(cache_read+input+cache_creation), exactly the feedback's formula", () => {
  assert.equal(cacheHitRatio({ cacheRead: 300, input: 100, cacheCreation: 20 }), 300 / 420);
  assert.equal(cacheHitRatio({ cacheRead: 450, input: 150, cacheCreation: 20 }), 450 / 620);
});

test("cacheHitRatio: a zero denominator is undefined, NEVER a fabricated 0.0", () => {
  assert.equal(cacheHitRatio({ cacheRead: 0, input: 0, cacheCreation: 0 }), undefined);
});

// ── Acceptance 2: both grains, over the same window ─────────────────────────────────────────

test("aggregateCacheHitTotals: groups the SAME window by run_id AND by task_class, summing raw token counts per grain", () => {
  const totals = aggregateCacheHitTotals(MIXED_LINES) as CacheHitTotals;
  assert.ok(totals, "the window carries usable cache data (R1/R3/R4), so this must not be undefined");

  // Per-run: R1's two call lines summed.
  assert.deepEqual(totals.byRun.R1, { cacheRead: 450, input: 150, cacheCreation: 20, callLines: 2, coveredLines: 2 });
  assert.deepEqual(totals.byRun.R3, { cacheRead: 100, input: 0, cacheCreation: 0, callLines: 1, coveredLines: 1 });
  // R2's only call line carried an all-zero envelope: counted as a call, never covered.
  assert.deepEqual(totals.byRun.R2, { cacheRead: 0, input: 0, cacheCreation: 0, callLines: 1, coveredLines: 0 });
  // R4 has no run.start in this window, so it is NOT itself a `byRun` key collision with class —
  // it still gets its own per-run grain.
  assert.deepEqual(totals.byRun.R4, { cacheRead: 90, input: 10, cacheCreation: 0, callLines: 1, coveredLines: 1 });

  // Per-class: "src" combines R1 + R3 (both task_class: "src").
  assert.deepEqual(totals.byClass.src, { cacheRead: 550, input: 150, cacheCreation: 20, callLines: 3, coveredLines: 3 });
  // "docs" is R2 alone — uncovered.
  assert.deepEqual(totals.byClass.docs, { cacheRead: 0, input: 0, cacheCreation: 0, callLines: 1, coveredLines: 0 });
  // R4's run_id was never named on a `run.start` line inside the window ⇒ "unknown" bucket
  // (same convention retro.ts's `aggregateByClass` already uses for an un-classed run).
  assert.deepEqual(totals.byClass.unknown, { cacheRead: 90, input: 10, cacheCreation: 0, callLines: 1, coveredLines: 1 });
});

test("aggregateCacheHitTotals: a non-call ledger line (no model/effort pair) never inflates callLines/coveredLines", () => {
  const totals = aggregateCacheHitTotals(MIXED_LINES) as CacheHitTotals;
  const totalCallLines = Object.values(totals.byRun).reduce((s, g) => s + g.callLines, 0);
  assert.equal(totalCallLines, 5, "exactly the 5 callLine() fixtures — the verdict/run.start lines must not count");
});

// ── Acceptance 3: UNKNOWN + coverage fraction per grain; digest omits the line entirely when
// the WHOLE window carries no cache data ─────────────────────────────────────────────────────

test("summarize: reports cacheHit with BOTH grains for a window that carries usable cache data", () => {
  const s = summarize(MIXED_LINES, "2026-08-10T00:00:00.000Z");
  assert.ok(s.cacheHit);
  assert.ok(s.cacheHit!.byRun.R1);
  assert.ok(s.cacheHit!.byClass.src);
});

test("summarize: a window with NO cache-token data anywhere leaves `cacheHit` undefined (soft-compose, design note iv)", () => {
  const lines = [
    { ts: "2026-08-10T09:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1.0 },
    runStart("R9", "src"),
  ];
  const s = summarize(lines, "2026-08-10T00:00:00.000Z");
  assert.equal(s.cacheHit, undefined);
});

test("renderDigest: a grain with an all-zero envelope renders UNKNOWN with its coverage fraction, never 0.0", () => {
  const s = summarize(MIXED_LINES, "2026-08-10T00:00:00.000Z");
  const text = renderDigest(s);
  assert.match(text, /cache hit by run:.*R2=UNKNOWN \(coverage 0%\)/);
  assert.match(text, /cache hit by class:.*docs=UNKNOWN \(coverage 0%\)/);
  assert.doesNotMatch(text, /R2=0\.0%/);
  assert.doesNotMatch(text, /docs=0\.0%/);
});

test("renderDigest: BOTH grains render, with real ratios rounded to one decimal place beside their coverage", () => {
  const s = summarize(MIXED_LINES, "2026-08-10T00:00:00.000Z");
  const text = renderDigest(s);
  // R1: 450/620 = 72.58...% ; R3: 100/100 = 100.0% ; R4 (unknown class): 90/100 = 90.0%
  assert.match(text, /cache hit by run: R1=72\.6% \(coverage 100%\), R2=UNKNOWN \(coverage 0%\), R3=100\.0% \(coverage 100%\), R4=90\.0% \(coverage 100%\)/);
  // class "src" = (450+100)/(620+100) = 550/720 = 76.38...%
  assert.match(text, /cache hit by class: docs=UNKNOWN \(coverage 0%\), src=76\.4% \(coverage 100%\), unknown=90\.0% \(coverage 100%\)/);
});

test("renderDigest: a window with no cache data OMITS the 'cache hit' lines entirely — no placeholder, byte-identical to before this feature", () => {
  const lines = [{ ts: "2026-08-10T09:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1.0 }];
  const s = summarize(lines, "2026-08-10T00:00:00.000Z");
  assert.equal(s.cacheHit, undefined, "precondition: no call line in this fixture's window");
  const text = renderDigest(s);
  assert.doesNotMatch(text, /cache hit/);
  assert.equal(
    text,
    [
      "Remudero daily digest — since 2026-08-10T00:00:00.000Z",
      "merged: W1-T1",
      "blocked: (none)",
      "escalations: (none)",
      "alerts: (no poll this window)",
      "issues reviewed: (no poll this window)",
      "verdict downgrades suppressed: 0",
      "notional cost: $1.00",
    ].join("\n"),
  );
});

test("collectSince windowing applies to cache-hit data too: a call line before sinceIso never enters either grain", () => {
  const lines = [
    runStart("R5", "src", "2026-08-01T00:00:00.000Z"),
    callLine({ run_id: "R5", ts: "2026-08-01T00:05:00.000Z", tokens: { input: 10, output: 0, cacheRead: 990, cacheCreation: 0 } }),
  ];
  const s = summarize(lines, "2026-08-10T00:00:00.000Z");
  assert.equal(s.cacheHit, undefined, "the only call line is outside the window, so there is nothing to report");
});

// ── Acceptance 4: `rmd status` renders the SAME figure by importing the ONE derivation ──────
// (grep proof: `cacheHitRatio(` in src/lib/status-board.ts — this half checks the BEHAVIOUR:
// the same raw ledger window produces the identical percentage string in both surfaces.)

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-cache-hit-board-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cache-hit-board-root-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => Date.parse("2026-08-10T12:00:00.000Z"),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

test("buildStatusBoard/renderStatusBoardText: CACHE HIT section renders the IDENTICAL ratio the digest computes off the same lines", () => {
  const ledgerPath = ledgerFile(MIXED_LINES);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.equal(model.cacheHit.found, true);
  assert.deepEqual(model.cacheHit.totals?.byRun.R1, { cacheRead: 450, input: 150, cacheCreation: 20, callLines: 2, coveredLines: 2 });

  const text = renderStatusBoardText(model);
  assert.match(text, /── CACHE HIT/);
  assert.match(text, /by run\s*:.*R1=72\.6% \(coverage 100%\)/);
  assert.match(text, /by run\s*:.*R2=UNKNOWN \(coverage 0%\)/);
  assert.match(text, /by class:.*src=76\.4% \(coverage 100%\)/);
});

test("buildStatusBoard: an empty ledger reports cacheHit.found=false, and the text block says so rather than printing a placeholder ratio", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist-cache-hit.ndjson"), baseDeps());
  assert.equal(model.cacheHit.found, false);
  assert.equal(model.cacheHit.totals, undefined);

  const text = renderStatusBoardText(model);
  assert.match(text, /── CACHE HIT/);
  assert.match(text, /no cache-token data in this window/);
  assert.doesNotMatch(text, /0\.0%/);
});
