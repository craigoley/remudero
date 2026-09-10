// test/an-instrument-change-that-only-tightens-is-not-entanglement.test.ts — W1-T3133.
//
// Standing rule 25 grades the FILE, never the CHANGE. It refuses an instrument+product mixture
// because an instrument edit can weaken the very gate that would have caught the product regression
// riding beside it. That reason is sound and is kept. But the predicate read only PATHS, so it could
// not tell a baseline being LOOSENED from the same baseline being TIGHTENED, and refused both.
//
// MEASURED 2026-09-08: #4558 (`bound-kind-baseline.json`, removals only; `gh-transport-baseline.json`,
// new and pinned at 0) and #4566 (`error-subclass-baseline.json`, a new ceiling arriving with its own
// reader) both read `entangled: true` against 22 and 3 product paths — and both were unblocked only
// by hand-adding their paths to ENTANGLEMENT_EXEMPT_INSTRUMENTS, a PER-FILE list that also blesses
// every future loosening of those same files. This task adds a per-CHANGE axis beside it.
//
// THE DANGEROUS HALF IS THE DIRECTION TABLE. For a size/count LEDGER a lower number is stricter; for
// a SCORE FLOOR a higher one is. Getting that backwards inverts the carve-out and admits exactly the
// loosening rule 25 exists to refuse — so the table is declared, and anything it does not name is
// `undetermined` and stays fully blocking.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENTANGLEMENT_EXEMPT_INSTRUMENTS,
  classifyInstrumentChange,
  detectInstrumentEntanglement,
} from "../src/lib/review.js";

const SRC = "src/lib/some-product.ts";
/** A `-baseline.json` NOT in ENTANGLEMENT_EXEMPT_INSTRUMENTS, so the path axis cannot decide. */
const LEDGER = "scripts/some-ledger-baseline.json";
const FLOOR = "scripts/mutation-baseline.json";

const srcHunk = [
  `diff --git a/${SRC} b/${SRC}`,
  `--- a/${SRC}`,
  `+++ b/${SRC}`,
  "@@ -1,2 +1,3 @@",
  "+export const somethingExecutable = 1;",
];

