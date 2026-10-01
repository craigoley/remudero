import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config-schema.js";
import { taskAttributableLifetimeDispatches } from "../src/lib/status.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import { routeAdaptiveLifetimePressure } from "../src/run-task.js";

function fixture(note = "") {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lifetime-judge-"));
  mkdirSync(join(dir, ".remudero"));
  copyFileSync(join(import.meta.dirname, "..", ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "tasks.yaml"), `- id: T-LIFETIME\n  title: feature with runtime confirmation\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  note: ${JSON.stringify(note)}\n`);
  const plan = loadPlan(join(dir, "tasks.yaml"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const rows = (items: Record<string, unknown>[]) => writeFileSync(ledgerPath, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const read = (): Record<string, unknown>[] => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let calls = 0;
  let prompt = "";
  const spawn: typeof spawnWorker = async (args) => {
    calls++;
    prompt = JSON.stringify(args);
    return { text: "VERIFY_HUMAN_DECISION: backlog\nVERIFY_HUMAN_REASON: task needs another attempt" } as WorkerResult;
  };
  const route = () => routeAdaptiveLifetimePressure([plan.byId.get("T-LIFETIME")!], {
    plan, root: dir, config: { root: dir } as Config, ledgerPath, runId: "LIFETIME-TEST",
    shadowJudgeSpawns: { primary: spawn, shadow: spawn },
  });
  return { rows, read, route, get calls() { return calls; }, get prompt() { return prompt; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const start = { task_id: "T-LIFETIME", run_id: "worker-1", step: "run.start" };
const failed = { task_id: "T-LIFETIME", run_id: "worker-1", step: "verdict", verdict: "failed", reason: "worker failed" };

test("W1-T5109: an unchanged task is judged once however many telemetry rows it accrues", async () => {
  const f = fixture();
  try {
    f.rows([start, failed]);
    assert.equal((await f.route()).judged, 1);
    assert.match(f.prompt, /BUILDING the task/i);
    assert.match(f.prompt, /worker failed/);
    const count = f.calls;
    f.rows([...f.read(), { task_id: "T-LIFETIME", step: "sweep.disposed" }, { task_id: "T-LIFETIME", step: "dispatch.skipped" }]);
    assert.equal((await f.route()).judged, 0);
    assert.equal(f.calls, count);
  } finally { f.cleanup(); }
});

test("W1-T5109: a new terminal verdict re-opens the judgment", async () => {
  const f = fixture();
  try {
    f.rows([start, failed]);
    await f.route();
    const count = f.calls;
    f.rows([...f.read(), { task_id: "T-LIFETIME", run_id: "worker-2", step: "verdict", verdict: "failed", reason: "different failure" }]);
    assert.equal((await f.route()).judged, 1);
    assert.equal(f.calls, count + 1);
  } finally { f.cleanup(); }
});

test("W1-T5109: infrastructure refusals do not count as the task lifetime attempts", async () => {
  const f = fixture();
  try {
    const rows = [
      { task_id: "T-LIFETIME", run_id: "lock", step: "run.start" },
      { task_id: "T-LIFETIME", run_id: "lock", step: "verdict", verdict: "blocked_transient" },
      { task_id: "T-LIFETIME", run_id: "containment", step: "run.start" },
      { task_id: "T-LIFETIME", run_id: "containment", step: "verdict", verdict: "failed", stage: "preflight.containment" },
      { task_id: "T-LIFETIME", run_id: "claim", step: "run.start" },
      { task_id: "T-LIFETIME", run_id: "claim", step: "verdict", verdict: "blocked_inflight" },
      { task_id: "T-LIFETIME", run_id: "github", step: "run.start" },
      { task_id: "T-LIFETIME", run_id: "github", step: "verdict", verdict: "blocked_git_fetch" },
      { task_id: "T-LIFETIME", run_id: "freshness", step: "run.start" },
      { task_id: "T-LIFETIME", run_id: "freshness", step: "verdict", verdict: "handed_off" },
    ];
    assert.equal(taskAttributableLifetimeDispatches(rows, "T-LIFETIME"), 0);
    f.rows(rows);
    assert.equal((await f.route()).judged, 0);
    assert.equal(f.calls, 0);
    assert.equal(f.read().filter((row) => row.step === "dispatch.lifetime_pressure.infra_only").length, 1);
    await f.route();
    assert.equal(f.read().filter((row) => row.step === "dispatch.lifetime_pressure.infra_only").length, 1);
  } finally { f.cleanup(); }
});

test("W1-T5109: a recorded operator ruling is honoured without a judge spawn", async () => {
  const f = fixture("OPERATOR RULING 2026-09-30: needs_operator\nOPERATOR RULING 2026-10-01: automate. Building needs no operator.");
  try {
    f.rows([start, failed]);
    assert.equal((await f.route()).judged, 1);
    assert.equal(f.calls, 0);
    assert.equal(f.read().find((row) => row.step === "verify_human.judged")?.judge_decision, "automate");
    assert.equal((await f.route()).judged, 0);
    assert.equal(f.calls, 0);
  } finally { f.cleanup(); }
});
