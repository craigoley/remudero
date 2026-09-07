import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { narrowNameFilteredArgs, parseWhitelistedProof } from "../src/lib/review.js";

// ── W1-T2292: COVERAGE-SESSION-BLANKING GUARD ────────────────────────────────────────────────
//
// THE DEFECT THIS PROVES A CHECK FOR (rationale §0-§1): `delete env.NODE_V8_COVERAGE` reads as an
// opt-out and is not one -- node's `child_process` force-injects the variable into every spawned
// child regardless of the `env` option, so a child spawned this way stays enrolled in the
// parent's coverage session. Its own function/line table then merges into the PARENT's lcov,
// keyed on the absolute path -- duplicate `FN:` records and split `DA:` hit counts on whichever
// source file both the parent's real tests and the enrolled child happen to import.
//
// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/coverage-session-blanking-check.mjs"` is a TS7016 -- the same reason
// test/tracked-source-write-guard.test.ts reaches its own sibling script through a runtime import
// rather than a typed one. A dynamic specifier is not statically resolved, so this loads the REAL
// module with no shadow copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "coverage-session-blanking-check.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  COVERAGE_VAR: string;
  NESTED_RUNNER_MARKER: string;
  BLIND_SPOTS: string;
  scanSource: (
    source: string,
    relPath: string,
  ) => {
    defects: Array<{ file: string; line: number; expr: string }>;
    suspects: Array<{ file: string; line: number; ident: string }>;
  };
  scanRepo: (repoRoot: string) => {
    defects: Array<{ file: string; line: number; expr: string }>;
    suspects: Array<{ file: string; line: number; ident: string }>;
    filesScanned: number;
  };
  listTrackedTestFiles: (repoRoot: string) => string[];
  main: (opts?: {
    repoRoot?: string;
    scan?: (repoRoot: string) => { defects: unknown[]; suspects: unknown[]; filesScanned: number };
    log?: (s: string) => void;
    error?: (s: string) => void;
  }) => number;
};
const { scanSource, scanRepo, listTrackedTestFiles, main, BLIND_SPOTS } = mod;

/** A fresh git repo with a `test/` tree that can be `git add`ed -- `listTrackedTestFiles`/
 *  `scanRepo` and `main`'s default `scan` collaborator all shell out to `git ls-files`, so the
 *  fixture must be a REAL repo, same discipline as test/tracked-source-write-guard.test.ts's own
 *  `mkFixtureRepo`. */
function mkFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-session-blanking-fixture-"));
  execFileSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  return root;
}

function gitAdd(root: string) {
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
}

// ── claim: "a delete of the coverage variable from a child env is reported as a defect wherever
// it appears" ────────────────────────────────────────────────────────────────────────────────

test("delete childEnv.NODE_V8_COVERAGE is reported as a defect, named with file/line/expr", () => {
  const source = ['const childEnv = { ...process.env };', "delete childEnv.NODE_V8_COVERAGE;"].join("\n");
  const { defects, suspects } = scanSource(source, "test/fixture.test.ts");
  assert.equal(defects.length, 1);
  assert.equal(defects[0].file, "test/fixture.test.ts");
  assert.equal(defects[0].line, 2, "the LINE of the delete, not the declaration");
  assert.equal(defects[0].expr, "childEnv");
  assert.deepEqual(suspects, [], "no NODE_TEST_CONTEXT strip here, so no suspicion finding");
});

test("delete is flagged for ANY identifier and ANY member-chain shape, not just the literal `childEnv` name", () => {
  const source = [
    'const env = { ...process.env };',
    "delete env.NODE_V8_COVERAGE;",
    "delete process.env.NODE_V8_COVERAGE;",
    'const opts = { env: { ...process.env } };',
    "delete opts.env.NODE_V8_COVERAGE;",
  ].join("\n");
  const { defects } = scanSource(source, "test/fixture.test.ts");
  assert.deepEqual(
    defects.map((d) => ({ line: d.line, expr: d.expr })),
    [
      { line: 2, expr: "env" },
      { line: 3, expr: "process.env" },
      { line: 5, expr: "opts.env" },
    ],
    "every delete-is-noop shape must be named, wherever in the file it appears",
  );
});

