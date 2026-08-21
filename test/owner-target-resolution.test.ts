import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDaemonTarget, resolveReviewTarget } from "../src/run-task.js";

/**
 * W1-T1062 ACCEPTANCE 1: "a bare repo flag keeps resolving to this checkout's own owner, so
 * every existing config and plan behaves exactly as it does today."
 *
 * `resolveDaemonTarget` is the pure resolver `rmd daemon --repo ...` runs through
 * (test/run-task.test.ts already covers its pre-W1-T1062 self-refusal/--plan/--dry-run
 * behaviour — untouched by this task). These tests isolate the ONE thing W1-T1062 could have
 * broken for every EXISTING (bare-name) caller: the owner it resolves to.
 */

const dEnv = { selfOwner: "craigoley", selfRepo: "remudero", repoRoot: "/repo", reposDir: "/root/repos" };

test("resolveDaemonTarget: a bare --repo <name> (no slash) still resolves to THIS checkout's own owner", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "remudero-sandbox"]) as { target: any };
  assert.ok(r.target, "a different-repo-name, same-owner target is never refused");
  assert.equal(r.target.owner, dEnv.selfOwner);
  assert.equal(r.target.repo, "remudero-sandbox");
});

test("resolveDaemonTarget: no --repo at all defaults BOTH owner and repo to this checkout's own (the self-host case)", () => {
  const r = resolveDaemonTarget(dEnv, ["--allow-self-target"]) as { target: any };
  assert.ok(r.target);
  assert.equal(r.target.owner, dEnv.selfOwner);
  assert.equal(r.target.repo, dEnv.selfRepo);
  assert.equal(r.target.isSelf, true);
});

test("resolveDaemonTarget: a bare-name target's plan is still read from THIS checkout's reposDir clone -- planPath derivation is unaffected", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "remudero-sandbox"]) as { target: any };
  assert.equal(r.target.planPath, "/root/repos/remudero-sandbox/plan/tasks.yaml");
});

test("resolveDaemonTarget: a bare-name target's owner matches resolveReviewTarget's OWN bare-name default EXACTLY -- proves the SAME splitter, not a second independently-tuned one", () => {
  const defaults = { owner: dEnv.selfOwner, repo: dEnv.selfRepo };
  const viaDaemon = resolveDaemonTarget(dEnv, ["--repo", "some-other-repo", "--allow-self-target"]) as { target: any };
  const viaReview = resolveReviewTarget(defaults, ["--repo", "some-other-repo"]);
  assert.equal(viaDaemon.target.owner, viaReview.owner);
  assert.equal(viaDaemon.target.repo, viaReview.repo);
});

test("resolveDaemonTarget: --dry-run against a bare-name target still previews with the self owner, unrefused, unrefusing", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "remudero-sandbox", "--dry-run"]) as { target: any };
  assert.ok(r.target);
  assert.equal(r.target.owner, dEnv.selfOwner);
  assert.equal(r.target.dryRun, true);
});
