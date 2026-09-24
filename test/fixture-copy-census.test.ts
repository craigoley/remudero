/**
 * test/fixture-copy-census.test.ts — W1-T2903 acceptance: "the per-signature copy counts are
 * recorded and cannot grow."
 *
 * WHAT THIS WALKS. Audit recon-2026-09-05 R-41 counted five shapes of copy-pasted test fixture
 * across `test/*.test.ts` (non-recursive — the audit's own `git grep -- 'test/*.test.ts'` never
 * descended into `test/helpers/`, `test/setup/` or `test/fixtures/`, and neither does this): raw
 * `git init` call sites, distinct repo-builder function names, distinct fake-GitHub builder
 * names (and the files that declare one), files hand-writing a `gh` PATH shim, and distinct
 * ledger-helper names. `test/helpers/git-repo.ts`, `fake-github.ts`, `gh-shim.ts` and
 * `ledger-fixture.ts` (this same task) are the shared builders migrating a call site to lets it
 * drop out of these counts.
 *
 * This suite is a CENSUS: it walks the whole population and asserts a property of the whole
 * set — never a single file — which is exactly why `git grep <symbol>` cannot find whether it
 * still holds and why a regression here is the kind of failure that only reaches CI. The
 * property is `scripts/fixture-copy-baseline.json`: live <= baseline, for every signature,
 * always. A shrink (migrating more callers) silently passes and leaves the baseline as a stale,
 * looser ceiling — exactly like `scripts/source-size-baseline.json`'s own ratchet, this baseline
 * is a human, on-the-record edit (re-running this file never rewrites it), never tightened
 * automatically by a passing run.
 *
 * DEFINITIONS ARE THIS CENSUS'S OWN, not a re-run of the audit's original ad hoc `git grep`
 * one-liners — those were never committed as code, only as counts in the task's own rationale.
 * Each regex below is chosen to score highly against the population the audit described while
 * staying cheap and dependency-free (`node:fs` only, no `git grep` subprocess); the falsifier
 * tests further down pin exactly what each one does and does not count, so a future change to a
 * definition is a reviewable diff, not a silent redefinition of what "the same" means.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  FIXTURE_COPY_CENSUS_FILENAME,
  FIXTURE_COPY_SIGNATURES,
  countFixtureCopies as countFixtureCopiesFromRoot,
  fixtureCopyViolations,
  // @ts-ignore the executable .mjs module has no declaration file.
} from "../scripts/fixture-copy-census.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "fixture-copy-baseline.json");

/** The counter and its signatures live in scripts/fixture-copy-census.mjs, so hooks/pre-push can
 *  ask this census's question without starting a test runner; this suite pins what they count. */
export { FIXTURE_COPY_SIGNATURES };

export type FixtureCopySignature = (typeof FIXTURE_COPY_SIGNATURES)[number];
export type FixtureCopyCounts = Record<FixtureCopySignature, number>;

const countFixtureCopies = (root: string): FixtureCopyCounts => countFixtureCopiesFromRoot(root) as FixtureCopyCounts;

function readBaseline(): FixtureCopyCounts {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as FixtureCopyCounts;
}

const violations = (live: FixtureCopyCounts, baseline: FixtureCopyCounts): string[] => fixtureCopyViolations(live, baseline);

// ── acceptance: "the per-signature copy counts are recorded and cannot grow" ────────────────────

test("the REAL test/ population is at or under the recorded baseline, for every signature", () => {
  const live = countFixtureCopies(REPO_ROOT);
  const baseline = readBaseline();
  assert.deepEqual(violations(live, baseline), [], `fixture-copy census grew past its baseline:\n${JSON.stringify(live, null, 2)}`);
});

