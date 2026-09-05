import assert from "node:assert/strict";
import { test } from "node:test";
import { planSectionRowHtml } from "../src/lib/console-shell-script.js";

// ── W1-T376, acceptance claim 3: "a rendered section row states the filed-versus-merged pair
// and contains no percent sign" ─────────────────────────────────────────────────────────────
//
// W1-T2731: `planSectionRowHtml` is now a REAL EXPORT of lib/console-shell-script.ts, so this
// suite imports it instead of slicing it out of the rendered shell between `function escapeHtml`
// and a `// W1-T189` comment. The old slice was not merely awkward — it was a coupling to the
// TEXTUAL ORDER of a 4,200-line template, and it broke the moment the helpers moved. What it
// bought (a real parse of the SHIPPED script rather than a hand-copied stand-in that could drift)
// is now bought by construction: renderShellHtml emits these very function objects through
// `.toString()`, so there is ONE definition and drift is not expressible.
// test/console-shell-coverage-is-vacuous.test.ts holds that wiring.

test("planSectionRowHtml: a section with one filed, one merged task renders '1 of 1 filed tasks merged' -- and the row carries NO percent sign anywhere, positively asserted", () => {
  const rowHtml = planSectionRowHtml;
  const html = rowHtml({ heading: "7C. Design Review", filed: 1, merged: 1 });
  assert.match(html, /1 of 1 filed tasks merged/);
  assert.doesNotMatch(html, /%/, "the falsifier: a percentage would rank this 1-task section as '100%', ranking it above a thicker one that merely hasn't finished yet");
});

test("planSectionRowHtml: an UNFILLED merge count states the pair as-is (e.g. '1 of 12 filed tasks merged') -- never a computed percentage, and the heading is HTML-escaped", () => {
  const rowHtml = planSectionRowHtml;
  const html = rowHtml({ heading: "5C. Task <pre-flight>", filed: 12, merged: 1 });
  assert.match(html, /1 of 12 filed tasks merged/);
  assert.doesNotMatch(html, /%/);
  assert.doesNotMatch(html, /<pre-flight>/, "untrusted heading text must never be injected verbatim");
  assert.match(html, /Task &lt;pre-flight&gt;/);
});

test("planSectionRowHtml: the heading text itself renders in the row, so an operator can tell WHICH section a count belongs to", () => {
  const rowHtml = planSectionRowHtml;
  const html = rowHtml({ heading: "9. Resource doctrine — mounts, windows & context", filed: 3, merged: 3 });
  assert.match(html, /9\. Resource doctrine — mounts, windows &amp; context/);
});
