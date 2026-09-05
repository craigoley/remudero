import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// ── W1-T2706: THE CANDIDATE SET IS A DEPENDENCY ON THE WHOLE REPO, SO IT SAYS SO OUT LOUD ───────
//
// `resolveNameFilteredCandidates` greps test SOURCES for the literal above with a FIXED STRING, so
// ANY file that merely NAMES the fixture's symbol becomes a candidate — a doc comment is enough.
// MEASURED, twice in one afternoon from two unrelated diffs: #3619 added a suite whose header cites
// the symbol while explaining something else entirely, the set went 1 -> 2, and both assertions
// below reddened on a PR that never touched check-proof; the repair comment then spelled the symbol
// again and made this suite its own third candidate.
//
// WHAT THESE TESTS ACTUALLY PROVE IS NOT THE COUNT. It is that a proof resolving to a real file
// but matching NO test title still collapses to `no-match` — the raw child genuinely exits 0, the
// historical false-green. That held at every count observed. The count is scaffolding, and it is
// the only part an outside diff can move. So the set stays PINNED (loosening it to a substring
// match would stop proving the set at all), and what changes is the FAILURE: it now names the file
// that joined and the two ways out, because the author who trips it has no connection to
// check-proof and sees only an opaque `candidates:` mismatch today.

/** The files expected to name the fixture's symbol, pinned. Re-derive with the command in
 *  {@link candidateSetDiagnosis}'s remedy when a legitimate new namer appears. */
const PINNED_NAMING_FILES = [
  "test/fix-branch-checkout-serialization.test.ts",
  "test/fix-rung-no-task.test.ts",
] as const;

/**
 * `null` when `actual` is exactly the pinned set; otherwise the message this suite fails with —
 * naming the offending file(s) and the remedy.
 *
 * PURE, and that is deliberate: the falsifier this task requires drives it with a SYNTHETIC extra
 * file. Creating a real one would mean writing into the tracked tree from a test, which W1-T2715's
 * suite-level gate now refuses outright.
 */
