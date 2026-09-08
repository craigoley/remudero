import assert from "node:assert/strict";
import { test } from "node:test";
import { outputContractLines, ratchetContractLines } from "../src/lib/compaction.js";

// W1-T2997 — A WORKER RUNS THE CHEAP GATES BEFORE IT PUSHES.
//
// MEASURED 2026-09-07: eight open PRs, every one a fleet build, verdict census `blocked_ci` 7,
// `blocked` 1, merged by the fleet itself ZERO. Four were repaired by hand and needed no judgement —
// #4330, #4324, #4343 and #4333 were red on ratchets the change itself moved and never recorded.
// W1-T464 removed the `--ci-parity` obligation for a sound reason (the orchestrator never gated on
// it; ~15-17 minutes of a ~61-minute lane) and nothing bounded replaced it. CLAUDE.md's "run the
// gate before your first push" cannot reach a worker spawned with `settingSources: []`.

const CHEAP = ["comment-load-signal", "source-size-signal"];
const NO_ALLOWLIST = ["negative-reachability-ratchet", "catch-erasure-ratchet", "source-text-assertion-census"];

test("W1-T2997: the implement contract names the ratchets it must run before pushing", () => {
  const contract = outputContractLines("W1-TEST").join("\n");
  for (const cmd of CHEAP) {
    assert.match(contract, new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the contract must name ${cmd} — a worker never reads CLAUDE.md, so the obligation has to live here`);
  }
  assert.match(contract, /BEFORE YOUR FIRST PUSH/, "and say when to run them");
  assert.doesNotMatch(contract, /npm run --silent source-size-ratchet/, "workers must not manufacture a baseline edit for line growth");
});

test("W1-T3140: the contract distinguishes the recordable comment ratchet from the nonblocking source-size signal", () => {
  const contract = ratchetContractLines().join("\n");
  assert.match(contract, /ordinary, reviewed outcome/,
    "recording remains the fix for comment-load growth, in that gate's own words");
  assert.match(contract, /source-size.*risk signal/i);
  assert.match(contract, /growth.*PASS/i);
  for (const suite of NO_ALLOWLIST) {
    assert.match(contract, new RegExp(suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${suite} must be named as the OTHER class`);
  }
  assert.match(contract, /do\s+NOT record a number/i,
    "and the contract must forbid recording against them: those gates say 'no allowlist to add it " +
      "to', so a recorded baseline banks the debt instead of paying it — teaching a worker to " +
      "silence the very gate that surfaces the defect");
});

test("W1-T2997: the contract does not reinstate the full ci-parity step", () => {
  const contract = ratchetContractLines().join("\n");
  assert.match(contract, /stays REMOVED from your contract/,
    "W1-T464's removal stands: ~15-17 minutes of a ~61-minute lane, gating nothing");
  assert.match(contract, /Do not run it/, "and the worker is told so explicitly, not left to infer it");
});

// ── W1-T3039: the contract names the census-membership route ─────────────────────────────────────

/*
 * WHY THIS LINE EXISTS. W1-T464 removed the full CI-parity preflight from the worker contract for
 * a sound reason — ~15-17 minutes of a ~61-minute lane, and the orchestrator never gated on it.
 * W1-T2997 put back the two CHEAP ratchets. That was the right direction and too narrow: a whole
 * class of failure still reached CI, the CENSUS suites, which walk a population and assert a
 * property of the WHOLE SET. Those redden on a file referencing nothing they touch, so
 * `git grep <symbol>` cannot find them — CLAUDE.md's own clause (j).
 *
 * `rmd census-membership` (W1-T2969) already computes the map from a diff to those suites and
 * nothing told a worker to run it. MEASURED 2026-09-07 against the gates that actually refused
 * that day: run-task.ts -> command-registry-census, policy.ts -> config-reader-seams-census,
 * dep-review.ts -> negative-reachability-census, a new test/ file -> source-text-census. Four of
 * five, each a CI cycle that need not have been spent. Cost: 1.4s for the verb, ~0.8s per suite.
 *
 * IT MUST STAY DISTINGUISHABLE FROM THE PREFLIGHT W1-T464 REMOVED, which is why the contract says
 * so in its own words and test/ci-parity-contract.test.ts still forbids the literal command.
 */

test("W1-T3039: the contract routes a worker to the census suites its own diff joins", () => {
  const text = ratchetContractLines().join("\n");
  assert.match(text, /rmd census-membership/, "the verb that computes the map must be named");
  assert.match(text, /WALKS a population/i, "and why those suites are invisible to a symbol grep");
  assert.match(text, /your OWN diff can move/i, "scoped to the diff, never the whole tree");
});

test("W1-T3039: it is stated as NARROWING the gap, not closing it — instrument-surface is not in the map", () => {
  // An overclaim here is the failure mode: a worker told "this covers it" stops looking. The map
  // did NOT name instrument-surface for src/lib/review.ts on the day it was measured.
  const text = ratchetContractLines().join("\n");
  assert.match(text, /instrument-surface/, "the known gap must be named");
  assert.match(text, /does not close it/i, "and the limit stated plainly");
});

test("W1-T3039: it still does not resurrect the full preflight W1-T464 removed", () => {
  const text = ratchetContractLines().join("\n");
  assert.doesNotMatch(text, /rmd preflight --ci-parity/, "W1-T464's own guard, restated here");
  assert.match(text, /NOT the full preflight/i);
});
