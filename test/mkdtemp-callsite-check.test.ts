/**
 * test/mkdtemp-callsite-check.test.ts — W1-T2773.
 *
 * Proves the fail-closed AST lint rule refuses every non-sanctioned mkdtempSync callsite
 * shape and accepts every sanctioned one. The linter reads the AST directly, not the import
 * graph, so a bare `node --test <this-file>` with no wrapper loaded exercises the refusal
 * exactly as `hooks/pre-commit` will.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// `scripts/**` sits outside tsconfig's `include`, so a static import of the .mjs is TS7016 --
// same pattern as test/tracked-source-write-guard.test.ts, which loads its script through a
// dynamic specifier so the REAL module runs with no shadow copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mkdtemp-callsite-check.mjs");
type ScanSummary = {
  refused: Array<{ file: string; line: number; arg: string; classification: string }>;
  scanned: number;
  allowedCount: number;
};
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  ALLOWLIST_PATH: string;
  RMD_TMP_PREFIX: string;
  checkMkdtempCallsites: (repoRoot: string, opts?: { scan?: (root: string) => ScanSummary }) => ScanSummary;
  classifyMkdtempFirstArg: (expr: string) => string;
  formatRefusal: (row: { file: string; line: number; arg: string; classification: string }) => string;
  main: (opts?: {
    repoRoot?: string;
    out?: (s: string) => void;
    err?: (s: string) => void;
    scan?: (root: string) => ScanSummary;
  }) => number;
  scanFile: (text: string) => Array<{ line: number; arg: string; classification: string }>;
};
const {
  ALLOWLIST_PATH,
  RMD_TMP_PREFIX,
  checkMkdtempCallsites,
  classifyMkdtempFirstArg,
  formatRefusal,
  main,
  scanFile,
} = mod;

// ── classification: the rule's pure heart ───────────────────────────────────────────────────

test("W1-T2773 classify: `join(tmpdir(), \"rmd-foo-\")` is a sanctioned literal", () => {
  assert.equal(classifyMkdtempFirstArg('join(tmpdir(), "rmd-foo-")'), "sanctioned-literal");
});

test("W1-T2773 classify: `join(tmpdir(), `${RMD_TMP_PREFIX}foo-`)` is a sanctioned constant", () => {
  assert.equal(classifyMkdtempFirstArg("join(tmpdir(), `${RMD_TMP_PREFIX}foo-`)"), "sanctioned-const");
});

test("W1-T2773 classify: a template whose LITERAL head begins with `rmd-` (before any `${...}`) is sanctioned — feedback-landing.ts:509 shape", () => {
  assert.equal(classifyMkdtempFirstArg("join(tmpdir(), `rmd-${kind.branch}-`)"), "sanctioned-literal");
  assert.equal(classifyMkdtempFirstArg("join(tmpdir(), `rmd-foo-${x}`)"), "sanctioned-literal");
});

test("W1-T2773 classify: `join(tmpdir(), \"bare-\")` (no rmd-) is a bare literal — REFUSED", () => {
  assert.equal(classifyMkdtempFirstArg('join(tmpdir(), "bare-")'), "bare-literal");
  assert.equal(classifyMkdtempFirstArg('join(tmpdir(), "sweep-reentry-")'), "bare-literal");
  assert.equal(classifyMkdtempFirstArg('join(tmpdir(), "unwired-gate-")'), "bare-literal");
});

test("W1-T2773 classify: a variable prefix is unresolvable — REFUSED, fails closed by design", () => {
  assert.equal(classifyMkdtempFirstArg("join(tmpdir(), prefix)"), "unresolvable");
  assert.equal(classifyMkdtempFirstArg("join(tmpdir(), fn())"), "unresolvable");
});

test("W1-T2773 classify: a template not starting with a sanctioned constant is refused, even if the substring `rmd-` appears later", () => {
  // NOT starting with ${RMD_TMP_PREFIX} — the check is on the FIRST characters of the prefix,
  // so a stray `${x}rmd-` cannot smuggle a bare prefix past the rule.
  assert.equal(classifyMkdtempFirstArg("join(tmpdir(), `${something}rmd-suffix-`)"), "bare-literal");
});

test("W1-T2773 classify: a non-tmpdir root is not our concern — the boot sweep only reaps under os.tmpdir()", () => {
  assert.equal(classifyMkdtempFirstArg('join(cacheDir, "foo-")'), "non-tmpdir");
  assert.equal(classifyMkdtempFirstArg('"/some/absolute/path/foo-"'), "non-tmpdir");
});

// ── scanFile: locates every callsite and its line number ─────────────────────────────────────

test("W1-T2773 scanFile: a mkdtempSync OCCURRENCE inside a string literal or comment is NOT a callsite -- the rule's own documentation and this file's own fixtures must not be false-positived", () => {
  // A doc comment discussing the API mentions mkdtempSync(...) in prose. Not a call.
  const text1 = [
    "/**",
    " * `mkdtempSync(join(tmpdir(), \"bare-\"))` is the shape THIS rule refuses.",
    " */",
    "function real(){}",
  ].join("\n");
  assert.equal(scanFile(text1).length, 0, "prose in a block comment is not a call");

  // A string constant carrying the exact refusal shape as sample text -- e.g. the
  // INSTRUMENT_SURFACE excuse in src/lib/review.ts.
  const text2 = `const NOTE = "mkdtempSync(join(tmpdir(), <expr>)) -- the exact shape";`;
  assert.equal(scanFile(text2).length, 0, "a quoted example is not a call");

  // A test-fixture string in a test file (this rule's own test file's shape).
  const text3 = "const fixture = 'const d = mkdtempSync(join(tmpdir(), \"sweep-reentry-\"));';";
  assert.equal(scanFile(text3).length, 0, "a fixture string that quotes the shape is not a call");

  // A real call NEXT TO a comment example must still be caught -- the exclusion is strictly
  // scoped to the string/comment span, not the whole line.
  const text4 = [
    "// example: mkdtempSync(join(tmpdir(), 'quoted-'))",
    "const real = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));",
  ].join("\n");
  const rows = scanFile(text4);
  assert.equal(rows.length, 1, "a real call after a comment example is one call, not two");
  assert.equal(rows[0].classification, "bare-literal");
  assert.equal(rows[0].line, 2);
});

