/**
 * test/mkdtemp-callsite-check.test.ts — W1-T2773.
 *
 * Proves the fail-closed AST lint rule refuses every non-sanctioned mkdtempSync callsite
 * shape and accepts every sanctioned one. The linter reads the AST directly, not the import
 * graph, so a bare `node --test <this-file>` with no wrapper loaded exercises the refusal
 * exactly as `hooks/pre-commit` will.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// `scripts/**` sits outside tsconfig's `include`, so a static import of the .mjs is TS7016 --
// same pattern as test/tracked-source-write-guard.test.ts, which loads its script through a
// dynamic specifier so the REAL module runs with no shadow copy to drift from it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mkdtemp-callsite-check.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  ALLOWLIST_PATH: string;
  RMD_TMP_PREFIX: string;
  classifyMkdtempFirstArg: (expr: string) => string;
  formatRefusal: (row: { file: string; line: number; arg: string; classification: string }) => string;
  main: (opts?: { repoRoot?: string; out?: (s: string) => void; err?: (s: string) => void }) => number;
  scanFile: (text: string) => Array<{ line: number; arg: string; classification: string }>;
};
const { ALLOWLIST_PATH, RMD_TMP_PREFIX, classifyMkdtempFirstArg, formatRefusal, main, scanFile } = mod;

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

test("W1-T2773 main: an allowlisted `<file>:<line>` bypasses the rule (the migration parking mechanism)", () => {
  const root = makeFixtureRepo({
    "test/bare.test.ts": [
      "import { mkdtempSync } from 'node:fs';",
      "const d = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));",
    ].join("\n"),
    "hooks/mkdtemp-allowlist.txt": [
      "# pre-existing site, migrated under W1-T2775",
      "test/bare.test.ts:2",
    ].join("\n"),
  });
  const out: string[] = [], err: string[] = [];
  const rc = main({ repoRoot: root, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  assert.equal(rc, 0, `allowlisted callsite must not red; err:\n${err.join("\n")}`);
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
