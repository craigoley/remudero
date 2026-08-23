import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyGrepZeroHit } from "../src/lib/grep-zero-cause.js";
import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";

// ── W1-T1224: a zero-hit `grep:` proof must say WHY it read zero ────────────────────────────────
//
// `checkProofCommand` runs a `grep:` proof's pattern EXACTLY ONCE and, on zero hits, used to print
// the SAME static BRE-metacharacter note whether or not the pattern actually had one — a phrase
// that wraps across a line break, a phrase whose capitalisation differs, and a phrase that is
// genuinely not written yet all read byte-identical. `classifyGrepZeroHit` (src/lib/grep-zero-
// cause.ts) is the derived answer; this suite proves both the classifier's own closed set and the
// wiring's real output.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** Run `checkProofCommand` with stdout captured, from `cwd` (default: this repo). Restores both,
 *  always — same discipline test/check-proof-executor-parity.test.ts already established. */
function runCheckProof(argv: string[], cwd: string = REPO_ROOT): { code: number; out: string } {
  const lines: string[] = [];
  const realLog = console.log;
  const realCwd = process.cwd();
  try {
    process.chdir(cwd);
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const code = checkProofCommand(argv);
    return { code, out: lines.join("\n") };
  } finally {
    console.log = realLog;
    process.chdir(realCwd);
  }
}

// ── classifyGrepZeroHit: the closed set, over fixtures — no fs, no exec ──────────────────────────

test("matched — a pattern with at least one genuine line hit is never misreported as a cause", () => {
  assert.equal(classifyGrepZeroHit("hello world", "say hello world to everyone"), "matched");
});

test("line-seam — a phrase present verbatim in the file but split by a line break (a YAML fold / wrapped paragraph) is reported line-seam, never absent", () => {
  const fileText =
    "Some preamble text.\n" +
    "The eventual design phrase splits across a line\n" +
    "because of a wrap that the author never typed.\n";
  const pattern = "design phrase splits across a line because";
  // No single physical line contains the whole phrase — it straddles the seam between line 2 and 3.
  assert.ok(!fileText.split("\n").some((l) => l.includes(pattern)), "fixture sanity: no single line contains the phrase");
  assert.equal(classifyGrepZeroHit(pattern, fileText), "line-seam");
});

test("case-only — a phrase present in the file only with different capitalisation is reported case-only, never absent", () => {
  const fileText = "The Widget Registry becomes authoritative here.\n";
  const pattern = "widget registry becomes authoritative";
  assert.equal(classifyGrepZeroHit(pattern, fileText), "case-only");
});

test("absent — a pattern genuinely missing from the file in every probed form is reported as a forward reference, never as an unmatchable pattern", () => {
  const fileText = "Nothing about this file mentions the target phrase at all.\n";
  const pattern = "quantum flux capacitor calibration";
  assert.equal(classifyGrepZeroHit(pattern, fileText), "absent");
  // Never one of the two "can never match" causes — this is the one case that must read as fine.
  assert.notEqual(classifyGrepZeroHit(pattern, fileText), "line-seam");
  assert.notEqual(classifyGrepZeroHit(pattern, fileText), "case-only");
});

test("stated order (design (ii)): when a phrase both wraps AND a differently-cased single-line form also exists, line-seam wins — never case-only", () => {
  const fileText =
    "alpha beta gamma\n" +
    "delta epsilon\n" +
    "\n" +
    "ALPHA BETA GAMMA DELTA EPSILON is also here, on one line.\n";
  const pattern = "alpha beta gamma delta epsilon";
  // Sanity: the case-insensitive-per-line probe alone WOULD find the all-caps line if checked —
  // proving this is a genuine "both hold" case, not one where case-only was never really live.
  assert.ok(/alpha beta gamma delta epsilon/i.test("ALPHA BETA GAMMA DELTA EPSILON is also here, on one line."));
  assert.equal(classifyGrepZeroHit(pattern, fileText), "line-seam");
});

test("same matcher, never a fixed string: a pattern carrying a BRE metacharacter (`.`) is matched as the regex it is, not as literal text", () => {
  // "fo.d" as a BASIC REGULAR EXPRESSION matches "food" (`.` = any one character) — a fixed-string
  // (`grep -F`) search for the four literal characters "fo.d" would never find it.
  const fileText = "there is plenty of food to go around\n";
  assert.equal(classifyGrepZeroHit("fo.d", fileText), "matched");
});

test("same matcher, never a fixed string: a pattern carrying a bracket expression (`[...]`) is matched as a character class, not literal brackets", () => {
  const fileText = "a cat sat on a bat\n";
  // "b[ai]t" matches "bat" (and would also match "bit") via the bracket expression — a fixed-string
  // search for the literal text "b[ai]t" would never find it in this file.
  assert.equal(classifyGrepZeroHit("b[ai]t", fileText), "matched");
});

// ── Wiring: check-proof calls the classifier and prints what it says ─────────────────────────────
// grep: classifyGrepZeroHit( in src/run-task.ts

test("check-proof: an absent path keeps today's exec_error verdict and exit code, and gains only a cause line", () => {
  const { code, out } = runCheckProof(["grep: anything in src/lib/w1-t1224-this-path-does-not-exist.ts"]);
  assert.equal(code, CHECK_PROOF_EXIT.execError, "exit code is unchanged — no caller shifts");
  assert.match(out, /^verdict:\s+exec_error/m);
  assert.match(out, /^cause:\s+path-absent/m, "gains a cause line naming the file was not there");
  assert.match(out, /w1-t1224-this-path-does-not-exist\.ts does not exist/);
});

test("check-proof: a genuine zero-hit grep prints a cause line derived from the file, and it is `absent` for a phrase in neither form", () => {
  const { code, out } = runCheckProof([`grep: totally-unique-xyzzy-w1t1224-nowhere in src/run-task.ts`]);
  assert.equal(code, CHECK_PROOF_EXIT.fail);
  assert.match(out, /^verdict:\s+fail/m);
  assert.match(out, /^cause:\s+absent/m);
});

test("check-proof: the static BRE-metacharacter note is gated on an actual unescaped metacharacter, not printed on every non-pass", () => {
  // Ends in `$` (a BLOCKING metachar per breMetacharsIn/task-linter.ts) — a valid regex that
  // genuinely fails to match (no line in this file ends with this exact sentinel text).
  const withMeta = runCheckProof(["grep: totally-unique-xyzzy-w1t1224-anchor$ in src/run-task.ts"]);
  assert.equal(withMeta.code, CHECK_PROOF_EXIT.fail);
  assert.match(
    withMeta.out,
    /^note:\s+a `grep:` pattern is a BASIC REGULAR EXPRESSION/m,
    "a pattern that genuinely carries `$` must still show the note",
  );

  const noMeta = runCheckProof(["grep: totally-unique-xyzzy-w1t1224-plain in src/run-task.ts"]);
  assert.equal(noMeta.code, CHECK_PROOF_EXIT.fail);
  assert.doesNotMatch(
    noMeta.out,
    /^note:/m,
    "a plain-text pattern with no metacharacter must not print the metacharacter note any more",
  );
});
