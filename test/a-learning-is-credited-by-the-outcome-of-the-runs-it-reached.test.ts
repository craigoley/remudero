/**
 * test/a-learning-is-credited-by-the-outcome-of-the-runs-it-reached.test.ts — W1-T4241.
 *
 * `selectLearnings` already randomizes which equally-matched learnings survive the budget cut. The
 * run now ledgers each contested entry's propensity, and `foldLearningOutcomes` joins injected vs
 * dropped to the run's clean-merge outcome with inverse-propensity weights.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderLearningOutcomes, summarizeLearningOutcomes } from "../src/lib/digest.js";
import { contestedPropensities, foldLearningOutcomes, OUTCOME_ARM_FLOOR } from "../src/lib/knowledge-outcome.js";
import { propensitySeed, selectLearnings, type LearningEntry } from "../src/lib/learnings.js";

const entry = (id: string, files: string[] = ["src/x.ts"], fact = "f".repeat(300)): LearningEntry =>
  ({ id, subsystem: "t", lifecycle: "active", files, fact, src: "t" }) as LearningEntry;

type Row = Record<string, unknown>;
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 8, 1) + clock++ * 60_000).toISOString();

/** One run: its injected row (id -> propensity, injected or dropped), then its verdict unless omitted. */
function run(runId: string, p: number, injected: boolean, verdict: string | undefined, fixes = 0, id = "L"): Row[] {
  const rows: Row[] = [
    { step: "learnings.injected", run_id: runId, ts: ts(), matched_ids: injected ? [id] : [], dropped: injected ? [] : [id], propensity: { [id]: p } },
  ];
  for (let i = 0; i < fixes; i++) rows.push({ step: "fix.dispatch", run_id: runId, ts: ts() });
  if (verdict !== undefined) rows.push({ step: "verdict", run_id: runId, ts: ts(), verdict });
  return rows;
}

/** `n` runs at propensity `p`, `injectedCount` of them injected, each with the given outcome. */
function stratum(tag: string, n: number, p: number, injectedCount: number, outcome: (injected: boolean) => string): Row[] {
  return Array.from({ length: n }, (_, i) => run(`${tag}-${i}`, p, i < injectedCount, outcome(i < injectedCount))).flat();
}

test("W1-T4241: contested entries carry a propensity and selection is unchanged", () => {
  // Four equal-strength ~330-char entries against a 700-char budget beside a tiny stronger one: two of
  // the four fit, and the draw decides which.
  const tied = ["a", "b", "c", "d"].map((id) => entry(id));
  const strong = entry("strong", ["src/x.ts", "src/y.ts"], "s");
  const files = ["src/x.ts", "src/y.ts"];
  const context = { usage: {}, seed: 42 };
  const plain = selectLearnings([...tied, strong], files, 700, context);
  const withP = selectLearnings([...tied, strong], files, 700, { ...context, propensityDraws: 64 });

  // Asking for propensities never changes what this run selects.
  assert.deepEqual(withP.selected.map((e) => e.id), plain.selected.map((e) => e.id));
  assert.deepEqual(withP.dropped.map((e) => e.id), plain.dropped.map((e) => e.id));
  assert.equal(plain.propensity, undefined);

  const p = withP.propensity!;
  assert.equal(p.strong, 1, "a higher match count is deterministic, not contested");
  for (const id of ["a", "b", "c", "d"]) assert.ok(p[id]! > 0 && p[id]! < 1, `${id} is contested: ${p[id]}`);
  // `strong` (~27 chars) leaves room for exactly two ~330-char tied entries in every re-selection,
  // so the tied propensities sum to 2 — each draw keeps two of the four.
  assert.equal(["a", "b", "c", "d"].reduce((sum, id) => sum + p[id]!, 0), 2);
  assert.equal(plain.selected.length, 3);
  // Reproducible from the run seed alone, and the derived seeds are the documented stride.
  assert.deepEqual(selectLearnings([...tied, strong], files, 700, { ...context, propensityDraws: 64 }).propensity, p);
  assert.notEqual(propensitySeed(42, 0), propensitySeed(42, 1));

  // No usage history means no draw: nothing is randomized, so nothing is contested.
  const noUsage = selectLearnings([...tied, strong], files, 700, { seed: 42, propensityDraws: 64 }).propensity!;
  assert.ok(Object.values(noUsage).every((v) => v === 0 || v === 1));
  assert.equal(contestedPropensities(noUsage), undefined);
  assert.deepEqual(contestedPropensities({ x: 0, y: 0.5, z: 1 }), { y: 0.5 });
});

