import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  decisionRecordContent, decisionRecordRelPath, queuedFeedbackDir, queuedFeedbackLandings,
  recordDecisionAsync, sweepFeedbackLandingAsync, type LandFeedbackAsyncOpts,
} from "#src/lib/feedback-landing.js";
import { feedbackEntryPath, feedbackEntryRepoPath } from "#src/lib/feedback.js";
import { FOLD_DEBT_INGESTED_STEP, landFoldDebt } from "#src/lib/fold-debt-pull.js";
import { alertFeedbackId, pollAlerts } from "#src/lib/ops.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { makeTempDir } from "#src/lib/tmp.js";

function forbidSyncPreflight(t: TestContext) {
  const fail = () => { throw new Error("sync preflight reached the daemon loop"); };
  const spawn = t.mock.method(childProcess, "spawnSync", fail);
  const exec = t.mock.method(childProcess, "execFileSync", fail);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => {
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(exec.mock.callCount(), 0);
  };
}

function scratch(t: TestContext) {
  const root = makeTempDir("w9735-landings");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function landingTransport(relPath: string) {
  const calls: string[][] = [];
  const contents: string[] = [];
  const preflights: string[] = [];
  const repository = { owner: "fixture", repo: "landing" };
  const opts: LandFeedbackAsyncOpts = {
    targetRepository: repository,
    sourceRepository: repository,
    git: () => { throw new Error("sync landing transport reached"); },
    gh: () => { throw new Error("sync github transport reached"); },
    gitAsync: async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") {
        if (args[1] === "origin/main") return "main-sha";
        if (args[1] === "main-sha^{tree}") return "main-tree";
        throw new Error(`fixture ref absent: ${args[1]}`);
      }
      if (args[0] === "hash-object") {
        contents.push(readFileSync(args.at(-1)!, "utf8"));
        return "record-blob";
      }
      if (args[0] === "write-tree") return "landing-tree";
      if (args.includes("commit-tree")) return "landing-commit";
      if (args[0] === "ls-files") return `${relPath}\0`;
      if (["fetch", "ls-remote", "read-tree", "update-index", "push", "diff"].includes(args[0]!)) return "";
      throw new Error(`unexpected fixture git call: ${args.join(" ")}`);
    },
    ghAsync: async (args) => {
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture/landing/pull/9735";
      throw new Error(`unexpected fixture github call: ${args.join(" ")}`);
    },
    planPrPreflight: async (sha) => {
      await Promise.resolve();
      preflights.push(sha);
      return { ok: true, failures: [], unreadable: [] };
    },
  };
  return { opts, calls, contents, preflights };
}

test("W1-T9735: the decision record and the alert status flip never run the sync preflight", async (t) => {
  const root = scratch(t);
  const noSyncCalls = forbidSyncPreflight(t);
  const params = {
    taskId: "W1-T9735", runId: "fixture", options: ["migrate schema", "defer"],
    chosen: "migrate schema", band: "medium", reason: "schema migration",
    falsifier: "the column already exists", ts: new Date().toISOString(),
  };
  const relPath = decisionRecordRelPath(params.taskId, params.runId);
  const transport = landingTransport(relPath);
  const result = await withLiveWritesAllowed(() => recordDecisionAsync(root, params, transport.opts));
  assert.equal(result.landed, true, result.error);
  assert.deepEqual(result.files, [relPath]);
  assert.deepEqual(transport.contents, [decisionRecordContent(params)]);
  assert.deepEqual(transport.preflights, ["landing-commit"]);
  assert.ok(transport.calls.some((args) => args[0] === "push" && args.at(-1) === "landing-commit:refs/heads/decisions-landing"));
  assert.equal(existsSync(join(root, relPath)), false);

  const stateRoot = scratch(t);
  const id = alertFeedbackId("fixture", "landing", { source: "code-scanning", id: "9735" });
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  const before = `id: ${id}\nts: ${new Date().toISOString()}\nraw: dismissed alert\norigin: alert#code-scanning-9735\nstatus: new\n`;
  writeFileSync(feedbackEntryPath(root, id), before);
  const poll = await pollAlerts("fixture", "landing", {
    root, landingStateRoot: stateRoot, ledgerPath: join(stateRoot, "ledger.ndjson"), runId: "fixture",
    alerts: { codeScanning: () => [], dependabot: () => [], secretScanning: () => [] },
    issues: { create: () => { throw new Error("no alert should be escalated"); } },
    readLedger: () => [],
    land: { planPrPreflight: () => { throw new Error("sync status preflight reached"); } },
  });
  assert.deepEqual(poll.reconciled, [id]);
  assert.deepEqual(queuedFeedbackLandings(stateRoot), [feedbackEntryRepoPath(id)]);
  assert.equal(parseYaml(readFileSync(join(queuedFeedbackDir(stateRoot), `${id}.yaml`), "utf8")).status, "rejected");
  assert.equal(readFileSync(feedbackEntryPath(root, id), "utf8"), before);
  noSyncCalls();
});

test("W1-T9735: the fold-debt landing never runs the sync landing", async (t) => {
  const root = scratch(t);
  const noSyncCalls = forbidSyncPreflight(t);
  const id = "fold-debt-claude-md-9735";
  const relPath = feedbackEntryRepoPath(id);
  const text = `id: ${id}\nts: ${new Date().toISOString()}\nraw: fold the standing rules\norigin: gate\nstatus: new\n`;
  const transport = landingTransport(relPath);
  const rows = await withLiveWritesAllowed(() => landFoldDebt([
    { kind: "accepted", artifactId: 9735, workflowRunId: "fixture", lane: "main", entries: [{ id, text }], refused: [] },
  ], {
    owner: "fixture", repo: "landing", root, ingested: new Set(), settled: new Set([9735]),
    readJson: () => { throw new Error("artifact already downloaded"); },
    readZip: () => { throw new Error("artifact already downloaded"); },
    log: () => { throw new Error("no failure should be logged"); },
    land: (checkout) => sweepFeedbackLandingAsync(checkout, transport.opts),
  }));
  assert.deepEqual(rows, [{
    step: FOLD_DEBT_INGESTED_STEP, workflow_run_id: "fixture", artifact_id: 9735, lane: "main",
    entry_ids: [id], written: [id], existing: [], refused: [], landed: true,
  }]);
  assert.deepEqual(transport.preflights, ["landing-commit"]);
  assert.equal(readFileSync(join(root, relPath), "utf8"), text);
  assert.ok(transport.calls.some((args) => args[0] === "push"));
  noSyncCalls();
});
