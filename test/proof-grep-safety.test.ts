import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { breMetacharsIn, proofGrepSafetyViolations } from "../src/lib/task-linter.js";
import { parseWhitelistedProof } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";

/**
 * The two failure modes measured on PR #1071, and the locks that keep the check from
 * over-rejecting. Every grep assertion here runs the REAL binary — the whole defect is that a
 * hand-rolled check used a different matcher than the executor, so a test that simulated grep
 * would reproduce the bug rather than catch it.
 */

function taskWithProof(proof: string): Task {
  return {
    id: "W1-TTEST",
    title: "t",
    status: "todo",
    depends_on: [],
    verify: "auto",
    acceptance: [{ claim: "a claim", proof }],
  } as unknown as Task;
}

test("an unescaped BRE metacharacter in a grep: pattern is BLOCKED", () => {
  // PR #1071 verbatim: `[call-site]` is a CHARACTER CLASS matching one of {c,a,l,-,s,i,t,e}.
  const v = proofGrepSafetyViolations(taskWithProof("grep: For a [call-site] violation in src/lib/task-linter.ts"));
  assert.equal(v.length, 1);
  assert.equal(v[0].check, "proof-grep-safety");
  assert.equal(v[0].severity, "block");
  assert.match(v[0].message, /unescaped BRE metacharacter/);
  assert.match(v[0].message, /`\[`/, "the offending character is named");
  assert.match(v[0].message, /never.*match the literal text|may never match/, "the message says WHY");
});

test("an ESCAPED metacharacter is accepted, and so is a merely punctuated pattern", () => {
  // TRAP 2's lock. `(` is an ERE metacharacter but NOT a BRE one — PR #1071's own call-site rule
  // emits proofs shaped `grep: someSymbol( in <path>`, so rejecting it would break a merged rule.
  for (const pattern of [
    "export function callSiteViolations",
    "callSiteViolations(",
    "src/lib/foo.ts:some_ident-name",
    "a{b}c+d?e|f]g",
    "an escaped \\. dot",
    "an escaped \\[bracket\\]",
  ]) {
    const v = proofGrepSafetyViolations(taskWithProof(`grep: ${pattern} in src/lib/review.ts`));
    assert.deepEqual(
      v.filter((x) => x.severity === "block"),
      [],
      `"${pattern}" must not be blocked — over-rejecting makes the check the thing authors route around`,
    );
  }
  assert.deepEqual(breMetacharsIn("callSiteViolations(").blocking, [], "( is not a BRE metacharacter");
  assert.deepEqual(breMetacharsIn("an escaped \\. dot").warning, [], "an escaped dot is a literal, not a warning");
});

test("an unescaped dot WARNS rather than blocking — it widens a match but still finds its own text", () => {
  const v = proofGrepSafetyViolations(taskWithProof("grep: panel-skills.js in src/lib/serve.ts"));
  assert.equal(v.length, 1);
  assert.equal(v[0].severity, "warn", "blocking this would strand 4 existing tasks whose proofs work");
  assert.match(v[0].message, /matches ANY character/);
});

test("THE #1071 REPRODUCTION: the bracket pattern passes grep -F but finds nothing under the real executor", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-grepsafe-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, "// For a [call-site] violation the linter says so\n");

  // grep -F — the FIXED-STRING matcher PR #1071's author used locally. Finds it.
  const fixed = execFileSync("grep", ["-c", "-F", "--", "For a [call-site] violation", file], { encoding: "utf8" });
  assert.equal(fixed.trim(), "1", "grep -F finds the literal text — this is the false green");

  // The executor's own matcher is a BRE. The bracket is a character class, so it cannot match.
  // R-18: the TARGET is relative and the run is FROM the fixture dir — an absolute target is
  // refused at parse now, and the reviewer never runs a proof from anywhere but the checkout.
  const proof = `grep: For a [call-site] violation in ${basename(file)}`;
  const w = parseWhitelistedProof(proof);
  assert.ok(w, "the proof PARSES — nothing today rejects it");
  let exit = 0;
  try {
    execFileSync(w!.command, w!.args as string[], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    exit = (e as { status?: number }).status ?? -1;
  }
  assert.equal(exit, 1, "the REAL executor finds nothing — the two matchers disagree");

  // And the new check catches it before it can be authored.
  const v = proofGrepSafetyViolations(taskWithProof(proof));
  assert.equal(v.filter((x) => x.severity === "block").length, 1, "lint now refuses it");
});

