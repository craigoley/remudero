/**
 * W1-T4042 — the regime helper has ONE derivation, and no constant exists only to be grepped.
 *
 * `EMPTY_CRITERIA_REGIME_REASON` held a grep proof's sentence verbatim, occurred exactly once in
 * the tree (its own declaration) and was referenced nowhere. It was added by an automated repair
 * to turn a failing review green after the reviewer had correctly withdrawn a comment-only proof.
 *
 * The first test asserts an ABSENCE, which a `grep:` proof cannot express: a grep reports hits, so
 * it can never substantiate "this is gone". It fails on the tree that still carries the constant
 * and passes once it is removed, so it discriminates in the direction that matters.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as runTask from "../src/run-task.js";
import { strikeRegimeForDispatch } from "../src/run-task.js";

test("W1-T4042: the proof-only constant is no longer exported", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(runTask, "EMPTY_CRITERIA_REGIME_REASON"),
    false,
    "EMPTY_CRITERIA_REGIME_REASON existed only so a grep proof would match a non-comment line",
  );
});

test("W1-T4042: the helper still decides the empty case the same way", () => {
  // The behaviour W1-T4033 shipped, unchanged by the deletion: an unjudged round counts.
  assert.equal(strikeRegimeForDispatch([]), "executed");
  assert.equal(strikeRegimeForDispatch([{ proof_exec: "not_executable" }]), "keyword_only");
  assert.equal(strikeRegimeForDispatch([{ proof_exec: "executed_pass" }]), "executed");
});

test("W1-T4042: the regime is derived in exactly one place", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  // CORPUS CONTROL, ASSERTED BEFORE ANY COUNTING. A census over an unreadable or truncated file
  // would report 0 of everything and pass every equality below by comparing nothing — the failure
  // mode this repo treats as the most dangerous. run-task.ts is ~2.4 MB; 100 KB is a floor no
  // real version of it can fall under, not a tuned threshold.
  assert.ok(src.length > 100_000, `read only ${src.length} bytes of run-task.ts — refusing to count against an empty corpus`);

  const callSites = src.match(/strikeRegimeForDispatch\(review\.criteria\)/g) ?? [];
  assert.equal(callSites.length, 2, "both strike writers — the ordinary dispatch and the body-repair arm — call the one helper");

  // The helper's OWN comparison, and nothing else. A second occurrence is a writer that went back
  // to deriving the regime inline, which is exactly the drift W1-T4033 removed and this guards.
  const inlineDerivations = src.match(/proof_exec !== "not_executable"/g) ?? [];
  assert.equal(inlineDerivations.length, 1, "only the helper may compare proof_exec; a second comparison is a drifting derivation");
});
