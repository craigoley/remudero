// @source-text-subject: this guard classifies actual git spawn sites in shipped sweep source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/** A direct git spawn: the leaf census for run-task never walks sweep.ts, so a hand fix there must not add one. */
const DIRECT_GIT_SPAWN = /\b(?:execFileSync|execFile|execFilePromise|spawnSync|spawn|exec)\(\s*"git"/;

test("W1-T10733: check:test:test/run-task-git-calls-into-a-worker-worktree-go-through-the-leaf.test.ts is prevented, not retried", () => {
  const lines = readFileSync(join(REPO_ROOT, "src/lib/sweep.ts"), "utf8").split("\n");
  const offenders = lines.map((text, i) => ({ text, n: i + 1 })).filter((l) => DIRECT_GIT_SPAWN.test(l.text));
  assert.deepEqual(offenders, [], "sweep.ts must reach git through an injected seam, never a direct spawn");
  assert.ok(lines.length > 1000, "positive control: the scan read the real sweep.ts");
});
