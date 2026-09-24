/**
 * W1-T4400 — ci-gate does not hold a runner for the whole CI run.
 *
 * It used to be a pull_request job in ci-gate.yml that started beside ci.yml and polled the
 * check-runs API until every required check finished (up to its 2400 s wait cap): ~77k job-min/month
 * of waiting. Now the required context comes from ci.yml's LAST job, `needs:`-ordered after every
 * other job in that file, which runs ci-gate.yml's own aggregation step read from the file
 * (scripts/ci-gate-from-contract.mjs). ci-gate.yml keeps only the `edited` re-aggregation.
 *
 * DECLARED DEVIATION from the shard's design (i): the completion signal is `needs:` rather than a
 * check_suite/workflow_run trigger. A workflow_run-triggered gate must POST its check through the API,
 * which (a) cannot be re-run as an Actions job, breaking the sweep's W1-T1275 re-drive, and (b) only
 * ever runs main's copy of the workflow, so the PR introducing it could never go green on its own.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { staleCiGateTransition } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO_ROOT, "scripts", "ci-gate-from-contract.mjs");
const { contractRun } = (await import(pathToFileURL(RUNNER).href)) as {
  contractRun: (text: string) => { env: Record<string, string>; script: string };
};

type Job = { name?: string; needs?: string[]; if?: string; env?: Record<string, string>; steps?: Array<{ run?: string }> };
type Wf = { on: { pull_request?: { types?: string[] } | null }; jobs: Record<string, Job> };
const CI_TEXT = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const GATE_TEXT = readFileSync(join(REPO_ROOT, ".github/workflows/ci-gate.yml"), "utf8");
const ci = parseYaml(CI_TEXT) as Wf;
const gate = parseYaml(GATE_TEXT) as Wf;
const REQUIRED = JSON.parse(contractRun(GATE_TEXT).env.REQUIRED!) as string[];

/** Runs the real runner against the real contract with a stub `gh` that answers every check-runs
 *  read with `runs`, and a stub clock so any wait would be instant. Returns the exit and gh call count. */
function runGate(runs: Array<{ name: string; status: string; conclusion: string | null }>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4400-`));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const page = JSON.stringify([{ check_runs: runs.map((r) => ({ ...r, started_at: "2026-09-24T00:00:00Z" })) }]);
  writeFileSync(join(dir, "page.json"), page);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho x >> "${dir}/gh-calls"\ncat "${dir}/page.json"\n`);
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["gh", "sleep"]) chmodSync(join(bin, f), 0o755);
  const r = spawnSync(process.execPath, [RUNNER], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "t", REPO: "o/r", SHA: "abc", GRACE_WINDOW_SECONDS: "0", WAIT_CAP_SECONDS: "0" },
  });
  const calls = readFileSync(join(dir, "gh-calls"), "utf8").split("\n").filter(Boolean).length;
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

test("W1-T4400: ci-gate evaluates on completion events without a wait loop", () => {
  // No pull_request job starts beside CI to poll it: ci-gate.yml fires on `edited` alone.
  assert.deepEqual(gate.on.pull_request?.types, ["edited"]);
  // ci.yml's gate starts only once EVERY other job in the file has completed — that is the event.
  const job = ci.jobs["ci-gate"]!;
  assert.equal(job.name, "ci-gate", "the check keeps the exact name branch protection requires");
  const others = Object.keys(ci.jobs).filter((id) => id !== "ci-gate").sort();
  assert.deepEqual([...job.needs!].sort(), others);
  // always() is load-bearing: without it a failed needed job SKIPS the gate, and GitHub counts a
  // skipped required check as passing.
  assert.equal(job.if, "${{ always() && github.event_name == 'pull_request' }}");
  assert.match(job.steps!.map((s) => s.run ?? "").join("\n"), /node scripts\/ci-gate-from-contract\.mjs/);

  // The real runner evaluates the real contract ONCE when everything has finished: one read, pass.
  const green = runGate(REQUIRED.map((name) => ({ name, status: "completed", conclusion: "success" })));
  assert.equal(green.status, 0, green.out);
  assert.equal(green.calls, 1, "a finished CI is evaluated by a single read, with no waiting");
  // Its refusals are the contract's own: a required failure fails the gate and is named.
  const red = runGate(REQUIRED.map((name) => ({ name, status: "completed", conclusion: name === "claims" ? "failure" : "success" })));
  assert.notEqual(red.status, 0);
  assert.match(red.out, /claims/);
  // A contract with no aggregation step cannot report success.
  assert.throws(() => contractRun("jobs:\n  ci-gate:\n    steps:\n      - run: echo ok\n"), /no ci-gate step defining runs_json/);
  // Actions expressions are left to the calling job, which supplies them itself.
  assert.ok(!("SHA" in contractRun(GATE_TEXT).env));
  const jobEnv = ci.jobs["ci-gate"]!.env!;
  assert.deepEqual(Object.keys(jobEnv).sort(), ["GH_TOKEN", "REPO", "SHA", "WAIT_CAP_SECONDS"]);
  // Its own wait (other workflows' stragglers only) plus the contract's grace window ends inside the
  // job's bound, so the gate's named refusal fires before Actions kills it.
  const timeoutSeconds = (ci.jobs["ci-gate"] as { "timeout-minutes"?: number })["timeout-minutes"]! * 60;
  assert.ok(Number(jobEnv.WAIT_CAP_SECONDS) + Number(contractRun(GATE_TEXT).env.GRACE_WINDOW_SECONDS) < timeoutSeconds);
});

test("W1-T4400: a lost completion event is recovered by the scheduled re-evaluation", () => {
  // The completion that ci-gate can miss is a body gate re-judged AFTER the gate concluded (an edit,
  // or a re-run of an edited-triggered workflow). The daemon's scheduled sweep re-drives ci-gate's own
  // Actions job for exactly that shape — which only works because the gate stays a real job.
  const transition = staleCiGateTransition([
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-09-24T00:10:00Z" },
    { name: "acceptance-author-gate", conclusion: "SUCCESS", startedAt: "2026-09-24T00:20:00Z" },
  ] as Parameters<typeof staleCiGateTransition>[0]);
  assert.deepEqual(transition, { siblingName: "acceptance-author-gate", siblingStartedAt: "2026-09-24T00:20:00Z" });
  // The control: a sibling that succeeded BEFORE the gate concluded is already in its verdict.
  assert.equal(
    staleCiGateTransition([
      { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-09-24T00:10:00Z" },
      { name: "acceptance-author-gate", conclusion: "SUCCESS", startedAt: "2026-09-24T00:05:00Z" },
    ] as Parameters<typeof staleCiGateTransition>[0]),
    undefined,
  );
  // And the gate IS a real Actions job in ci.yml (uses no API-posted check), so that re-drive and a
  // "re-run failed jobs" — which re-runs dependents too — both reach it.
  assert.equal(ci.jobs["ci-gate"]!.steps!.some((s) => /check-runs.*--method POST|POST.*check-runs/.test(s.run ?? "")), false);
});
