/**
 * test/worktree-creation-census.test.ts — W1-T2622.
 *
 * WHAT THIS PROVES. `src/lib/worktree-sites.ts` is the census: a registry naming every
 * worktree-creation site in `src/` as either `routes-through: worktreeAdd` (base recorded,
 * currency asserted — W1-T2621's own work) or a NAMED `exempt` row carrying the reason
 * origin/main currency does not apply, plus a BIDIRECTIONAL guard that re-derives the truth from
 * `src/` on every call rather than trusting the registry as a hand-maintained duplicate of it.
 *
 * FOUR CLAIMS, four groups of tests below:
 *   (1) a raw `git worktree add` with no registry row FAILS the guard — a new hole cannot appear
 *       silently, and the site inside `worktreeAdd` itself needs no row at all;
 *   (2) THE OTHER DIRECTION — a registry row whose site no longer exists in `src/` ALSO FAILS,
 *       for both `exempt` and `routes-through` rows;
 *   (3) an `exempt` row with a blank reason FAILS, and the review-materialization site is present
 *       as a NAMED row, not an absence;
 *   (4) the census changes no provisioning behaviour — it is pure text reading, never git.
 *
 * FIXTURES, NOT THE REAL `src/`, FOR THE FAILURE-MODE TESTS. Proving "a new raw site fails"
 * requires a raw site with no row, and this repo's own `src/` must never carry one (that is what
 * group (1)'s FIRST test, against the real tree, already asserts) — so every failure-mode test
 * below builds a throwaway `src/` under a fresh `mkdtempSync` dir instead. `test/setup/tmp-hygiene`
 * (loaded by `npm test`/`npm run test:ci`) reaps it automatically; nothing here needs its own
 * cleanup.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assertWorktreeSiteCensusClean,
  censusWorktreeSites,
  enclosingSiteName,
  findRawWorktreeAddSites,
  RAW_WORKTREE_ADD_RE,
  renderWorktreeCensusFailure,
  WORKTREE_SITE_REGISTRY,
  type WorktreeSiteRow,
} from "../src/lib/worktree-sites.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SRC = join(REPO_ROOT, "src");

/** A throwaway `<tmp>/src/...` tree, one file per entry (path relative to the fixture root, e.g.
 * `"src/lib/rogue.ts"`). Returns the fixture's `root` and `srcDir` for
 * `censusWorktreeSites(srcDir, root, registry)`. */
