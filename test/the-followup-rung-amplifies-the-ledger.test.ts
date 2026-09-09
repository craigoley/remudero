/**
 * W1-T3234 — the follow-up harvest writes one row per DECLARATION, not one per re-read.
 *
 * MEASURED 2026-09-09 over the three-form ledger union, `report.followups` rows against DISTINCT
 * row payloads in the same day:
 *
 *   2026-08-26   1,330 / 90    15:1
 *   2026-09-01   2,601 / 67    39:1
 *   2026-09-03  15,543 / 48   324:1
 *   2026-09-05  11,622 / 26   447:1
 *   2026-09-07  22,082 / 80   276:1
 *
 * THE CONTENT SHRANK WHILE THE VOLUME GREW — 90 distinct payloads down to 26 while rows rose from
 * 1,330 to 22,082. A rate that rises as the signal falls is an amplifier, not a producer. And the
 * corpus it inflates is the one that OOM-killed the retro meant to consume it (W1-T3229): the
 * inflection is 2026-09-03 in BOTH series, the day the retro marker froze.
 *
 * The mechanism is re-reading: the fix rung re-harvests the same worker transcript on every sweep
 * tick for a PR it cannot dispatch, and two implement call sites read the same `fullText(impl)`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { followupSetDigest, harvestFollowupsFromReport } from "../src/run-task.js";

const REPORT = [
  "## Follow-ups",
  "",
  "- task: wire the reader that nothing calls",
  "- research: confirm the trailer scan sees the head ref",
  "",
].join("\n");

/** Drive the harvest with its own memo, so no case inherits another's writes. */
function harvester() {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const seen = new Set<string>();
  return {
    rows,
    said,
    seen,
    run: (text: string, label = "implement", prUrl?: string) =>
      harvestFollowupsFromReport(text, {
        label,
        prUrl,
        seen,
        log: (step, extra) => rows.push({ step, extra }),
        say: (m) => said.push(m),
      }),
  };
}

const followupRows = (h: ReturnType<typeof harvester>) => h.rows.filter((r) => r.step === "report.followups");
const suppressedRows = (h: ReturnType<typeof harvester>) => h.rows.filter((r) => r.step === "followup_write_suppressed");

test("W1-T3234: an unchanged follow-up set is written once, not once per pass", () => {
  const h = harvester();
  // Ten re-reads of the SAME transcript — the fix rung's sweep-tick shape.
  for (let i = 0; i < 10; i += 1) h.run(REPORT);

  assert.equal(followupRows(h).length, 1, "one declaration, one row");
  assert.equal(h.said.length, 1, "and it is announced once, not ten times");

  // THE SUPPRESSION IS SAID ONCE AND THEN SILENT. Logging every suppression would rebuild the
  // amplifier out of the fix — 22,081 suppression rows instead of 22,081 follow-up rows is not a
  // repair, and that is the one outcome this must not ship.
  assert.equal(suppressedRows(h).length, 1, "the suppression is reported once, then silent");
  const note = suppressedRows(h)[0]!.extra!;
  assert.equal(note.label, "implement");
  assert.equal(note.entry_count, 2);
  assert.equal(typeof note.digest, "string");
  assert.match(String(note.note), /further repeats are silent/);
});

test("W1-T3234: a new or changed follow-up set is still recorded", () => {
  const h = harvester();
  h.run(REPORT);
  assert.equal(followupRows(h).length, 1);

  // A CHANGED set is a new finding and must be written. Deduplication that swallowed this would
  // cost exactly what the rung exists to produce.
  h.run(REPORT.replace("wire the reader that nothing calls", "wire the reader AND its caller"));
  assert.equal(followupRows(h).length, 2, "changed content is a new declaration");

  // Same entries, DIFFERENT PR — a different declaration, because the provenance differs.
  h.run(REPORT, "implement", "https://example.invalid/pull/1");
  assert.equal(followupRows(h).length, 3, "same entries on another PR is not a repeat");
  assert.equal(followupRows(h)[2]!.extra!.pr_url, "https://example.invalid/pull/1");

  // Same entries, DIFFERENT rung — recon and implement declaring the same thing are two facts.
  h.run(REPORT, "recon");
  assert.equal(followupRows(h).length, 4, "same entries from another label is not a repeat");

  // ...and re-reading any of them is still suppressed, so the bound survives the exceptions.
  const before = followupRows(h).length;
  h.run(REPORT);
  h.run(REPORT, "recon");
  assert.equal(followupRows(h).length, before, "repeats of the new sets are suppressed too");
});

test("W1-T3234: a report with no follow-ups section writes nothing at all, as before", () => {
  const h = harvester();
  h.run("## Summary\n\nNothing declared here.\n");
  assert.deepEqual(h.rows, [], "the silent no-op case is byte-identical to before");
  assert.deepEqual(h.said, []);
});

test("W1-T3234: the digest is content identity — not order-insensitive, not time-varying", () => {
  const a = followupSetDigest("implement", undefined, [{ type: "task", text: "x" }]);
  assert.equal(a, followupSetDigest("implement", undefined, [{ type: "task", text: "x" }]), "stable across calls");
  assert.notEqual(a, followupSetDigest("recon", undefined, [{ type: "task", text: "x" }]), "label is part of identity");
  assert.notEqual(a, followupSetDigest("implement", "https://p/1", [{ type: "task", text: "x" }]), "pr_url is too");
  assert.notEqual(a, followupSetDigest("implement", undefined, [{ type: "task", text: "y" }]), "and the content is");
  // Order matters: two orderings are two different declarations, and collapsing them would let a
  // reordered set silently vanish.
  const two = [{ type: "task", text: "x" }, { type: "research", text: "y" }];
  assert.notEqual(followupSetDigest("implement", undefined, two), followupSetDigest("implement", undefined, [...two].reverse()));
});