test("a NUL-carrying target returns the SAME result as a NUL-free copy under the executor's argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-grepnul-"));
  const clean = join(dir, "clean.ts");
  const withNul = join(dir, "nul.ts");
  writeFileSync(clean, "export function callSiteViolations() {}\n");
  writeFileSync(withNul, "export function callSiteViolations() {}\n// \0 sentinel\n");

  // ASSERT ON STDOUT, NOT JUST THE EXIT CODE. Which binary `grep` resolves to differs between a
  // login shell and node's execFileSync — MEASURED on this host, node gets BSD grep 2.6.0-FreeBSD
  // while the interactive shell gets ugrep 7.5.0. Without `-a` those two DISAGREE on a NUL file
  // (BSD exits 0 with "Binary file … matches"; ugrep exits 1 with nothing), so an exit-code-only
  // assertion silently cannot fail under whichever binary happens to be lenient. The line of
  // EVIDENCE is what `-a` guarantees on every implementation, so that is what this asserts.
  // R-18: relative target + `cwd: dir`, for the same reason as the sibling test above.
  const run = (file: string) => {
    const w = parseWhitelistedProof(`grep: export function callSiteViolations in ${basename(file)}`);
    assert.ok(w);
    try {
      return { exit: 0, out: execFileSync(w!.command, w!.args as string[], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { exit: err.status ?? -1, out: err.stdout ?? "" };
    }
  };

  const a = run(clean);
  const b = run(withNul);
  assert.equal(a.exit, 0, "the NUL-free control matches");
  assert.equal(b.exit, 0, "the NUL-carrying file matches IDENTICALLY — this is what -a buys");
  assert.equal(a.exit, b.exit, "the verdict must not depend on the file's bytes");
  assert.match(a.out, /export function callSiteViolations/, "the control prints the matching line");
  assert.match(
    b.out,
    /export function callSiteViolations/,
    "the NUL file must print the LINE too — without -a, BSD grep prints only 'Binary file … matches'",
  );
  assert.doesNotMatch(b.out, /Binary file/, "evidence, not a binary-file placeholder");
});

test("rmd check-proof reports the EXECUTOR'S OWN argv, exit code and hits — and writes nothing", async (t) => {
  const { checkProofCommand } = await import("../src/run-task.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-checkproof-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, "export function breMetacharsIn() {}\n");

  const lines: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));

  // R-18: the proof names its target RELATIVE to the checkout and this runs FROM that checkout —
  // an absolute target is now refused at parse (parseDialectGrep), and a target resolving outside
  // the cwd is refused before the spawn (assertGrepTargetsInsideCheckout). The fixture keeps
  // `rmd check-proof` in parity with the reviewer, which runs every proof with cwd pinned to the
  // PR-head checkout — the property test/check-proof-executor-parity.test.ts exists to hold.
  const realCwd = process.cwd();
  let code: number;
  try {
    process.chdir(dir);
    code = checkProofCommand([`grep: export function breMetacharsIn in ${basename(file)}`]);
  } finally {
    process.chdir(realCwd);
  }
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /parse:\s+OK — kind=grep/);
  assert.match(out, /argv:\s+grep -arn --/, "it prints the EXACT argv the reviewer runs, -a included");
  assert.match(out, /exit:\s+0/);
  assert.match(out, /hits:\s+1/);

  // The state directory it would have to touch to be a writer is never even resolved: the verb
  // reads no config and owns no path. Asserting on the DIRECTORY it would write to is the only
  // check that stays true if someone later adds a cache (the `rmd next-task-id` failure mode).
  assert.equal(existsSync(join(dir, "state")), false, "no state written beside the target");
});

test("rmd check-proof FAILS a metacharacter pattern and names the regex trap", async (t) => {
  const { checkProofCommand } = await import("../src/run-task.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-checkproof2-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, "// For a [call-site] violation the linter says so\n");
  const lines: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));

  // The #1071 pattern: grep -F finds it, the executor does not. The verb reports the executor's answer.
  // R-18: relative target, run from the checkout — see the sibling test above for why.
  const realCwd = process.cwd();
  let code: number;
  try {
    process.chdir(dir);
    code = checkProofCommand([`grep: For a [call-site] violation in ${basename(file)}`]);
  } finally {
    process.chdir(realCwd);
  }
  assert.equal(code, 1);
  const out = lines.join("\n");
  assert.match(out, /hits:\s+0/);
  assert.match(out, /BASIC REGULAR EXPRESSION/, "it tells the author WHY, at the moment they are wrong");
  assert.match(out, /Do NOT re-check this with `grep -F`/);
});

