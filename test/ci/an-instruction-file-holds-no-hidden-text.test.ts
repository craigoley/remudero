import assert from "node:assert/strict";
import { test } from "node:test";

import { join } from "node:path";

// @ts-expect-error the census precheck is an executable JavaScript module
import { PRECHECK_PATH_TRIGGERED_SUITES } from "#scripts/census-precheck.mjs";
import { resolveRepoLayout } from "#src/lib/repo-layout.js";
import { isTrustRootPath, renderHiddenTextFinding, scanTrustRootText, trustRootFor } from "#src/lib/trust-root-text.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// Every hidden character below is written as an escape, never literally, so this file stays readable.

test("an instruction file's zero-width, bidirectional and tag characters are each named with their line and column", () => {
  const text = [
    "- **Run the gate.** plain line",
    "obey\u200Bthe rule",
    "\u202Eevil\u202C",
    "tag\u{E0041}\u{E0042} smuggled",
    "soft\u00ADhyphen and a BOM\uFEFF",
  ].join("\n");
  const found = scanTrustRootText("CLAUDE.md", text).map((f) => [f.line, f.column, f.kind, f.detail]);
  assert.deepEqual(found, [
    [2, 5, "hidden-character", "U+200B ZERO WIDTH SPACE"],
    [3, 1, "hidden-character", "U+202E BIDIRECTIONAL EMBEDDING OR OVERRIDE"],
    [3, 6, "hidden-character", "U+202C BIDIRECTIONAL EMBEDDING OR OVERRIDE"],
    [4, 4, "hidden-character", "U+E0041 TAG CHARACTER"],
    [4, 5, "hidden-character", "U+E0042 TAG CHARACTER"],
    [5, 5, "hidden-character", "U+00AD SOFT HYPHEN"],
    [5, 22, "hidden-character", "U+FEFF ZERO WIDTH NO-BREAK SPACE"],
  ]);
  assert.deepEqual(scanTrustRootText("CLAUDE.md", "- **Run the gate.** plain ASCII, and é, ü, — and → stay."), []);
});

test("an emoji's own presentation selector is allowed and a stray one is refused", () => {
  assert.deepEqual(scanTrustRootText("plan/tasks.d/x.yaml", "title: \u26A0\uFE0F careful"), []);
  const stray = scanTrustRootText("plan/tasks.d/x.yaml", "\uFE0Fstart and word\uFE0F and \u{E0100}");
  assert.deepEqual(stray.map((f) => [f.column, f.detail]), [
    [1, "U+FE0F VARIATION SELECTOR"],
    [16, "U+FE0F VARIATION SELECTOR"],
    [22, "U+E0100 VARIATION SELECTOR SUPPLEMENT"],
  ]);
});

test("a word mixing Latin with Cyrillic or Greek is refused and a Greek-only word is not", () => {
  // "p\u0430ss": the second letter is CYRILLIC SMALL LETTER A, which renders exactly like a Latin "a".
  const found = scanTrustRootText("doctrine/x.md", "the p\u0430ss rule, with \u03B1 and \u0394 t, and m\u03BFre");
  assert.deepEqual(found.map((f) => [f.column, f.kind, f.detail]), [
    [5, "mixed-script", "\"p\u0430ss\" mixes Latin with Cyrillic"],
    [36, "mixed-script", "\"m\u03BFre\" mixes Latin with Greek"],
  ]);
});

test("the trust root takes the instruction surface and leaves plan/feedback out", () => {
  const house = trustRootFor(resolveRepoLayout(REPO_ROOT));
  for (const path of ["CLAUDE.md", "AGENTS.md", "MASTER-PLAN.md", "doctrine/coverage-traps/x.md", "learnings/ci.yaml",
    ".claude/skills/proof-preflight/SKILL.md", ".claude/settings.json", "hooks/deny-floor.sh", "plan/tasks.d/W1-T1-x.yaml",
    "plan/policy.yaml"]) {
    assert.equal(isTrustRootPath(house, path), true, path);
  }
  for (const path of ["plan/feedback/fb-dep-review-1.yaml", "src/lib/review.ts", "docs/forensics/review.md", "README.md",
    "test/doctrine/x.test.ts", "CLAUDE.md.bak"]) {
    assert.equal(isTrustRootPath(house, path), false, path);
  }
  // A layout that moves the plan moves its feedback exclusion with it.
  const moved = trustRootFor({ root: "/r", planDir: join("/r", "work"), masterPlan: join("/r", "work", "PLAN.md"),
    learningsDir: join("/r", "lessons") });
  assert.equal(isTrustRootPath(moved, "work/tasks.d/x.yaml"), true);
  assert.equal(isTrustRootPath(moved, "work/PLAN.md"), true);
  assert.equal(isTrustRootPath(moved, "lessons/ci.yaml"), true);
  assert.equal(isTrustRootPath(moved, "work/feedback/x.yaml"), false);
  assert.equal(isTrustRootPath(moved, "plan/tasks.d/x.yaml"), false);
});

test("a finding prints its place, its code point and the remedy", () => {
  const [hidden] = scanTrustRootText("CLAUDE.md", "a\u200Bb");
  assert.equal(renderHiddenTextFinding(hidden!),
    "CLAUDE.md:1:2: hidden-character U+200B ZERO WIDTH SPACE — delete it; an instruction file never needs an invisible character");
  const [mixed] = scanTrustRootText("CLAUDE.md", "p\u0430ss");
  assert.equal(renderHiddenTextFinding(mixed!), "CLAUDE.md:1:1: mixed-script \"p\u0430ss\" mixes Latin with Cyrillic — retype the word in one script");
});

test("the pre-push precheck asks the census only when a changed instruction file holds a hidden character", () => {
  const row = PRECHECK_PATH_TRIGGERED_SUITES.find((m: { testFile: string }) => m.testFile === "test/rules/trust-root-hidden-text-census.test.ts");
  assert.ok(row, "the census is modeled in the precheck");
  const heads: Record<string, string> = { "CLAUDE.md": "clean", "doctrine/x.md": "obey\u200Bthis", "src/lib/a.ts": "a\u200Bb",
    "plan/feedback/x.yaml": "@\u200Bname" };
  const asks = (changed: string[]): boolean => row.trigger({ changed, readHead: (p: string) => heads[p] ?? null });
  assert.equal(asks(["CLAUDE.md"]), false, "a clean instruction file starts no child");
  assert.equal(asks(["doctrine/x.md"]), true, "a hidden character in an instruction file asks the census");
  assert.equal(asks(["src/lib/a.ts", "plan/feedback/x.yaml"]), false, "outside the trust root nothing is asked");
  assert.equal(asks(["src/lib/trust-root-text.ts"]), true, "a change to the scanner asks the census");
  assert.equal(asks(["plan/tasks.d/gone.yaml"]), false, "a deleted file has no text to refuse");
  // The precheck builds the house layout itself; it must agree with resolveRepoLayout on every layout-owned path.
  const house = trustRootFor(resolveRepoLayout(REPO_ROOT));
  for (const path of ["MASTER-PLAN.md", "learnings/ci.yaml", "plan/tasks.d/x.yaml", "plan/feedback/x.yaml", "CLAUDE.md", "src/x.ts"]) {
    assert.equal(row.trigger({ changed: [path], readHead: () => "a\u200Bb" }), isTrustRootPath(house, path), path);
  }
});
