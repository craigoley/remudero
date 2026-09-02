import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execWhitelistedProof, parseWhitelistedProof } from "../src/lib/review.js";
import { checkProofCommand, CHECK_PROOF_EXIT, COMMANDS } from "../src/run-task.js";

// ── W1-T387: check-proof and the reviewer's executor CANNOT be two different programs ───────────
//
// CLAUDE.md told every author `rmd check-proof` was "the reviewer's own parser and executor". It
// was only ever the parser. Past that, checkProofCommand ran its own raw spawnSync and judged
// pass/fail purely by `status === 0` — while the real reviewer path (execWhitelistedProof, via
// nameFilteredOutcome) reads the TAP stream for the NAMED test's own result line, because
// `node --test --test-name-pattern` exits 0 and prints its file's trivial wrapper line even when
// ZERO named tests matched. MEASURED live at 946f281 (unchanged at this sha): a name-filtered
// `unit test:` proof naming the exported symbol below resolves to test/fix-rung-no-task.test.ts
// (the source imports and repeatedly CALLS a function of that name, so the fixed-string candidate
// search finds the file) but no `test(...)` in that file is literally TITLED with that name — so
// the run completes, exits 0, and prints output, while zero real (non-wrapper) TAP result lines
// match the pattern.
//
// THE FIX IS ONE CALL (design note): checkProofCommand now judges through execWhitelistedProof
// itself, the exact function judgeCriterion calls at review time, rather than a second exit-code
// check of its own. This suite proves that call is real, not merely present.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Assembled at runtime ON PURPOSE, same discipline as test/proof-grep-safety.test.ts's sentinel:
// `resolveNameFilteredCandidates` greps SOURCE with a FIXED STRING, so if this file's own bytes
// spelled the name out verbatim, THIS FILE would become a second candidate the moment it exists —
// exactly the kind of self-reference the fixed-string search is blind to. Splitting it here keeps
// the fixture's resolution at exactly the one file the rationale measured against.
const NAME_FILTERED_FIXTURE = ["fixHead", "Acceptable"].join("");
const NO_MATCH_PROOF = `unit test: ${NAME_FILTERED_FIXTURE}`;

/** Run `checkProofCommand` with stdout captured, from `cwd` (default: this repo). Restores both,
 *  always — same discipline as test/check-proof-suite-run.test.ts, which established that these
 *  tests must drive the REAL exported command, not a re-implementation of its decision.
 *
 * ALSO strips `NODE_TEST_CONTEXT` around the call — an artifact of THIS SUITE, not of the verb
 * under test. `execWhitelistedProof`'s spawn inherits `process.env` (by design — a real `rmd
 * check-proof` invocation is never itself running under `node --test`), and node's test runner
 * sets `NODE_TEST_CONTEXT=child-v8` on ITSELF. Left in place, a name-filtered `kind: "test"`
 * fixture spawned FROM WITHIN this test file inherits that variable, its nested `node --test`
 * grandchild silently switches reporters, and the missing TAP trailer reads as a truncated
 * (timed-out) run instead of a genuine, fast completion — MEASURED here (not a timeout: the same
 * command finishes in ~5s standalone). Deleting it for the duration of the call is the same
 * discipline test/proof-grep-safety.test.ts already uses for SELF_SYNC_GUARD_ENV: mutate, call,
 * restore in `finally`, never leak the change past this one call. */
function runCheckProof(argv: string[], cwd: string = REPO_ROOT): { code: number; out: string } {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  const hadNodeTestContext = Object.prototype.hasOwnProperty.call(process.env, "NODE_TEST_CONTEXT");
  const savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    delete process.env.NODE_TEST_CONTEXT;
    const code = checkProofCommand(argv);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    process.chdir(realCwd);
    if (hadNodeTestContext) process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
  }
}

function resolvedCandidateFiles(out: string): string[] {
  const match = out.match(/^candidates:\s+(\d+) file\(s\)\s+—\s+(.+)\s*$/m);
  assert.ok(match, "check-proof must report the resolved candidate files");
  const files = match[2]!.split(/\s*,\s*/).filter(Boolean);
  assert.equal(files.length, Number(match[1]), "the reported candidate count must match the file list");
  return files;
}

// ── Acceptance #1: SAME verdict as the review executor, never a green exit code ─────────────────

