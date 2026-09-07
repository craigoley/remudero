import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";

// ── W1-T2686 ───────────────────────────────────────────────────────────────────────────────────
//
// `check-proof --base`'s help used to justify its refusal to compare a `unit test:` proof as
// "(same scope the reviewer itself has)" and printed `NOT COMPARABLE — only grep: proofs get a
// base blob materialized today`. That parity was true when W1-T912 shipped and stopped being true
// the moment W1-T362 extended the reviewer's own `executed_stale` downgrade to `unit test:`
// proofs (src/lib/review.ts) — after which the verb's refusal cited a scope the reviewer no
// longer has, and a `unit test:` proof that would score nothing at review read `verdict: pass`
// locally with no warning beyond a note that looked like an unrelated tooling limitation.
//
// R-11 (PR #4107) already replaced the materialised-blob-only base with a real detached worktree
// at the merge-base, so a `unit test:` proof is re-run for real and graded exactly as the
// reviewer grades it. This suite is this task's own acceptance proof for that behaviour: it
// exercises the REAL exported `checkProofCommand`, drives real `unit test:` proofs through real
// two-commit git repos (never a re-implementation of the decision), and asserts the stale
// "same scope"/"NOT COMPARABLE" story is gone for good.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run `checkProofCommand` with stdout captured, from `cwd`. Restores both, always. */
function runCheckProof(
  argv: string[],
  cwd: string,
  deps?: Parameters<typeof checkProofCommand>[1],
): { code: number; out: string } {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    const code = checkProofCommand(argv, deps);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    process.chdir(realCwd);
  }
}

/** Identity from `-c` flags, never ambient config. */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

/**
 * A real two-commit repo: `base` files committed first, then `head` files on top of it. The base
 * tree needs to be one `node --test --import tsx` can actually run in, so every fixture also
 * commits a package.json, a stub of the hygiene import the proof argv names, and a `node_modules`
 * symlink to this repo's own install (so the executor's own `ensureDeps` sees an install and
 * never shells out to `npm ci` for a throwaway fixture).
 */
