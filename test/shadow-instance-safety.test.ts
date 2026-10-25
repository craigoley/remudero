import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as runtimeRegistry from "#src/lib/instance-registry-selection.js";
import { observeSelectedMode } from "#src/lib/instance-mode.js";
import { daemonCommand } from "#src/cli/commands/daemon.js";
import { runTask as directRunTask } from "#src/cli/commands/run-task-verb.js";
import { main } from "#src/run-task.js";
import { spawnCodexWorker } from "#src/lib/worker-provider.js";
import { realDeployDeps } from "#src/lib/deployer.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { workerHomeDir } from "#src/lib/config.js";
import { perRunWorkerHomeDir } from "#src/lib/worker-home.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, renderWorkerSettings, spawnWorker,
  startWorkerEgressProxy, type SpawnWorkerArgs } from "#src/lib/worker.js";

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

test("selected runtime entry points qualify before daemon and direct task host effects", async () => {
  const fixture = runtimeRegistryFixture(), prior = process.env.RMD_INSTANCE_REGISTRY;
  const reachedHost = new Error("contained host boundary reached");
  let reads = 0, observed: string | undefined;
  const host = new Proxy({}, { get: () => {
    reads++;
    observed = instanceMode("owner/repo", readInstanceRegistryText(fixture.root));
    throw reachedHost;
  } });
  const entries = [
    () => daemonCommand([], {}, host as Parameters<typeof daemonCommand>[2]),
    () => directRunTask("fixture", {}, host as Parameters<typeof directRunTask>[2]),
  ];
  try {
    for (const enter of entries) {
      process.env.RMD_INSTANCE_REGISTRY = "";
      const before = reads;
      await assert.rejects(enter(), /selected instance registry unavailable/);
      assert.equal(reads, before, "explicit invalid selection must not touch the command host");
      process.env.RMD_INSTANCE_REGISTRY = fixture.selected;
      await assert.rejects(enter(), error => error === reachedHost);
      assert.equal(observed, "shadow", "actual entrypoint host reads must see selected default bytes");
      delete process.env.RMD_INSTANCE_REGISTRY;
      await assert.rejects(enter(), error => error === reachedHost);
      assert.equal(observed, "live", "genuine absence retains the existing legacy reader");
    }
  } finally {
    if (prior === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = prior;
    fixture.cleanup();
  }
});

test("selected runtime CLI entry refuses invalid input without changing unselected read-only dispatch", async (t) => {
  const fixture = runtimeRegistryFixture(), prior = process.env.RMD_INSTANCE_REGISTRY, argv = process.argv;
  const reachedExit = new Error("contained CLI exit");
  let code: number | string | undefined;
  t.mock.method(process, "exit", ((value?: number | string): never => { code = value; throw reachedExit; }) as typeof process.exit);
  t.mock.method(process.stderr, "write", (_chunk: unknown, encodingOrDone?: unknown, done?: unknown) => {
    const callback = typeof encodingOrDone === "function" ? encodingOrDone : done;
    if (typeof callback === "function") callback();
    return true;
  });
  process.argv = [process.execPath, "rmd", "daemon"];
  try {
    process.env.RMD_INSTANCE_REGISTRY = "";
    await assert.rejects(main(), /selected instance registry unavailable/);
    assert.equal(code, undefined, "invalid selection stops before the actual dispatch exit");
    process.argv = [process.execPath, "rmd", "gh", "missing-separator"];
    for (const selected of [undefined, fixture.selected, ""]) {
      if (selected === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = selected;
      await assert.rejects(main(), error => error === reachedExit);
      assert.equal(code, 2, "read-only recovery dispatch must not become a global selected-configuration hold");
    }
  } finally {
    process.argv = argv;
    if (prior === undefined) delete process.env.RMD_INSTANCE_REGISTRY; else process.env.RMD_INSTANCE_REGISTRY = prior;
    fixture.cleanup();
  }
});

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

test("selected runtime private file binds canonical identity and refuses aliasable hardlinks", async () => {
  const fixture = runtimeRegistryFixture();
  try {
    const run = runtimeRegistryRunner(), link = join(fixture.root, "hardlink.yaml");
    linkSync(fixture.selected, link);
    await assert.rejects(run(() => undefined, { envPath: fixture.selected }), /selected instance registry unavailable/,
      "an existing hardlink bypasses a pathname-only OS denial");
    unlinkSync(link);
    const privateFile = Reflect.get(runtimeRegistry, "runtimeInstanceRegistryPrivateFile");
    assert.equal(typeof privateFile, "function", "only the trusted invocation may obtain the actual canonical file");
    const parent = join(fixture.root, "parent");
    symlinkSync(fixture.root, parent);
    await run(async () => {
      assert.equal(privateFile(), fixture.selected, "deny the physical file, not merely a symlink spelling");
      const replacement = join(fixture.root, "replacement.yaml");
      writeFileSync(replacement, readFileSync(fixture.selected));
      renameSync(replacement, fixture.selected);
      await assert.rejects(runtimeRegistry.assertInstanceRegistryRuntimeCurrent(), /selected instance registry unavailable/,
        "same bytes at a replacement inode are still revised evidence");
    }, { envPath: join(parent, "private.yaml") });
    assert.equal(privateFile(), undefined, "a later worker cannot inherit the completed invocation's private target");
  } finally { fixture.cleanup(); }
});

test("selected runtime canonical identity lookup shares the bounded read deadline", async () => {
  const fixture = runtimeRegistryFixture();
  let effects = 0;
  try {
    const io = { ...runtimeRegistry.registryFileIO, canonicalPath: async (path: string) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return runtimeRegistry.registryFileIO.canonicalPath!(path);
    } };
    await assert.rejects(runtimeRegistry.withInstanceRegistryRuntime(() => { effects++; },
      { envPath: fixture.selected, timeoutMs: 10 }, io), /selected instance registry unavailable \(timeout\)/);
    assert.equal(effects, 0, "late physical identity is not permission to start a selected effect");
    await new Promise(resolve => setTimeout(resolve, 70));
  } finally { fixture.cleanup(); }
});

test("selected runtime trusted launcher packet uses the real bounded child and immutable digest", async () => {
  const fixture = runtimeRegistryFixture();
  const script = 'const {pathToFileURL}=await import("node:url"); const m=await import(pathToFileURL(process.argv[1]).href); try { await m.withInstanceRegistryRuntime(()=>process.stdout.write(m.trustedInstanceRegistryLaunchPacket()), {envPath:process.env.RMD_INSTANCE_REGISTRY,instanceName:process.argv[2],expectedDigest:process.env.RMD_INSTANCE_REGISTRY_DIGEST}); } catch { process.exitCode=2; }';
  const invoke = (digest?: string, instance = "worker") => spawnSync(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, join(REPO_ROOT, "src/lib/instance-registry-selection.ts"), instance],
    { cwd: REPO_ROOT, env: { ...process.env, RMD_INSTANCE_REGISTRY: fixture.selected,
      ...(digest === undefined ? {} : { RMD_INSTANCE_REGISTRY_DIGEST: digest }) }, encoding: "utf8", timeout: 10000 });
  try {
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    const packet = first.stdout.split("\n");
    assert.equal(packet.length, 6);
    assert.equal(packet[0], "rmd-private-registry-v1");
    assert.equal(packet[1], fixture.selected);
    for (const index of [2, 3, 4]) assert.match(packet[index]!, /^[a-f0-9]{64}$/);
    assert.equal(Buffer.from(packet[5]!, "base64").toString("utf8"), registry("shadow"));
    assert.equal(invoke(packet[2]).stdout, first.stdout, "same physical file and instance remain bound");
    assert.equal(invoke("0".repeat(64)).status, 2, "expected bytes are checked inside the actual default reader");
    assert.equal(invoke(undefined, "other").status, 2, "a same-repository or different-instance default is not a fallback");
    const replacement = join(fixture.root, "same-bytes.yaml");
    writeFileSync(replacement, readFileSync(fixture.selected)); renameSync(replacement, fixture.selected);
    const changed = invoke(packet[2]);
    assert.equal(changed.status, 0);
    assert.notEqual(changed.stdout.split("\n")[3], packet[3], "equal bytes never conceal a replacement physical identity");
  } finally { fixture.cleanup(); }
});

