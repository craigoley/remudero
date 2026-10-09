import assert from "node:assert/strict";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";

// Namespace-loaded so the base tree (which lacks the module) fails inside the tests, not at link time.
const loadBase = async () => (await import("../src/lib/fix-round-base.js")) as typeof import("../src/lib/fix-round-base.js");

function advancedBranch() {
  const repo = gitRepo({ branch: "run-unfiled-1" });
  repo.git("config", "user.name", "round fixture");
  repo.git("config", "user.email", "round@remudero.invalid");
  repo.git("commit", "--allow-empty", "-qm", "snapshot head");
  const snapshot = repo.git("rev-parse", "HEAD");
  repo.git("commit", "--allow-empty", "-qm", "Merge branch 'main' into run-unfiled-1");
  const advanced = repo.git("rev-parse", "HEAD");
  const isAncestor = (a: string, d: string) => {
    try {
      repo.git("merge-base", "--is-ancestor", a, d);
      return true;
    } catch {
      return false;
    }
  };
  return { repo, snapshot, advanced, isAncestor };
}

test("a fix round started on a merge-forward of its snapshot guards the tip it started from", async (t) => {
  const { fixRoundBaseHead } = await loadBase();
  const { repo, snapshot, advanced, isAncestor } = advancedBranch();
  t.after(() => repo.cleanup());
  const base = fixRoundBaseHead({ snapshotHeadSha: snapshot, startedFromSha: advanced, isAncestor });
  assert.equal(base.advanced, true);
  assert.equal(base.baseSha, advanced);
  assert.match(base.reason, /advanced/);
});

test("a fix round whose starting tip rewrote the snapshot keeps the snapshot guard", async (t) => {
  const { fixRoundBaseHead } = await loadBase();
  const { repo, snapshot, isAncestor } = advancedBranch();
  t.after(() => repo.cleanup());
  repo.git("checkout", "-q", "--orphan", "rewritten");
  repo.git("commit", "--allow-empty", "-qm", "unrelated history");
  const rewritten = repo.git("rev-parse", "HEAD");
  const base = fixRoundBaseHead({ snapshotHeadSha: snapshot, startedFromSha: rewritten, isAncestor });
  assert.equal(base.advanced, false);
  assert.equal(base.baseSha, snapshot);
});

test("a fix round with an unreadable starting tip keeps the snapshot guard", async () => {
  const { fixRoundBaseHead } = await loadBase();
  const base = fixRoundBaseHead({ snapshotHeadSha: "a".repeat(40), startedFromSha: undefined, isAncestor: () => true });
  assert.equal(base.advanced, false);
  assert.equal(base.baseSha, "a".repeat(40));
});