test("W1-T2773 scanFile: reports the line, the raw arg, and the classification for every callsite", () => {
  const text = [
    "import { mkdtempSync } from 'node:fs';",
    "const good = mkdtempSync(join(tmpdir(), 'rmd-x-'));",
    "const bad = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));",
    "const varish = mkdtempSync(join(tmpdir(), prefix));",
  ].join("\n");
  const rows = scanFile(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].classification, "sanctioned-literal");
  assert.equal(rows[0].line, 2);
  assert.equal(rows[1].classification, "bare-literal");
  assert.equal(rows[1].line, 3);
  assert.equal(rows[2].classification, "unresolvable");
  assert.equal(rows[2].line, 4);
});

test("W1-T2773 scanFile: strings, comments, and unbalanced calls cannot confuse delimiter matching", () => {
  const balanced = [
    "const line = mkdtempSync(join(tmpdir(), 'rmd-line-') // comment with ) and ,",
    ");",
    "const block = mkdtempSync(join(tmpdir(), 'rmd-block-') /* comment with ) and , */);",
  ].join("\n");
  assert.deepEqual(
    scanFile(balanced).map((row) => row.classification),
    ["sanctioned-literal", "sanctioned-literal"],
    "delimiters inside comments must not close or split a real call",
  );

  assert.deepEqual(
    scanFile("const unfinished = mkdtempSync(join(tmpdir(), 'rmd-open-')"),
    [],
    "an unclosed outer call is ignored rather than parsed past EOF",
  );
  assert.deepEqual(
    scanFile("const prose = \"unterminated mkdtempSync(join(tmpdir(), 'bare-'))"),
    [],
    "an unterminated string remains an exclusion through EOF",
  );
});

