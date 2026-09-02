// W1-T2596 — A CHECK THAT NAMES ITS OWN ESCAPE HATCH GETS ESCAPED.
//
// Two census gates print their own bypass in the failure text a fix worker reads:
//   config-reader-seams:  "...or add an ALLOWED entry saying why it needs none."
//   route-scope-matrix:   a route excused from the scope sweep needs only `selfAuthenticated: true`
//                          plus the reviewed SELF_AUTHENTICATED table (#3535 built that shape by
//                          hand for one route; nothing yet enforces it as a RULE for the next one).
//
// A fix rung optimises for green BY CONSTRUCTION. A gate whose message names a cheaper compliant
// answer than the real fix will, over enough dispatches, get the cheaper answer — MEASURED on
// #3535, where the printed hatch would have satisfied config-reader-seams while `rmd serve` still
// refused to boot on any checkout with no plan/policy.yaml.
//
// THIS FILE DOES NOT CHANGE WHAT EITHER GATE DETECTS (out of scope, W1-T2596's own rationale).
// It pins the shape of the two hatches themselves: an exemption must be a REVIEWED,
// hand-enumerated entry naming CONCRETE evidence (a test file, a call-site argument, the reader's
// own defining role) — never a free-text reason a worker can fill in and never a silent `continue`
// — and both hatches must stay OPEN for the real cases they exist for.
//
// READ, NEVER IMPORTED. Importing test/config-reader-seams.test.ts or test/route-scope-matrix.test.ts
// as a module would re-execute every `test(...)` registration those files make (Node's test runner
// gives each `*.test.ts` its own subprocess with an empty module cache, so a same-process import
// re-runs the imported file's top-level code) — silently doubling their suites under this file's
// name. Every assertion below reads the other files' SOURCE TEXT instead, the same technique
// test/a-size-ledger-is-not-a-score-floor.test.ts and test/a-new-census-gate-cannot-ship-itself.test.ts
// use to pin a hand-enumerated constant without re-running the module that declares it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_READER_SEAMS_PATH = join(REPO_ROOT, "test", "config-reader-seams.test.ts");
const ROUTE_SCOPE_MATRIX_PATH = join(REPO_ROOT, "test", "route-scope-matrix.test.ts");

const configReaderSeamsSrc = readFileSync(CONFIG_READER_SEAMS_PATH, "utf8");
const routeScopeMatrixSrc = readFileSync(ROUTE_SCOPE_MATRIX_PATH, "utf8");

/**
 * Every entry in config-reader-seams.test.ts's `ALLOWED` array, sliced out of the SOURCE TEXT —
 * `{ file, symbol, block }` where `block` is everything from that entry's own `file:`/`symbol:`
 * header up to the next entry's header (or the array's end). Slicing to "the next header" rather
 * than hunting for a matching closing brace survives the reason field's own multi-line `"..." +`
 * concatenation without needing to parse it.
 */
