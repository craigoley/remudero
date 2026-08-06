/**
 * test/ci-parity-contract.test.ts — W1-T295.
 *
 * THE GAP. `outputContractLines` went straight from "stage the changed file(s), commit, then
 * run `git push origin HEAD`" to opening the PR — nothing told a worker to verify its own
 * change against CI before that first push. CLAUDE.md's "Before you push" section records the
 * coverage ratchet alone blocking three consecutive PRs on their first push, each costing an
 * amend, a force-push and a CI round-trip — a report, not a contract line, and a report leaks
 * (LEARNINGS, PR 407). W1-T294 shipped the command (`rmd preflight --ci-parity`, mirroring
 * every CI job); this task is what makes a worker RUN it before the first push.
 *
 * ONE SHARED LITERAL, TWO PROMPTS (the #427/#428 shape): `ciParityContractLines()` lives
 * beside `commitMessageContractLines`/`bodyVsDiffContractLines` in lib/compaction.ts and must
 * be composed byte-identically into BOTH the implement contract (`outputContractLines`, which
 * also composes into `renderAnchorBlock`, so it survives compaction) and the fix rung's own
 * footer (`renderFixPrompt`, run-task.ts) — never restated as a second copy of the same text.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ciParityContractLines, outputContractLines, renderAnchorBlock } from "../src/lib/compaction.js";
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

// ── (1) the requirement is stated, and it is stated at turn 0 ────────────────

test("ciParityContractLines names the exact command a worker is expected to run", () => {
  const lines = ciParityContractLines();
  assert.ok(lines.length > 0);
  const text = lines.join("\n");
  assert.match(text, /rmd preflight --ci-parity/, "the literal command, not a paraphrase");
  assert.match(text, /CI job/i, "explains what the command mirrors");
});

test("ciParityContractLines says named failures are fixed BEFORE pushing, not after", () => {
  const text = ciParityContractLines().join("\n");
  // "fix ... before" / "do not push to find out" — the ordering claim itself, not just the verb.
  assert.match(text, /fix/i);
  assert.match(text, /before the first push|do not push/i);
});

test("the implement output contract carries the ci-parity requirement, at turn 0", () => {
  const contract = ciParityContractLines();
  const implement = outputContractLines("W1-T295").join("\n");
  assert.ok(implement.includes(contract.join("\n")), "the implement contract carries it verbatim, not paraphrased");
  // Ordered BEFORE the push step, so a worker following the contract in order cannot skip it.
  const parityIdx = implement.indexOf(contract[0]);
  const pushIdx = implement.indexOf("git push origin HEAD");
  assert.ok(parityIdx >= 0 && pushIdx >= 0);
  assert.ok(parityIdx < pushIdx, "the parity requirement must precede the push instruction");
});

// ── (2) the fix rung carries the BYTE-IDENTICAL requirement from the same source ─────────────

test("the fix rung's prompt carries the same shared literal, not a second copy of the rule", async () => {
  const contract = ciParityContractLines();
  const { renderFixPrompt } = await import("../src/run-task.js");
  const fix = renderFixPrompt({
    task: { id: "W1-T295", title: "t" },
    round: 2,
    branch: "run-W1-T295-1",
    evidence: {} as never,
  } as never);
  assert.ok(fix.includes(contract.join("\n")), "the fix rung carries the SAME literal as the implement contract");
});

// ── (3) it is part of the block re-injected verbatim after compaction ────────────────────────

test("the ci-parity requirement survives compaction via renderAnchorBlock", () => {
  const contract = ciParityContractLines();
  const anchor = renderAnchorBlock(
    {
      id: "W1-T295",
      title: "t",
      prompt: "do the thing",
      acceptance: [],
    } as never,
    "run-W1-T295-1",
  );
  assert.ok(anchor.includes(contract.join("\n")), "the anchor re-injected after compaction carries it verbatim");
});

// ── (4) both prompt renderers consume the shared function rather than restating its text ─────

test("outputContractLines and the fix rung compose ciParityContractLines() — not a paraphrase", async () => {
  const contract = ciParityContractLines();
  const implement = outputContractLines("W1-T1").join("\n");
  const { renderFixPrompt } = await import("../src/run-task.js");
  const fix = renderFixPrompt({
    task: { id: "W1-T1", title: "t" },
    round: 1,
    branch: "run-W1-T1-1",
    evidence: {} as never,
  } as never);
  for (const text of [implement, fix]) {
    assert.ok(text.includes(contract.join("\n")), "byte-identical composition, both prompts");
  }
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