// ── main(): the exit-code contract, driven through the same argv path pre-commit will use ───

function makeFixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mkdtemp-lint-fixture-`));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"], { env });
  execFileSync("git", ["-C", root, "config", "user.email", "t@e.x"], { env });
  execFileSync("git", ["-C", root, "config", "user.name", "t"], { env });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(root, rel.replace(/\/[^/]*$/, "") || "."), { recursive: true });
    writeFileSync(abs, body);
  }
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed", "--no-verify"], { env });
  return root;
}

function makePreCommitFixtureRepo(): string {
  const root = makeFixtureRepo({
    "scripts/mkdtemp-callsite-check.mjs": readFileSync(SCRIPT, "utf8"),
    "hooks/pre-commit": readFileSync(join(REPO_ROOT, "hooks", "pre-commit"), "utf8"),
    "hooks/mkdtemp-allowlist.txt": "# fixture starts with no exemptions\n",
    "test/seed.test.ts": "const seed = true;\n",
  });
  chmodSync(join(root, "hooks", "pre-commit"), 0o755);
  execFileSync("git", ["-C", root, "config", "core.hooksPath", "hooks"]);
  return root;
}

test("W1-T2773 pre-commit: the real hook refuses a staged bare prefix before commit and accepts the sanctioned repair", () => {
  const root = makePreCommitFixtureRepo();
  const candidate = join(root, "test", "candidate.test.ts");
  const before = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  writeFileSync(
    candidate,
    [
      "import { mkdtempSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "mkdtempSync(join(tmpdir(), 'worker-bare-prefix-'));",
    ].join("\n"),
  );
  execFileSync("git", ["-C", root, "add", "test/candidate.test.ts"]);
  const refused = spawnSync("git", ["-C", root, "commit", "-m", "test: add a bare temp prefix"], {
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0, "the real pre-commit hook must reject the staged callsite");
  assert.match(refused.stderr, /pre-commit refused/);
  assert.match(refused.stderr, /worker-bare-prefix-/);
  assert.equal(
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    before,
    "the refusal must happen before git creates a commit",
  );

  writeFileSync(candidate, readFileSync(candidate, "utf8").replace("worker-bare-prefix-", "rmd-worker-prefix-"));
  execFileSync("git", ["-C", root, "add", "test/candidate.test.ts"]);
  const accepted = spawnSync("git", ["-C", root, "commit", "-m", "test: use a reapable temp prefix"], {
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, `the repaired staged callsite must commit:\n${accepted.stderr}`);
  assert.notEqual(
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    before,
    "the accepted repair must create the commit the refused form could not",
  );
});

test("W1-T2773 main: a repo with only sanctioned callsites exits 0", () => {
  const root = makeFixtureRepo({
    "test/ok.test.ts": [
      "import { mkdtempSync } from 'node:fs';",
      "const RMD_TMP_PREFIX = 'rmd-';",
      "const d = mkdtempSync(join(tmpdir(), 'rmd-fine-'));",
      "const e = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}also-fine-`));",
    ].join("\n"),
  });
  const out: string[] = [], err: string[] = [];
  const rc = main({ repoRoot: root, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  assert.equal(rc, 0, `expected clean, got err:\n${err.join("\n")}`);
  assert.ok(out.some((l) => /clean/.test(l)), "clean message expected");
});