const patch = (file: string, body: string[], opts: { newFile?: boolean } = {}): string =>
  [
    `diff --git a/${file} b/${file}`,
    ...(opts.newFile ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${file}`]),
    `+++ b/${file}`,
    "@@ -1,4 +1,4 @@",
    ...body,
    ...srcHunk,
  ].join("\n");

// ── acceptance 1: removals only ──────────────────────────────────────────────────────────────────

test("W1-T3133: an instrument edit that only REMOVES grandfathered entries is not entanglement, and ADDING one is", () => {
  const removalsOnly = patch(LEDGER, ['-  "src/lib/a.ts": 3,', '-  "src/lib/b.ts": 4,']);
  const removed = detectInstrumentEntanglement([LEDGER, SRC], removalsOnly);
  assert.equal(removed.entangled, false, "strictly fewer exemptions cannot hide a product regression");
  assert.deepEqual(removed.instrumentPaths, [LEDGER], "the evidence is still reported unedited");
  assert.deepEqual(removed.srcPaths, [SRC], "and so is the src/ half — the subtraction is on the VERDICT only");

  // THE DISCRIMINATOR: identical shape, one entry ADDED instead of removed.
  const added = detectInstrumentEntanglement([LEDGER, SRC], patch(LEDGER, ['+  "src/lib/brand-new.ts": 3,']));
  assert.equal(added.entangled, true, "a new grandfather entry for a pre-existing file still refuses");
});

// ── acceptance 2: direction, for a LEDGER and a FLOOR independently ──────────────────────────────

test("W1-T3133: a bound moved the STRICTER way is exempt and the other way is refused — opposite senses for a ledger and a floor", () => {
  // LEDGER: lower is stricter.
  const ledgerDown = patch(LEDGER, ['-  "src/lib/a.ts": 40,', '+  "src/lib/a.ts": 30,']);
  const ledgerUp = patch(LEDGER, ['-  "src/lib/a.ts": 30,', '+  "src/lib/a.ts": 40,']);
  assert.equal(detectInstrumentEntanglement([LEDGER, SRC], ledgerDown).entangled, false, "ledger lowered = tighter");
  assert.equal(detectInstrumentEntanglement([LEDGER, SRC], ledgerUp).entangled, true, "ledger raised = looser");

  // FLOOR: higher is stricter — the OPPOSITE sense, which is why the table cannot be guessed.
  const floorUp = patch(FLOOR, ['-  "score": 60,', '+  "score": 70,']);
  const floorDown = patch(FLOOR, ['-  "score": 70,', '+  "score": 60,']);
  assert.equal(detectInstrumentEntanglement([FLOOR, SRC], floorUp).entangled, false, "floor raised = tighter");
  assert.equal(
    detectInstrumentEntanglement([FLOOR, SRC], floorDown).entangled,
    true,
    "floor lowered = looser — an INVERTED table would admit exactly this",
  );
});

// ── acceptance 3: undeclared, and one unparseable hunk, both stay blocking ───────────────────────

test("W1-T3133: an instrument with NO declared direction stays blocking, however its numbers moved", () => {
  const undeclared = ".github/workflows/ci.yml";
  const d = classifyInstrumentChange(patch(undeclared, ["-  timeout-minutes: 40", "+  timeout-minutes: 10"]), [undeclared, SRC], undeclared);
  assert.equal(d, "undetermined", "no row in the direction table ⇒ no opinion ⇒ no exemption");
  assert.equal(detectInstrumentEntanglement([undeclared, SRC], patch(undeclared, ["-  a: 40", "+  a: 10"])).entangled, true);
});

test("W1-T3133: ONE unparseable hunk makes the whole file undetermined, never skipped beside tightening ones", () => {
  // A genuine tightening line AND a line the parser cannot account for. Grading the file on the
  // half it understood is exactly how a loosening edit would ride in unnoticed.
  const mixed = patch(LEDGER, ['-  "src/lib/a.ts": 40,', '+  "src/lib/a.ts": 30,', "+  some free prose that is not a row"]);
  assert.equal(classifyInstrumentChange(mixed, [LEDGER, SRC], LEDGER), "undetermined");
  assert.equal(detectInstrumentEntanglement([LEDGER, SRC], mixed).entangled, true);
});

// ── acceptance 4: an introduced instrument needs a reader in the same diff ───────────────────────

test("W1-T3133: a NEW instrument is admitted only when a reader of it changes in the same diff", () => {
  const reader = "test/some-ledger-census.test.ts";
  const withReader = [
    `diff --git a/${LEDGER} b/${LEDGER}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${LEDGER}`,
    "@@ -0,0 +1,3 @@",
    '+{ "directThing": 0 }',
    `diff --git a/${reader} b/${reader}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${reader}`,
    "@@ -0,0 +1,2 @@",
    `+import baseline from "../${LEDGER}";`,
    "+// reads some-ledger-baseline and refuses a count above it",
    ...srcHunk,
  ].join("\n");
  assert.equal(classifyInstrumentChange(withReader, [LEDGER, reader, SRC], LEDGER), "introduced");
  assert.equal(detectInstrumentEntanglement([LEDGER, reader, SRC], withReader).entangled, false);

  // A lone new baseline nothing reads must NOT buy the exemption — that is how a lax bound would be
  // pre-placed for a later PR to spend.
  const alone = [
    `diff --git a/${LEDGER} b/${LEDGER}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${LEDGER}`,
    "@@ -0,0 +1,3 @@",
    '+{ "directThing": 0 }',
    ...srcHunk,
  ].join("\n");
  assert.equal(classifyInstrumentChange(alone, [LEDGER, SRC], LEDGER), "undetermined");
  assert.equal(detectInstrumentEntanglement([LEDGER, SRC], alone).entangled, true);
});

// ── acceptance 5: a new key is admitted only for a file this diff ADDS ───────────────────────────

test("W1-T3133: a new baseline key naming a file this diff ADDS is admitted; the same key for a pre-existing file is not", () => {
  const NEWSRC = "src/lib/brand-new.ts";
  const addsFile = [
    `diff --git a/${LEDGER} b/${LEDGER}`,
    `--- a/${LEDGER}`,
    `+++ b/${LEDGER}`,
    "@@ -1,3 +1,4 @@",
    '-  "src/lib/a.ts": 40,',
    '+  "src/lib/a.ts": 30,',
    `+  "${NEWSRC}": 12,`,
    `diff --git a/${NEWSRC} b/${NEWSRC}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${NEWSRC}`,
    "@@ -0,0 +1,2 @@",
    "+export const brandNew = 1;",
    ...srcHunk,
  ].join("\n");
  assert.equal(
    classifyInstrumentChange(addsFile, [LEDGER, NEWSRC, SRC], LEDGER),
    "tightening",
    "a key for a file with no prior bound cannot loosen anything",
  );

  // The loophole this closes: the identical key for a file that already existed.
  const preExisting = patch(LEDGER, ['-  "src/lib/a.ts": 40,', '+  "src/lib/a.ts": 30,', '+  "src/lib/already-here.ts": 900,']);
  assert.equal(classifyInstrumentChange(preExisting, [LEDGER, SRC], LEDGER), "undetermined");
});

// ── acceptance 6: evidence unedited, and the per-file list untouched ─────────────────────────────

test("W1-T3133: the per-FILE exemption set is unchanged — this task adds an axis beside it, not instead of it", () => {
  // W1-T2891 took this from seven to nine. THE ASSERTION'S POINT SURVIVES THE BUMP: it is not "the
  // set never changes" — a reviewed addition is exactly how the set is meant to grow — it is that
  // W1-T3133's TIGHTENING AXIS did not quietly replace the per-path list. The four names below are
  // the ones that existed when this control was written and they are all still exempt by path, which
  // is the property this test actually holds.
  //
  // THIS IS THE THIRD TRIPWIRE ON THIS SET, and I found it by breaking it: W1-T2891's own commit
  // claimed there were two (test/a-size-ledger-is-not-a-score-floor.test.ts and
  // test/instrument-isolation.test.ts) because those were the two that reddened first. A count that
  // has to be edited in three places is friction working, but only if a later author can find all
  // three — so each of the three now names the other two.
  assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.size, 9, "the reviewed per-path list keeps exactly its entries");
  for (const named of [
    "scripts/knowledge-budget-baseline.json",
    "scripts/source-size-baseline.json",
    "scripts/comment-load-baseline.json",
    "scripts/clock-signature-baseline.json",
  ]) {
    assert.ok(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(named), `${named} is still exempt by path`);
  }
});