test("selected recycler default child checks the original parent digest and physical binding", async () => {
  const fixture = runtimeRegistryFixture();
  try {
    const packet = await runtimeRegistryRunner()(() => runtimeRegistry.trustedInstanceRegistryLaunchPacket(),
      { envPath: fixture.selected, instanceName: "worker" });
    const fields = packet.split("\n");
    const invoke = (digest = fields[2]!, binding = fields[3]!) => spawnSync("bash", ["-c",
      'source "$1"; selected_registry_init "$2" "$3" fixture', "selected-child-fixture",
      join(REPO_ROOT, "deploy/recycle-container.sh"), REPO_ROOT, "worker"],
      { cwd: REPO_ROOT, env: { ...process.env, RMD_INSTANCE_REGISTRY: fixture.selected,
        RMD_INSTANCE_REGISTRY_DIGEST: digest, RMD_INSTANCE_REGISTRY_LAUNCH_BINDING: binding }, encoding: "utf8", timeout: 10000 });
    const healthy = invoke(); assert.equal(healthy.status, 0, healthy.stderr);
    for (const [digest, binding] of [["", fields[3]!], ["0".repeat(64), fields[3]!], [fields[2]!, "0".repeat(64)]]) {
      const refused = invoke(digest, binding);
      assert.equal(refused.status, 2); assert.match(refused.stderr, /selected registry unavailable/);
      assert.equal(refused.stdout, ""); assert.equal(refused.stderr.includes(fixture.root), false);
    }
    const replacement = join(fixture.root, "replacement");
    writeFileSync(replacement, readFileSync(fixture.selected)); renameSync(replacement, fixture.selected);
    const replaced = invoke(); assert.equal(replaced.status, 2); assert.match(replaced.stderr, /revision_changed/);
  } finally { fixture.cleanup(); }
});

