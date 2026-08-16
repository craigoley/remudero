import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assessInstallForDeploy,
  checkInstallSeparation,
  describeInstallState,
  inspectInstallRoot,
  provisionInstallRoot,
  resolveInstallRoot,
} from "../src/lib/install-root.js";
import { runDeployCycle, type DeployDeps } from "../src/lib/deployer.js";

// ── W1-T924: the daemon's dedicated install checkout. Real, throwaway git repos throughout (no
// mocking of git itself) — same discipline as test/self-sync.test.ts's gitFixture() and
// scripts/recovery-drill.mjs's exerciseDeployRollback(), both cited as prior art by this task's
// own note: "a separation proven only against a stubbed git runner would pass while the real
// `-C <path>` still pointed at the operator's tree, which is the defect one level down."

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/**
 * A throwaway bare origin + a "seed" repo that pushes to it — the real remote a clone/fetch/ff
 * exercises against. Mirrors recovery-drill.mjs's exerciseDeployRollback() fixture shape.
 */
function buildOrigin(dir: string): { originDir: string; seedDir: string; v1Sha: string } {
  const originDir = join(dir, "origin.git");
  const seedDir = join(dir, "seed");
  // `-b main` on the BARE side too — without it, the bare repo's HEAD symref stays pointed at
  // whatever `init.defaultBranch` this host configures (often `master`), the first push to
  // `main` never updates an unborn HEAD, and every subsequent `git clone` checks out nothing:
  // "warning: remote HEAD refers to nonexistent ref, unable to checkout" -> a HEAD-less clone.
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", originDir]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seedDir]);
  git(seedDir, ["config", "user.email", "t@example.invalid"]);
  git(seedDir, ["config", "user.name", "Test"]);
  git(seedDir, ["remote", "add", "origin", originDir]);
  writeFileSync(join(seedDir, "marker.txt"), "v1\n");
  git(seedDir, ["add", "."]);
  git(seedDir, ["commit", "--quiet", "-m", "v1"]);
  git(seedDir, ["push", "--quiet", "origin", "main"]);
  const v1Sha = git(seedDir, ["rev-parse", "HEAD"]);
  return { originDir, seedDir, v1Sha };
}

/** Publish one more commit from the seed repo to origin/main; returns the new sha. */
function publish(seedDir: string, content: string): string {
  writeFileSync(join(seedDir, "marker.txt"), content);
  git(seedDir, ["add", "."]);
  git(seedDir, ["commit", "--quiet", "-m", content]);
  git(seedDir, ["push", "--quiet", "origin", "main"]);
  return git(seedDir, ["rev-parse", "HEAD"]);
}

/** A real clone of `originDir`, with user.* configured so commits inside it can succeed. */
function cloneFrom(originDir: string, dest: string): void {
  execFileSync("git", ["clone", "--quiet", originDir, dest]);
  git(dest, ["config", "user.email", "t@example.invalid"]);
  git(dest, ["config", "user.name", "Test"]);
}

function withTmp<T>(prefix: string, body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return body(dir);
}

// ── resolveInstallRoot ───────────────────────────────────────────────────────────────────────

test("resolveInstallRoot defaults to <config.root>/daemon-install, derived not hardcoded", () => {
  const got = resolveInstallRoot({ root: "/x/Remudero" });
  assert.equal(got, join("/x/Remudero", "daemon-install"));
});

test("resolveInstallRoot honors an explicit config.installRoot override", () => {
  const got = resolveInstallRoot({ root: "/x/Remudero", installRoot: "/custom/install" });
  assert.equal(got, "/custom/install");
});

// ── checkInstallSeparation ───────────────────────────────────────────────────────────────────

test("checkInstallSeparation refuses when the state root resolves inside the install root", () => {
  const result = checkInstallSeparation({
    installRoot: "/Remudero/daemon-install",
    stateRoot: "/Remudero/daemon-install/state",
    operatorRepoRoot: "/Users/craig/remudero",
  });
  assert.equal(result.ok, false);
});

test("checkInstallSeparation refuses when the install root equals the operator checkout (today's production configuration)", () => {
  const result = checkInstallSeparation({
    installRoot: "/Users/craig/remudero",
    stateRoot: "/Remudero/state",
    operatorRepoRoot: "/Users/craig/remudero",
  });
  assert.equal(result.ok, false);
});

test("checkInstallSeparation refuses when the install root is nested inside the operator checkout", () => {
  const result = checkInstallSeparation({
    installRoot: "/Users/craig/remudero/daemon-install",
    stateRoot: "/Remudero/state",
    operatorRepoRoot: "/Users/craig/remudero",
  });
  assert.equal(result.ok, false);
});

test("checkInstallSeparation accepts a properly separated layout", () => {
  const result = checkInstallSeparation({
    installRoot: "/Remudero/daemon-install",
    stateRoot: "/Remudero/state",
    operatorRepoRoot: "/Users/craig/remudero",
  });
  assert.equal(result.ok, true);
});

