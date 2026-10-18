import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProofSpawner } from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

test("the real synchronous proof spawner retains stderr on a child failure", t => {
  const { dir } = ownedFixtureDir(t, "proof-spawner-stderr");
  assert.throws(() => defaultProofSpawner(process.execPath, ["-e",
    'process.stdout.write("fixture stdout\\n"); process.stderr.write("fixture runner refusal\\napi_key=fixture-not-a-real-credential\\n"); process.exit(2)',
  ], dir, 5_000), (error: unknown) => {
    const result = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "fixture stdout\n");
    assert.equal(result.stderr, "fixture runner refusal\napi_key=fixture-not-a-real-credential\n");
    assert.doesNotMatch(result.message ?? "", /fixture-not-a-real-credential/);
    assert.match(result.message ?? "", /api_key=<redacted>/);
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

test("the real synchronous proof spawner bounds and redacts its public error message", t => {
  const { dir } = ownedFixtureDir(t, "proof-spawner-error-tail");
  assert.throws(() => defaultProofSpawner(process.execPath, ["-e",
    'process.stderr.write("fixture earlier line\\n".repeat(80) + "api_key=fixture-not-a-real-credential\\nfixture final refusal\\n"); process.exit(2)',
  ], dir, 5_000), (error: unknown) => {
    const message = (error as Error).message;
    assert.ok(message.length <= 3100, "the maintained tail includes only a bounded omission header");
    assert.match(message, /earlier lines omitted/);
    assert.match(message, /fixture final refusal/);
    assert.doesNotMatch(message, /fixture-not-a-real-credential/);
    return true;
  });
});
