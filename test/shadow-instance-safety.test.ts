import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as runtimeRegistry from "#src/lib/instance-registry-selection.js";
import { observeSelectedMode } from "#src/lib/instance-mode.js";

import { parseInstanceRegistry } from "../src/lib/instance-registry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
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

const SELECTED_INSTALL_ROOT = fileURLToPath(new URL("..", import.meta.url));

const registry = (mode?: string) => [
  "instances:",
  "  worker:",
  "    github_repo: owner/repo",
  ...(mode ? [`    mode: ${mode}`] : []),
  "",
].join("\n");

type RuntimeRegistryRunner = <T>(operation: () => T | Promise<T>, input: { envPath?: string; instanceName?: string }) => Promise<T>;
function runtimeRegistryRunner(): RuntimeRegistryRunner {
  const run = Reflect.get(runtimeRegistry, "withInstanceRegistryRuntime");
  assert.equal(typeof run, "function", "production invocation binding must exist, not a supplied current-subject fixture");
  return run as RuntimeRegistryRunner;
}
function runtimeRegistryFixture(mode = "shadow") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-registry-`));
  const selected = join(root, "private.yaml");
  const legacy = registry("live");
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), legacy);
  writeFileSync(selected, registry(mode));
  return { root, selected, legacy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("selected runtime binding reaches the existing default mode reader", async () => {
  const fixture = runtimeRegistryFixture();
  try {
    const run = runtimeRegistryRunner();
    assert.equal(readInstanceRegistryText(fixture.root), fixture.legacy, "healthy unselected legacy positive control");
    await run(async () => {
      assert.equal(readInstanceRegistryText(fixture.root), registry("shadow"));
      assert.equal(instanceMode("owner/repo", readInstanceRegistryText(fixture.root)), "shadow");
      assert.throws(() => instanceMode("other/repo", readInstanceRegistryText(fixture.root)), /selected instance registry unavailable/);
      let effects = 0;
      assert.equal(await observeSelectedMode(undefined, "arm", () => { effects++; return "independent-owner-hold"; }), "independent-owner-hold");
      assert.equal(effects, 1, "runtime configuration binding is not an observation toggle or publication permission");
    }, { envPath: fixture.selected, instanceName: "worker" });
    assert.equal(readInstanceRegistryText(fixture.root), fixture.legacy, "completion does not change the ambient legacy reader");
  } finally { fixture.cleanup(); }
});

test("selected runtime invalid evidence refuses before the unchanged legacy effect", async () => {
  const fixture = runtimeRegistryFixture();
  try {
    const run = runtimeRegistryRunner();
    let effects = 0;
    for (const envPath of ["", "relative.yaml", join(fixture.root, "missing.yaml")]) {
      await assert.rejects(run(() => { effects++; return readInstanceRegistryText(fixture.root); }, { envPath }), /selected instance registry unavailable/);
    }
    writeFileSync(fixture.selected, "not a valid registry\n");
    await assert.rejects(run(() => { effects++; }, { envPath: fixture.selected }), /selected instance registry unavailable/);
    assert.equal(effects, 0, "healthy public bytes never rescue an explicitly invalid selection");
    assert.equal(await run(() => readInstanceRegistryText(fixture.root), {}), fixture.legacy);
  } finally { fixture.cleanup(); }
});

test("selected runtime changed binding is rechecked at the real final arm observer seam", async () => {
  const fixture = runtimeRegistryFixture();
  try {
    const run = runtimeRegistryRunner();
    let effects = 0;
    await run(async () => {
      assert.equal(instanceMode("owner/repo", readInstanceRegistryText(fixture.root)), "shadow");
      writeFileSync(fixture.selected, registry("live"));
      await assert.rejects(observeSelectedMode(undefined, "arm", () => { effects++; return "armed"; }), /selected instance registry unavailable/);
    }, { envPath: fixture.selected, instanceName: "worker" });
    assert.equal(effects, 0, "revised bytes cannot silently retarget deferred work");
    assert.equal(await observeSelectedMode(undefined, "arm", () => { effects++; return "legacy-result"; }), "legacy-result");
    assert.equal(effects, 1, "absence preserves the legacy effect without a global hold");
  } finally { fixture.cleanup(); }
});

test("selected runtime concurrent and escaped invocations cannot borrow another binding", { timeout: 10000 }, async () => {
  const a = runtimeRegistryFixture("shadow"), b = runtimeRegistryFixture("live");
  try {
    const run = runtimeRegistryRunner();
    let entered = 0, release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    const modes = await Promise.all([a, b].map(fixture => run(async () => {
      if (++entered === 2) release();
      await both;
      const expected = fixture === a ? "shadow" : "live";
      assert.equal(instanceMode("owner/repo", readInstanceRegistryText(fixture.root)), expected);
      await run(() => assert.equal(readInstanceRegistryText(fixture.root), fixture.legacy), {});
      assert.equal(instanceMode("owner/repo", readInstanceRegistryText(fixture.root)), expected);
      return expected;
    }, { envPath: fixture.selected, instanceName: "worker" })));
    assert.deepEqual(modes, ["shadow", "live"]);
    let wake!: () => void, escaped!: Promise<string | undefined>;
    const later = new Promise<void>(resolve => { wake = resolve; });
    await run(() => { escaped = later.then(() => readInstanceRegistryText(a.root)); }, { envPath: a.selected });
    wake();
    await assert.rejects(escaped, /selected instance registry unavailable/, "escaped async work cannot use a completed invocation's trusted bytes");
  } finally { a.cleanup(); b.cleanup(); }
});

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

test("selected mode shadow evidence reaches actual run and sweep consumers", async (t) => {
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
    { when: "api repos/owner/remudero/pulls/1/files", stdout: "[]" },
    { when: "api repos/owner/remudero/pulls/1", stdout: JSON.stringify({ number: 1, state: "closed", merged: true, merged_at: new Date(now).toISOString(), head: { sha: head } }) },
  ]);
  const previous = { path: process.env.PATH, registry: process.env.RMD_INSTANCE_REGISTRY, name: process.env.RMD_INSTANCE_NAME };
  process.env.PATH = `${shim.dir}:${previous.path}`; delete process.env.RMD_INSTANCE_REGISTRY; delete process.env.RMD_INSTANCE_NAME;
  const clock = t.mock.method(Date, "now", () => now);
  let spawned = 0;
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
    const res = await withLiveWritesAllowed(() => runTask("T-SELECTED", {
      owner: "owner", skipGitSync: true, planPath,
      config: selectedConfig,
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
        writeFileSync(selected, selectedText("live"));
        return { state: "success", criteria: [], testTheater: false, summary: "fixture pass", floorDegraded: false,
          capped: false, keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "success" };
      },
    }));
    assert.equal(res.verdict, "merged", "the contained independent legacy run still finishes normally");
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const observed = rows.filter(row => row.step === "instance_mode.shadow_observed");
    assert.ok(observed.length > 0, "the REAL runTaskBody deferred arm must carry the original selected binding");
    assert.ok(observed.some(row => row.reason === "revision_changed" && row.selected_outcome === "would-refuse"));
    assert.ok(observed.every(row => row.publication_permission === "not-granted"));
  } finally {
    clock.mock.restore(); process.env.PATH = previous.path;
    if (previous.registry === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = previous.registry;
    if (previous.name === undefined) delete process.env.RMD_INSTANCE_NAME; else process.env.RMD_INSTANCE_NAME = previous.name;
    rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
    seed.cleanup(); origin.cleanup();
  }
});
