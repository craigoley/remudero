import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const HOOK = readFileSync(join(REPO_ROOT, "hooks", "pre-push"), "utf8");
const TIER_SCRIPT = readFileSync(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs"), "utf8");
const BEGIN = "# W1-T3205: BEGIN test-tier admission";
const END = "# W1-T3205: END test-tier admission";

/** W1-T4430 flipped what the tier admission refuses: a new test file with NO manifest row is the
 *  fast tier and is admitted; a GHOST row (one naming a test file not on disk) is the refusal. Every
 *  fixture carries the untiered `test/new.test.ts`, so the refusing fixture proves the ghost row is
 *  the cause and the admitting one proves the untiered file is not. */
function fixture(t: TestContext, opts: { ghostRow: boolean } = { ghostRow: true }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prepush-test-tier-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "scripts", "test-tier-manifest.mjs"), TIER_SCRIPT);
  const files = opts.ghostRow ? { "test/deleted.test.ts": 1234 } : {};
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), `${JSON.stringify({ thresholdMs: 5000, files })}\n`);
  writeFileSync(join(root, "test", "new.test.ts"), "// deliberately absent from the manifest\n");
  return root;
}

function runHook(root: string, source = HOOK) {
  const hook = join(root, "pre-push");
  writeFileSync(hook, source);
  return spawnSync("/bin/sh", [hook], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RMD_PREPUSH_GATES: "1" },
  });
}

// W1-T4430 retitled this from "refuses an untiered test locally and names the seed command": that
// behaviour is retired (an untiered file is admitted — next test). The hook still refuses early and
// still names the fix, now for the one tier defect left: a row naming a test file not on disk.
test("W1-T3205: hooks/pre-push refuses a ghost tier row locally and names the fix", (t) => {
  const result = runHook(fixture(t, { ghostRow: true }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /test\/deleted\.test\.ts/, "the refusal names the ghost row");
  assert.match(result.stderr, /Remove the row\(s\) above, or restore the file they name\./, "and the fix");
  assert.match(result.stderr, /pre-push REFUSED/);
  assert.doesNotMatch(result.stderr, /test\/new\.test\.ts/, "the untiered file beside it is not the cause");
  assert.doesNotMatch(result.stderr, /--seed/, "and no seeding remedy is offered for it");
});

test("W1-T4430: hooks/pre-push ADMITS a new test file that has no tier row", (t) => {
  const root = fixture(t, { ghostRow: false });
  const before = readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8");
  const result = runHook(root);

  assert.equal(result.status, 0, `an untiered test file must not stop a push: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /pre-push REFUSED/);
  assert.doesNotMatch(result.stdout + result.stderr, /test\/new\.test\.ts/, "the untiered file is not even reported");
  assert.match(result.stdout, /test-tier-manifest: OK/, "the tier admission ran and reached a verdict");
  assert.equal(
    readFileSync(join(root, "scripts", "test-tier-manifest.json"), "utf8"),
    before,
    "the gate never writes the manifest",
  );
});

test("W1-T3205: MUTANT removing only the tier admission lets the same push through", (t) => {
  const start = HOOK.indexOf(BEGIN);
  const finish = HOOK.indexOf(END);
  assert.ok(start >= 0 && finish > start, "the tier admission block is bounded by stable mutation anchors");
  const mutant = `${HOOK.slice(0, start)}${HOOK.slice(finish + END.length)}`;
  const result = runHook(fixture(t, { ghostRow: true }), mutant);

  assert.equal(result.status, 0, "without the tier admission, no other hook check sees the ghost row");
  assert.doesNotMatch(result.stderr, /test\/deleted\.test\.ts/);
  assert.doesNotMatch(result.stderr, /Remove the row/);
});
