import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProofSpawner } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("the real synchronous proof spawner retains stderr on a child failure", t => {
  const { dir } = ownedFixtureDir(t, "proof-spawner-stderr");
  assert.throws(() => defaultProofSpawner(process.execPath, ["-e",
    'process.stdout.write("fixture stdout\\n"); process.stderr.write("fixture runner refusal\\n"); process.exit(2)',
  ], dir, 5_000), (error: unknown) => {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "fixture stdout\n");
    assert.equal(result.stderr, "fixture runner refusal\n");
    return true;
  });
});

test("the real synchronous proof spawner keeps successful stdout separate from stderr", t => {
  const { dir } = ownedFixtureDir(t, "proof-spawner-success");
  const output = defaultProofSpawner(process.execPath, ["-e",
    'process.stdout.write("fixture result\\n"); process.stderr.write("fixture diagnostic\\n")',
  ], dir, 5_000);
  assert.equal(output, "fixture result\n");
});
