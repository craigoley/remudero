import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── ci-gate: A READ THAT FAILED IS NOT A READ THAT SAID NO ──────────────────────────────────
//
// MEASURED 2026-08-11 on PR #1569. ci-gate polled correctly for two minutes, printing its
// shrinking waiting-list every ~15s, and then ONE poll returned:
//
//   Get "https://api.github.com/repos/craigoley/remudero/commits/3c67149…/check-runs?per_page=100":
//   tls: failed to verify certificate: x509: certificate is not valid for any names,
//   but wanted to match api.github.com
//   ##[error]Process completed with exit code 1.
//
// Under `set -euo pipefail` that killed the script mid-wait, and ci-gate reported FAILURE on a
// REQUIRED context — indistinguishable, to branch protection and to a reader scanning the checks
// list, from a required check going red. The re-run (job 93858981018) went SUCCESS on the SAME
// sha with no new commit, so the gate had converted a network hiccup into a merge-blocking
// verdict. That is the fifth bound in this repo measured firing on a healthy condition.
//
// WHY RETRYING THIS PARTICULAR READ CANNOT MASK A FLAPPING CHECK — the property that makes the
// fix safe rather than clever. A check's verdict only ever rides the BODY of a SUCCESSFUL read.
// A non-zero `gh api` exit yields no rows at all, so there is nothing to mask: a genuinely red
// or flapping check still arrives as data and is decided by the evaluate step and the W1-T261
// grace window, untouched by this change. The last test below pins exactly that.
//
// This suite drives the REAL bash+jq script extracted from ci-gate.yml (never re-typed here) as
// a subprocess with a stub `gh` on PATH, following test/ci-gate-reaggregate.test.ts's harness.
// RETRY_ATTEMPTS / RETRY_BACKOFF_SECONDS are shrunk via env so the suite runs fast; the
// mechanism under test is unchanged by the magnitude.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_GATE_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

type CheckRun = {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null;
  started_at: string;
};

const passing: CheckRun[] = [
  { name: "ci", status: "completed", conclusion: "success", started_at: "2026-08-11T16:56:50Z" },
];

async function loadAggregateScript(): Promise<string> {
  const raw = await readFile(CI_GATE_PATH, "utf8");
  const doc = parseYaml(raw) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
  const step = doc.jobs["ci-gate"].steps.find((s) => typeof s.run === "string" && s.run.includes("runs_json"));
  assert.ok(step, "expected ci-gate.yml's ci-gate job to have a step whose run script defines runs_json()");
  return step!.run!;
}

/**
 * A fake `gh` that FAILS its first `failures` invocations the way the real one did — a Go
 * transport error on stderr and a non-zero exit, carrying NO body — and answers every later call
 * with `snapshot`. `failures: Infinity` never recovers, standing in for an API that stays
 * unreachable for the whole retry budget.
 */
async function writeFlakyGh(dir: string, stateDir: string, failures: number, snapshot: CheckRun[]): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "fixture"), JSON.stringify([{ check_runs: snapshot }]));
  const body = `#!/usr/bin/env bash
set -euo pipefail
COUNTER_FILE="${stateDir}/call_count"
n=0
[ -f "\${COUNTER_FILE}" ] && n="$(cat "\${COUNTER_FILE}")"
echo $((n + 1)) > "\${COUNTER_FILE}"
if [ "\${n}" -lt ${Number.isFinite(failures) ? failures : 999999} ]; then
  echo 'Get "https://api.github.com/repos/example/example/commits/dead/check-runs?per_page=100": tls: failed to verify certificate: x509: certificate is not valid for any names, but wanted to match api.github.com' >&2
  exit 1
fi
cat "${stateDir}/fixture"
`;
  await writeFile(join(dir, "gh"), body, { mode: 0o755 });
}

