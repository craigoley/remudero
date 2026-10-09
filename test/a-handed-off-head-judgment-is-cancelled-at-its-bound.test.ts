import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runSweep, handedOffHeadJudgmentPool, riskJudgeHandedOffHead, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { realRiskJudge } from "../src/lib/risk-judge.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { Mount } from "../src/lib/mounts.js";

// W1-T5659 — W1-T5523's pool settled an overrunning handed-off-head judgment as unavailable and freed
// its slot, but nothing reached the model call: it kept spending, and its late `risk_judge.decision`
// row (or BLOCKED escalation) was still acted on. The bound now ABORTS the judgment's signal.

const MOUNT = { model: "haiku", effort: "medium" } as unknown as Mount;
const NOW = Date.parse("2026-10-04T12:00:00Z");
const PR = 56590;

function pr(): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR}`,
    taskId: `W1-T${PR}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-04T11:00:00Z",
    headSha: `${PR}aaaa`,
    autoMergeArmed: false,
  };
}

function result(text: string): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  } as unknown as WorkerResult;
}

const HIGH = "RISK_VERDICT: high\nRISK_CONFIDENCE: 0.95\nRISK_REASON: touches auth";
const LOW = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: routine";

test("W1-T5659: a handed-off-head judgment that outlives the pool's bound has its spawn aborted, writes no available risk_judge.decision row and no escalation, and the head is held until a fresh judgment lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5659-`));
  const lines: Array<Record<string, unknown>> = [
    {
      ts: "2026-10-04T10:00:00.000Z",
      run_id: "RUN-1",
      task_id: `W1-T${PR}`,
      step: "verdict",
      verdict: "handed_off",
      pr_url: pr().prUrl,
      reason: "pr_open_yield",
    },
  ];
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lines.push({ ts: "2026-10-04T11:30:00.000Z", run_id: "SWEEP", step, ...extra });
  };
  const escalations: string[] = [];
  // A spawn that IGNORES the abort and answers late — what a model call already in flight does.
  const spawns: Array<{ args: SpawnWorkerArgs; answer: (text: string) => void }> = [];
  const spawn = ((args: SpawnWorkerArgs) =>
    new Promise<WorkerResult>((resolve) => {
      spawns.push({ args, answer: (text) => resolve(result(text)) });
    })) as unknown as typeof spawnWorker;

  const timers: Array<{ fire: () => void; cancelled: boolean }> = [];
  const pool = handedOffHeadJudgmentPool({
    schedule: (_ms, fire) => {
      const t = { fire, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  const armed: string[] = [];
  const deps: SweepDeps = {
    arm: (p) => {
      armed.push(`${p.prNumber}@${p.headSha}`);
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "SWEEP",
    now: () => NOW,
    readLedger: () => lines,
    log,
    handedOffHeadJudgments: pool,
    judgeHandedOffHead: riskJudgeHandedOffHead((p, signal) => ({
      input: { change: { description: p.prUrl }, gatesState: {}, planContext: { taskId: p.taskId } },
      orchestrator: {
        judge: realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/s.json", spawn, signal }),
        escalate: () => {
          escalations.push("filed");
          return "https://github.com/craigoley/remudero/issues/1";
        },
        log,
      },
    })),
  };
  const turns = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  };
  const decisions = () => lines.filter((l) => l.step === "risk_judge.decision");

  try {
  await runSweep([pr()], deps);
  assert.equal(spawns.length, 1, "the judgment spawned once");
  assert.ok(spawns[0].args.signal, "the spawn carries the judgment's signal");
  assert.equal(spawns[0].args.signal!.aborted, false, "not aborted while inside its bound");

  // The bound fires: the spawn is aborted, then the (ignoring) call answers late with an ESCALATING verdict.
  for (const t of timers) if (!t.cancelled) t.fire();
  assert.equal(spawns[0].args.signal!.aborted, true, "the pool's bound aborts the in-flight spawn");
  spawns[0].answer(HIGH);
  await turns();
  assert.deepEqual(decisions(), [], "a cancelled judgment writes no risk_judge.decision row");
  assert.deepEqual(escalations, [], "a cancelled judgment files no escalation");
  assert.equal(lines.filter((l) => l.step === "risk_judge.escalated").length, 0);
  assert.equal(lines.filter((l) => l.step === "sweep.risk_judge_unavailable").length, 1);

  // The next pass holds the head and starts a FRESH judgment; only its landed decision arms the head.
  await runSweep([pr()], deps);
  assert.deepEqual(armed, [], "the head is held until a fresh judgment lands");
  assert.equal(spawns.length, 2, "a fresh judgment was started");
  assert.equal(spawns[1].args.signal!.aborted, false);
  spawns[1].answer(LOW);
  await turns();
  assert.equal(decisions().length, 1, "the fresh judgment's decision row lands");
  await runSweep([pr()], deps);
  assert.deepEqual(armed, [`${PR}@${PR}aaaa`], "the head arms once a fresh judgment proceeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T5659: realRiskJudge starts no further spawn once its signal is aborted, and an unsignalled call is unchanged", async () => {
  const seen: Array<SpawnWorkerArgs> = [];
  const spawn = (async (args: SpawnWorkerArgs) => {
    seen.push(args);
    return result("no verdict here");
  }) as unknown as typeof spawnWorker;
  const controller = new AbortController();
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/s.json", spawn, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => judge({ change: { description: "d" }, gatesState: {}, planContext: {} }), /cancelled/);
  assert.equal(seen.length, 0, "an aborted judgment never spawns");

  const plain = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/s.json", spawn });
  await plain({ change: { description: "d" }, gatesState: {}, planContext: {} });
  assert.equal(seen.length, 3, "unparseable output still retries to the bound when no signal is given");
  assert.equal("signal" in seen[0], false, "no signal key rides an unsignalled spawn");
});