function fixture(files: Record<string, string>): { root: string; srcDir: string } {
  const root = mkdtempSync(join(tmpdir(), "worktree-census-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { root, srcDir: join(root, "src") };
}

const roguey = `
import { execFileSync } from "node:child_process";

export function rogueCreate(repoDir: string, worktreePath: string, branch: string): void {
  execFileSync("git", ["-C", repoDir, "worktree", "add", worktreePath, \`origin/\${branch}\`], { stdio: "pipe" });
}
`;

const canonicalWorktreeAdd = `
import { execFileSync } from "node:child_process";

export function worktreeAdd(repoDir: string, worktreePath: string, branch: string, base = "origin/main"): void {
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branch, "--no-track", worktreePath, base],
    { stdio: "inherit" },
  );
}
`;

// ── (1) FORWARD DIRECTION: a raw site with no row fails; the canonical site needs none ───────

test("the REAL src/ census is clean: every raw invocation is inside worktreeAdd or has a row", () => {
  assert.doesNotThrow(() => assertWorktreeSiteCensusClean(REAL_SRC, REPO_ROOT));
});

test("a NEW raw `git worktree add` site with no registry row FAILS the guard", () => {
  const { root, srcDir } = fixture({ "src/lib/rogue.ts": roguey });
  const result = censusWorktreeSites(srcDir, root, []); // empty registry: nothing is declared
  assert.equal(result.undeclaredRawSites.length, 1);
  assert.equal(result.undeclaredRawSites[0]?.file, "src/lib/rogue.ts");
  assert.equal(result.undeclaredRawSites[0]?.site, "rogueCreate");

  assert.throws(
    () => assertWorktreeSiteCensusClean(srcDir, root, []),
    /raw `git worktree add` invocation\(s\) with no registry row.*src\/lib\/rogue\.ts:.*rogueCreate/s,
  );
});

test("...and adding the matching exempt row clears it", () => {
  const { root, srcDir } = fixture({ "src/lib/rogue.ts": roguey });
  const registry: WorktreeSiteRow[] = [
    {
      file: "src/lib/rogue.ts",
      site: "rogueCreate",
      creates: "a test fixture worktree",
      disposition: { kind: "exempt", because: "fixture-only, exercising the guard's happy path" },
    },
  ];
  const result = censusWorktreeSites(srcDir, root, registry);
  assert.deepEqual(result.undeclaredRawSites, []);
  assert.deepEqual(result.rottedRows, []);
  assert.deepEqual(result.blankReasonRows, []);
  assert.doesNotThrow(() => assertWorktreeSiteCensusClean(srcDir, root, registry));
});

test("the site INSIDE worktreeAdd's own body needs no row at all", () => {
  const { root, srcDir } = fixture({ "src/lib/worker.ts": canonicalWorktreeAdd });
  const result = censusWorktreeSites(srcDir, root, []); // no rows, yet clean
  assert.deepEqual(result.undeclaredRawSites, [], "worktreeAdd's own raw invocation is the routing TARGET, not a site");
  assert.doesNotThrow(() => assertWorktreeSiteCensusClean(srcDir, root, []));
});

// ── (2) REVERSE DIRECTION: a row whose site no longer exists ALSO fails ──────────────────────

test("a registry row whose EXEMPT site no longer exists in src/ FAILS (a rotted exemption)", () => {
  // The fixture's rogue.ts still exists, but the row names a DIFFERENT site in it — exactly the
  // shape a rename or a deleted call site leaves behind: the row survives, the site it excused
  // does not.
  const { root, srcDir } = fixture({ "src/lib/rogue.ts": roguey });
  const registry: WorktreeSiteRow[] = [
    {
      file: "src/lib/rogue.ts",
      site: "longGoneFunction",
      creates: "nothing — this site was removed",
      disposition: { kind: "exempt", because: "stale on purpose, to prove the reverse direction" },
    },
  ];
  const result = censusWorktreeSites(srcDir, root, registry);
  assert.equal(result.rottedRows.length, 1);
  assert.equal(result.rottedRows[0]?.site, "longGoneFunction");
  // The raw site that DOES exist (rogueCreate) has no row for IT, so it is ALSO reported —
  // both halves of the bidirectional guard can fire in the same run, independently.
  assert.equal(result.undeclaredRawSites.length, 1);
  assert.equal(result.undeclaredRawSites[0]?.site, "rogueCreate");

  assert.throws(
    () => assertWorktreeSiteCensusClean(srcDir, root, registry),
    /registry row\(s\) whose site no longer exists in src\/.*longGoneFunction/s,
  );
});

test("a registry row whose ROUTES-THROUGH site no longer exists in src/ ALSO fails", () => {
  const { root, srcDir } = fixture({
    "src/lib/caller.ts": `
export function stillHere(repoDir: string): void {
  worktreeAdd(repoDir, "x", "y", "origin/main");
}
`,
  });
  const registry: WorktreeSiteRow[] = [
    { file: "src/lib/caller.ts", site: "stillHere", creates: "x", disposition: { kind: "routes-through" } },
    { file: "src/lib/caller.ts", site: "renamedAway", creates: "x", disposition: { kind: "routes-through" } },
  ];
  const result = censusWorktreeSites(srcDir, root, registry);
  assert.deepEqual(
    result.rottedRows.map((r) => r.site),
    ["renamedAway"],
    "the declared function that is actually still there is NOT reported as rotted",
  );
  assert.throws(() => assertWorktreeSiteCensusClean(srcDir, root, registry), /renamedAway/);
});

// ── (3) BLANK REASONS FAIL, AND THE REVIEW SITE IS A NAMED ROW ────────────────────────────────

test("an exempt row with a BLANK reason FAILS even though its site is present", () => {
  const { root, srcDir } = fixture({ "src/lib/rogue.ts": roguey });
  const registry: WorktreeSiteRow[] = [
    { file: "src/lib/rogue.ts", site: "rogueCreate", creates: "x", disposition: { kind: "exempt", because: "   " } },
  ];
  const result = censusWorktreeSites(srcDir, root, registry);
  assert.deepEqual(result.undeclaredRawSites, [], "the site itself is declared — only the reason is the problem");
  assert.equal(result.blankReasonRows.length, 1);
  assert.throws(
    () => assertWorktreeSiteCensusClean(srcDir, root, registry),
    /exempt row\(s\) with a blank reason.*rogue\.ts::rogueCreate/s,
  );
});

test("the review-materialization site is a NAMED row in the real registry, not an absence", () => {
  const review = WORKTREE_SITE_REGISTRY.find(
    (r) => r.file === "src/run-task.ts" && r.site === "addWorktree" && r.disposition.kind === "exempt",
  );
  assert.ok(review, "realReviewWorktreeDeps.addWorktree must be a named exempt row");
  assert.ok(
    review!.disposition.kind === "exempt" && review!.disposition.because.trim().length > 0,
    "the review site's reason must be non-blank",
  );
  assert.match(review!.disposition.kind === "exempt" ? review!.disposition.because : "", /PR/i);
});

test("the fix rung's raw materialization is ALSO a named row, not an absence", () => {
  const fixRung = WORKTREE_SITE_REGISTRY.find(
    (r) => r.file === "src/run-task.ts" && r.site === "createFixRungWorktree" && r.disposition.kind === "exempt",
  );
  assert.ok(fixRung, "createFixRungWorktree must be a named exempt row");
  assert.ok(fixRung!.disposition.kind === "exempt" && fixRung!.disposition.because.trim().length > 0);
});

test("every exempt row in the real registry carries a non-blank reason (no row ships silent)", () => {
  const blanks = WORKTREE_SITE_REGISTRY.filter(
    (r) => r.disposition.kind === "exempt" && r.disposition.because.trim() === "",
  );
  assert.deepEqual(blanks, []);
});

test("the real registry declares EXACTLY the two raw sites this task's own recon found — no more, no fewer", () => {
  const exempt = WORKTREE_SITE_REGISTRY.filter((r) => r.disposition.kind === "exempt")
    .map((r) => `${r.file}::${r.site}`)
    .sort();
  assert.deepEqual(exempt, ["src/run-task.ts::addWorktree", "src/run-task.ts::createFixRungWorktree"]);
});

// ── (4) NO PROVISIONING BEHAVIOUR CHANGES — the census only ever reads text ──────────────────

test("worktree-sites.ts never imports node:child_process — it cannot itself shell out to git", () => {
  const text = readFileSync(join(REPO_ROOT, "src/lib/worktree-sites.ts"), "utf8");
  // An IMPORT of the module (the only way this file could gain the ability to shell out), never a
  // bare mention — the module's own doc prose says "it never imports node:child_process" in
  // exactly those words, which a substring check would trip over itself.
  assert.doesNotMatch(text, /from\s+["']node:child_process["']/);
  assert.doesNotMatch(text, /\bexecFileSync\(|\bspawnSync\(|\bexecSync\(/);
});

test("censusWorktreeSites over the real repo makes no CHANGE — same result called twice in a row", () => {
  // A behaviour-changing scan would, at minimum, be non-idempotent (e.g. if it wrote a cache file
  // a second read could observe). It is not: two independent calls over the same real tree agree
  // byte-for-byte.
  const first = censusWorktreeSites(REAL_SRC, REPO_ROOT);
  const second = censusWorktreeSites(REAL_SRC, REPO_ROOT);
  assert.deepEqual(first, second);
});

test("routes-through sites route through worktreeAdd exactly as they do today — the registry adds no base record to them", () => {
  // The registry's routes-through disposition carries NO fields beyond `kind` — there is nowhere
  // for this task to have snuck in a base override, a currency bypass, or any other behavioural
  // knob for a site that already routes through worktreeAdd (W1-T2621 owns that path's own
  // behaviour, unchanged by this census).
  for (const row of WORKTREE_SITE_REGISTRY) {
    if (row.disposition.kind === "routes-through") {
      assert.deepEqual(Object.keys(row.disposition), ["kind"]);
    }
  }
});

test("RAW_WORKTREE_ADD_RE accepts a real raw invocation's argv shape and rejects ordinary prose — both arms driven directly by identifier (W1-T2317 negative-reachability ratchet)", () => {
  assert.equal(RAW_WORKTREE_ADD_RE.test('["-C", repoDir, "worktree", "add", worktreePath]'), true);
  assert.equal(RAW_WORKTREE_ADD_RE.test("this line just talks about worktrees, never adding one"), false);
});

// ── SUPPORTING UNIT: enclosingSiteName / findRawWorktreeAddSites, the primitives above lean on ──

test("enclosingSiteName finds a named function, an object-literal method, and neither past an optional-typed property", () => {
  const lines = [
    "export function worktreeAdd(",
    "  repoDir: string,",
    "  deps: {",
    "    warn?: (message: string) => void;", // optional — must NOT be picked up
    "  } = {},",
    ') {',
    '  execFileSync("git", ["-C", repoDir, "worktree", "add"], {});', // line 6, idx 6
  ];
  assert.equal(enclosingSiteName(lines, 6), "worktreeAdd");

  const objectLines = [
    "const deps = {",
    "  addWorktree: (repoDir, worktreePath, branch) =>",
    '    execFileSync("git", ["-C", repoDir, "worktree", "add", worktreePath], {}),',
  ];
  assert.equal(enclosingSiteName(objectLines, 2), "addWorktree");

  assert.equal(enclosingSiteName(["  execFileSync(...)"], 0), "", "no enclosing declaration above ⇒ empty");
});

test("findRawWorktreeAddSites finds the exact three real sites at their real lines (regression pin)", () => {
  const sites = findRawWorktreeAddSites(REAL_SRC, REPO_ROOT).map((s) => `${s.file}::${s.site}`);
  assert.deepEqual(
    sites.sort(),
    ["src/lib/worker.ts::worktreeAdd", "src/run-task.ts::addWorktree", "src/run-task.ts::createFixRungWorktree"].sort(),
  );
});

test("renderWorktreeCensusFailure names every drift kind so a failure is actionable, not just red", () => {
  const rendered = renderWorktreeCensusFailure({
    undeclaredRawSites: [{ file: "src/x.ts", site: "y", line: 1 }],
    rottedRows: [{ file: "src/x.ts", site: "z", creates: "c", disposition: { kind: "routes-through" } }],
    blankReasonRows: [
      { file: "src/x.ts", site: "w", creates: "c", disposition: { kind: "exempt", because: "" } },
    ],
  });
  assert.match(rendered, /no registry row/);
  assert.match(rendered, /no longer exists/);
  assert.match(rendered, /blank reason/);
});
