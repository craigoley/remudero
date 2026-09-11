import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CI_GATE_EVIDENCE_MAX,
  ciGateBlockReason,
  ciGateState,
  runTask,
  waitForCiGreen,
  type PollDeps,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const PR_URL = "https://github.com/acme/remudero/pull/1";

/** Drive the real REST poller without a network. The only mutable state is which rollup the
 * three REST reads for each poll return; the gate still owns classification and bounding. */
function pollDeps(
  rollup: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[],
): PollDeps {
  return {
    readJson: async (args) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) {
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
      }
      if (request.includes("/check-runs")) {
        return {
          check_runs: rollup
            .filter((check) => check.status !== undefined || check.conclusion !== undefined)
            .map((check) => ({ name: check.name, status: check.status ?? "completed", conclusion: check.conclusion ?? null })),
        };
      }
      if (request.includes("/status")) {
        return {
          statuses: rollup
            .filter((check) => check.state !== undefined)
            .map((check) => ({ context: check.context, state: check.state })),
        };
      }
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
  };
}

test("BEHAVIORAL: a red gate carries a bounded, counted set of every failed check into the historical blocked_ci reason", async () => {
  const names = Array.from({ length: CI_GATE_EVIDENCE_MAX + 3 }, (_, index) => `failure-${String(index + 1).padStart(2, "0")}`);
  const outcome = await waitForCiGreen(
    PR_URL,
    () => {},
    0,
    pollDeps(names.map((name) => ({ name, conclusion: "FAILURE" }))),
  );

  assert.equal(ciGateState(outcome), "red");
  assert.equal(outcome.checkCount, names.length, "the row preserves the complete cause count before bounding its names");
  assert.deepEqual(outcome.checks, names.slice(0, CI_GATE_EVIDENCE_MAX), "only the declared bounded prefix is carried");
  assert.equal(
    ciGateBlockReason(outcome),
    `ci red before review; red checks: ${names.slice(0, CI_GATE_EVIDENCE_MAX).join(", ")} (${names.length} total; first ${CI_GATE_EVIDENCE_MAX} shown)`,
    "the historical wording stays as a prefix while the handoff records the failed checks",
  );
});

test("UNIT: missing check evidence and an observed empty set remain distinct blocked_ci handoffs", () => {
  const unavailable = ciGateBlockReason({ state: "red" });
  const none = ciGateBlockReason({ state: "red", checks: [], checkCount: 0 });

  assert.equal(unavailable, "ci red before review; relevant checks unavailable");
  assert.equal(none, "ci red before review; red checks: none (0 total)");
  assert.notEqual(unavailable, none, "a legacy or unreadable outcome must not masquerade as an observed zero-cause gate");
});

test("BEHAVIORAL: a stalled gate remains a timeout and carries its pending checks", async () => {
  const outcome = await waitForCiGreen(
    PR_URL,
    () => {},
    0,
    pollDeps([
      { name: "lint", status: "QUEUED" },
      { context: "integration", state: "PENDING" },
    ]),
  );

  assert.equal(ciGateState(outcome), "timeout", "a quiescent pending rollup is still the existing timeout outcome");
  assert.deepEqual(outcome.checks, ["integration", "lint"]);
  assert.equal(
    ciGateBlockReason(outcome),
    "ci timeout before review; pending checks: integration, lint (2 total)",
    "the terminal format identifies pending rather than falsely calling it red",
  );
});

const LEDGER_FIXTURE_PLAN = [
  "- id: T-CI-EVIDENCE",
  "  title: terminal CI evidence fixture",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
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

function writeOfflineGitFixture(root: string): () => void {
  const origin = gitRepo({ bare: true, kind: "blocked-ci-evidence-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "blocked-ci-evidence-seed" });
  const repo = join(root, "repos", "remudero");
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  return () => {
    origin.cleanup();
    seed.cleanup();
  };
}

function writeRedGateGh(branch: string) {
  return ghShim(
    [
      { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "" }) },
      { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "build", status: "completed", conclusion: "failure" }, { name: "unit", status: "completed", conclusion: "failure" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    ],
    { kind: "blocked-ci-evidence" },
  );
}

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

test("BEHAVIORAL: runTask writes the enriched blocked_ci reason to its terminal ledger row", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blocked-ci-evidence-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, LEDGER_FIXTURE_PLAN);
  const cleanupGit = writeOfflineGitFixture(root);
  const fixedTime = 1785001000000;
  const branch = `run-T-CI-EVIDENCE-${fixedTime}`;
  const gh = writeRedGateGh(branch);
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const dateNow = t.mock.method(Date, "now", () => fixedTime);
  const calls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    calls.push(args);
    return calls.length === 1
      ? workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" })
      : workerResult({ text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  try {
    const config: Config = { claudeBin: "/bin/true", root };
    const result = await withLiveWritesAllowed(() =>
      runTask("T-CI-EVIDENCE", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    assert.equal(result.verdict, "blocked_ci");
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const verdict = ledger.find((line) => line.step === "verdict" && line.verdict === "blocked_ci");
    assert.ok(verdict, "the CI-gate exit writes a terminal blocked_ci row");
    assert.equal(verdict.reason, "ci red before review; red checks: build, unit (2 total)");
  } finally {
    dateNow.mock.restore();
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    cleanupGit();
    rmSync(root, { recursive: true, force: true });
  }
});