test("selected supervisor hands immutable private identity only to its trusted recycler and redacts failures", async () => {
  const fixture = runtimeRegistryFixture(), calls: string[][] = [];
  const stateRoot = join(fixture.root, "selected-state");
  writeFileSync(fixture.selected, registry("shadow") + `    state_dir: ${stateRoot}\n    container_name: selected-container\n`);
  try {
    await runtimeRegistryRunner()(() => {
      const options: Parameters<typeof realDeployDeps>[0] = { installPath: fixture.root, stateRoot, daemonLabel: "fixture", serveLabel: "fixture-serve",
        servePort: 1, uid: 1, ledgerPath: join(stateRoot, "unused"), log: () => {},
        execFile: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ""; } };
      const deps = realDeployDeps(options), recycler = deps.restartBackends!().find(b => b.name === "recycle-container")!;
      options.instance = "retargeted";
      recycler.restart();
      const command = calls.at(-1)!;
      assert.ok(command.includes("worker"), "selected bytes, not the healthy public row, name the target");
      assert.ok(command.includes(fixture.selected), "only this trusted host launcher receives the private selection");
      assert.ok(command.some(arg => /^[a-f0-9]{64}$/.test(arg)), "the original digest/physical binding survives the handoff");
      calls.length = 0;
      assert.throws(() => deps.kickstart(), /selected instance registry unavailable/);
      assert.deepEqual(calls, [], "an unsupported launchctl route must refuse before a restart");
      const refused = realDeployDeps({ ...options, instance: "worker", execFile: () => { throw new Error(fixture.selected); } });
      assert.throws(() => refused.restartBackends!().find(b => b.name === "recycle-container")!.restart(), error => {
        assert.ok(error instanceof runtimeRegistry.InstanceRegistryRuntimeError);
        assert.equal(error.message.includes(fixture.root), false, "exec failures must not quote private argv");
        return true;
      });
    }, { envPath: fixture.selected, instanceName: "worker" });
  } finally { fixture.cleanup(); }
});

