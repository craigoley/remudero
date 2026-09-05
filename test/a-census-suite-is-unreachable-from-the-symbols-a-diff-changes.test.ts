import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "diff-class.mjs");

/**
 * test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts — W1-T2680.
 *
 * A census suite asserts the SIZE or SHAPE of a population — every policy reader, every source
 * file's line count, every `_RE` validator. It therefore NAMES NONE of the symbols any particular
 * diff touches, and `git grep -l <symbol>` — the caller sweep CLAUDE.md prescribes — cannot reach
 * it BY CONSTRUCTION. Measured twice on 2026-09-01: #3569's sweep ran 153 suites and 2738/2738
 * green while config-reader-seams stayed red; #3583's ran 44 suites and 1099/1099 green while
 * mounts-wiring stayed red. CI found both; the local discipline could not.
 *
 * The hazard is already written down, and being written down did not prevent the recurrence. That
 * is the point: a hazard an agent must REMEMBER is not a mechanism. This verb is the mechanism.
 */

// `scripts/**` sits outside tsconfig's `include`, so a runtime import — the same route
// test/fast-lane-classifier.test.ts takes to the same file, leaving no shadow copy to drift.
const {
  censusSuiteFiles,
  changedAreas,
  enumeratesPopulation,
  sourceTextPathsRead,
  withoutRelativePathLiterals,
} = (await import(pathToFileURL(SCRIPT).href)) as {
  censusSuiteFiles: (changed: readonly string[] | undefined, root?: string) => string[];
  changedAreas: (files: readonly string[] | undefined) => Set<string>;
  enumeratesPopulation: (content: string) => boolean;
  sourceTextPathsRead: (content: string) => Set<string>;
  withoutRelativePathLiterals: (content: string) => string;
};

// ── criterion 1: enumerated from the tree, never a registry ───────────────────────────────────

