import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "source-text-assertion-baseline.json");

/**
 * test/source-text-assertion-census.test.ts — W1-T2905.
 *
 * A test that reads a `src/` file AS TEXT and asserts a phrase or a signature is in it is the
 * snapshot-of-source shape: it PASSES when the prose is present and the behaviour is broken, and
 * it FAILS when a refactor moves the prose and the behaviour is intact. Both halves are wrong, and
 * the second is what a decomposition does to every file that reads run-task.ts as text.
 *
 * MEASURED at this head and replayed before building: the audit's own query
 * `git grep -nE 'readFileSync\([^)]*src/' -- 'test/*.test.ts'` reads 206 sites across 138 files
 * against a 2,202-hit control for `readFileSync` alone, so the number is the query working. This
 * census's predicate is WIDER — it also honours the `join(…, "src", …)` spelling — and reads
 * 321 sites across 213 files, a strict SUPERSET (the 138 audit files are all in the 213; measured,
 * not assumed). The audit's 206 is the same population through a narrower lens, not a disagreement.
 * The predicate is also NARROWER in one direction that matters: it bounds each match to the call's
 * own argument list, where the audit's `[^)]*` runs to the first `)` and can reach a `src/` literal
 * belonging to something else.
 *
 * `detectTestTheater` (src/lib/review.ts) cannot catch this shape: it scans only ADDED diff lines
 * and only when a NEW `test(` is declared, so a source-text read added to an existing test body is
 * invisible to it. Standing rule 4 — "green checks are not evidence" — is the doctrine; this is one
 * of the mechanisms that defeats it quietly.
 *
 * THIS TASK RECORDS AND REFUSES GROWTH. It converts nothing: the 321 existing sites are follow-up
 * work this ratchet drives, exactly as the source-size and catch-erasure ratchets drive theirs.
 *
 * THIS FILE DECLARES THE MARKER ITSELF, deliberately and not by accident. Its predicate fixtures
 * below are `readFileSync(… "src" …)` strings passed as DATA to the counter; scanned as raw text
 * they read as real source reads and this census would count itself. Defining
 * `SOURCE_TEXT_SUBJECT_MARKER` puts the literal in the file, so the exclusion fires — a test at the
 * bottom asserts it does, so the exclusion is a stated property and not a side effect nobody
 * checked.
 */

/** The marker a test whose SUBJECT genuinely IS a source file's text declares itself with — the
 *  CLAUDE.md budget ratchet, the source-size baseline census, the docs-claims suites. A file
 *  carrying it is EXCLUDED from the count, so this census measures theatre and not the ratchets. */
export const SOURCE_TEXT_SUBJECT_MARKER = "@source-text-subject";

/** The argument text of the `readFileSync(` call starting at `open` — everything between its
 *  parentheses, matched by DEPTH so a nested `join(...)` or `new URL(...)` is included whole and
 *  nothing after the call's own `)` is. A fixed-width window was tried first and is wrong in both
 *  directions: it truncates a long joined path and it attributes an unrelated later `src/` literal
 *  to the call, which is exactly the mis-attribution scripts/diff-class.mjs's `sourceTextPathsRead`
 *  had to settle. Returns "" when the call is unterminated. */
