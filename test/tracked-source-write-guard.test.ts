import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseWhitelistedProof, narrowNameFilteredArgs } from "../src/lib/review.js";

// ── W1-T2291: TRACKED-SOURCE-WRITE GUARD ─────────────────────────────────────────────────────
//
// THE PROPERTY (rationale (1)): a test whose correctness depends on the state of the workspace it
// SHARES with every other test in the run. `node --test` runs files concurrently across workers,
// so a tracked `src/` file rewritten by one test -- even one that restores it in a `finally` -- is
// observed, mid-window, by every other worker that transpiles, instruments or reads it. This suite
// proves scripts/tracked-source-write-check.mjs's `scanSource`/`scanRepo` ACTIVELY catch that
// shape (a planted fixture is named with file/line/call), correctly exempt the two shapes design
// note (i)/(ii) name as non-hazards (a temp-rooted target; a `cpSync` whose SOURCE is tracked but
// DESTINATION is a temp root), read clean across the real tracked corpus now that both real
// offenders are isolated, and that the two mutation detectors this task touched still fail their
// inner positive test when their pinning is removed -- exactly the shape they had before isolation,
// unaffected by WHERE the mutation now lands.
//
// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/tracked-source-write-check.mjs"` is a TS7016 -- the same reason
// test/acceptance-author-gate.test.ts/test/clock-sweep.test.ts reach their scripts through a
// runtime import rather than a typed one. A dynamic specifier is not statically resolved, so this
// loads the REAL module with no shadow copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "tracked-source-write-check.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  scanSource: (source: string, relPath: string) => Array<{ file: string; line: number; call: string; label: string; targetExpr: string }>;
  scanRepo: (repoRoot: string) => { violations: unknown[]; filesScanned: number };
  listTrackedTestFiles: (repoRoot: string) => string[];
  targetCandidates: (name: string, args: string[]) => Array<{ expr: string; label: string }>;
  main: (repoRoot?: string) => void;
};
const { scanSource, scanRepo, listTrackedTestFiles, targetCandidates, main } = mod;

// ── claim: "a test writing a tracked file under src is named by the scan with its file and call
// site" ───────────────────────────────────────────────────────────────────────────────────────

test("a writeFileSync target resolving under the tracked src/ tree is named with its file, line and call", () => {
  const source = [
    'import { writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
    'const statusTsPath = join(repoRoot, "src", "lib", "status.ts");',
    "",
    "writeFileSync(statusTsPath, mutated);",
  ].join("\n");

  const violations = scanSource(source, "test/fixture.test.ts");
  assert.equal(violations.length, 1, "exactly one violation for the one mutating call");
  assert.equal(violations[0].file, "test/fixture.test.ts");
  assert.equal(violations[0].line, 8, "the LINE of the call, not the declaration");
  assert.equal(violations[0].call, "writeFileSync");
  assert.equal(violations[0].targetExpr, "statusTsPath");
});

test("an inline join(repoRoot, \"src\", ...) target, never bound to a variable, is caught the same way", () => {
  const source = [
    'import { rmSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
    'rmSync(join(repoRoot, "src", "lib", "scratch.ts"));',
  ].join("\n");

  const violations = scanSource(source, "test/fixture.test.ts");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].call, "rmSync");
  assert.match(violations[0].targetExpr, /^join\(repoRoot, "src", "lib", "scratch\.ts"\)$/);
});

test("renameSync flags EITHER end that resolves under tracked src/ -- the old path is deleted, the new one created", () => {
  const source = [
    'import { renameSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
    'renameSync(join(repoRoot, "src", "lib", "a.ts"), join(repoRoot, "src", "lib", "b.ts"));',
  ].join("\n");

  const violations = scanSource(source, "test/fixture.test.ts");
  assert.equal(violations.length, 2, "both the removed old path and the created new path are flagged");
  assert.deepEqual(
    violations.map((v) => v.label).sort(),
    ["newPath", "oldPath"],
  );
});

// ── claim: "a write whose target is a mkdtemp or tmpdir root is not flagged" ────────────────────

test("a writeFileSync target under an mkdtempSync-rooted directory is exempt", () => {
  const source = [
    'import { mkdtempSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    "",
    'const sandbox = mkdtempSync(join(tmpdir(), "guard-fixture-"));',
    'writeFileSync(join(sandbox, "src", "lib", "status.ts"), mutated);',
  ].join("\n");

  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), []);
});

test("a writeFileSync target built directly from tmpdir() (no mkdtemp) is exempt", () => {
  const source = [
    'import { writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    "",
    'writeFileSync(join(tmpdir(), "scratch", "src", "x.ts"), "data");',
  ].join("\n");

  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), []);
});

