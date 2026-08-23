import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_SWEEP_POLICY,
  CI_GATE_REAGGREGATE_STEP,
  ciGateReaggregateDecision,
  ciGateReaggregateKey,
  reaggregatedCiGateKeysFromLedger,
  runSweep,
  staleCiGateTransition,
  type OpenPrView,
  type RollupCheckEntry,
  type StaleCiGateTransition,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

// ── W1-T261: ci-gate RE-AGGREGATES on member-check completion ───────────────────────────────
//
// The sibling of W1-T123 (what ci-gate reads): this is WHEN it reads. #729 (2026-07-24):
// coverage-ratchet was FAILURE at ci-gate's 17:11 read, SUCCESS at 17:18, and only a manual
// ci-gate re-run or a fresh sha cleared the stale hold.
//
// LIVE PLATFORM FACT (verified against docs.github.com/en/actions/using-workflows/events-that-
// trigger-workflows#check_run + community discussion #148873, not assumed): GitHub's own
// recursion guard suppresses `check_run` events for any check run whose check suite was
// created by GitHub Actions. Every name in ci-gate's REQUIRED list is a GitHub Actions check
// suite, so a `check_run: types: [completed]` trigger (design (i)) would never fire for the
// checks this gate actually aggregates -- design (iv)'s own contingency applies: fall back to
// a bounded grace-window RE-READ inside the SAME run, before concluding FAILURE. No new
// workflow run, no new sha, no manual re-run -- exactly the property the task requires.
//
// Because there is no new trigger surface, there is nothing for ci-gate's own completion to
// re-trigger (claim 3's recursion half is true BY CONSTRUCTION, not by a guard that could have
// a bug) and nothing for a burst of member completions to fan out into multiple aggregations --
// each pull_request-triggering push still produces exactly ONE ci-gate run (the pre-existing
// `concurrency: group: ci-gate-<pr>, cancel-in-progress: true` already keeps that run's
// completion terminal, never cancelled, and is unchanged by this task). The IGNORE list (single
// source, unchanged) still keeps ci-gate's own entry from ever appearing as a required/failing
// name, including across the new grace-window re-read path.
//
// This suite drives the REAL bash+jq script embedded in ci-gate.yml's one step (extracted from
// the file on disk, never re-typed here) as a subprocess, with a stub `gh` binary on PATH that
// returns a DIFFERENT snapshot on each successive invocation -- standing in for a same-sha
// rerun landing partway through the grace window. GRACE_WINDOW_SECONDS / GRACE_POLL_INTERVAL_
// SECONDS are shrunk to single-digit seconds via env so the suite runs fast; the mechanism
// under test is unchanged by the magnitude.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_GATE_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

type CheckRun = {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  started_at: string;
};

async function loadAggregateScript(): Promise<string> {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, any> };
  const steps = doc.jobs["ci-gate"].steps as Array<{ name: string; run: string }>;
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("runs_json"));
  assert.ok(step, "expected ci-gate.yml's ci-gate job to have a step whose run script defines runs_json()");
  return step!.run;
}

// A fake `gh` that answers each successive `gh api .../check-runs?... --paginate --slurp` call
// with the NEXT snapshot in `sequence` (clamped to the last entry once exhausted) -- simulating
// runs_json() being called repeatedly across the wait loop and the grace-window re-read loop,
// each time seeing whatever the "platform" has landed by then.
async function writeSequencedFakeGh(dir: string, stateDir: string, sequence: CheckRun[][]): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  for (let i = 0; i < sequence.length; i += 1) {
    await writeFile(join(stateDir, `fixture_${i}`), JSON.stringify([{ check_runs: sequence[i] }]));
  }
  const lastIdx = sequence.length - 1;
  const body = `#!/usr/bin/env bash
set -euo pipefail
COUNTER_FILE="${stateDir}/call_count"
n=0
[ -f "\${COUNTER_FILE}" ] && n="$(cat "\${COUNTER_FILE}")"
echo $((n + 1)) > "\${COUNTER_FILE}"
idx="\${n}"
if [ "\${idx}" -gt ${lastIdx} ]; then
  idx=${lastIdx}
fi
cat "${stateDir}/fixture_\${idx}"
`;
  await writeFile(join(dir, "gh"), body, { mode: 0o755 });
}

