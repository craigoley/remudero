/**
 * test/ci-parity-contract.test.ts — W1-T295, revised by W1-T464.
 *
 * THE ORIGINAL GAP (W1-T295). `outputContractLines` went straight from "stage the changed
 * file(s), commit, then run `git push origin HEAD`" to opening the PR — nothing told a worker
 * to verify its own change against CI before that first push. W1-T294 shipped the command
 * (`rmd preflight --ci-parity`, mirroring every CI job); W1-T295 made a worker RUN it before
 * the first push via a shared literal, `ciParityContractLines()`, composed byte-identically
 * into BOTH the implement contract (`outputContractLines`, which also composes into
 * `renderAnchorBlock`) and the fix rung's own footer (`renderFixPrompt`, run-task.ts).
 *
 * WHY THAT CONTRACT IS GONE (W1-T464). Re-measured on the Azure host's full ledger: the
 * orchestrator's own handling of a failed preflight (`run-task.ts`) has NO branch, NO early
 * return, NO gate — a worker that ran `--ci-parity` and failed it pushed anyway, every time.
 * Of 17 `preflight.failed` rows, only 2 were genuine (15 were `test/preflight.test.ts`'s fake
 * spawn contaminating the ledger, a defect W1-T455 owns); of those 2 genuine rows, one was
 * UNDECIDABLE and the other was WRONG (CI passed 21/22 checks, 1 neutral, on the identical
 * sha). The step cost ~15-17 minutes — roughly a quarter of a lane — for zero earned catches.
 * `ciParityContractLines()` was removed from lib/compaction.ts along with both call sites; the
 * `rmd preflight --ci-parity` CLI verb itself is untouched and remains the hand route's gate.
 * These tests now assert the NEGATIVE: neither worker prompt carries that obligation anymore.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
import { CI_PARITY_TABLE, runCiParity } from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** Records every spawn call, falling back to a clean `{status: 0}` for anything unlisted —
 *  duplicated locally per test/preflight-ci-parity.test.ts's own file-scoping convention. */
