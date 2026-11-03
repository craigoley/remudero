import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildProjectInit, parseProjectInitArgs, ProjectInitError } from "#src/lib/project-init.js";
import { projectInitFiles, writeProjectInit } from "#src/lib/project-init-write.js";
import { resolveRepoLayout } from "#src/lib/repo-layout.js";

const BASELINES = { coveragePct: 73.4, branchesPct: 68.9, mutationScorePct: 61.2, dupPct: 4.2 };
const payload = () => buildProjectInit({
  owner: "acme-corp", repo: "widget-service", profile: "ts-node", baselines: BASELINES,
  now: () => new Date("2026-11-03T12:00:00.000Z"),
});

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "project-init-write-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("project init --write: every generated file lands on disk with the generator's exact content", () => {
  withDir((dir) => {
    const generated = payload();
    const written = writeProjectInit(generated, dir);
    const expected = projectInitFiles(generated, resolveRepoLayout(dir));
    assert.deepEqual(written, expected.map(([rel]) => rel));
    assert.ok(written.includes(".github/workflows/ci-gate.yml"));
    assert.ok(written.includes(".remudero/principles.yaml"));
    for (const [rel, content] of expected) assert.equal(readFileSync(join(dir, rel), "utf8"), content);
    const protection = JSON.parse(readFileSync(join(dir, ".remudero/branch-protection.json"), "utf8"));
    assert.deepEqual(protection.required_status_checks.contexts, ["ci-gate", "remudero-review"]);
  });
});

test("project init --write: an existing file refuses the whole write and leaves the checkout untouched", () => {
  withDir((dir) => {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/ci.yml"), "name: mine\n");
    assert.throws(() => writeProjectInit(payload(), dir), (e: unknown) =>
      e instanceof ProjectInitError && /refusing to overwrite/.test(e.message) && /\.github\/workflows\/ci\.yml/.test(e.message));
    assert.equal(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8"), "name: mine\n");
    assert.equal(existsSync(join(dir, ".remudero/principles.yaml")), false);
    assert.equal(existsSync(join(dir, ".github/workflows/ci-gate.yml")), false);
  });
});

test("project init --write: a relative target directory is refused before any write", () => {
  const writes: string[] = [];
  const fs = { exists: () => false, mkdirp: () => undefined, writeFile: (path: string) => { writes.push(path); } };
  assert.throws(() => writeProjectInit(payload(), "relative/dir", fs), ProjectInitError);
  assert.deepEqual(writes, []);
});

test("project init --write: the parser carries the directory and refuses a missing value", () => {
  const base = ["acme/widget", "--coverage-pct", "1", "--branches-pct", "1", "--mutation-pct", "1", "--dup-pct", "1"];
  const parsed = parseProjectInitArgs([...base, "--write", "/tmp/target"]);
  assert.ok(parsed.ok);
  assert.equal(parsed.args.writeDir, "/tmp/target");
  const bare = parseProjectInitArgs(base);
  assert.ok(bare.ok);
  assert.equal(bare.args.writeDir, undefined);
  const missing = parseProjectInitArgs([...base, "--write"]);
  assert.equal(missing.ok, false);
  const swallowed = parseProjectInitArgs(["acme/widget", "--write", "--coverage-pct", "1", "--branches-pct", "1", "--mutation-pct", "1", "--dup-pct", "1"]);
  assert.equal(swallowed.ok, false);
});
