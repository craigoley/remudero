import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkWorktreeNodeModules } from "#src/lib/worker.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-physical-dependency-"));
  const engine = join(root, "state", "engines", "fixture");
  const install = join(root, "canonical");
  const modules = join(install, "node_modules");
  const worktree = join(root, "worktree");
  for (const dir of [engine, modules, worktree]) mkdirSync(dir, { recursive: true });
  for (const dir of [engine, install, worktree]) {
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
  }
  symlinkSync(modules, join(engine, "node_modules"), "dir");
  return { root, engine, install, modules, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a worker dependency link names the physical install, not its private engine alias", () => {
  const f = fixture();
  try {
    assert.equal(linkWorktreeNodeModules(f.engine, f.worktree), "linked");
    const linked = join(f.worktree, "node_modules");
    assert.equal(readlinkSync(linked), f.modules);
    renameSync(f.engine, join(f.root, "retired-engine"));
    assert.equal(statSync(linked).isDirectory(), true, "hiding the intermediate engine cannot hide the real install");
  } finally { f.cleanup(); }
});

test("a worker dependency link compares lockfiles with the physical install", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.engine, "package.json"), '{"name":"older-engine"}\n');
    const warnings: string[] = [];
    assert.equal(linkWorktreeNodeModules(f.engine, f.worktree, { warn: (line) => warnings.push(line) }), "linked");
    assert.deepEqual(warnings, [], "the engine's unrelated package metadata is not installed dependency provenance");
  } finally { f.cleanup(); }
});

test("a worker dependency link refuses a source whose physical path cannot be read", () => {
  const f = fixture();
  try {
    const absent = join(f.root, "absent", "node_modules");
    assert.equal(linkWorktreeNodeModules(f.engine, f.worktree, { resolveSource: () => absent }), "failed");
    assert.equal(existsSync(join(f.worktree, "node_modules")), false);
    assert.throws(() => lstatSync(join(f.worktree, "node_modules")), { code: "ENOENT" });
  } finally { f.cleanup(); }
});

test("an occupied worker dependency destination is never resolved or replaced", () => {
  const f = fixture();
  try {
    const linked = join(f.worktree, "node_modules");
    symlinkSync(join(f.root, "absent"), linked, "dir");
    assert.equal(linkWorktreeNodeModules(f.engine, f.worktree, {
      resolveSource: () => { throw new Error("must not inspect a source for an occupied destination"); },
    }), "already-present");
    assert.equal(readlinkSync(linked), join(f.root, "absent"));
  } finally { f.cleanup(); }
});
