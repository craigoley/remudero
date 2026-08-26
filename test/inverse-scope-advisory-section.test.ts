import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  inverseScopeAdvisorySection,
  scopeAdvisorySection,
  unwiredExportAdvisorySection,
} from "../src/lib/review.js";
import type { UnwiredAdvisory } from "../src/lib/review.js";

const inverse = (symbols: string[]): UnwiredAdvisory => ({
  reasonCode: "inverse_scope",
  symbols,
  detail: `task declares file(s) this diff never touched: ${symbols.join(", ")}`,
});

const scopeViolation = (symbols: string[]): UnwiredAdvisory => ({
  reasonCode: "scope_violation",
  symbols,
  detail: `diff touches file(s) outside the task's declared scope: ${symbols.join(", ")}`,
});

const unwired = (symbols: string[]): UnwiredAdvisory => ({
  reasonCode: "unwired_export",
  symbols,
  detail: `unreached export(s) added with no WIRED-AT/SHIPS-UNWIRED marker: ${symbols.join(", ")}`,
});

test("an inverse_scope advisory renders a section naming every untouched declared path", () => {
  const out = inverseScopeAdvisorySection([inverse(["src/lib/daemon.ts", "test/daemon.test.ts"])]);
  assert.ok(out, "expected a rendered section");
  assert.match(out, /- `src\/lib\/daemon\.ts`/);
  assert.match(out, /- `test\/daemon\.test\.ts`/);
});

