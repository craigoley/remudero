/**
 * test/a-new-ci-yml-job-cannot-ship-its-own-registration.test.ts — W1-T2738.
 *
 * W1-T2521 carved the introducing-commit circularity out of Rule 25, and the carve-out works: a
 * brand-new `scripts/<name>-ratchet.mjs` shipped with its own first `CI_PARITY_TABLE` entry reads
 * not-entangled. It cannot reach a ci.yml JOB, and one fact separates the two cases —
 * `isIntroducingCensusGate`'s second condition is `fileIsNewInDiff(diff, scriptFile)`, where
 * `scriptFile` is the INSTRUMENT path. A job added to `.github/workflows/ci.yml` is an edit of a
 * file that has existed since the repo did, so that condition is false however new the job, its
 * script and its registration are.
 *
 * MEASURED AT origin/main BEFORE THIS FILE EXISTED, all four against the shipped predicate:
 *   CONTROL  new scripts/foo-ratchet.mjs + a parity add naming its stem  -> entangled FALSE
 *   THE GAP  new ci.yml job + new script + its parity entry              -> entangled TRUE
 *   NEGATIVE ci.yml edited beside an ordinary src/lib/drain.ts statement -> entangled TRUE
 *   NO_ENTRY new ci.yml job + src change, no parity add                  -> entangled TRUE
 * Only the second is wrong, and only it changes here.
 *
 * AND THE SPLIT ORDERINGS ARE CLOSED, so this is not one refusal but three.
 * `test/preflight-ci-parity.test.ts` asserts `CI_PARITY_TABLE` in BOTH directions — no entry for a
 * job ci.yml does not define, and no real job without an entry — and both fail on `main`, not
 * merely on a PR. With entanglement closing the third ordering a new ci.yml job has no admissible
 * sequence at all.
 *
 * THE CARVE-OUT KEYS ON THE REGISTERED UNIT, NOT THE FILE. A new job is introduced when ci.yml
 * gains a job KEY and `src/lib/ci-parity.ts` gains a line registering THAT job by name. The
 * registration is what makes the added key a job rather than, say, a new `on:` trigger — which
 * carries the identical two-space `key:` shape and is pinned below precisely because a shape-only
 * reading would mistake it for one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectInstrumentEntanglement } from "../src/lib/review.js";

/** A real `git diff` block for a brand-new file — carries the `new file mode` and `/dev/null` markers
 *  `fileIsNewInDiff` actually reads, never a hand-waved approximation of them. */
function newFile(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    `+${line}`,
    "",
  ].join("\n");
}

/** A real `git diff` block for an EDIT to a file that already existed — no new-file marker. */
function edit(path: string, added: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -10,3 +10,4 @@ context",
    " keep",
    `+${added}`,
    " keep",
    "",
  ].join("\n");
}

function verdict(diff: string): { entangled: boolean; instrumentPaths: string[]; srcPaths: string[] } {
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!);
  return detectInstrumentEntanglement(files, diff);
}

const CI_YML = ".github/workflows/ci.yml";
const PARITY = "src/lib/ci-parity.ts";
const jobKey = (name: string) => `  ${name}:`;
const parityEntry = (job: string, script: string) => `  { job: "${job}", script: "${script}", reason: "same-class" },`;

test("W1-T2738: a new ci.yml job shipped with its script and its parity entry is not refused", () => {
  const diff =
    edit(CI_YML, jobKey("unwired-gate")) +
    newFile("scripts/unwired-gate-check.mjs", "export const check = 1;") +
    edit(PARITY, parityEntry("unwired-gate", "unwired-gate-check"));

  const r = verdict(diff);
  assert.equal(r.entangled, false, "the only ordering left open to a new ci.yml job must not be refused");
  // The raw evidence is NOT rewritten — same discipline W1-T2521 states for its own carve-out, and
  // what lets the negative controls below prove the carve-out is doing the work.
  assert.deepEqual(r.instrumentPaths, [CI_YML]);
  assert.deepEqual(r.srcPaths, [PARITY]);
});

test("W1-T2738: W1-T2521's own case still reads not-entangled — this extends that carve-out, never replaces it", () => {
  const diff =
    newFile("scripts/foo-ratchet.mjs", "export const x = 1;") +
    edit(PARITY, parityEntry("foo", "foo-ratchet"));

  assert.equal(verdict(diff).entangled, false, "the pre-existing carve-out must keep firing unchanged");
});

test("W1-T2738: an EXISTING ci.yml job edited beside ordinary src code is still refused — Rule 25 is not retired", () => {
  const diff =
    edit(CI_YML, "        run: npm run something-else") +
    edit("src/lib/drain.ts", "  const unrelated = 1;");

  const r = verdict(diff);
  assert.equal(r.entangled, true, "editing a workflow beside product code is exactly what Rule 25 exists to catch");
  assert.deepEqual(r.instrumentPaths, [CI_YML]);
});

test("W1-T2738: a new ci.yml job with NO matching parity entry gets no carve-out", () => {
  const diff =
    edit(CI_YML, jobKey("unwired-gate")) +
    newFile("scripts/unwired-gate-check.mjs", "export const check = 1;") +
    edit("src/lib/drain.ts", "  const unrelated = 1;");

  assert.equal(verdict(diff).entangled, true, "the registration is what introduces the job — without it there is nothing to carve out");
});

test("W1-T2738: a parity entry naming a DIFFERENT job does not carve out the one ci.yml added", () => {
  const diff =
    edit(CI_YML, jobKey("unwired-gate")) +
    edit(PARITY, parityEntry("some-other-job", "some-other-script"));

  assert.equal(verdict(diff).entangled, true, "the added key and the registered job must be the SAME unit, not merely co-present");
});

test("W1-T2738: an added `on:` TRIGGER is not a job — the same two-space shape must not carve anything out", () => {
  // `on:`'s children (`pull_request:`, `push:`) are indented exactly like a job key, so a
  // shape-only reading would treat adding a trigger as introducing a job. Nothing registers a
  // trigger in CI_PARITY_TABLE, which is what tells them apart.
  const diff =
    edit(CI_YML, jobKey("pull_request")) +
    edit("src/lib/drain.ts", "  const unrelated = 1;");

  assert.equal(verdict(diff).entangled, true, "a trigger addition beside src code stays entangled");
});

test("W1-T2738: the path-only reading is unchanged — a caller that cannot supply the diff still fails closed", () => {
  const files = [CI_YML, "scripts/unwired-gate-check.mjs", PARITY];
  assert.equal(
    detectInstrumentEntanglement(files).entangled,
    true,
    "without the patch there is no way to tell a new job from an edited one, so the stricter reading stands",
  );
});
