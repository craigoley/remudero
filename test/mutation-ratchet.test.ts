import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMutationScore, evaluateMutationRatchet } from "../src/lib/mutation-ratchet.js";

// W1-T25 acceptance: "a mutation-testing baseline is established and
// ENFORCED by a script, with a recorded score" — "the baseline-check script
// REJECTS a fixture mutation score below the recorded baseline (accepts
// at/above)."

test("evaluateMutationRatchet: REJECTS a fixture score BELOW the recorded baseline (the falsifier)", () => {
  const v = evaluateMutationRatchet(55, 60);
  assert.equal(v.pass, false);
  assert.match(v.reasons[0], /mutation score 55% is below the ratcheted floor of 60%/);
});

test("evaluateMutationRatchet: ACCEPTS a fixture score exactly AT the recorded baseline", () => {
  const v = evaluateMutationRatchet(60, 60);
  assert.equal(v.pass, true);
});

test("evaluateMutationRatchet: ACCEPTS a fixture score ABOVE the recorded baseline", () => {
  const v = evaluateMutationRatchet(75, 60);
  assert.equal(v.pass, true);
});

test("evaluateMutationRatchet: a null baseline (BOOTSTRAP — no full run has completed yet) always passes, never blocks a PR before a real baseline exists", () => {
  const v = evaluateMutationRatchet(1, null);
  assert.equal(v.pass, true);
});

test("evaluateMutationRatchet: a null score against a REAL baseline fails closed, not open", () => {
  const v = evaluateMutationRatchet(null, 60);
  assert.equal(v.pass, false);
});

test("computeMutationScore: killed / (killed + survived + timeout) * 100, Stryker's own formula", () => {
  const statuses = ["Killed", "Killed", "Killed", "Survived", "Timeout"] as const;
  assert.equal(computeMutationScore([...statuses]), 60);
});

test("computeMutationScore: NoCoverage and Ignored mutants are excluded from the denominator", () => {
  const withNoise = computeMutationScore(["Killed", "Killed", "Killed", "Survived", "Timeout", "NoCoverage", "Ignored", "NoCoverage"]);
  const withoutNoise = computeMutationScore(["Killed", "Killed", "Killed", "Survived", "Timeout"]);
  assert.equal(withNoise, withoutNoise);
});

test("computeMutationScore: returns null (never fabricates 0 or 100) when there is nothing to divide by", () => {
  assert.equal(computeMutationScore([]), null);
  assert.equal(computeMutationScore(["NoCoverage", "Ignored"]), null);
});

test("computeMutationScore: all killed -> 100", () => {
  assert.equal(computeMutationScore(["Killed", "Killed"]), 100);
});

test("computeMutationScore: all survived -> 0", () => {
  assert.equal(computeMutationScore(["Survived", "Survived"]), 0);
});
