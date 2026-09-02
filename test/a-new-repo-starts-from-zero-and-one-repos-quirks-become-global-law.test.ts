// test/a-new-repo-starts-from-zero-and-one-repos-quirks-become-global-law.test.ts
//
// W1-T2576 — ROUTING EVIDENCE IS POOLED OR IT IS PER-REPO AND BOTH ARE WRONG. Pool everything and
// the busiest repo's idiosyncrasies become the prior every OTHER repo inherits; isolate per repo
// and onboarding a repo throws away everything the fleet already learned. src/lib/routing-prior.ts
// (W1-T2576) is the partial-pooling estimator that resolves this — a repo's estimate is the pooled
// fleet-wide estimate shrunk toward that repo's OWN observations in proportion to how much of its
// own evidence exists. This suite proves:
//   1. `pooledPriorFor` is reached from `mount-recommender.ts`, not only from this test — a grep,
//      not a unit test (this task's own acceptance).
//   2. a repo with no runs of its own inherits the pooled fleet estimate, never a default constant
//      or an error.
//   3. a repo whose own evidence CONTRADICTS the pool converges to its own value as its sample
//      grows.
//   4. the estimate reports the repo's own n and the pooled n behind it, separately.
//   5. an operator prior declared in principles.yaml dominates the learned estimate rather than
//      averaging with it.
//   6. one repo's volume cannot move another repo's estimate once that repo has its own evidence.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  computePooledPrior,
  DEFAULT_SHRINKAGE_K,
  operatorPriorFromPrinciples,
  pooledPriorFor,
  type PoolableEvidence,
} from "../src/lib/routing-prior.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── Claim 1: reached from the recommender, not only from this test ────────────────────────────

test("pooledPriorFor( is called from src/lib/mount-recommender.ts, not only from this test", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "mount-recommender.ts"), "utf8");
  assert.match(src, /\bpooledPriorFor\(/, "mount-recommender.ts must call pooledPriorFor(...) from a production rung");
});

// ── Claim 2: a repo with no runs of its own inherits the pool, not a default or an error ──────

test("a repo with no runs of its own inherits the pooled fleet estimate, not a default constant or an error", () => {
  const evidence: PoolableEvidence[] = [
    { id: "busy-repo-a", n: 500, value: 0.7 },
    { id: "busy-repo-b", n: 300, value: 0.9 },
  ];
  // A brand-new repo, never seen before, is not even present in `evidence`.
  const result = pooledPriorFor("brand-new-repo", evidence);

  assert.equal(result.ownN, 0, "the new repo has no observations of its own");
  const pooled = computePooledPrior(evidence);
  assert.equal(pooled.pooledN, 800);
  // (500*0.7 + 300*0.9) / 800 = 0.775
  assert.ok(Math.abs(pooled.pooledValue - 0.775) < 1e-9);
  // Not a magic constant (e.g. 0, 0.5, 1) and not NaN/thrown — exactly the pool.
  assert.ok(Math.abs(result.estimate - pooled.pooledValue) < 1e-9, "n=0 must inherit the pool exactly");
  assert.equal(result.source, "shrinkage");
  assert.equal(result.pooledN, 800, "the pooled n behind the estimate must be reported");
});

test("a totally cold fleet (no evidence anywhere) never throws — it degenerates safely", () => {
  assert.doesNotThrow(() => pooledPriorFor("anything", []));
  const result = pooledPriorFor("anything", []);
  assert.equal(result.ownN, 0);
  assert.equal(result.pooledN, 0);
});

// ── Claim 3: a repo whose own evidence contradicts the pool converges to its own value ─────────

test("a repo whose own evidence contradicts the pool converges toward its own value as its sample grows", () => {
  // The pool (everyone else) sits around 0.9; this repo's own runs consistently land at 0.2.
  const others: PoolableEvidence[] = [
    { id: "fleet-repo-1", n: 1000, value: 0.9 },
    { id: "fleet-repo-2", n: 1000, value: 0.9 },
  ];

  const small = pooledPriorFor("contrarian-repo", [...others, { id: "contrarian-repo", n: 5, value: 0.2 }]);
  const medium = pooledPriorFor("contrarian-repo", [...others, { id: "contrarian-repo", n: 200, value: 0.2 }]);
  const large = pooledPriorFor("contrarian-repo", [...others, { id: "contrarian-repo", n: 1_000_000, value: 0.2 }]);

  // Monotonically closer to the repo's own value (0.2) as n grows, further from the pool (~0.9).
  assert.ok(small.estimate > medium.estimate, "more of its own evidence must pull the estimate down toward 0.2");
  assert.ok(medium.estimate > large.estimate);
  // At sufficient n, it ends up AT its own value, not merely "between" the two forever.
  assert.ok(Math.abs(large.estimate - 0.2) < 1e-6, `at n=1e6 the estimate must converge to 0.2, got ${large.estimate}`);
});

// ── Claim 4: own n and pooled n are reported separately ────────────────────────────────────────

