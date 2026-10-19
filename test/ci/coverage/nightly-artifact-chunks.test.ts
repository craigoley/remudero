/** @source-text-subject: executes the compact/package block in .github/workflows/coverage-nightly.yml. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const ROOT = repoRoot();
type Workflow = { jobs: Record<string, { steps: Array<{ run?: string }> }> };
const workflow = parseYaml(readFileSync(join(ROOT, ".github/workflows/coverage-nightly.yml"), "utf8")) as Workflow;
const compactStep = Object.values(workflow.jobs).flatMap(job => job.steps).find(step =>
  step.run?.includes("--compact-output coverage/compact"))?.run;
assert.ok(compactStep, "the actual nightly compact-and-package step must exist");
const packagingStart = compactStep.indexOf("cp coverage/lcov.info ");
assert.ok(packagingStart >= 0, "the package suffix must follow the actual compactor");
const packaging = compactStep.slice(packagingStart);

// Test-only safety bound for our own closed synthetic-corpus subprocess, never a production timeout.
const CHILD_BOUND_MS = 30_000;
const environment = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});
function shell(root: string, source: string) {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", source], {
    cwd: root, env: environment(), encoding: "utf8", timeout: CHILD_BOUND_MS,
  });
}
function layout(root: string) {
  for (const relative of ["coverage/raw", "coverage/compact", "coverage-artifact/raw"]) {
    mkdirSync(join(root, relative), { recursive: true });
  }
  writeFileSync(join(root, "coverage/lcov.info"), "TN:transport-fixture\n");
}
function merge(root: string) {
  return spawnSync(process.execPath, ["--expose-internals", join(ROOT, "scripts/coverage-merge-ratchet.mjs"),
    "--output", "coverage/transport-merged.info", "coverage-artifact/raw"], {
    cwd: root, env: environment(), encoding: "utf8", timeout: CHILD_BOUND_MS,
  });
}

test("the nightly artifact carries real gzip coverage chunks through its unchanged strict merger", t => {
  const { dir } = ownedFixtureDir(t, "nightly-real-chunk-transport");
  layout(dir);
  symlinkSync(join(ROOT, "scripts"), join(dir, "scripts"), "dir");
  copyFileSync(join(ROOT, ".nvmrc"), join(dir, ".nvmrc"));
  const program = join(dir, "coverage-witness.mjs");
  writeFileSync(program, "export function witness(x) { return x ? 7 : 3; }\nif (witness(true) !== 7) throw Error('witness');\n");
  const measured = spawnSync(process.execPath, [program], {
    cwd: dir, env: { ...environment(), NODE_V8_COVERAGE: join(dir, "coverage/raw") },
    encoding: "utf8", timeout: CHILD_BOUND_MS,
  });
  assert.equal(measured.status, 0, measured.stderr);
  assert.ok(readdirSync(join(dir, "coverage/raw")).some(name => /^coverage-.*\.json$/.test(name)));
  const packaged = shell(dir, compactStep);
  assert.equal(packaged.status, 0, packaged.stderr);
  const compact = join(dir, "coverage/compact"), artifact = join(dir, "coverage-artifact/raw");
  const names = readdirSync(compact).sort();
  assert.ok(names.some(name => name.endsWith(".json.gz")), "the real maintained writer must exercise the gzip path");
  assert.deepEqual(readdirSync(artifact).sort(), names, "every declared completed chunk must be transported");
  for (const name of names) assert.deepEqual(readFileSync(join(artifact, name)), readFileSync(join(compact, name)));
  const merged = merge(dir);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /1 V8 file\(s\)/);
  const lcov = readFileSync(join(dir, "coverage/transport-merged.info"), "utf8");
  assert.match(lcov, /^SF:.*coverage-witness\.mjs$/m);
  const chunk = names.find(name => name.endsWith(".json.gz"))!;
  rmSync(join(artifact, chunk));
  const missing = merge(dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /incomplete or extra coverage chunks/);
  copyFileSync(join(compact, chunk), join(artifact, chunk));
  const extra = chunk.replace(/\d{8}(?=\.json)/, "99999999");
  assert.notEqual(extra, chunk);
  copyFileSync(join(compact, chunk), join(artifact, extra));
  const unexpected = merge(dir);
  assert.equal(unexpected.status, 1);
  assert.match(unexpected.stderr, /incomplete or extra coverage chunks/);
  rmSync(join(artifact, extra));
  writeFileSync(join(artifact, chunk), Buffer.alloc(1));
  const truncated = merge(dir);
  assert.equal(truncated.status, 1);
  assert.match(truncated.stderr, /coverage chunk size mismatch/);
  copyFileSync(join(compact, chunk), join(artifact, chunk));
  const restored = merge(dir);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(join(dir, "coverage/transport-merged.info"), "utf8"), lcov);
});

test("the nightly artifact accepts identity-only names and excludes unfinished or unrelated files", t => {
  const { dir } = ownedFixtureDir(t, "nightly-identity-transport");
  layout(dir);
  // Filename-transport control only: this is not a forged corpus accepted by the merger.
  const name = "coverage-identity-fixture.json", bytes = Buffer.from("identity bytes\n");
  writeFileSync(join(dir, "coverage/compact", name), bytes);
  writeFileSync(join(dir, "coverage/compact/coverage-incomplete.json.gz.part"), "unfinished");
  writeFileSync(join(dir, "coverage/compact/unrelated.json.gz"), "unrelated");
  const packaged = shell(dir, packaging);
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.deepEqual(readdirSync(join(dir, "coverage-artifact/raw")), [name]);
  assert.deepEqual(readFileSync(join(dir, "coverage-artifact/raw", name)), bytes);
});

test("the nightly artifact refuses an empty completed-chunk population", t => {
  const { dir } = ownedFixtureDir(t, "nightly-empty-transport");
  layout(dir);
  const packaged = shell(dir, packaging);
  assert.equal(packaged.status, 1, packaged.stderr);
  assert.deepEqual(readdirSync(join(dir, "coverage-artifact/raw")), []);
});
