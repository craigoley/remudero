import { test } from "node:test";
import assert from "node:assert/strict";
import { anchoredFixOutcome, decideFixOutcomeAction } from "../src/lib/fix-outcome.js";

// Real report tails from 2026-10-09 fix rounds. Each was ledgered fix_outcome "unstated", so #10234's FLAKE
// round went to a commit attempt ("the worker changed nothing") instead of the rerun it asked for.
const glossed = (line: string) => `REPORT\n\nNo edits saved.\n\n${line}\nPR_URL: https://github.com/o/r/pull/1`;

test("a FLAKE outcome followed by a dash gloss still asks the harness to rerun the failed jobs", () => {
  const report = glossed("FIX_OUTCOME: FLAKE — rerun attempted but blocked; hosted recovery remains unverified");
  assert.deepEqual(anchoredFixOutcome(report), { kind: "FLAKE" });
  assert.equal(decideFixOutcomeAction(anchoredFixOutcome(report), { admitTests: true }).kind, "rerun-once");
});

test("a glossed BASE_RED and FIXED route to base verification and commit", () => {
  assert.equal(decideFixOutcomeAction(anchoredFixOutcome(glossed("FIX_OUTCOME: BASE_RED - fails at main too")),
    { admitTests: true }).kind, "verify-base");
  assert.deepEqual(anchoredFixOutcome(glossed("FIX_OUTCOME: FIXED — saved edits resolve the reported reach-ratchet failure")),
    { kind: "FIXED" });
  assert.deepEqual(anchoredFixOutcome(glossed("FIX_OUTCOME: FLAKE: empty V8 coverage file")), { kind: "FLAKE" });
});

test("a glossed NEEDS_SCOPE names only its paths, never the gloss", () => {
  assert.deepEqual(anchoredFixOutcome(glossed("FIX_OUTCOME: NEEDS_SCOPE src/lib/open-prs-rest.ts — the mapper drops merged_at")),
    { kind: "NEEDS_SCOPE", paths: ["src/lib/open-prs-rest.ts"] });
  assert.equal(anchoredFixOutcome(glossed("FIX_OUTCOME: NEEDS_SCOPE src/a.ts because it drops merged_at")), undefined);
});

test("prose that is not a gloss is still not an outcome", () => {
  for (const line of ["FIX_OUTCOME: FIXED extra", "FIX_OUTCOME: FLAKEY — no", "FIX_OUTCOME: FIXED -", "FIX_OUTCOME: — FIXED"]) {
    assert.equal(anchoredFixOutcome(glossed(line)), undefined, line);
  }
});