function twoCommitRepo(base: Record<string, string>, head: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2686-"));
  git(dir, "init", "--quiet", "-b", "main");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "w1-t2686-fixture", private: true, type: "module" }),
  );
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "test", "setup"), { recursive: true });
  writeFileSync(join(dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  for (const [rel, body] of Object.entries(base)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  for (const [rel, body] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "head");
  return dir;
}

// ── Acceptance 1: identical at head and base ⇒ discriminates nothing, never NOT COMPARABLE ───────

test("a unit-test proof passing identically at head and base is reported as discriminating nothing, not as NOT COMPARABLE", () => {
  const passing = 'import { test } from "node:test";\ntest("passes on both commits", () => {});\n';
  const repo = twoCommitRepo({ "test/stale.test.ts": passing }, { "test/stale.test.ts": passing });
  try {
    const { code, out } = runCheckProof(["--base", "HEAD~1", "unit test:", "test/stale.test.ts"], repo);
    assert.match(out, /^verdict:\s+pass\s*$/m, "the raw head run genuinely passed");
    assert.match(out, /^base:\s+pass\s*$/m, "the base run, in a real worktree, genuinely passed too");
    assert.match(
      out,
      /^discrimination:\s+executed_stale\b/m,
      "identical on both trees discriminates nothing — the reviewer's own name for this downgrade (W1-T273/W1-T362)",
    );
    assert.equal(code, CHECK_PROOF_EXIT.executedStale, "must never exit as a plain local pass");
    assert.doesNotMatch(out, /NOT COMPARABLE/, "the stale pre-R-11 refusal wording must never reappear");
    assert.doesNotMatch(out, /same scope/i, "must never cite parity with the reviewer");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Acceptance 2: fails or is absent at base ⇒ discriminates, verdict unchanged ──────────────────

test("a unit-test proof that passes at head and is absent at base reports discrimination, verdict unchanged", () => {
  const passing = 'import { test } from "node:test";\ntest("exists only on the head", () => {});\n';
  const repo = twoCommitRepo({}, { "test/fresh.test.ts": passing });
  try {
    const { code, out } = runCheckProof(["--base", "HEAD~1", "unit test:", "test/fresh.test.ts"], repo);
    assert.equal(code, CHECK_PROOF_EXIT.pass, "the head verdict itself (pass) is unchanged by the base check");
    assert.match(out, /^verdict:\s+pass\s*$/m);
    assert.match(out, /^base:\s+fail$/m, "`node --test` finds no such file in the base worktree");
    assert.match(out, /^discrimination:\s+discriminates\b/m, "head and base disagree — this proof tells done from not-done");
    assert.doesNotMatch(out, /executed_stale/, "a discriminating proof must never be reported stale");
    assert.doesNotMatch(out, /NOT COMPARABLE/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a unit-test proof that passes at head and fails at base reports discrimination, verdict unchanged", () => {
  const failingAtBase = 'import { test } from "node:test";\ntest("fails at the base", () => { throw new Error("not implemented yet"); });\n';
  const passingAtHead = 'import { test } from "node:test";\ntest("fails at the base", () => {});\n';
  const repo = twoCommitRepo({ "test/fixed.test.ts": failingAtBase }, { "test/fixed.test.ts": passingAtHead });
  try {
    const { code, out } = runCheckProof(["--base", "HEAD~1", "unit test:", "test/fixed.test.ts"], repo);
    assert.equal(code, CHECK_PROOF_EXIT.pass, "the head verdict itself (pass) is unchanged by the base check");
    assert.match(out, /^base:\s+fail$/m, "the base worktree genuinely fails this test");
    assert.match(out, /^discrimination:\s+discriminates\b/m);
    assert.doesNotMatch(out, /executed_stale/);
    assert.doesNotMatch(out, /NOT COMPARABLE/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Acceptance 3: `grep:` proofs keep their existing base behaviour and exit codes byte-identical ─

const NEEDLE = "NEEDLE_TOKEN_W1_T2686";
const GREP_ARGV = ["grep:", NEEDLE, "in", "src/marker.txt"];

test("grep proofs keep their existing base behaviour and exit codes byte-identical", () => {
  const repoDiscriminates = twoCommitRepo(
    { "src/marker.txt": "no token here\n" },
    { "src/marker.txt": `this line carries ${NEEDLE}\n` },
  );
  const repoStale = twoCommitRepo(
    { "src/marker.txt": `${NEEDLE} already here, before any work\n` },
    { "src/marker.txt": `${NEEDLE} still here at the head\n` },
  );
  try {
    const discriminating = runCheckProof(["--base", "HEAD~1", ...GREP_ARGV], repoDiscriminates);
    assert.equal(discriminating.code, CHECK_PROOF_EXIT.pass, "head still passes — --base must not re-rank the head verdict");
    assert.match(discriminating.out, /^base:\s+fail\s*$/m);
    assert.match(discriminating.out, /^discrimination:\s+discriminates\b/m);

    const stale = runCheckProof(["--base", "HEAD~1", ...GREP_ARGV], repoStale);
    assert.equal(stale.code, CHECK_PROOF_EXIT.executedStale, "a grep proof matching both trees still exits executedStale");
    assert.match(stale.out, /^base:\s+pass\s*$/m);
    assert.match(stale.out, /^discrimination:\s+executed_stale\b/m);
    assert.match(stale.out, /^base hits:\s+1$/m, "grep proofs still report a base hit count — a fact `unit test:` proofs never had");
  } finally {
    rmSync(repoDiscriminates, { recursive: true, force: true });
    rmSync(repoStale, { recursive: true, force: true });
  }
});

// ── Acceptance 4: omitting --base leaves every line and exit code unchanged (W1-T912) ────────────

test("omitting --base leaves every line and exit code unchanged, as W1-T912 promises", () => {
  const passing = 'import { test } from "node:test";\ntest("passes", () => {});\n';
  const repo = twoCommitRepo({ "test/stale.test.ts": passing }, { "test/stale.test.ts": passing });
  try {
    const { code, out } = runCheckProof(["unit test:", "test/stale.test.ts"], repo);
    assert.equal(code, CHECK_PROOF_EXIT.pass);
    assert.doesNotMatch(out, /^base:/m, "no base-comparison line may appear without --base");
    assert.doesNotMatch(out, /^discrimination:/m, "no discrimination line may appear without --base");
    for (const line of ["proof:", "parse:", "argv:", "exit:", "verdict:"]) {
      assert.ok(out.includes(line), `expected the unchanged ${line} diagnostic line to survive`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Acceptance 5: any remaining NOT COMPARABLE names its own cause, never the reviewer's parity ──

test("a unit-test proof whose merge-base worktree cannot be created reports UNKNOWN naming its own cause, never citing parity with the reviewer", () => {
  const { code, out } = runCheckProof(
    ["--base", "deadbeef0000000000000000000000000000000", "unit test:", "test/serve-identity-default-path.test.ts"],
    REPO_ROOT,
  );
  assert.equal(code, CHECK_PROOF_EXIT.pass, "the real file genuinely passes at head");
  assert.match(out, /^base:\s+UNKNOWN — a merge-base worktree at deadbeef.* could not be created/m, out);
  assert.match(out, /base_unknown/, "names the reviewer's own OUTCOME name");
  assert.doesNotMatch(out, /NOT COMPARABLE/, "the pre-R-11 wording must never reappear");
  assert.doesNotMatch(out, /same scope the reviewer/i, "must never justify itself by citing parity with the reviewer");
  assert.doesNotMatch(out, /only.*grep:.*proofs get a base blob/i, "must never repeat the stale grep-only-blob justification");
  assert.match(
    out,
    /^discrimination:\s+unknown\s+—\s+reported verdict above stands unchanged\s*$/m,
    "unknown is reported honestly, never silently skipped and never claimed as a discrimination",
  );
});

test("no source string anywhere still claims a unit-test proof is out of scope because only grep proofs get a base blob", () => {
  // @source-text-subject — W1-T2905's census counts this read; this is its declared exception, not
  // a way around it. The property under test is the ABSENCE of two specific stale strings from
  // run-task.ts's own source, and no call through checkProofCommand can demonstrate an absence —
  // the acceptance tests above already cover every OUTPUT this verb can produce; this test's own
  // subject is the source text itself, guarding against the stale wording resurfacing in a branch
  // those fixtures do not happen to exercise (e.g. an untested argv shape).
  //
  // Read the working file directly (not `git show HEAD:...`) — this repo's run-task.ts is large
  // enough that `git show`'s captured stdout can exceed execFileSync's default maxBuffer (ENOBUFS).
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.doesNotMatch(source, /NOT COMPARABLE/, "the stale refusal string must not exist anywhere in the verb's source");
  assert.doesNotMatch(
    source,
    /only[^\n]{0,10}grep:[^\n]{0,40}proofs get a base blob/i,
    "the stale grep-only-blob justification must not exist anywhere in the verb's source",
  );
});