export function readCallArgs(content: string, open: number): string {
  let depth = 0;
  for (let i = open; i < content.length; i += 1) {
    const c = content[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return "";
}

/** True when a `readFileSync` argument list names a path under `src/`. Every quoted segment is
 *  examined, so all three spellings in this tree resolve: the plain literal (`"src/run-task.ts"`),
 *  the relative one (`"../src/lib/x.ts"`) and the INTERPOLATED one (`` `${root}/src/lib/serve.ts` ``)
 *  — that last is a real site in test/stale-base-release-before-exhaustion.test.ts and was the one
 *  file the audit's raw regex saw and a quote-anchored predicate did not. The joined form
 *  (`join(REPO_ROOT, "src", …)`) is matched separately, since there `src` is its own segment.
 *  `src/` must begin the segment: a path through `notsrc/` is not a match. */
export function namesSrcPath(args: string): boolean {
  if (/\bjoin\s*\([^)]*["'`]src["'`]/.test(args)) return true;
  const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (let m = STRING.exec(args); m; m = STRING.exec(args)) if (/(?:^|\/)src\//.test(m[2])) return true;
  return false;
}

/** Per-test-file count of `readFileSync(` calls that read a `src/` path as text. */
export function countSourceTextReads(content: string): number {
  if (content.includes(SOURCE_TEXT_SUBJECT_MARKER)) return 0;
  const CALL = /\breadFileSync\s*\(/g;
  let n = 0;
  for (let m = CALL.exec(content); m; m = CALL.exec(content)) {
    if (namesSrcPath(readCallArgs(content, m.index + m[0].length - 1))) n += 1;
  }
  return n;
}

/** Per-file counts over the TRACKED test suites, enumerated from the tree at run time — never a
 *  frozen list, so a suite added in the same commit is counted by the run that adds it. */
export function censusSourceTextReads(root = REPO_ROOT): Record<string, number> {
  const files = execFileSync("git", ["ls-files", "test/*.test.ts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const out: Record<string, number> = {};
  for (const f of files) {
    const n = countSourceTextReads(readFileSync(join(root, f), "utf8"));
    if (n > 0) out[f] = n;
  }
  return out;
}

interface Baseline {
  _comment: string;
  files: Record<string, number>;
}

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

// ── the ratchet ────────────────────────────────────────────────────────────────────────────────

test("W1-T2905: the per-file count of source-text reads in tests is recorded and CANNOT GROW", () => {
  const baseline = loadBaseline();
  const actual = censusSourceTextReads();

  // CONTROL FIRST — a zero here would make every assertion below vacuously true, which is the
  // shape this repo's own gates keep being defeated by.
  assert.ok(Object.keys(actual).length > 100, `the census must SEE the corpus (found ${Object.keys(actual).length} files)`);
  assert.ok(Object.keys(baseline.files).length > 100, "and the baseline must be a real population, not an empty object");

  const grown: string[] = [];
  for (const [file, count] of Object.entries(actual)) {
    const allowed = baseline.files[file] ?? 0;
    if (count > allowed) grown.push(`  ${file}: ${count} > baseline ${allowed}`);
  }
  assert.deepEqual(
    grown,
    [],
    "source-text assertions grew. A test that reads a src/ file AS TEXT passes when the prose is right and " +
      "the behaviour is wrong, and breaks on a refactor that moved the prose and nothing else.\n" +
      grown.join("\n") +
      "\n  THE REMEDY, either one:\n" +
      "    (1) assert on BEHAVIOUR — import the symbol and call it — which is what the read was standing in for; or\n" +
      "    (2) if this test's SUBJECT genuinely IS the source text (a size/budget ratchet, a docs-claims\n" +
      `        check), declare it by putting ${SOURCE_TEXT_SUBJECT_MARKER} in the file and it stops being counted.\n` +
      "  Re-capturing the baseline upward is NOT a remedy — that is the ratchet this task exists to hold.",
  );
});

test("W1-T2905: a DECREASE is accepted, and the baseline says how to re-capture it", () => {
  const baseline = loadBaseline();
  const actual = censusSourceTextReads();
  const shrunk = Object.entries(baseline.files).filter(([f, n]) => (actual[f] ?? 0) < n);
  // Not an assertion that anything HAS shrunk — only that shrinking is never a failure, which is
  // what makes converting a file cheap rather than a fight with this gate.
  for (const [f, n] of shrunk) assert.ok((actual[f] ?? 0) < n, `${f} shrank from ${n} — accepted`);
  assert.match(baseline._comment, /re-capture/i, "the baseline states how to re-capture after a decrease");
  assert.match(baseline._comment, new RegExp(SOURCE_TEXT_SUBJECT_MARKER), "and names the declared exception");
  assert.match(baseline._comment, /never.*upward|NOT a remedy|never raise/i, "and that raising it is not a remedy");
});

// ── the predicate, both directions ─────────────────────────────────────────────────────────────

test("W1-T2905: the predicate counts BOTH spellings, and nothing that merely mentions a path", () => {
  assert.equal(countSourceTextReads('const s = readFileSync("../src/lib/x.ts", "utf8");'), 1, "the literal spelling");
  assert.equal(countSourceTextReads('readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");'), 1, "the joined spelling the audit's raw regex missed");
  assert.equal(countSourceTextReads('readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");'), 1, "and the URL spelling");
  assert.equal(countSourceTextReads('readFileSync(`${root}/src/lib/serve.ts`, "utf8");'), 1, "and the INTERPOLATED spelling, the one real site a quote-anchored predicate missed");
  assert.equal(countSourceTextReads('readFileSync("src/run-task.ts", "utf8");'), 1, "and the bare repo-relative spelling");

  assert.equal(countSourceTextReads('const fixture = { path: "src/config.ts" };'), 0, "a path in FIXTURE DATA is not a read");
  assert.equal(countSourceTextReads('readFileSync(join(dir, "tmp.json"), "utf8"); const other = "src/lib/x.ts";'), 0,
    "and a src/ literal elsewhere in the file is not attributed to an unrelated readFileSync");
  assert.equal(countSourceTextReads('readFileSync(join(REPO_ROOT, "plan", "tasks.yaml"), "utf8");'), 0, "reading a non-src path is not this shape");
  assert.equal(countSourceTextReads('readFileSync(`${root}/notsrc/lib/x.ts`, "utf8");'), 0, "src/ must BEGIN the segment — notsrc/ is not a match");
});

test("W1-T2905: a file whose SUBJECT is the source text declares itself and stops being counted", () => {
  const body = 'const s = readFileSync("../src/lib/x.ts", "utf8");';
  assert.equal(countSourceTextReads(body), 1, "counted by default");
  assert.equal(countSourceTextReads(`// ${SOURCE_TEXT_SUBJECT_MARKER}: this suite's subject IS the file's text.\n${body}`), 0, "and excluded once declared");
});

test("W1-T2905: the census is enumerated from the TREE, so a suite added in the same commit is counted by the run that adds it", () => {
  const actual = censusSourceTextReads();
  // The control that makes that a measurement rather than a claim: every counted file is really a
  // tracked test file, and re-running the enumeration agrees with git's own list.
  const tracked = new Set(
    execFileSync("git", ["ls-files", "test/*.test.ts"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean),
  );
  for (const f of Object.keys(actual)) assert.ok(tracked.has(f), `${f} was counted but is not a tracked test file`);
  assert.ok(tracked.size > Object.keys(actual).length, "and not every test file reads source text — the census discriminates");
});

test("W1-T2905: the argument extractor stops at the call's OWN close paren, nesting and all", () => {
  const s = 'readFileSync(join(a, "b"), "utf8"); after("src/x.ts");';
  assert.equal(readCallArgs(s, s.indexOf("readFileSync(") + "readFileSync".length), 'join(a, "b"), "utf8"');
  // The falsifier for the window this replaced: a src/ literal AFTER the call must not be reached.
  assert.ok(!readCallArgs(s, s.indexOf("readFileSync(") + "readFileSync".length).includes("src/"));
  assert.equal(readCallArgs("readFileSync(unterminated", "readFileSync".length), "", "an unterminated call yields nothing rather than the rest of the file");
});

test("W1-T2905: this census file is EXCLUDED from its own count, because it declares the marker", () => {
  const self = readFileSync(join(REPO_ROOT, "test", "source-text-assertion-census.test.ts"), "utf8");
  assert.ok(self.includes(SOURCE_TEXT_SUBJECT_MARKER), "the file declares the marker");
  assert.equal(countSourceTextReads(self), 0, "so it counts zero");
  // And the control that makes that a property rather than a tautology: with the declaration
  // stripped, the file's own fixture strings DO read as the shape — which is why it must declare.
  const stripped = self.split(SOURCE_TEXT_SUBJECT_MARKER).join("MARKER_REMOVED");
  assert.ok(countSourceTextReads(stripped) > 0, "and without the declaration it would count itself");
  assert.equal(censusSourceTextReads()["test/source-text-assertion-census.test.ts"], undefined, "so the census never lists it");
});
