import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseInstanceRegistry } from "../src/lib/instance-registry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { captureSelectedRegistryIntent, qualifySelectedRegistryIntent, selectedRegistryObserverFromIntent,
  type SelectedRegistryIntent } from "#src/lib/selected-registry-consumers.js";
import { runChildMain } from "#src/run-child-main.js";
import { RUN_CHILD_SCHEMA, writeSpec } from "#src/lib/run-child-contract.js";
import { applyOperatorMergeHold } from "#src/lib/operator-merge-hold.js";
import { automergeHoldFromLedger } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  buildSweepEffects,
  ghPrCreateFillCommand,
  instanceMode,
  readInstanceRegistryText,
  resolveShadowInstanceArmPermission,
  runTask,
  shadowLiveWouldHaveDone,
} from "../src/run-task.js";

const SELECTED_INSTALL_ROOT = REPO_ROOT;

const registry = (mode?: string) => [
  "instances:",
  "  worker:",
  "    github_repo: owner/repo",
  ...(mode ? [`    mode: ${mode}`] : []),
  "",
].join("\n");

test("a shadow instance opens pull requests ready for review under the no-draft rule", () => {
  assert.equal(parseInstanceRegistry(registry("shadow")).instances[0]?.mode, "shadow");
  assert.equal(instanceMode("owner/repo", registry("shadow")), "shadow");
  const command = withLiveWritesAllowed(() =>
    ghPrCreateFillCommand(process.cwd(), "owner", "repo", "shadow-fixture", "test: shadow PR"),
  );
  assert.ok(command.args.includes("base=main"));
  assert.ok(!command.args.some((arg) => arg.startsWith("draft=")), "the create API opens ready by default");
});

test("a shadow instance never arms or merges a pull request", () => {
  let mergeCalls = 0;
  const permission = resolveShadowInstanceArmPermission(true);
  if (permission.armed) mergeCalls += 1;
  assert.equal(mergeCalls, 0);
  assert.match(permission.reason ?? "", /shadow instance/);
  assert.equal(resolveShadowInstanceArmPermission(false).armed, true);
});

test("a shadow run records what a live instance would have done", () => {
  const verdict = shadowLiveWouldHaveDone(true);
  assert.equal(verdict.would, "would_merge");
  assert.deepEqual(shadowLiveWouldHaveDone(false, "review held"), {
    would: "would_block",
    reason: "review held",
  });
});

test("an instance with no mode stays live", () => {
  assert.equal(instanceMode("owner/repo", undefined), "live");
  assert.equal(instanceMode("owner/repo", registry()), "live");
});

