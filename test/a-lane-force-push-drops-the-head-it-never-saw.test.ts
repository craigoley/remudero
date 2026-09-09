// W1-T3221 — A LANE'S FORCE-PUSH DISCARDS THE REMOTE HEAD IT NEVER SAW.
//
// `gitPushRunBranch(worktreePath, { force: true })` appended a bare `--force`, on the premise —
// written into the option's own docblock — that a `run-<id>-<epochMs>` branch is "owned
// exclusively by this one run, so nobody else's work is ever discarded". MEASURED 2026-09-08 on
// run-W1-T3207-1788902917008: the published head f4f18be74 is NOT an ancestor of the branch's
// later head. It was replaced 22 minutes on by a commit with the same subject, a different parent
// (404999789 vs 90097932a) and a different tree. An operator now works lane-owned PRs by hand as
// ordinary practice, so the run branch is a SHARED ref and that premise is false.
//
// W1-T1288 does not cover this and says so: its `expectedHeadSha` reads "the worktree's OWN head
// ... never the value observed on the remote". It catches a LOCAL ref that drifted between the
// commit and the push. This is the remote moving under a lane that never looked.
//
// THESE RUN AGAINST A REAL LOCAL REMOTE — a bare repo on disk, real `git push`, real refs. A fake
// ref store can be made to agree with whatever the implementation happens to send; only git
// decides whether a lease actually holds, and the elision trap below is a property of git's own
// behaviour, not of an argv string.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  gitPushRunBranch,
  leaselessRefusalMessage,
  foreignHeadRefusalMessage,
} from "../src/lib/git-push.js";
// The fixture's origin is a bare repo under TMPDIR, which is exactly the case the live-write
// guard names as legitimate — it checks the CALL, not the destination, so a real-but-local remote
// still has to be declared. Each push is wrapped individually so nothing else in a test is exempt.
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

/** A lane worktree on `run-<id>-<epochMs>`, with one commit already published to a real bare remote. */
function laneOnAPublishedBranch(): { lane: GitRepo; remote: GitRepo; branch: string; published: string } {
  const remote = gitRepo({ bare: true, kind: "leased-force-origin" });
  const lane = gitRepo({ seedCommit: false, kind: "leased-force-lane" });
  lane.addRemote("origin", remote.dir);
  writeFileSync(join(lane.dir, "seed.txt"), "seed\n");
  lane.git("add", "-A");
  lane.git("commit", "-m", "chore: seed");
  lane.git("push", "origin", "HEAD:refs/heads/main");

  const branch = "run-W1-T3221-1788909404398";
  lane.git("checkout", "-b", branch);
  writeFileSync(join(lane.dir, "work.txt"), "the lane's work\n");
  lane.git("add", "-A");
  lane.git("commit", "-m", "feat: the lane's work");
  // The lane's OWN first push — the unforced one that precedes every trailer amend, and the thing
  // that populates refs/remotes/origin/<branch>, which is where the lease comes from.
  withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { stdio: "ignore" }));
  return { lane, remote, branch, published: lane.git("rev-parse", "HEAD") };
}

/** Amend the tip the way `appendTaskTrailerToCommit` does: same tree, new sha. */
function amendWithTrailer(lane: GitRepo): string {
  lane.git("commit", "--amend", "-m", "feat: the lane's work\n\nRemudero-Task: W1-T3221");
  return lane.git("rev-parse", "HEAD");
}

/** A second writer — the operator working this PR by hand — lands a commit on the same branch. */
function anOperatorCommitLandsOn(remote: GitRepo, branch: string, base: string): string {
  const clone = gitRepo({ cloneFrom: remote.dir, kind: "leased-force-operator" });
  clone.git("checkout", "--quiet", "-B", branch, base);
  writeFileSync(join(clone.dir, "operator.txt"), "the operator's fix\n");
  clone.git("add", "-A");
  clone.git("commit", "-m", "fix: the operator's one-line repair");
  clone.git("push", "origin", `HEAD:refs/heads/${branch}`);
  return clone.git("rev-parse", "HEAD");
}

const remoteHead = (remote: GitRepo, branch: string): string => remote.git("rev-parse", `refs/heads/${branch}`);

test("W1-T3221: an unchanged remote head still lands the trailer amend — the ordinary path is unbroken", () => {
  const { lane, remote, branch } = laneOnAPublishedBranch();
  const amended = amendWithTrailer(lane);

  withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore" }));

  assert.equal(remoteHead(remote, branch), amended, "the amended tip must land when nobody else moved the ref");
  assert.match(
    remote.git("log", "-1", "--format=%B", `refs/heads/${branch}`),
    /Remudero-Task: W1-T3221/,
    "the trailer this force-push exists for must actually be on the remote tip",
  );
});

test("W1-T3221: a remote advanced by a commit the lane never saw refuses the push, and that commit survives", () => {
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  const operatorSha = anOperatorCommitLandsOn(remote, branch, published);
  // The lane never fetched, so its refs/remotes/origin/<branch> still reads its own push — which
  // is precisely the disagreement the lease states.
  assert.equal(lane.git("rev-parse", `refs/remotes/origin/${branch}`), published);
  const amended = amendWithTrailer(lane);

  withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore" }));

  assert.equal(remoteHead(remote, branch), operatorSha, "the operator's commit must still be the remote tip");
  assert.notEqual(remoteHead(remote, branch), amended, "the lane's amended tip must not have replaced it");
  assert.equal(
    remote.git("cat-file", "-t", operatorSha),
    "commit",
    "the operator's commit must remain reachable, not merely un-tipped",
  );
});