async function runScript(
  script: string,
  failures: number,
  snapshot: CheckRun[] = passing,
  required: string[] = ["ci"],
) {
  const dir = await mkdtemp(join(tmpdir(), "ci-gate-transport-bin-"));
  const stateDir = await mkdtemp(join(tmpdir(), "ci-gate-transport-state-"));
  try {
    await writeFlakyGh(dir, stateDir, failures, snapshot);
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "fake-token",
        REPO: "example/example",
        SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        REQUIRED: JSON.stringify(required),
        IGNORE: JSON.stringify(["ci-gate"]),
        GRACE_WINDOW_SECONDS: "3",
        GRACE_POLL_INTERVAL_SECONDS: "1",
        WAIT_CAP_SECONDS: "60",
        WAIT_POLL_INTERVAL_SECONDS: "1",
        RETRY_ATTEMPTS: "3",
        RETRY_BACKOFF_SECONDS: "0",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const callCount = Number((await readFile(join(stateDir, "call_count"), "utf8")).trim());
    return { result, callCount };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

// ── the defect, fixed ────────────────────────────────────────────────────────────────────────

test("ci-gate: a transport error on one poll is retried, and the gate reaches its real verdict", async () => {
  const script = await loadAggregateScript();
  // TWO consecutive failures — more than the one that killed #1569, still inside the budget.
  const { result, callCount } = await runScript(script, 2);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /every REQUIRED check is terminal and no check failed/);
  assert.match(result.stderr, /check-runs read FAILED \(attempt 1\/3\)/, "the retry must be visible, not silent");
  assert.equal(callCount, 3, "two failures then one success — the third call is the one that answered");
});

test("ci-gate MUTANT: strip the retry loop from the SOURCE and the same two transport errors kill the gate", async () => {
  // The falsifier, mutating the SCRIPT rather than an env knob — an env-only mutant would still
  // pass against a version that deleted the loop and ignored the knob, proving nothing about the
  // file. The substitution target is asserted UNIQUE first, or the mutation is unattributable.
  const script = await loadAggregateScript();
  const target = 'while [ "${attempt}" -le "${RETRY_ATTEMPTS}" ]; do';
  assert.equal(script.split(target).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");
  const mutant = script.replace(target, 'while [ "${attempt}" -le 1 ]; do');

  const { result } = await runScript(mutant, 2);
  assert.notEqual(result.status, 0, "one attempt against a flaky API must reproduce the #1569 death");
  // And the REAL script survives the identical fixture — otherwise the mutant proves only that
  // the fixture fails everything.
  const { result: real } = await runScript(script, 2);
  assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
});

test("ci-gate MUTANT: drop `|| unreadable_die` and the unreadable case loses its message", async () => {
  // Proves the guard is what produces the UNREADABLE verdict. Without it, `set -e` still aborts
  // on the failed assignment — but silently, which is the pre-fix reader experience: a required
  // gate red with nothing saying the API was the problem.
  const script = await loadAggregateScript();
  const target = 'runs="$(runs_json)" || unreadable_die';
  assert.equal(script.split(target).length - 1, 2, "both call sites must route through the guard");
  const mutant = script.split(target).join('runs="$(runs_json)"');

  const { result } = await runScript(mutant, Infinity);
  assert.notEqual(result.status, 0, "it must still fail closed — the mutant removes the MESSAGE, not the refusal");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /could NOT READ the check-runs API/);
});

// ── and it does NOT become a silent pass ─────────────────────────────────────────────────────

test("ci-gate: an API unreachable for the WHOLE budget fails closed, and says UNREADABLE rather than FAILED", async () => {
  const script = await loadAggregateScript();
  const { result, callCount } = await runScript(script, Infinity);
  assert.notEqual(result.status, 0, "a gate that went green on an unreadable poll would be the worse defect");
  const out = `${result.stdout}\n${result.stderr}`;
  assert.match(out, /could NOT READ the check-runs API after 3 attempt\(s\)/);
  assert.match(out, /this is NOT a check failure/, "the reader must not be sent hunting a red check that does not exist");
  assert.doesNotMatch(out, /check\(s\) FAILED — holding merge/, "an unreadable poll must never be reported as a check failure");
  assert.equal(callCount, 3, "the budget is bounded — it does not spin forever");
});

test("ci-gate: a REAL failing check is still refused, so the retry bought no leniency", async () => {
  // THE CONTROL. A retry that also swallowed genuine reds would be strictly worse than the defect
  // it fixes. `gh` never fails here — the red arrives as DATA, which is the only way a verdict
  // ever arrives — and the gate must still hold the merge after its grace window elapses.
  const script = await loadAggregateScript();
  const failing: CheckRun[] = [
    { name: "ci", status: "completed", conclusion: "failure", started_at: "2026-08-11T16:56:50Z" },
  ];
  const { result } = await runScript(script, 0, failing);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /check\(s\) FAILED — holding merge/);
});