function recordingSpawn(map: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[]; opts?: { cwd?: string; input?: string } }[] = [];
  const spawn: PreflightSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const key = [file, ...args].join(" ");
    for (const [needle, result] of Object.entries(map)) {
      if (key.includes(needle)) {
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

// ── (1) the implement contract no longer obligates a worker to run --ci-parity ───────────────

test("the implement output contract no longer tells a worker to run rmd preflight --ci-parity", () => {
  const implement = outputContractLines("W1-T464").join("\n");
  assert.doesNotMatch(implement, /rmd preflight --ci-parity/, "W1-T464 removed the worker-facing obligation");
  assert.doesNotMatch(implement, /BEFORE THE FIRST PUSH, run/i, "the whole contract line is gone, not reworded");
});

test("the implement output contract still tells a worker how to push and open a PR", () => {
  const implement = outputContractLines("W1-T464").join("\n");
  assert.match(implement, /git push origin HEAD/, "pushing is still part of the contract");
  assert.match(implement, /gh pr create --fill/, "opening the PR is still part of the contract");
  // Ordered after commit, same as before — only the ci-parity gate in between is gone.
  const stageIdx = implement.indexOf("stage the changed file(s)");
  const pushIdx = implement.indexOf("git push origin HEAD");
  assert.ok(stageIdx >= 0 && pushIdx >= 0 && stageIdx < pushIdx);
});

// ── (2) the fix rung carries the SAME absence, not a second copy of the removed rule ─────────

test("the fix rung's prompt also no longer carries the --ci-parity obligation", async () => {
  const { renderFixPrompt } = await import("../src/run-task.js");
  const fix = renderFixPrompt({
    task: { id: "W1-T464", title: "t" },
    round: 2,
    branch: "run-W1-T464-1",
    evidence: {} as never,
  } as never);
  assert.doesNotMatch(fix, /rmd preflight --ci-parity/, "removed from both prompts together");
  assert.match(fix, /git push origin HEAD/, "the fix rung still pushes once its own steps are done");
});

// ── (3) the anchor re-injected after compaction reflects the same absence ────────────────────

test("the post-compaction anchor does not re-inject the --ci-parity requirement either", () => {
  const anchor = renderAnchorBlock(
    {
      id: "W1-T464",
      title: "t",
      prompt: "do the thing",
      acceptance: [],
    } as never,
    "run-W1-T464-1",
  );
  assert.doesNotMatch(anchor, /rmd preflight --ci-parity/, "the anchor composes outputContractLines, so it inherits the removal");
});

// ── (4) the hand route's own verb is untouched by the worker-contract removal ────────────────

test("rmd preflight --ci-parity remains a live CLI verb — only the worker's obligation to run it is gone", () => {
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci");
  assert.ok(ciEntry && ciEntry.mirrored, "CI_PARITY_TABLE — the machinery --ci-parity runs — is still intact");
});

// ── (5) W1-T373 design (v): cli-reference:check is a ci-parity entry — ONE LIST, ONE TRUTH ──
//
// cli-reference:check was missing from lib/ci-parity.ts entirely — it is asserted from INSIDE
// test/cli-reference.test.ts, which is only reached by the `ci` job's `npm run test:ci` step,
// so a failure there surfaced as a numbered TAP line (#1352's `not ok 449 - generate-cli-
// reference --check`) rather than a named --ci-parity step. This closes that gap: the `ci`
// job's table entry now runs a DEDICATED `ci:cli-reference-check` step, so --ci-parity is
// actually at parity with CI on this check instead of only accidentally exercising it.

test("CI_PARITY_TABLE: the 'ci' job entry runs a DEDICATED ci:cli-reference-check step — cli-reference:check is no longer missing from lib/ci-parity.ts", () => {
  const { spawn } = recordingSpawn();
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci")!;
  assert.ok(ciEntry && ciEntry.mirrored, "the 'ci' job must be a mirrored entry");
  const steps = ciEntry.run!(REPO_ROOT, spawn);
  const cliRefStep = steps.find((s) => s.name === "ci:cli-reference-check");
  assert.ok(cliRefStep, "expected a 'ci:cli-reference-check' step in the 'ci' job entry's run()");
});

test("CI_PARITY_TABLE: ci:cli-reference-check invokes `npm run --silent cli-reference:check` — the same script the task's own measurement (0.69s) and package.json name", () => {
  const { spawn, calls } = recordingSpawn();
  const ciEntry = CI_PARITY_TABLE.find((e) => e.job === "ci")!;
  ciEntry.run!(REPO_ROOT, spawn);

  const call = calls.find((c) => c.file === "npm" && c.args.join(" ") === "run --silent cli-reference:check");
  assert.ok(call, "expected an `npm run --silent cli-reference:check` call from the 'ci' job entry");
});

test("CI_PARITY_TABLE: ci:cli-reference-check FAILS INDEPENDENTLY of ci:test — a stale docs/cli-reference.md is named as its own step, not buried inside ci:test's output", () => {
  const { spawn } = recordingSpawn({ "cli-reference:check": { status: 1, stderr: "Drifted command(s): check-acceptance" } });
  const result = runCiParity(REPO_ROOT, { spawn });

  const cliRefStep = result.steps.find((s) => s.name === "ci:cli-reference-check")!;
  assert.equal(cliRefStep.ok, false, "a stale committed cli-reference.md must fail its own named step");
  assert.match(cliRefStep.detail, /Drifted command\(s\)/, "the step's own detail carries the drift reason, not a bare FAIL");

  // ci:test still ran and reported independently — one failing step never blocks another.
  const ciTestStep = result.steps.find((s) => s.name === "ci:test")!;
  assert.equal(ciTestStep.ok, true, "ci:test's own (stubbed-clean) verdict is unaffected by ci:cli-reference-check's failure");
  assert.equal(result.ok, false);
});

test("CI_PARITY_TABLE: adding ci:cli-reference-check does not turn the ci-parity:drift step red — 'ci' is still a real ci.yml job, only its step LIST grew", () => {
  const { spawn } = recordingSpawn();
  const result = runCiParity(REPO_ROOT, { spawn });
  const drift = result.steps.find((s) => s.name === "ci-parity:drift")!;
  assert.equal(drift.ok, true, "the drift step only checks for ci.yml jobs missing a table entry — the 'ci' entry still exists and is unchanged as a job");
});