export function candidateSetDiagnosis(actual: readonly string[]): string | null {
  const pinned: string[] = [...PINNED_NAMING_FILES].sort();
  const got = [...actual].sort();
  const joined = got.join("|");
  if (joined === pinned.join("|")) return null;
  const added = got.filter((f) => !pinned.includes(f));
  const gone = pinned.filter((f) => !got.includes(f));
  return [
    "check-proof-executor-parity: the fixture proof's resolved candidate set changed.",
    added.length > 0 ? `  JOINED: ${added.join(", ")}` : "",
    gone.length > 0 ? `  NO LONGER NAMES IT: ${gone.join(", ")}` : "",
    "  WHY YOUR DIFF DID THIS: this suite's fixture proof resolves by grepping test/ sources for a",
    "  literal symbol, so a file that merely MENTIONS that symbol — a doc comment is enough, it does",
    "  not have to call it — becomes a candidate. Your file almost certainly names it in prose.",
    "  THE REMEDY, either one:",
    "    (1) stop naming the symbol in that file (assemble it, as this suite does for its own copy), or",
    "    (2) re-derive the pinned set here, if the new file names it for a real reason:",
    "        git grep -lF -- \"$(node -e 'process.stdout.write([\"fixHead\",\"Acceptable\"].join(\"\"))')\" test/",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The set as the TREE reports it right now, by the same fixed-string search the resolver uses —
 *  never a second hand-maintained list that could drift from what check-proof actually resolves. */
function filesNamingFixtureSymbolInTree(symbol: string = NAME_FILTERED_FIXTURE): string[] {
  const out = execFileSync("git", ["grep", "-lF", "--", symbol, "test/"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean).sort();
}

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
  assert.equal(candidateSetDiagnosis(resolvedCandidateFiles(out)), null);
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
  assert.equal(candidateSetDiagnosis(candidates), null);
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

// ── W1-T2706: the dependency stated, the diagnosis proven, the self-defence pinned ──────────────

test("W1-T2706: the uniqueness property this suite depends on is STATED and checked against the tree, not left implicit in a regex", () => {
  // The property: exactly the pinned files name the fixture's symbol. Derived from the tree by the
  // SAME fixed-string search `resolveNameFilteredCandidates` uses, so this can never pass while
  // check-proof would resolve something else.
  const inTree = filesNamingFixtureSymbolInTree();
  assert.ok(inTree.length > 0, "control: the search finds the fixture's namers at all — a zero here would make every assertion below vacuous");

  // THE CONTROL THAT MAKES THIS A MEASUREMENT OF THE TREE. Without it, replacing the search with
  // `[...PINNED_NAMING_FILES]` leaves this test asserting `pinned === pinned` and passing — MEASURED:
  // that falsifier reddened NOTHING until this clause existed. The same search, for a DIFFERENT
  // symbol this suite knows the tree contains, must return a DIFFERENT non-empty set; a function
  // that returned the pinned constant would answer identically for both.
  const other = filesNamingFixtureSymbolInTree("resolveNameFilteredCandidates");
  assert.ok(other.length > 0, "control: the search finds a second, unrelated symbol too — so it really searches");
  assert.notDeepEqual(other, inTree, "and answers DIFFERENTLY for it — a constant could not");

  // And every path it returned genuinely contains the symbol on disk, so the set is not merely
  // a plausible-looking list.
  for (const f of inTree) {
    assert.ok(
      readFileSync(join(REPO_ROOT, f), "utf8").includes(NAME_FILTERED_FIXTURE),
      `${f} was reported as a namer but does not contain the symbol`,
    );
  }
  assert.equal(
    candidateSetDiagnosis(inTree),
    null,
    "the tree's namers must be exactly the pinned set; if this fails, the message names the file that joined",
  );
});

test("W1-T2706: a NEW file naming the symbol fails with THAT FILE NAMED and the remedy — never an opaque candidates mismatch", () => {
  // Driven with a SYNTHETIC extra file. A real one would mean writing into the tracked tree from a
  // test, which W1-T2715's suite-level gate refuses — and the diagnosis is a pure function precisely
  // so this falsifier does not need to.
  const intruder = "test/some-unrelated-suite-that-mentions-it.test.ts";
  const msg = candidateSetDiagnosis([...PINNED_NAMING_FILES, intruder]);
  assert.ok(msg, "a changed set must produce a diagnosis, not silence");
  assert.match(msg, new RegExp(`JOINED: ${intruder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the offending file is NAMED");
  assert.match(msg, /a doc comment is enough/, "and WHY an unrelated diff did it");
  assert.match(msg, /THE REMEDY, either one/, "and what to do about it");
  assert.match(msg, /git grep -lF/, "including the command that re-derives the pinned set");

  // The other direction: a file that STOPS naming it is reported too, not silently tolerated.
  const shrunk = candidateSetDiagnosis([PINNED_NAMING_FILES[0]]);
  assert.ok(shrunk, "a shrinking set is also a changed set");
  assert.match(shrunk, /NO LONGER NAMES IT: test\/fix-rung-no-task\.test\.ts/);

  // And the healthy case stays silent, in either order — grep promises no traversal order.
  assert.equal(candidateSetDiagnosis([...PINNED_NAMING_FILES]), null);
  assert.equal(candidateSetDiagnosis([...PINNED_NAMING_FILES].reverse()), null);
});

test("W1-T2706: the fixture stays ASSEMBLED, so this suite can never become its own candidate", () => {
  // Asserted over this file's own bytes. The literal is assembled here too — spelling it out to
  // check for its absence would be the very defect under test.
  const own = readFileSync(join(__dirname, "check-proof-executor-parity.test.ts"), "utf8");
  const literal = ["fixHead", "Acceptable"].join("");
  const spelled = own.split(literal).length - 1;
  assert.equal(spelled, 0, `this suite must never spell the fixture's symbol verbatim (found ${spelled}) — doing so makes it its own candidate`);
  assert.match(own, /\["fixHead", "Acceptable"\]\.join\(""\)/, "and it stays assembled, which is what keeps that true");
  // The control that makes the zero above a measurement rather than a typo: the assembled value is
  // really the symbol the fixture proof carries.
  assert.equal(NO_MATCH_PROOF, `unit test: ${literal}`);
  assert.ok(!filesNamingFixtureSymbolInTree().includes("test/check-proof-executor-parity.test.ts"), "and the TREE agrees this file is not a namer");
});
