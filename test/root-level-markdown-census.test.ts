import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ── W1-T2918: ROOT-LEVEL MARKDOWN CENSUS ─────────────────────────────────────────────────────
//
// `DIAGNOSIS.md` and `FINDINGS.md` sat at the repo root as dated snapshots no gate reads, cited
// from source comments as if current (see docs/archive/DIAGNOSIS.md, docs/archive/FINDINGS.md
// after this task's move). Nothing stopped a THIRD snapshot from re-accreting the same way: no
// symbol-search finds a "root markdown file" defect because there is no symbol to search for —
// this is a WALK over a population (every `.md` file directly at the repo root) asserting a
// property of the whole set (every one of them is a file the loop actually reads), which is
// exactly the shape `git grep <symbol>` cannot see and a census test can.
//
// The allowlist below is §8A's knowledge architecture, read off MASTER-PLAN and this repo's own
// root: the entry point (README), the operating contract (CLAUDE.md, budget-ratcheted by
// scripts/claude-md-budget-ratchet.mjs), the full design (MASTER-PLAN.md), the append-only
// decision log (DECISIONS.md), the injectable learnings mirror (LEARNINGS.md), the frozen
// release note (CHANGELOG.md, pre-alpha per README), the contribution guide (CONTRIBUTING.md),
// and the LICENSE-adjacent policy doc (SECURITY.md). A dated snapshot belongs under `docs/`
// (e.g. `docs/archive/`), never at the root, so this test refuses a new one on sight.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The root-level `.md` files the loop actually reads (MASTER-PLAN §8A's knowledge
 *  architecture) -- everything else that lands at the repo root is a context tax paid by every
 *  reader who opens it, the defect class W1-T2918 fixes. */
export const ROOT_MARKDOWN_ALLOWLIST = new Set([
  "README.md",
  "CLAUDE.md",
  "MASTER-PLAN.md",
  "DECISIONS.md",
  "LEARNINGS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
]);

/** Lists the `.md` files directly at `dir`'s top level -- no recursion, so a doc filed correctly
 *  under `docs/` is invisible here and a snapshot dropped straight at the root is not. */
export function rootMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

/** The census predicate: every file in `files` must be on `allowlist`. Returns the offenders
 *  (empty when the population is entirely allowlisted) so a failure names what to move instead
 *  of just going red. */
export function census(files: string[], allowlist: Set<string> = ROOT_MARKDOWN_ALLOWLIST): string[] {
  return files.filter((file) => !allowlist.has(file));
}

// ── census() itself, proven against an injected population (both arms) ──────────────────────

test("census() flags a file outside the allowlist by name -- the UNHEALTHY arm", () => {
  const offenders = census(["README.md", "SNAPSHOT.md"], new Set(["README.md"]));
  assert.deepEqual(offenders, ["SNAPSHOT.md"]);
});

test("census() reports nothing when every file is allowlisted -- the HEALTHY arm", () => {
  const offenders = census(["README.md", "CLAUDE.md"], new Set(["README.md", "CLAUDE.md"]));
  assert.deepEqual(offenders, []);
});

// ── the real repo root, walked live ──────────────────────────────────────────────────────────

test("every root-level markdown file in this repo is on the allowlist", () => {
  const offenders = census(rootMarkdownFiles(REPO_ROOT));
  assert.deepEqual(
    offenders,
    [],
    `root-level .md not on the allowlist: ${offenders.join(", ")} -- move it under docs/ ` +
      `(e.g. docs/archive/ for a dated snapshot) and repoint its citations, per W1-T2918`,
  );
});

test("the allowlist itself has not drifted from what is actually at the root", () => {
  const present = new Set(rootMarkdownFiles(REPO_ROOT));
  const missing = [...ROOT_MARKDOWN_ALLOWLIST].filter((file) => !present.has(file));
  assert.deepEqual(missing, [], `allowlisted file no longer at the repo root: ${missing.join(", ")}`);
});

test("DIAGNOSIS.md and FINDINGS.md no longer sit at the repo root (W1-T2918)", () => {
  const present = new Set(rootMarkdownFiles(REPO_ROOT));
  assert.ok(!present.has("DIAGNOSIS.md"), "DIAGNOSIS.md is still at the repo root; move it to docs/archive/");
  assert.ok(!present.has("FINDINGS.md"), "FINDINGS.md is still at the repo root; move it to docs/archive/");
});
