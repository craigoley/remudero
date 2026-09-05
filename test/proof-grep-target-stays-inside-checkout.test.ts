/**
 * test/proof-grep-target-stays-inside-checkout.test.ts — recon 2026-09-05, finding R-18.
 *
 * THE DEFECT. `execWhitelistedProof` (src/lib/review.ts) runs a `grep:` proof as
 * `grep -arn -- <pattern> <path>` with cwd pinned to the PR-HEAD CHECKOUT, and grep FOLLOWS a
 * symlink named on its own command line. `parseDialectGrep` refused `..` and `*` — while its own
 * comment claimed traversal out of the checkout was "still refused" — and refused an ABSOLUTE
 * target not at all. So a proof could name any file the reviewer's uid can read, and its
 * match/no-match verdict reported ONE BIT about that file's content; because a PR-body edit
 * re-earns review on the same head sha (CLAUDE.md, "A BODY REPAIR IS A NEW REVIEW INPUT"), the
 * oracle was repeatable at will. The legacy fenced `` `grep …` `` shape passed the author's own
 * argv through, where `-f <file>` reads PATTERNS from a file — the same read by another route.
 *
 * WHAT CLOSES IT, and why in two places. The escapes VISIBLE IN THE PROOF TEXT (`..`, an absolute
 * path) are refused at PARSE. A symlink is invisible there, so it is refused against the real
 * filesystem — `assertGrepTargetsInsideCheckout` realpaths every non-flag argv token that exists
 * on disk and throws {@link ProofTargetOutsideCheckoutError} when it lands outside the checkout.
 * The throw matters: `judgeCriterion`'s catch (src/lib/review.ts, `proofExec = "exec_error"`) maps
 * EVERY thrown cause to `exec_error`, which degrades to the keyword floor and never becomes a
 * verdict — so the outcome is CONTENT-INDEPENDENT, which is the property that closes the oracle.
 * A `fail` would have leaked the same bit inverted.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  execWhitelistedProof,
  judgeCriterion,
  parseWhitelistedProof,
  ProofTargetOutsideCheckoutError,
  type ProofExecContext,
} from "../src/lib/review.js";

/** The bit the oracle would have read. Present in the OUTSIDE file and in the in-tree control,
 *  so a proof naming either one would report `pass` if the containment check were not there. */
const SECRET = "SECRET-TOKEN-r18";
/** A string present in NEITHER file — the second half of the content-independence measurement. */
const ABSENT = "NO-SUCH-TOKEN-r18";

const CLAIM = "the proof target stays inside the checkout";

/**
 * Report tokens that FULLY cover a given proof's distinctive keywords, so the mechanical keyword
 * floor (`MIN_COVERAGE`, src/lib/review.ts) reads `met: true` and an `exec_error` is visibly a
 * DEGRADE to that floor rather than a refusal. Mirrors review.ts's own private `tokenize` —
 * camelCase split, lowercase, split on every non-alphanumeric — because neither it nor
 * `proofKeywords` is exported; a hand-written token list silently under-covers the moment a proof
 * string here changes, which is exactly how the first draft of this suite read `met: false`.
 */
function tokensCovering(proof: string): Set<string> {
  return new Set(
    proof
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function git(dir: string, ...args: string[]): string {
  // No `env` override: child_process defaults to `process.env`, which test/setup/tmp-hygiene.ts
  // has already stamped with the gc-disable settings (see test/git-fixture-gc-hygiene.test.ts).
  // The identity comes from `-c` flags, not ambient config — `actions/checkout` sets NEITHER repo
  // nor global identity, so a fixture inheriting a dev machine's config passes locally and fails
  // on every CI runner (CLAUDE.md, "A fixture shelling git PLUMBING …").
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  }).trim();
}

/**
 * A throwaway git checkout holding an ordinary in-tree file plus a COMMITTED symlink `escape`
 * pointing at a directory outside it — the exact shape a PR head can carry — and, beside it, the
 * "operator's" directory that symlink escapes to. Two sibling `mkdtempSync` roots, so `outside` is
 * genuinely not under `checkout` (and both are swept by test/setup/tmp-hygiene.ts on exit).
 */
