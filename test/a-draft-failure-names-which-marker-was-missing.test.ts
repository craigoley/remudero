/**
 * W1-T3350 — THE INBOX DRAFTER'S DOMINANT FAILURE IS UNATTRIBUTABLE BY CONSTRUCTION.
 *
 * `parseDraftedCandidate` returns `null` when EITHER marker is missing, and the failure site logs
 * one fixed string for every one of those cases. MEASURED over the ledger union (919 archives +
 * live file): 951 `inbox.draft_error` rows, of which 947 carry the identical message
 * `no FRAGMENT/STAMP markers in worker output`, and the row records nothing else — only
 * `proposal_id`. No output size, no which-marker, no empty-vs-prose.
 *
 * That message covers at least four distinct causes: the worker produced NOTHING; it produced prose
 * with neither marker; it emitted a FRAGMENT and no STAMP; or a STAMP and no FRAGMENT. Each has a
 * different fix and the ledger cannot tell them apart — the same defect class as #981, where a row
 * carried an outcome from one decision and a reason from another.
 *
 * WHY IT IS URGENT RATHER THAN TIDY. Per-day rates from the same union: the known 2026-08-30..09-01
 * spike (44.7%, 67.3%, 87.5%), then 0-10% through 09-07 — and then 46.1% on 09-08, 74.7% on 09-09,
 * 69.7% on 09-10. The failure has RECURRED and is running at ~70% right now. W1-T3094's rationale
 * records "has run 1-6% since 09-02", which was true when written and is now stale. Nobody noticed,
 * because 947 identical strings cannot show a shape.
 *
 * NO WORKER CONTENT IS LOGGED. Only counts and a length. Worker output can carry credentials, and
 * a diagnostic that leaks them is a worse defect than the one it explains.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { describeDraftParseFailure } from "../src/lib/inbox.js";

test("W1-T3350: each way a draft can fail is a DIFFERENT recorded reason, not one string", () => {
  const none = describeDraftParseFailure("");
  assert.equal(none.fragments, 0);
  assert.equal(none.stamps, 0);
  assert.equal(none.outputChars, 0);
  assert.match(none.reason ?? "", /produced no output/i, "an empty worker run is its own cause");

  const prose = describeDraftParseFailure("I considered the proposal and decided not to draft it.");
  assert.equal(prose.fragments, 0);
  assert.equal(prose.stamps, 0);
  assert.ok(prose.outputChars > 0);
  assert.match(prose.reason ?? "", /neither marker/i, "prose with no markers is distinct from no output at all");
  assert.notEqual(prose.reason, none.reason, "the two must not collapse into one string");

  const noStamp = describeDraftParseFailure("=== FRAGMENT START ===\n- id: X\n=== FRAGMENT END ===");
  assert.equal(noStamp.fragments, 1);
  assert.equal(noStamp.stamps, 0);
  assert.match(noStamp.reason ?? "", /STAMP/, "a fragment with no stamp names the STAMP as the missing half");
  assert.doesNotMatch(noStamp.reason ?? "", /neither/i);

  const noFragment = describeDraftParseFailure("STAMP: lint_clean=true");
  assert.equal(noFragment.fragments, 0);
  assert.equal(noFragment.stamps, 1);
  assert.match(noFragment.reason ?? "", /FRAGMENT/, "a stamp with no fragment names the FRAGMENT as the missing half");

  // All four are mutually distinct — the whole point.
  const reasons = [none.reason, prose.reason, noStamp.reason, noFragment.reason];
  assert.equal(new Set(reasons).size, 4, "four causes, four reasons");
});

test("W1-T3350: the describer never carries worker CONTENT, only counts and a length", () => {
  const secretish = "STAMP: x\nANTHROPIC_API_KEY=sk-ant-not-a-real-key-000\nsome prose";
  const d = describeDraftParseFailure(secretish);
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes("sk-ant-not-a-real-key-000"), "no worker content may ride in the diagnostic");
  assert.ok(!serialized.includes("ANTHROPIC_API_KEY"), "not even a key NAME");
  assert.ok(!serialized.includes("some prose"), "no tail, no excerpt");
  assert.equal(d.outputChars, secretish.length, "the LENGTH is the only thing read off the content");
});

test("W1-T3350: a well-formed draft is not a failure and the describer says so", () => {
  const good = describeDraftParseFailure("=== FRAGMENT START ===\n- id: X\n=== FRAGMENT END ===\nSTAMP: lint_clean=true");
  assert.equal(good.fragments, 1);
  assert.equal(good.stamps, 1);
  assert.equal(good.reason, undefined, "both markers present is not a parse failure at all");
});
