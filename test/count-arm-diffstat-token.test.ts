import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyContradictsDiff } from "../src/lib/review.js";

// ── W1-T2224 ─────────────────────────────────────────────────────────────────
//
// THE THIRD FALSE POSITIVE ON THE SAME LINE. The count arm's enumeration group
// (`([^\s,]+(?:\s*,\s*[^\s,]+)*)`) accepts any whitespace-free, comma-separated
// token, and `looksLikePath` admits anything containing a `.` or a `/`. PR
// #1192 (W1-T288, a backtick-wrapped path) and PR #1209 (W1-T304, a
// paren-wrapped path) each broke exact-string `includes` the same way: a REAL,
// correctly-enumerated file whose exact TEXT no longer matched `diffFiles`
// once something else was glued around it. A compact diffstat token — a
// numstat triple, a `--stat` line joined by `|`, a trailing `+N/-M` — is the
// same shape of failure, not a new one: the real path is still IN the token,
// just decorated by characters no fixed strip class anticipated.
//
// The fix (src/lib/review.ts, `enumeratedTokenMatchesChangeset`) stops
// deciding membership from the token's punctuation and decides it against the
// contract the caller already holds — `diffFiles` — via exact match, an
// unambiguous suffix/basename match, or an unambiguous embedded match.

test("bodyContradictsDiff: a compact diffstat token appended after a comma is no longer a contradiction", () => {
  // The live shape: a numstat-style "insertions/deletions/path" triple, pasted straight into the
  // enumeration as an extra comma item rather than replacing the real one. The real path
  // (`src/lib/review.ts`) is embedded intact inside the token, decorated only by the leading
  // "12/3/" a fixed backtick/paren strip could never anticipate.
  const diff = ["src/lib/review.ts", "test/count-arm-diffstat-token.test.ts"];
  const body =
    "This PR touches exactly 2 files: `src/lib/review.ts`, `test/count-arm-diffstat-token.test.ts`, " +
    "12/3/src/lib/review.ts.";

  assert.deepEqual(bodyContradictsDiff(body, diff), [], "a true claim decorated by a diffstat token must be silence");
});

test("bodyContradictsDiff: a `--stat`-style pipe-joined diffstat token is also silence", () => {
  // The second reproducing shape from the same family: `git diff --stat`'s own "path | N +++---"
  // line, compacted to a single whitespace-free token and appended the same way.
  const diff = ["src/lib/review.ts"];
  const body = "This PR touches exactly 1 file: `src/lib/review.ts`, src/lib/review.ts|12+++++-----.";

  assert.deepEqual(bodyContradictsDiff(body, diff), [], "a pipe-joined diffstat token must not itself contradict");
});

test("bodyContradictsDiff: the two prior wrapper fixtures still pass unchanged (PR #1192, PR #1209)", () => {
  // PR #1192 (W1-T288): backtick-wrapped enumeration items.
  const backtickBody =
    "This PR touches exactly 3 files: `src/lib/panel-actions.ts`, `src/lib/serve.ts`, " +
    "`test/control-status-daemon-liveness.test.ts`.";
  const backtickDiff = ["src/lib/panel-actions.ts", "src/lib/serve.ts", "test/control-status-daemon-liveness.test.ts"];
  assert.deepEqual(bodyContradictsDiff(backtickBody, backtickDiff), [], "backtick-wrapped true enumeration stays silent");

  // PR #1209 (W1-T304): a parenthesised enumeration whose final item carries a trailing paren.
  const parenBody =
    "(this changeset is exactly 2 files: `src/lib/review.ts`, `test/review-failure-reason-ledgered.test.ts`)";
  const parenDiff = ["src/lib/review.ts", "test/review-failure-reason-ledgered.test.ts"];
  assert.deepEqual(bodyContradictsDiff(parenBody, parenDiff), [], "paren-wrapped true enumeration stays silent");
});

test("bodyContradictsDiff: a genuinely wrong count is still reported", () => {
  const diff = ["src/lib/review.ts", "test/count-arm-diffstat-token.test.ts"];
  const body = "This PR touches exactly 3 files: `src/lib/review.ts`, `test/count-arm-diffstat-token.test.ts`.";

  const hits = bodyContradictsDiff(body, diff);
  assert.equal(hits.length, 1, "a wrong file count must still contradict");
});

test("bodyContradictsDiff: a genuinely wrong enumerated filename is still reported", () => {
  // Same shape as test/body-contradicts-diff.test.ts's NOT-IN-DIFF.ts fixture: correct count,
  // one real file, one WRONG file that shares no substring with anything in `diffFiles` — not a
  // decorated real path, an actual typo. `enumeratedTokenMatchesChangeset` must not paper over it.
  const diff = ["src/lib/serve.ts", "src/lib/panel-actions.ts"];
  const body = "This PR touches exactly 2 files: `src/lib/serve.ts`, `src/lib/NOT-IN-DIFF.ts`.";

  const hits = bodyContradictsDiff(body, diff);
  assert.equal(hits.length, 1, "a wrong enumerated file must still contradict, decorated-token fix or not");
});

test("bodyContradictsDiff: an extensionless enumerated path is no less visible than it is today", () => {
  // `looksLikePath` (unchanged by this fix) requires a `.` or `/`, so an extensionless name like
  // `Makefile` was ALREADY filtered out of the enumeration arm before this fix — never checked
  // against `diffFiles` either way. This is a known, out-of-scope limitation (W1-T2224 design
  // (vi)); the assertion below pins that this fix does not make it any MORE invisible, i.e. a
  // wrongly-enumerated `Makefile` still produces no contradiction from the enumeration arm — same
  // as before.
  const diff = ["src/lib/other.ts"]; // Makefile is NOT actually part of the changeset
  const body = "This PR touches exactly 1 file: Makefile.";

  assert.deepEqual(bodyContradictsDiff(body, diff), [], "extensionless tokens stay invisible to this arm, unchanged");
});

test("bodyContradictsDiff: the quotation guard is unchanged and a fenced example is still silenced", () => {
  // stripQuotedRegions (untouched by this fix) blanks fenced code blocks before any arm scans the
  // body, so a body that merely QUOTES a failing claim — as this PR's own description of the bug
  // must — is not itself judged as making that claim.
  const diff = ["src/lib/review.ts"];
  const body =
    "This PR fixes a false positive. For example, this used to fail:\n" +
    "```\n" +
    "This PR touches exactly 2 files: `src/lib/review.ts`, 12/3/src/lib/review.ts.\n" +
    "```\n" +
    "This PR itself touches exactly 1 file: `src/lib/review.ts`.";

  assert.deepEqual(bodyContradictsDiff(body, diff), [], "a fenced example of the bug must not itself be read as a claim");
});