// ── claim: "a cpSync reading the tracked tree into a temp destination is not flagged" ───────────

test("cpSync(repoRoot/src -> mkdtemp sandbox) is exempt -- the SOURCE is tracked, the DESTINATION is not", () => {
  const source = [
    'import { cpSync, mkdtempSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
    'const sandbox = mkdtempSync(join(tmpdir(), "guard-fixture-"));',
    'cpSync(join(repoRoot, "src"), join(sandbox, "src"), { recursive: true });',
  ].join("\n");

  assert.deepEqual(
    scanSource(source, "test/fixture.test.ts"),
    [],
    "cpSync must resolve the DESTINATION argument specifically (design note (ii)), never the source",
  );
});

test("cpSync(repoRoot/src -> repoRoot/other-src) -- a destination that itself resolves under tracked src/ IS flagged", () => {
  const source = [
    'import { cpSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
    'cpSync(join(repoRoot, "src", "lib"), join(repoRoot, "src", "lib-copy"), { recursive: true });',
  ].join("\n");

  const violations = scanSource(source, "test/fixture.test.ts");
  assert.equal(violations.length, 1, "a cpSync whose DESTINATION also resolves under tracked src/ is a real hazard");
  assert.equal(violations[0].label, "destination");
});

// ── claim: "a `/* ... */` comment inside a call's argument list never desyncs the depth-matching
// bracket walk (matchClose) or the top-level argument split (splitTopLevelArgs) -- the call is
// still resolved and, when its target lands under tracked src/, still flagged" ─────────────────

test("a block comment inside the argument list is skipped by both the bracket matcher and the arg splitter, and the call is still flagged", () => {
  const source = [
    'import { writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
    'writeFileSync(join(repoRoot, "src", /* keep this comment */ "lib", "status.ts"), mutated);',
  ].join("\n");

  const violations = scanSource(source, "test/fixture.test.ts");
  assert.equal(violations.length, 1, "the block comment must not hide the violation nor break bracket matching");
  assert.equal(violations[0].call, "writeFileSync");
});

// ── claim: "a call whose parentheses never close (malformed/truncated source) is never mistaken
// for a resolvable call site -- the bracket matcher's unmatched fallback is reached, and the
// call is skipped, not crashed on" ───────────────────────────────────────────────────────────

test("a call with an unterminated argument list does not crash the scan and yields no violation", () => {
  const source = [
    'import { writeFileSync } from "node:fs";',
    "",
    "writeFileSync(unterminated",
  ].join("\n");

  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), []);
});

// ── claim: "a target argument that is a BARE string literal (never bound to a variable, never
// wrapped in `join(...)`) is classified the same way as any other resolvable expression: flagged
// when it starts with `src/`, left alone otherwise" ─────────────────────────────────────────────

test("a bare string literal target starting with src/ is flagged with no join(...) or binding involved", () => {
  const source = ['import { writeFileSync } from "node:fs";', "", 'writeFileSync("src/lib/direct.ts", mutated);'].join("\n");

  const violations = scanSource(source, "test/fixture.test.ts");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].targetExpr, '"src/lib/direct.ts"');
});

test("a bare string literal target NOT starting with src/ is left alone", () => {
  const source = ['import { writeFileSync } from "node:fs";', "", 'writeFileSync("test/fixtures/output.txt", data);'].join("\n");

  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), []);
});

// ── claim: "targetCandidates has no candidates -- and so nothing to flag -- for any call name
// outside the six MUTATING_CALLS names" ──────────────────────────────────────────────────────

test("targetCandidates returns no candidates for a call name the guard was never asked to police", () => {
  assert.deepEqual(targetCandidates("readFileSync", ["somePath"]), []);
});

// ── claim: "listTrackedTestFiles throws, rather than silently returning [], when `git ls-files`
// itself fails (e.g. repoRoot is not inside a git repository at all)" ───────────────────────────

