/**
 * A fix round whose branch moved while its worker ran merges the new tip and pushes once.
 *
 * #10497 guards the tip a round STARTED from; a branch that moves WHILE the worker runs (a fleet
 * refresh, another fix lane, an operator push) still refused the round's leased push and threw the
 * correct commit away. Every fixture here is a real clone: the "remote" moves by a real commit.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

const reapplyModule = new URL("../src/lib/fix-round-reapply.ts", import.meta.url);
const load = async () => (await import(reapplyModule.href)) as typeof import("../src/lib/fix-round-reapply.js");

interface Pair { upstream: GitRepo; wt: GitRepo; base: string; committed: string }

function roundOnMovedBranch(kind: string, upstreamFile: string, upstreamText: string): Pair {
  const upstream = gitRepo({ kind: `${kind}-upstream`, seedCommit: true, branch: "main" });
  writeFileSync(join(upstream.dir, "shared.txt"), "base\n");
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "seed");
  const wt = gitRepo({ kind: `${kind}-round`, cloneFrom: upstream.dir });
  wt.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  wt.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const base = wt.git("rev-parse", "HEAD");
  writeFileSync(join(wt.dir, "shared.txt"), "base\nthe round's fix\n");
  wt.git("commit", "-am", "fix: the round's own edit");
  const committed = wt.git("rev-parse", "HEAD");
  writeFileSync(join(upstream.dir, upstreamFile), upstreamText);
  upstream.git("add", "-A");
  upstream.git("commit", "-m", "main moved while the round ran");
  return { upstream, wt, base, committed };
}

test("a branch that moved to a clean descendant while the round ran is merged into the round's commit", async () => {
  const { reapplyFixRoundOnMovedTip, realFixRoundReapplyPorts } = await load();
  const { upstream, wt, base, committed } = roundOnMovedBranch("reapply-clean", "other.txt", "a concurrent refresh\n");
  try {
    const remoteTip = upstream.git("rev-parse", "HEAD");
    const log: Array<{ step: string } & Record<string, unknown>> = [];
    const result = await reapplyFixRoundOnMovedTip({ wt: wt.dir, branch: "main", leaseBaseSha: base, committedSha: committed },
      realFixRoundReapplyPorts, (step, extra) => log.push({ step, ...(extra ?? {}) }));
    assert.equal(result.reapplied, true);
    assert.ok(result.reapplied);
    assert.equal(result.remoteTip, remoteTip);
    assert.deepEqual(wt.git("log", "-1", "--format=%P", result.mergedHeadSha).split(" "), [committed, remoteTip],
      "a merge keeps both the round's commit and the tip it did not see");
    assert.deepEqual(log.map((row) => row.step), ["fix.round_reapplied"]);
    assert.equal(log[0]!.merged_head_sha, result.mergedHeadSha);
  } finally {
    wt.cleanup();
    upstream.cleanup();
  }
});

test("a moved branch whose change conflicts with the round's edit is refused and the merge is aborted", async () => {
  const { reapplyFixRoundOnMovedTip, realFixRoundReapplyPorts } = await load();
  const { upstream, wt, base, committed } = roundOnMovedBranch("reapply-conflict", "shared.txt", "base\na different edit\n");
  try {
    const log: Array<{ step: string } & Record<string, unknown>> = [];
    const result = await reapplyFixRoundOnMovedTip({ wt: wt.dir, branch: "main", leaseBaseSha: base, committedSha: committed },
      realFixRoundReapplyPorts, (step, extra) => log.push({ step, ...(extra ?? {}) }));
    assert.equal(result.reapplied, false);
    assert.deepEqual(log.map((row) => row.step), ["fix.round_reapply_refused"]);
    assert.match(String(log[0]!.reason), /did not complete cleanly/);
    assert.equal(wt.git("rev-parse", "HEAD"), committed, "the round's commit is untouched");
    assert.equal(existsSync(join(wt.dir, wt.git("rev-parse", "--git-path", "MERGE_HEAD"))), false, "no merge is left half-done");
  } finally {
    wt.cleanup();
    upstream.cleanup();
  }
});

test("a moved branch that rewrote the round's base is refused, never merged", async () => {
  const { reapplyFixRoundOnMovedTip, realFixRoundReapplyPorts } = await load();
  const { upstream, wt, base, committed } = roundOnMovedBranch("reapply-rewrite", "other.txt", "x\n");
  try {
    upstream.git("reset", "--hard", "HEAD~2");
    writeFileSync(join(upstream.dir, "rewritten.txt"), "history rewritten\n");
    upstream.git("add", "-A");
    upstream.git("commit", "-m", "a force-pushed history");
    const log: Array<{ step: string } & Record<string, unknown>> = [];
    const result = await reapplyFixRoundOnMovedTip({ wt: wt.dir, branch: "main", leaseBaseSha: base, committedSha: committed },
      realFixRoundReapplyPorts, (step, extra) => log.push({ step, ...(extra ?? {}) }));
    assert.equal(result.reapplied, false);
    assert.deepEqual(log.map((row) => row.step), ["fix.round_reapply_refused"]);
    assert.match(String(log[0]!.reason), /rewrote/);
    assert.equal(wt.git("rev-parse", "HEAD"), committed);
  } finally {
    wt.cleanup();
    upstream.cleanup();
  }
});

test("a remote that did not move, or already holds the round's commit, needs no re-apply", async () => {
  const { planFixRoundReapply } = await load();
  const never = () => { throw new Error("ancestry must not be read"); };
  assert.equal(planFixRoundReapply({ leaseBaseSha: "a", committedSha: "c", remoteTip: "a", isAncestor: never }).action, "none");
  assert.equal(planFixRoundReapply({ leaseBaseSha: "a", committedSha: "c", remoteTip: "c", isAncestor: never }).action, "none");
  assert.equal(planFixRoundReapply({ leaseBaseSha: "a", committedSha: "c", remoteTip: undefined, isAncestor: never }).action, "refuse");
  const unreadable = planFixRoundReapply({ leaseBaseSha: "a", committedSha: "c", remoteTip: "d",
    isAncestor: () => { throw new Error("no such object"); } });
  assert.equal(unreadable.action, "refuse");
  assert.match(unreadable.reason, /ancestry unreadable/);
});

test("every unreadable or unexpected step of a re-apply refuses with its own reason", async () => {
  const { reapplyFixRoundOnMovedTip } = await load();
  const args = { wt: "/unused", branch: "b", leaseBaseSha: "base", committedSha: "mine" };
  const ok = {
    remoteTip: async () => "theirs",
    headSha: async () => "mine",
    isAncestor: async () => true,
    merge: async () => ({ merged: true as const, head: "merged" }),
  };
  const reasons = async (ports: typeof ok): Promise<string> => {
    const log: Array<{ step: string; reason?: unknown }> = [];
    const result = await reapplyFixRoundOnMovedTip(args, ports, (step, extra) => log.push({ step, ...(extra ?? {}) }));
    assert.equal(result.reapplied, false);
    return String(log.find((row) => row.step === "fix.round_reapply_refused")?.reason);
  };
  assert.match(await reasons({ ...ok, remoteTip: async () => { throw new Error("ls-remote died"); } }), /remote tip was unreadable/);
  assert.match(await reasons({ ...ok, isAncestor: async () => { throw new Error("bad object"); } }), /ancestry unreadable/);
  assert.match(await reasons({ ...ok, headSha: async () => { throw new Error("no HEAD"); } }), /head was unreadable/);
  assert.match(await reasons({ ...ok, headSha: async () => "someone-else" }), /is not this round's commit/);
  assert.match(await reasons({ ...ok, merge: async () => { throw new Error("fetch failed"); } }), /merge failed: Error: fetch failed/);
  const done = await reapplyFixRoundOnMovedTip(args, ok, () => {});
  assert.deepEqual(done, { reapplied: true, mergedHeadSha: "merged", remoteTip: "theirs" });
});
