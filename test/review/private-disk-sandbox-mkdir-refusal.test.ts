import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { proofSandboxArgv, ProofSandboxUnavailableError } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("a real private scratch mkdir refusal stops before a later open", (t) => {
  const { dir } = ownedFixtureDir(t, "disk-sandbox-mkdir-refusal");
  const cwd = join(dir, "checkout"), home = join(dir, "not-a-directory");
  mkdirSync(cwd);
  writeFileSync(home, "owned fixture, not a usable HOME");
  assert.throws(() => proofSandboxArgv({ cwd, home, env: {} }), (error: unknown) => {
    assert.ok(error instanceof ProofSandboxUnavailableError);
    // Pin the operation before the quoted path: this fixture's own name also contains "mkdir".
    assert.match(error.message, /^proof sandbox could not start: private disk \/tmp unavailable: ENOTDIR: [^'\r\n]*, mkdir '/);
    return true;
  });
  assert.equal(readFileSync(home, "utf8"), "owned fixture, not a usable HOME");
});
