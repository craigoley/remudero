import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import * as consumers from "#src/lib/selected-registry-consumers.js";
import { parseSpec, readSpec, readStatus, RUN_CHILD_SCHEMA, writeSpec, type RunChildSpec } from "#src/lib/run-child-contract.js";
import { adoptRunChildren, spawnRunChild, type SpawnRunChildInput, type SpawnRunChildPorts } from "#src/lib/run-child.js";
import { runChildMain, type RunChildMainPorts } from "#src/run-child-main.js";
import { buildWorkerEnv } from "#src/lib/env.js";
import { codexSpawnEnvForTest } from "#src/lib/worker-provider.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
const text = (name = "fixture") => `instances:\n  ${name}:\n    github_repo: owner/repo\n    mode: shadow\n    state_dir: /private/registry-material-sentinel\n`;
function fixture(t: TestContext) {
  const root = makeTempDir("selected-child");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "private-selected.yaml"), other = join(root, "other.yaml");
  writeFileSync(path, text()); writeFileSync(other, text("other"));
  const settings = { mode: "shadow" as const, registryPath: path, instanceName: "fixture" };
  const intent = consumers.captureSelectedRegistryIntent({ settings });
  const dir = join(root, "run-fixture"), plan = join(root, "plan.json");
  mkdirSync(dir); writeFileSync(plan, JSON.stringify({ tasks: [] }));
  const spec: RunChildSpec = { schema: RUN_CHILD_SCHEMA, taskId: "W1-T9796", runId: basename(dir), instance: "fixture",
    engine: { sha: "b".repeat(40), sourceHash: "a".repeat(64) }, reservationId: "fixture",
    planSnapshotPath: plan, options: { selectedRegistryIntent: intent } };
  const rows: Row[] = [];
  const ports: RunChildMainPorts = { env: {}, loadRunPath: async () => ({}),
    selectedRegistryRecord: (step, fields) => { rows.push({ step, ...fields }); },
    runTask: async (taskId) => ({ taskId, runId: spec.runId, verdict: "no_pr", merged: false, costUsd: 0 }) };
  return { root, path, other, settings, intent, dir, spec, rows, ports };
}
const receipts = (rows: Row[]) => rows.filter(row => row.step === "instance_registry.consumer_shadow_observed");

test("selected registry shadow intent survives actual trusted child transport", { timeout: 30_000 }, async t => {
  const f = fixture(t), state = join(f.root, "state"), engine = join(state, "engines", f.spec.engine.sourceHash);
  mkdirSync(engine, { recursive: true });
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules")), join(engine, "node_modules"), "dir");
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ ...f.spec.engine, builtAt: Date.now() }));
  const entry = pathToFileURL(join(REPO_ROOT, "src/run-child-main.ts")).href;
  const code = `import { runChildMain } from ${JSON.stringify(entry)};
    const dir = process.argv[1];
    process.exitCode = await runChildMain(['--run-dir', dir], { env: {}, loadRunPath: async () => ({}),
      selectedRegistryRecord: (step, fields) => console.error(JSON.stringify({step,...fields})),
      runTask: async taskId => ({taskId, runId: 'fixture', verdict: 'no_pr', merged: false, costUsd: 0}) });`;
  let turned = false;
  const input: SpawnRunChildInput = { taskId: f.spec.taskId, root: f.root, stateRoot: state, repoDir: f.root,
    options: f.spec.options, log: () => {}, plan: async () => {
      f.spec.options.selectedRegistryIntent = consumers.captureSelectedRegistryIntent({ settings: { ...f.settings, registryPath: f.other } });
      return { plan: { tasks: [] } };
    } };
  const ports: SpawnRunChildPorts = { mainSha: async () => f.spec.engine.sha, engine: { isCurrent: () => true },
    launch: (_engine, args) => ({ cwd: REPO_ROOT, engineRoot: engine, kind: "tsx", reason: "fixture",
      argv: ["--import", "tsx", "--input-type=module", "-e", code, args[1]!] }),
    reserve: async () => ({ id: "fixture", bindRoot() {}, releaseOccupancy() {} }) as never,
    workerAdmissionHold: () => undefined, pollMs: 5, watch: false };
  setImmediate(() => { turned = true; });
  const child = await spawnRunChild(input, ports);
  assert.ok(child.started, JSON.stringify(child));
  const result = await child.settled;
  assert.equal(result.verdict, "no_pr"); assert.equal(turned, true);
  const output = readFileSync(join(child.dir, "stderr.log"), "utf8");
  const row = output.trim().split("\n").map(line => JSON.parse(line) as Row).find(row => row.action === "run-child");
  assert.equal(row?.selected_state, "ready"); assert.equal(row?.target_instance, "fixture");
  const stored = readSpec(child.dir); assert.ok(stored.ok);
  assert.equal(stored.value.options.selectedRegistryIntent?.kind, "shadow");
  assert.equal(stored.value.options.selectedRegistryIntent?.kind === "shadow" && stored.value.options.selectedRegistryIntent.input.configuredPath, f.path);
  child.detach?.();
  const adopted = adoptRunChildren({ stateRoot: state, instance: stored.value.instance, log: () => {}, settledRunIds: new Set() },
    { watch: false, pollMs: 5 });
  assert.equal(adopted.length, 1);
  assert.deepEqual(await adopted[0]!.settled, result);
  assert.equal(readSpec(child.dir).ok, true);
});