test("selected trusted launcher target cannot contradict its original invocation", async () => {
  const fixture = runtimeRegistryFixture();
  try {
    await runtimeRegistryRunner()(() => {
      const packet = runtimeRegistry.trustedInstanceRegistryLaunchPacket as (target?: string) => string;
      assert.throws(() => packet("different"), /selected instance registry unavailable/);
      assert.equal(packet("worker").split("\n")[0], "rmd-private-registry-v1");
    }, { envPath: fixture.selected, instanceName: "worker" });
    await runtimeRegistryRunner()(() => {
      const packet = runtimeRegistry.trustedInstanceRegistryLaunchPacket as (target?: string) => string;
      assert.equal(packet("worker").split("\n")[0], "rmd-private-registry-v1", "an explicit trusted target can bind an unnamed host invocation");
    }, { envPath: fixture.selected });
  } finally { fixture.cleanup(); }
});

test("selected runtime Codex spawn denies private bytes without adding them to child arguments", async () => {
  const fixture = runtimeRegistryFixture(), codexHome = join(fixture.root, "codex-home");
  const cwd = join(fixture.root, "checkout"), publicSource = join(fixture.root, "public-source");
  mkdirSync(codexHome); mkdirSync(cwd); mkdirSync(publicSource);
  let profileFile = "", spawns = 0;
  try {
    for (const intent of ["reader", "writer", "review"] as const) {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
      let prompt = "";
      stdin.on("data", chunk => { prompt += String(chunk); });
      stdin.on("finish", () => {
        stdout.end(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
        queueMicrotask(() => child.emit("exit", 0));
      });
      await runtimeRegistryRunner()(() => spawnCodexWorker({
        cwd, workerHome: fixture.root, prompt: "contained boundary probe",
        settingsFile: join(REPO_ROOT, "settings", "worker.json"),
        tools: intent === "writer" ? ["Read", "Edit", "Bash"] : ["Read", "Bash"],
        ...(intent === "review" ? { sandboxIntent: "disposable-review" as const, sandboxReadRoots: [publicSource] } : {}),
        containment: { spawn: options => {
          spawns++;
          const index = options.args.indexOf("--profile");
          assert.ok(index >= 0, "actual worker spawn must use the protected per-invocation profile");
          profileFile = join(codexHome, options.args[index + 1]! + ".config.toml");
          const text = readFileSync(profileFile, "utf8");
          assert.equal(text.includes(fixture.selected), false, "permissions must not disclose the private source");
          assert.equal(text.includes(profileFile), false, "permissions must not disclose their own artifact");
          assert.ok(text.includes('\":root\"="deny"'));
          const inline = options.args.filter((_, i) => options.args[i - 1] === "-c").join("\n");
          assert.ok(inline.includes('filesystem={\":root\"="deny"'), "real exec must receive the enforceable inline policy too");
          assert.ok(inline.includes(`default_permissions=${JSON.stringify(options.args[index + 1])}`));
          assert.ok(text.includes(`extends="${intent === "reader" ? ":read-only" : ":workspace"}"`));
          if (intent === "review") {
            assert.ok(text.includes(`${JSON.stringify(publicSource)}="read"`), "existing public reviewer read roots stay available");
            assert.ok(text.includes('\":slash_tmp\"="deny"'));
            assert.ok(options.args.includes("network_proxy"));
          }
          assert.ok(options.args.includes("--strict-config"), "unsupported old config must refuse, never silently ignore denial");
          assert.equal(options.args.includes("--sandbox"), false, "a legacy sandbox flag must not replace the named denial");
          assert.equal(JSON.stringify(options.args).includes(fixture.selected), false);
          assert.equal(JSON.stringify(options.env).includes(fixture.selected), false);
          return { process: child as never, pid: 9876 };
        }, teardown: () => {} },
      }, { root: fixture.root, claudeBin: "/unused", workerProviders: {
        enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome,
      } }), { envPath: fixture.selected });
      assert.equal(prompt.includes(fixture.selected), false);
      assert.equal(existsSync(profileFile), false, "only the invocation's own profile is retired after the child ends");
      assert.deepEqual(readdirSync(codexHome), [], "shared authentication/configuration files are never copied or changed");
    }
    assert.equal(spawns, 3);
  } finally { fixture.cleanup(); }
});

test("selected Codex dispatch snapshots caller-owned arguments before its first asynchronous boundary", async () => {
  const fixture = runtimeRegistryFixture(), codexHome = join(fixture.root, "codex-home");
  const cwd = join(fixture.root, "checkout"); mkdirSync(codexHome); mkdirSync(cwd);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let prompt = "", spawns = 0;
  stdin.on("data", chunk => { prompt += String(chunk); });
  stdin.on("finish", () => {
    stdout.end(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
    queueMicrotask(() => child.emit("exit", 0));
  });
  const args: Parameters<typeof spawnCodexWorker>[0] = {
    cwd, workerHome: fixture.root, prompt: "original public prompt",
    settingsFile: join(REPO_ROOT, "settings", "worker.json"), tools: ["Read", "Bash"],
    sandboxIntent: "disposable-review", sandboxReadRoots: [cwd], env: { PUBLIC_CANARY: "original" },
    containment: { spawn: options => {
      spawns++;
      assert.equal(options.cwd, cwd, "queued mutation cannot move the contained worker");
      assert.equal(options.env.HOME, fixture.root);
      assert.equal(options.env.PUBLIC_CANARY, "original");
      assert.equal(options.command, "/bin/sh", "provider binary/config are part of the invocation snapshot");
      const i = options.args.indexOf("--profile"); assert.ok(i >= 0);
      const profile = readFileSync(join(codexHome, options.args[i + 1]! + ".config.toml"), "utf8");
      assert.ok(profile.includes('\":workspace_roots\"="write"'));
      assert.equal(profile.includes("queued-mutant"), false);
      assert.equal(options.args[options.args.indexOf("--model") + 1], "gpt-6-luna");
      return { process: child as never, pid: 9876 };
    }, teardown: () => {} },
  };
  const config: Config = { root: fixture.root, claudeBin: "/unused", workerProviders: {
    enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome,
  } };
  try {
    await runtimeRegistryRunner()(async () => {
      const pending = spawnCodexWorker(args, config);
      args.cwd = join(fixture.root, "queued-mutant"); args.workerHome = args.cwd;
      args.prompt = fixture.selected; args.tools!.push("Edit");
      args.sandboxReadRoots!.push(join(fixture.root, "queued-mutant"));
      args.env!.PUBLIC_CANARY = "mutated";
      config.workerProviders!.codexBin = "/queued-mutant";
      config.workerProviders!.codexModel = "queued-mutant";
      config.workerProviders!.codexHome = join(fixture.root, "queued-mutant");
      await pending;
    }, { envPath: fixture.selected });
    assert.equal(spawns, 1);
    assert.ok(prompt.includes("original public prompt"));
    assert.equal(prompt.includes(fixture.selected), false, "late mutation cannot inject private bytes into stdin");
    assert.deepEqual(readdirSync(codexHome), []);
  } finally { fixture.cleanup(); }
});

test("selected runtime worker unknown and cleanup outcomes stay explicit", async () => {
  for (const mode of ["resume", "home-missing", "scope-overlap", "scope-relative", "config-uncopyable", "spawn-error", "profile-replaced", "profile-unlinked"] as const) {
    const fixture = runtimeRegistryFixture(), codexHome = join(fixture.root, "codex-home");
    const cwd = join(fixture.root, "checkout"); mkdirSync(cwd);
    const original = new Error("contained spawn failure");
    let spawns = 0, profileFile = "";
    if (mode !== "home-missing") mkdirSync(codexHome);
    try {
      const configured: Config = { root: fixture.root, claudeBin: "/unused", workerProviders: {
        enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome,
      } };
      const result = runtimeRegistryRunner()(() => spawnCodexWorker({
        cwd, workerHome: fixture.root, prompt: "no model call",
        settingsFile: join(REPO_ROOT, "settings", "worker.json"), tools: ["Read", "Bash"],
        ...(mode === "resume" ? { resumeSessionId: "old-permissions" } : {}),
        ...(mode === "scope-overlap" || mode === "scope-relative" ? { sandboxIntent: "disposable-review" as const,
          sandboxReadRoots: [mode === "scope-overlap" ? fixture.root : "relative"] } : {}),
        containment: { spawn: options => {
          spawns++;
          const index = options.args.indexOf("--profile"); assert.ok(index >= 0);
          profileFile = join(codexHome, options.args[index + 1]! + ".config.toml");
          if (mode === "profile-replaced") { unlinkSync(profileFile); writeFileSync(profileFile, "replacement"); }
          if (mode === "profile-unlinked") unlinkSync(profileFile);
          throw original;
        }, teardown: () => {} },
      }, mode === "config-uncopyable" ? new Proxy(configured, {}) : configured), { envPath: fixture.selected });
      await assert.rejects(result, error => {
        if (mode === "spawn-error") return error === original;
        assert.ok(error instanceof runtimeRegistry.InstanceRegistryRuntimeError);
        assert.equal(error.message.includes(fixture.root), false, "OS/private paths must not leak through a cleanup error");
        if (mode === "profile-replaced" || mode === "profile-unlinked") {
          assert.match(error.message, /worker_profile_cleanup_unknown/);
          assert.equal(error.cause, original, "cleanup uncertainty preserves the actual original failure");
        } else assert.match(error.message, mode === "resume" ? /worker_resume_not_qualified/
          : mode === "config-uncopyable" ? /worker_arguments_unqualified/
          : mode === "scope-overlap" ? /worker_scope_contains_private_file/
          : mode === "scope-relative" ? /worker_scope_unqualified/ : /worker_profile_unavailable/);
        return true;
      });
      if (["resume", "home-missing", "config-uncopyable", "scope-overlap", "scope-relative"].includes(mode)) assert.equal(spawns, 0);
      if (mode === "spawn-error") assert.equal(existsSync(profileFile), false);
      if (mode === "profile-replaced") assert.equal(readFileSync(profileFile, "utf8"), "replacement", "never delete a replacement as if it were our artifact");
      if (mode === "profile-unlinked") assert.equal(existsSync(profileFile), false, "absence is not falsely certified retained evidence");
    } finally { fixture.cleanup(); }
  }
});

test("selected private file denial follows actual scratch-backed Claude worker homes", async () => {
  const fixture = runtimeRegistryFixture(), operator = join(fixture.root, "operator");
  const selected = join(operator, ".config", "remudero", "selected-registry.yaml");
  mkdirSync(join(operator, ".config", "remudero"), { recursive: true, mode: 0o700 });
  writeFileSync(selected, registry("shadow"), { mode: 0o600 });
  const config: Config = { root: join(operator, "Remudero"), claudeBin: "/unused", installRoot: REPO_ROOT };
  const home = (env: NodeJS.ProcessEnv) => perRunWorkerHomeDir(workerHomeDir(config, env), "fixture", { perSpawn: true });
  const rendered = join(fixture.root, "worker-settings.json");
  // This oracle tests the paths named by the actual rendered policy, not a claim about SDK/OS enforcement.
  const namesSelectedFile = (rules: string[], workerHome: string) => rules.some(rule => {
    const absolute = rule.startsWith("~/") ? resolve(workerHome, rule.slice(2)) : rule;
    return absolute.endsWith("/**")
      ? selected === absolute.slice(0, -3) || selected.startsWith(absolute.slice(0, -3) + "/")
      : selected === absolute;
  });
  try {
    await runtimeRegistryRunner()(() => {
      renderWorkerSettings({ templatePath: join(REPO_ROOT, "settings", "worker.json"), hooksDir: join(REPO_ROOT, "hooks"), outPath: rendered });
      const rules = JSON.parse(readFileSync(rendered, "utf8")).sandbox.filesystem.denyRead as string[];
      assert.equal(namesSelectedFile(rules, home({})), true, "healthy default-home positive control sees the maintained private-config denial");
      const scratch = home({ RMD_WORKER_HOME_DIR: `${config.root}:${join(fixture.root, "scratch", "worker-homes")}` });
      assert.equal(namesSelectedFile(rules, scratch), true,
        "the actual per-spawn policy must name the selected physical file even when HOME moves to scratch");
    }, { envPath: selected });
  } finally { fixture.cleanup(); }
});

function privateClaudeArgs(fixture: ReturnType<typeof runtimeRegistryFixture>, sink: { options?: Record<string, unknown>; prompt?: unknown; calls: number }): SpawnWorkerArgs {
  const cwd = join(fixture.root, "checkout"), settingsFile = join(fixture.root, "settings.json");
  mkdirSync(cwd);
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true,
    allowUnsandboxedCommands: false, network: { allowedDomains: ["api.github.com"] } } }));
  return { cwd, settingsFile, prompt: "selected privacy fixture", permissionMode: "bypassPermissions",
    config: { root: fixture.root, claudeBin: "/unused" }, mountProvider: "claude", egress: { mode: "off" },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: fixture.root, exists: () => true, canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt: 4102444800000 } }) },
    queryFn: ((params: { options: Record<string, unknown>; prompt: unknown }) => {
      sink.calls++; sink.options = params.options; sink.prompt = params.prompt;
      return (async function* () { yield { type: "result", subtype: "success", is_error: false,
        result: "done", session_id: "selected-fixture", total_cost_usd: 0, num_turns: 1 }; })();
    }) as SpawnWorkerArgs["queryFn"] };
}

