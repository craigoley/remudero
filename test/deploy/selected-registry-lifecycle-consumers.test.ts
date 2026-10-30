import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonInstanceRegistryPath, realDeployDeps, type RealDeployOpts } from "#src/lib/deployer.js";
import { resolvePauseTarget } from "#src/lib/pause-target.js";
import { daemonSreLaneInput } from "#src/lib/sre-lane.js";
import { realServePolicyDeps } from "#src/lib/serve-policy-convergence.js";
import { createSelectedRegistryObserver, observeSelectedRegistry, withSelectedRegistryContext,
  type RegistryConsumerAction } from "#src/lib/selected-registry-consumers.js";
import { readSelectedInstanceRegistry } from "#src/lib/instance-registry-selection.js";
import { makeTempDir } from "#src/lib/tmp.js";

function fixture(t: TestContext) {
  const root = makeTempDir("selected-lifecycle");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(root, "owner"), otherRoot = join(root, "other");
  for (const path of [stateRoot, otherRoot]) mkdirSync(join(path, "state"), { recursive: true });
  const registry = daemonInstanceRegistryPath(root), selected = join(root, "selected.yaml");
  mkdirSync(dirname(registry), { recursive: true });
  const text = (retired = false, state = stateRoot) => `instances:\n  owner:\n    github_repo: fixture/owner\n    primary: true\n    state_dir: ${state}\n    container_name: owner-container\n${retired ? "    retired: true\n" : ""}  other:\n    github_repo: fixture/other\n    state_dir: ${otherRoot}\n`;
  writeFileSync(registry, text()); writeFileSync(selected, text());
  const rows: Record<string, unknown>[] = [], effects: string[][] = [];
  const options = { settings: { mode: "shadow" as const, registryPath: selected },
    record: (_step: string, fields: Readonly<Record<string, unknown>>) => { rows.push({ ...fields }); } };
  const observer = createSelectedRegistryObserver(options)!;
  t.after(() => observer.close());
  const opts: RealDeployOpts = { installPath: root, stateRoot, daemonLabel: "owner", serveLabel: "serve", servePort: 1,
    uid: 1, ledgerPath: join(stateRoot, "state", "ledger.ndjson"), log: () => {},
    execFile: (cmd, args) => { effects.push([cmd, ...args]); return ""; } };
  return { root, stateRoot, otherRoot, registry, selected, text, rows, effects, options, observer, opts };
}

test("selected lifecycle shadow reaches actual deploy pause and daemon consumers", async t => {
  const f = fixture(t);
  const saved = { RMD_INSTANCE_REGISTRY: process.env.RMD_INSTANCE_REGISTRY, RMD_INSTANCE_NAME: process.env.RMD_INSTANCE_NAME };
  process.env.RMD_INSTANCE_REGISTRY = f.registry; process.env.RMD_INSTANCE_NAME = "owner";
  t.after(() => { for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  await withSelectedRegistryContext(f.observer, async () => {
    const deps = realDeployDeps(f.opts);
    deps.kickstart();
    deps.restartBackends!()[1]!.restart();
    assert.equal(resolvePauseTarget({ configRoot: f.stateRoot, registryText: f.text(), registryPath: f.registry }).ok, true);
    const lane = daemonSreLaneInput({ root: f.root, stateDir: join(f.stateRoot, "state"),
      ledgerPath: f.opts.ledgerPath, owner: "fixture", repo: "owner", mergedLastDay: () => 0, log: () => {} });
    assert.equal(lane.stateDir, join(f.stateRoot, "state"));
    const serve = realServePolicyDeps(f.opts, (cmd, args) => { f.effects.push([cmd, ...args]); return ""; });
    serve.replaceServe!();
    await f.observer.settled();
    for (const action of ["deploy-restart", "deploy-recycle", "pause-target", "sre-target", "serve-policy-replace"]) {
      const row = f.rows.find(row => row.action === action);
      assert.ok(row, `real ${action} seam must forward the invocation observer`);
      assert.equal(row.selected_state, "unknown");
      assert.equal(row.reason, "synchronous_seam");
      assert.equal(row.publication_permission, "not-granted");
    }
  });
  assert.ok(f.effects.some(args => args.includes("--instance") && args.includes("owner")));
  const home = join(f.root, "cli-home"), configDir = join(home, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ root: f.stateRoot, claudeBin: "/bin/true",
    selectedRegistryMode: f.options.settings }));
  const savedHome = process.env.HOME, savedArgv = process.argv;
  process.env.HOME = home;
  const exit = new Error("fixture CLI exit");
  const exitMock = t.mock.method(process, "exit", ((code: number) => { assert.equal(code, 0); throw exit; }) as never);
  try {
    const { main, daemonCommand } = await import("#src/run-task.js");
    for (const verb of ["pause", "resume"]) {
      process.argv = [process.execPath, "run-task.js", verb];
      await assert.rejects(main({ checkFreshness: () => ({ status: "guarded" }) }), error => error === exit);
    }
    const plan = join(f.root, "tasks.yaml");
    writeFileSync(plan, "[]\n");
    process.argv = [process.execPath, "run-task.js", "daemon", "--allow-self-target", "--plan", plan, "--max", "0"];
    await assert.rejects(main({ checkServiceFreshness: () => ({ status: "guarded" }),
      dispatch: async (_verb, rest) => daemonCommand(rest, {
        gardenPassSpawn: async () => 0,
        runDaemon: async () => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }),
      }),
    }), error => error === exit);
    const receipts = readFileSync(f.opts.ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const action of ["pause", "resume", "sre-target"]) {
      assert.ok(receipts.some(row => row.action === action && row.target_instance === "owner"
        && row.selected_state === "unknown" && row.publication_permission === "not-granted"));
    }
  } finally {
    exitMock.mock.restore(); process.argv = savedArgv;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
});

