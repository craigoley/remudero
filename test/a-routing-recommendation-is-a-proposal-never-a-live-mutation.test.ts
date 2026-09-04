// test/a-routing-recommendation-is-a-proposal-never-a-live-mutation.test.ts
//
// W1-T2575 — NOTHING TURNS THE ROUTING EVIDENCE INTO A DECISION. scripts/mount-headroom-sweep.mjs
// (W1-T2560, extended W1-T2574) already MEASURES: it groups retained ledger runs into (type,
// risk, class) cells and, within each, into (provider, served_model, effort) arms — a printed
// table a human had to read and act on. lib/mount-recommender.ts is the missing leg: it turns
// those cells into either a {@link MountRecommendation} or a named {@link MountRefusal}, PURELY
// (no I/O), and hands a cleared recommendation to `updateProposalRegistry` (lib/inbox.ts) — the
// SAME ratification path `rmd inbox`/`rmd approve` already tier and ratify every other proposal
// through. This suite proves:
//   1. the recommender is reached from a production caller (src/run-task.ts), not only its own
//      test — a grep, not a unit test (see this task's own acceptance).
//   2. a recommendation emits a proposal through the EXISTING ratification path and mutates no
//      routing table.
//   3. a cell below the declared minimum sample yields a REFUSAL naming the shortfall.
//   4. a cell whose arms are unmatched (fewer than two) yields a refusal rather than an effect
//      size.
//   5. every recommendation carries the cell, the arms, each arm's n, and an interval.
//   6. a proposed mount that would violate the Tier Invariant (G-17) is refused at proposal time,
//      the violation named.
//   7. the emitted proposal states that its evidence is observational while no golden run backs
//      it.
//
// WHAT IS REAL HERE: `recommendMounts` is exercised directly against hand-built
// `MountHeadroomCell` fixtures (the exact structural shape scripts/mount-headroom-sweep.mjs's
// `buildMountHeadroomSweep` emits — see that script's own test, test/a-mount-comparison-across-
// unmatched-populations-is-not-a-measurement.test.ts, for the ledger-to-cell path this module
// consumes) and a REAL, `validateMounts`-produced `Mounts` table (never a hand-typed stub that
// could drift from the loader's own shape). The ratification-path claim (2) drives a REAL
// `updateProposalRegistry` write against a temp dir and reads the bytes back off disk — no mock.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateMounts, type Mounts } from "../src/lib/mounts.js";
import { updateProposalRegistry } from "../src/lib/inbox.js";
import {
  DEFAULT_MIN_SAMPLE_N,
  mountRecommendationProposalCandidate,
  mountRecommendationProposalId,
  OBSERVATIONAL_EVIDENCE_NOTICE,
  recommendMounts,
  tierInvariantViolation,
  type MountHeadroomArm,
  type MountHeadroomCell,
  type MountHeadroomComparison,
  type MountRecommendation,
  type MountRefusal,
} from "../src/lib/mount-recommender.js";

// ── A minimal, VALID mounts table (mirrors test/mounts.test.ts's own `goodRaw`) — real
// validation, not a hand-typed stub, so a drift in mounts.ts's shape breaks THIS suite too. ──────
function testMounts(): Mounts {
  return validateMounts({
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
      triage: { model: "opus", effort: "low", max_turns: 60, context_budget: 180000 },
      inbox_draft: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    },
    routes: {
      implement: {
        medium: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
      },
    },
  });
}

function arm(opts: {
  cellKey: string;
  armKey: string;
  provider: string;
  servedModel: string;
  effort: string;
  n: number;
  passing: number;
  costP50: number | null;
  costP90: number | null;
  costPerCompletedTaskUsd: number | null;
}): MountHeadroomArm {
  return {
    cellKey: opts.cellKey,
    armKey: opts.armKey,
    provider: opts.provider,
    servedModel: opts.servedModel,
    effort: opts.effort,
    n: opts.n,
    outcomes: { passing: opts.passing, blockedCi: opts.n - opts.passing, redispatched: 0 },
    costP50: opts.costP50,
    costP90: opts.costP90,
    costMax: opts.costP90,
    costPerCompletedTaskUsd: opts.costPerCompletedTaskUsd,
  };
}

function comparison(opts: {
  cellKey: string;
  armKeyA: string;
  armKeyB: string;
  nA: number;
  nB: number;
  cheaperByCostPerCompletedTask: string | null;
  advantageHoldsUnderRedispatch: boolean | null;
  note: string;
}): MountHeadroomComparison {
  return {
    cellKey: opts.cellKey,
    armKeyA: opts.armKeyA,
    armKeyB: opts.armKeyB,
    nA: opts.nA,
    nB: opts.nB,
    cheaperByCostP50: opts.cheaperByCostPerCompletedTask,
    cheaperByCostPerCompletedTask: opts.cheaperByCostPerCompletedTask,
    advantageHoldsUnderRedispatch: opts.advantageHoldsUnderRedispatch,
    note: opts.note,
  };
}

