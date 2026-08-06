import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShellHtml } from "../src/lib/serve.js";

// ── W1-T376, acceptance claim 3: "a rendered section row states the filed-versus-merged pair
// and contains no percent sign" ─────────────────────────────────────────────────────────────
//
// serve.ts's client render lives inside renderShellHtml's own <script> template literal, not as
// an importable module (this task's own note: "serve.ts's client script is a backtick template
// where a stray backtick breaks the esbuild parse"). `planSectionRowHtml` is a PURE function
// there (heading/filed/merged in, one <li> string out, no DOM beyond `escapeHtml`), so it is
// pulled out of the RENDERED shell and eval'd directly -- the exact same technique
// test/account-usage.test.ts already proved for `usageWindowLabel` (see that file's own
// comment): the slice spans `escapeHtml` (which `planSectionRowHtml` calls) through the next
// unrelated function definition, so the extracted text is a self-contained, real parse of the
// SHIPPED script -- not a hand-copied stand-in that could silently drift from it.

function extractPlanSectionRowHtml(): (s: { heading: string; filed: number; merged: number }) => string {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(renderShellHtml())![1];
  const start = script.indexOf("function escapeHtml");
  assert.ok(start >= 0, "escapeHtml must exist in the rendered shell -- planSectionRowHtml calls it");
  const end = script.indexOf("// W1-T189");
  assert.ok(end > start, "the W1-T189 comment must still follow planSectionRowHtml -- if this moved, update the slice bounds");
  const slice = script.slice(start, end);
  assert.match(slice, /function planSectionRowHtml/, "planSectionRowHtml must be defined within the extracted slice");
  return new Function(`${slice} return planSectionRowHtml;`)() as (s: { heading: string; filed: number; merged: number }) => string;
}

test("planSectionRowHtml: a section with one filed, one merged task renders '1 of 1 filed tasks merged' -- and the row carries NO percent sign anywhere, positively asserted", () => {
  const rowHtml = extractPlanSectionRowHtml();
  const html = rowHtml({ heading: "7C. Design Review", filed: 1, merged: 1 });
  assert.match(html, /1 of 1 filed tasks merged/);
  assert.doesNotMatch(html, /%/, "the falsifier: a percentage would rank this 1-task section as '100%', ranking it above a thicker one that merely hasn't finished yet");
});

test("planSectionRowHtml: an UNFILLED merge count states the pair as-is (e.g. '1 of 12 filed tasks merged') -- never a computed percentage, and the heading is HTML-escaped", () => {
  const rowHtml = extractPlanSectionRowHtml();
  const html = rowHtml({ heading: "5C. Task <pre-flight>", filed: 12, merged: 1 });
  assert.match(html, /1 of 12 filed tasks merged/);
  assert.doesNotMatch(html, /%/);
  assert.doesNotMatch(html, /<pre-flight>/, "untrusted heading text must never be injected verbatim");
  assert.match(html, /Task &lt;pre-flight&gt;/);
});

test("planSectionRowHtml: the heading text itself renders in the row, so an operator can tell WHICH section a count belongs to", () => {
  const rowHtml = extractPlanSectionRowHtml();
  const html = rowHtml({ heading: "9. Resource doctrine — mounts, windows & context", filed: 3, merged: 3 });
  assert.match(html, /9\. Resource doctrine — mounts, windows &amp; context/);
});
