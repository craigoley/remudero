import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProofCommand, checkProofTimeoutMs, CHECK_PROOF_FULL_SUITE_FLAG } from "../src/run-task.js";

// ── `rmd check-proof` must never be the thing that runs the whole test suite.
//
// A `unit test:` proof naming a TITLE (rather than a test/<file>.test.ts PATH) compiles to
// `node --test --test-name-pattern <title> test/**/*.test.ts` — the whole glob. `checkProofCommand`
// resolves the title to its file first and narrows the argv, which is why the ordinary case runs
// exactly one file. But `resolveNameFilteredCandidates` has THREE answers, and only two were
// handled: `resolved` narrows, `absent` fast-fails, and `unresolvable` fell through with the glob
// intact — into a `spawnSync` that carried no timeout. An operator asking a one-line question about
// one proof got an unbounded full-suite run.
//
// The trigger is ordinary, not exotic: `unresolvable` is returned whenever `couldBeInterpolatedTitle`
// is true — whenever the title merely SHARES A STATIC CHUNK with any template-literal title in the
// corpus — and, as below, whenever the cwd has no readable test corpus at all.
//
// WHY THESE TESTS DRIVE THE REAL COMMAND. `checkProofCommand` is where the fallback lived, so a test
// against a re-implemented decision would prove nothing about the verb an operator types. Each test
// calls the exported command with a real cwd and reads what it printed.

/** Run `checkProofCommand` with stdout captured, from `cwd`. Restores both, always. */
function runCheckProof(argv: string[], cwd: string): { code: number; out: string } {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    const code = checkProofCommand(argv);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    process.chdir(realCwd);
  }
}

/**
 * A directory with no test corpus, which makes `resolveNameFilteredCandidates` answer
 * `unresolvable` — the branch under test. It is also the reason these tests are SAFE: even the
 * opt-in case below spawns `node --test` here, where the glob matches nothing, so no test file in
 * this repository is ever loaded by this suite.
 */
function corpuslessDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-check-proof-nocorpus-"));
}

const TITLE_PROOF = ["unit test:", "a", "title", "that", "resolves", "to", "no", "file", "here"];

test("check-proof REFUSES a title proof that resolves to no file, rather than running the whole suite", () => {
  const dir = corpuslessDir();
  try {
    const { code, out } = runCheckProof(TITLE_PROOF, dir);

    assert.match(out, /candidates: unresolvable/, "the resolution and its reason must still be reported");
    assert.match(out, /verdict:\s+NOT EXECUTED/, "the run must be refused, not attempted");
    assert.match(out, /WHOLE test suite/, "the refusal must say what it is refusing to do");
    assert.match(out, new RegExp(CHECK_PROOF_FULL_SUITE_FLAG.replace(/[-]/g, "\\-")), "and name the opt-in");
    assert.equal(code, 2, "a refusal is not a proof verdict — it must not read as pass (0) or fail (1)");

    // The DIAGNOSTIC value is unchanged: an author still sees the parse and the exact argv, which
    // is what they came for. Only the spawn is withheld.
    assert.match(out, /parse:\s+OK — kind=test \(name-filtered\)/);
    assert.match(out, /argv:.*--test-name-pattern/);
    assert.match(out, /test\/\*\*\/\*\.test\.ts/, "the argv must still SHOW the glob that would have run");

    // The falsifier for this whole suite: a refusal must produce no run output. `exit:`/`hits:` are
    // printed only after the spawn, so their absence is proof nothing was spawned.
    assert.doesNotMatch(out, /^exit:/m, "a refused proof must not report an exit code — nothing ran");
    assert.doesNotMatch(out, /^hits:/m, "a refused proof must not report hits — nothing ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-proof runs the glob only when the operator explicitly opts in with the flag", () => {
  const dir = corpuslessDir();
  try {
    const { out } = runCheckProof([...TITLE_PROOF, CHECK_PROOF_FULL_SUITE_FLAG], dir);

    assert.match(out, /candidates: unresolvable/);
    assert.doesNotMatch(out, /NOT EXECUTED/, "the opt-in must actually opt in");
    assert.match(out, /^exit:/m, "with the flag, the run happens and reports its exit code");

    // Safe here BY CONSTRUCTION, and that is the point of running it in a corpusless dir: the glob
    // matches nothing, so no test file in this repository is loaded.
    assert.match(out, /test\/\*\*\/\*\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the opt-in flag is stripped from the proof text, not parsed as part of it", () => {
  const dir = corpuslessDir();
  try {
    const { out } = runCheckProof([...TITLE_PROOF, CHECK_PROOF_FULL_SUITE_FLAG], dir);
    // The echoed proof must be the author's text alone — otherwise the flag would silently become
    // part of the test-name pattern and change what the proof means.
    assert.match(out, /^proof:\s+unit test: a title that resolves to no file here$/m);
    assert.doesNotMatch(out.split("\n")[0], /allow-full-suite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof that resolves to a real file is unaffected — it still narrows to that one file", () => {
  // The regression guard: the fix must not touch the ordinary path. This title lives in exactly one
  // file, so the argv must name that file and must NOT carry the glob.
  const { out } = runCheckProof(
    ["unit test:", "check-proof", "REFUSES", "a", "title", "proof", "that", "resolves", "to", "no", "file"],
    process.cwd(),
  );
  assert.match(out, /candidates: 1 file\(s\) — test\/check-proof-suite-run\.test\.ts/);
  assert.doesNotMatch(out, /test\/\*\*\/\*\.test\.ts/, "a resolved proof must never carry the whole-suite glob");
  assert.doesNotMatch(out, /NOT EXECUTED/, "a resolved proof is executed as before");
});

// ── The timeout seam. The other half of what made the fallback expensive was that `spawnSync`
// carried no `timeout` at all, so the whole-suite run was unbounded. Both arms are asserted here —
// the catch arm in particular, which is otherwise reachable only on a checkout whose policy file is
// unreadable, i.e. never from a passing test.

test("checkProofTimeoutMs reads the policy's proofTimeoutMs, the same field the reviewer uses", () => {
  assert.equal(checkProofTimeoutMs(() => 123_456), 123_456);
});

test("checkProofTimeoutMs falls back to the documented floor when the policy cannot be read", () => {
  const thrown = checkProofTimeoutMs(() => {
    throw new Error("plan/policy.yaml is unreadable");
  });
  assert.equal(thrown, 60_000, "an unreadable policy must degrade to the floor, never crash the verb");
});

test("checkProofTimeoutMs against the REAL policy is a positive, bounded number", () => {
  // No injection: proves the default argument resolves against the shipped policy rather than
  // relying on the two injected cases above, which would both pass with the default broken.
  const real = checkProofTimeoutMs();
  assert.ok(Number.isFinite(real) && real >= 60_000, `expected a real policy timeout >= the floor, got ${real}`);
});
