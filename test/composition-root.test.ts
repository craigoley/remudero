import assert from "node:assert/strict";
import { test } from "node:test";
import { composeRealDeps } from "../src/lib/composition-root.js";

test("composeRealDeps builds every top-level real seam from a fake config without calling it", () => {
  let loadConfigCalls = 0;
  const graph = composeRealDeps({
    repoRoot: "/tmp/remudero-fake-repo",
    loadConfig: () => {
      loadConfigCalls += 1;
      throw new Error("fake config must be callable later, not during composition");
    },
  });

  assert.equal(loadConfigCalls, 0, "composition itself must not shell out through loadConfig");

  assert.equal(typeof graph.arm.headSha, "function");
  assert.equal(typeof graph.deployFor, "function");
  assert.equal(typeof graph.gitRemote.getRemoteUrl, "function");
  assert.equal(typeof graph.onboard.fs.existsSync, "function");
  assert.equal(typeof graph.onboard.gh.repoInfo, "function");
  assert.equal(typeof graph.onboard.resolveOwnerRepo, "function");
  assert.equal(typeof graph.recon.fs.readFileSync, "function");
  assert.equal(typeof graph.recon.gh.listOpenIssues, "function");
  assert.equal(typeof graph.reviewWorktree.fetch, "function");
  assert.equal(typeof graph.reviewWorktree.addWorktree, "function");
  assert.equal(typeof graph.reviewWorktree.revParseHead, "function");
  assert.equal(typeof graph.session.fs.appendFileSync, "function");
  assert.equal(typeof graph.sharedPauseGit.run, "function");
  assert.equal(typeof graph.sharedPauseGit.mintAnchor, "function");
  assert.equal(typeof graph.synthesize.fs.readFileSync, "function");
  assert.equal(typeof graph.synthesize.git.exec, "function");
  assert.equal(typeof graph.synthesize.gh.openPr, "function");
});
