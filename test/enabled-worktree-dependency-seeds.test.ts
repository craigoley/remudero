import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { provisionWorktreeNodeModules } from "../src/lib/worker.js";

test("enabled worktree provisioning primes once without a donor and preserves existing installs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-enabled-seeds-")));
  const previous = process.env.RMD_DEPENDENCY_SEED_ROOT, warnings: string[] = [];
  const first = join(root, "first"), second = join(root, "second"), missing = join(root, "missing");
  for (const path of [first, second, missing]) mkdirSync(path);
  for (const path of [first, second]) {
    writeFileSync(join(path, "package.json"), '{"name":"empty","version":"1.0.0"}');
    writeFileSync(join(path, "package-lock.json"), '{"name":"empty","lockfileVersion":3,"packages":{}}');
  }
  try {
    process.env.RMD_DEPENDENCY_SEED_ROOT = join(root, "seeds");
    const deps = { resolveSource: () => undefined, warn: (s: string) => warnings.push(s) };
    assert.equal(provisionWorktreeNodeModules(root, first, deps), "linked");
    assert.ok(lstatSync(join(first, "node_modules")).isDirectory());
    assert.equal(provisionWorktreeNodeModules(root, first, deps), "already-present");
    assert.equal(provisionWorktreeNodeModules(root, second, { ...deps, resolveSource: () => join(first, "node_modules") }), "linked");
    assert.equal(provisionWorktreeNodeModules(root, missing, deps), "failed");
    assert.match(warnings[0], /dependency seed provisioning refused/);
    assert.ok(!existsSync(join(missing, "node_modules")));
  } finally {
    if (previous === undefined) delete process.env.RMD_DEPENDENCY_SEED_ROOT; else process.env.RMD_DEPENDENCY_SEED_ROOT = previous;
    const writable = (path: string): void => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.mode | 0o700); if (s.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); };
    writable(root); rmSync(root, { recursive: true, force: true });
  }
});