test("W1-T4241: outcomes are weighted by inverse propensity with a per-arm floor", () => {
  // CONFOUNDED, NO TRUE EFFECT: runs at p=0.8 merge clean whether or not L is injected; runs at
  // p=0.2 never do. Injection follows p, so the NAIVE injected-vs-dropped rate reads +0.6.
  const confounded = [
    ...stratum("hi", 20, 0.8, 16, () => "merged"),
    ...stratum("lo", 20, 0.2, 4, () => "blocked_ci"),
  ];
  const naive = (() => {
    const inj = [16, 4];
    return 16 / (inj[0]! + inj[1]!) - 4 / (4 + 16);
  })();
  assert.ok(Math.abs(naive - 0.6) < 1e-9, "the fixture is confounded as intended");
  const none = foldLearningOutcomes(confounded).learnings[0]!;
  assert.equal(none.verdict, "no-detectable-effect");
  assert.ok(Math.abs(none.effect!) < 1e-9, `IPW removes the confounding: ${none.effect}`);

  // A REAL EFFECT: injected runs merge clean, dropped runs do not, at the same propensities.
  const real = [...stratum("hi", 20, 0.8, 16, (inj) => (inj ? "merged" : "blocked_ci")), ...stratum("lo", 20, 0.2, 4, (inj) => (inj ? "merged" : "blocked_ci"))];
  const helps = foldLearningOutcomes(real).learnings[0]!;
  assert.equal(helps.verdict, "helps");
  assert.equal(helps.effect, 1);
  const hurts = foldLearningOutcomes([...stratum("hi", 20, 0.5, 10, (inj) => (inj ? "blocked_ci" : "merged"))]).learnings[0]!;
  assert.equal(hurts.verdict, "hurts");

  // Below the floor in either arm: unmeasurable, with its counts — never a favourable reading.
  const few = foldLearningOutcomes(stratum("few", 3, 0.5, 2, () => "merged")).learnings[0]!;
  assert.deepEqual(few, { id: "L", injected: 2, dropped: 1, verdict: "unmeasurable" });
  assert.equal(OUTCOME_ARM_FLOOR, 10);

  // Propensities outside the trim are excluded and counted.
  const trimmed = foldLearningOutcomes([...run("t1", 0.02, true, "merged"), ...run("t2", 0.97, false, "merged")]);
  assert.equal(trimmed.excludedTrimmed, 2);
  assert.deepEqual(trimmed.learnings, []);
});

test("W1-T4241: a run with no terminal verdict is excluded and counted", () => {
  const rows = [
    ...run("done", 0.5, true, "merged"),
    ...run("inflight", 0.5, false, undefined),
    ...run("fixed", 0.5, false, "merged", 1),
    { step: "learnings.injected", run_id: "masked", ts: ts(), masked: true, matched_ids: [], propensity: { L: 0.5 } },
    { step: "learnings.injected", run_id: "no-p", ts: ts(), matched_ids: ["L"] },
  ];
  const r = foldLearningOutcomes(rows, { floor: 1 });
  assert.equal(r.excludedNoVerdict, 1);
  assert.equal(r.excludedMasked, 1);
  assert.equal(r.runs, 2, "the verdict-less, masked and propensity-less runs contribute nothing");
  // `fixed` merged only after a fix rung: not clean, so the dropped arm reads 0 and the injected 1.
  assert.deepEqual({ ...r.learnings[0]!, se: undefined }, { id: "L", injected: 1, dropped: 1, effect: 1, se: undefined, verdict: "helps" });
  assert.ok(r.window && r.window.from < r.window.to);
});

test("W1-T4241: the digest names measured effects and disagreements with LEARNINGS_USED", () => {
  const rows: Row[] = [
    ...stratum("hi", 20, 0.5, 10, (inj) => (inj ? "blocked_ci" : "merged")),
    // Workers claim to use L almost every time it is offered.
    ...Array.from({ length: 12 }, (_, i) => ({ step: "learnings.used", run_id: `u${i}`, injected_ids: ["L"], used_ids: ["L"] })),
  ];
  const s = summarizeLearningOutcomes(rows)!;
  assert.deepEqual(s.disagreements.map((d) => [d.id, d.verdict]), [["L", "hurts"]]);
  const line = renderLearningOutcomes(s);
  assert.match(line, /learning outcomes \(20 contested run\(s\)/);
  assert.match(line, /L -1\.00 ±0\.00 \(n 10\/10\)/);
  assert.match(line, /disagrees with LEARNINGS_USED: L hurts but used-mean 0\.93/);
  assert.equal(summarizeLearningOutcomes([{ step: "learnings.injected", run_id: "x", matched_ids: [] }]), undefined);
  assert.match(renderLearningOutcomes(summarizeLearningOutcomes(stratum("q", 3, 0.5, 1, () => "merged"))!), /no detectable effect; 0 measured, 1 unmeasurable/);
});