test("a delete of the coverage variable inside a `//` comment is never mistaken for real code", () => {
  const source = [
    "// note for whoever takes it: `delete env.NODE_V8_COVERAGE` IS A NO-OP -- node re-injects it",
    'export const nothing = 1;',
  ].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

test("a delete of the coverage variable inside a STRING (a child-process script argument) is never mistaken for real code", () => {
  const source = [
    'import { spawnSync } from "node:child_process";',
    "",
    'spawnSync(process.execPath, ["-e", "delete process.env.NODE_V8_COVERAGE"]);',
  ].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

// ── claim: "the falsifier holds against a real file: test/base-blob-read-failure.test.ts is
// named while its delete stands" ─────────────────────────────────────────────────────────────
//
// W1-T2732 UPDATE: this task's own remit -- unlike W1-T2292's, which deliberately stopped at
// naming callers -- is to actually clear the population this scan reports, so it does not
// "deliberately not fix callers" the way the comment above once read. `defects`/`suspects` no
// longer have a real, live example to pin a line/expr to once the corpus is clean; the
// end-to-end `git ls-files` integration path this test exercises is still proven for real by
// "main() prints the blind-spots statement AFTER naming a violation" below, which drives the
// identical scanRepo()-via-git-ls-files path against a synthetic fixture repo carrying a planted
// violation. This test's own job narrows to proving the REAL, live corpus is clean end to end.
test("the REAL repo, scanned end to end via git ls-files, is clean of both defect shapes (W1-T2732 cleared the corpus)", () => {
  const { defects, suspects, filesScanned } = scanRepo(REPO_ROOT);
  assert.ok(filesScanned > 700, `sanity: the scan must actually have read a real corpus (got ${filesScanned})`);
  assert.deepEqual(defects, [], "W1-T2732 converted every delete-is-noop site to real blanking");
  assert.deepEqual(suspects, [], "W1-T2732 blanked every unblanked NODE_TEST_CONTEXT-strip finding");
});

// ── claim: "blanking by explicit undefined and by empty string are both accepted, and neither is
// reported" ──────────────────────────────────────────────────────────────────────────────────

test("env.NODE_V8_COVERAGE = undefined, alongside a NODE_TEST_CONTEXT strip, is accepted -- not reported", () => {
  const source = [
    'const env = { ...process.env };',
    "delete env.NODE_TEST_CONTEXT;",
    "env.NODE_V8_COVERAGE = undefined;",
  ].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

test('env.NODE_V8_COVERAGE = "", alongside a NODE_TEST_CONTEXT strip, is accepted -- not reported', () => {
  const source = ['const env = { ...process.env };', "delete env.NODE_TEST_CONTEXT;", 'env.NODE_V8_COVERAGE = "";'].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

test("an inline object-literal NODE_V8_COVERAGE: undefined property, declared alongside the spread, is accepted too", () => {
  const source = ['const env = { ...process.env, NODE_V8_COVERAGE: undefined };', "delete env.NODE_TEST_CONTEXT;"].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

test('an inline object-literal NODE_V8_COVERAGE: "" property is accepted too -- no preference between the two forms', () => {
  const source = ['const env = { ...process.env, NODE_V8_COVERAGE: "" };', "delete env.NODE_TEST_CONTEXT;"].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

// ── claim: "a child env that drops the nested runner marker without blanking the coverage
// session is reported by file" ───────────────────────────────────────────────────────────────

test("a childEnv that strips NODE_TEST_CONTEXT without blanking NODE_V8_COVERAGE is reported, named with file/line/ident", () => {
  const source = ['const childEnv = { ...process.env };', "delete childEnv.NODE_TEST_CONTEXT;"].join("\n");
  const { defects, suspects } = scanSource(source, "test/fixture.test.ts");
  assert.deepEqual(defects, [], "no `delete ...NODE_V8_COVERAGE` here -- this is a suspicion, not a defect");
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].file, "test/fixture.test.ts");
  assert.equal(suspects[0].line, 2);
  assert.equal(suspects[0].ident, "childEnv");
});

test("two envs in one file: the properly-blanked one is silent, the unblanked one is still named -- scoped per identifier", () => {
  const source = [
    'const goodEnv = { ...process.env };',
    "delete goodEnv.NODE_TEST_CONTEXT;",
    "goodEnv.NODE_V8_COVERAGE = undefined;",
    "",
    'const badEnv = { ...process.env };',
    "delete badEnv.NODE_TEST_CONTEXT;",
  ].join("\n");
  const { defects, suspects } = scanSource(source, "test/fixture.test.ts");
  assert.deepEqual(defects, []);
  assert.equal(suspects.length, 1, "only the identifier that never blanked its own NODE_V8_COVERAGE is flagged");
  assert.equal(suspects[0].ident, "badEnv");
});

test("an env declaration whose object literal never closes (unbalanced `{`) is not mistaken for a blanked identifier", () => {
  // Exercises matchBraceClose's own unbalanced-brace return (-1): a truncated/malformed object
  // literal must not be treated as "found and inspected the body for NODE_V8_COVERAGE" -- the
  // declaration is skipped, so the identifier is never added to `blanked`, and a NODE_TEST_CONTEXT
  // strip against that same identifier is still reported as a suspicion, not silently cleared.
  const source = ["const env = { ...process.env,", "delete env.NODE_TEST_CONTEXT;"].join("\n");
  const { defects, suspects } = scanSource(source, "test/fixture.test.ts");
  assert.deepEqual(defects, []);
  assert.equal(suspects.length, 1, "the unclosed declaration must not count as a blanking of NODE_V8_COVERAGE");
  assert.equal(suspects[0].ident, "env");
  assert.equal(suspects[0].line, 2);
});

test("delete process.env.NODE_TEST_CONTEXT -- mutating the REAL process environment, not a child env object -- is NOT reported", () => {
  // test/check-proof-executor-parity.test.ts does exactly this: `delete process.env.NODE_TEST_CONTEXT`
  // around a call whose spawn inherits `process.env` BY DESIGN (never a copy), restoring it in a
  // `finally`. That is a different hazard in a different shape (rationale distinguishes "ten test
  // files do the first ... NONE does the second" from this file, which is not a "child env object"
  // at all) -- this check does not adjudicate it, and must not false-positive on it either.
  const source = ["delete process.env.NODE_TEST_CONTEXT;"].join("\n");
  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), { defects: [], suspects: [] });
});

// ── claim: "the check states its own blind spots in its output so a clean run is never read as a
// clearance" AND "a spawn with no env option is named as unreachable by the scan rather than
// silently passed" ───────────────────────────────────────────────────────────────────────────

test("BLIND_SPOTS names the no-env-option spawn as unreachable by this scan, not silently passed", () => {
  assert.match(BLIND_SPOTS, /Unreachable by this scan/);
  assert.match(BLIND_SPOTS, /a spawn with NO `env` option/);
  assert.match(BLIND_SPOTS, /inherits the parent's/);
  assert.match(BLIND_SPOTS, /never proves ABSENCE/);
});

test("main() prints the blind-spots statement on a CLEAN run, not only on a violation", () => {
  const root = mkFixtureRepo();
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "clean.test.ts"), 'export const nothing = 1;\n');
    gitAdd(root);

    const logged: string[] = [];
    const code = main({ repoRoot: root, log: (s: string) => logged.push(s), error: () => assert.fail("must not log to error on a clean scan") });
    assert.equal(code, 0);
    const out = logged.join("\n");
    assert.match(out, /coverage-session-blanking-check: clean/);
    assert.match(out, /Unreachable by this scan/, "a clean run must still carry the blind-spot statement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main() prints the blind-spots statement AFTER naming a violation", () => {
  const root = mkFixtureRepo();
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "test", "offender.test.ts"),
      ['const childEnv = { ...process.env };', "delete childEnv.NODE_V8_COVERAGE;"].join("\n"),
    );
    gitAdd(root);

    const errored: string[] = [];
    const code = main({ repoRoot: root, log: () => assert.fail("must not log the clean message on a violation"), error: (s: string) => errored.push(s) });
    assert.equal(code, 1);
    const out = errored.join("\n");
    assert.match(out, /coverage-session-blanking-check: FAILED/);
    assert.match(out, /test\/offender\.test\.ts:2: delete childEnv\.NODE_V8_COVERAGE/);
    assert.match(out, /Unreachable by this scan/, "the blind-spot statement must survive next to a real finding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// W1-T2732 UPDATE: the real repo now reads clean (see the "is clean of both defect shapes" test
// above) -- this task's whole point is wiring this CLI into CI as a gate, which requires the real
// tree to actually pass it. The CLI's own `main()` default `repoRoot` resolves from the SCRIPT's
// own path, not `cwd`, so a direct CLI spawn can only ever exercise the REAL repo, never a
// fixture; the FAILED/violation path is already covered for real, via git ls-files end to end,
// by "main() prints the blind-spots statement AFTER naming a violation" above (same scanRepo()
// path, driven in-process against a fixture repoRoot instead of a CLI spawn).
test("the CLI, run directly (no injected collaborators), exits 0 against the real repo now that W1-T2732 cleared it, and still prints blind spots", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /coverage-session-blanking-check: clean/);
  assert.match(result.stdout, /Unreachable by this scan/);
});

// ── claim: "no caller is edited by this task and no existing mutation detector changes
// behaviour" ──────────────────────────────────────────────────────────────────────────────────

test("this check script contains none of the mutating fs calls -- it cannot edit any caller it scans", () => {
  const src = readFileSync(SCRIPT, "utf8");
  for (const call of ["writeFileSync(", "appendFileSync(", "rmSync(", "unlinkSync(", "cpSync(", "renameSync("]) {
    assert.ok(!src.includes(call), `${SCRIPT} must never call ${call} -- naming a violation is the whole deliverable, not fixing one`);
  }
});

test("the real corpus's two named-in-the-task-note mutation-detector files are still tracked and are no longer suspects (W1-T2732 cleared them)", () => {
  // W1-T2292's own note pinned test/ledger-rotation.test.ts (W1-T964) and
  // test/dispatch-lifetime-breaker.test.ts (W1-T951) as two callers that DELIBERATELY stayed
  // unblanked, because that task's own scope fence forbade touching callers. W1-T2732 is the
  // successor whose whole remit is clearing exactly that population -- both files now blank
  // NODE_V8_COVERAGE alongside their existing NODE_TEST_CONTEXT strip (see each file's own
  // "W1-T2732" comment), and the mutation-detector tests below prove each file's OWN pinning
  // check still fires correctly after that edit.
  const { suspects, filesScanned } = scanRepo(REPO_ROOT);
  const files = suspects.map((s) => s.file);
  assert.ok(filesScanned > 700, `sanity: the scan must actually have read a real corpus (got ${filesScanned})`);
  assert.ok(!files.includes("test/ledger-rotation.test.ts"), "ledger-rotation.test.ts was cleared by W1-T2732");
  assert.ok(!files.includes("test/dispatch-lifetime-breaker.test.ts"), "dispatch-lifetime-breaker.test.ts was cleared by W1-T2732");
});

// Same discipline, same reason, as test/tracked-source-write-guard.test.ts's own MUTATION_DETECTORS
// loop: each of these two files carries a FILE-SHA-BRACKETED mutation check that removes a real
// production invariant on a SANDBOXED COPY, spawns a real `node --test` child narrowed to one
// positive test, and asserts that child FAILS. This task adds two files and edits nothing else, so
// both detectors must still catch their own mutation exactly as before -- driven for real here,
// not merely asserted from the diff.
const MUTATION_DETECTORS = [
  {
    file: "test/ledger-rotation.test.ts",
    name: "W1-T964: removing the pinning fails the idempotency test",
  },
  {
    file: "test/dispatch-lifetime-breaker.test.ts",
    name: "W1-T951: removing the durable credit lookup fails the positive test",
  },
];

for (const { file, name } of MUTATION_DETECTORS) {
  test(`the mutation detector in ${file} still fails its positive test when its pinning is removed (unaffected by this task)`, () => {
    const whitelisted = parseWhitelistedProof(`unit test: ${name}`);
    assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
    assert.ok(whitelisted!.nameFiltered);
    const args = narrowNameFilteredArgs(whitelisted!.args, [file]);

    // Same NODE_TEST_CONTEXT strip every mutation check in this repo applies -- see rationale §0:
    // `delete` is a no-op for NODE_V8_COVERAGE, but node's test runner treats NODE_TEST_CONTEXT's
    // mere PRESENCE (not its coverage side effects) as "this is a recursive run() call" and skips
    // the child outright, so stripping it here is the orthogonal, load-bearing fix this task does
    // not touch.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    // W1-T2732: this file's own scanner would flag the strip above as unblanked -- blank the
    // coverage var too, same remedy as every other tracked test file this task cleared.
    childEnv.NODE_V8_COVERAGE = undefined;
    const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: childEnv });
    assert.equal(
      result.status,
      0,
      `${file}'s own mutation-detector test must still PASS (i.e. its inner sandboxed mutation must still ` +
        `FAIL the positive test it targets), unaffected by this task\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
}

// ── claim: "the reader side reconciliation is left alone, so the blocking gate keeps refusing
// lines with no evidence" ────────────────────────────────────────────────────────────────────

test("scripts/diff-coverage.mjs still exits nonzero on a blocking finding -- untouched by this task", () => {
  const diffCoverageSrc = readFileSync(join(REPO_ROOT, "scripts", "diff-coverage.mjs"), "utf8");
  assert.match(
    diffCoverageSrc,
    /blocking\.length > 0/,
    "the reader-side gate must still branch on a nonempty blocking set -- this task does not touch it",
  );
  assert.match(diffCoverageSrc, /process\.exitCode = 1/, "and it must still refuse (nonzero exit) when that set is nonempty");
});

test("this task's own new check script never imports or invokes the reader-side gate -- the reader side is genuinely untouched, not silently rewired", () => {
  // The module doc mentions `diff-coverage` BY NAME, in prose, describing the symptom this check
  // exists alongside (rationale §1) -- so the bar is not "the string never appears" but "no
  // import/require/spawn actually reaches it".
  const scriptSrc = readFileSync(SCRIPT, "utf8");
  assert.ok(!/\bimport\b[^\n]*diff-coverage/.test(scriptSrc), "must not import scripts/diff-coverage.mjs");
  assert.ok(!/\brequire\s*\(\s*["'][^"']*diff-coverage/.test(scriptSrc), "must not require() scripts/diff-coverage.mjs");
  assert.ok(!/diff-coverage\.mjs/.test(scriptSrc), "must not name diff-coverage.mjs as a spawn target either");
});

// ── claim (defence-in-depth, rationale §2): "the check makes no claim it cannot back" ───────────

test("listTrackedTestFiles reads via `git ls-files`, not a raw directory walk -- an untracked scratch file is never scanned", () => {
  const files = listTrackedTestFiles(REPO_ROOT);
  assert.ok(files.length > 700);
  for (const f of files) {
    assert.ok(f.startsWith("test/"), `every listed file must be under test/: ${f}`);
    assert.ok(f.endsWith(".ts"), `every listed file must be a .ts file: ${f}`);
  }
});

test("listTrackedTestFiles throws, naming the repo root, when `git ls-files` fails (not a git repository at all)", () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-session-blanking-not-a-repo-"));
  try {
    assert.throws(() => listTrackedTestFiles(root), /coverage-session-blanking-check: `git ls-files` failed in/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
