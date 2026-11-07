import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { instanceMode, readInstanceRegistryText } from "#src/lib/instance-mode.js";
import {
  assertInstanceRegistryRuntimeCurrent,
  assertInstanceRegistryWorkerEnvironment,
  runtimeInstanceRegistryPrivateFile,
  withInstanceRegistryRuntime,
} from "#src/lib/instance-registry-selection.js";
import { makeTempDir } from "#src/lib/tmp.js";

function fixture(t: TestContext) {
  const root = realpathSync(makeTempDir("selected-registry-contract"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = ["RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY", "RMD_INSTANCE_NAME",
    "RMD_INSTANCE_REGISTRY_DIGEST", "RMD_INSTANCE_REGISTRY_FILE_BINDING"];
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