test("repo-builder detection: a Report builder is NOT a repo builder, and Repository still is", () => {
  const dir = fixtureTree({
    "a.test.ts": "function shardLintReport(x: string) { return x; }\nconst runReport = (x: string) => x;\n",
    "b.test.ts": "function buildRepositoryFixture() { return 1; }\nfunction cloneRepo() { return 2; }\n",
  });
  try {
    const live = countFixtureCopies(dir);
    // The NEGATIVE half is the one that regressed: without the lookahead this reads 4, not 2.
    assert.equal(live.repoBuilderFunctionNames, 2, "only the two genuine repo builders may count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the baseline carries EXACTLY the seven declared signatures — no key drift either direction", () => {
  const baseline = readBaseline();
  assert.deepEqual(Object.keys(baseline).sort(), [...FIXTURE_COPY_SIGNATURES].sort());
  for (const sig of FIXTURE_COPY_SIGNATURES) {
    assert.equal(typeof baseline[sig], "number");
    assert.ok(Number.isInteger(baseline[sig]) && baseline[sig] >= 0, `${sig} must be a non-negative integer`);
  }
});

test("the baseline is a POSITIVE control — every signature's recorded ceiling is > 0 (a suite this size has real copies of all five shapes today)", () => {
  const baseline = readBaseline();
  for (const sig of FIXTURE_COPY_SIGNATURES) {
    assert.ok(baseline[sig] > 0, `${sig} baseline is 0 — either genuinely fully migrated (update this test) or the scan found nothing by mistake`);
  }
});

// ── THE FALSIFIER: a synthetic tree proves violations() actually fires, and names the overage ──

function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-fixture-copy-census-"));
  mkdirSync(join(root, "test"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "test", name), content);
  }
  return root;
}

test("THE FALSIFIER: a synthetic file growing past a tight baseline is reported, naming the exact signature and overage", () => {
  const root = fixtureTree({
    "grown.test.ts": [
      'function fakeGithubOne(): GitHub { return {} as GitHub; }',
      'function fakeGithubTwo(): GitHub { return {} as GitHub; }',
      'execFileSync("git", ["init", "--quiet", "-C", dir]);',
    ].join("\n"),
  });
  try {
    const live = countFixtureCopies(root);
    assert.equal(live.fakeGithubBuilderNames, 2);
    assert.equal(live.gitInitSites, 1);
    const tightBaseline: FixtureCopyCounts = {
      gitInitSites: 0,
      gitInitFiles: 0,
      repoBuilderFunctionNames: 0,
      fakeGithubBuilderNames: 1, // one under the live count of 2 — the deliberate overage
      fakeGithubBuilderFiles: 0,
      ghPathShimFiles: 0,
      ledgerHelperNames: 0,
    };
    const found = violations(live, tightBaseline);
    assert.deepEqual(found, [
      "gitInitSites: 1 > baseline 0 (+1 over)",
      "gitInitFiles: 1 > baseline 0 (+1 over)",
      "fakeGithubBuilderNames: 2 > baseline 1 (+1 over)",
      "fakeGithubBuilderFiles: 1 > baseline 0 (+1 over)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synthetic file at EXACTLY its baseline reports no violations — the falsifier above was the GROWTH, not the fixture", () => {
  const root = fixtureTree({
    "steady.test.ts": 'function fakeGitHub(): GitHub { return {} as GitHub; }',
  });
  try {
    const live = countFixtureCopies(root);
    const baseline: FixtureCopyCounts = {
      gitInitSites: 0,
      gitInitFiles: 0,
      repoBuilderFunctionNames: 0,
      fakeGithubBuilderNames: 1,
      fakeGithubBuilderFiles: 1,
      ghPathShimFiles: 0,
      ledgerHelperNames: 0,
    };
    assert.deepEqual(violations(live, baseline), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countFixtureCopies excludes ONLY its own filename — a different file also named for testing purposes still counts", () => {
  const root = fixtureTree({
    [FIXTURE_COPY_CENSUS_FILENAME]: 'function fakeGithubExcluded(): GitHub { return {} as GitHub; }',
    "another.test.ts": 'function fakeGithubIncluded(): GitHub { return {} as GitHub; }',
  });
  try {
    const live = countFixtureCopies(root);
    assert.equal(live.fakeGithubBuilderNames, 1, "only another.test.ts's declaration counts");
    assert.equal(live.fakeGithubBuilderFiles, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("countFixtureCopies never descends into a subdirectory — test/helpers/*.ts (this census's own fixtures) is never counted", () => {
  const root = fixtureTree({ "top.test.ts": 'function fakeGitHub(): GitHub { return {} as GitHub; }' });
  mkdirSync(join(root, "test", "helpers"), { recursive: true });
  writeFileSync(
    join(root, "test", "helpers", "fake-github.ts"),
    'export function fakeGitHub(): GitHub { return {} as GitHub; }\nexport function anotherRepoBuilder() {}\n',
  );
  try {
    const live = countFixtureCopies(root);
    assert.equal(live.fakeGithubBuilderNames, 1, "only the top-level file's declaration counts");
    assert.equal(live.repoBuilderFunctionNames, 0, "the helper's Repo-named export must never be reached");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plain `const x = someOtherFn()` (not an arrow function) is NEVER counted as a builder — only function/arrow declarations are", () => {
  const root = fixtureTree({
    "notabuilder.test.ts": [
      'const ledgerPath = tmpLedgerPath(); // a call result, not a declared builder',
      'const ledgerDir = "/tmp/x"; // a string literal, not a builder',
    ].join("\n"),
  });
  try {
    const live = countFixtureCopies(root);
    assert.equal(live.ledgerHelperNames, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GIT_INIT_SITE_RE distinguishes a real git-wrapper call from unrelated prose containing the word \"init\" — both arms driven directly (W1-T2317 negative-reachability discipline)", () => {
  const root = fixtureTree({
    "mixed.test.ts": [
      'run(["init", "--quiet", "-b", "main"]); // a real site',
      'yield { type: "system", subtype: "init" }; // NOT a git call',
      '"emissions", "escalate", "init", "install-checkout"; // CLI help text, NOT a git call',
    ].join("\n"),
  });
  try {
    const live = countFixtureCopies(root);
    assert.equal(live.gitInitSites, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isGhPathShimFile requires BOTH a literal \"gh\" write/chmod AND a PATH mention — neither half alone is enough", () => {
  const root = fixtureTree({
    "writes-only.test.ts": 'writeFileSync(join(dir, "gh"), "#!/bin/sh\\n", { mode: 0o755 });',
    "path-only.test.ts": 'process.env.PATH = `${dir}:${process.env.PATH}`;',
    "both.test.ts": 'writeFileSync(join(dir, "gh"), "#!/bin/sh\\n", { mode: 0o755 });\nprocess.env.PATH = `${dir}:${old}`;',
  });
  try {
    const live = countFixtureCopies(root);
    assert.equal(live.ghPathShimFiles, 1, "only both.test.ts declares BOTH halves of the shim signature");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
