import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * test/a-house-layout-site-is-judged-against-the-merge-base.test.ts — W1-T3701.
 *
 * test/repo-layout.test.ts's own house-literal ratchet used to freeze a hand-maintained ceiling
 * PER LITERAL (`HOUSE_LITERAL_CEILING`), each sitting at exactly today's count with zero headroom
 * — a tripwire that refuses the next diff to mention any of `plan/tasks.d`, `MASTER-PLAN.md`,
 * `.remudero/` or `learnings/` in non-test `src/`, whatever that diff is FOR, because the ceiling
 * cannot tell "the repository already carried this" apart from "this diff added it".
 *
 * THIS FILE HOLDS THE JUDGED LOGIC test/repo-layout.test.ts's rewritten check now runs (it reuses
 * scripts/comment-load-ratchet.mjs's `evaluateCommentLoadRatchet` for the count-vs-merge-base half
 * directly, so that half is not restated here) plus the two things a bare count comparison cannot
 * express on its own:
 *
 *   - which SPECIFIC (file, literal) pair is new relative to the merge base
 *     ({@link findNewHouseLayoutSites}), so a diff that changed nothing about a literal is never
 *     blamed for a count the repository already carried (acceptance 1); and a diff that DID add
 *     one is judged against that merge-base count, not a frozen number (acceptance 2);
 *   - a TIERED response over each new site ({@link judgeHouseLayoutSites}, design note iii): a
 *     file that already imports the sanctioned `resolveRepoLayout` has the tool in hand, so an
 *     inline literal beside it is something its author can fix right now and is refused; a file
 *     with no such import yet has no resolution path wired in, so the site is recorded as a
 *     conversion task and the diff is ADMITTED rather than walled off (acceptance 4);
 *   - the adoption ratio design note (iv) asks be reported, never targeted
 *     ({@link houseLayoutAdoption}, acceptance 5).
 *
 * Every function below is PURE — it takes already-read file contents as plain objects, never
 * touches a filesystem or spawns git — so every acceptance below is a synthetic fixture, not a
 * dependency on this repository's own drifting file count.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The house-layout literals a non-test `src/*.ts` file may assume instead of resolving through
 *  {@link "../src/lib/repo-layout.js".resolveRepoLayout} — kept identical to
 *  test/repo-layout.test.ts's own list; declared again here rather than imported from that test
 *  file, since importing one `*.test.ts` from another would re-register its `test()` calls under
 *  whichever file happens to import it first. */
export const HOUSE_LITERALS = ["plan/tasks.d", "MASTER-PLAN.md", ".remudero/", "learnings/"] as const;
export type HouseLiteral = (typeof HOUSE_LITERALS)[number];

/** One (file, literal) pair a diff added relative to the merge base. */
export interface HouseLayoutSite {
  readonly file: string;
  readonly literal: HouseLiteral;
}

/**
 * Every `(file, literal)` pair present in `headContents` that was NOT present in `baseContents` at
 * the merge base — literally added by this diff, never inherited. A `file` absent from
 * `baseContents` did not exist at the merge base at all, so every literal it carries counts as
 * newly added; a `file` present at both is compared literal-by-literal, so editing an unrelated
 * line in an already-inlining file adds no new site.
 */
export function findNewHouseLayoutSites(
  headContents: Readonly<Record<string, string>>,
  baseContents: Readonly<Record<string, string>>,
  literals: readonly HouseLiteral[] = HOUSE_LITERALS,
): HouseLayoutSite[] {
  const sites: HouseLayoutSite[] = [];
  for (const file of Object.keys(headContents).sort()) {
    const head = headContents[file];
    const base = baseContents[file];
    for (const literal of literals) {
      const inHead = head.includes(literal);
      const inBase = base !== undefined && base.includes(literal);
      if (inHead && !inBase) sites.push({ file, literal });
    }
  }
  return sites;
}

/** The judgement over a set of newly-added sites: which are refused outright, and which are
 *  admitted as a recorded conversion task instead. */
export interface HouseLayoutVerdict {
  readonly ok: boolean;
  readonly refused: readonly HouseLayoutSite[];
  readonly conversions: readonly HouseLayoutSite[];
}

