import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

const ROOT = findRepoRoot();
const SUITE = "test/a-check-proof-child-runs-the-precompiled-entry-when-current.test.ts";

// fb-1791916356285-50ef47: drive the existing real bundle-build/launch assertion under a deterministic path.
test("a current bundle under a tsx-named temporary path passes the real launcher assertion", () => {
  assert.ok(existsSync(join(ROOT, SUITE)), "the child suite exists before launching it");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "rmd-bundle-tsx-path-"));
  try {
    const result = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap",
      "--test-name-pattern=^W1-T8775: a current check-proof bundle is spawned without tsx$",
      "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", SUITE,
    ], {
      cwd: ROOT,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMPDIR: temporaryRoot },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^ok \d+ - W1-T8775: a current check-proof bundle is spawned without tsx$/m);
    assert.match(result.stdout, /^# pass 1$/m, "the named test ran, rather than a zero-match wrapper");
    assert.match(result.stdout, /^# fail 0$/m);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