test("the inverse scope section calls itself advisory and says it never blocks", () => {
  const out = inverseScopeAdvisorySection([inverse(["src/a.ts"])]) ?? "";
  assert.match(out, /advisory/i, "the word 'advisory' must be in the rendered text");
  assert.match(out, /never blocks/i);
  assert.match(out, /does not affect remudero-review's verdict/);
});

test("a review with no inverse_scope advisory renders nothing", () => {
  assert.equal(inverseScopeAdvisorySection([]), undefined);
  assert.equal(inverseScopeAdvisorySection(undefined), undefined);
  // the other three reason codes are not this renderer's business
  assert.equal(inverseScopeAdvisorySection([scopeViolation(["src/z.ts"])]), undefined);
  assert.equal(inverseScopeAdvisorySection([unwired(["src/a.ts::x"])]), undefined);
  assert.equal(
    inverseScopeAdvisorySection([
      { reasonCode: "unresolved_task_scope", symbols: ["src/q.ts"], detail: "d" },
    ]),
    undefined,
  );
});

test("an inverse_scope advisory carrying no symbols renders nothing rather than an empty list", () => {
  assert.equal(inverseScopeAdvisorySection([inverse([])]), undefined);
});

test("a declared path named twice on the same head renders once", () => {
  const out =
    inverseScopeAdvisorySection([inverse(["src/lib/dup.ts"]), inverse(["src/lib/dup.ts", "src/lib/other.ts"])]) ?? "";
  const occurrences = out.split("- `src/lib/dup.ts`").length - 1;
  assert.equal(occurrences, 1, `expected the duplicated path once, saw ${occurrences}`);
  assert.match(out, /- `src\/lib\/other\.ts`/, "the distinct path must still render");
});

test("singular and plural wording both read correctly", () => {
  assert.match(inverseScopeAdvisorySection([inverse(["src/a.ts"])]) ?? "", /declares a file this diff never touched/);
  assert.match(
    inverseScopeAdvisorySection([inverse(["src/a.ts", "src/b.ts"])]) ?? "",
    /declares files this diff never touched/,
  );
});

test("the other two sections are unchanged by the new renderer", () => {
  const advisories = [scopeViolation(["docs/ORIENTATION.md"]), unwired(["src/lib/a.ts::x"]), inverse(["src/lib/q.ts"])];

  const scope = scopeAdvisorySection(advisories) ?? "";
  assert.match(scope, /\*\*Declared scope \(advisory — does not affect remudero-review's verdict\)\*\*/);
  assert.match(scope, /- `docs\/ORIENTATION\.md`/);
  assert.ok(!scope.includes("src/lib/q.ts"), "scope section must not absorb an inverse_scope path");

  const unw = unwiredExportAdvisorySection(advisories) ?? "";
  assert.match(unw, /^\*\*Unwired exports \(advisory/);
  assert.match(unw, /- `src\/lib\/a\.ts::x`/);
  assert.ok(!unw.includes("src/lib/q.ts"), "unwired section must not absorb an inverse_scope path");

  const inv = inverseScopeAdvisorySection(advisories) ?? "";
  assert.ok(!inv.includes("docs/ORIENTATION.md"), "inverse section must not name a scope_violation path");
  assert.ok(!inv.includes("src/lib/a.ts::x"), "inverse section must not name an unwired symbol");
});

test("all three sections carry distinct headers, so a comment carrying them together is readable", () => {
  const all = [scopeViolation(["src/z.ts"]), unwired(["src/lib/a.ts::x"]), inverse(["src/lib/q.ts"])];
  const heads = [scopeAdvisorySection(all), unwiredExportAdvisorySection(all), inverseScopeAdvisorySection(all)].map(
    (s) => (s ?? "").split("\n")[0],
  );
  assert.equal(new Set(heads).size, 3, `expected 3 distinct headers, saw ${JSON.stringify(heads)}`);
  assert.match(heads[2], /^\*\*Untouched declared scope \(advisory/);
});

// ── THE COMMENT PATH CONSUMES IT ──────────────────────────────────────────────────────────────

test("wiring: runReview computes the inverse scope section AND pushes it into the comment body", () => {
  // The same source-structure idiom the two sibling renderers use, because the failure it guards
  // is INVISIBLE to a renderer test: a section computed, gated on, and then never appended
  // renders perfectly in isolation and reaches no PR.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function runReview(");
  const end = src.indexOf("// ── THE blocked_review FIX RUNG");
  assert.ok(start > -1 && end > start, "could not locate runReview's body in run-task.ts");
  const runReviewSrc = src.slice(start, end);

  assert.match(runReviewSrc, /const inverseScopeSection = inverseScopeAdvisorySection\(/, "runReview must render it");
  assert.match(runReviewSrc, /\|\| inverseScopeSection\)/, "…gate the comment on it…");
  assert.match(runReviewSrc, /if \(inverseScopeSection\) parts\.push\(inverseScopeSection\)/, "…and append it");

  // INDEPENDENCE: the binding verdict never sees it. Advisory means advisory.
  const judgeIdx = runReviewSrc.indexOf("const computed = judgeReview(");
  assert.ok(judgeIdx > -1, "could not locate the judgeReview call site");
  const judgeArgs = runReviewSrc.slice(judgeIdx, runReviewSrc.indexOf("});", judgeIdx) + 3);
  assert.doesNotMatch(judgeArgs, /\binverseScope(Section|AdvisorySection)\b/, "judgeReview's inputs never reference it");
});

test("unresolved_task_scope gets no renderer, because its evidence field has no producer", () => {
  // NOT an oversight and NOT laziness: `unresolvedTaskScopeOverlaps` returns empty unless
  // `ReviewEvidence.openTaskDeclaredFiles` is populated, and nothing in src/ populates it — so a
  // renderer would be dead code. Whether to wire the producer is an open operator decision.
  const review = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  assert.ok(
    !/export function unresolvedTaskScopeAdvisorySection/.test(review),
    "no renderer should exist for unresolved_task_scope while its field is unpopulated",
  );
  // CONTROL: the same file, same accessor — the three that DO have renderers are all present.
  for (const name of ["scopeAdvisorySection", "unwiredExportAdvisorySection", "inverseScopeAdvisorySection"]) {
    assert.ok(new RegExp(`export function ${name}\\(`).test(review), `${name} must exist`);
  }
});
