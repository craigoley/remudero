import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @source-text-subject: execute the actual CI shell assignment that counts a shard's selected files.
const workflow = parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"));
const steps = workflow.jobs.ci.steps as Array<{run?: string}>;
const assignments = steps.flatMap(step => (step.run ?? "").split("\n")).filter(line => line.trim().startsWith("ASSIGNED_COUNT="));
assert.equal(assignments.length, 1, "the real candidate-count assignment is observed exactly once");

function runCount(input: string | undefined, t: {after(fn: () => void): void}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-empty-assignment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (input !== undefined) writeFileSync(join(root, "assigned-plan-reading-suites.txt"), input);
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${assignments[0]}\nprintf 'REACHED count=%s\\n' "$ASSIGNED_COUNT"`], {
    cwd: root, encoding: "utf8", env: { ...process.env, BASH_ENV: "/dev/null" },
  });
}

test("a valid empty plan-reading shard reaches its runner with zero assigned suites", t => {
  const empty = runCount("", t);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "REACHED count=0");
  const assigned = runCount("test/a.test.ts\ntest/b.test.ts\ntest/c.test.ts\n", t);
  assert.equal(assigned.status, 0, assigned.stderr);
  assert.equal(assigned.stdout.trim(), "REACHED count=3");
});

test("an unreadable plan-reading assignment still stops before the runner", t => {
  const missing = runCount(undefined, t);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /assigned-plan-reading-suites/);
});
