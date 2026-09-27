// W1-T4616: from 2026-09-27T00Z core logged ~105/h `verify-human-judge` and `escalation-summary`
// worker.attempt rows reading only `spawn-threw-before-result` — no assignment, no cause. The thrown
// error is now kept, redacted and bounded, and a failure before any model was selected says so.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkNonDispatchSpawn, SPAWN_FAILURE_MESSAGE_MAX_CHARS, spawnFailureDetail } from "../src/lib/benchmark-run.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { recordBenchmarkWorkerAttempt } from "../src/run-task.js";

const SECRET = "sk-ant-api03-SENSITIVEvalue1234567890";
const PATH = "/home/node/Remudero/worker-home-1de6/.claude.json";

function thrown(): Error {
  return Object.assign(new Error(`Claude configuration file not found at: ${PATH} (key ${SECRET})`), { code: "ENOENT" });
}

function attempts(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "worker.attempt");
}

function args(root: string): SpawnWorkerArgs {
  return { cwd: root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt: "p", config: { root } as Config };
}

const assignment = { version: 1, id: "asg-1", phase: "pre-execution",
  requested: { model: "haiku", effort: "low", maxTurns: 2 }, selected: { provider: "claude", model: "haiku", effort: "low" },
  routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
  candidates: [] } as unknown as WorkerSelectionAssignment;

test("W1-T4616: a spawn that throws before selection records a bounded, redacted cause and is marked pre-selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4616-"));
  try {
    const before = benchmarkNonDispatchSpawn("verify-human-judge", async () => { throw thrown(); });
    await assert.rejects(before(args(root)), /configuration file not found/, "the caller still sees the original error");
    const after = benchmarkNonDispatchSpawn("escalation-summary", async (a) => {
      a.onSelectionAssignment?.(assignment);
      throw thrown();
    });
    await assert.rejects(after(args(root)));
    const [pre, post] = attempts(root);
    assert.equal(pre.worker_failure, "spawn-threw-before-result");
    assert.equal(pre.pre_selection, true, "no model was ever selected");
    assert.equal(pre.error_class, "Error");
    assert.equal(pre.error_code, "ENOENT");
    assert.match(String(pre.error_message), /Claude configuration file not found at: <path>/);
    assert.equal(post.pre_selection, false);
    assert.equal(post.selection_assignment_id, "asg-1");
    const text = JSON.stringify(attempts(root));
    assert.doesNotMatch(text, /SENSITIVEvalue|worker-home-1de6|\/home\/node/, "no credential or path reaches the ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The dispatch path's receipt carries the same cause.
  const logged: Record<string, unknown>[] = [];
  await assert.rejects(recordBenchmarkWorkerAttempt(
    () => Promise.reject(thrown()), (_step, fields) => logged.push(fields), () => undefined, () => undefined));
  assert.equal(logged[0].pre_selection, true);
  assert.equal(logged[0].error_code, "ENOENT");

  // A long message is bounded; a non-Error throw is still named.
  const long = spawnFailureDetail(new Error("x ".repeat(2000)), false);
  assert.ok(String(long.error_message).length <= SPAWN_FAILURE_MESSAGE_MAX_CHARS);
  assert.equal(spawnFailureDetail("plain string", true).error_class, "string");
});
