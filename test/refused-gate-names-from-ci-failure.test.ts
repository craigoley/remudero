import assert from "node:assert/strict";
import { dirname, join as joinPath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { refusedGateNamesFromCiFailure, recordableRatchetRepairFor, ratifiedBaselineRatchetRepairFor } from "../src/lib/sweep.js";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a STATIC import of the .mjs is a TS7016 and
// fails typecheck — the same reason test/expiring-fixture-census.test.ts reaches its script this
// way. A dynamic specifier is not statically resolved, so this loads the REAL module with no
// shadow copy that could drift from it.
const REPO_ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = joinPath(REPO_ROOT, "scripts", "expiring-fixture-census.mjs");
const { refusedGateNamesFromReport } = (await import(pathToFileURL(SCRIPT).href)) as {
  refusedGateNamesFromReport: (text: string | undefined) => string[];
};

// W1-T3720 — A BUNDLED JOB REPORTS UNDER ONE GATE'S NAME WHILE A DIFFERENT GATE IS THE ONE THAT
// ACTUALLY REFUSED. MEASURED 2026-09-17: the same job log on five PRs reported
//
//   comment-load-ratchet: OK -- 354 measured file(s), ...; none over its ceiling, no added block over 25 lines.
//   ##[error]expiring-fixture-census: BLOCKED -- 1 fixture(s) CROSS their threshold within 7 day(s)
//
// under the single check-run name `comment-load-ratchet`. `refusedGateNamesFromReport`
// (scripts/expiring-fixture-census.mjs, the shared `emitCiReport` encoder's own home) recovers the
// gate that actually refused straight from the report's own `<gate>: BLOCKED|OK` first token, and
// `refusedGateNamesFromCiFailure` (src/lib/sweep.ts) is the consumer that trusts it over a bundled
// check-run's own `.name`.

const MEASURED_LOG_TAIL =
  "comment-load-ratchet: OK -- 354 measured file(s), 71142 comment lines against 143033 code lines " +
  "(33.2%); none over its ceiling, no added block over 25 lines.\n" +
  "##[error]expiring-fixture-census: BLOCKED -- 1 fixture(s) CROSS their threshold within 7 day(s)";

test("W1-T3720: a bundled job that fails names the gate that actually refused, taken from the gate's own report", () => {
  // The report's own first token says `expiring-fixture-census: BLOCKED`, so that is the gate this
  // resolves to — never the bundled check-run's own name, `comment-load-ratchet`, and never a
  // hand-written gate-to-job table (this task's own falsifier: fed a report from a gate no table
  // would know about, `web-vitals-ratchet` say, the derivation still finds it because it reads the
  // report text itself).
  assert.deepEqual(
    refusedGateNamesFromCiFailure({ name: "comment-load-ratchet", logTail: MEASURED_LOG_TAIL }),
    ["expiring-fixture-census"],
  );
  assert.deepEqual(refusedGateNamesFromReport("##[error]web-vitals-ratchet: BLOCKED -- a gate no table knows about"), [
    "web-vitals-ratchet",
  ]);
});

test("W1-T3720: a job where two bundled gates refuse names both rather than picking one", () => {
  const tail = "##[error]expiring-fixture-census: BLOCKED -- 1 fixture(s) CROSS their threshold within 7 day(s)\n" + "##[error]console-parity: BLOCKED -- 2 verb(s) map to no route and carry no cli-only reason";
  assert.deepEqual(refusedGateNamesFromCiFailure({ name: "comment-load-ratchet", logTail: tail }), [
    "console-parity",
    "expiring-fixture-census",
  ]);
});

test("W1-T3720: a passing job's reported name is unchanged, so a green board reads as it does today", () => {
  const allOk =
    "comment-load-ratchet: OK -- 354 measured file(s), 71142 comment lines against 143033 code lines " +
    "(33.2%); none over its ceiling, no added block over 25 lines.\n" +
    "expiring-fixture-census: OK -- 83 fixture stamp(s) measured, none crossing within 7 day(s).\n" +
    "console-parity: OK -- every verb maps to a route or a stated cli-only reason.";
  assert.deepEqual(refusedGateNamesFromCiFailure({ name: "comment-load-ratchet", logTail: allOk }), ["comment-load-ratchet"]);
  // A tail with no self-describing report at all (an ordinary test failure, a lint error) falls
  // back identically — nothing to derive from means nothing changes.
  assert.deepEqual(refusedGateNamesFromCiFailure({ name: "commitlint", logTail: "subject must not end with a period" }), [
    "commitlint",
  ]);
});

test("W1-T3720: renaming a bundled report never moves a required context", () => {
  // `redRequiredChecks` is GitHub's own required-context list (branch protection / ci-gate.yml) —
  // this derivation never reads or rewrites it, only the *evidence* keyed off `ciFailures[].name`.
  // Design note (iii): `ci-gate` still aggregates whatever GitHub actually reports; this fixes only
  // which gate's remedy surface a red check evidences.
  const pr = {
    redRequiredChecks: ["comment-load-ratchet"],
    ciFailures: [{ name: "comment-load-ratchet", logTail: MEASURED_LOG_TAIL }],
    mergeState: "clean" as const,
  };
  // The required CONTEXT itself is untouched — still literally "comment-load-ratchet".
  assert.deepEqual(pr.redRequiredChecks, ["comment-load-ratchet"]);
  // But the remedy dispatch now correctly recognizes the gate that actually refused
  // (`expiring-fixture-census`) is NOT a recordable-baseline ratchet, so it refuses to
  // mis-dispatch `comment-load-signal` — the wrong gate's remedy surface — against it.
  assert.equal(ratifiedBaselineRatchetRepairFor(pr), undefined);
  assert.equal(recordableRatchetRepairFor(pr), undefined);
  // The registry's OWN member still resolves correctly when its own report is the one that says
  // BLOCKED — the fix narrows what is misattributed, it does not blind the registry to a real hit.
  const genuineHit = {
    redRequiredChecks: ["comment-load-ratchet"],
    ciFailures: [{ name: "comment-load-ratchet", logTail: "##[error]comment-load-ratchet: BLOCKED -- 1 file(s) over their ceiling" }],
    mergeState: "clean" as const,
  };
  assert.deepEqual(ratifiedBaselineRatchetRepairFor(genuineHit), ["comment-load-ratchet"]);
});