test("W1-T2680 (acceptance 1): the verb lists census suites for a changed-file set, enumerated from the TREE", () => {
  const listed = censusSuiteFiles(["src/lib/policy.ts"], REPO_ROOT);
  assert.ok(listed.length > 0, "a src/lib change must reach at least one census");
  for (const p of listed) assert.match(p, /^test\/.+\.test\.ts$/, "repo-relative test paths, POSIX separators");
  assert.deepEqual([...listed].sort(), listed, "sorted, so a caller diffing two runs sees real change");
  // CONTROL against the vacuous direction: it must not simply be every suite in the directory.
  const everySuite = execFileSync("git", ["ls-files", "test/*.test.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean).length;
  assert.ok(everySuite > 900, `control: the repo really does have a large test dir (${everySuite})`);
  assert.ok(listed.length < everySuite / 3, `handing back ${listed.length} of ${everySuite} would be the whole directory, which is the same as no answer`);
});

test("W1-T2680: the source holds NO hardcoded suite list — a census added tomorrow is found tomorrow", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const added = src.slice(src.indexOf("W1-T2680"));
  assert.doesNotMatch(added, /["'`]test\/[a-z0-9-]+\.test\.ts["'`]/, "no suite path is named in the implementation");
  assert.match(added, /readdirSync\(testDir/, "it walks the test directory at run time");
});

// ── criterion 2: the two suites that caught real regressions ──────────────────────────────────

test("W1-T2680 (acceptance 2): config-reader-seams and mounts-wiring are BOTH listed, replayed over the REAL diffs that caught them", () => {
  // The exact changed-file sets of the two PRs the task's rationale measures, read from GitHub.
  // Using the real diffs rather than a synthetic set is what makes this evidence: #3583's carried
  // `src/run-task.ts`, which is WHY mounts-wiring — a source-shape ratchet that reads that file's
  // text and enumerates nothing — is reachable at all.
  const pr3569 = ["plan/policy.yaml", "src/lib/policy.ts", "src/lib/review.ts", "test/arm-calibration-bands.test.ts"];
  const pr3583 = ["scripts/source-size-baseline.json", "src/lib/review.ts", "src/run-task.ts"];

  assert.ok(
    censusSuiteFiles(pr3569, REPO_ROOT).includes("test/config-reader-seams.test.ts"),
    "#3569's own diff must reach the census it reddened — the sweep ran 153 suites and never did",
  );
  assert.ok(
    censusSuiteFiles(pr3583, REPO_ROOT).includes("test/mounts-wiring.test.ts"),
    "#3583's own diff must reach the ratchet it reddened — the sweep ran 44 suites and never did",
  );
});

test("W1-T2680: the three suites that went red in CI on 2026-09-05, after a caller sweep ran green over 45 files", () => {
  // This verb was built the day after its own filing was vindicated three more times. Each of
  // these was found by CI, never by the prescribed sweep.
  assert.ok(
    censusSuiteFiles(["src/lib/untrusted-envelope.ts"], REPO_ROOT).includes("test/negative-reachability-ratchet.test.ts"),
    "a NEW src/lib file joins the `_RE` validator census (PR #4072)",
  );
  const serveChange = censusSuiteFiles(["src/lib/serve.ts"], REPO_ROOT);
  assert.ok(
    serveChange.includes("test/console-stopped-counts.test.ts"),
    "console-stopped-counts reads serve.ts's SOURCE TEXT and went red on it (PR #4073)",
  );
  // decision-summary.test.ts went red for the SAME reason in the same PR, and is deliberately NOT
  // asserted here: its repair replaced the `readFileSync(serve.ts)` with an assertion on the real
  // function object, so it no longer carries the shape at all. Pinning it would be pinning history
  // rather than the tree — and this suite found that itself, by failing when the repair landed.
  //
  // The CLASS is what matters and it is very much alive: every suite that still reads serve.ts as
  // text is reachable only this way. Asserted as a population so the claim cannot quietly decay to
  // one lucky file.
  const stillReadServe = ["test/codex-model-console.test.ts", "test/console-token-refresh.test.ts", "test/provider-routing-console.test.ts"];
  for (const suite of stillReadServe) {
    assert.ok(serveChange.includes(suite), `${suite} reads serve.ts as text and no symbol sweep can reach it`);
  }
});

// ── criterion 3: not the whole directory ──────────────────────────────────────────────────────

test("W1-T2680 (acceptance 3): an ordinary suite that merely IMPORTS a changed module is NOT listed", () => {
  // sweep.test.ts imports from src/lib/sweep.ts and is fully reachable by `git grep -l` — listing
  // it would be redundant at best. It is also the sharpest control available: it carries
  // `"src/config.ts"` and `"src/lib/widget.ts"` as FIXTURE DATA, so a naive "any path literal in a
  // file that mentions readFileSync" rule DID list it (measured, before arm (b) was scoped to the
  // call). A path in a fixture is an argument to the code under test; a path in `readFileSync` is
  // a dependency on the tree.
  for (const changed of [["src/lib/sweep.ts"], ["src/lib/policy.ts", "src/lib/review.ts"], ["src/lib/config.ts"]]) {
    assert.ok(!censusSuiteFiles(changed, REPO_ROOT).includes("test/sweep.test.ts"), `sweep.test.ts must not be listed for ${changed.join(",")}`);
  }
  assert.equal(enumeratesPopulation(readFileSync(join(REPO_ROOT, "test", "sweep.test.ts"), "utf8")), false, "and it genuinely enumerates nothing");
});

test("W1-T2680: shelling git is not enough — a fixture repo is not a census", () => {
  // test/serve.test.ts runs `git init`/`config`/`add`/`commit` against a per-test tmpdir. That is
  // the hardest false positive in this verb: it looks exactly like a repo-wide scan to any rule
  // keyed on `execFileSync("git")`. What separates a census is enumeration OF THE TREE.
  assert.equal(enumeratesPopulation('execFileSync("git", ["init", "--quiet"], { cwd: root })'), false);
  assert.equal(enumeratesPopulation('execFileSync("git", ["ls-files", "src/*.ts"])'), true, "ls-files IS enumeration");
  assert.equal(enumeratesPopulation("readdirSync(testDir)"), true);
  assert.equal(enumeratesPopulation("const x = 1;"), false);
});

// ── criterion 4: a census added to the tree is found with no registry edit ────────────────────

test("W1-T2680 (acceptance 4): a census suite ADDED to the tree is found, with no registry to edit", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-verb-`));
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    const ordinary = 'import { thing } from "../src/lib/thing.js";\ntest("x", () => thing());\n';
    writeFileSync(join(root, "test", "ordinary.test.ts"), ordinary);
    assert.deepEqual(censusSuiteFiles(["src/lib/thing.ts"], root), [], "BEFORE: nothing in this tree walks a population");

    // A census arrives. No list is edited anywhere.
    writeFileSync(
      join(root, "test", "brand-new-census.test.ts"),
      'import { readdirSync } from "node:fs";\nconst files = readdirSync(join(REPO_ROOT, "src/lib/"));\ntest("population", () => files.length);\n',
    );
    assert.deepEqual(
      censusSuiteFiles(["src/lib/thing.ts"], root),
      ["test/brand-new-census.test.ts"],
      "AFTER: found by the run that adds it — and the ordinary suite beside it still is not",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── criterion 5: an empty set is an empty answer ──────────────────────────────────────────────

test("W1-T2680 (acceptance 5): an empty changed-file set yields an EMPTY list, never every suite", () => {
  assert.deepEqual(censusSuiteFiles([], REPO_ROOT), []);
  assert.deepEqual(censusSuiteFiles(undefined, REPO_ROOT), []);
  assert.deepEqual(censusSuiteFiles(["", ""], REPO_ROOT), [], "and blank entries are not areas");
  assert.deepEqual([...changedAreas([])], []);
  // NOT the same fail-closed direction as classify(): this verb ADDS suites to a run, so an empty
  // answer costs a caller nothing, while "every suite" would be no answer at all.
});

// ── the predicates, both directions ───────────────────────────────────────────────────────────

test("W1-T2680: changedAreas names the directory AND its immediate subdirectory, and nothing for a root file", () => {
  assert.deepEqual([...changedAreas(["src/lib/x.ts"])].sort(), ["src/", "src/lib/"]);
  assert.deepEqual([...changedAreas(["src/run-task.ts"])], ["src/"]);
  assert.deepEqual([...changedAreas(["README.md"])], [], "a repo-root file belongs to no area");
});

test("W1-T2680: an area named only in an IMPORT or a COMMENT is not a population", () => {
  const stripped = withoutRelativePathLiterals('import x from "../src/lib/a.js"; // see src/lib/b.ts\nconst d = "src/lib/";');
  assert.doesNotMatch(stripped, /\.\.\/src/, "the import path is gone");
  assert.ok(!/see src\/lib\/b\.ts/.test(stripped), "the comment is gone");
  assert.match(stripped, /"src\/lib\/"/, "the bare directory literal — the one that means something — survives");
  // Measured on the real tree, for a src/lib change: 128 suites raw, 82 after dropping relative
  // path literals, 46 after dropping comments too. Both halves earn their place.
});

test("W1-T2680: sourceTextPathsRead reads paths from the CALL, not from fixture data elsewhere in the file", () => {
  assert.deepEqual(
    [...sourceTextPathsRead('const s = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");')],
    ["src/run-task.ts"],
  );
  assert.deepEqual([...sourceTextPathsRead('const fixture = { path: "src/config.ts" }; readFileSync(somewhereElse);')], [], "a fixture path is an ARGUMENT to the code under test, not a dependency on the tree");
  assert.deepEqual([...sourceTextPathsRead('const p = "src/lib/x.ts";')], [], "no readFileSync at all reads nothing");
});

// ── the CLI, end to end ───────────────────────────────────────────────────────────────────────

test("W1-T2680: the CLI FAILS CLOSED — an unreadable tree prints NOTHING and exits 1, never an empty list a caller could read as 'no suites matter'", () => {
  // Driven through the CLI's TEST-ONLY `--plan-reading-root` flag, the same seam
  // test/fast-lane-classifier.test.ts uses to drive the sibling verb's catch block — pointed at a
  // directory that does not exist, so the enumeration genuinely throws. Without this the catch arm
  // is dead code, which is exactly what `diff-coverage` blocked this PR on.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-cli-fail-`));
  try {
    const list = join(dir, "changed.txt");
    writeFileSync(list, "src/lib/policy.ts\n");
    let status = 0;
    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--list-census-suites", "--changed-files", list, "--plan-reading-root", join(REPO_ROOT, "no-such-directory-at-all")],
        { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } as NodeJS.ProcessEnv },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 0;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    assert.equal(status, 1, "a nonzero exit is the whole signal — a caller must fail closed on it");
    assert.equal(stdout.trim(), "", "and NOTHING on stdout: an empty list beside exit 0 would read as 'no suites matter'");
    assert.match(stderr, /FAILED to enumerate the census suite set/);
    assert.match(stderr, /fail closed and run the full suite/, "the message says what the caller must do");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2680 (wiring): the CLI verb prints the list on stdout, one path per line", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}census-cli-`));
  try {
    const list = join(dir, "changed.txt");
    writeFileSync(list, "src/lib/policy.ts\nsrc/lib/review.ts\n");
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--list-census-suites", "--changed-files", list],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } as NodeJS.ProcessEnv },
    );
    const lines = out.split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "the verb answers");
    assert.ok(lines.includes("test/config-reader-seams.test.ts"), "including the census #3569 reddened");
    for (const l of lines) assert.match(l, /^test\/.+\.test\.ts$/, "stdout carries ONLY paths — nothing a caller must strip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