/**
 * Tier every newly-added site (design note iii). A site in a file that ALREADY imports
 * `resolveRepoLayout` has the sanctioned tool in hand — the inline literal beside it is something
 * its own author can fix in this same diff, so it is REFUSED. A site in a file with no such import
 * yet has no resolution path wired into it at all; migrating it is real work nobody came to this
 * diff to do, so the gate instead RECORDS a conversion task against that file and ADMITS the diff
 * — `ok` stays true as long as no site was refused, however many were converted.
 */
export function judgeHouseLayoutSites(
  sites: readonly HouseLayoutSite[],
  headContents: Readonly<Record<string, string>>,
): HouseLayoutVerdict {
  const refused: HouseLayoutSite[] = [];
  const conversions: HouseLayoutSite[] = [];
  for (const site of sites) {
    const content = headContents[site.file] ?? "";
    if (content.includes("resolveRepoLayout")) refused.push(site);
    else conversions.push(site);
  }
  return { ok: refused.length === 0, refused, conversions };
}

/** The adoption ratio design note (iv) asks be REPORTED, never targeted: how many non-test src
 *  files resolve the house layout through `resolveRepoLayout` (`callers`) against how many still
 *  assume it inline (`inliners`). `src/lib/repo-layout.ts` itself is neither — it IS the house
 *  default, not a caller of it and not a site that could resolve through itself. */
export interface HouseLayoutAdoption {
  readonly callers: number;
  readonly inliners: number;
}

export function houseLayoutAdoption(
  headContents: Readonly<Record<string, string>>,
  literals: readonly HouseLiteral[] = HOUSE_LITERALS,
): HouseLayoutAdoption {
  let callers = 0;
  let inliners = 0;
  for (const [file, content] of Object.entries(headContents)) {
    if (file.endsWith("repo-layout.ts")) continue;
    if (content.includes("resolveRepoLayout")) callers += 1;
    if (literals.some((literal) => content.includes(literal))) inliners += 1;
  }
  return { callers, inliners };
}

// ── acceptance 1 ──────────────────────────────────────────────────────────────────────────────

test("acceptance 1: a diff that adds no house-layout site passes even when the repository already sits at its inherited count", () => {
  // 25 files already inline `learnings/` in BOTH head and base — one MORE than the old frozen
  // ceiling of 16 ever allowed, which is exactly the point: nothing here is judged against a
  // fixed number, only against what changed.
  const shared: Record<string, string> = {};
  for (let i = 0; i < 25; i += 1) shared[`src/lib/inliner-${i}.ts`] = `const dir = join(root, "learnings/", "${i}");`;

  const sites = findNewHouseLayoutSites(shared, shared);
  assert.deepEqual(sites, [], "an unchanged tree adds no site, however high its inherited count sits");

  const verdict = judgeHouseLayoutSites(sites, shared);
  assert.equal(verdict.ok, true, "a tripwire must not refuse a diff for what the repository already was");
  assert.deepEqual(verdict.refused, []);
  assert.deepEqual(verdict.conversions, []);
});

// ── acceptance 2 ──────────────────────────────────────────────────────────────────────────────

test("acceptance 2: a diff that adds a site is refused against the merge base's own count rather than a frozen literal", () => {
  const baseContents: Record<string, string> = {
    "src/lib/existing-caller.ts": 'import { resolveRepoLayout } from "./repo-layout.js"; // 1 existing site',
  };
  // The base count for `plan/tasks.d` here is 0 — an arbitrary number nowhere near any of the
  // real frozen ceilings (24/19/18/16) — to demonstrate the refusal keys on the MERGE BASE's own
  // count, not on matching some remembered literal.
  const headContents: Record<string, string> = {
    ...baseContents,
    "src/lib/new-inliner.ts":
      'import { resolveRepoLayout } from "./repo-layout.js"; const d = join(root, "plan/tasks.d");',
  };

  const sites = findNewHouseLayoutSites(headContents, baseContents);
  assert.deepEqual(sites, [{ file: "src/lib/new-inliner.ts", literal: "plan/tasks.d" }]);

  const verdict = judgeHouseLayoutSites(sites, headContents);
  assert.equal(verdict.ok, false, "a genuinely new site is refused");
  assert.deepEqual(verdict.refused, [{ file: "src/lib/new-inliner.ts", literal: "plan/tasks.d" }]);
  assert.deepEqual(verdict.conversions, []);
});