test("selected Claude SDK boundary snapshots private denials across queued arguments and egress replacement", async () => {
  for (const proxy of [false, true]) {
    const fixture = runtimeRegistryFixture(), sink = { calls: 0 } as { calls: number; options?: Record<string, unknown>; prompt?: unknown };
    try {
      const args = privateClaudeArgs(fixture, sink), originalPolicy = args.settingsFile;
      args.onMemoryAdmissionEnd = () => { args.settingsFile = join(fixture.root, "other-settings.json"); args.prompt = "retargeted"; };
      if (proxy) args.egress = { mode: "enforce", checkVersion: () => "fixture-verified-version", startProxy: settings => startWorkerEgressProxy(settings,
        () => { throw new Error("forbidden external egress in private-policy fixture"); }) };
      await runtimeRegistryRunner()(() => spawnWorker(args), { envPath: fixture.selected });
      assert.equal(sink.calls, 1);
      const settings = sink.options!.settings as { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] }; network?: Record<string, unknown> }; permissions: { deny: string[] } };
      for (const target of [fixture.selected, originalPolicy]) {
        assert.ok(settings.sandbox.filesystem.denyRead.includes(target));
        assert.ok(settings.sandbox.filesystem.denyWrite.includes(target));
        assert.ok(settings.permissions.deny.includes(`Read(/${target})`));
      }
      assert.equal(Object.isFrozen(settings.sandbox.filesystem.denyRead), true);
      assert.equal(String(sink.prompt).includes("retargeted"), false, "queued caller mutation cannot replace the captured dispatch");
      assert.equal(JSON.stringify(sink.options!.env).includes(fixture.selected), false, "private file is not an untrusted child environment grant");
      assert.equal(String(sink.prompt).includes(fixture.selected), false);
      if (proxy) assert.equal(typeof settings.sandbox.network!.httpProxyPort, "number", "the real egress replacement retained filesystem denials");
    } finally { fixture.cleanup(); }
  }
});