function escapingCheckout(): { checkout: string; outside: string } {
  const outside = mkdtempSync(join(tmpdir(), "rmd-r18-operator-"));
  writeFileSync(join(outside, "secret.txt"), `${SECRET} — an operator-readable file the PR head does not contain\n`);

  const root = mkdtempSync(join(tmpdir(), "rmd-r18-head-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "inside.txt"), `${SECRET} — an ordinary in-tree line\n`);
  writeFileSync(join(checkout, "patterns.txt"), `${SECRET}\n`);
  symlinkSync(outside, join(checkout, "escape"));

  git(checkout, "init", "--quiet", "-b", "main");
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "head with a committed symlink");

  // The symlink is COMMITTED, not merely present on disk: git records mode 120000 for it. Without
  // this the fixture would model a local filesystem accident rather than a PR head an author
  // controls, which is the whole threat.
  const staged = git(checkout, "ls-files", "-s", "escape");
  assert.match(staged, /^120000 /, `the fixture's escape must be a COMMITTED symlink, got: ${staged}`);
  return { checkout, outside };
}

// ── (i) THE ESCAPES THE PROOF TEXT SHOWS: refused at PARSE, before anything runs ────────────────

test("R-18 (i): an ABSOLUTE `grep:` target is refused at parse — it never reaches the executor", () => {
  assert.equal(parseWhitelistedProof("grep: x in /etc/hostname"), null, "an absolute target must not compile");

  // THE CONTROL THAT MAKES THAT NULL A MEASUREMENT. The same body with the SAME trailing token
  // made RELATIVE parses, so the refusal above is the leading `/`, not a failure of the ` in `
  // split to find a path clause at all (which is its own, older refusal).
  const relative = parseWhitelistedProof("grep: x in etc/hostname");
  assert.ok(relative, "control: the identical body with a relative target still compiles");
  assert.deepEqual(relative!.args, ["-arn", "--", "x", "etc/hostname"]);

  // The two escapes that were already refused stay refused, unchanged.
  assert.equal(parseWhitelistedProof("grep: x in ../outside.txt"), null, "`..` — unchanged");
  assert.equal(parseWhitelistedProof("grep: x in src/*.ts"), null, "a glob — unchanged");
});

// ── (ii) THE ESCAPE THE PROOF TEXT HIDES: refused at EXECUTION, as exec_error ───────────────────

test("R-18 (ii): a target resolving out through a COMMITTED SYMLINK throws ProofTargetOutsideCheckoutError, and judgeCriterion grades it exec_error", () => {
  const { checkout, outside } = escapingCheckout();
  const proof = `grep: ${SECRET} in escape/secret.txt`;

  const w = parseWhitelistedProof(proof);
  assert.ok(w, "the proof PARSES — nothing in its TEXT distinguishes it from an ordinary in-tree target");
  assert.deepEqual(w!.args, ["-arn", "--", SECRET, "escape/secret.txt"]);

  // THE ORACLE, MEASURED rather than assumed: the file this target resolves to really is outside
  // the checkout and really does contain the pattern, so an unguarded executor answers "pass" and
  // the verdict reports one bit about a file the PR head does not contain.
  assert.match(readFileSync(join(outside, "secret.txt"), "utf8"), new RegExp(SECRET));

  assert.throws(() => execWhitelistedProof(w!, checkout), ProofTargetOutsideCheckoutError);
  assert.throws(() => execWhitelistedProof(w!, checkout), /outside the checkout/);

  const execCtx: ProofExecContext = { cwd: checkout };
  const verdict = judgeCriterion({ claim: CLAIM, proof }, tokensCovering(proof), undefined, execCtx);
  assert.equal(verdict.proof_exec, "exec_error", "a throw is no conclusion at all — never executed_pass, never executed_fail");
  assert.equal(verdict.met, true, "the keyword floor stands verbatim: exec_error degrades, it never overrides");
});

test("R-18 (ii, content-independence): the SAME out-of-checkout target reports the SAME outcome whether or not the file matches — the one bit is gone", () => {
  const { checkout } = escapingCheckout();
  const execCtx: ProofExecContext = { cwd: checkout };
  const judge = (pattern: string) => {
    const proof = `grep: ${pattern} in escape/secret.txt`;
    return judgeCriterion({ claim: CLAIM, proof }, tokensCovering(proof), undefined, execCtx);
  };

  const present = judge(SECRET); // the outside file DOES contain this
  const absent = judge(ABSENT); // it does NOT
  assert.equal(present.proof_exec, "exec_error");
  assert.equal(absent.proof_exec, "exec_error");
  assert.equal(
    present.proof_exec,
    absent.proof_exec,
    "the verdict must not vary with the CONTENT of a file outside the checkout — that variation IS the oracle",
  );
  assert.equal(present.met, absent.met, "and neither may the criterion's own met/unmet");
});

// ── (iii) THE CHECK DOES NOT COST AN HONEST PROOF ANYTHING ──────────────────────────────────────

test("R-18 (iii): an ordinary RELATIVE, in-tree target still executes and still passes", () => {
  const { checkout } = escapingCheckout();
  const proof = `grep: ${SECRET} in inside.txt`;
  const w = parseWhitelistedProof(proof);
  assert.ok(w);
  assert.equal(execWhitelistedProof(w!, checkout), "pass", "the containment check must not refuse a proof that stays in-tree");

  const verdict = judgeCriterion({ claim: CLAIM, proof }, tokensCovering(proof), undefined, { cwd: checkout });
  assert.equal(verdict.proof_exec, "executed_pass");
  assert.match(verdict.reason, /proof executed and PASSED on the PR head/);

  // And a genuine in-tree MISS is still an ordinary fail, not a refusal — the check discriminates
  // WHERE the target is, never whether the pattern matched.
  const missedProof = `grep: ${ABSENT} in inside.txt`;
  const missed = judgeCriterion({ claim: CLAIM, proof: missedProof }, tokensCovering(missedProof), undefined, { cwd: checkout });
  assert.equal(missed.proof_exec, "executed_fail");
});

// ── (iv) THE LEGACY FENCED SHAPE, WHOSE ARGV THE AUTHOR CHOOSES ─────────────────────────────────

test("R-18 (iv): the legacy fenced shape reading its PATTERNS from a file outside the checkout (`-f`) is refused the same way", () => {
  const { checkout, outside } = escapingCheckout();
  // `-f <file>` makes grep read its patterns FROM that file — a read of an out-of-checkout file by
  // a second route, in the one shape whose argv is the author's own rather than compiled.
  const proof = `legacy fenced form: \`grep -f ${join(outside, "secret.txt")} inside.txt\``;

  const w = parseWhitelistedProof(proof);
  assert.ok(w, "the legacy shape still parses — its argv is author-selected, which is the point");
  assert.equal(w!.authorSelectedArgv, true);
  assert.throws(() => execWhitelistedProof(w!, checkout), ProofTargetOutsideCheckoutError);

  const verdict = judgeCriterion({ claim: CLAIM, proof }, tokensCovering(proof), undefined, { cwd: checkout });
  assert.equal(verdict.proof_exec, "exec_error");
});

test("R-18 (iv, control): the same legacy `-f` shape reading an IN-TREE pattern file still runs", () => {
  const { checkout } = escapingCheckout();
  // Proves the refusal above is about WHERE the file is, not about `-f` itself — a check that
  // refused every `-f` would pass the test above while breaking a legitimate proof.
  const w = parseWhitelistedProof("legacy fenced form: `grep -f patterns.txt inside.txt`");
  assert.ok(w);
  assert.equal(execWhitelistedProof(w!, checkout), "pass");
});

test("R-18: a cwd that cannot be realpath'd falls back to resolving it, and still CONTAINS — the refusal never depends on the checkout being readable", () => {
  const { outside } = escapingCheckout();
  // The one arm of the containment check no other case here reaches: `realpathSync(cwd)` itself
  // throwing. It must FAIL CLOSED — a checkout that cannot be resolved is not a licence to read
  // outside it — so the fallback resolves the path lexically and the comparison still runs.
  const missing = join(tmpdir(), "rmd-r18-no-such-checkout");
  assert.equal(existsSync(missing), false, "control: the cwd genuinely does not exist, so realpathSync on it throws");

  const w = parseWhitelistedProof(`legacy fenced form: \`grep -f ${join(outside, "secret.txt")} .\``);
  assert.ok(w);
  assert.throws(() => execWhitelistedProof(w!, missing), ProofTargetOutsideCheckoutError);
});

// ── the error is a NAMED, EXPORTED type, so callers can tell it from an ordinary spawn failure ──

test("R-18: ProofTargetOutsideCheckoutError is exported and names the token, the resolved path and the checkout", () => {
  const { checkout, outside } = escapingCheckout();
  const w = parseWhitelistedProof(`grep: ${SECRET} in escape/secret.txt`);
  assert.ok(w);
  let caught: unknown;
  try {
    execWhitelistedProof(w!, checkout);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ProofTargetOutsideCheckoutError, "a named subclass, not a bare Error");
  const err = caught as ProofTargetOutsideCheckoutError;
  assert.equal(err.token, "escape/secret.txt");
  assert.equal(readFileSync(err.resolvedPath, "utf8").includes(SECRET), true, "resolvedPath names the REAL file it would have read");
  assert.match(err.resolvedPath, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(err.message, /outside the checkout/);
});