// ── acceptance 3 ──────────────────────────────────────────────────────────────────────────────

test("acceptance 3: no hand-maintained ceiling constant survives in test/repo-layout.test.ts", () => {
  const text = readFileSync(join(REPO_ROOT, "test", "repo-layout.test.ts"), "utf8");
  assert.ok(
    !text.includes("HOUSE_LITERAL_CEILING"),
    "a hand-maintained ceiling constant has no path back down and no meaning past the day it was " +
      "written — the ceiling is now the merge base's own count (design note i), so there is no " +
      "number left to maintain and none to raise",
  );
});

// ── acceptance 4 ──────────────────────────────────────────────────────────────────────────────

test("acceptance 4: a site that cannot yet resolve through the layout helper records a conversion task and admits the diff", () => {
  const baseContents: Record<string, string> = {};
  const headContents: Record<string, string> = {
    // No `resolveRepoLayout` import anywhere in this file — it has no resolution path wired in
    // yet, so migrating it is real work, not something its author can simply do in this diff.
    "src/lib/not-yet-wired.ts": 'const p = join(root, "MASTER-PLAN.md");',
  };

  const sites = findNewHouseLayoutSites(headContents, baseContents);
  assert.deepEqual(sites, [{ file: "src/lib/not-yet-wired.ts", literal: "MASTER-PLAN.md" }]);

  const verdict = judgeHouseLayoutSites(sites, headContents);
  assert.equal(verdict.ok, true, "the response is graded — a not-yet-resolvable site never walls off the diff");
  assert.deepEqual(verdict.refused, [], "nothing here is refused outright");
  assert.deepEqual(
    verdict.conversions,
    [{ file: "src/lib/not-yet-wired.ts", literal: "MASTER-PLAN.md" }],
    "the site is recorded as a conversion task instead",
  );
});

test("acceptance 4 (contrast): the SAME new site is refused once its file already has the tool in hand", () => {
  const baseContents: Record<string, string> = {};
  const headContents: Record<string, string> = {
    "src/lib/already-wired.ts":
      'import { resolveRepoLayout } from "./repo-layout.js"; const p = join(root, "MASTER-PLAN.md");',
  };

  const sites = findNewHouseLayoutSites(headContents, baseContents);
  const verdict = judgeHouseLayoutSites(sites, headContents);
  assert.equal(verdict.ok, false, "a file that already imports resolveRepoLayout can fix this now");
  assert.deepEqual(verdict.refused, [{ file: "src/lib/already-wired.ts", literal: "MASTER-PLAN.md" }]);
  assert.deepEqual(verdict.conversions, []);
});

// ── acceptance 5 ──────────────────────────────────────────────────────────────────────────────

test("acceptance 5: the check reports callers against inliners so the debt is a trend rather than a ceiling", () => {
  const headContents: Record<string, string> = {
    "src/lib/repo-layout.ts": 'const p = join(root, "MASTER-PLAN.md"); // the house default itself',
    "src/lib/caller-one.ts": 'import { resolveRepoLayout } from "./repo-layout.js";',
    "src/lib/caller-two.ts": 'import { resolveRepoLayout } from "./repo-layout.js";',
    "src/lib/inliner-one.ts": 'const p = join(root, "learnings/");',
    "src/lib/inliner-two.ts": 'const p = join(root, ".remudero/");',
    "src/lib/inliner-three.ts": 'const p = join(root, "plan/tasks.d");',
    "src/lib/unrelated.ts": "export const x = 1;",
  };

  const adoption = houseLayoutAdoption(headContents);
  assert.deepEqual(
    adoption,
    { callers: 2, inliners: 3 },
    "a plain count, not a pass/fail verdict — the ratio is read, never gated on",
  );
  // The definition file itself is excluded from both sides — it neither calls nor inlines, it IS
  // the house default every other file above resolves against.
  assert.equal("ok" in adoption, false, "houseLayoutAdoption reports a ratio, it never refuses anything");
});