test("selected Claude SDK final recheck refuses changed missing and replaced policy or registry before query", async () => {
  for (const mode of ["edited", "replaced", "missing", "registry"] as const) {
    const fixture = runtimeRegistryFixture(), sink = { calls: 0 };
    try {
      const args = privateClaudeArgs(fixture, sink);
      args.onMemoryAdmissionEnd = () => {
        if (mode === "registry") writeFileSync(fixture.selected, registry("live"));
        else if (mode === "missing") unlinkSync(args.settingsFile);
        else if (mode === "edited") writeFileSync(args.settingsFile, readFileSync(args.settingsFile, "utf8") + " ");
        else { const replacement = join(fixture.root, "replacement-policy.json"); writeFileSync(replacement, readFileSync(args.settingsFile)); renameSync(replacement, args.settingsFile); }
      };
      await assert.rejects(runtimeRegistryRunner()(() => spawnWorker(args), { envPath: fixture.selected }), /selected instance registry unavailable/);
      assert.equal(sink.calls, 0, "no stale selected permission reaches even the injected SDK boundary");
    } finally { fixture.cleanup(); }
  }
});

test("selected policy real default reader keeps unreadable evidence unknown and diagnostics private", async () => {
  for (const mode of ["invalid-json", "invalid-schema", "invalid-rules", "invalid-entry", "invalid-encoding", "missing", "directory", "empty-input", "glob-path", "symlink", "hardlink", "oversized", "resume"] as const) {
    const fixture = runtimeRegistryFixture(), sink = { calls: 0 };
    try {
      const args = privateClaudeArgs(fixture, sink);
      if (mode === "invalid-json") writeFileSync(args.settingsFile, `{"private":"${fixture.selected}", BAD`);
      if (mode === "invalid-schema") writeFileSync(args.settingsFile, JSON.stringify({ sandbox: { enabled: false }, private: fixture.selected }));
      if (mode === "invalid-rules") { const policy = JSON.parse(readFileSync(args.settingsFile, "utf8")); policy.permissions = { deny: {} }; writeFileSync(args.settingsFile, JSON.stringify(policy)); }
      if (mode === "invalid-entry") { const policy = JSON.parse(readFileSync(args.settingsFile, "utf8")); policy.sandbox.filesystem = { denyRead: [42] }; writeFileSync(args.settingsFile, JSON.stringify(policy)); }
      if (mode === "invalid-encoding") writeFileSync(args.settingsFile, Buffer.from([0xff]));
      if (mode === "missing") unlinkSync(args.settingsFile);
      if (mode === "directory") args.settingsFile = fixture.root;
      if (mode === "empty-input") args.settingsFile = "";
      if (mode === "glob-path") { const path = join(fixture.root, "policy[opaque].json"); renameSync(args.settingsFile, path); args.settingsFile = path; }
      if (mode === "symlink") { unlinkSync(args.settingsFile); symlinkSync(fixture.selected, args.settingsFile); }
      if (mode === "hardlink") linkSync(args.settingsFile, join(fixture.root, "policy-alias.json"));
      if (mode === "oversized") writeFileSync(args.settingsFile, Buffer.alloc(65537));
      if (mode === "resume") args.resumeSessionId = "saved-before-selection";
      await assert.rejects(runtimeRegistryRunner()(() => spawnWorker(args), { envPath: fixture.selected }), error => {
        assert.ok(error instanceof runtimeRegistry.InstanceRegistryRuntimeError);
        assert.equal(error.message.includes(fixture.root), false, "stable diagnostics never quote the selected source or policy bytes");
        return true;
      });
      assert.equal(sink.calls, 0);
    } finally { fixture.cleanup(); }
  }
});