test("listTrackedTestFiles throws when git ls-files fails, rather than returning an empty/misleading list", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "guard-not-a-repo-"));
  try {
    assert.throws(() => listTrackedTestFiles(notARepo), /tracked-source-write-check: `git ls-files` failed/);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

// ── claim: "main()'s own two branches -- clean/exit 0, and FAILED/exit 1 naming every offender --
// are driven IN-PROCESS, not by spawning a subprocess" (design (v)): `--experimental-test-coverage`
// instruments only the CURRENT process's V8 session; a subprocess spawned via `child_process` never
// reports back into it, however faithfully it reproduces the CLI's real exit code/output. `main`
// takes `repoRoot` as an explicit (defaulted) parameter for exactly this reason -- so a test can
// drive both of its branches directly, exactly like test/acceptance-author-gate.test.ts and
// test/credit-surface-gate.test.ts's own `withExitCode` shape for the analogous entry point in each.
// process.exitCode/console.log/console.error are saved and monkey-patched around each call so a
// real invocation never corrupts this suite's own process. A SEPARATE, un-mocked subprocess smoke
// test right after still spawns the real CLI once against the real checkout -- proof the entry
// guard (`import.meta.url === argv[1]`) and the default-parameter wiring both actually work end to
// end, not just that `main`'s body does when called directly. ─────────────────────────────────────

async function withExitCode(fn: () => void): Promise<{ exitCode: typeof process.exitCode; err: string[]; out: string[] }> {
  const priorExit = process.exitCode;
  const err: string[] = [];
  const out: string[] = [];
  const realErr = console.error;
  const realOut = console.log;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    fn();
    return { exitCode: process.exitCode, err, out };
  } finally {
    console.error = realErr;
    console.log = realOut;
    process.exitCode = priorExit;
  }
}

test("main(REPO_ROOT) exits 0 and logs the clean summary when the workspace has no violations", async () => {
  const r = await withExitCode(() => main(REPO_ROOT));
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.err, [], "a clean run reports nothing on stderr");
  assert.equal(r.out.length, 1);
  assert.match(r.out[0], /tracked-source-write-check: clean --/);
});

test("main(sandboxRepoRoot) exits 1 and names the file/line/call when a planted violation is present", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "guard-main-violation-"));
  try {
    spawnSync("git", ["-C", sandbox, "init", "--quiet"], { encoding: "utf8" });
    mkdirSync(join(sandbox, "test"), { recursive: true });
    writeFileSync(
      join(sandbox, "test", "planted-violation.test.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");',
        'writeFileSync(join(repoRoot, "src", "lib", "planted.ts"), "mutated");',
        "",
      ].join("\n"),
    );
    spawnSync("git", ["-C", sandbox, "add", "-A"], { encoding: "utf8" });

    const r = await withExitCode(() => main(sandbox));
    assert.equal(r.exitCode, 1);
    assert.deepEqual(r.out, [], "a FAILED run prints no clean summary");
    assert.ok(r.err.some((line) => /tracked-source-write-check: FAILED/.test(line)));
    assert.ok(r.err.some((line) => /test\/planted-violation\.test\.ts:6: writeFileSync/.test(line)));
    assert.ok(r.err.some((line) => /never the checked-out/.test(line)));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("spawning the real CLI directly against the real (clean) checkout also exits 0 -- proof the entry guard itself wires up, not only main()'s body", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /tracked-source-write-check: clean --/);
});

// ── claim: "the scan reports zero across the tracked test corpus once both offenders are
// isolated" ──────────────────────────────────────────────────────────────────────────────────

test("the REAL repo, scanned end to end via git ls-files, reports zero tracked-src writes today", () => {
  const { violations, filesScanned } = scanRepo(REPO_ROOT);
  assert.ok(filesScanned > 700, `sanity: the scan must actually have read a real corpus, not an empty/broken glob (got ${filesScanned})`);
  assert.deepEqual(
    violations,
    [],
    `test/dispatch-lifetime-breaker.test.ts and test/task-id-reservation.test.ts must both be isolated: ${JSON.stringify(violations)}`,
  );
});

test("listTrackedTestFiles reads via `git ls-files`, not a raw directory walk -- an untracked scratch file is never scanned", () => {
  // A raw fs walk of test/ would pick up test/setup/ too (not itself a *.test.ts population, but
  // proves nothing about this specific claim) -- the discriminating fact is that `git ls-files`
  // is a READ of the index, so a file that merely EXISTS on disk under test/ but was never
  // `git add`ed is invisible to it. Every file it does list must be a real `.ts` path under test/.
  const files = listTrackedTestFiles(REPO_ROOT);
  assert.ok(files.length > 700);
  for (const f of files) {
    assert.ok(f.startsWith("test/"), `every listed file must be under test/: ${f}`);
    assert.ok(f.endsWith(".ts"), `every listed file must be a .ts file: ${f}`);
  }
});

// ── claim: "the two mutation detectors still fail when their pinning is removed" ────────────────
//
// The two files this task isolates each carry a FILE-SHA-BRACKETED MUTATION CHECK (W1-T951 in
// dispatch-lifetime-breaker.test.ts, W1-T949 in task-id-reservation.test.ts) that removes a real
// production invariant on a SANDBOXED COPY, spawns a real `node --test` child narrowed to one
// positive test, and asserts that child FAILS. Isolating WHERE the mutation lands must never
// change WHETHER it is still detected (design note (iv), Q3) -- so this drives each detector for
// real, exactly as `remudero-review`'s own unit-test proof execution would, and requires the
// detector's own OUTER test to still pass (which is only possible if its inner mutated child still
// fails the way it always did).

