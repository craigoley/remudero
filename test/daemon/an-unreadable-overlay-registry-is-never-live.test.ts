import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { instanceMode, readInstanceRegistryText, type OverlayPointerIO } from "#src/lib/instance-mode.js";
import { readFileIfExists } from "#src/lib/fs-race-safe.js";
import { InstanceRegistryRuntimeError, withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-overlay-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, ".remudero");
  mkdirSync(state);
  return { root, pointer: join(state, "overlay-home.json") };
}

const ownerRepo = "owner/instance";
const registryPath = ".remudero/daemon-instances.yaml";
const registry = "instances:\n  fixture:\n    github_repo: owner/instance\n    mode: shadow\n";
const pointer = (paths: string[]) => JSON.stringify({ repo: "owner/home", paths });

test("W1-T13763 criterion 1: an unreadable overlay registry refuses mode resolution", (t) => {
  const { root, pointer: pointerPath } = fixture(t);
  writeFileSync(pointerPath, pointer([registryPath]));

  assert.throws(
    () => instanceMode(ownerRepo, readInstanceRegistryText(root)),
    new InstanceRegistryRuntimeError("overlay_registry_unreadable"),
  );
});

test("W1-T13763 criterion 2: a missing registry without a pointer still resolves live", (t) => {
  const { root } = fixture(t);
  const text = readInstanceRegistryText(root);
  assert.equal(text, undefined);
  assert.equal(instanceMode(ownerRepo, text), "live");

  const stateDir = join(root, ".remudero");
  rmSync(stateDir, { recursive: true });
  writeFileSync(stateDir, "");
  assert.equal(instanceMode(ownerRepo, readInstanceRegistryText(root)), "live");
});

/** An errno error as node:fs throws it, so the reader's code check sees what a real denial carries. */
function denied(code: "EACCES" | "EPERM", path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: permission denied, open '${path}'`), { code });
}

/** The real reads, with the pointer read (and, when `searchDenied`, its stat) replaced by a staged denial. Uid-independent. */
function deniedPointerIO(code: "EACCES" | "EPERM", searchDenied: boolean): OverlayPointerIO {
  return {
    readIfExists: (path) => { throw denied(code, path); },
    lstat: (path) => { if (searchDenied) throw denied(code, path); return lstatSync(path); },
  };
}

for (const code of ["EACCES", "EPERM"] as const) {
  test(`W1-T13763 criterion 2: a denied search of .remudero with no pointer still resolves live (${code})`, (t) => {
    const { root } = fixture(t);
    const text = readInstanceRegistryText(root, deniedPointerIO(code, true));
    assert.equal(text, undefined);
    assert.equal(instanceMode(ownerRepo, text), "live");
  });

  test(`an unreadable pointer file that is present still refuses even though its directory is searchable (${code})`, (t) => {
    const { root, pointer: pointerPath } = fixture(t);
    writeFileSync(pointerPath, pointer([registryPath]));
    assert.throws(() => readInstanceRegistryText(root, deniedPointerIO(code, false)),
      new InstanceRegistryRuntimeError("overlay_pointer_unreadable"));
  });
}

test("the real pointer reads are the default seam", (t) => {
  const { root, pointer: pointerPath } = fixture(t);
  writeFileSync(pointerPath, pointer([registryPath]));
  const real: OverlayPointerIO = { readIfExists: readFileIfExists, lstat: lstatSync };
  assert.throws(() => readInstanceRegistryText(root, real), new InstanceRegistryRuntimeError("overlay_registry_unreadable"));
  assert.throws(() => readInstanceRegistryText(root), new InstanceRegistryRuntimeError("overlay_registry_unreadable"));
});

test("a pointer for other files leaves the missing registry on the legacy path", (t) => {
  const { root, pointer: pointerPath } = fixture(t);
  writeFileSync(pointerPath, pointer([".remudero/managed-repos.json"]));
  assert.equal(instanceMode(ownerRepo, readInstanceRegistryText(root)), "live");
});

test("a readable core registry remains in use before the overlay cutover", (t) => {
  const { root, pointer: pointerPath } = fixture(t);
  writeFileSync(pointerPath, pointer([registryPath]));
  writeFileSync(join(root, registryPath), registry);
  assert.equal(instanceMode(ownerRepo, readInstanceRegistryText(root)), "shadow");
});

test("a readable selected registry resolves mode with the core registry absent", async (t) => {
  const { root, pointer: pointerPath } = fixture(t);
  writeFileSync(pointerPath, pointer([registryPath]));
  const selectedPath = join(root, "selected.yaml");
  writeFileSync(selectedPath, registry);
  await withInstanceRegistryRuntime(() => {
    assert.equal(instanceMode(ownerRepo, readInstanceRegistryText(root)), "shadow");
  }, { cliPath: selectedPath, instanceName: "fixture" });
});

test("an unreadable or invalid pointer cannot restore the missing-registry live default", (t) => {
  const { root, pointer: pointerPath } = fixture(t);
  mkdirSync(pointerPath);
  const refusal = new InstanceRegistryRuntimeError("overlay_pointer_unreadable");
  assert.throws(() => readInstanceRegistryText(root), refusal);
  rmSync(pointerPath, { recursive: true });

  for (const invalid of ["{", "null", "[]", "{}", pointer(["../daemon-instances.yaml"])]) {
    writeFileSync(pointerPath, invalid);
    assert.throws(() => readInstanceRegistryText(root), refusal);
  }
});
