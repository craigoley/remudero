import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeRuntimeFixture } from "#test/helpers/native-runtime-fixture.js";

const ROOT = join(import.meta.dirname, "..");
const runtime = await import(pathToFileURL(join(ROOT, "scripts/lib/native-author-runtime.mjs")).href);
const { calibrateAuthorRuntime } = await import(pathToFileURL(join(ROOT, "scripts/calibrate-author-runtime.mjs")).href);

test("native timing reuse requires an identical committed input tree and never transfers author assurance", t => {
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const observed = calibrateAuthorRuntime({ root: f.dir });
  const original = readFileSync(observed.path, "utf8"), old = JSON.parse(original);
  f.git("commit", "--allow-empty", "-m", "test: metadata-only runtime successor");
  const current = f.git("rev-parse", "HEAD"); assert.notEqual(current, observed.head);
  const bindings = runtime.runtimeBindings(f.dir, current);
  const reused = runtime.readRuntimeProfile(f.dir, observed.path, bindings);
  assert.equal(reused.bindings.head, observed.head); assert.equal(reused.author, "not-proven");
  assert.equal(reused.assurance, "runtime-sample-only");
  assert.deepEqual(reused.timingCompatibility, { observedHead: observed.head, currentHead: current,
    inputTree: bindings.inputTree, reusedAcrossHeads: true, assurance: "timing-only; never author PASS" });
  assert.equal(readFileSync(observed.path, "utf8"), original, "reuse may not rewrite original observations");
  writeFileSync(observed.path, JSON.stringify({ ...old, author: "passed", assurance: "author-only" }));
  const forged = runtime.readRuntimeProfile(f.dir, observed.path, bindings);
  assert.equal(forged.author, "not-proven"); assert.equal(forged.assurance, "runtime-sample-only");
  writeFileSync(observed.path, original);
  assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, { ...bindings, head: "f".repeat(40) }), /binding mismatch/);
  writeFileSync(observed.path, JSON.stringify({ ...old, bindings: { ...old.bindings, inputTree: "e".repeat(40) } }));
  assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, bindings), /binding mismatch/);
  writeFileSync(observed.path, original);
  writeFileSync(join(f.dir, "src/leaf.ts"), "export const changed = 3;\n");
  assert.throws(() => runtime.runtimeBindings(f.dir, current), /committed inputs changed/);
  f.git("add", "."); f.git("commit", "-m", "test: change a non-test runtime input");
  const changed = runtime.runtimeBindings(f.dir, f.git("rev-parse", "HEAD"));
  assert.equal(changed.corpusSha256, bindings.corpusSha256);
  assert.notEqual(changed.inputTree, bindings.inputTree);
  assert.throws(() => runtime.readRuntimeProfile(f.dir, observed.path, changed), /binding mismatch/);
});
