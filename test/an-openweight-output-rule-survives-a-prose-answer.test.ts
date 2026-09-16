import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENWEIGHT_OUTPUT_CONTRACT } from "../src/lib/worker-provider.js";

// W1-T3664. MEASURED over the deduped ledger union: 200 draft attempts, 100 errors, all 100
// carrying the SAME reason -- "the worker produced output carrying NEITHER marker — it answered
// in prose instead of the fragment contract". The lane (inbox.ts's FRAGMENT_RE/STAMP_RE) asks the
// worker to emit `=== FRAGMENT START ===` / `=== FRAGMENT END ===` and a `STAMP:` line verbatim,
// but the adapter-owned OPENWEIGHT_OUTPUT_CONTRACT (W1-T3567) had no rule covering literal output
// markers at all -- only YAML colon-quoting, closed-enum literals, and fence-free raw documents.
// W1-T3621's 16.8x prompt-size cut did not change the failure rate, which rules out "buried under
// too much YAML" as the cause; the missing rule is the adapter-shaped fix W1-T3567's own
// precedent argues for (a rule restated per-caller is a rule the next caller will forget).

const RULE_LINES = OPENWEIGHT_OUTPUT_CONTRACT.split("\n").slice(1);

test("the openweight output contract requires literal markers when the request names them", () => {
  assert.match(
    OPENWEIGHT_OUTPUT_CONTRACT,
    /When the request names literal output markers or delimiters.*emit (those|these) markers verbatim.*rather than|instead of.*prose/is,
  );
  assert.match(OPENWEIGHT_OUTPUT_CONTRACT, /START\/END/i);
  assert.match(OPENWEIGHT_OUTPUT_CONTRACT, /STAMP/);
});

test("every openweight output-contract rule is conditional", () => {
  // >= 4, not > 0: the three pre-existing rules (W1-T3567) were ALREADY all conditional, so a
  // bare "at least one rule" check would pass identically before and after this PR's literal-
  // marker rule lands -- non-discriminating by proof-discrimination's own definition (it would
  // pass at the merge base too). Requiring the post-PR count makes this test fail at that base.
  assert.ok(
    RULE_LINES.length >= 4,
    `the contract must carry the new literal-marker rule alongside its three predecessors (found ${RULE_LINES.length})`,
  );
  for (const line of RULE_LINES) {
    assert.match(
      line,
      /^- When /,
      `rule line is not conditional -- it does not open with "- When ": ${JSON.stringify(line)}`,
    );
  }
});