test("selected child admission and resume retain current original source identity", async t => {
  const f = fixture(t);
  f.spec.options.selectedRegistryIntent = await consumers.qualifySelectedRegistryIntent(f.intent);
  writeSpec(f.dir, f.spec);
  const original = readFileSync(join(f.dir, "spec.json"), "utf8");
  f.ports.runTask = async taskId => {
    const observer = consumers.selectedRegistryObserverInContext(); assert.ok(observer);
    await observer.observe("run-task-resume", {}, () => "first");
    await observer.settled();
    writeFileSync(f.path, text("replacement")); f.settings.registryPath = f.other;
    await observer.observe("run-task-resume", {}, () => "resumed");
    return { taskId, runId: f.spec.runId, verdict: "no_pr", merged: false, costUsd: 0 };
  };
  assert.equal(await runChildMain(["--run-dir", f.dir], f.ports), 0);
  assert.ok(receipts(f.rows).some(row => row.selected_state === "ready"));
  assert.ok(receipts(f.rows).some(row => row.selected_state === "unknown"));
  assert.equal(readFileSync(join(f.dir, "spec.json"), "utf8"), original);
  f.rows.length = 0;
  f.ports.runTask = async taskId => ({ taskId, runId: f.spec.runId, verdict: "no_pr", merged: false, costUsd: 0 });
  assert.equal(await runChildMain(["--run-dir", f.dir], f.ports), 0);
  assert.equal(receipts(f.rows)[0]?.selected_state, "unknown");
});

test("selected child mixed version contracts never invent authority", async t => {
  const f = fixture(t);
  const legacy = { ...f.spec, schema: { major: 1, minor: 0 }, options: { owner: "human", unknownQualification: f.intent } };
  const parsed = parseSpec(legacy); assert.ok(parsed.ok); assert.deepEqual(parsed.value.options, { owner: "human" });
  for (const intent of [{ version: 99, kind: "shadow", input: {} }, { version: 1, kind: "enforce", input: {} }]) {
    const newer = parseSpec({ ...f.spec, options: { selectedRegistryIntent: intent } });
    assert.ok(newer.ok); assert.deepEqual(newer.value.options.selectedRegistryIntent, { version: 1, kind: "unknown" });
  }
  // Explicit v1.1 reader fixture: only its historical option allowlist crosses the boundary.
  const oldRead = (spec: RunChildSpec) => Object.fromEntries(Object.entries(spec.options)
    .filter(([key]) => ["owner", "planPath", "allowStale", "skipGitSync", "handOffAtPrOpen", "pairedTrialHost"].includes(key)));
  assert.deepEqual(oldRead(f.spec), {});
  assert.equal(parseSpec({ ...f.spec, schema: { major: 2, minor: 0 } }).ok, false);
  const unsupported = consumers.selectedRegistryObserverFromIntent({ ...f.intent, input: { configuredPath: f.path, requiredCapabilities: ["permission"] } },
    (step, fields) => { f.rows.push({ step, ...fields }); });
  await unsupported!.observe("run-child", {}, () => "legacy"); await unsupported!.settled(); unsupported!.close();
  assert.equal(receipts(f.rows)[0]?.selected_state, "unknown");
});

test("selected child qualification isolates private material from workers", async t => {
  const f = fixture(t); writeSpec(f.dir, f.spec);
  f.ports.runTask = async taskId => {
    const parent = { RMD_INSTANCE_REGISTRY: f.path, PRIVATE_REGISTRY_BYTES: text() };
    const env = buildWorkerEnv({}, parent, { home: f.root });
    const config = { root: f.root } as Parameters<typeof codexSpawnEnvForTest>[0];
    const codex = codexSpawnEnvForTest(config, { cwd: f.root, prompt: "harmless", workerHome: f.root, env });
    for (const worker of [env, codex]) {
      assert.equal(worker.RMD_INSTANCE_REGISTRY, undefined);
      assert.equal(worker.PRIVATE_REGISTRY_BYTES, undefined);
      assert.ok(!JSON.stringify(worker).includes("registry-material-sentinel"));
    }
    return { taskId, runId: f.spec.runId, verdict: "no_pr", merged: false, costUsd: 0 };
  };
  assert.equal(await runChildMain(["--run-dir", f.dir], f.ports), 0);
  assert.ok(receipts(f.rows).length > 0);
  const publicText = JSON.stringify(f.rows) + readFileSync(join(f.dir, "status.json"), "utf8");
  assert.ok(!publicText.includes(f.path)); assert.ok(!publicText.includes("registry-material-sentinel"));
});

test("selected child defaults and recovery preserve shadow effects and owner holds", async t => {
  const f = fixture(t); writeSpec(f.dir, f.spec);
  const failure = new Error("owner hold remains held");
  f.ports.runTask = async () => { throw failure; }; f.ports.stderr = () => {};
  assert.equal(await runChildMain(["--run-dir", f.dir], f.ports), 1);
  const status = readStatus(f.dir); assert.ok(status.ok); assert.equal(status.value.state, "failed");
  assert.match(status.value.failure!.message, /owner hold remains held/);
  assert.equal(receipts(f.rows)[0]?.legacy_outcome, "threw");
  delete f.spec.options.selectedRegistryIntent; writeSpec(f.dir, f.spec); f.rows.length = 0;
  assert.equal(await runChildMain(["--run-dir", f.dir], f.ports), 1);
  assert.deepEqual(receipts(f.rows), []);
});