const CELL_KEY = "implement::medium::src";

/** A cell that clears EVERY gate — the one positive fixture the "a recommendation is emitted"
 *  claims build on. haiku (tier 1) is well below opus (tier 3, both architect and judge here). */
function recommendableCell(): MountHeadroomCell {
  const cheap = arm({
    cellKey: CELL_KEY,
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    effort: "medium",
    n: 40,
    passing: 36, // 90%
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
  });
  const costly = arm({
    cellKey: CELL_KEY,
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    effort: "medium",
    n: 40,
    passing: 32, // 80%
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
  });
  const cmp = comparison({
    cellKey: CELL_KEY,
    armKeyA: cheap.armKey,
    armKeyB: costly.armKey,
    nA: cheap.n,
    nB: costly.n,
    cheaperByCostPerCompletedTask: cheap.armKey,
    advantageHoldsUnderRedispatch: true,
    note: `${cheap.armKey} is cheaper both per settled run and per completed task`,
  });
  return { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [cheap, costly], comparisons: [cmp] };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-mount-recommendation-proposal-"));
}

// ── Claim 1: reached from a production caller ──────────────────────────────────────────────

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("recommendMounts( is called from src/run-task.ts, not only from this test", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(src, /\brecommendMounts\(/, "src/run-task.ts must call recommendMounts(...) from a production rung");
});

// ── Claim 2: a recommendation emits a proposal through the existing ratification path, and
// mutates no routing table ─────────────────────────────────────────────────────────────────