const MUTATION_DETECTORS = [
  { file: "test/dispatch-lifetime-breaker.test.ts", name: "W1-T951: removing the durable credit lookup fails the positive test" },
  { file: "test/task-id-reservation.test.ts", name: "W1-T949: removing the per id reservation fails the N ref test" },
];

for (const { file, name } of MUTATION_DETECTORS) {
  test(`the mutation detector in ${file} still fails its positive test when its pinning is removed`, () => {
    const whitelisted = parseWhitelistedProof(`unit test: ${name}`);
    assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
    assert.ok(whitelisted!.nameFiltered);
    const args = narrowNameFilteredArgs(whitelisted!.args, [file]);

    // Same NODE_TEST_CONTEXT strip every mutation check in this repo applies -- inherited by
    // default, node's test runner treats its presence as a recursive `run()` call and SKIPS the
    // child entirely, exiting 0 having executed nothing (a silently-skipped child looks identical
    // to a clean pass, which is exactly the failure mode this strip exists to rule out).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: childEnv });
    assert.equal(
      result.status,
      0,
      `${file}'s own mutation-detector test must still PASS (i.e. its inner sandboxed mutation must still ` +
        `FAIL the positive test it targets) after isolation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
}

// ── claim: "the guard makes no claim about runtime-built paths, injected seams, or child-process
// writes" (design note (ii)) ─────────────────────────────────────────────────────────────────

test("a path assembled at RUNTIME (an env-var root) is invisible to the guard -- not a proof of absence", () => {
  const source = [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "",
    "// The root is read from an environment variable at RUNTIME -- nothing in this expression's",
    "// TEXT resolves to the repo-root idiom, so a static scan cannot tell this apart from any",
    "// other unresolvable path. This is the documented blind spot, not a bug: catching it would",
    "// require actually EXECUTING the test.",
    'const root = process.env.REPO_ROOT_OVERRIDE ?? "/nonexistent";',
    'writeFileSync(join(root, "src", "lib", "status.ts"), "data");',
  ].join("\n");

  assert.deepEqual(
    scanSource(source, "test/fixture.test.ts"),
    [],
    "a runtime-computed root must not be flagged -- the guard has no way to know where it resolves",
  );
});

test("a call name mentioned only inside a STRING (e.g. a child-process script argument) is never mistaken for a real call site", () => {
  // Simulates the shape design note (ii) names as invisible: "a CHILD PROCESS writing on the
  // test's behalf". The literal text `writeFileSync(...)` appears in this source only as DATA
  // handed to a spawned child (a `-e` script string) -- there is no real `writeFileSync(` call
  // in the test file's own code, so the scan must find nothing, exactly as it would if the write
  // actually happened out-of-process where this static scanner cannot see it at all.
  const source = [
    'import { spawnSync } from "node:child_process";',
    "",
    "spawnSync(process.execPath, [",
    '  "-e",',
    '  "require(\'node:fs\').writeFileSync(\'src/lib/status.ts\', \'mutated\')",',
    "]);",
  ].join("\n");

  assert.deepEqual(
    scanSource(source, "test/fixture.test.ts"),
    [],
    "a call name appearing only inside a string literal must never be treated as a real call site",
  );
});

test("a call name mentioned only inside a COMMENT is never mistaken for a real call site", () => {
  const source = [
    "// A comment documenting the OLD shape this file used to have:",
    '//   writeFileSync(join(repoRoot, "src", "lib", "status.ts"), mutated);',
    "// -- no longer true; see the isolation note above.",
    'export const nothing = 1;',
  ].join("\n");

  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), []);
});

test("the guard has no opinion about assertions or test content -- only about WHERE a write lands", () => {
  // A test that asserts on the RESULT of a tracked-src write it performs THROUGH AN EXEMPT path
  // (a sandboxed copy) is not flagged, no matter what it asserts -- design note (iv)'s "the guard
  // constrains WHERE a test may write, never WHAT it may assert".
  const source = [
    'import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import assert from "node:assert/strict";',
    "",
    'const sandbox = mkdtempSync(join(tmpdir(), "guard-fixture-"));',
    'writeFileSync(join(sandbox, "src", "lib", "status.ts"), "anything at all, any assertion shape");',
    'assert.equal(readFileSync(join(sandbox, "src", "lib", "status.ts"), "utf8"), "anything at all, any assertion shape");',
  ].join("\n");

  assert.deepEqual(scanSource(source, "test/fixture.test.ts"), []);
});
