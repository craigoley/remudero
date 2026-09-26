import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ledgeredNonDispatchSpawn } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";

test("W1-T4457 criterion 1: a non-dispatch worker spawn ledgers its worker assignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-nondispatch-assignment-"));
  try {
    const assignment = {
      version: 1, id: "selected-1", phase: "pre-execution",
      requested: { model: "gpt-6-luna", effort: "low", maxTurns: 3 },
      selected: { provider: "cash", model: "gpt-6-luna", effort: "low" },
      routing: { mode: "mount-affinity", policy: { preference: "automatic", reservePercent: 0, provenance: "default" } },
      candidates: [],
    } as WorkerSelectionAssignment;
    const result = { text: "done" } as WorkerResult;
    let callbackSeen = 0;
    const raw = (async (args: SpawnWorkerArgs) => {
      args.onSelectionAssignment?.(assignment);
      return result;
    }) as typeof import("../src/lib/worker.js").spawnWorker;
    const spawn = ledgeredNonDispatchSpawn("triage", raw);
    assert.equal(await spawn({
      cwd: root, permissionMode: "bypassPermissions", settingsFile: "settings.json", prompt: "x",
      config: { root } as Config,
      onSelectionAssignment: (observed) => { assert.equal(observed.id, assignment.id); callbackSeen += 1; },
    }), result);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((rawLine) => JSON.parse(rawLine));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, "worker.assignment");
    assert.equal(rows[0].lane, "triage");
    assert.equal(rows[0].worker_assignment.id, "selected-1");
    assert.equal(rows[0].worker_assignment.selected.provider, "cash");
    assert.equal(rows[0].task_id, "TRIAGE");
    assert.equal(rows[0].run_id, "triage-selected-1");
    assert.equal(callbackSeen, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the existing non-dispatch defaults use the assignment sink, including cash-eligible lanes", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const lanes = new Set([...source.matchAll(/ledgeredNonDispatchSpawn\("([^"]+)"/g)].map((match) => match[1]));
  for (const lane of ["review", "promotion-judge", "retro", "serve-feedback", "triage", "plan",
    "inbox-draft", "risk-judge", "alert-fix", "onboard-synthesis"]) {
    assert.equal(lanes.has(lane), true, `${lane} must not silently lose its assignment sink`);
  }
});
