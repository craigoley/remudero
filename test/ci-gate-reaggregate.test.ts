import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

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
  opts: { graceWindowSeconds?: number; gracePollIntervalSeconds?: number; timeoutMs?: number } = {},
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
