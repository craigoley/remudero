import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// W1-T6013: the PR-title gate refuses a wip-marked title. Drives the real commitlint CLI against
// the project's own config, as test/commitlint-config.test.ts does.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CONFIG = join(REPO_ROOT, "commitlint.config.mjs");

function lint(message: string) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", CONFIG],
    { cwd: REPO_ROOT, input: message, encoding: "utf8" },
  );
}

for (const title of [
  "chore(wip): x",
  "wip: x",
  "chore(serve): wip serve plan reload in place",
  "chore(serve): serve plan reload WIP",
]) {
  test(`unit test: test/a-wip-titled-pr-is-refused-at-merge.test.ts — refuses "${title}" naming the wip rule`, () => {
    const result = lint(`${title}\n`);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /no-wip-title/);
  });
}

for (const title of [
  "fix(janitor): wipe stale caches",
  "feat(drain): honour wip_limit",
  "test(drain): wipetest fixture",
]) {
  test(`unit test: test/a-wip-titled-pr-is-refused-at-merge.test.ts — accepts "${title}"`, () => {
    const result = lint(`${title}\n`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