// ── inspectInstallRoot: the four named states ───────────────────────────────────────────────

test("inspectInstallRoot: a path that does not exist is ABSENT", () => {
  withTmp("rmd-install-root-", (dir) => {
    const state = inspectInstallRoot(join(dir, "nope"));
    assert.equal(state.status, "absent");
  });
});

test("inspectInstallRoot: an existing EMPTY directory is ABSENT (a valid clone target)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const target = join(dir, "empty");
    mkdirSync(target);
    const state = inspectInstallRoot(target);
    assert.equal(state.status, "absent");
  });
});

test("inspectInstallRoot: a non-empty directory with no .git is NOT-A-REPO", () => {
  withTmp("rmd-install-root-", (dir) => {
    const target = join(dir, "junk");
    mkdirSync(target);
    writeFileSync(join(target, "readme.txt"), "not a repo\n");
    const state = inspectInstallRoot(target);
    assert.equal(state.status, "not-a-repo");
  });
});

test("inspectInstallRoot: a clean checkout on main, current with origin, is HEALTHY", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    const state = inspectInstallRoot(installDir);
    assert.equal(state.status, "healthy");
  });
});

test("inspectInstallRoot: a clean checkout on main, BEHIND origin, is still HEALTHY (ff possible)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir, seedDir, v1Sha } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    git(installDir, ["reset", "--quiet", "--hard", v1Sha]);
    publish(seedDir, "v2\n");
    const state = inspectInstallRoot(installDir);
    assert.equal(state.status, "healthy");
  });
});

test("inspectInstallRoot: uncommitted local modifications -> UNFIT(dirty)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    writeFileSync(join(installDir, "marker.txt"), "operator touched this\n");
    const state = inspectInstallRoot(installDir);
    assert.equal(state.status, "unfit");
    assert.equal(state.status === "unfit" && state.reason, "dirty");
  });
});

test("inspectInstallRoot: a local commit origin/main does not have -> UNFIT(diverged)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    writeFileSync(join(installDir, "local-only.txt"), "never pushed\n");
    git(installDir, ["add", "."]);
    git(installDir, ["commit", "--quiet", "-m", "local commit"]);
    const state = inspectInstallRoot(installDir);
    assert.equal(state.status, "unfit");
    assert.equal(state.status === "unfit" && state.reason, "diverged");
  });
});

test("inspectInstallRoot: on a feature branch (not main) -> UNFIT(off-main)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    git(installDir, ["checkout", "--quiet", "-b", "feature"]);
    const state = inspectInstallRoot(installDir);
    assert.equal(state.status, "unfit");
    assert.equal(state.status === "unfit" && state.reason, "off-main");
  });
});

test("inspectInstallRoot: a detached HEAD -> UNFIT(off-main)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir, v1Sha } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    git(installDir, ["checkout", "--quiet", "--detach", v1Sha]);
    const state = inspectInstallRoot(installDir);
    assert.equal(state.status, "unfit");
    assert.equal(state.status === "unfit" && state.reason, "off-main");
  });
});

// ── provisionInstallRoot: PROVISION-OR-REFUSE, mutating only on ABSENT/HEALTHY ─────────────

test("provisionInstallRoot: ABSENT -> clones origin/main into it", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir, v1Sha } = buildOrigin(dir);
    const installDir = join(dir, "install");
    const outcome = provisionInstallRoot(installDir, originDir);
    assert.equal(outcome.action, "cloned");
    assert.equal(outcome.action === "cloned" && outcome.headSha, v1Sha);
    assert.equal(git(installDir, ["rev-parse", "HEAD"]), v1Sha);
    assert.equal(git(installDir, ["symbolic-ref", "--short", "HEAD"]), "main");
  });
});

test("provisionInstallRoot: HEALTHY + behind -> ff-only to origin/main, nothing else", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir, seedDir, v1Sha } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    git(installDir, ["reset", "--quiet", "--hard", v1Sha]);
    const v2Sha = publish(seedDir, "v2\n");

    const outcome = provisionInstallRoot(installDir, originDir);
    assert.equal(outcome.action, "fast-forwarded");
    assert.equal(outcome.action === "fast-forwarded" && outcome.fromSha, v1Sha);
    assert.equal(outcome.action === "fast-forwarded" && outcome.toSha, v2Sha);
    assert.equal(git(installDir, ["rev-parse", "HEAD"]), v2Sha);
  });
});

test("provisionInstallRoot: HEALTHY + already current -> up-to-date, no mutation", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir, v1Sha } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    const outcome = provisionInstallRoot(installDir, originDir);
    assert.equal(outcome.action, "up-to-date");
    assert.equal(outcome.action === "up-to-date" && outcome.headSha, v1Sha);
  });
});

