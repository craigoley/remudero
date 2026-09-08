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

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prepush-test-tier-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "scripts", "test-tier-manifest.mjs"), TIER_SCRIPT);
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), '{"thresholdMs":5000,"files":{}}\n');
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

test("W1-T3205: hooks/pre-push refuses an untiered test locally and names the seed command", (t) => {
  const result = runHook(fixture(t));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /test\/new\.test\.ts/);
  assert.match(result.stderr, /node scripts\/test-tier-manifest\.mjs --seed/);
  assert.match(result.stderr, /pre-push REFUSED/);
});

test("W1-T3205: MUTANT removing only the tier admission lets the same push through", (t) => {
  const start = HOOK.indexOf(BEGIN);
  const finish = HOOK.indexOf(END);
  assert.ok(start >= 0 && finish > start, "the tier admission block is bounded by stable mutation anchors");
  const mutant = `${HOOK.slice(0, start)}${HOOK.slice(finish + END.length)}`;
  const result = runHook(fixture(t), mutant);

  assert.equal(result.status, 0, "without the new admission, neither existing hook check sees an untiered test");
  assert.doesNotMatch(result.stderr, /--seed/);
});
