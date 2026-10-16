// W1-T9700: the onboard and recon verbs read a target checkout's origin url through realGitRemoteDeps, which ran
// `git config --get remote.origin.url` as a synchronous child the sync-spawn census reached from daemonCommand. The
// read is now an awaited child; these tests drive the REAL default against a real fixture, which no fake reaches.
import assert from "node:assert/strict";
import { test } from "node:test";
import { realGitRemoteDeps, resolveTargetOwnerRepo } from "../src/lib/onboard/inventory.js";
import { gitRepo } from "./helpers/git-repo.js";

test("W1-T9700: the real remote read resolves a fixture origin through an awaited child", async () => {
  const target = gitRepo({ kind: "w1t9700-origin" });
  try {
    target.addRemote("origin", "git@github.com:acme-corp/widget-fixture.git");
    const pendingUrl = realGitRemoteDeps.getRemoteUrl(target.dir);
    assert.ok(pendingUrl instanceof Promise, "the real reader returns a promise over an awaited git child");
    assert.equal(await pendingUrl, "git@github.com:acme-corp/widget-fixture.git");

    const pending = resolveTargetOwnerRepo(target.dir);
    assert.ok(pending instanceof Promise, "resolveTargetOwnerRepo is awaited, never a synchronous read");
    assert.deepEqual(await pending, { owner: "acme-corp", repo: "widget-fixture" });
  } finally {
    target.cleanup();
  }
});

test("W1-T9700: a fixture with no origin resolves undefined, never a guess", async () => {
  const target = gitRepo({ kind: "w1t9700-no-origin" });
  try {
    await assert.rejects(realGitRemoteDeps.getRemoteUrl(target.dir), "git config exits non-zero with no origin set");
    assert.equal(await resolveTargetOwnerRepo(target.dir), undefined);

    // An origin that does not parse as owner/repo is unresolved too.
    target.addRemote("origin", "not-a-remote");
    assert.equal(await resolveTargetOwnerRepo(target.dir), undefined);
  } finally {
    target.cleanup();
  }
});
