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

const CHEAP = ["comment-load-signal", "source-size-ratchet"];
const NO_ALLOWLIST = ["negative-reachability-ratchet", "catch-erasure-ratchet", "source-text-assertion-census"];

test("W1-T2997: the implement contract names the ratchets it must run before pushing", () => {
  const contract = outputContractLines("W1-TEST").join("\n");
  for (const cmd of CHEAP) {
    assert.match(contract, new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the contract must name ${cmd} — a worker never reads CLAUDE.md, so the obligation has to live here`);
  }
  assert.match(contract, /BEFORE YOUR FIRST PUSH/, "and say when to run them");
});

test("W1-T2997: the contract distinguishes a recordable ratchet from one with no allowlist", () => {
  const contract = ratchetContractLines().join("\n");
  assert.match(contract, /ordinary, reviewed outcome/,
    "recording is the fix for the cheap two, in those gates' own words");
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
