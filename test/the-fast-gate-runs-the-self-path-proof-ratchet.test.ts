import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CENSUS_ADMITTED_MEMBERS,
  FAST_GATE_STEPS,
  runPreflightFast,
} from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// THE GAP THIS CLOSES. `census:self-path-proof` ratchets each shard's self-path proof count, and a
// plan-only PR can fail it — #6596 did, on 2026-09-22, taking one shard from its baseline of 5 to
// 8. That refusal arrived as `ci-shard (2/4)` FAILURE after a full instrumented CI shard, although
// the identical script runs locally in about a second. Six sibling `census:*` scripts were already
// in the fast gate; this one was not, so a dispatched worker's pre-push `rmd preflight` never saw it.
//
// WHY IT IS NOT A CENSUS MEMBER. The suite enumerates with readdirSync, so the recognizer classes it
// `dir-walk`, and W1-T2809 defers that whole class (~84 suites) to its own filing. Admitting it via
// CENSUS_POPULATION would make censusPopulationDrift report it `stale`. So it is a plain, plan-shaped
// step beside lint-plan, with no `boundMs` — the key the census class is identified by.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "census:self-path-proof";
const STEP = FAST_GATE_STEPS.find((s) => s.script === SCRIPT);

test("the fast gate carries the self-path proof ratchet, so a pre-push preflight reaches it", () => {
  assert.ok(STEP, `FAST_GATE_STEPS must declare a step running "${SCRIPT}"`);
  assert.equal(STEP.job, "self-path-proof");
});

test("it is a plain plan-shaped step, NOT a census-class member — it carries no boundMs", () => {
  assert.ok(STEP);
  // The census class is keyed on boundMs; a plain step that carried one would be demanded a
  // CENSUS_POPULATION member it cannot have while the dir-walk class stays deferred.
  assert.equal(STEP.boundMs, undefined);
  // And no remedyFiles: the remedy is fewer self-path proofs, never a raise of the baseline.
  assert.equal(STEP.remedyFiles, undefined);
});

test("REFUSES A DOUBLE ENTRY — the script is never both a hand step and an admitted census member", () => {
  // The day the dir-walk deferral is resolved and this suite enters CENSUS_POPULATION, the census
  // projection will add its own step. This fails until the hand entry above is removed, so the
  // ratchet can never run twice per preflight.
  const asCensus = CENSUS_ADMITTED_MEMBERS.filter((m) => m.script === SCRIPT);
  const asSteps = FAST_GATE_STEPS.filter((s) => s.script === SCRIPT);
  assert.equal(asCensus.length, 0, "admitted as a census member — remove the hand-written fast-gate step");
  assert.equal(asSteps.length, 1);
});

test("the npm script targets exactly the self-path ratchet suite, never a glob", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const command = pkg.scripts[SCRIPT];
  assert.ok(command, `package.json must define "${SCRIPT}"`);
  assert.match(command, /test\/a-shards-proof-cannot-target-its-own-file\.test\.ts$/);
  assert.doesNotMatch(command, /\*/);
});

test("a checkout with no plan/tasks.d skips the step rather than failing it", () => {
  assert.ok(STEP);
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fastgate-noplan-`));
  try {
    let spawned = false;
    const result = runPreflightFast(bare, {
      steps: [STEP],
      packageJsonText: JSON.stringify({ scripts: { [SCRIPT]: "exit 1" } }),
      spawn: (() => {
        spawned = true;
        return { status: 1, stdout: "", stderr: "" };
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(spawned, false, "an absent plan/tasks.d must never even attempt the script");
    assert.match(result.steps[0]?.detail ?? "", /SKIPPED/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("REAL, UNMOCKED: the step runs against this repository and passes on a healthy tree", () => {
  assert.ok(STEP);
  // One test that really shells out, so the default spawn seam is exercised — a suite where every
  // case injects a fake never proves the gate can run at all.
  const result = runPreflightFast(REPO_ROOT, { steps: [STEP] });
  assert.equal(result.ok, true, result.steps.map((s) => s.detail).join("\n"));
});