test("selected lifecycle effects observe current immutable instance targets", async t => {
  const f = fixture(t), action = "deploy-recycle" as RegistryConsumerAction;
  const bound = await readSelectedInstanceRegistry({ cliPath: f.selected });
  assert.equal(bound.kind, "ready");
  if (bound.kind !== "ready") assert.fail("positive registry control");
  const observer = createSelectedRegistryObserver(f.options, async () => bound)!;
  t.after(() => observer.close());
  const target = { instanceName: "owner", repository: "fixture/owner", stateRoot: f.stateRoot, namespace: "host" as const,
    containerName: "owner-container" };
  await observeSelectedRegistry(observer, action, target, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.selected_state, "ready");
  const unavailable = createSelectedRegistryObserver(f.options, async () => ({ ...bound,
    binding: { ...bound.binding, matchesLifecycleTarget: undefined } }))!;
  t.after(() => unavailable.close());
  await observeSelectedRegistry(unavailable, action, target, () => "legacy");
  await unavailable.settled();
  assert.equal(f.rows.at(-1)?.reason, "lifecycle_binding_unavailable");
  await observeSelectedRegistry(observer, action, { ...target, stateRoot: f.otherRoot }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.reason, "state_root_unverified");
  await observeSelectedRegistry(observer, action, { ...target, containerName: "other-container" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.reason, "state_root_unverified");
  await observeSelectedRegistry(observer, action, { ...target, namespace: "container" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.reason, "namespace_unverified");
  await observeSelectedRegistry(observer, action, { instanceName: "owner" }, () => "legacy");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.reason, "target_unavailable");
  let admit!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const effect = observeSelectedRegistry(observer, action, target, async () => {
    await admitted;
    writeFileSync(f.selected, f.text(false, f.otherRoot));
    return "unchanged legacy result";
  });
  target.instanceName = "other"; target.stateRoot = f.otherRoot;
  admit();
  assert.equal(await effect, "unchanged legacy result");
  await observer.settled();
  assert.equal(f.rows.at(-1)?.target_instance, "owner");
  assert.equal(f.rows.at(-1)?.selected_state, "unknown");
  assert.equal(f.rows.at(-1)?.reason, "revision_changed");
  assert.ok(!JSON.stringify(f.rows).includes(f.root), "receipts must not publish operational paths");
});

test("selected lifecycle unknown preserves owner holds and legacy effects", async t => {
  const f = fixture(t);
  for (const flag of ["PAUSE", "STOP"]) writeFileSync(join(f.stateRoot, "state", flag), "owner hold");
  rmSync(f.selected);
  const legacy = realDeployDeps(f.opts);
  legacy.restartBackends!()[1]!.restart();
  const expected = [...f.effects]; f.effects.length = 0;
  await withSelectedRegistryContext(f.observer, async () => {
    realDeployDeps(f.opts).restartBackends!()[1]!.restart();
  });
  assert.deepEqual(f.effects, expected);
  assert.equal(f.rows.at(-1)?.selected_state, "unknown");
  for (const flag of ["PAUSE", "STOP"]) assert.equal(readFileSync(join(f.stateRoot, "state", flag), "utf8"), "owner hold");
  assert.equal(readFileSync(f.registry, "utf8"), f.text());
});

test("selected lifecycle recovery never retargets or promotes unknown evidence", async t => {
  const f = fixture(t);
  await withSelectedRegistryContext(f.observer, async () => {
    const deps = realDeployDeps(f.opts), backend = deps.restartBackends!()[1]!;
    const serve = realServePolicyDeps(f.opts, (cmd, args) => { f.effects.push([cmd, ...args]); return ""; });
    f.opts.stateRoot = f.otherRoot; f.opts.instance = "other";
    f.opts.installPath = f.otherRoot; f.opts.daemonLabel = "other";
    writeFileSync(f.registry, f.text(false, f.otherRoot));
    backend.restart();
    deps.resetHard("last-good");
    backend.restart();
    deps.kickstart();
    serve.replaceServe!();
    const restarts = f.effects.filter(args => args[0] === "bash");
    assert.equal(restarts.length, 2);
    for (const args of restarts) assert.deepEqual(args.slice(1), [join(f.root, "deploy", "recycle-container.sh"), "--instance", "owner"]);
    assert.ok(f.effects.some(args => args.includes("last-good")));
    assert.ok(f.effects.some(args => args[0] === "git" && args[2] === f.root && args.includes("last-good")));
    assert.ok(f.effects.some(args => args.includes("gui/1/owner")));
    assert.ok(f.effects.some(args => args.includes(`RMD_STATE_DIR=${f.stateRoot}`)));
    assert.ok(f.effects.every(args => !args.includes(f.otherRoot)), "recovery effects must retain the original roots");
    assert.ok(f.rows.some(row => row.action === "deploy-rollback"));
    assert.ok(f.rows.every(row => row.selected_state === "unknown"));
  });
  rmSync(f.selected);
  const observer = createSelectedRegistryObserver(f.options)!;
  t.after(() => observer.close());
  const target = { instanceName: "owner", stateRoot: f.stateRoot, namespace: "host" as const };
  const action = "deploy-rollback" as RegistryConsumerAction;
  await observeSelectedRegistry(observer, action, target, () => "original failure");
  await observer.settled();
  const failure = { ...f.rows.at(-1) };
  writeFileSync(f.selected, f.text());
  await observeSelectedRegistry(observer, action, target, () => "legacy recovery");
  await observer.settled();
  assert.deepEqual(f.rows.at(-1), failure, "a recovered source cannot promote the original unknown binding");
  assert.equal(failure.selected_state, "unknown");
  writeFileSync(f.selected, f.text(true));
  const retired = createSelectedRegistryObserver(f.options)!;
  t.after(() => retired.close());
  await observeSelectedRegistry(retired, action, target, () => "legacy recovery");
  await retired.settled();
  assert.equal(f.rows.at(-1)?.selected_state, "retired");
  assert.equal(f.rows.at(-1)?.reason, "target_retired");
  writeFileSync(f.selected, f.text());
  const pinned = await readSelectedInstanceRegistry({ cliPath: f.selected });
  const recovery = createSelectedRegistryObserver(f.options, async () => pinned)!;
  t.after(() => recovery.close());
  await observeSelectedRegistry(recovery, action, target, () => "legacy");
  await recovery.settled();
  assert.equal(f.rows.at(-1)?.selected_state, "ready");
  writeFileSync(f.selected, f.text(false, f.otherRoot));
  await observeSelectedRegistry(recovery, action, target, () => "failed attempt");
  await recovery.settled();
  assert.equal(f.rows.at(-1)?.reason, "revision_changed");
  writeFileSync(f.selected, f.text());
  await observeSelectedRegistry(recovery, "deploy-recycle" as RegistryConsumerAction, target, () => "legacy recovery");
  await recovery.settled();
  assert.equal(f.rows.at(-1)?.selected_state, "unknown", "restoring bytes cannot promote invalidated recovery evidence");
  await observeSelectedRegistry(recovery, action, { instanceName: "other", stateRoot: f.otherRoot, namespace: "host" }, () => "control");
  await recovery.settled();
  assert.equal(f.rows.at(-1)?.selected_state, "ready", "a failed target does not poison an unrelated unchanged instance");
  assert.equal(pinned.kind, "ready");
  if (pinned.kind !== "ready") assert.fail("positive registry control");
  let throws = true;
  const caught = createSelectedRegistryObserver(f.options, async () => ({ ...pinned, binding: { ...pinned.binding,
    matchesLifecycleTarget: () => { if (throws) throw new Error("private binding failure"); return true; },
  } }))!;
  t.after(() => caught.close());
  await observeSelectedRegistry(caught, action, target, () => "legacy");
  await caught.settled();
  assert.equal(f.rows.at(-1)?.reason, "observation_failed");
  throws = false;
  await observeSelectedRegistry(caught, "deploy-recycle" as RegistryConsumerAction, target, () => "legacy");
  await caught.settled();
  assert.equal(f.rows.at(-1)?.reason, "observation_failed", "a caught failure cannot silently become ready");
});

test("selected lifecycle defaults stay bounded with forbidden live effects", async t => {
  const f = fixture(t);
  const noConfig = createSelectedRegistryObserver({ settings: undefined,
    get input(): never { throw new Error("legacy must not inspect selected input"); }, record: () => assert.fail("legacy receipt") });
  assert.equal(noConfig, undefined);
  const original = new Error("recorded child failure");
  await withSelectedRegistryContext(f.observer, async () => {
    const deps = realDeployDeps({ ...f.opts, execFile: () => { throw original; } });
    assert.throws(() => deps.kickstart(), error => error === original);
  });
  assert.equal(f.rows.at(-1)?.legacy_outcome, "threw");
  const output = execFileSync(process.execPath, ["-p", "'disposable child'"], { encoding: "utf8" });
  assert.equal(output.trim(), "disposable child");
  const defaults = realDeployDeps({ ...f.opts, execFile: undefined });
  assert.throws(() => defaults.installHead(), /not a git repository/,
    "the production default child transport really runs against a disposable non-repository");
  const target = { instanceName: "owner", stateRoot: f.stateRoot, namespace: "host" as const };
  const action = "deploy-recycle" as RegistryConsumerAction;
  for (const input of [{ cliPath: "" }, { cliPath: "relative" }, { maxBytes: 1 }, { requiredCapabilities: ["unsupported"] }]) {
    const observer = createSelectedRegistryObserver({ ...f.options, input })!;
    t.after(() => observer.close());
    assert.equal(await observeSelectedRegistry(observer, action, target, () => "legacy"), "legacy");
    await observer.settled();
    assert.equal(f.rows.at(-1)?.selected_state, "unknown");
  }
  const waiting = new Promise<never>(() => {});
  const timed = createSelectedRegistryObserver({ ...f.options, settings: { ...f.options.settings, timeoutMs: 1 },
    io: { lstat: () => waiting, open: () => assert.fail("timeout must not open anything") } })!;
  t.after(() => timed.close());
  assert.equal(await observeSelectedRegistry(timed, action, target, () => "legacy"), "legacy");
  await timed.settled();
  assert.equal(f.rows.at(-1)?.reason, "timeout");
  for (const invalid of [{ stateRoot: "" }, { stateRoot: 7 as never }, { containerName: "bad/name" }, { namespace: "other" as never }]) {
    const observer = createSelectedRegistryObserver(f.options)!;
    t.after(() => observer.close());
    await observeSelectedRegistry(observer, action, { ...target, ...invalid }, () => "legacy");
    await observer.settled();
    assert.equal(f.rows.at(-1)?.selected_state, "unknown");
  }
  const diagnostics: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
  for (const record of [() => { throw original; }, () => Promise.reject(original)]) {
    const observer = createSelectedRegistryObserver({ ...f.options, record })!;
    t.after(() => observer.close());
    assert.equal(await observeSelectedRegistry(observer, action, target, () => "legacy"), "legacy");
    await observer.settled();
  }
  assert.ok(diagnostics.length >= 2, "throwing and rejecting sinks remain visible diagnostics");
  const bounded = createSelectedRegistryObserver(f.options)!;
  t.after(() => bounded.close());
  for (let n = 0; n < 33; n++) {
    assert.equal(await observeSelectedRegistry(bounded, action, { ...target, stateRoot: join(f.root, `missing-${n}`) }, () => n), n);
    await bounded.settled();
  }
  assert.equal(f.rows.at(-1)?.reason, "observation_capacity");
  assert.deepEqual(f.effects, [], "qualification never invokes the live deployment transport");
});
