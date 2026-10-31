import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import { loadPlan } from "#src/lib/plan.js";
import { taskAttributableLifetimeDispatches } from "#src/lib/status.js";
import type { spawnWorker, WorkerResult } from "#src/lib/worker.js";
import {
  auditedLifetimeTalliesFromArchives, breakerGateFor, MAX_LIFETIME_ARCHIVE_START_IDENTITIES,
  routeAdaptiveLifetimePressure,
} from "#test/helpers/run-task-test.js"; // the shared run-task seam: the reach ratchet admits no new direct importer

type Row = Record<string, unknown>;
const taskId = "W1-T7837";
const start = (run_id: string, task_id = taskId): Row => ({ task_id, run_id, step: "run.start" });
const verdict = (run_id: string, value: string, reason = ""): Row =>
  ({ task_id: taskId, run_id, step: "verdict", verdict: value, reason });
const encode = (rows: readonly Row[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-lifetime-once-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const archive = (rows: readonly Row[], n = 0, gzip = false) => {
    const path = join(stateDir, `ledger.2026-10-11T00-00-0${n}-000Z.ndjson${gzip ? ".gz" : ""}`);
    writeFileSync(path, gzip ? gzipSync(encode(rows)) : encode(rows));
  };
  archive([start("control", "OTHER")]);
  writeFileSync(ledgerPath, "");
  const live = (rows: readonly Row[]) => writeFileSync(ledgerPath, encode(rows));
  const append = (rows: readonly Row[]) => appendFileSync(ledgerPath, encode(rows));
  const history = async () => {
    const audit = await auditedLifetimeTalliesFromArchives(stateDir);
    assert.equal(audit.unavailableReason, undefined);
    assert.ok(audit.history, "a readable archive enables the real live overlay");
    return audit.history;
  };
  return { root, stateDir, ledgerPath, archive, live, append, history };
}

async function judgeRoute(f: ReturnType<typeof fixture>, prompts: string[]) {
  mkdirSync(join(f.root, ".remudero"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", ".remudero", "mounts.yaml"), join(f.root, ".remudero", "mounts.yaml"));
  const planPath = join(f.root, "tasks.yaml");
  writeFileSync(planPath, `- id: ${taskId}\n  title: lifetime attribution\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`);
  const plan = loadPlan(planPath);
  const spawn: typeof spawnWorker = async (args) => {
    prompts.push(JSON.stringify(args));
    return { text: "VERIFY_HUMAN_DECISION: backlog\nVERIFY_HUMAN_REASON: retry the worker" } as WorkerResult;
  };
  return routeAdaptiveLifetimePressure([plan.byId.get(taskId)!], {
    plan, root: f.root, config: { root: f.root } as Config, ledgerPath: f.ledgerPath,
    runId: "LIFETIME-ONCE", shadowJudgeSpawns: { primary: spawn, shadow: spawn },
  });
}

test("W1-T8164: a failed restart checkpoint is not a lifetime attempt", async (t) => {
  const f = fixture(t);
  const rows = [
    start("save"), verdict("save", "no_pr", "restart_checkpoint_failed"),
    start("restore"), verdict("restore", "no_pr", "restart_checkpoint_restore_failed"),
  ];
  assert.equal(taskAttributableLifetimeDispatches(rows, taskId), 0);
  f.live(rows);
  const prompts: string[] = [];
  assert.equal((await judgeRoute(f, prompts)).judged, 0);
  assert.equal(prompts.length, 0);
  f.append([start("worker"), verdict("worker", "failed", "worker failure")]);
  assert.equal((await judgeRoute(f, prompts)).judged, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /attributable dispatches=1/);
  assert.match(prompts[0]!, /attributable terminal-verdict history=failed: worker failure/);
  assert.doesNotMatch(prompts[0]!, /restart_checkpoint_(?:restore_)?failed/);
});

test("W1-T8164: an archived yield or refusal is not a lifetime attempt", async (t) => {
  const f = fixture(t);
  const nonWorker = [
    verdict("yield", "handed_off", "freshness_yield"),
    verdict("claim", "blocked_inflight"),
    verdict("fetch", "blocked_git_fetch"),
    verdict("infra", "blocked_transient"),
    { ...verdict("containment", "failed"), stage: "preflight.containment" },
    verdict("checkpoint", "no_pr", "restart_checkpoint_failed"),
    verdict("restore", "no_pr", "restart_checkpoint_restore_failed"),
  ];
  f.archive(nonWorker.map((row) => start(String(row.run_id))), 1, true);
  f.archive(nonWorker, 2);
  const audit = await auditedLifetimeTalliesFromArchives(f.stateDir);
  assert.equal(audit.archiveCount, 3, "both archive forms and the positive control were read");
  assert.ok(audit.history);
  assert.deepEqual(audit.history.tallyFor("OTHER"), { starts: 1, capacityBlocked: 0 });
  assert.deepEqual(audit.history.tallyFor(taskId), { starts: 0, capacityBlocked: 0 });
  assert.equal(breakerGateFor(f.ledgerPath, [], audit.history).isLifetimeCapExceeded(taskId), false);
});

test("W1-T8164: a live start is counted once, not twice", async (t) => {
  const f = fixture(t);
  f.live([start("first")]);
  const history = await f.history();
  const gate = breakerGateFor(f.ledgerPath, [], history);
  assert.deepEqual(history.tallyFor(taskId), { starts: 1, capacityBlocked: 0 });
  assert.equal(gate.isLifetimeCapExceeded(taskId), false);
  f.append([start("second")]);
  gate.beginSelectionPass();
  assert.deepEqual(history.tallyFor(taskId), { starts: 2, capacityBlocked: 0 });
  assert.equal(gate.isLifetimeCapExceeded(taskId), true, "two genuine attempts still signal pressure");
});

test("W1-T8164: the W1-T7837 runs report no lifetime pressure", async (t) => {
  const f = fixture(t);
  const rows = [
    start("W1-T7837-1791691978673"),
    verdict("W1-T7837-1791691978673", "no_pr", "restart_checkpoint_failed"),
    start("W1-T7837-1791700996261"),
    verdict("W1-T7837-1791700996261", "handed_off", "freshness_yield"),
    start("W1-T7837-1791707730822"),
    verdict("W1-T7837-1791707730822", "handed_off", "freshness_yield"),
  ];
  assert.equal(taskAttributableLifetimeDispatches(rows, taskId), 0);
  f.archive(rows.slice(0, 2), 1, true);
  f.live(rows);
  const history = await f.history();
  assert.deepEqual(history.tallyFor(taskId), { starts: 0, capacityBlocked: 0 });
  assert.equal(breakerGateFor(f.ledgerPath, [], history).isLifetimeCapExceeded(taskId), false);
  const prompts: string[] = [];
  assert.equal((await judgeRoute(f, prompts)).judged, 0);
  assert.equal(prompts.length, 0);
});

test("W1-T8164: capacity receipts are deducted once across archive and live history", async (t) => {
  const f = fixture(t);
  f.archive([start("archived"), verdict("archived", "failed")], 1);
  f.live([start("blocked-1"), start("blocked-2"), start("worker"), verdict("worker", "no_pr", "worker produced no edits"),
    { step: "daemon.spawn_infra_blocked", task_id: "DAEMON", task: taskId, reason: "capacity-1" },
    { step: "daemon.spawn_infra_blocked", task_id: "DAEMON", task: taskId, reason: "capacity-2" }]);
  const history = await f.history();
  assert.deepEqual(history.tallyFor(taskId), { starts: 4, capacityBlocked: 2 });
  assert.equal(breakerGateFor(f.ledgerPath, [], history).isLifetimeCapExceeded(taskId), true);
});

test("W1-T8164: verdict pairing survives boot and rotation without replaying starts", async (t) => {
  const f = fixture(t);
  f.archive([start("pending")], 1);
  f.live([start("pending"), start("live"), verdict("live", "failed")]);
  const history = await f.history();
  assert.deepEqual(history.tallyFor(taskId), { starts: 2, capacityBlocked: 0 });
  renameSync(f.ledgerPath, join(f.stateDir, "ledger.2026-10-11T00-00-09-000Z.ndjson"));
  f.live([verdict("pending", "handed_off")]);
  assert.deepEqual(history.tallyFor(taskId), { starts: 1, capacityBlocked: 0 });
  const gate = breakerGateFor(f.ledgerPath, [], history);
  assert.equal(gate.isLifetimeCapExceeded(taskId), false);
  f.append([start("new-worker"), verdict("new-worker", "failed")]);
  gate.beginSelectionPass();
  assert.equal(gate.isLifetimeCapExceeded(taskId), true);
});

test("W1-T8164: proven live orphans are excluded while unknown and working runs stay charged", async (t) => {
  const f = fixture(t);
  f.live([
    { ...start("orphan"), ts: "2026-10-11T00:00:00.000Z" },
    start("unknown"),
    { ts: "2026-10-11T12:00:00.000Z", task_id: "DAEMON", step: "daemon.heartbeat" },
  ]);
  const history = await f.history();
  assert.deepEqual(history.tallyFor(taskId), { starts: 1, capacityBlocked: 0 });
  assert.equal(breakerGateFor(f.ledgerPath, [], history).isLifetimeCapExceeded(taskId), false);
  f.append([{ task_id: taskId, run_id: "orphan", step: "implement.done", verdict: "failed" }]);
  assert.deepEqual(history.tallyFor(taskId), { starts: 2, capacityBlocked: 0 });
  assert.equal(breakerGateFor(f.ledgerPath, [], history).isLifetimeCapExceeded(taskId), true);
});

test("W1-T8164: a retained verdict before its archived start still excludes that attempt", async (t) => {
  const f = fixture(t);
  f.archive([verdict("retained", "handed_off")], 1);
  f.archive([start("retained"), start("unknown"), start("worker"), verdict("worker", "failed")], 2);
  assert.deepEqual((await f.history()).tallyFor(taskId), { starts: 2, capacityBlocked: 0 });
});

test("W1-T8164: unmatched terminal joins obey the existing identity ceiling", async (t) => {
  const f = fixture(t);
  f.archive(Array.from({ length: MAX_LIFETIME_ARCHIVE_START_IDENTITIES }, (_, n) => verdict(`unmatched-${n}`, "handed_off")), 1);
  const audit = await auditedLifetimeTalliesFromArchives(f.stateDir);
  assert.equal(audit.history, undefined);
  assert.equal(audit.unavailableReason, "start_identity_ceiling");
});

test("W1-T8164: a live identity overflow falls back to the attributable live sensor", async (t) => {
  const f = fixture(t);
  const count = MAX_LIFETIME_ARCHIVE_START_IDENTITIES - 1;
  f.archive(Array.from({ length: count }, (_, n) => start(`archived-${n}`)), 1);
  const history = await f.history();
  assert.deepEqual(history.tallyFor(taskId), { starts: count, capacityBlocked: 0 });
  f.live([start("over-ceiling"), start("second")]);
  assert.equal(history.tallyFor(taskId), undefined);
  assert.equal(breakerGateFor(f.ledgerPath, [], history).isLifetimeCapExceeded(taskId), true);
});
