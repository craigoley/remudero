import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import * as consumers from "#src/lib/selected-registry-consumers.js";
import { parseSpec, readSpec, readStatus, RUN_CHILD_SCHEMA, writeSpec, type RunChildSpec } from "#src/lib/run-child-contract.js";
import { adoptRunChildren, createDetachedWorkHost, spawnRunChild, startRunChildProbe, type DetachedWorkHostInput, type SpawnRunChildInput, type SpawnRunChildPorts } from "#src/lib/run-child.js";
import { runChildMain, type RunChildMainPorts } from "#src/run-child-main.js";
import { spawnWorker, createClaudeExecutableCache, CLAUDE_BIN_ENV_OVERRIDE } from "#src/lib/worker.js";
import { spawnCodexWorker } from "#src/lib/worker-provider.js";
import { spawnDetachedGroup } from "#src/lib/worker-containment.js";
import { applyOperatorMergeHold } from "#src/lib/operator-merge-hold.js";
import { automergeHoldFromLedger } from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const { buildChildEntries } = createRequire(import.meta.url)("#scripts/build-child-entries.mjs") as {
  buildChildEntries(options: { root: string; outDir: string; entries: { name: string; source: string }[]; workers: string[] }): Promise<unknown>;
};
let bundleRoot: string | undefined;
let childBundle: string;
before(async () => {
  bundleRoot = makeTempDir("selected-child-bundle");
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules")), join(bundleRoot, "node_modules"), "dir");
  const outDir = join(bundleRoot, "dist", "child-entries");
  // Build the current real entry once, before case deadlines: repeated full tsx graph loads contend in flake-screen.
  await buildChildEntries({ root: REPO_ROOT, outDir,
    entries: [{ name: "run-child", source: "src/run-child-main.ts" }], workers: [] });
  childBundle = join(outDir, "run-child.mjs");
}, { timeout: 240_000 });
after(() => { if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true }); });

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
    process.exitCode = await runChildMain(process.argv.slice(1), { env: {}, loadRunPath: async () => ({}),
      selectedRegistryRecord: (step, fields) => console.error(JSON.stringify({step,...fields})),
      runTask: async (taskId, options) => {
        if (options.selectedRegistryIntent?.kind !== 'shadow' || !options.selectedRegistryIntent.input.expectedDigest)
          throw new Error('child entry lost admitted shadow intent');
        return {taskId, runId: 'fixture', verdict: 'no_pr', merged: false, costUsd: 0};
      } });`;
  let turned = false;
  const input: SpawnRunChildInput = { taskId: f.spec.taskId, root: f.root, stateRoot: state, repoDir: f.root,
    options: f.spec.options, log: () => {}, plan: async () => {
      f.spec.options.selectedRegistryIntent = consumers.captureSelectedRegistryIntent({ settings: { ...f.settings, registryPath: f.other } });
      return { plan: { tasks: [] } };
    } };
  const ports: SpawnRunChildPorts = { mainSha: async () => f.spec.engine.sha, engine: { isCurrent: () => true },
    launch: (_engine, args) => ({ cwd: REPO_ROOT, engineRoot: engine, kind: "tsx", reason: "fixture",
      argv: ["--import", "tsx", "--input-type=module", "-e", code, "--", ...args] }),
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

test("selected registry shadow intent survives actual trusted child transport - probe", { timeout: 30_000 }, async t => {
  const f = fixture(t), state = join(f.root, "state"), engine = join(state, "engines", f.spec.engine.sourceHash);
  mkdirSync(engine, { recursive: true });
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules")), join(engine, "node_modules"), "dir");
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ ...f.spec.engine, builtAt: Date.now() }));
  let release!: (value: { plan: { tasks: never[] } }) => void;
  const plan = new Promise<{ plan: { tasks: never[] } }>(resolve => { release = resolve; });
  const probing = startRunChildProbe({ taskId: f.spec.taskId, root: f.root, stateRoot: state, repoDir: f.root,
    options: f.spec.options, plan, log: (step, fields) => { f.rows.push({ step, ...fields }); } }, {
    readMode: () => "shadow", mainSha: async () => f.spec.engine.sha, engine: { isCurrent: () => true },
    launch: (_engine, args) => ({ cwd: REPO_ROOT, engineRoot: engine, kind: "bundle", reason: "real probe entry",
      argv: [childBundle, ...args] }),
    reserve: () => ({ id: "fixture", bindRoot() {}, releaseOccupancy() {} }) as never,
    timeoutMs: 20_000,
  });
  f.spec.options.selectedRegistryIntent = consumers.captureSelectedRegistryIntent({ settings: { ...f.settings, registryPath: f.other } });
  release({ plan: { tasks: [] } });
  const outcome = await probing; assert.ok(outcome.started);
  assert.equal(outcome.row.contract, "ok", JSON.stringify(outcome.row));
  assert.equal(outcome.row.entry_kind, "bundle");
  const spec = readSpec(join(state, "runs", String(outcome.row.run_id))); assert.ok(spec.ok);
  const intent = spec.value.options.selectedRegistryIntent; assert.ok(intent?.kind === "shadow");
  assert.equal(intent.input.configuredPath, f.path); assert.ok(intent.input.expectedDigest);
});

test("selected registry shadow intent survives actual trusted child transport - production detached producers", { timeout: 90_000 }, async t => {
  const f = fixture(t), state = join(f.root, "state"), engine = join(state, "engines", f.spec.engine.sourceHash);
  mkdirSync(engine, { recursive: true });
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules")), join(engine, "node_modules"), "dir");
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ ...f.spec.engine, builtAt: Date.now() }));
  const entry = pathToFileURL(join(REPO_ROOT, "src/run-child-main.ts")).href;
  const consumerEntry = pathToFileURL(join(REPO_ROOT, "src/lib/selected-registry-consumers.ts")).href;
  const code = `import { runChildMain } from ${JSON.stringify(entry)};
    import * as consumers from ${JSON.stringify(consumerEntry)};
    import { writeFileSync } from 'node:fs';
    process.exitCode = await runChildMain(process.argv.slice(1), { env: {}, loadRunPath: async () => ({}),
      selectedRegistryRecord: (step, fields) => console.error(JSON.stringify({step,...fields})),
      runDetachedWork: async (work, ctx) => {
        const observer = consumers.selectedRegistryObserverInContext();
        if (!observer || !consumers.hasQualifiedSelectedRegistryRunContext()) throw new Error('lost detached intent');
        await observer.observe('run-task-resume', {}, () => work.kind);
        await observer.settled();
        writeFileSync(${JSON.stringify(f.path)}, ${JSON.stringify(text("replacement"))});
        await observer.observe('run-task-resume', {}, () => work.kind);
        return {taskId:ctx.taskId,runId:ctx.runId,verdict:'no_pr',merged:false,costUsd:0};
      } });`;
  const dirs: string[] = [];
  const ports: SpawnRunChildPorts = { mainSha: async () => f.spec.engine.sha, engine: { isCurrent: () => true },
    launch: (_engine, args) => ({ cwd: REPO_ROOT, engineRoot: engine, kind: "tsx", reason: "real detached entry",
      argv: ["--import", "tsx", "--input-type=module", "-e", code, "--", ...args] }),
    reserve: async () => ({ id: "fixture", bindRoot() {}, releaseOccupancy() {} }) as never,
    workerAdmissionHold: () => undefined, pollMs: 5, watch: false };
  for (const kind of ["review", "fix-dispatch", "retro"] as const) {
    writeFileSync(f.path, text());
    const mutable = structuredClone(f.intent)!;
    const input: DetachedWorkHostInput = { stateRoot: state, repoDir: f.root, root: f.root, repo: "repo", log: () => {},
      selectedRegistryIntent: mutable, readMode: () => "on", readLedger: () => {
        if (mutable.kind === "shadow") (mutable.input as { configuredPath: string }).configuredPath = f.other;
        input.selectedRegistryIntent = undefined;
        return [{ step: "daemon.memory_drain.completed", duration_ms: 5000,
          waited_on: [{ what: kind === "review" ? "review" : "detached", kind, settled_after_ms: 5000 }] }];
      }, spawn: async args => {
        const child = await spawnRunChild(args, ports);
        if (child.started) dirs.push(child.dir);
        return child;
      } };
    const host = createDetachedWorkHost(input);
    const pr = { prNumber: 19, headSha: "b".repeat(40), taskId: f.spec.taskId };
    const child = kind === "review" ? await host.spawnReview({ pr, reviewKey: "fixture-review", reviewAttemptId: undefined })
      : kind === "fix-dispatch" ? await host.spawnFix!({ pr, fixKey: "fixture-fix", envelope: {} as never })
      : await host.spawnRetro!({ decision: { fire: true, reason: "days", mergesSinceMarker: 0, daysSinceMarker: 1 } });
    assert.ok(child && "settled" in child, `production ${kind} must launch`);
    assert.equal((await child.settled as { verdict: string }).verdict, "no_pr");
    const dir = dirs.at(-1)!;
    const stored = readSpec(dir); assert.ok(stored.ok);
    const intent = stored.value.options.selectedRegistryIntent; assert.ok(intent?.kind === "shadow");
    assert.equal(intent.input.configuredPath, f.path); assert.ok(intent.input.expectedDigest);
    const output = readFileSync(join(dir, "stderr.log"), "utf8");
    const rows = output.trim().split("\n").map(line => JSON.parse(line) as Row);
    assert.ok(rows.some(row => row.action === "run-task-resume" && row.selected_state === "ready"));
    assert.ok(rows.some(row => row.action === "run-task-resume" && row.selected_state === "unknown" && row.reason === "revision_changed"));
    assert.ok(rows.some(row => row.action === "run-child" && row.selected_state === "unknown"));
    assert.ok(rows.every(row => row.publication_permission === "not-granted"));
    assert.equal(output.includes(f.path) || output.includes("registry-material-sentinel"), false);
  }
});

test("selected child observer retains its original source identity across restart", async t => {
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

test("selected child qualification isolates private material from workers", { timeout: 30_000 }, async t => {
  const f = fixture(t), repo = gitRepo();
  t.after(repo.cleanup);
  writeSpec(f.dir, f.spec);
  const socketPath = join(f.root, "git.sock");
  let requests = 0;
  const server = createServer(socket => {
    let request = "";
    socket.on("data", data => { request += data; });
    socket.on("end", () => {
      assert.match(request, /path=owner\/repo.git/);
      requests++; socket.end("username=fixture\npassword=scoped-fixture-token\n");
    });
  });
  server.listen(socketPath); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const settingsFile = join(f.root, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  const old = { registry: process.env.RMD_INSTANCE_REGISTRY, bytes: process.env.PRIVATE_REGISTRY_BYTES };
  process.env.RMD_INSTANCE_REGISTRY = f.path; process.env.PRIVATE_REGISTRY_BYTES = text();
  t.after(() => {
    for (const [key, value] of [["RMD_INSTANCE_REGISTRY", old.registry], ["PRIVATE_REGISTRY_BYTES", old.bytes]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  const captures: unknown[] = [];
  f.ports.runTask = async taskId => {
    const resultPath = join(f.root, "worker-observed.json");
    const code = `const fs = require('fs');
      let prompt = ''; process.stdin.on('data', c => prompt += c);
      process.stdin.on('end', () => {
        const credential = require('child_process').execFileSync('git', ['credential', 'fill'], {
          cwd: ${JSON.stringify(repo.dir)}, env: {...process.env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'},
          input: 'url=https://github.com/owner/repo.git\\n\\n', encoding:'utf8', timeout:5000,
        });
        fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({env:process.env,prompt,credential}));
      });
    `;
    const worker = await spawnWorker({
      cwd: repo.dir, prompt: "harmless worker prompt", settingsFile, permissionMode: "bypassPermissions",
      config: { root: f.root, claudeBin: "/unused" },
      runId: f.spec.runId, taskId,
      env: { RMD_INSTANCE_REGISTRY: f.path, SAFE_EXTRA: "preserved" },
      secretBoundary: { credentialHelperSocketPath: socketPath },
      claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
        env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: f.root,
        exists: () => true, canExecute: () => true, which: () => undefined, locations: [],
      } },
      keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: {
        accessToken: "fixture", expiresAt: Date.now() + 86_400_000,
      } }) },
      queryFn: ((input: { prompt: string; options: { env: Record<string,string>; spawnClaudeCodeProcess: (opts: unknown) => unknown } }) => {
        captures.push({ prompt: input.prompt, env: input.options.env });
        for (const entry of readdirSync(input.options.env.HOME!)) {
          const path = join(input.options.env.HOME!, entry);
          if (lstatSync(path).isSymbolicLink()) assert.ok(!realpathSync(path).includes("private-selected"));
        }
        const child = input.options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", code],
          cwd: repo.dir, env: input.options.env }) as ReturnType<typeof spawnDetachedGroup>["process"] & EventEmitter;
        let stderr = "";
        (child as unknown as { stderr: NodeJS.ReadableStream }).stderr.on("data", chunk => { stderr += chunk; });
        child.stdin!.end(input.prompt);
        return (async function* () {
          const [exit] = await once(child, "close");
          assert.equal(exit, 0, stderr);
          yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "fixture", total_cost_usd: 0, num_turns: 1 };
        })();
      }) as never,
    });
    assert.equal(worker.isError, false);
    const observed = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(observed.env.RMD_INSTANCE_REGISTRY, undefined);
    assert.equal(observed.env.PRIVATE_REGISTRY_BYTES, undefined);
    assert.equal(observed.env.SAFE_EXTRA, "preserved", "positive control: the real process received caller extras");
    assert.equal(observed.env.REMUDERO_RUN_ID, f.spec.runId);
    captures.push(observed);
    const helper = repo.git("config", "--worktree", "--get-all", "credential.helper");
    assert.ok(helper.includes(socketPath), "real spawnWorker wired the scoped credential helper");
    assert.match(observed.credential, /scoped-fixture-token/);
    assert.equal(requests, 1, "the actual worker process used the configured helper socket");
    const executable = join(f.root, "codex-fixture");
    writeFileSync(executable, `#!${process.execPath}
      let prompt=''; process.stdin.on('data', c => prompt += c);
      process.stdin.on('end', () => {
        require('fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({env:process.env,prompt}));
        console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
        console.log(JSON.stringify({type:'turn.started'}));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
        console.log(JSON.stringify({type:'turn.completed',usage:{}}));
      });
    `, { mode: 0o700 });
    const codexHome = join(f.root, "codex-home"); mkdirSync(codexHome);
    let argv: string[] = [];
    const codex = await spawnCodexWorker({ cwd: repo.dir, workerHome: codexHome, prompt: "harmless codex prompt",
      tools: ["Read"], settingsFile: join(REPO_ROOT, "settings/worker.json"),
      env: { RMD_INSTANCE_REGISTRY: f.path, SAFE_EXTRA: "preserved" },
      containment: { spawn: (options, stderr, error) => {
        argv = options.args; return spawnDetachedGroup(options, stderr, error);
      } },
    }, { root: f.root, claudeBin: "/unused", workerProviders: { enabled: ["codex"], codexBin: executable,
      codexHome, codexModel: "gpt-6-luna" } });
    assert.equal(codex.isError, false);
    const codexObserved = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(codexObserved.env.RMD_INSTANCE_REGISTRY, undefined);
    assert.equal(codexObserved.env.PRIVATE_REGISTRY_BYTES, undefined);
    assert.equal(codexObserved.env.SAFE_EXTRA, "preserved");
    captures.push(codexObserved, argv);
    assert.ok(!argv.includes("--add-dir"), "the read-only worker inherits no selected private mount");
    return { taskId, runId: f.spec.runId, verdict: "no_pr", merged: false, costUsd: 0 };
  };
  assert.equal(await runChildMain(["--run-dir", f.dir], f.ports), 0);
  assert.ok(receipts(f.rows).length > 0);
  const publicText = JSON.stringify([captures, f.rows]) + readFileSync(join(f.dir, "status.json"), "utf8");
  assert.ok(!publicText.includes(f.path)); assert.ok(!publicText.includes("registry-material-sentinel"));
});

test("selected child defaults and recovery preserve shadow effects and owner holds", { timeout: 30_000 }, async t => {
  const f = fixture(t), state = join(f.root, "state"), ledger = join(state, "ledger.ndjson");
  const held = applyOperatorMergeHold(ledger, { action: "engage", by: "fixture owner",
    reason: "manual review", authority: "console-confirmed", prNumber: 19 });
  assert.ok(held.current);
  const originalHold = readFileSync(ledger, "utf8");
  mkdirSync(join(f.root, ".config/remudero"), { recursive: true });
  writeFileSync(join(f.root, ".config/remudero/config.json"), JSON.stringify({ root: f.root, claudeBin: "/bin/false" }));
  const engine = join(state, "engines", f.spec.engine.sourceHash);
  mkdirSync(engine, { recursive: true });
  symlinkSync(realpathSync(join(REPO_ROOT, "node_modules")), join(engine, "node_modules"), "dir");
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ ...f.spec.engine, builtAt: Date.now() }));
  let released = 0, turns = 0;
  const stderr: string[] = [];
  const responsive = setInterval(() => { turns++; }, 1);
  t.after(() => clearInterval(responsive));
  const ports: SpawnRunChildPorts = {
    mainSha: async () => f.spec.engine.sha, engine: { isCurrent: () => true },
    launch: (_engine, args) => ({ cwd: REPO_ROOT, engineRoot: engine, kind: "bundle", reason: "real default entry",
      argv: [childBundle, ...args] }),
    env: { PATH: process.env.PATH, HOME: f.root, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
      RMD_TEST_LIVE_DENY_ROOT: process.env.RMD_TEST_LIVE_DENY_ROOT },
    reserve: async () => ({ id: "fixture", bindRoot() {}, releaseOccupancy() { released++; } }) as never,
    workerAdmissionHold: () => undefined, pollMs: 5, watch: false,
  };
  const literalPlan = join(f.root, "tasks.yaml"); writeFileSync(literalPlan, "[]\n");
  for (const intent of [f.intent, undefined]) {
    const child = await spawnRunChild({ taskId: f.spec.taskId, root: f.root, stateRoot: state, repoDir: f.root,
      options: { selectedRegistryIntent: intent, skipGitSync: true, planPath: literalPlan }, log: (step, fields) => { f.rows.push({ step, ...fields }); },
      plan: async () => ({ plan: { tasks: [] } }),
    }, ports);
    assert.ok(child.started, JSON.stringify(child));
    const settled = await Promise.allSettled([child.settled]);
    assert.equal(settled[0]!.status, "rejected", "real runTask rejects a task absent from its admitted plan");
    const status = readStatus(child.dir); assert.ok(status.ok);
    assert.equal(status.value.entryKind, "bundle");
    assert.equal(status.value.state, "failed");
    assert.equal(status.value.failure?.class, "terminal_error");
    assert.equal(status.value.failure?.message, `no task with id '${f.spec.taskId}' in plan`);
    stderr.push(readFileSync(join(child.dir, "stderr.log"), "utf8"));
    const specBeforeAdoption = readFileSync(join(child.dir, "spec.json"), "utf8");
    const stored = readSpec(child.dir); assert.ok(stored.ok);
    child.detach?.();
    const adopted = adoptRunChildren({ stateRoot: state, instance: stored.value.instance, log: () => {}, settledRunIds: new Set() },
      { pollMs: 5, watch: false }).filter(handle => handle.runId === child.runId);
    assert.equal(adopted.length, 1);
    const recovery = await Promise.allSettled([adopted[0]!.settled]);
    assert.equal(recovery[0]!.status, "rejected");
    if (recovery[0]!.status === "rejected" && settled[0]!.status === "rejected") {
      assert.equal(recovery[0].reason.message, settled[0].reason.message);
    }
    assert.equal(readFileSync(join(child.dir, "spec.json"), "utf8"), specBeforeAdoption, "adoption retains the rollback tuple");
    assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledger), 19), held.current);
  }
  assert.equal(released, 2);
  assert.ok(turns > 0, "default process execution leaves the parent's loop responsive");
  const rows = readLedgerLines(ledger);
  const observations = rows.filter(row => row.step === "instance_registry.consumer_shadow_observed");
  assert.equal(observations.length, 1, `legacy sibling emits no selected observation: ${JSON.stringify({ rows, stderr })}`);
  assert.equal(observations[0]!.legacy_outcome, "threw");
  assert.equal(observations[0]!.publication_permission, "not-granted");
  assert.ok(readFileSync(ledger, "utf8").startsWith(originalHold));
  assert.equal(rows.some(row => row.step === "automerge.hold_released" || row.step === "automerge.armed"), false);
  const broken = fixture(t); writeSpec(broken.dir, broken.spec);
  broken.spec.planSnapshotPath = join(broken.root, "missing-plan.json"); writeSpec(broken.dir, broken.spec);
  assert.equal(await runChildMain(["--run-dir", broken.dir], { env: {}, stderr: () => {} }), 1);
  const startup = readStatus(broken.dir); assert.ok(startup.ok);
  assert.equal(startup.value.failure?.reasonClass, "plan_snapshot_unreadable");
  assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledger), 19), held.current);
  const unknownDir = join(state, "runs", "run-unknown");
  writeSpec(unknownDir, { ...f.spec, runId: "run-unknown" });
  writeFileSync(join(unknownDir, "status.json"), JSON.stringify({ schema: { major: 99, minor: 0 } }));
  const unknownRows: Row[] = [];
  const unknownChildren = adoptRunChildren({ stateRoot: state, instance: f.spec.instance, settledRunIds: new Set(),
    log: (step, fields) => { unknownRows.push({ step, ...fields }); } });
  assert.deepEqual(unknownChildren, []);
  assert.equal(unknownRows.filter(row => row.step === "run_child.adoption_unreadable").length, 1);
  assert.equal(unknownRows.find(row => row.step === "run_child.adoption_pass")?.unreadable, 1);
  assert.deepEqual(automergeHoldFromLedger(readLedgerLines(ledger), 19), held.current);
});
