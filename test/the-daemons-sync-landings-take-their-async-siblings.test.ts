import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  decisionRecordRelPath, queuedFeedbackDir, queuedFeedbackLandings, type LandFeedbackAsyncOpts,
} from "#src/lib/feedback-landing.js";
import { feedbackEntryPath, feedbackEntryRepoPath } from "#src/lib/feedback.js";
import { FOLD_DEBT_INGESTED_STEP, landFoldDebt } from "#src/lib/fold-debt-pull.js";
import { alertFeedbackId, pollAlerts } from "#src/lib/ops.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runTask } from "#test/helpers/run-task-test.js";

function forbidSyncPreflight(t: TestContext, runFlow = false) {
  const fail = () => { throw new Error("sync preflight reached the daemon loop"); };
  const spawn = t.mock.method(childProcess, "spawnSync", fail);
  const unrelatedGitRead = (cmd: unknown, args: unknown) => runFlow && cmd === "git" && Array.isArray(args)
    && (args[0] === "config" || args.includes("rev-parse") || args.includes("log"));
  const exec = t.mock.method(childProcess, "execFileSync", (cmd: string, args?: readonly string[]) => {
    if (unrelatedGitRead(cmd, args)) return "";
    return fail();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => {
    assert.equal(spawn.mock.callCount(), 0);
    const blocked = exec.mock.calls.filter((call) => !unrelatedGitRead(call.arguments[0], call.arguments[1]));
    assert.equal(blocked.length, 0, JSON.stringify(blocked.map((call) => call.arguments.slice(0, 2))));
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
  const origin = gitRepo({ bare: true, scope: t });
  const checkout = gitRepo({ scope: t });
  checkout.addRemote("origin", origin.dir);
  checkout.git("push", "-u", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  cpSync(checkout.dir, join(root, "repos", "landing"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: W1-T9735\n  title: prove the daemon decision landing\n  repo: landing\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/lib/daemon.ts]\n  origin: architect\n  status: queued\n`);
  const transport = landingTransport("");
  let runId = "";
  let noSyncCalls: (() => void) | undefined;
  let workerCalls = 0;
  const resumed = new Error("fixture stopped after the decision was recorded");
  const worker = (text: string): WorkerResult => ({
    sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "low",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  await assert.rejects(withLiveWritesAllowed(() => runTask("W1-T9735", {
    planPath, skipGitSync: true, owner: "fixture",
    config: { root, claudeBin: "/bin/true", installRoot: REPO_ROOT },
    onRunCreated: (id) => { runId = id; },
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    binaryPinDeps: { readCliManifest: () => '{"dependencies":{"@anthropic-ai/claude-code":"1.2.3"}}', runClaudeVersion: () => "1.2.3" },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "clean", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    decisionLanding: transport.opts,
    spawn: async () => {
      if (++workerCalls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      if (workerCalls === 2) {
        noSyncCalls = forbidSyncPreflight(t, true);
        return worker("DECISION_REQUEST\n- migrate schema (RECOMMENDED)\n- defer\nFALSIFIER: the column already exists\n");
      }
      noSyncCalls!();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.deepEqual(transport.preflights, ["landing-commit"], "the run must await the default decision landing before resuming");
      throw resumed;
    },
  })), (error: unknown) => error === resumed);
  assert.equal(workerCalls, 3);
  assert.ok(noSyncCalls, "the implement worker reached DECISION_REQUEST");
  noSyncCalls();
  const relPath = decisionRecordRelPath("W1-T9735", runId);
  assert.equal(transport.contents.length, 1);
  assert.match(transport.contents[0]!, /migrate schema/);
  assert.match(transport.contents[0]!, /the column already exists/);
  assert.deepEqual(transport.preflights, ["landing-commit"]);
  assert.ok(transport.calls.some((args) => args[0] === "push" && args.at(-1) === "landing-commit:refs/heads/decisions-landing"));
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const decision = ledger.find((row) => row.step === "decision.autochoose");
  assert.equal(decision?.recorded, true);
  assert.equal(decision?.landed, true);
  assert.equal(existsSync(join(REPO_ROOT, relPath)), false);

  const noSyncStatusCalls = forbidSyncPreflight(t);
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
  noSyncStatusCalls();
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
    landingOptions: transport.opts,
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