test("the estimate reports the repo's own n and the pooled n behind it, separately", () => {
  const evidence: PoolableEvidence[] = [
    { id: "repo-x", n: 12, value: 0.6 },
    { id: "repo-y", n: 88, value: 0.95 },
  ];
  const result = pooledPriorFor("repo-x", evidence);
  assert.equal(result.ownN, 12, "repo-x's own n, not the fleet total");
  assert.equal(result.pooledN, 100, "the fleet-wide total (12 + 88), not repo-x's own n again");
  assert.notEqual(result.ownN, result.pooledN, "the two counts must be visibly distinct fields");
});

// ── Claim 5: an operator prior in principles.yaml dominates, never averages ────────────────────

test("an operator-declared prior dominates the learned estimate rather than averaging with it", () => {
  // A parsed principles.yaml document declaring a routing prior for this repo — the shorthand form.
  const principlesShorthand = { routing_priors: { "gnarly-repo": 0.99 } };
  // ...and the explicit-object form, equivalent.
  const principlesExplicit = { routing_priors: { "gnarly-repo": { value: 0.99 } } };

  for (const principles of [principlesShorthand, principlesExplicit]) {
    const operatorPrior = operatorPriorFromPrinciples(principles, "gnarly-repo");
    assert.ok(operatorPrior, "an operator prior must be read back out of the parsed document");
    assert.equal(operatorPrior!.value, 0.99);

    // The learned evidence says something completely different (0.1) — if this were averaged,
    // the result would sit somewhere between 0.1 and 0.99. It must not: it must BE 0.99.
    const evidence: PoolableEvidence[] = [
      { id: "gnarly-repo", n: 10_000, value: 0.1 },
      { id: "other-repo", n: 10_000, value: 0.1 },
    ];
    const result = pooledPriorFor("gnarly-repo", evidence, { operatorPrior });
    assert.equal(result.estimate, 0.99, "the operator prior must win outright, never blend with the ledger");
    assert.equal(result.source, "operator");
    // Even with an operator override, the underlying counts are still legible.
    assert.equal(result.ownN, 10_000);
    assert.equal(result.pooledN, 20_000);
  }
});

test("operatorPriorFromPrinciples returns undefined (never throws) for a document with no routing_priors block", () => {
  assert.equal(operatorPriorFromPrinciples({}, "any-repo"), undefined);
  assert.equal(operatorPriorFromPrinciples(undefined, "any-repo"), undefined);
  assert.equal(operatorPriorFromPrinciples({ routing_priors: { "other-repo": 0.5 } }, "any-repo"), undefined);
});

// ── Claim 6: one repo's volume cannot move another repo's estimate once it has its own evidence ─

test("one repo's volume cannot move another repo's estimate once that repo has its own evidence", () => {
  // repo-a has a solid sample of its own (well above the recommender's own DEFAULT_MIN_SAMPLE_N).
  const repoAOwn: PoolableEvidence = { id: "repo-a", n: 1000, value: 0.5 };

  const withModestFleet = pooledPriorFor("repo-a", [repoAOwn, { id: "repo-b", n: 10_000, value: 0.95 }]);
  const withHugeFleet = pooledPriorFor("repo-a", [repoAOwn, { id: "repo-b", n: 10_000_000, value: 0.95 }]);

  // repo-b's volume grew 1000x — that must not meaningfully move repo-a's own estimate, because
  // the pool's WEIGHT against repo-a's own value is capped at the fixed shrinkage constant K, not
  // at the fleet's total n.
  assert.ok(
    Math.abs(withHugeFleet.estimate - withModestFleet.estimate) < 0.01,
    `repo-a's estimate moved from ${withModestFleet.estimate} to ${withHugeFleet.estimate} as repo-b's volume grew`,
  );
  // And it must stay close to repo-a's OWN value (0.5), not migrate toward repo-b's (0.95).
  assert.ok(Math.abs(withHugeFleet.estimate - 0.5) < 0.05, "repo-a's own sample must dominate its own estimate");
});

// ── The shrinkage constant itself is a fixed, documented pseudo-count ──────────────────────────

test("DEFAULT_SHRINKAGE_K is a small fixed pseudo-count, independent of any evidence handed in", () => {
  assert.equal(typeof DEFAULT_SHRINKAGE_K, "number");
  assert.ok(DEFAULT_SHRINKAGE_K > 0);
  // A caller may still override it explicitly. own-repo has SOME evidence of its own (n=5) that
  // disagrees with the pool (0.3 vs 1.0).
  const evidence: PoolableEvidence[] = [{ id: "own-repo", n: 5, value: 0.3 }, { id: "other", n: 100, value: 1 }];
  const withDefault = pooledPriorFor("own-repo", evidence);
  const withOverride = pooledPriorFor("own-repo", evidence, { shrinkageK: 0 });
  assert.notEqual(withDefault.estimate, withOverride.estimate, "shrinkageK must actually change the estimate");
  assert.equal(withOverride.estimate, 0.3, "K=0 means no pooling at all — own value only, however small its n");
});