test("provisionInstallRoot: NOT-A-REPO -> refused, directory left byte-for-byte untouched (never rm -rf)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const target = join(dir, "junk");
    mkdirSync(target);
    writeFileSync(join(target, "readme.txt"), "not a repo\n");
    const outcome = provisionInstallRoot(target, originDir);
    assert.equal(outcome.action, "refused");
    assert.equal(outcome.action === "refused" && outcome.reason, "not-a-repo");
    assert.equal(readFileSync(join(target, "readme.txt"), "utf8"), "not a repo\n");
  });
});

test("provisionInstallRoot: DIRTY -> refused, the local edit is left in place (never reset --hard)", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    writeFileSync(join(installDir, "marker.txt"), "operator touched this\n");
    const outcome = provisionInstallRoot(installDir, originDir);
    assert.equal(outcome.action, "refused");
    assert.equal(outcome.action === "refused" && outcome.reason, "dirty");
    assert.equal(readFileSync(join(installDir, "marker.txt"), "utf8"), "operator touched this\n");
  });
});

test("provisionInstallRoot: off-main -> refused, the branch is left exactly where it was", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    git(installDir, ["checkout", "--quiet", "-b", "feature"]);
    const outcome = provisionInstallRoot(installDir, originDir);
    assert.equal(outcome.action, "refused");
    assert.equal(outcome.action === "refused" && outcome.reason, "off-main");
    assert.equal(git(installDir, ["symbolic-ref", "--short", "HEAD"]), "feature");
  });
});

// ── describeInstallState: names the state, never silent ────────────────────────────────────

test("describeInstallState names the specific defect for every non-healthy state", () => {
  const path = "/Remudero/daemon-install";
  assert.match(describeInstallState(path, { status: "absent" }), /absent/);
  assert.match(describeInstallState(path, { status: "not-a-repo" }), /not a git checkout/);
  assert.match(
    describeInstallState(path, { status: "unfit", reason: "dirty", detail: "1 locally-modified path(s)" }),
    /dirty/,
  );
  assert.match(describeInstallState(path, { status: "healthy", headSha: "a".repeat(40) }), /healthy/);
});

// ── assessInstallForDeploy: the deploy-path gate — fail SAFE, never falls back ──────────────

test("assessInstallForDeploy: a healthy, separated install resolves to the install root, not the operator checkout", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    const operatorDir = join(dir, "operator");
    cloneFrom(originDir, installDir);
    cloneFrom(originDir, operatorDir);

    const assessment = assessInstallForDeploy(installDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
    });
    assert.equal(assessment.ok, true);
    assert.equal(assessment.ok && assessment.installRoot, installDir);
    assert.notEqual(assessment.ok && assessment.installRoot, operatorDir);
  });
});

test("assessInstallForDeploy: install root == operator checkout (today's production configuration) refuses, names the violation, never returns a usable path", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const sharedDir = join(dir, "shared");
    cloneFrom(originDir, sharedDir);

    const assessment = assessInstallForDeploy(sharedDir, {
      operatorRepoRoot: sharedDir,
      stateRoot: join(dir, "state"),
    });
    assert.equal(assessment.ok, false);
    assert.match(assessment.ok === false ? assessment.reason : "", /install root .* resolves INSIDE the operator/);
  });
});

test("assessInstallForDeploy: an ABSENT install root no-ops with a named reason — never falls back to the operator checkout", () => {
  withTmp("rmd-install-root-", (dir) => {
    const operatorDir = join(dir, "operator");
    mkdirSync(operatorDir, { recursive: true });
    const installDir = join(dir, "install"); // never created

    const assessment = assessInstallForDeploy(installDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
    });
    assert.equal(assessment.ok, false);
    assert.match(assessment.ok === false ? assessment.reason : "", /absent/);
    // The whole point: nothing here ever hands back `operatorDir` as a substitute.
    assert.notEqual(assessment.ok, true);
  });
});

test("assessInstallForDeploy: dirt in the OPERATOR checkout changes neither the resolved install root nor the verdict", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    const operatorDir = join(dir, "operator");
    cloneFrom(originDir, installDir);
    cloneFrom(originDir, operatorDir);

    const cleanAssessment = assessInstallForDeploy(installDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
    });

    // Dirty the OPERATOR's tree three ways: untracked, tracked-modified, and a feature branch.
    writeFileSync(join(operatorDir, "untracked.txt"), "scratch\n");
    writeFileSync(join(operatorDir, "marker.txt"), "operator WIP\n");
    git(operatorDir, ["checkout", "--quiet", "-b", "operator-feature"]);

    const dirtyAssessment = assessInstallForDeploy(installDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
    });

    assert.deepEqual(dirtyAssessment, cleanAssessment);
    assert.equal(dirtyAssessment.ok, true);
    assert.equal(dirtyAssessment.ok && dirtyAssessment.installRoot, installDir);
  });
});

