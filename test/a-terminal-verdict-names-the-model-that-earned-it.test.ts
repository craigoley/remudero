// W1-T3080: before this task all 23 `log("verdict", ...)` sites in run-task.ts omitted `model`
// entirely, and the one row that DID carry the model that actually SERVED a call
// (`implement.done`, via `workerLedgerFields`) was in neither ledger-rotation retention set — so
// per-model cost/merge-rate stayed unmeasurable for the class-routing decision W1-T167 exists to
// make. This file proves both halves BEHAVIORALLY (a real `runTask` run, no network, no real
// Claude/gh spawn — the same injected-preflight technique test/containment-wiring.test.ts and
// test/run-task.test.ts's followup-harvest suite already use) plus the retro reader's priority
// order over the now-populated `verdict`/`implement.done` rows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { runModelAttribution, runModelIndex, type LedgerRecord } from "../src/lib/retro.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const FIXTURE_PLAN = [
  "- id: TST-MODELROW",
  "  title: terminal verdict model-attribution probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const passingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const passingIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A dropped containment probe — the run refuses BEFORE any task worker (recon/implement) spawns,
 *  so there is no `WorkerResult` at all to read a model off. */
const droppedContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt`,
    outsideWriteCreated: true,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** A real, throwaway bare "origin" + a real clone at `repoDir` (mirrors test/run-task.test.ts's
 *  `followupGitFixture`) — `worktreeAdd`'s own `git fetch`/`git worktree add` and the run's later
 *  `git push origin HEAD` run for real, entirely offline. */
function gitFixture(root: string): void {
  const origin = gitRepo({ bare: true, kind: "modelrow-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "modelrow-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "modelrow-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "modelrow-test"]);
}

function readLedger(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── Criterion 1a: a pre-spawn refusal writes `model: null` explicitly, never omits it ───────

test("BEHAVIORAL: a dropped containment probe (no worker ever spawns) ledgers a verdict with model AND served_model explicitly null", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}modelrow-containment-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  const spawn = (async () => {
    throw new Error("spawn must never run — the containment preflight must refuse first");
  }) as typeof spawnWorker;

  try {
    const res = await runTask("TST-MODELROW", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn,
      containmentExec: droppedContainmentExec,
    });
    assert.equal(res.verdict, "blocked_containment");

    const verdictLine = readLedger(root).find((l) => l.step === "verdict" && l.verdict === "blocked_containment");
    assert.ok(verdictLine, "a blocked_containment verdict line was ledgered");
    assert.equal(verdictLine!.model, null, "no worker ran — model is explicitly null, never omitted (P48)");
    assert.equal(verdictLine!.served_model, null, "no worker ran — served_model is explicitly null too");
    assert.equal("routed_model" in verdictLine!, false, "routed_model rides along only when present — absent here");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Criterion 1b: a real terminal verdict (a worker DID run) carries model, served_model and,
// when present, routed_model — off the SAME WorkerResult that produced the verdict, never a
// guess. FALSIFIER (per this task's own falsifier clause): removing the
// `...terminalVerdictFields(impl)` spread from the `no_pr` writer in run-task.ts makes this
// fixture fail, because the assertion reads the ACTUAL ledgered line a real `runTask` run wrote,
// not a call to any pure helper in isolation. ────────────────────────────────────────────────

test("BEHAVIORAL: a real implement run's no_pr verdict carries the SERVED model, not just the mount that was resolved", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}modelrow-nopr-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const spawnCalls: number[] = [];
  const spawn: typeof spawnWorker = async () => {
    spawnCalls.push(1);
    if (spawnCalls.length === 1) {
      return {
        sessionId: "s-recon",
        costUsd: 0,
        numTurns: 1,
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
        blocks: [],
        stderr: "",
        subtype: "success",
        isError: false,
        apiError: false,
        permissionDenials: [],
        childEnvKeys: [],
        model: "default",
        effort: "default",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsage: {},
        compactionEvents: [],
        qualitySuspect: false,
      } satisfies WorkerResult;
    }
    // The implement worker: a clean success that commits/opens nothing (the ordinary no_pr
    // path), naming a model DIFFERENT from what actually served the call — exactly the shape
    // provider routing / model-health fallback produces (W1-T2704, W1-T2572).
    return {
      sessionId: "s-implement",
      costUsd: 0.02,
      numTurns: 3,
      text: "REPORT\nno PR opened yet\n",
      blocks: [],
      stderr: "",
      subtype: "success",
      isError: false,
      apiError: false,
      permissionDenials: [],
      childEnvKeys: [],
      model: "sonnet",
      routedModel: "claude-haiku-4-5",
      servedModel: "claude-haiku-4-5-20251001",
      effort: "default",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {},
      compactionEvents: [],
      qualitySuspect: false,
    } satisfies WorkerResult;
  };

  try {
    const res = await runTask("TST-MODELROW", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn,
      containmentExec: passingContainmentExec,
      isolationExec: passingIsolationExec,
    });
    assert.equal(res.verdict, "no_pr");

    const ledger = readLedger(root);
    const verdictLine = ledger.find((l) => l.step === "verdict" && l.verdict === "no_pr");
    assert.ok(verdictLine, "a no_pr verdict line was ledgered");
    assert.equal(verdictLine!.model, "sonnet", "the mount-requested model rides the row exactly like it always has");
    assert.equal(verdictLine!.served_model, "claude-haiku-4-5-20251001", "the model that ACTUALLY SERVED the call — not the mount alone");
    assert.equal(verdictLine!.routed_model, "claude-haiku-4-5", "a routing decision, when one fired, is carried too");

    // Criterion 2: implement.done (the row `workerLedgerFields` already populated with the same
    // served_model) is registered for rotation survival — grep proof lives in src/lib/ledger.ts,
    // this asserts the registration is real, not merely present in a comment.
    assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("implement.done"), "implement.done must survive rotation (W1-T3080)");
    const implementDoneLine = ledger.find((l) => l.step === "implement.done");
    assert.ok(implementDoneLine, "implement.done was ledgered for this run");
    assert.equal(implementDoneLine!.served_model, "claude-haiku-4-5-20251001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Criterion 3: the retro's `runModelAttribution` prefers a `verdict` row's served_model over
// every other source, in the exact priority order this task's design fixes, and names WHICH
// source it used. ─────────────────────────────────────────────────────────────────────────────

function records(...rows: Record<string, unknown>[]): LedgerRecord[] {
  return rows.map((r) => r as LedgerRecord);
}

test("runModelAttribution: verdict.served_model outranks every other source, including the same row's own model key", () => {
  const RUN = "W1-T9001-1788000000000";
  const corpus = records(
    { run_id: RUN, task_id: "W1-T9001", step: "run.start", type: "implement", mount: { model: "opus" } },
    { run_id: RUN, task_id: "W1-T9001", step: "implement.done", model: "sonnet", served_model: "claude-sonnet-4-5" },
    { run_id: RUN, task_id: "W1-T9001", step: "verdict", verdict: "merged", model: "sonnet", served_model: "claude-opus-4-1" },
  );
  const attribution = runModelAttribution(corpus);
  assert.deepEqual(attribution.get(RUN), { model: "claude-opus-4-1", source: "verdict.served_model" });
  assert.equal(runModelIndex(corpus).get(RUN), "claude-opus-4-1", "runModelIndex projects the same winning model");
});

test("runModelAttribution: verdict.model outranks implement.done entirely when the verdict row carries no served_model", () => {
  const RUN = "W1-T9002-1788000000001";
  const corpus = records(
    { run_id: RUN, task_id: "W1-T9002", step: "run.start", type: "implement", mount: { model: "opus" } },
    { run_id: RUN, task_id: "W1-T9002", step: "implement.done", model: "sonnet", served_model: "claude-sonnet-4-5" },
    { run_id: RUN, task_id: "W1-T9002", step: "verdict", verdict: "merged", model: "haiku" },
  );
  const attribution = runModelAttribution(corpus);
  assert.deepEqual(attribution.get(RUN), { model: "haiku", source: "verdict.model" });
});

test("runModelAttribution: falls through implement.done.served_model, then implement.done.model, then run.start.mount.model, in that order", () => {
  const SERVED_RUN = "W1-T9003-1788000000002";
  const MODEL_ONLY_RUN = "W1-T9004-1788000000003";
  const MOUNT_ONLY_RUN = "W1-T9005-1788000000004";
  const corpus = records(
    { run_id: SERVED_RUN, task_id: "W1-T9003", step: "run.start", type: "implement", mount: { model: "opus" } },
    { run_id: SERVED_RUN, task_id: "W1-T9003", step: "implement.done", model: "sonnet", served_model: "claude-sonnet-4-5" },
    { run_id: SERVED_RUN, task_id: "W1-T9003", step: "verdict", verdict: "merged" },
    { run_id: MODEL_ONLY_RUN, task_id: "W1-T9004", step: "run.start", type: "implement", mount: { model: "opus" } },
    { run_id: MODEL_ONLY_RUN, task_id: "W1-T9004", step: "implement.done", model: "sonnet" },
    { run_id: MODEL_ONLY_RUN, task_id: "W1-T9004", step: "verdict", verdict: "merged" },
    { run_id: MOUNT_ONLY_RUN, task_id: "W1-T9005", step: "run.start", type: "implement", mount: { model: "opus" } },
    { run_id: MOUNT_ONLY_RUN, task_id: "W1-T9005", step: "verdict", verdict: "merged" },
  );
  const attribution = runModelAttribution(corpus);
  assert.deepEqual(attribution.get(SERVED_RUN), { model: "claude-sonnet-4-5", source: "implement.done.served_model" });
  assert.deepEqual(attribution.get(MODEL_ONLY_RUN), { model: "sonnet", source: "implement.done.model" });
  assert.deepEqual(attribution.get(MOUNT_ONLY_RUN), { model: "opus", source: "run.start.mount.model" });
});