test("selected policy late default reads cannot outlive their original invocation", async t => {
  for (const phase of ["capture", "recheck"] as const) {
    const fixture = runtimeRegistryFixture(), args = privateClaudeArgs(fixture, { calls: 0 });
    const actualOpen = runtimeRegistry.registryFileIO.open.bind(runtimeRegistry.registryFileIO);
    let release!: () => void, entered!: () => void, intercept = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const mocked = t.mock.method(runtimeRegistry.registryFileIO, "open", async (path: string) => {
      if (path === args.settingsFile && intercept) { entered(); await blocked; }
      return actualOpen(path);
    });
    let pending: Promise<unknown> | undefined;
    try {
      await runtimeRegistryRunner()(async () => {
        if (phase === "capture") { intercept = true; pending = runtimeRegistry.captureInstanceRegistryRuntimeFile(args.settingsFile); }
        else { const snapshot = await runtimeRegistry.captureInstanceRegistryRuntimeFile(args.settingsFile); intercept = true; pending = snapshot.recheck(); }
        await started;
      }, { envPath: fixture.selected });
      assert.ok(pending);
      const refused = assert.rejects(pending, /selected instance registry unavailable \(invocation_closed\)/);
      release(); await refused;
    } finally { release(); mocked.mock.restore(); fixture.cleanup(); }
  }
});

test("unconfigured worker policy rendering remains byte identical", () => {
  const fixture = runtimeRegistryFixture();
  try {
    const template = join(REPO_ROOT, "settings", "worker.json"), hooksDir = join(REPO_ROOT, "hooks"), outPath = join(fixture.root, "legacy-settings.json");
    renderWorkerSettings({ templatePath: template, hooksDir, outPath });
    assert.equal(readFileSync(outPath, "utf8"), readFileSync(template, "utf8").split("${HOOKS_DIR}").join(hooksDir));
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