// ── The end-to-end deploy cycle: ASSERT THE REFS, NOT THE STATUS ───────────────────────────
//
// Wires the RESOLVED install root (via resolveInstallRoot + assessInstallForDeploy, this
// module's own primitives — the same ones deployRunCommand calls) into deployer.ts's real
// runDeployCycle, exactly as `deployRunCommand` does. launchctl/health-polling are FAKED (never
// the real daemon); the git/fs half — the part this task exists to fix — is always real, same
// discipline as scripts/recovery-drill.mjs's exerciseDeployRollback(). Per this task's own note:
// a test that only checks the reason/status would pass for an implementation that fast-forwarded
// the WRONG tree — so this asserts the actual git refs, independently re-read, on BOTH trees.

test("the deploy cycle fast-forwards the RESOLVED install root, never the checkout the command was invoked from", () => {
  withTmp("rmd-install-root-", (dir) => {
    const { originDir, seedDir, v1Sha } = buildOrigin(dir);

    // The install checkout — the ONLY tree the deploy supervisor may ever touch.
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);

    // The OPERATOR's checkout — a SEPARATE clone, deliberately dirtied (untracked + tracked
    // modification + a feature branch) to model the WIP tree the pre-fix defect fast-forwarded.
    const operatorDir = join(dir, "operator");
    cloneFrom(originDir, operatorDir);
    writeFileSync(join(operatorDir, "untracked.txt"), "scratch\n");
    writeFileSync(join(operatorDir, "marker.txt"), "operator WIP — must never be touched\n");
    git(operatorDir, ["checkout", "--quiet", "-b", "operator-feature"]);
    const operatorHeadBefore = git(operatorDir, ["rev-parse", "HEAD"]);
    const operatorMarkerBefore = readFileSync(join(operatorDir, "marker.txt"), "utf8");
    const operatorStatusBefore = git(operatorDir, ["status", "--porcelain"]);

    const config = { root: join(dir, "state-root"), installRoot: installDir };
    const installRoot = resolveInstallRoot(config);
    assert.equal(installRoot, installDir);
    const assessment = assessInstallForDeploy(installRoot, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state-root", "state"),
    });
    assert.equal(assessment.ok, true);
    assert.equal(assessment.ok && assessment.installRoot, installDir);

    // origin/main moves on AFTER the install was cloned, same as a real merged fix landing.
    const v2Sha = publish(seedDir, "v2\n");
    assert.notEqual(v2Sha, v1Sha);

    const deps: DeployDeps = {
      log: () => {},
      now: () => 0,
      fetch: () => git(installDir, ["fetch", "origin", "--quiet"]),
      installHead: () => git(installDir, ["rev-parse", "HEAD"]),
      originMain: () => git(installDir, ["rev-parse", "origin/main"]),
      markerPresent: () => true, // operator-requested deploy
      autoMode: () => false,
      lastFailedHead: () => undefined,
      runningHead: () => undefined, // unknown -> fail-eager, exactly as an unmigrated daemon reads
      dirtyFiles: () => [],
      incomingFiles: (from, to) =>
        git(installDir, ["diff", "--name-only", `${from}..${to}`])
          .split("\n")
          .filter(Boolean),
      pullFf: () => git(installDir, ["merge", "--ff-only", "--quiet", "origin/main"]),
      resetHard: (ref) => git(installDir, ["reset", "--quiet", "--hard", ref]),
      probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
      kickstart: () => {}, // NEVER the real launchctl
      waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }), // force the healthy path
      alert: () => {},
      clearMarker: () => {},
      kickstartConsole: () => {},
      consolePid: () => undefined,
      waitConsoleUp: () => true,
      alertConsoleOnly: () => {},
    };

    const result = runDeployCycle(deps);
    assert.equal(result.deployed, true);
    assert.equal(result.toHead, v2Sha);

    // ASSERT THE REFS, independently re-read from real git — never trusted from the result alone.
    assert.equal(git(installDir, ["rev-parse", "HEAD"]), v2Sha, "the INSTALL checkout must advance");
    assert.equal(
      git(operatorDir, ["rev-parse", "HEAD"]),
      operatorHeadBefore,
      "the OPERATOR checkout's HEAD must be byte-for-byte where it was",
    );
    assert.equal(
      readFileSync(join(operatorDir, "marker.txt"), "utf8"),
      operatorMarkerBefore,
      "the OPERATOR's dirty file content must be untouched",
    );
    assert.equal(
      git(operatorDir, ["status", "--porcelain"]),
      operatorStatusBefore,
      "the OPERATOR checkout's dirt must be untouched, included and all",
    );
    assert.equal(git(operatorDir, ["symbolic-ref", "--short", "HEAD"]), "operator-feature");
  });
});
