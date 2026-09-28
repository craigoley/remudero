import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  API_WINDOW_HOLD_STREAK_FLOOR,
  INITIAL_API_WINDOW_HOLD_STATE,
  reasonAboutApiWindow,
  type ApiWindowHoldState,
} from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import { runTask } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

/**
 * W1-T4662 — A FRESHNESS YIELD IS A HAND-OFF, NOT A TRANSIENT FAILURE.
 *
 * Since #6138, `waitForCiGreen`'s freshness-yield branch (a healthy run that reached the
 * CI-wait boundary and left its OPEN pr_url for a fresher daemon lifetime) wrote the SAME
 * verdict, `blocked_transient`, as a genuine, repeated Anthropic-side API error
 * (test/the-dispatch-loop-is-never-told-the-window-closed.test.ts's own subject). Both
 * daemon.ts's cross-task API-window hold (`reasonAboutApiWindow`) and its lane refill key off
 * that literal string, so a healthy hand-off backed dispatch off exactly as an API outage would.
 *
 * This split gives the yield its own verdict, `handed_off`, carrying the PR it left open. The
 * first test proves the write; the second proves the cross-task hold never starts on it — the
 * task's own stated falsifier ("write blocked_transient on the yield again and the second test
 * sees the hold start").
 */

const PLAN_YAML = [
  "- id: T-HANDOFF-VERDICT",
  "  title: freshness handoff verdict fixture",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/run-task.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test",
    effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

test("W1-T4662: a freshness yield is ledgered as a hand-off carrying its PR", async (t) => {
  const PR_URL = "https://github.com/acme/remudero/pull/1";
  const HEAD_SHA = "c".repeat(40);
  const OLD_SHA = "a".repeat(40);
  const NEW_SHA = "b".repeat(40);
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}handoff-verdict-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);

  // A LOCAL, offline origin — no network, matching every other fixture in this suite.
  const origin = gitRepo({ bare: true, kind: "handoff-verdict-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "handoff-verdict-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "test"]);

  const fixedTime = 1789842000000;
  const branch = `run-T-HANDOFF-VERDICT-${fixedTime}`;
  const gh = ghShim(
    [
      { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "" }) },
      { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    ],
    { kind: "handoff-verdict" },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const now = t.mock.method(Date, "now", () => fixedTime);
  const calls: SpawnWorkerArgs[] = [];
  // The mock worker never pushes its own branch (test/daemon-external-wait-freshness.test.ts's
  // OWN "external wait handoff" fixture uses the identical shape) — run-task.ts's orchestrator
  // fallback push (a separate call site, untouched by this task) carries it to origin instead.
  const spawn: typeof spawnWorker = async (args) => {
    calls.push(args);
    return calls.length === 1
      ? workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" })
      : workerResult({ text: `REPORT\nPR_URL: ${PR_URL}\n` });
  };
  const claimReserver: DispatchClaimReserver = {
    mintAnchor: () => "handoff-verdict-anchor",
    attempt: () => "created",
    holder: () => undefined,
    drop: () => true,
  };

  try {
    const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
    const result = await withLiveWritesAllowed(() =>
      runTask("T-HANDOFF-VERDICT", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        claimReserver,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        externalWaitFreshness: () => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA }),
      }),
    );
    assert.equal(result.verdict, "handed_off", "a healthy freshness yield is a hand-off, never a transient failure");
    assert.equal(result.prUrl, PR_URL, "the hand-off carries the PR it left open");
    assert.equal(result.merged, false);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const verdictLine = ledger.find((line) => line.step === "verdict");
    assert.ok(verdictLine, "a verdict row was ledgered");
    assert.equal(verdictLine?.verdict, "handed_off");
    assert.equal(verdictLine?.pr_url, PR_URL, "the ledgered hand-off names the PR it left open");
    assert.notEqual(verdictLine?.verdict, "blocked_transient", "the falsifier: never the shared, ambiguous value again");
  } finally {
    now.mock.restore();
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4662: a hand-off never starts the API-window hold", () => {
  // The falsifier, stated in the task's own words: "write blocked_transient on the yield again
  // and the second test sees the hold start." Two DIFFERENT task ids ending `blocked_transient`
  // back-to-back crosses the hold floor (the-dispatch-loop-is-never-told-the-window-closed.test.ts's
  // own proof) — the SAME shape, run here with `handed_off`, must hold NOTHING.
  let state: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  let d = reasonAboutApiWindow(state, "A", "handed_off", 1000);
  state = d.state;
  assert.equal(d.holdMs, 0, "the first task's hand-off holds nothing");
  assert.deepEqual(state, INITIAL_API_WINDOW_HOLD_STATE, "a hand-off never advances the streak at all");
  d = reasonAboutApiWindow(state, "B", "handed_off", 1000);
  state = d.state;
  assert.equal(d.holdMs, 0, "a SECOND, different task id also hand-off still holds nothing");
  assert.deepEqual(state, INITIAL_API_WINDOW_HOLD_STATE, "two different tasks' hand-offs never cross the floor a real outage would");

  // Many more, well past API_WINDOW_HOLD_STREAK_FLOOR, in case a future edit keys the reset off
  // "streak below floor" rather than "verdict is not blocked_transient" — this would still catch it.
  const ids = ["C", "D", "E", "F", "G"];
  assert.ok(ids.length > API_WINDOW_HOLD_STREAK_FLOOR);
  for (const id of ids) {
    d = reasonAboutApiWindow(state, id, "handed_off", 1000);
    state = d.state;
    assert.equal(d.holdMs, 0, `hand-off #${id} still holds nothing`);
  }

  // Interleaving a GENUINE blocked_transient after a run of hand-offs still behaves exactly as a
  // lone transient refusal would — the hand-offs preceding it left no residue to build on.
  d = reasonAboutApiWindow(state, "H", "blocked_transient", 1000);
  state = d.state;
  assert.equal(d.holdMs, 0, "one genuine transient refusal after only hand-offs is still just one refusal");
  assert.equal(state.streak, 1);
});