test("a recommendation emits a proposal through the existing ratification path and mutates no routing table", () => {
  const dir = tmpDir();
  try {
    const mounts = testMounts();
    const beforeJson = JSON.stringify(mounts);

    const outcomes = recommendMounts([recommendableCell()], mounts);
    const rec = outcomes.find((o): o is MountRecommendation => o.kind === "recommendation");
    assert.ok(rec, "the recommendable fixture must yield a recommendation");

    // The routing table handed in is never touched by recommendMounts itself.
    assert.equal(JSON.stringify(mounts), beforeJson, "recommendMounts must not mutate the Mounts table it was given");

    const candidate = mountRecommendationProposalCandidate(rec);
    assert.equal(candidate.id, mountRecommendationProposalId(rec));
    assert.deepEqual(candidate.evidenceAnchors, []);

    // The candidate is the SAME shape lib/inbox.ts's Proposal takes — filed through the REAL,
    // existing single-writer (updateProposalRegistry), never a bespoke second mechanism.
    const registryPath = join(dir, "state", "inbox-proposals.json");
    const written = updateProposalRegistry(registryPath, (current) => [
      ...current,
      { id: candidate.id, summary: candidate.summary, evidenceAnchors: candidate.evidenceAnchors },
    ]);
    assert.ok(written?.some((p) => p.id === candidate.id));

    const onDisk = JSON.parse(readFileSync(registryPath, "utf8")) as { proposals: Array<{ id: string }> };
    assert.ok(onDisk.proposals.some((p) => p.id === candidate.id), "the proposal must actually be on disk via the shared registry writer");

    // Still no mutation of the routing table, after the proposal round-tripped through disk.
    assert.equal(JSON.stringify(mounts), beforeJson);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Claim 3: below the minimum sample -> a refusal naming the shortfall ────────────────────

test("a cell below the declared minimum sample yields a REFUSAL naming the shortfall, never a recommendation", () => {
  const mounts = testMounts();
  const cheap = arm({
    cellKey: CELL_KEY,
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    effort: "medium",
    n: 4,
    passing: 4,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
  });
  const costly = arm({
    cellKey: CELL_KEY,
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    effort: "medium",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
  });
  const cmp = comparison({
    cellKey: CELL_KEY,
    armKeyA: cheap.armKey,
    armKeyB: costly.armKey,
    nA: cheap.n,
    nB: costly.n,
    cheaperByCostPerCompletedTask: cheap.armKey,
    advantageHoldsUnderRedispatch: true,
    note: "cheaper",
  });
  const cell: MountHeadroomCell = { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [cheap, costly], comparisons: [cmp] };

  const [outcome] = recommendMounts([cell], mounts);
  assert.equal(outcome.kind, "refusal");
  const refusal = outcome as MountRefusal;
  assert.equal(refusal.reason, "insufficient-sample");
  assert.match(refusal.detail, /n=4/);
  assert.match(refusal.detail, new RegExp(`floor of ${DEFAULT_MIN_SAMPLE_N}`));
});

// ── Claim 4: unmatched arms -> a refusal, never an effect size ─────────────────────────────

test("a cell whose arms are unmatched (fewer than two) yields a refusal rather than an effect size", () => {
  const mounts = testMounts();
  const lone = arm({
    cellKey: CELL_KEY,
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    effort: "medium",
    n: 100,
    passing: 90,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
  });
  const cell: MountHeadroomCell = { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [lone], comparisons: [] };

  const [outcome] = recommendMounts([cell], mounts);
  assert.equal(outcome.kind, "refusal");
  const refusal = outcome as MountRefusal;
  assert.equal(refusal.reason, "unmatched-arms");
  assert.match(refusal.detail, /only 1 arm/);
  assert.ok(!("effectSizeUsd" in outcome));
});

// ── Claim 5: every recommendation carries the cell, the arms, each arm's n, and an interval ─

test("every recommendation carries the cell, the arms compared, each arm's n, and an interval", () => {
  const mounts = testMounts();
  const [outcome] = recommendMounts([recommendableCell()], mounts);
  assert.equal(outcome.kind, "recommendation");
  const rec = outcome as MountRecommendation;
  assert.equal(rec.cellKey, CELL_KEY);
  assert.equal(rec.type, "implement");
  assert.equal(rec.risk, "medium");
  assert.equal(rec.taskClass, "src");
  assert.equal(rec.recommendedArm.armKey, "claude::haiku::medium");
  assert.equal(rec.recommendedArm.n, 40);
  assert.equal(rec.currentArm.armKey, "claude::sonnet::medium");
  assert.equal(rec.currentArm.n, 40);
  assert.equal(typeof rec.effectSizeUsd, "number");
  assert.ok(rec.effectSizeUsd > 0);
  assert.equal(typeof rec.interval.lowUsd, "number");
  assert.equal(typeof rec.interval.highUsd, "number");
  assert.ok(rec.interval.lowUsd > 0, "a recommended interval never reaches zero or a reversal");
  assert.ok(rec.interval.lowUsd <= rec.interval.highUsd);
});

// ── Claim 6: a Tier-Invariant-violating proposal is refused at proposal time, named ────────

test("a proposed mount that would violate the Tier Invariant is refused at proposal time with the violation named", () => {
  const mounts = testMounts(); // architect + judge both ride 'opus' (tier 3)
  const cheap = arm({
    cellKey: CELL_KEY,
    armKey: "claude::opus::medium", // the SAME tier as the Architect/judge -- not strictly below
    provider: "claude",
    servedModel: "opus",
    effort: "medium",
    n: 40,
    passing: 40,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
  });
  const costly = arm({
    cellKey: CELL_KEY,
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    effort: "medium",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
  });
  const cmp = comparison({
    cellKey: CELL_KEY,
    armKeyA: cheap.armKey,
    armKeyB: costly.armKey,
    nA: cheap.n,
    nB: costly.n,
    cheaperByCostPerCompletedTask: cheap.armKey,
    advantageHoldsUnderRedispatch: true,
    note: "cheaper",
  });
  const cell: MountHeadroomCell = { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [cheap, costly], comparisons: [cmp] };

  const [outcome] = recommendMounts([cell], mounts);
  assert.equal(outcome.kind, "refusal");
  const refusal = outcome as MountRefusal;
  assert.equal(refusal.reason, "tier-invariant");
  assert.match(refusal.detail, /Tier Invariant \(G-17\)/);
  assert.match(refusal.detail, /opus/);

  // Also exercised directly: an unroutable served_model (a second-provider name absent from
  // `tiers`) refuses too, rather than assuming it is safe.
  const unresolvable = tierInvariantViolation(mounts, "gpt-codex-mystery");
  assert.match(unresolvable ?? "", /does not resolve/);
});

// ── Claim 7: the emitted proposal states its evidence is observational, no golden run backs it

test("the emitted proposal states that its evidence is observational while no golden run backs it", () => {
  const mounts = testMounts();
  const [outcome] = recommendMounts([recommendableCell()], mounts);
  assert.equal(outcome.kind, "recommendation");
  const rec = outcome as MountRecommendation;
  assert.match(rec.note, /OBSERVATIONAL/);
  assert.match(rec.note, /no golden-suite run backs/i);

  const candidate = mountRecommendationProposalCandidate(rec);
  assert.match(candidate.summary, /OBSERVATIONAL/);
  assert.equal(rec.note.includes(OBSERVATIONAL_EVIDENCE_NOTICE), true);
  assert.equal(candidate.summary.includes(OBSERVATIONAL_EVIDENCE_NOTICE), true);
});

// ── Extra gates, beyond the seven acceptance claims, that back "refuse more often than
// recommend" (this task's own rationale) ───────────────────────────────────────────────────

test("no-stable-advantage (the cost advantage does not hold under re-dispatch) refuses rather than recommends", () => {
  const mounts = testMounts();
  const cheap = arm({
    cellKey: CELL_KEY,
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    effort: "medium",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
  });
  const costly = arm({
    cellKey: CELL_KEY,
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    effort: "medium",
    n: 40,
    passing: 32,
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
  });
  const cmp = comparison({
    cellKey: CELL_KEY,
    armKeyA: cheap.armKey,
    armKeyB: costly.armKey,
    nA: cheap.n,
    nB: costly.n,
    cheaperByCostPerCompletedTask: cheap.armKey,
    advantageHoldsUnderRedispatch: false, // looked cheaper per run, but not once re-dispatch is charged
    note: `${cheap.armKey} looked cheaper per settled run, but its advantage disappears under the charged metric`,
  });
  const cell: MountHeadroomCell = { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [cheap, costly], comparisons: [cmp] };

  const [outcome] = recommendMounts([cell], mounts);
  assert.equal(outcome.kind, "refusal");
  assert.equal((outcome as MountRefusal).reason, "no-stable-advantage");
});

test("a cheaper arm with a LOWER observed pass rate is refused (outcome before cost), never recommended", () => {
  const mounts = testMounts();
  const cheap = arm({
    cellKey: CELL_KEY,
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    effort: "medium",
    n: 40,
    passing: 20, // 50%
    costP50: 1.0,
    costP90: 1.5,
    costPerCompletedTaskUsd: 1.2,
  });
  const costly = arm({
    cellKey: CELL_KEY,
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    effort: "medium",
    n: 40,
    passing: 36, // 90%
    costP50: 3.0,
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
  });
  const cmp = comparison({
    cellKey: CELL_KEY,
    armKeyA: cheap.armKey,
    armKeyB: costly.armKey,
    nA: cheap.n,
    nB: costly.n,
    cheaperByCostPerCompletedTask: cheap.armKey,
    advantageHoldsUnderRedispatch: true,
    note: "cheaper",
  });
  const cell: MountHeadroomCell = { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [cheap, costly], comparisons: [cmp] };

  const [outcome] = recommendMounts([cell], mounts);
  assert.equal(outcome.kind, "refusal");
  assert.equal((outcome as MountRefusal).reason, "quality-regression");
});

test("an effect-size interval that reaches zero or a reversal is refused as inconclusive", () => {
  const mounts = testMounts();
  const cheap = arm({
    cellKey: CELL_KEY,
    armKey: "claude::haiku::medium",
    provider: "claude",
    servedModel: "haiku",
    effort: "medium",
    n: 40,
    passing: 36,
    costP50: 1.0,
    costP90: 3.0, // wide band
    costPerCompletedTaskUsd: 1.2,
  });
  const costly = arm({
    cellKey: CELL_KEY,
    armKey: "claude::sonnet::medium",
    provider: "claude",
    servedModel: "sonnet",
    effort: "medium",
    n: 40,
    passing: 32,
    costP50: 2.5, // sits INSIDE the cheaper arm's own p50-p90 band
    costP90: 4.0,
    costPerCompletedTaskUsd: 3.5,
  });
  const cmp = comparison({
    cellKey: CELL_KEY,
    armKeyA: cheap.armKey,
    armKeyB: costly.armKey,
    nA: cheap.n,
    nB: costly.n,
    cheaperByCostPerCompletedTask: cheap.armKey,
    advantageHoldsUnderRedispatch: true,
    note: "cheaper",
  });
  const cell: MountHeadroomCell = { cellKey: CELL_KEY, type: "implement", risk: "medium", taskClass: "src", arms: [cheap, costly], comparisons: [cmp] };

  const [outcome] = recommendMounts([cell], mounts);
  assert.equal(outcome.kind, "refusal");
  assert.equal((outcome as MountRefusal).reason, "inconclusive-interval");
});

test("re-running recommendMounts on the SAME cell mints the SAME proposal id (idempotent, never a duplicate)", () => {
  const mounts = testMounts();
  const [first] = recommendMounts([recommendableCell()], mounts);
  const [second] = recommendMounts([recommendableCell()], mounts);
  assert.equal(first.kind, "recommendation");
  assert.equal(second.kind, "recommendation");
  assert.equal(
    mountRecommendationProposalId(first as MountRecommendation),
    mountRecommendationProposalId(second as MountRecommendation),
  );
});
