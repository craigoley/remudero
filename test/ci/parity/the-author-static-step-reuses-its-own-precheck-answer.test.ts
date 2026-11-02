import assert from "node:assert/strict";
import { test } from "node:test";

import { AUTHOR_CENSUS_ANSWERED_ENV, FAST_GATE_STEPS, runPreflightFast } from "#src/lib/ci-parity.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HEAD = hostWorktreeGit(REPO_ROOT, ["rev-parse", "HEAD"]).trim();
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const CENSUS_STEP = FAST_GATE_STEPS.find((step) => step.runner === "census-precheck");

function recordingSpawn() {
  const calls: { file: string; args: string[] }[] = [];
  const spawn = (file: string, args: string[]) => {
    calls.push({ file, args });
    return { status: 0, stdout: "census-precheck: OK", stderr: "" };
  };
  const censusRuns = () => calls.filter((c) => c.args.some((a) => a.endsWith("census-precheck.mjs"))).length;
  return { spawn, calls, censusRuns };
}

function withAnswer<T>(value: string | undefined, fn: () => T): T {
  const before = process.env[AUTHOR_CENSUS_ANSWERED_ENV];
  if (value === undefined) delete process.env[AUTHOR_CENSUS_ANSWERED_ENV];
  else process.env[AUTHOR_CENSUS_ANSWERED_ENV] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[AUTHOR_CENSUS_ANSWERED_ENV];
    else process.env[AUTHOR_CENSUS_ANSWERED_ENV] = before;
  }
}

test("W1-T11101 criterion 1: an author census answer for this HEAD is reused and census-precheck is not spawned again", () => {
  assert.ok(CENSUS_STEP, "the fast gate carries a census-precheck step");
  for (const outcome of ["ok", "time-bound"]) {
    const rec = recordingSpawn();
    const result: ReturnType<typeof runPreflightFast> = withAnswer(`${HEAD}:${outcome}`, () => runPreflightFast(REPO_ROOT, { spawn: rec.spawn as never, steps: [CENSUS_STEP!] }));
    assert.equal(result.steps[0]!.ok, true);
    assert.match(result.steps[0]!.detail, new RegExp(`answered by the author preflight's census-precheck step at ${HEAD} \\(${outcome}\\); not run again`));
    assert.equal(rec.censusRuns(), 0, "census-precheck was spawned although the author run had answered for this head");
  }
});

test("W1-T11101 criterion 2: another head, an absent answer, or a malformed one still spawns census-precheck exactly as before", () => {
  for (const value of [`${OTHER}:ok`, undefined, `${HEAD}:refused`, "not-a-sha:ok"]) {
    const rec = recordingSpawn();
    const result: ReturnType<typeof runPreflightFast> = withAnswer(value, () => runPreflightFast(REPO_ROOT, { spawn: rec.spawn as never, steps: [CENSUS_STEP!] }));
    assert.equal(rec.censusRuns(), 1, `census-precheck must run when the recorded answer is ${String(value)}`);
    assert.doesNotMatch(result.steps[0]!.detail, /answered by the author preflight/);
  }
});
