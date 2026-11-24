import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error -- plain .mjs script, no type declarations
import { CI_COVERAGE_SHARD_COUNT } from "#scripts/coverage-floor.mjs";
// @ts-expect-error -- plain .mjs script, no type declarations
import { screenBudgetMs } from "#scripts/flake-screen.mjs";
// @ts-expect-error -- plain .mjs script, no type declarations
import { COVERAGE_SHARD_WORKERS, DEFAULT_CI_SHARD_COUNT, instrumentedManifest, listTestFiles, loadManifest, packFilesByMakespan, predictMakespanMs } from "#scripts/test-tier-manifest.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14648: the screen spends the time a pull request already waits for its slowest coverage
// shard. Coverage runs CI_COVERAGE_SHARD_COUNT (16) shards, but the budget packed the ci lane's
// DEFAULT_CI_SHARD_COUNT (8), predicting a window about twice the one the pull request really waits.

/** The slowest shard's predicted wall time when `root`'s files pack into `shardCount` shards. */
function packedMakespanMs(root: string, shardCount: number): number {
  const manifest = instrumentedManifest(
    loadManifest(join(root, "scripts/test-tier-manifest.json")),
    loadManifest(join(root, "scripts/test-tier-coverage-manifest.json")),
  );
  const shards = packFilesByMakespan(listTestFiles(root), manifest, shardCount, COVERAGE_SHARD_WORKERS);
  return Math.max(0, ...shards.map((files: string[]) => predictMakespanMs(files, manifest, COVERAGE_SHARD_WORKERS)));
}

test("W1-T14648: the screen budget packs with the coverage shard count", () => {
  assert.equal(CI_COVERAGE_SHARD_COUNT, 16, "coverage-floor.mjs CI_COVERAGE_SHARD_COUNT");
  assert.notEqual(CI_COVERAGE_SHARD_COUNT, DEFAULT_CI_SHARD_COUNT, "the two lanes differ, so the choice is observable");

  // 48 equal files on 3 workers per shard: 16 shards hold 3 each (one round), 8 hold 6 (two rounds).
  const dir = mkdtempSync(join(tmpdir(), "rmd-flake-budget-shards-"));
  try {
    mkdirSync(join(dir, "test"));
    mkdirSync(join(dir, "scripts"));
    const files: Record<string, number> = {};
    for (let i = 0; i < 48; i++) {
      writeFileSync(join(dir, "test", `f${String(i).padStart(2, "0")}.test.ts`), "");
      files[`test/f${String(i).padStart(2, "0")}.test.ts`] = 10_000;
    }
    writeFileSync(join(dir, "scripts", "test-tier-manifest.json"), JSON.stringify({ files }));
    writeFileSync(join(dir, "scripts", "test-tier-coverage-manifest.json"), JSON.stringify({ files }));
    assert.equal(packedMakespanMs(dir, CI_COVERAGE_SHARD_COUNT), 10_000);
    assert.equal(packedMakespanMs(dir, DEFAULT_CI_SHARD_COUNT), 20_000);
    assert.equal(screenBudgetMs(dir), 10_000, "the budget is one 16-shard round, not the 8-shard two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The repository's own ledgers: the budget is the 16-shard predicted makespan.
  assert.equal(screenBudgetMs(REPO_ROOT), packedMakespanMs(REPO_ROOT, CI_COVERAGE_SHARD_COUNT));

  // Never a literal: the shard count comes from coverage-floor.mjs.
  const source = readFileSync(join(REPO_ROOT, "scripts/flake-screen.mjs"), "utf8");
  assert.match(source, /import \{[^}]*\bCI_COVERAGE_SHARD_COUNT\b[^}]*\} from "\.\/coverage-floor\.mjs";/);
  assert.match(source, /packFilesByMakespan\(testFiles, manifest, CI_COVERAGE_SHARD_COUNT, COVERAGE_SHARD_WORKERS\)/);
});
