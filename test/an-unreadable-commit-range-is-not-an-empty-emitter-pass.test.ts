/**
 * W1-T10095 — AN UNREADABLE COMMIT RANGE IS NOT AN EMPTY EMITTER PASS.
 *
 * `readRangeCommitMessages` already refused a missing status, a signal and a spawn errno, but a
 * `git log` that ran and exited nonzero (an invalid from/to revision) printed nothing on stdout —
 * the same shape as a genuinely empty range — and the emitter step certified "0 commit message(s)"
 * as a PASS. These fixtures drive real disposable repositories for the Git outcomes and a scripted
 * spawn for the status/signal/errno matrix, so a successful empty read and a failed read stay apart.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { emitterChecksStep, readRangeCommitMessages } from "#src/lib/commit-message.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function rangeFixture(t: TestContext) {
  const previous = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  t.after(() => {
    for (const [i, key] of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"].entries()) {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    }
  });
  const repo = gitRepo({ seedCommit: false, scope: t });
  const commit = (text: string) => repo.git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", text);
  commit("chore(fixture): seed a real range");
  const from = repo.git("rev-parse", "HEAD");
  commit("fix(fixture): valid range message");
  return { repo, from, to: repo.git("rev-parse", "HEAD") };
}

test("actual emitter range reads refuse failed Git without erasing valid empty ranges", (t) => {
  const { repo, from, to } = rangeFixture(t);
  const empty = emitterChecksStep(repo.dir, { from: to, to });
  assert.equal(empty.ok, true, empty.detail);
  assert.match(empty.detail, /0 commit message/);
  for (const range of [{ from: "missing-fixture-origin", to }, { from, to: "missing-fixture-head" }]) {
    const result = emitterChecksStep(repo.dir, range);
    assert.equal(result.ok, false, "real nonzero Git must not certify an empty successful range");
    assert.match(result.detail, /Git range read.*(?:status|exit).*128/);
  }
});

test("emitter range status checks preserve healthy and invalid message controls", (t) => {
  const valid = rangeFixture(t), good = emitterChecksStep(valid.repo.dir, { from: valid.from, to: valid.to });
  assert.equal(good.ok, true, good.detail);
  assert.match(good.detail, /1 commit message/);
  valid.repo.git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet",
    "--allow-empty", "-m", "wip: invalid conventional type");
  const bad = emitterChecksStep(valid.repo.dir, { from: valid.to, to: "HEAD" });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /type-enum/);
  assert.equal(emitterChecksStep(valid.repo.dir, { from: "missing-fixture-origin", to: "HEAD" }).ok, false,
    "healthy controls travel beside the repaired status boundary, not a proof that passes on the old false-zero reader");
});

test("emitter range failures name Git status signal and errno without certifying zero", () => {
  const cases = [
    { status: 17, stderr: "synthetic Git diagnostic", expected: /Git range read.*(?:status|exit).*17/ },
    { status: 19, stderr: "", expected: /Git range read.*(?:status|exit).*19/ },
    { status: 128, stderr: "x".repeat(4096), expected: /Git range read.*(?:status|exit).*128/ },
    { status: null, stderr: "", signal: "SIGTERM", expected: /SPAWN FAILURE.*KILLED by SIGTERM/ },
    { status: null, stderr: "", error: "spawn git ENOENT", expected: /SPAWN FAILURE.*ENOENT/ },
    { status: null, stderr: "", expected: /SPAWN FAILURE.*no exit status, no signal and no error/ },
  ];
  for (const c of cases) {
    const spawn = (() => ({ ...c, stdout: "\0fix(fixture): would otherwise pass\n" })) as Parameters<typeof emitterChecksStep>[2];
    // The directory is only the scripted spawn's cwd, which this matrix never reads.
    const result = emitterChecksStep("/scripted-spawn-cwd", { from: "from", to: "to" }, spawn);
    assert.equal(result.ok, false);
    assert.match(result.detail, c.expected);
    if (c.status === 128) assert.ok(result.detail.length < 800, "a Git diagnostic is bounded, not a full arbitrary stream");
  }
});

test("actual emitter range status checking is load-bearing", (t) => {
  const { repo, from, to } = rangeFixture(t);
  assert.deepEqual(readRangeCommitMessages(repo.dir, { from: to, to }), []);
  assert.throws(() => readRangeCommitMessages(repo.dir, { from, to: "missing-fixture-head" }), /Git range read/);
});