test("rmd check-proof refuses a proof that does not parse, rather than pretending to run it", async (t) => {
  const { checkProofCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  // A path-less `grep:` is refused by parseDialectGrep — it never executes.
  assert.equal(checkProofCommand(["grep: something with no path clause"]), 2);
  assert.match(lines.join("\n"), /parse:\s+REFUSED/);
});

test("rmd check-proof with NO argument refuses rather than running an empty pattern", async (t) => {
  const { checkProofCommand } = await import("../src/run-task.js");
  const errs: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void errs.push(a.map(String).join(" ")));
  assert.equal(checkProofCommand([]), 2);
  assert.match(errs.join("\n"), /give me a proof/);
});

test("rmd check-proof resolves a `unit test:` proof to its candidate file and narrows the argv", async (t) => {
  const { checkProofCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  // A title that exists verbatim in THIS file, so the candidate resolver finds exactly one file.
  checkProofCommand(["unit test: an unescaped BRE metacharacter in a grep: pattern is BLOCKED"]);
  const out = lines.join("\n");
  assert.match(out, /parse:\s+OK — kind=test \(name-filtered\)/);
  assert.match(out, /candidates:\s+\d+ file\(s\)/, "the executor's own candidate resolution is shown");
  assert.match(out, /test\/proof-grep-safety\.test\.ts/, "narrowed to the file that holds the title");
  assert.doesNotMatch(out, /argv:.*test\/\*\*/, "the whole-suite glob is replaced, exactly as the executor does");
});

test("rmd check-proof reports a `unit test:` title that matches NO test as absent, without spawning node", async (t) => {
  const { checkProofCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  // Assembled at runtime ON PURPOSE. `resolveNameFilteredCandidates` greps SOURCE with a FIXED
  // string, so any sentinel written as one literal would be found in THIS file and resolve rather
  // than being absent — the test would then assert the opposite of what it claims.
  const sentinel = ["no test title", "matches this", "xy" + "zzy"].join(" ");
  // W1-T387: no-match is no longer folded into the SAME exit code as a genuine fail (1) — the
  // reviewer degrades no-match to the keyword floor and overrides on fail, so a local check that
  // could not tell the two apart was reporting the wrong one of the two. See CHECK_PROOF_EXIT.
  assert.equal(checkProofCommand([`unit test: ${sentinel}`]), 3);
  const out = lines.join("\n");
  assert.match(out, /candidates:\s+absent/);
  assert.match(out, /never spawns node/, "the fast path is reported, not silently taken");
});

test("main(): `rmd check-proof` actually ROUTES to checkProofCommand and exits with its code", async (t) => {
  const { main } = await import("../src/run-task.js");
  class ExitCalled extends Error {
    constructor(readonly code?: number) {
      super("exit");
    }
  }
  t.mock.method(process, "exit", ((code?: number): never => {
    throw new ExitCalled(code);
  }) as typeof process.exit);
  t.mock.method(console, "log", () => {});
  const dir = mkdtempSync(join(tmpdir(), "rmd-cproute-"));
  const file = join(dir, "s.ts");
  writeFileSync(file, "export function breMetacharsIn() {}\n");
  const originalArgv = process.argv;
  const originalGuard = process.env[SELF_SYNC_GUARD_ENV];
  const realCwd = process.cwd();
  // R-18: relative target, run from the checkout — see the argv/exit/hits test above for why.
  process.argv = ["node", "run-task.js", "check-proof", `grep: export function breMetacharsIn in ${basename(file)}`];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  process.chdir(dir);
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof ExitCalled, "main() must reach process.exit via checkProofCommand's return value");
    assert.equal((caught as ExitCalled).code, 0);
  } finally {
    process.chdir(realCwd);
    process.argv = originalArgv;
    if (originalGuard === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuard;
  }
});

test("the executor's grep argv carries -a so the verdict cannot depend on the host's grep", () => {
  const w = parseWhitelistedProof("grep: needle in src/lib/review.ts");
  assert.ok(w);
  assert.equal(w!.command, "grep");
  assert.equal(w!.args[0], "-arn", "without -a, BSD grep exits 0 and ugrep exits 1 on the same NUL file");
});