test("ACCEPTANCE #1 baseline: the review executor itself reports no-match for the rationale's exact fixture, confirming the divergence is still live at this sha", () => {
  const w = parseWhitelistedProof(NO_MATCH_PROOF);
  assert.ok(w, "must parse as a name-filtered unit test proof");
  assert.ok(w!.nameFiltered);
  // See runCheckProof's doc comment: strip this suite's own NODE_TEST_CONTEXT so the nested
  // `node --test` child this spawns is not mistaken for a truncated (timed-out) run.
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const outcome = execWhitelistedProof(w!, REPO_ROOT, 60_000);
    assert.equal(outcome, "no-match", "zero tests are literally titled with this fixture's name in the resolved file");
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

test("ACCEPTANCE #1: check-proof reports the SAME no-match verdict as the review executor — never a green (pass) exit — for a proof that resolves to a real file but matches no test title", () => {
  const { code, out } = runCheckProof(["unit test:", NAME_FILTERED_FIXTURE]);

  // The trap this whole task exists to close: the RAW child process genuinely exits 0 and prints
  // real output (the file's own trivial TAP wrapper line among others) — an exit-code-only check
  // reads this as green. check-proof must not be that check any more.
  // W1-T2609: the resolved SET grew to two files and the fixture's property is unchanged.
  // `resolveNameFilteredCandidates` greps test SOURCES for the literal, so any file that merely
  // NAMES the fixture's symbol — even inside a doc comment — becomes a candidate. THIS FILE MUST
  // THEREFORE NEVER SPELL THAT SYMBOL OUTSIDE THE FIXTURE CONSTANT: writing it in a comment here
  // makes this suite its own third candidate and the assertion below can never match. Still pinned
  // EXACTLY, both files named: grep does not promise traversal order, so compare the candidate SET
  // while still pinning both paths and the count. The invariant is the three assertions below — the
  // raw child still exits 0 (the historical false-green) and the collapsed verdict must still read
  // no-match. Measured at this head: candidates 2, exit 0, hits 24, verdict no-match.
  assert.deepEqual(resolvedCandidateFiles(out).sort(), [
    "test/fix-branch-checkout-serialization.test.ts",
    "test/fix-rung-no-task.test.ts",
  ]);
  assert.match(out, /^exit:\s+0\s*$/m, "the RAW child process exit code is genuinely 0 — the historical false-green");
  assert.match(out, /^verdict:\s+no-match\s*$/m, "the collapsed verdict must read no-match, not pass");

  assert.notEqual(code, CHECK_PROOF_EXIT.pass, "must NOT read as a green exit despite the raw exit code 0");
  assert.equal(code, CHECK_PROOF_EXIT.noMatch, "must report the SAME verdict class execWhitelistedProof observed");
});

// ── Acceptance #2: diagnostics survive the collapse ──────────────────────────────────────────────

test("ACCEPTANCE #2: check-proof still prints parse kind, resolved candidates, the exact argv and a hit count on the no-match path", () => {
  const { out } = runCheckProof(["unit test:", NAME_FILTERED_FIXTURE]);
  assert.match(out, new RegExp(`^proof:\\s+unit test: ${NAME_FILTERED_FIXTURE}\\s*$`, "m"));
  assert.match(out, /^parse:\s+OK — kind=test \(name-filtered\)\s*$/m);
  const candidates = resolvedCandidateFiles(out);
  assert.deepEqual(candidates.slice().sort(), [
    "test/fix-branch-checkout-serialization.test.ts",
    "test/fix-rung-no-task.test.ts",
  ]);
  const argv = out.match(/^argv:\s+(.+)\s*$/m)?.[1];
  assert.ok(argv, "check-proof must report the executor argv");
  assert.match(argv, new RegExp(`^node --test .*--test-name-pattern ${NAME_FILTERED_FIXTURE} `));
  assert.ok(argv.endsWith(candidates.join(" ")), "the executor argv must preserve the reported candidate list");
  assert.doesNotMatch(out, /test\/\*\*\/\*\.test\.ts/, "narrowed to the one candidate file, not the whole-suite glob");
  assert.match(out, /^hits:\s+\d+\s*$/m, "a hit count is still printed — collapsing the executor costs no diagnostics");
});

test("ACCEPTANCE #2: diagnostics also survive on the pass path (a proof that genuinely holds)", () => {
  const { code, out } = runCheckProof([`grep: export function checkProofCommand in src/run-task.ts`]);
  assert.equal(code, CHECK_PROOF_EXIT.pass);
  assert.match(out, /^parse:\s+OK — kind=grep\s*$/m);
  assert.match(out, /^argv:\s+grep -arn --/m);
  assert.match(out, /^exit:\s+0\s*$/m);
  assert.match(out, /^hits:\s+\d+\s*$/m);
  assert.match(out, /^verdict:\s+pass\s*$/m);
});

// ── Acceptance #3: no-match and fail map to distinguishable exit codes; help text states it ─────

test("ACCEPTANCE #3: no-match and fail are DIFFERENT exit codes — the no-match fixture and a genuinely failing proof must never collide", () => {
  const noMatch = runCheckProof(["unit test:", NAME_FILTERED_FIXTURE]);
  const fail = runCheckProof([`grep: this-string-does-not-exist-anywhere-xyzzy-387 in src/run-task.ts`]);

  assert.equal(noMatch.code, CHECK_PROOF_EXIT.noMatch);
  assert.equal(fail.code, CHECK_PROOF_EXIT.fail);
  assert.notEqual(
    noMatch.code,
    fail.code,
    "a proof that named nothing and a proof that genuinely failed must not read the same to an author",
  );
  assert.match(fail.out, /^verdict:\s+fail\s*$/m);
});

test("ACCEPTANCE #3: CHECK_PROOF_EXIT itself gives every outcome a distinct code (pass/fail/refused/no-match/exec_error)", () => {
  const codes = Object.values(CHECK_PROOF_EXIT);
  assert.equal(new Set(codes).size, codes.length, "every mapped outcome must have its own exit code");
  assert.equal(CHECK_PROOF_EXIT.pass, 0);
  assert.equal(CHECK_PROOF_EXIT.fail, 1);
  assert.equal(CHECK_PROOF_EXIT.refused, 2, "unchanged from before the collapse — refusals never executed anything");
  assert.notEqual(CHECK_PROOF_EXIT.noMatch, CHECK_PROOF_EXIT.fail, "the exact defect this task closes");
});

test("ACCEPTANCE #3: the verb's own --help text states the verdict-to-exit-code mapping explicitly", () => {
  const spec = COMMANDS.find((c) => c.name === "check-proof");
  assert.ok(spec, "check-proof must still be a registered command");
  assert.match(spec!.detail, /EXIT CODE IS THE VERDICT/i);
  assert.match(spec!.detail, /0 pass/);
  assert.match(spec!.detail, /1 fail/);
  assert.match(spec!.detail, /3 no-match/);
  assert.match(spec!.detail, /never read as fail/i, "the help text must say WHY the codes are kept apart");
});
