import assert from "node:assert/strict";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { instanceMode, readInstanceRegistryText } from "#src/lib/instance-mode.js";
import {
  assertInstanceRegistryRuntimeCurrent,
  assertInstanceRegistryWorkerEnvironment,
  runtimeInstanceRegistryPrivateFile,
  withInstanceRegistryRuntime,
  type RegistryFileIO,
} from "#src/lib/instance-registry-selection.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { daemonSreLaneInput, resolveSreLaneInstance, sreLaneStartRow } from "#src/lib/sre-lane.js";
import { daemonSreLaneEnabled, startBoundedDaemonSreLane } from "#src/cli/commands/daemon.js";

function fixture(t: TestContext) {
  const root = realpathSync(makeTempDir("selected-registry-contract"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = ["RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY", "RMD_INSTANCE_NAME",
    "RMD_INSTANCE_REGISTRY_DIGEST", "RMD_INSTANCE_REGISTRY_FILE_BINDING", "RMD_SRE_LANE"];
  const previous = keys.map(key => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const key of keys) delete process.env[key];
  const registry = (mode: string) => `instances:\n  fixture:\n    github_repo: owner/repo\n    mode: ${mode}\n`;
  const catalog = join(root, "catalog.yaml"), selected = join(root, "selected.yaml");
  const legacyText = registry("live"), selectedText = registry("shadow");
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero/daemon-instances.yaml"), legacyText);
  writeFileSync(catalog, legacyText);
  writeFileSync(selected, selectedText);
  return { root, catalog, selected, legacyText, selectedText };
}

test("explicit selection overrides a distinct legacy catalog in the default runtime", async t => {
  const f = fixture(t);
  await withInstanceRegistryRuntime(() => {
    assert.equal(runtimeInstanceRegistryPrivateFile(), undefined);
    assert.equal(readInstanceRegistryText(f.root), f.legacyText);
    assert.equal(instanceMode("owner/repo", readInstanceRegistryText(f.root)), "live");
  });
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  process.env.RMD_SELECTED_INSTANCE_REGISTRY = f.selected;
  await withInstanceRegistryRuntime(async () => {
    assert.equal(runtimeInstanceRegistryPrivateFile(), f.selected);
    assert.equal(readInstanceRegistryText(f.root), f.selectedText);
    assert.equal(instanceMode("owner/repo", readInstanceRegistryText(f.root)), "shadow");
    await assertInstanceRegistryRuntimeCurrent();
    writeFileSync(f.selected, `${f.selectedText}# revised after selection\n`);
    await assert.rejects(() => assertInstanceRegistryRuntimeCurrent(), /digest_mismatch/);
  });
  assert.equal(runtimeInstanceRegistryPrivateFile(), undefined, "selection is scoped to the invocation");
  assert.equal(process.env.RMD_INSTANCE_REGISTRY, f.catalog, "selection preserves the legacy catalog variable");
  delete process.env.RMD_SELECTED_INSTANCE_REGISTRY;
  await withInstanceRegistryRuntime(() => {
    assert.equal(runtimeInstanceRegistryPrivateFile(), f.catalog, "old launchers retain their selection alias");
    assert.equal(instanceMode("owner/repo", readInstanceRegistryText(f.root)), "live");
  });
});

test("invalid explicit selection cannot fall back to a healthy legacy catalog", async t => {
  const f = fixture(t);
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  let operations = 0;
  await withInstanceRegistryRuntime(() => { operations++; });
  assert.equal(operations, 1, "the healthy old-name alias can reach the operation");
  const malformed = join(f.root, "malformed.yaml"), unsupported = join(f.root, "unsupported.yaml");
  writeFileSync(malformed, "instances: [\n");
  writeFileSync(unsupported, `${f.selectedText}    unsupported_field: true\n`);
  const cases = [
    ["", "invalid_path"], ["relative.yaml", "invalid_path"],
    [join(f.root, "missing.yaml"), "missing"], [f.root, "not_regular"],
    [malformed, "malformed"], [unsupported, "unsupported_field"],
  ];
  for (const [path, reason] of cases) {
    process.env.RMD_SELECTED_INSTANCE_REGISTRY = path;
    await assert.rejects(() => withInstanceRegistryRuntime(() => { operations++; }),
      new RegExp(`selected instance registry unavailable \\(${reason}\\)`));
    assert.equal(operations, 1, `selection ${reason} must refuse before the operation`);
  }
});

test("the explicit selection transport name cannot enter worker overrides", async t => {
  const f = fixture(t);
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  process.env.RMD_SELECTED_INSTANCE_REGISTRY = f.selected;
  await withInstanceRegistryRuntime(() => {
    assert.doesNotThrow(() => assertInstanceRegistryWorkerEnvironment({ PUBLIC_FIXTURE: "allowed" }));
    for (const value of ["", "public-looking-value", f.selected]) {
      assert.throws(() => assertInstanceRegistryWorkerEnvironment({ RMD_SELECTED_INSTANCE_REGISTRY: value }),
        /worker_environment_private_source/);
    }
    assert.throws(() => assertInstanceRegistryWorkerEnvironment({ PUBLIC_FIXTURE: f.selected }),
      /worker_environment_private_source/, "the selected path is also private under a public name");
  });
});

test("selected SRE readers use the qualified bounded port and reject revised bytes and private read errors", async t => {
  const f = fixture(t);
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  process.env.RMD_SELECTED_INSTANCE_REGISTRY = f.selected;
  const original = `${f.selectedText}    primary: true\n    state_dir: ${f.root}\n`;
  let bytes = Buffer.from(original), failRead = false, reads = 0;
  const stamp = () => ({ regular: true, size: bytes.length, dev: 1, ino: 2,
    mtimeMs: 3, ctimeMs: 4, nlink: 1 });
  const io: RegistryFileIO = {
    canonicalPath: async path => path,
    lstat: async () => stamp(),
    open: async () => ({
      stat: async () => stamp(), close: async () => {},
      read: async (buffer, offset, length, position) => {
        reads++;
        if (failRead) throw new Error(`private read failed: ${f.selected}`);
        return bytes.copy(buffer, offset, position, position + length);
      },
    }),
  };
  const input = { root: f.root, stateDir: join(f.root, "state"), ledgerPath: join(f.root, "ledger.ndjson"),
    owner: "owner", repo: "repo", mergedLastDay: () => 0, log: () => {} };
  await withInstanceRegistryRuntime(async () => {
    const before = reads;
    const instance = await resolveSreLaneInstance({ stateRoot: f.root, registryPath: f.catalog,
      readText: () => { throw new Error("selected SRE must never enter the independent legacy reader"); },
      env: { RMD_INSTANCE_NAME: "untrusted-other-instance" } });
    assert.deepEqual(instance, { resolved: true, resolvedBy: "env", name: "fixture", live: true, primary: true });
    assert.ok(reads > before, "SRE must recheck through the original bounded runtime IO");
    assert.equal(sreLaneStartRow({ instance, env: {} }).step, "sre_lane.started");
    const starts: unknown[] = [];
    assert.equal(await daemonSreLaneEnabled(f.root, f.root, (step, fields) => starts.push({ step, fields })), true);
    assert.deepEqual([...starts], [{ step: "sre_lane.started", fields: { instance: "fixture", enabled_by: "primary", resolved_by: "env" } }]);
    const lane = await daemonSreLaneInput(input);
    assert.equal(lane.root, f.root);
    bytes = Buffer.from(original.replace("primary: true", "primary: false"));
    for (const read of [
      () => resolveSreLaneInstance({ stateRoot: f.root, registryPath: f.selected }),
      () => daemonSreLaneInput(input),
    ]) {
      await assert.rejects(read, /selected instance registry unavailable \(digest_mismatch\)/,
        "a revised primary must not change the lane decision or fall back to the catalog");
    }
    bytes = Buffer.from(original);
    failRead = true;
    await assert.rejects(() => daemonSreLaneEnabled(f.root, f.root, (step, fields) => starts.push({ step, fields })), /read_failed/);
    assert.equal(starts.length, 1, "a failed selected read cannot produce a successful or path-bearing start row");
    await assert.rejects(() => daemonSreLaneInput(input), error => {
      assert.equal((error as Error).message, "selected instance registry unavailable (read_failed)");
      assert.ok(!JSON.stringify(error).includes(f.root));
      return true;
    });
    const rows: { step: string; fields?: Record<string, unknown> }[] = [];
    const starter = startBoundedDaemonSreLane(() => daemonSreLaneInput(input), async () => 1,
      (step, fields) => { rows.push({ step, fields }); })(60_000);
    try { await starter.settled(); } finally { starter.stop(); }
    assert.deepEqual(rows, [{ step: "sre_lane.failed", fields: { error: "selected instance registry unavailable (read_failed)" } }]);
    assert.ok(!JSON.stringify(rows).includes(f.root), "the daemon's actual failed-pass logger receives no private file details");
  }, { envPath: f.selected, instanceName: "fixture" }, io);
});

test("selected SRE defaults retain host matching and recheck each daemon pass before the pause switch", async t => {
  const f = fixture(t);
  const original = `${f.selectedText}    primary: true\n    state_dir: ${f.root}\n`;
  writeFileSync(f.selected, original);
  mkdirSync(join(f.root, "state"));
  writeFileSync(join(f.root, "state", "SRE_LANE_OFF"), "owner pause\n");
  const input = { root: f.root, stateDir: join(f.root, "state"), ledgerPath: join(f.root, "ledger.ndjson"),
    owner: "owner", repo: "repo", mergedLastDay: () => 0, log: () => {} };
  await withInstanceRegistryRuntime(async () => {
    const instance = await resolveSreLaneInstance({ stateRoot: f.root, registryPath: f.catalog });
    assert.deepEqual(instance, { resolved: true, resolvedBy: "state_root", name: "fixture", live: true, primary: true });
    await assert.rejects(() => resolveSreLaneInstance({ stateRoot: join(f.root, "wrong"), registryPath: f.catalog }),
      /target_missing_or_mismatched/);
    let inputs = 0;
    const rows: unknown[] = [];
    const start = () => startBoundedDaemonSreLane(async rate => {
      const lane = await daemonSreLaneInput({ ...input, mergedLastDay: () => rate });
      inputs++;
      assert.equal(lane.mergedLastDay(), 2);
      return lane;
    }, async () => 2, (step, fields) => rows.push({ step, fields }))(60_000);
    let starter = start();
    try { await starter.settled(); } finally { starter.stop(); }
    assert.equal(inputs, 1, "the real pass receives the awaited, qualified input");
    assert.deepEqual(rows, [], "the owner pause still suppresses the actual pass");
    writeFileSync(f.selected, original.replace("primary: true", "primary: false"));
    starter = start();
    try { await starter.settled(); } finally { starter.stop(); }
    assert.equal(inputs, 1, "revised evidence cannot build another lane input");
    assert.deepEqual(rows, [{ step: "sre_lane.failed", fields: { error: "selected instance registry unavailable (digest_mismatch)" } }]);
  }, { envPath: f.selected });
  process.env.RMD_SELECTED_INSTANCE_REGISTRY = f.selected;
  await assert.rejects(() => resolveSreLaneInstance({ stateRoot: f.root, registryPath: f.catalog }), /selection_missing/);
});

test("daemon SRE selection covers legacy absence old-name selection and explicit non-primary selection", async t => {
  const f = fixture(t);
  const primary = `${f.selectedText}    primary: true\n    state_dir: ${f.root}\n`;
  writeFileSync(join(f.root, ".remudero/daemon-instances.yaml"), primary);
  const rows: unknown[] = [], log = (step: string, fields?: Record<string, unknown>) => rows.push({ step, fields });
  assert.equal(await daemonSreLaneEnabled(f.root, f.root, log), true, "absent selection uses the real legacy default reader");
  writeFileSync(f.catalog, primary);
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  await withInstanceRegistryRuntime(async () => {
    assert.equal(await daemonSreLaneEnabled(f.root, f.root, log), true, "the old-name selection alias still works");
  });
  writeFileSync(f.selected, primary.replace("primary: true", "primary: false"));
  process.env.RMD_SELECTED_INSTANCE_REGISTRY = f.selected;
  await withInstanceRegistryRuntime(async () => {
    assert.equal(await daemonSreLaneEnabled(f.root, f.root, log), false, "the explicit selection decides independently of the primary legacy catalog");
    assert.deepEqual(rows.at(-1), { step: "sre_lane.disabled", fields: { instance: "fixture", resolved_by: "state_root",
      reason: "instance 'fixture' is not the registry's primary instance" } });
    process.env.RMD_SRE_LANE = "1";
    assert.equal(await daemonSreLaneEnabled(f.root, f.root, log), true);
    process.env.RMD_SRE_LANE = "0";
    assert.equal(await daemonSreLaneEnabled(f.root, f.root, log), false, "the explicit off still wins");
    const replacement = join(f.root, "replacement.yaml");
    writeFileSync(replacement, primary.replace("primary: true", "primary: false"));
    renameSync(replacement, f.selected);
    await assert.rejects(() => daemonSreLaneEnabled(f.root, f.root, log), /revision_changed/,
      "even identical selected bytes at a replacement inode are revised input");
  });
  assert.ok(!JSON.stringify(rows).includes(f.root));
});