test("W1-T3221: the bare --force this replaces WOULD have discarded that commit — the lease is load-bearing", () => {
  // The falsifier, run as a test rather than described: same fixture, same amend, but pushed the
  // way the leaf did before this task. Without it, "the operator's commit survives" above proves
  // only that this particular push happened to fail.
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  const operatorSha = anOperatorCommitLandsOn(remote, branch, published);
  const amended = amendWithTrailer(lane);

  lane.git("push", "--force", "origin", "HEAD");

  assert.equal(remoteHead(remote, branch), amended, "the un-leased push replaces the tip");
  assert.notEqual(remoteHead(remote, branch), operatorSha, "and the operator's commit is no longer the tip — the loss this task removes");
});

test("W1-T3221: a refusal returns rather than throwing, so the run still reaches PR creation", () => {
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  anOperatorCommitLandsOn(remote, branch, published);
  amendWithTrailer(lane);

  // The work is already on origin by this point; only the trailer is at stake. A throw here would
  // abort the run before `gh pr create`, trading an invisible loss for a louder one.
  assert.doesNotThrow(() => withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore" })));
});

test("W1-T3221: a worktree with no branch to lease against refuses instead of falling back to a bare force", () => {
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  const operatorSha = anOperatorCommitLandsOn(remote, branch, published);
  amendWithTrailer(lane);
  const detachedAt = lane.git("rev-parse", "HEAD");
  lane.git("checkout", "--quiet", "--detach", detachedAt);

  withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore" }));

  assert.equal(
    remoteHead(remote, branch),
    operatorSha,
    "no lease can be stated from a detached HEAD, and a push that cannot state one is the bare force this removes",
  );
});

test("W1-T3221: both refusal messages name the shas, so a reader can tell what was preserved", () => {
  const foreign = foreignHeadRefusalMessage("run-W1-T3221-1", "aaaaaaa", "bbbbbbb", "ccccccc");
  for (const sha of ["aaaaaaa", "bbbbbbb", "ccccccc"]) {
    assert.ok(foreign.includes(sha), `the foreign-head refusal must name ${sha}`);
  }
  assert.match(foreign, /nothing was\s+pushed and nothing was discarded/, "it must say what did NOT happen");
  assert.match(
    leaselessRefusalMessage("no tracking ref"),
    /trailer amend is skipped/,
    "the leaseless refusal must name the bounded cost it is accepting, not merely refuse",
  );
});

test("W1-T3221: the local-head check W1-T1288 added still fires alongside the lease — they answer different questions", () => {
  const { lane } = laneOnAPublishedBranch();
  amendWithTrailer(lane);
  // W1-T1288's precondition is about THIS worktree's ref, and is checked before any lease work.
  assert.throws(
    () => withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore", expectedHeadSha: "0".repeat(40) })),
    /the local ref moved between the commit and this push/,
  );
});

test("W1-T3221: a branch this lane has never published has no lease to state, so nothing is pushed", () => {
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  const operatorSha = anOperatorCommitLandsOn(remote, branch, published);
  // A branch with no refs/remotes/origin/<branch> at all — the lane has published nothing under
  // this name, so "the sha I last put there" does not exist and cannot be asserted.
  lane.git("checkout", "--quiet", "-b", "run-W1-T3221-never-pushed");
  lane.git("commit", "--allow-empty", "-m", "feat: unpublished");

  withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore" }));

  assert.equal(remoteHead(remote, branch), operatorSha, "the original branch is untouched");
  assert.throws(
    () => remote.git("rev-parse", "refs/heads/run-W1-T3221-never-pushed"),
    "an unleasable push must create nothing either — refusing is not the same as force-creating",
  );
});

test("W1-T3221: an unreadable HEAD refuses rather than pushing a sha it could not name", () => {
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  const operatorSha = anOperatorCommitLandsOn(remote, branch, published);
  // Injected because a worktree whose branch resolves but whose HEAD does not is not reachable
  // with real git in a fixture; the arm still has to be shown to refuse rather than fall through.
  const capture = (_f: string, args: string[]): string => {
    if (args.includes("--abbrev-ref")) return `${branch}\n`;
    if (args.includes(`refs/remotes/origin/${branch}`)) return `${published}\n`;
    throw new Error("fatal: ambiguous argument 'HEAD': unknown revision");
  };
  withLiveWritesAllowed(() =>
    gitPushRunBranch(lane.dir, {
      force: true,
      stdio: "ignore",
      capture,
      exec: () => assert.fail("must not push when the sha to be pushed could not be read"),
    }),
  );
  assert.equal(remoteHead(remote, branch), operatorSha, "the remote is untouched");
});

test("W1-T3221: an ELIDED lease is caught by the post-push read, not trusted from exit 0", () => {
  // task-id-reservation.ts's header records the measured trap and gitPushEmptyCommit already
  // answers it: git can skip a lease entirely and still exit 0, so a caller reading the exit code
  // alone takes a lease-skipped push for a lease-honoured one. An exec that returns cleanly while
  // moving nothing is exactly that shape.
  const { lane, remote, branch, published } = laneOnAPublishedBranch();
  const operatorSha = anOperatorCommitLandsOn(remote, branch, published);
  const amended = amendWithTrailer(lane);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    withLiveWritesAllowed(() => gitPushRunBranch(lane.dir, { force: true, stdio: "ignore", exec: () => {} }));
  } finally {
    console.error = realError;
  }
  assert.equal(remoteHead(remote, branch), operatorSha, "nothing moved, which is the point");
  assert.ok(
    errors.some((e) => e.includes(amended) && e.includes(published) && e.includes(operatorSha)),
    `a clean exit that moved nothing must still be reported with all three shas; got ${JSON.stringify(errors)}`,
  );
});