test("W1-T2773 main: a bare-literal callsite reddens the rule and the refusal names the fix (RMD_TMP_PREFIX + allowlist path)", () => {
  const root = makeFixtureRepo({
    "test/bare.test.ts": [
      "import { mkdtempSync } from 'node:fs';",
      "const d = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));",
    ].join("\n"),
  });
  const out: string[] = [], err: string[] = [];
  const rc = main({ repoRoot: root, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  assert.equal(rc, 1);
  const msg = err.join("\n");
  assert.ok(/sweep-reentry-/.test(msg), "the refusal must name the prefix the human wrote");
  assert.ok(/RMD_TMP_PREFIX/.test(msg), "the refusal must name the constant as the fix");
  assert.ok(/hooks\/mkdtemp-allowlist\.txt/.test(msg), "the refusal must name the allowlist path");
  assert.ok(/sweepStaleTempDirs/.test(msg), "the refusal must name WHY (the boot sweep) so a reader knows the reapability discipline exists");
});

test("W1-T2773 main: a variable-prefix callsite fails closed — the rule cannot prove reapability from the AST", () => {
  const root = makeFixtureRepo({
    "scripts/varish.mjs": [
      "import { mkdtempSync } from 'node:fs';",
      "export function foo(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }",
    ].join("\n"),
  });
  const err: string[] = [];
  const rc = main({ repoRoot: root, out: () => {}, err: (s: string) => err.push(s) });
  assert.equal(rc, 1, "unresolvable prefixes must be refused, not admitted");
  assert.ok(/<variable-prefix>|scripts\/varish\.mjs/.test(err.join("\n")));
});

// W1-T2786 re-keyed the allowlist from `<file>:<line>` to `<file>:<prefix>`. The parking
// mechanism this test proves is unchanged; only the key it is spelled with has moved. The
// line-keyed spelling (`test/bare.test.ts:2`) is now inert by design — the sibling suite
// test/mkdtemp-allowlist-rekey.test.ts asserts that directly, so the retired form is proven
// dead somewhere rather than merely deleted here.
test("W1-T2773 main: an allowlisted `<file>:<prefix>` bypasses the rule (the migration parking mechanism)", () => {
  const root = makeFixtureRepo({
    "test/bare.test.ts": [
      "import { mkdtempSync } from 'node:fs';",
      "const d = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));",
    ].join("\n"),
    "hooks/mkdtemp-allowlist.txt": [
      "# pre-existing site, migrated under W1-T2775",
      "test/bare.test.ts:sweep-reentry-",
    ].join("\n"),
  });
  const out: string[] = [], err: string[] = [];
  const rc = main({ repoRoot: root, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  assert.equal(rc, 0, `allowlisted callsite must not red; err:\n${err.join("\n")}`);
});

test("W1-T2773 programmatic and CLI boundaries preserve the scanner's success and failure contracts", () => {
  const expected: ScanSummary = { refused: [], scanned: 3, allowedCount: 2 };
  const roots: string[] = [];
  assert.deepEqual(
    checkMkdtempCallsites("/fixture", {
      scan: (root) => {
        roots.push(root);
        return expected;
      },
    }),
    expected,
  );
  assert.deepEqual(roots, ["/fixture"], "the programmatic wrapper passes its requested root to the scanner");

  const notRepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mkdtemp-lint-not-a-repo-`));
  const errors: string[] = [];
  assert.equal(main({ repoRoot: notRepo, out: () => {}, err: (s) => errors.push(s) }), 2);
  assert.match(errors.join("\n"), /git ls-files failed/);

  // This child inherits NODE_V8_COVERAGE in CI, so the raw shard includes the direct-execution
  // guard and process.exit boundary rather than treating a successful import as equivalent.
  const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(stdout, /mkdtemp-callsite-check: clean/);
});

test("W1-T2773 formatRefusal: the message text NAMES THE FIX, not just the rule", () => {
  const msg = formatRefusal({ file: "test/x.test.ts", line: 42, arg: 'join(tmpdir(), "foo-")', classification: "bare-literal" });
  assert.ok(msg.includes("test/x.test.ts:42"), "must name the callsite");
  assert.ok(msg.includes("'foo-'"), "must quote the prefix the human wrote");
  assert.ok(msg.includes("RMD_TMP_PREFIX"), "must name the constant to use");
  assert.ok(msg.includes(ALLOWLIST_PATH), "must name the allowlist as the escape hatch");
  assert.ok(msg.includes("sweepStaleTempDirs"), "must name why the current form fails");
  // Read the message aloud: "prefix 'foo-' will not be reaped by ... — use ..."
  assert.ok(/will not be reaped by/.test(msg));
  assert.ok(/use\s+`\$\{RMD_TMP_PREFIX\}/.test(msg));
});