function extractAllowedEntries(src: string): Array<{ file: string; symbol: string; block: string }> {
  const arrayStart = src.indexOf("[", src.indexOf("const ALLOWED"));
  const arrayEnd = src.indexOf("\n];", arrayStart);
  const body = src.slice(arrayStart, arrayEnd);
  const headerRe = /\{\s*\n\s*file:\s*"([^"]+)",\s*\n\s*symbol:\s*"([^"]+)",/g;
  const headers = [...body.matchAll(headerRe)];
  return headers.map((m, i) => {
    const start = m.index as number;
    const end = i + 1 < headers.length ? (headers[i + 1].index as number) : body.length;
    return { file: m[1], symbol: m[2], block: body.slice(start, end) };
  });
}

/**
 * Every entry in route-scope-matrix.test.ts's `SELF_AUTHENTICATED` array, sliced the same way.
 */
function extractSelfAuthenticatedEntries(src: string): Array<{ path: string; refusedBy: string; provenBy: string }> {
  const arrayStart = src.indexOf("[", src.indexOf("const SELF_AUTHENTICATED"));
  const arrayEnd = src.indexOf("\n];", arrayStart);
  const body = src.slice(arrayStart, arrayEnd);
  const paths = [...body.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  const refusedBys = [...body.matchAll(/refusedBy:\s*"([^"]+)"/g)].map((m) => m[1]);
  const provenBys = [...body.matchAll(/provenBy:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(refusedBys.length, paths.length, "extraction sanity: one refusedBy per path");
  assert.equal(provenBys.length, paths.length, "extraction sanity: one provenBy per path");
  return paths.map((path, i) => ({ path, refusedBy: refusedBys[i], provenBy: provenBys[i] }));
}

const allowedEntries = extractAllowedEntries(configReaderSeamsSrc);
const selfAuthenticatedEntries = extractSelfAuthenticatedEntries(routeScopeMatrixSrc);

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Claim 1 — "a reader excused from the seam requirement is named in a reviewed, hand-enumerated
// list rather than admitted by free text a worker can supply"
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("W1-T2596 claim 1: config-reader-seams' printed hatch demands checkable EVIDENCE, not merely a reason", () => {
  // Locks the wording change this task makes to the failure text: it must no longer read as "add
  // an entry saying why" (any prose clears that bar) — it must say the entry needs evidence a
  // reviewer can independently check.
  assert.match(
    configReaderSeamsSrc,
    /CONCRETE, checkable EVIDENCE/,
    "the seam gate's failure text must demand concrete evidence for an exemption, not just a reason",
  );
});

test("W1-T2596 claim 1: every ALLOWED entry actually carries that evidence today — the bar is real, not merely printed", () => {
  const EVIDENCE_RE = /test\/[\w.-]+\.test\.ts|MEASURED SAFE|passed as an argument|takes an explicit|own body|W1-T\d+/;
  assert.ok(allowedEntries.length > 0, "sanity: the allowlist is not empty");
  for (const e of allowedEntries) {
    assert.match(
      e.block,
      EVIDENCE_RE,
      `${e.file}:${e.symbol} — reason names no test file, measurement, argument seam, W1 task, or ` +
        "defining role a reviewer could check; a plausible sentence alone must not satisfy this",
    );
  }
});

test("W1-T2596 claim 1: an ALLOWED entry is an EXACT file+symbol pair, never a pattern that could blanket-exempt more than the one reviewed site", () => {
  for (const e of allowedEntries) {
    assert.doesNotMatch(e.file, /[*?[\]{}]/, `${e.file}: an allowlisted path must be literal, not a glob`);
    assert.doesNotMatch(e.symbol, /[*?[\]{}]/, `${e.symbol}: an allowlisted symbol must be a literal substring, not a pattern`);
  }
  // The matcher itself (allowedEntryFor, config-reader-seams.test.ts) requires BOTH an exact file
  // match and a literal symbol substring — asserted here on the matcher's own source, since
  // re-deriving readers from src/ would duplicate the detection this task must not touch.
  assert.match(
    configReaderSeamsSrc,
    /ALLOWED\.find\(\(a\) => a\.file === r\.file && r\.text\.includes\(a\.symbol\)\)/,
    "the allowlist match must stay an exact file === plus a literal symbol substring check",
  );
});

test("W1-T2596 claim 1: a new reader — seamed or allowlisted — cannot land invisibly, because the census is pinned to an EXACT count", () => {
  // A `>=` bound would let a fresh ALLOWED entry (or a fresh unredirectable read) accumulate
  // without ever moving a number a reviewer's eye catches in the diff.
  assert.match(
    configReaderSeamsSrc,
    /assert\.equal\(readers\.length, \d+,/,
    "the calibration test must pin the reader count with exact equality",
  );
  assert.doesNotMatch(configReaderSeamsSrc, /readers\.length >=\s*\d/, "a tolerant bound would let new readers accumulate invisibly");
});

test("W1-T2596 claim 1: an allowlisted reader that gains a seam is refused, not left allowlisted — the hatch cannot be kept open by faking one", () => {
  assert.match(configReaderSeamsSrc, /STALE-ENTRY LOCK/);
  assert.match(
    configReaderSeamsSrc,
    /const stale = readers\.filter\(\(r\) => r\.hasSeam && allowedEntryFor\(r\)\)/,
    "the stale-entry lock must actually filter on hasSeam AND an allowlist match",
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Claim 2 — "a route excused from the scope sweep must name what refuses it instead and the suite
// proving that refusal, so the exemption cannot be a silent exit"
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("W1-T2596 claim 2: every SELF_AUTHENTICATED entry names a refusal mechanism and a real, existing suite that proves it", () => {
  assert.ok(selfAuthenticatedEntries.length > 0, "sanity: at least the #3535 entry exists");
  for (const e of selfAuthenticatedEntries) {
    assert.ok(e.refusedBy.length >= 20, `${e.path}: refusedBy must describe a real mechanism, not a placeholder`);

    const provenFile = e.provenBy.split(/\s/)[0];
    assert.match(provenFile, /^test\/[\w.-]+\.test\.ts$/, `${e.path}: provenBy must lead with a real test file path, saw ${JSON.stringify(e.provenBy)}`);
    assert.ok(existsSync(join(REPO_ROOT, provenFile)), `${e.path}: provenBy names ${provenFile}, which must exist on disk`);

    // The provenBy text names the refusal codes it claims ("-> 401", "-> 403"); the suite it points
    // at must actually assert every one, not merely be a plausibly-named file.
    const codes = [...e.provenBy.matchAll(/(\d{3})/g)].map((m) => m[1]);
    assert.ok(codes.length > 0, `${e.path}: provenBy must name the refusal code(s) it proves`);
    const provenSrc = readFileSync(join(REPO_ROOT, provenFile), "utf8");
    for (const code of codes) {
      assert.ok(provenSrc.includes(code), `${e.path}: ${provenFile} must actually assert ${code}, the code provenBy claims it proves`);
    }
  }
});

test("W1-T2596 claim 2: setting selfAuthenticated cannot exit the audit silently — the sweep checks membership against the reviewed table before any route is skipped", () => {
  const testStart = routeScopeMatrixSrc.indexOf('test("every route in the REAL table is refused without its scope');
  assert.notEqual(testStart, -1, "the sweep test must exist");
  const testEnd = routeScopeMatrixSrc.indexOf("readFileSync(deps.ledgerPath", testStart);
  const body = routeScopeMatrixSrc.slice(testStart, testEnd);

  const membershipIdx = body.indexOf("SELF_AUTHENTICATED.map((e) => e.path).sort()");
  const skipIdx = body.indexOf("if (entry.selfAuthenticated) continue;");
  assert.ok(membershipIdx >= 0, "the sweep must assert the flagged set matches SELF_AUTHENTICATED exactly");
  assert.ok(skipIdx >= 0, "the sweep must skip probing a self-authenticated route (it carries no bearer semantics)");
  assert.ok(
    membershipIdx < skipIdx,
    "the membership assertion must run BEFORE any route can be skipped — otherwise a new " +
      "selfAuthenticated route with no reviewed table entry could exit the sweep before that " +
      "check ever ran",
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Claim 3 — "both excusal routes remain open for the real cases they exist for, so nothing is
// forced into a fake seam or a route dropped from the table"
// ══════════════════════════════════════════════════════════════════════════════════════════════

test("W1-T2596 claim 3: the seam allowlist still excuses at least one genuinely unseamable reader — the hatch was narrowed, not removed", () => {
  assert.ok(allowedEntries.length > 0, "an ALLOWED entry naming its own concrete evidence must still be possible");
});

test("W1-T2596 claim 3: SELF_AUTHENTICATED still excuses at least one genuinely self-authenticating route — it was not forced out of the table", () => {
  assert.ok(selfAuthenticatedEntries.length > 0, "a route that carries its own credential must still be excusable with a reviewed entry");
});

test("W1-T2596 claim 3: the real route matrix never filters a self-authenticated route out of the table — it is swept in and reviewed, not hidden", () => {
  const fnStart = routeScopeMatrixSrc.indexOf("function realMatrix");
  assert.notEqual(fnStart, -1, "realMatrix must exist");
  const fnEnd = routeScopeMatrixSrc.indexOf("\n}", fnStart);
  const fn = routeScopeMatrixSrc.slice(fnStart, fnEnd);
  assert.doesNotMatch(
    fn,
    /\.filter\(/,
    "realMatrix must not drop any route from the table — dropping selfAuthenticated routes here " +
      "would be the 'one continue' silent exit this task exists to close off",
  );
  // The flag itself must still be carried through, or the reviewed-membership check above has
  // nothing to compare against.
  assert.match(fn, /selfAuthenticated:\s*r\.selfAuthenticated/, "the self-authenticated flag must be preserved on every entry the matrix reports");
});
