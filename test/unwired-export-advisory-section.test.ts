import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

import { scopeAdvisorySection, unwiredExportAdvisorySection } from "../src/lib/review.js";
import type { UnwiredAdvisory } from "../src/lib/review.js";

const unwired = (symbols: string[]): UnwiredAdvisory => ({
  reasonCode: "unwired_export",
  symbols,
  detail: `unreached export(s) added with no WIRED-AT/SHIPS-UNWIRED marker: ${symbols.join(", ")}`,
});

const scopeViolation = (symbols: string[]): UnwiredAdvisory => ({
  reasonCode: "scope_violation",
  symbols,
  detail: `diff touches file(s) outside the task's declared scope: ${symbols.join(", ")}`,
});

test("an unwired_export advisory renders a section naming every unreached symbol", () => {
  const out = unwiredExportAdvisorySection([
    unwired(["src/lib/board-review.ts::boardReviewMarkerPath", "src/lib/board-review.ts::recordBoardReviewFire"]),
  ]);
  assert.ok(out, "expected a rendered section");
  assert.match(out, /- `src\/lib\/board-review\.ts::boardReviewMarkerPath`/);
  assert.match(out, /- `src\/lib\/board-review\.ts::recordBoardReviewFire`/);
});

test("the rendered section says advisory and says it never blocks", () => {
  const out = unwiredExportAdvisorySection([unwired(["src/lib/a.ts::x"])]) ?? "";
  assert.match(out, /advisory/i, "the word 'advisory' must be in the rendered text");
  assert.match(out, /never blocks/i);
  assert.match(out, /does not affect remudero-review's verdict/);
});

test("a review with no unwired_export advisory renders nothing", () => {
  assert.equal(unwiredExportAdvisorySection([]), undefined);
  assert.equal(unwiredExportAdvisorySection(undefined), undefined);
  // present-but-unrelated codes are not this renderer's business
  assert.equal(unwiredExportAdvisorySection([scopeViolation(["src/lib/z.ts"])]), undefined);
  assert.equal(
    unwiredExportAdvisorySection([{ reasonCode: "inverse_scope", symbols: ["src/q.ts"], detail: "d" }]),
    undefined,
  );
});

test("an advisory carrying no symbols renders nothing rather than an empty list", () => {
  assert.equal(unwiredExportAdvisorySection([unwired([])]), undefined);
});

test("a symbol named twice on the same head renders once", () => {
  const out =
    unwiredExportAdvisorySection([unwired(["src/lib/a.ts::dup"]), unwired(["src/lib/a.ts::dup", "src/lib/b.ts::other"])]) ??
    "";
  const occurrences = out.split("- `src/lib/a.ts::dup`").length - 1;
  assert.equal(occurrences, 1, `expected the duplicated symbol once, saw ${occurrences}`);
  assert.match(out, /- `src\/lib\/b\.ts::other`/, "the distinct symbol must still render");
});

test("singular and plural wording both read correctly", () => {
  assert.match(unwiredExportAdvisorySection([unwired(["src/a.ts::one"])]) ?? "", /adds an exported symbol that/);
  assert.match(
    unwiredExportAdvisorySection([unwired(["src/a.ts::one", "src/a.ts::two"])]) ?? "",
    /adds exported symbols that/,
  );
});

test("scope_violation's existing section is unchanged by the new renderer", () => {
  const advisories = [scopeViolation(["docs/ORIENTATION.md"]), unwired(["src/lib/a.ts::x"])];
  const scope = scopeAdvisorySection(advisories) ?? "";
  assert.match(scope, /\*\*Declared scope \(advisory — does not affect remudero-review's verdict\)\*\*/);
  assert.match(scope, /- `docs\/ORIENTATION\.md`/);
  // the scope section must not absorb the unwired symbols, and vice versa
  assert.ok(!scope.includes("src/lib/a.ts::x"), "scope section must not name an unwired symbol");
  const unw = unwiredExportAdvisorySection(advisories) ?? "";
  assert.ok(!unw.includes("docs/ORIENTATION.md"), "unwired section must not name a scope path");
});

test("the two sections are distinguishable headers, so a comment carrying both is readable", () => {
  const both = [scopeViolation(["src/z.ts"]), unwired(["src/lib/a.ts::x"])];
  const a = scopeAdvisorySection(both) ?? "";
  const b = unwiredExportAdvisorySection(both) ?? "";
  assert.notEqual(a.split("\n")[0], b.split("\n")[0], "the two sections must not share a header line");
  assert.match(b, /^\*\*Unwired exports \(advisory/);
});

// ── THE COMMENT PATH CONSUMES IT ──────────────────────────────────────────────────────────────

test("wiring: runReview computes the unwired section AND pushes it into the comment body", () => {
  // The same source-structure idiom test/scope-guard-overrun.test.ts uses for W1-T434, because
  // the failure it guards is INVISIBLE to a renderer test: a section computed, gated on, and
  // then never appended renders perfectly in isolation and reaches no PR.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function runReview(");
  const end = src.indexOf("// ── THE blocked_review FIX RUNG");
  assert.ok(start > -1 && end > start, "could not locate runReview's body in run-task.ts");
  const runReviewSrc = src.slice(start, end);

  assert.match(runReviewSrc, /const unwiredSection = unwiredExportAdvisorySection\(/, "runReview must render it");
  assert.match(runReviewSrc, /if \(hasUnmet \|\| rubricSection \|\| scopeSection \|\| unwiredSection\)/, "…gate on it…");
  assert.match(runReviewSrc, /if \(unwiredSection\) parts\.push\(unwiredSection\)/, "…and append it to the body");

  // INDEPENDENCE: the binding verdict never sees it. Advisory means advisory.
  const judgeIdx = runReviewSrc.indexOf("const computed = judgeReview(");
  assert.ok(judgeIdx > -1, "could not locate the judgeReview call site");
  const judgeArgs = runReviewSrc.slice(judgeIdx, runReviewSrc.indexOf("});", judgeIdx) + 3);
  assert.doesNotMatch(judgeArgs, /\bunwired(Section|ExportAdvisorySection)\b/, "judgeReview's inputs never reference it");
});

test("the advisory's ledger registration is left exactly as found", () => {
  // NOT an assertion that the step is absent from DECISION_RELEVANT_LEDGER_STEPS — it is PRESENT,
  // registered by W1-T1017 for ROTATION RETENTION so the operator adjudicating W1-T323 has the
  // corpus to adjudicate against. (`src/lib/ledger.ts` records that `run-task.ts`'s "NOT added …
  // deliberately" emitter comment is stale as a result.) Retention is not blocking: what this
  // pins is that rendering the advisory changed neither the registration nor its reader.
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("review.unwired_advisory"), true);
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("run.start"), true); // control: same Set, same accessor
});