async function runAggregateScript(
  script: string,
  required: string[],
  ignore: string[],
  sequence: CheckRun[][],
  opts: {
    graceWindowSeconds?: number;
    gracePollIntervalSeconds?: number;
    timeoutMs?: number;
    waitCapSeconds?: number;
    waitPollIntervalSeconds?: number;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "ci-gate-reaggregate-bin-"));
  const stateDir = await mkdtemp(join(tmpdir(), "ci-gate-reaggregate-state-"));
  try {
    await writeSequencedFakeGh(dir, stateDir, sequence);
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "fake-token",
        REPO: "example/example",
        SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        REQUIRED: JSON.stringify(required),
        IGNORE: JSON.stringify(ignore),
        GRACE_WINDOW_SECONDS: String(opts.graceWindowSeconds ?? 5),
        GRACE_POLL_INTERVAL_SECONDS: String(opts.gracePollIntervalSeconds ?? 1),
        WAIT_CAP_SECONDS: String(opts.waitCapSeconds ?? 2400),
        WAIT_POLL_INTERVAL_SECONDS: String(opts.waitPollIntervalSeconds ?? 15),
      },
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 20_000,
    });
    const callCount = Number((await readFile(join(stateDir, "call_count"), "utf8")).trim());
    return { result, callCount };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("ci-gate-reaggregate: a required check FAILURE at the first read that flips SUCCESS on a same-sha rerun landing inside the grace window re-drives to SUCCESS, no new sha, no manual re-run (the #729 fixture)", async () => {
  const script = await loadAggregateScript();
  const failing: CheckRun[] = [
    { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:11:00Z" },
  ];
  const passing: CheckRun[] = [
    { name: "coverage-ratchet", status: "completed", conclusion: "success", started_at: "2026-07-24T17:18:00Z" },
  ];
  const { result, callCount } = await runAggregateScript(
    script,
    ["coverage-ratchet"],
    [],
    [failing, failing, passing, passing],
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /entering a 5s grace window/);
  assert.match(out, /- coverage-ratchet/);
  assert.match(out, /ci-gate: all required checks terminal, no failures — merge may proceed\./);
  // Proves a RE-READ actually happened (more than the single initial call) rather than the
  // script simply ignoring the failure.
  assert.ok(callCount > 1, `expected more than one runs_json() call, got ${callCount}`);
});

test("ci-gate-reaggregate: a required check that is STILL failing at the grace-window deadline stays FAILURE — re-aggregation never launders a real red", async () => {
  const script = await loadAggregateScript();
  const stillFailing: CheckRun[] = [
    { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:11:00Z" },
  ];
  const { result } = await runAggregateScript(script, ["coverage-ratchet"], [], [
    stillFailing,
    stillFailing,
    stillFailing,
    stillFailing,
    stillFailing,
    stillFailing,
    stillFailing,
    stillFailing,
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /entering a 5s grace window/);
  assert.match(out, /::error::ci-gate: required check\(s\) FAILED — holding merge:/);
  assert.match(out, /- coverage-ratchet/);
});

test("ci-gate-reaggregate: a rerun still IN PROGRESS when the grace window elapses never masks the original failure as a pass", async () => {
  const script = await loadAggregateScript();
  const failing: CheckRun[] = [
    { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:11:00Z" },
  ];
  // A rerun starts (newer started_at) but never reaches "completed" within the fixture window --
  // dedupe would pick this as the latest attempt; its null conclusion must NOT be read as a pass.
  const rerunInFlight: CheckRun[] = [
    { name: "coverage-ratchet", status: "in_progress", conclusion: null, started_at: "2026-07-24T17:12:00Z" },
  ];
  const { result } = await runAggregateScript(script, ["coverage-ratchet"], [], [
    failing,
    rerunInFlight,
    rerunInFlight,
    rerunInFlight,
    rerunInFlight,
    rerunInFlight,
    rerunInFlight,
    rerunInFlight,
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /::error::ci-gate: required check\(s\) FAILED — holding merge:/);
  assert.match(out, /- coverage-ratchet/);
});

test("ci-gate-reaggregate: a member completing FAILURE (fresh attempt, never a stale one) still FAILS after the grace window", async () => {
  const script = await loadAggregateScript();
  const freshFailure: CheckRun[] = [
    { name: "refactor-campaign", status: "completed", conclusion: "success", started_at: "2026-07-24T17:00:00Z" },
    { name: "refactor-campaign", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:20:00Z" },
  ];
  const { result } = await runAggregateScript(script, ["refactor-campaign"], [], [
    freshFailure,
    freshFailure,
    freshFailure,
    freshFailure,
    freshFailure,
    freshFailure,
    freshFailure,
    freshFailure,
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /::error::ci-gate: required check\(s\) FAILED — holding merge:/);
  assert.match(out, /- refactor-campaign/);
});

test("ci-gate-reaggregate: an absent required check still blocks through the grace window — the fail-closed absent-check contract is untouched", async () => {
  const script = await loadAggregateScript();
  // "present-check" registers; "missing-check" never does, across every read including the
  // grace-window re-reads -- step 1's own 15-minute wait loop (unchanged) is what actually
  // holds here, so this never reaches the grace-window step at all.
  const snapshot: CheckRun[] = [
    { name: "present-check", status: "completed", conclusion: "success", started_at: "2026-07-24T17:00:00Z" },
  ];
  const { result } = await runAggregateScript(
    script,
    ["present-check", "missing-check"],
    [],
    [snapshot, snapshot, snapshot],
    { timeoutMs: 3_000 },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(out, /waiting for required check\(s\) to complete:/);
  assert.match(out, /- missing-check/);
  assert.doesNotMatch(out, /merge may proceed\./);
  assert.doesNotMatch(out, /required check\(s\) FAILED/);
});

test("ci-gate-reaggregate: ci-gate's own IGNORE-listed entry is excluded from the required/failing set even when it appears as FAILURE during a grace-window re-read", async () => {
  const script = await loadAggregateScript();
  // "ci-gate" is never in REQUIRED (not waited on), but it CAN appear in the raw check-runs list
  // (it is a check run itself). IGNORE, unchanged, is the single source that excludes it from
  // the failing set -- no second hardcoded exclusion was added for the grace-window path.
  const withSelfFailure: CheckRun[] = [
    { name: "refactor-campaign", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:00:00Z" },
    { name: "ci-gate", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:05:00Z" },
  ];
  const cleared: CheckRun[] = [
    { name: "refactor-campaign", status: "completed", conclusion: "success", started_at: "2026-07-24T17:10:00Z" },
    { name: "ci-gate", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:05:00Z" },
  ];
  const { result } = await runAggregateScript(script, ["refactor-campaign"], ["ci-gate"], [
    withSelfFailure,
    withSelfFailure,
    cleared,
    cleared,
  ]);
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /merge may proceed\./);
  assert.doesNotMatch(out, /- ci-gate\n/);
});

test("ci-gate-reaggregate: the grace-window re-read loop is BOUNDED — it stops polling at the deadline instead of spinning forever on a persistent red", async () => {
  const script = await loadAggregateScript();
  const stillFailing: CheckRun[] = [
    { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-07-24T17:11:00Z" },
  ];
  // 20 identical snapshots is far more than a 5s/1s-poll window (~5 re-reads) could consume --
  // if the loop were unbounded it would exhaust every entry; a bounded loop stops well short.
  const sequence = Array.from({ length: 20 }, () => stillFailing);
  const { result, callCount } = await runAggregateScript(script, ["coverage-ratchet"], [], sequence, {
    graceWindowSeconds: 3,
    gracePollIntervalSeconds: 1,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.ok(callCount < sequence.length, `expected the bounded loop to stop well before ${sequence.length} calls, got ${callCount}`);
});

test("ci-gate-reaggregate: the workflow carries the grace-window fallback in its env (not just this test's env overrides) and documents the platform finding inline", async () => {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, any> };
  const env = doc.jobs["ci-gate"].env as Record<string, string>;
  assert.ok(Number(env.GRACE_WINDOW_SECONDS) > 0, "expected a positive default GRACE_WINDOW_SECONDS in ci-gate.yml");
  assert.ok(Number(env.GRACE_POLL_INTERVAL_SECONDS) > 0, "expected a positive default GRACE_POLL_INTERVAL_SECONDS in ci-gate.yml");
  assert.match(raw, /check_run/, "expected ci-gate.yml to name the investigated check_run trigger");
  assert.match(raw, /GitHub Actions/, "expected ci-gate.yml to document the GitHub Actions recursion-guard finding");
});

// ── W1-T312: the wait cap itself was shorter than this repo's own CI ────────────────────────
//
// A SEPARATE defect from the grace-window re-aggregation above: step 1's own wait loop (the one
// that runs BEFORE any check has failed) hard-capped at 900s, which sat below this repo's own
// measured p95 required-check wall-clock (~1345s, n=10 samples 2026-08-03 — see the
// WAIT_CAP_SECONDS comment in ci-gate.yml's job env). ci-gate timed out on siblings that were
// still green-in-progress (#1229, #1234), and the W1-T261 grace window above cannot help here: it
// only re-reads once `fails` is non-empty, i.e. once a required check has COMPLETED as failing --
// a check that has not completed at all never reaches that branch.

test("ci-gate-reaggregate (W1-T312): the wait cap is sized from a measured distribution of this repo's own required-check durations, with the p95 stated inline", async () => {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, any> };
  const env = doc.jobs["ci-gate"].env as Record<string, string>;
  const waitCapSeconds = Number(env.WAIT_CAP_SECONDS);
  assert.ok(waitCapSeconds > 0, "expected a positive default WAIT_CAP_SECONDS in ci-gate.yml");
  // The old hard-coded cap (900s / 15 minutes) sat below the measured p95 and produced the false
  // timeouts this task was filed from -- the fix must raise it, not just parameterize it.
  assert.ok(
    waitCapSeconds > 900,
    `expected WAIT_CAP_SECONDS (${waitCapSeconds}) to exceed the old 900s hard cap that caused the false timeouts`,
  );
  assert.ok(Number(env.WAIT_POLL_INTERVAL_SECONDS) > 0, "expected a positive default WAIT_POLL_INTERVAL_SECONDS in ci-gate.yml");
  assert.match(raw, /p95/i, "expected ci-gate.yml to state the measured p95 inline, not just a bare number");
  assert.match(raw, /measured/i, "expected ci-gate.yml to document that the cap comes from a measurement, not a guess");
  // The script must actually use the env var for its deadline, not just declare it unused.
  assert.match(raw, /WAIT_CAP_SECONDS/);
  assert.doesNotMatch(
    raw,
    /\$\(\(\s*\$\(date \+%s\)\s*\+\s*900\s*\)\)/,
    "expected the literal 900s hard-coded deadline to be gone, replaced by the WAIT_CAP_SECONDS env var",
  );
});

test("ci-gate-reaggregate (W1-T312): a required check that never completes within the wait cap is reported as a TIMEOUT, distinctly from a genuine check FAILURE, and names a new sha as the remedy", async () => {
  const script = await loadAggregateScript();
  // "missing-check" never registers as completed across any read -- this drives step 1's own
  // wait loop (unchanged in shape) all the way to its deadline, never reaching step 2/3's
  // FAILED-check evaluation at all.
  const snapshot: CheckRun[] = [
    { name: "present-check", status: "completed", conclusion: "success", started_at: "2026-07-24T17:00:00Z" },
  ];
  const sequence = Array.from({ length: 20 }, () => snapshot);
  const { result } = await runAggregateScript(
    script,
    ["present-check", "missing-check"],
    [],
    sequence,
    { waitCapSeconds: 2, waitPollIntervalSeconds: 1, timeoutMs: 15_000 },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /::error::ci-gate: TIMED OUT waiting for required check\(s\) to complete/, out);
  assert.match(out, /- missing-check/);
  // Distinct from the FAILED-check message path (step 2/3) -- a timeout must never read as one.
  assert.doesNotMatch(out, /required check\(s\) FAILED/);
  // The remedy: a NEW sha, not a re-run of this one.
  assert.match(out, /NEW sha/i);
});

test("ci-gate-reaggregate (W1-T312): CLAUDE.md no longer states that W1-T261 is unimplemented", async () => {
  const claudeMdPath = join(REPO_ROOT, "CLAUDE.md");
  const raw = await readFile(claudeMdPath, "utf8");
  assert.doesNotMatch(
    raw,
    /W1-T261[^\n]*UNIMPLEMENTED/i,
    "expected CLAUDE.md to stop claiming W1-T261 is unimplemented (it merged 2026-07-29 via #885)",
  );
  assert.doesNotMatch(
    raw,
    /underlying defect is filed as W1-T261 and UNIMPLEMENTED/i,
  );
  // The corrected bullet should still exist and now name the merged PR + this task.
  assert.match(raw, /W1-T261.*#885/s);
  assert.match(raw, /W1-T312/);
});

// ── W1-T1275: THE REQUIRED ROLLUP NEVER RECOMPUTES ONCE ITS OWN RUN CONCLUDES ────────────────
//
// A SEPARATE gap from W1-T261 above, filed and measured 2026-08-23 on #2612. W1-T261 re-reads
// INSIDE ci-gate's own run, bounded by GRACE_WINDOW_SECONDS; this defect is what happens once
// that run has already CONCLUDED and posted a terminal verdict — nothing brings it back. `ci-gate`
// held `failure` for 155.4 minutes after its own verdict and 30.7 minutes after `coverage-ratchet`
// (the last required sibling) reached `success`, burning the `blocked_ci` fix rung's both strikes
// and an operator escalation (issues/2632) against a PR whose only red required check was the
// stale rollup itself.
//
// Design (ii) requires the recompute to go through the SAME per-job Actions route W1-T1223's
// `requeueCheck` already uses, never a new client; design (iii) requires the trigger condition to
// be exactly ONE shape (ci-gate concluded non-success, a required sibling later reached a LATER
// terminal success on the same head) and NOTHING wider; design (iv) requires the recompute bounded
// to at most once per (head, sibling-transition), ledgered so a human can tell it apart from a
// hand re-run. This suite drives `staleCiGateTransition`/`ciGateReaggregateDecision` (the pure
// detection and the bound) directly, and `runSweep` end to end against `deps.reaggregateCiGate`
// (the sweep's own gate-reconciliation lane — see the block immediately preceding the cancelled-
// check lane in lib/sweep.ts's `runSweep`).

// ── staleCiGateTransition — the pure detection (criteria 1 & 2) ─────────────────────────────────

test("staleCiGateTransition: the #2612 fixture — ci-gate FAILURE, coverage-ratchet cancelled then a LATER success on the same head — names coverage-ratchet's later attempt", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-14T14:27:16Z" },
    { name: "ci", conclusion: "SUCCESS", startedAt: "2026-08-14T14:27:00Z" },
    { name: "coverage-ratchet", conclusion: "CANCELLED", startedAt: "2026-08-14T14:27:16Z" },
    { name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-14T17:03:13Z" },
  ];
  const transition = staleCiGateTransition(rollup);
  assert.ok(transition, "expected a stale transition to be detected");
  assert.equal(transition!.siblingName, "coverage-ratchet");
  assert.equal(transition!.siblingStartedAt, "2026-08-14T17:03:13Z");
});

test("staleCiGateTransition: a suite that is GENUINELY still failing — no sibling has reached a later success — is never named (criterion 2)", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-14T14:27:16Z" },
    { name: "coverage-ratchet", conclusion: "FAILURE", startedAt: "2026-08-14T14:27:16Z" },
    { name: "ci", conclusion: "SUCCESS", startedAt: "2026-08-14T14:27:00Z" },
  ];
  assert.equal(staleCiGateTransition(rollup), undefined, "still-red with no later sibling success must never trigger a recompute");
});

test("staleCiGateTransition: a sibling success that PREDATES ci-gate's own read never counts as a later transition", () => {
  // ci ran and succeeded BEFORE ci-gate even started — ci-gate already had this in view when it
  // concluded FAILURE (on some OTHER, still-red required check); nothing has changed since.
  const rollup: RollupCheckEntry[] = [
    { name: "ci", conclusion: "SUCCESS", startedAt: "2026-08-14T14:20:00Z" },
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-14T14:27:16Z" },
    { name: "coverage-ratchet", conclusion: "FAILURE", startedAt: "2026-08-14T14:27:16Z" },
  ];
  assert.equal(staleCiGateTransition(rollup), undefined, "an older success proves nothing changed after the gate's own read");
});

test("staleCiGateTransition: ci-gate itself still PENDING/IN-PROGRESS has no concluded verdict to be stale", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "ci-gate", status: "in_progress", startedAt: "2026-08-14T14:27:16Z" },
    { name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-14T17:03:13Z" },
  ];
  assert.equal(staleCiGateTransition(rollup), undefined, "nothing concluded yet — never a positive claim from 'the gate is red' alone");
});

test("staleCiGateTransition: ci-gate already SUCCESS is already green — nothing to recompute", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-08-14T14:27:16Z" },
    { name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-14T17:03:13Z" },
  ];
  assert.equal(staleCiGateTransition(rollup), undefined);
});

test("staleCiGateTransition: absent rollup / no ci-gate entry at all returns undefined, never throws", () => {
  assert.equal(staleCiGateTransition(undefined), undefined);
  assert.equal(staleCiGateTransition([{ name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-14T17:03:13Z" }]), undefined);
});

test("staleCiGateTransition: TWO qualifying siblings — the LATEST startedAt is named, the most recent transition is what makes the verdict stale", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-08-14T14:27:16Z" },
    { name: "coverage-ratchet", conclusion: "SUCCESS", startedAt: "2026-08-14T17:03:13Z" },
    { name: "ci", conclusion: "SUCCESS", startedAt: "2026-08-14T18:00:00Z" },
  ];
  const transition = staleCiGateTransition(rollup);
  assert.equal(transition?.siblingName, "ci");
  assert.equal(transition?.siblingStartedAt, "2026-08-14T18:00:00Z");
});

// ── ciGateReaggregateDecision / ciGateReaggregateKey / ledger read-back — the bound (criterion 3) ─

test("ciGateReaggregateDecision: no prior ledger record recomputes; a prior record for the SAME transition never repeats", () => {
  const first = ciGateReaggregateDecision(false);
  assert.equal(first.reaggregate, true);
  const second = ciGateReaggregateDecision(true);
  assert.equal(second.reaggregate, false);
  assert.match(second.reason, /already re-driven once/);
});

test("ciGateReaggregateKey / reaggregatedCiGateKeysFromLedger: the key names the head sha, the sibling, AND the sibling's own attempt timestamp", () => {
  const transition: StaleCiGateTransition = { siblingName: "coverage-ratchet", siblingStartedAt: "2026-08-14T17:03:13Z" };
  const key = ciGateReaggregateKey("202d302", transition);
  assert.equal(key, "202d302@coverage-ratchet@2026-08-14T17:03:13Z");
  const keys = reaggregatedCiGateKeysFromLedger([
    { step: CI_GATE_REAGGREGATE_STEP, head_sha: "202d302", sibling_name: "coverage-ratchet", sibling_started_at: "2026-08-14T17:03:13Z" },
    { step: "some.other.step", head_sha: "202d302", sibling_name: "coverage-ratchet", sibling_started_at: "2026-08-14T17:03:13Z" },
  ]);
  assert.ok(keys.has(key));
  assert.equal(keys.size, 1, "only the matching step contributes a key");
});

// ── runSweep end to end — the sweep's own gate-reconciliation lane ───────────────────────────────

const NOW = Date.parse("2026-08-14T18:15:00Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-ci-gate-reaggregate-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2612,
    prUrl: "https://github.com/craigoley/remudero/pull/2612",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "e97690b0",
    headRefName: "run-W1-TX-1785378652634",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView }>;
  armed: Array<{ pr: OpenPrView }>;
  reaggregated: Array<{ pr: OpenPrView; transition: StaleCiGateTransition }>;
} {
  const fixed: Array<{ pr: OpenPrView }> = [];
  const armed: Array<{ pr: OpenPrView }> = [];
  const reaggregated: Array<{ pr: OpenPrView; transition: StaleCiGateTransition }> = [];
  return {
    fixed,
    armed,
    reaggregated,
    arm: (p) => {
      armed.push({ pr: p });
    },
    close: () => {},
    dispatchFix: (p) => {
      fixed.push({ pr: p });
    },
    escalate: () => {},
    reaggregateCiGate: async (p, transition) => {
      reaggregated.push({ pr: p, transition });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-CIGATEREAGG-1",
    now: () => NOW,
    ...overrides,
  };
}

test("runSweep: a PR red only because ci-gate's own verdict went stale re-drives its job exactly once, ledgered, and never spends a fix-rung strike", async () => {
  const deps = fakeDeps();
  const transition: StaleCiGateTransition = { siblingName: "coverage-ratchet", siblingStartedAt: "2026-08-14T17:03:13Z" };
  const subject = pr({ staleCiGateTransition: transition });
  const summary = await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.reaggregated.length, 1, "the re-drive fired exactly once");
  assert.equal(deps.reaggregated[0].transition.siblingName, "coverage-ratchet");
  assert.equal(deps.fixed.length, 0, "a stale rollup carries no diff defect — the fix rung never spends a strike on it");
  assert.equal(deps.armed.length, 0, "criterion 5 — this pass never arms/merges; it only asks GitHub to re-evaluate");
  assert.equal(summary.actions[0].disposition, "blocked-fixable", "the disposition itself is untouched — never silently marked mergeable");
  assert.equal(summary.actions[0].acted, false, "standing down, not a completed gated action");

  const line = readLedgerLines(deps.ledgerPath).find((l) => l.step === CI_GATE_REAGGREGATE_STEP);
  assert.ok(line, "the re-drive must be ledgered before it can be repeated (design iv)");
  assert.equal(line!.head_sha, "e97690b0");
  assert.equal(line!.sibling_name, "coverage-ratchet");
  assert.equal(line!.sibling_started_at, "2026-08-14T17:03:13Z");
  assert.equal(line!.pr_number, 2612);

  const keys = reaggregatedCiGateKeysFromLedger(readLedgerLines(deps.ledgerPath));
  assert.ok(keys.has(ciGateReaggregateKey("e97690b0", transition)), "reaggregatedCiGateKeysFromLedger reads the SAME row back");
});

test("runSweep: a SECOND pass over the SAME head sha and the SAME sibling transition does NOT re-drive again (criterion 3)", async () => {
  const transition: StaleCiGateTransition = { siblingName: "coverage-ratchet", siblingStartedAt: "2026-08-14T17:03:13Z" };
  const first = fakeDeps();
  const subject = pr({ staleCiGateTransition: transition });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.reaggregated.length, 1);

  // Same ledger (so the prior re-drive is visible), same head sha, same transition — exactly
  // what the NEXT pass would observe while GitHub's own re-run is still settling.
  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([subject], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.reaggregated.length, 0, "bounded — no second re-drive for the same (head, transition) pair");
  assert.equal(second.fixed.length, 0, "still never the fix rung's job while the recompute settles");
});

test("runSweep: a DIFFERENT sibling transition on the SAME head earns its own bounded re-drive — the bound is per-transition, not per-head", async () => {
  const first = fakeDeps();
  const firstTransition: StaleCiGateTransition = { siblingName: "coverage-ratchet", siblingStartedAt: "2026-08-14T17:03:13Z" };
  await runSweep([pr({ staleCiGateTransition: firstTransition })], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.reaggregated.length, 1);

  // A LATER pass observes ci-gate concluded (stale) AGAIN on the SAME head, this time because a
  // DIFFERENT required sibling flipped after that later verdict — a genuinely new transition, not
  // a repeat of the one already re-driven.
  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  const secondTransition: StaleCiGateTransition = { siblingName: "ci", siblingStartedAt: "2026-08-14T19:00:00Z" };
  await runSweep([pr({ staleCiGateTransition: secondTransition })], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.reaggregated.length, 1, "a genuinely new transition still earns its own recompute");
  assert.equal(second.reaggregated[0].transition.siblingName, "ci");
});

test("runSweep: a genuinely red PR with NO stale transition observed is untouched by this remedy — it still dispatches the fix rung, never re-drives ci-gate", async () => {
  const deps = fakeDeps();
  const subject = pr({ ciFailures: [{ name: "coverage-ratchet", logTail: "mutation survivor at line 12\n" }] });
  await runSweep([subject], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.reaggregated.length, 0, "nothing flipped — nothing to re-drive");
  assert.equal(deps.fixed.length, 1, "a genuine failure still routes to the fix rung, unchanged");
});