test("an invalid or unreadable registry does not invent shadow mode", () => {
  assert.throws(() => parseInstanceRegistry(registry("bogus")), /not "shadow" or "live"/);
  assert.equal(instanceMode("owner/repo", registry("bogus")), "live");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-registry-absent-`));
  try {
    assert.equal(readInstanceRegistryText(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the independent sweep path cannot arm a shadow instance", async () => {
  let sweepArmCalls = 0;
  const effects = buildSweepEffects({
    owner: "owner",
    repo: "repo",
    instanceRegistryTextImpl: () => registry("shadow"),
    config: { root: "/tmp/shadow-sweep-fixture" } as Config,
    ledgerPath: "/tmp/shadow-sweep-fixture/ledger.ndjson",
    runId: "SWEEP-shadow",
    plan: { tasks: [], byId: new Map() } as Plan,
    log: () => {},
    armImpl: () => { sweepArmCalls += 1; return "armed"; },
  });
  const outcome = await effects.arm({
    prUrl: "https://github.com/owner/repo/pull/1",
    taskId: "W1-T4265",
    headSha: "abc123",
  } as OpenPrView);
  assert.equal(outcome, "shadow-refused");
  assert.equal(sweepArmCalls, 0);
});

for (const contract of ["qualified", "unsupported", "absent"] as const) {
test(contract === "qualified"
  ? "selected child admission and resume retain current original source identity"
  : `selected child mixed version contracts never invent authority - actual ${contract} deferred arm`, { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selected-mode-run-`));
  const origin = gitRepo({ bare: true }), seed = gitRepo({ cloneFrom: origin.dir });
  const repoDir = join(root, "repos", "remudero");
  const selected = join(root, "selected.yaml"), planPath = join(root, "tasks.yaml");
  const now = Date.now(), branch = `run-T-SELECTED-${now}`, head = "deadbeef";
  const selectedText = (mode: string) => registry(mode).replace("  worker:", "  fixture:").replace("owner/repo", "owner/remudero");
  writeFileSync(selected, selectedText("shadow"));
  writeFileSync(planPath, "- id: T-SELECTED\n  title: selected deferred arm fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/lib/daemon.ts]\n  origin: architect\n  status: queued\n");
  const git = (args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  writeFileSync(join(seed.dir, "README.md"), "fixture\n"); seed.git("add", "README.md");
  seed.git("commit", "-qm", "test: seed"); seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos")); git(["clone", "-q", origin.dir, repoDir]);
  for (const args of [["user.name", "selected-mode-fixture"], ["user.email", "selected@example.invalid"]]) git(["-C", repoDir, "config", ...args]);
  const shim = ghShim([
    { when: "--json headRefName", stdout: JSON.stringify({ headRefName: branch }) },
    { when: "--json body", stdout: JSON.stringify({ body: "Remudero-Task: T-SELECTED" }) },
    { when: "--json files", stdout: JSON.stringify({ files: [{ path: "src/lib/daemon.ts" }] }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    { when: "pulls/1/files", stdout: JSON.stringify([{ filename: "src/lib/daemon.ts" }]) },
    { when: "api repos/owner/remudero/pulls/1", stdout: JSON.stringify({ number: 1, body: "Remudero-Task: T-SELECTED", state: "closed", merged: true, merged_at: new Date(now).toISOString(), mergeable_state: "clean", head: { sha: head } }) },
  ]);
  const previous = { path: process.env.PATH, registry: process.env.RMD_INSTANCE_REGISTRY, name: process.env.RMD_INSTANCE_NAME };
  process.env.PATH = `${shim.dir}:${previous.path}`; delete process.env.RMD_INSTANCE_REGISTRY; delete process.env.RMD_INSTANCE_NAME;
  const clock = t.mock.method(Date, "now", () => now);
  let spawned = 0, attemptedPushes = 0;
  try {
    const selectedConfig: Config = { root, claudeBin: "/bin/true", installRoot: SELECTED_INSTALL_ROOT,
      selectedRegistryMode: { mode: "shadow", instanceName: "fixture", registryPath: selected } };
    const sweepRows: Array<Record<string, unknown>> = [];
    const effects = buildSweepEffects({ owner: "owner", repo: "remudero", config: selectedConfig,
      ledgerPath: join(root, "state", "ledger.ndjson"), runId: "selected-sweep", plan: { tasks: [], byId: new Map() } as Plan,
      instanceRegistryTextImpl: () => undefined, armImpl: async () => "armed" as const,
      log: (step, fields = {}) => { if (step === "instance_mode.shadow_observed") sweepRows.push(fields); } });
    assert.equal(await effects.arm({ prUrl: "https://github.com/owner/remudero/pull/1", prNumber: 1,
      taskId: "T-SELECTED", headSha: head } as OpenPrView), "armed");
    assert.equal(sweepRows.at(-1)?.selected_outcome, "would-shadow", "real sweep construction and selected filesystem control");
    const inheritedRows: Array<Record<string, unknown>> = [];
    const intent = await qualifySelectedRegistryIntent(captureSelectedRegistryIntent({ settings: selectedConfig.selectedRegistryMode }));
    const inheritedObserver = selectedRegistryObserverFromIntent(intent, (step, fields) => {
      inheritedRows.push({ step, ...fields });
    });
    assert.ok(inheritedObserver);
    let runResult: Awaited<ReturnType<typeof runTask>> | undefined;
    const childDir = join(root, "run-selected"); mkdirSync(childDir);
    const snapshot = join(root, "snapshot.json"); writeFileSync(snapshot, JSON.stringify({ tasks: [] }));
    writeSpec(childDir, { schema: RUN_CHILD_SCHEMA, taskId: "T-SELECTED", runId: "run-selected", instance: "fixture",
      engine: { sha: "b".repeat(40), sourceHash: "c".repeat(64) }, reservationId: "fixture", planSnapshotPath: snapshot,
      options: { owner: "owner", skipGitSync: true, planPath,
        ...(contract === "absent" ? {} : { selectedRegistryIntent: contract === "qualified" ? intent
          : { version: 99, kind: "shadow", input: {} } as never }) } });
    const specBefore = readFileSync(join(childDir, "spec.json"), "utf8");
    let hold: ReturnType<typeof applyOperatorMergeHold>["current"];
    let optionsSeen = false;
    const exitCode = await runChildMain(["--run-dir", childDir], {
      env: {}, selectedRegistryRecord: (step, fields) => { inheritedRows.push({ step, ...fields }); },
      loadRunPath: async () => ({ runTask: async (taskId: string, options: Record<string, unknown>) => {
      optionsSeen = true;
      assert.ok(Object.hasOwn(options, "selectedRegistryIntent"));
      assert.deepEqual(options.selectedRegistryIntent, contract === "qualified" ? intent
        : contract === "unsupported" ? { version: 1, kind: "unknown" } : undefined);
      const mutableIntent = options.selectedRegistryIntent === undefined ? undefined
        : structuredClone(options.selectedRegistryIntent) as SelectedRegistryIntent;
      const running = withLiveWritesAllowed(() => runTask(taskId, {
      ...options, selectedRegistryIntent: mutableIntent,
      owner: "owner", skipGitSync: true, planPath,
      config: selectedConfig,
      implementPush: async () => { attemptedPushes++; },
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      spawn: async () => {
        spawned++;
        return { sessionId: `selected-${spawned}`, costUsd: 0, numTurns: 0,
          text: spawned === 1 ? "RECON REPORT\nOBSERVED: fixture\nINFERRED: none\nCOULDN'T-VERIFY: none\n"
            : spawned === 2 ? "REPORT\nPR_URL: https://github.com/owner/remudero/pull/1\n"
            : "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: fixture\n",
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "default", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false } satisfies WorkerResult;
      },
      containmentExec: async token => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
      runReview: async () => {
        if (contract === "qualified") {
          writeFileSync(selected, selectedText("live"));
          const replacement = join(root, "replacement.yaml"); writeFileSync(replacement, selectedText("shadow"));
          selectedConfig.selectedRegistryMode = { mode: "shadow", registryPath: replacement, instanceName: "fixture" };
          hold = applyOperatorMergeHold(join(root, "state/ledger.ndjson"), { action: "engage", by: "fixture owner",
            authority: "console-confirmed", reason: "review the admitted revision", prNumber: 1 }).current;
        }
        return { state: "success", criteria: [], testTheater: false, summary: "fixture pass", floorDegraded: false,
          capped: false, keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "success" };
      },
      }));
      if (contract === "qualified") {
        const replacement = join(root, "transport-replacement.yaml"); writeFileSync(replacement, selectedText("live"));
        (mutableIntent as { input: { configuredPath: string } }).input.configuredPath = replacement;
      }
      runResult = await running;
      return runResult;
      } }),
    });
    inheritedObserver.close();
    assert.equal(exitCode, 0); assert.equal(optionsSeen, true); assert.ok(runResult);
    assert.equal(attemptedPushes, 1, "the real run body attempted its push through the recording transport");
    assert.equal(readFileSync(join(childDir, "spec.json"), "utf8"), specBefore);
    assert.equal(runResult.verdict, "merged", "the contained independent legacy run still finishes normally");
    if (contract === "qualified") assert.ok(inheritedRows.some(row => row.step === "instance_registry.consumer_shadow_observed"
      && row.action === "run-task-resume" && row.selected_state === "unknown"
      && row.reason === "revision_changed" && row.legacy_outcome === "returned"),
    "the real runTask consumes the inherited observer and rechecks the source after the effect");
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const observed = rows.filter(row => row.step === "instance_mode.shadow_observed");
    if (contract === "qualified") {
      assert.ok(observed.length > 0, "the REAL runTaskBody deferred arm must carry the original selected binding");
      assert.ok(observed.some(row => row.reason === "revision_changed" && row.selected_outcome === "would-refuse"));
      assert.ok(observed.every(row => row.publication_permission === "not-granted"));
      assert.ok(rows.some(row => row.step === "automerge.armed" && row.outcome === "hold-refused"));
      assert.deepEqual(automergeHoldFromLedger(readLedgerLines(join(root, "state/ledger.ndjson")), 1), hold);
    } else {
      assert.deepEqual(observed, [], "unknown/absent child intent never qualifies using current global defaults");
      assert.ok(rows.some(row => row.step === "automerge.armed" && row.outcome === "armed"), "legacy effect remains exact");
      if (contract === "unsupported") {
        assert.ok(inheritedRows.length > 0);
        assert.ok(inheritedRows.every(row => row.selected_state === "unknown"));
      } else assert.deepEqual(inheritedRows, []);
    }
  } finally {
    clock.mock.restore(); process.env.PATH = previous.path;
    if (previous.registry === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = previous.registry;
    if (previous.name === undefined) delete process.env.RMD_INSTANCE_NAME; else process.env.RMD_INSTANCE_NAME = previous.name;
    rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
    seed.cleanup(); origin.cleanup();
  }
});
}
