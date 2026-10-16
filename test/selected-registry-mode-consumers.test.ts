import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSweepEffects, runTask } from "../src/run-task.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { createSelectedModeQualification } from "../src/lib/instance-mode.js";
import { realArmDepsAsync, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { ghShim } from "./helpers/gh-shim.js";
import type { WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OBSERVED = "instance_mode.shadow_observed";
type Settings = { mode: "shadow"; instanceName: string; registryPath?: string; timeoutMs?: number };
const registry = (mode: string | undefined, privateValue = "/private/selected-mode-sentinel") => [
  "instances:", "  fixture:", "    github_repo: owner/repo",
  ...(mode === undefined ? [] : [`    mode: ${mode}`]),
  `    state_dir: ${privateValue}`, "",
].join("\n");
const pr = { prUrl: "https://github.com/owner/repo/pull/1", prNumber: 1,
  taskId: "W1-T9572", headSha: "a".repeat(40) } as OpenPrView;

function fixture(mode: string | null = "shadow", legacy: "shadow" | "live" = "live", optedIn = true,
  physical?: "armAuto" | "mergeDirect" | "enqueue") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selected-mode-consumer-`));
  const selected = join(root, "selected.yaml"), other = join(root, "other.yaml");
  writeFileSync(selected, registry(mode === null ? undefined : mode, root)); writeFileSync(other, registry("live", root));
  const prior = { path: process.env.RMD_INSTANCE_REGISTRY, name: process.env.RMD_INSTANCE_NAME };
  delete process.env.RMD_INSTANCE_REGISTRY; delete process.env.RMD_INSTANCE_NAME;
  const settings: Settings = { mode: "shadow", instanceName: "fixture", registryPath: selected, timeoutMs: 1500 };
  const config = { root, claudeBin: "/bin/true", installRoot: REPO_ROOT,
    ...(optedIn ? { selectedRegistryMode: settings } : {}) };
  const logs: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let arms = 0;
  const deps = { owner: "owner", repo: "repo", config, ledgerPath: join(root, "ledger.ndjson"),
    runId: "SWEEP-selected-mode-fixture", plan: loadPlanFromYaml("[]", "selected-mode consumer fixture"),
    instanceRegistryTextImpl: () => registry(legacy),
    log: (step: string, fields: Record<string, unknown> = {}) => logs.push({ step, fields }),
    armImpl: async (url?: string, _task?: string, ports?: ArmDeps<true>) => {
      arms += 1;
      if (physical) { assert.ok(ports); await ports[physical]!(url!); }
      return "armed" as const;
    },
  };
  const effects = buildSweepEffects(deps);
  return { root, selected, other, settings, config, effects, logs, arms: () => arms,
    rows: () => logs.filter(row => row.step === OBSERVED).map(row => row.fields),
    cleanup: () => {
      if (prior.path === undefined) delete process.env.RMD_INSTANCE_REGISTRY;
      else process.env.RMD_INSTANCE_REGISTRY = prior.path;
      if (prior.name === undefined) delete process.env.RMD_INSTANCE_NAME;
      else process.env.RMD_INSTANCE_NAME = prior.name;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("selected mode shadow evidence reaches actual run and sweep consumers", async (t) => {
  // First red: the real entrypoint-built sweep currently ignores selected configuration.
  // Actual run/deferred/default-transport cases join this criterion before task completion.
  for (const mode of ["shadow", "live"] as const) {
    const fx = fixture(mode);
    try {
      assert.equal(await fx.effects.arm!(pr), "armed");
      assert.equal(fx.arms(), 1, "SHADOW must preserve the real legacy result");
      assert.equal(fx.rows().at(-1)?.selected_outcome, `would-${mode}`);
      assert.equal(fx.rows().at(-1)?.legacy_outcome, "armed");
    } finally { fx.cleanup(); }
  }
  for (const method of ["armAuto", "mergeDirect", "enqueue"] as const) await t.test(`actual async ${method} transport`, async () => {
    const fx = fixture("shadow"), shim = ghShim();
    const path = process.env.PATH;
    process.env.PATH = `${shim.dir}:${path}`;
    try {
      const qualification = createSelectedModeQualification(fx.settings, "owner/repo", {},
        (step, fields) => fx.logs.push({ step, fields }));
      assert.ok(qualification);
      // The second constructor argument is deliberately ignored by the pre-fix production
      // default. Reflect.apply lets this behavioral red reach that real method without a fake.
      const deps = Reflect.apply(realArmDepsAsync, undefined, [() => fx.config, qualification]) as ArmDeps<true>;
      await withLiveWritesAllowed(async () => { await deps[method]!(pr.prUrl); });
      assert.equal(shim.calls().length, 1, "exactly one real default child, contained by the PATH shim");
      const action = method === "armAuto" ? "arm" : method === "mergeDirect" ? "direct-merge" : "queue";
      assert.equal(fx.rows().find(row => row.action === action)?.selected_outcome, "would-shadow");
      assert.equal(fx.rows().find(row => row.action === action)?.publication_permission, "not-granted");
    } finally { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); fx.cleanup(); }
  });
});

test("selected mode evidence never falls back after explicit failure", async () => {
  const fx = fixture(null);
  try {
    assert.equal(/^\s+mode:/m.test(readFileSync(fx.selected, "utf8")), false, "actual missing-mode input control");
    assert.equal(await fx.effects.arm!(pr), "armed", "healthy legacy effects remain unchanged");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "mode_missing");
    assert.equal(fx.arms(), 1);
  } finally { fx.cleanup(); }
});

test("selected mode revisions invalidate deferred arm observations", async () => {
  const fx = fixture("live");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    const original = fx.rows().at(-1)?.binding_digest;
    assert.equal(typeof original, "string");
    writeFileSync(fx.selected, registry("shadow", fx.root));
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "revision_changed");
    assert.equal(fx.rows().at(-1)?.binding_digest, original, "do not retarget the original binding");
    assert.equal(fx.arms(), 2);
  } finally { fx.cleanup(); }
});

test("selected mode recheck preserves a real reader refusal cause", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    const original = fx.rows().at(-1)?.binding_digest;
    const current = readFileSync(fx.selected, "utf8");
    assert.ok(current.includes("    state_dir:"), "the actual selected row is present");
    writeFileSync(fx.selected, current.replace("    state_dir:", "    future_field: unexpected\n    state_dir:"));
    assert.equal(await fx.effects.arm!(pr), "armed", "SHADOW must preserve the independent legacy effect");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "unsupported_field", "retain the real reader's cause, not a generic revision change");
    assert.equal(fx.rows().at(-1)?.binding_digest, original);
    assert.equal(fx.arms(), 2);
  } finally { fx.cleanup(); }
});

test("selected mode snapshots survive caller and transport mutation", async () => {
  const fx = fixture("shadow");
  try {
    fx.settings.registryPath = fx.other;
    fx.settings.instanceName = "another-instance";
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-shadow");
    assert.equal(fx.rows().at(-1)?.legacy_outcome, "armed");
  } finally { fx.cleanup(); }
});

test("selected mode shadow unknown preserves owner and trusted legacy effects", async () => {
  for (const legacy of ["shadow", "live"] as const) {
    const fx = fixture(null, legacy);
    try {
      assert.equal(/^\s+mode:/m.test(readFileSync(fx.selected, "utf8")), false, "actual missing-mode input control");
      const outcome = await fx.effects.arm!(pr);
      assert.equal(outcome, legacy === "shadow" ? "shadow-refused" : "armed");
      assert.equal(fx.arms(), legacy === "shadow" ? 0 : 1);
      assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
      assert.equal(fx.rows().at(-1)?.legacy_outcome, outcome);
    } finally { fx.cleanup(); }
  }
});

test("selected mode defaults stay bounded asynchronous and private", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(readFileSync(fx.selected, "utf8").includes(fx.root), true, "private-value control");
    let pulsed = false;
    const pulse = new Promise<void>(resolve => setImmediate(() => { pulsed = true; resolve(); }));
    assert.equal(await fx.effects.arm!(pr), "armed"); await pulse;
    assert.equal(pulsed, true);
    assert.ok(fx.rows().length > 0, "real default selected filesystem read must reach this consumer");
    assert.equal(JSON.stringify(fx.rows()).includes(fx.root), false);
    assert.equal(JSON.stringify(fx.rows()).includes("selected.yaml"), false);
    assert.equal(fx.rows().at(-1)?.publication_permission, "not-granted");
  } finally { fx.cleanup(); }
});

test("selected mode shadow qualification never activates selected permissions", async () => {
  const legacy = fixture("shadow", "live", false);
  try {
    process.env.RMD_INSTANCE_REGISTRY = legacy.selected;
    assert.equal(await legacy.effects.arm!(pr), "armed");
    assert.equal(legacy.arms(), 1); assert.equal(legacy.rows().length, 0, "environment alone is not opt-in");
  } finally { legacy.cleanup(); }
  const observed = fixture("shadow");
  try {
    assert.equal(await observed.effects.arm!(pr), "armed");
    assert.equal(observed.rows().at(-1)?.selected_outcome, "would-shadow");
    assert.equal(observed.rows().at(-1)?.publication_permission, "not-granted");
    assert.equal(observed.arms(), 1, "a would-shadow observation is not an enforced hold");
  } finally { observed.cleanup(); }
});

test("selected mode production sweep roots forward to each real physical default", async (t) => {
  for (const physical of ["armAuto", "mergeDirect", "enqueue"] as const) await t.test(physical, async () => {
    const fx = fixture("shadow", "live", true, physical), shim = ghShim(), path = process.env.PATH;
    process.env.PATH = `${shim.dir}:${path}`;
    try {
      assert.equal(await withLiveWritesAllowed(() => fx.effects.arm!(pr)), "armed");
      const action = physical === "armAuto" ? "arm" : physical === "mergeDirect" ? "direct-merge" : "queue";
      const row = fx.rows().find(row => row.action === action);
      assert.equal(row?.selected_outcome, "would-shadow", "the actual composition root must forward to the actual write");
      assert.equal(row?.publication_permission, "not-granted");
      assert.equal(shim.calls().length, 1, "one contained real default transport");
    } finally { process.env.PATH = path; rmSync(shim.dir, { recursive: true, force: true }); fx.cleanup(); }
  });
});

test("selected mode observations bind each real target and never dedupe another PR", async () => {
  const fx = fixture("shadow");
  try {
    assert.equal(await fx.effects.arm!(pr), "armed");
    assert.equal(await fx.effects.arm!({ ...pr, prUrl: "https://github.com/owner/repo/pull/2", prNumber: 2 }), "armed");
    assert.equal(fx.rows().length, 2, "distinct PR effects cannot disappear behind an identical mode/result");
    assert.deepEqual(fx.rows().map(row => [row.target_repo, row.target_pr]), [["owner/repo", 1], ["owner/repo", 2]]);
    assert.equal(await fx.effects.arm!({ ...pr, prUrl: "https://github.com/other/repo/pull/3", prNumber: 3 }), "armed");
    assert.equal(fx.rows().at(-1)?.selected_outcome, "would-refuse");
    assert.equal(fx.rows().at(-1)?.reason, "target_mismatch");
    assert.equal(fx.arms(), 3, "mismatched observation never blocks the independent SHADOW effect");
  } finally { fx.cleanup(); }
});

test("selected mode hostile opt-in and receipt mutation never change legacy effects", async () => {
  const fx = fixture("shadow");
  try {
    const settings = Object.defineProperty({}, "mode", { get() { throw new Error(fx.root); } }) as Settings;
    let row: Record<string, unknown> | undefined, calls = 0;
    const q = createSelectedModeQualification(settings, "owner/repo", {}, (_step, fields) => { row = fields; });
    assert.ok(q, "unreadable opt-in is unknown, not an uncaught effect failure");
    assert.equal(await Reflect.apply(q.observe, q, ["arm", () => { calls++; return "armed"; }, pr.prUrl]), "armed");
    assert.equal(row?.reason, "input_unreadable");
    assert.equal(Object.isFrozen(row), true, "sinks cannot mutate the immutable redacted observation");
    assert.equal(Reflect.set(row!, "publication_permission", "granted"), false);
    assert.equal(calls, 1); assert.equal(JSON.stringify(row).includes(fx.root), false);
  } finally { fx.cleanup(); }
});

test("selected mode real run retains its original binding through deferred arming", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selected-mode-run-`));
  const origin = join(root, "origin.git"), seed = join(root, "seed"), repoDir = join(root, "repos", "remudero");
  const selected = join(root, "selected.yaml"), planPath = join(root, "tasks.yaml");
  const now = Date.now(), branch = `run-T-SELECTED-${now}`, head = "deadbeef";
  const selectedText = (mode: string) => registry(mode, root).replace("owner/repo", "owner/remudero");
  writeFileSync(selected, selectedText("shadow"));
  writeFileSync(planPath, "- id: T-SELECTED\n  title: selected deferred arm fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/lib/daemon.ts]\n  origin: architect\n  status: queued\n");
  const git = (args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git(["init", "-q", "--bare", "--initial-branch=main", origin]);
  git(["clone", "-q", origin, seed]);
  for (const args of [["user.name", "selected-mode-fixture"], ["user.email", "selected@example.invalid"]]) git(["-C", seed, "config", ...args]);
  writeFileSync(join(seed, "README.md"), "fixture\n"); git(["-C", seed, "add", "README.md"]);
  git(["-C", seed, "commit", "-qm", "test: seed"]); git(["-C", seed, "push", "-q", "origin", "main"]);
  mkdirSync(join(root, "repos")); git(["clone", "-q", origin, repoDir]);
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
    const res = await withLiveWritesAllowed(() => runTask("T-SELECTED", {
      owner: "owner", skipGitSync: true, planPath,
      config: { root, claudeBin: "/bin/true", installRoot: REPO_ROOT,
        selectedRegistryMode: { mode: "shadow", instanceName: "fixture", registryPath: selected } },
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
    const observed = rows.filter(row => row.step === OBSERVED);
    assert.ok(observed.length > 0, "the REAL runTaskBody deferred arm must carry the original selected binding");
    assert.ok(observed.some(row => row.reason === "revision_changed" && row.selected_outcome === "would-refuse"));
    assert.ok(observed.every(row => row.publication_permission === "not-granted"));
  } finally {
    clock.mock.restore(); process.env.PATH = previous.path;
    if (previous.registry === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = previous.registry;
    if (previous.name === undefined) delete process.env.RMD_INSTANCE_NAME; else process.env.RMD_INSTANCE_NAME = previous.name;
    rmSync(shim.dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
