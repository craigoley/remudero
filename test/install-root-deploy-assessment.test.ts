import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assessInstallForDeploy, inspectInstallRoot } from "../src/lib/install-root.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T3605: A CONCURRENT FETCH RACE CRASHES THE SUPERVISOR TICK ──────────────────────────
//
// Measured on the live Azure host: 124 of 275 watchdog ticks in 24h died with an UNCAUGHT
// `git fetch` failure — "cannot lock ref 'refs/remotes/origin/heartbeat-azure': is at A but
// expected B" — a concurrent writer (heartbeat-azure is force-pushed on the same 5-minute
// cadence as the watchdog), never corruption. `deployRunCommand`'s own contract says
// assessInstallForDeploy is "FAIL SAFE, NOT FAIL FAST": every unfitness kind is a NAMED no-op,
// never a throw. A failing fetch was a sixth kind that was never enumerated, so it escaped
// uncaught. This file drives that failure deterministically and proves it is now a named no-op,
// discriminated from an unrelated failure kind (a genuinely unreadable install root) rather than
// collapsed into the same reason.
//
// Real, throwaway git repos throughout — same discipline as test/install-root.test.ts's own
// fixtures (gitFixture()-style, no stubbing of git itself). Only the `fetch` subcommand is
// faked, via the module's existing `execFile` injection point (`InstallRootDeps.execFile`);
// every other git invocation in a test below (rev-parse, status, merge-base, symbolic-ref,
// clone) hits the real `git` binary against a real checkout.

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function buildOrigin(dir: string): { originDir: string } {
  const originDir = join(dir, "origin.git");
  const seedDir = join(dir, "seed");
  // `-b main` on the bare side too, matching test/install-root.test.ts's own buildOrigin — else
  // the bare repo's HEAD symref stays on whatever `init.defaultBranch` the host configures.
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", originDir]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seedDir]);
  git(seedDir, ["config", "user.email", "t@example.invalid"]);
  git(seedDir, ["config", "user.name", "Test"]);
  git(seedDir, ["remote", "add", "origin", originDir]);
  writeFileSync(join(seedDir, "marker.txt"), "v1\n");
  git(seedDir, ["add", "."]);
  git(seedDir, ["commit", "--quiet", "-m", "v1"]);
  git(seedDir, ["push", "--quiet", "origin", "main"]);
  return { originDir };
}

/** A real clone of `originDir`, with user.* configured so commits inside it can succeed. */
function cloneFrom(originDir: string, dest: string): void {
  execFileSync("git", ["clone", "--quiet", originDir, dest]);
  git(dest, ["config", "user.email", "t@example.invalid"]);
  git(dest, ["config", "user.name", "Test"]);
}

function withTmp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}install-root-fetch-race-`));
  return body(dir);
}

/** The real `execFile`, except a `git ... fetch ...` call throws the exact ref-lock message
 *  measured on the live fleet — every other subcommand (rev-parse/status/merge-base/
 *  symbolic-ref) still hits the real `git` binary. */
function execFileFailingFetch(cmd: string, args: string[]): string {
  if (args.includes("fetch")) {
    throw new Error(
      "Command failed: git -C <daemon-install> fetch --quiet origin\n" +
        "error: cannot lock ref 'refs/remotes/origin/heartbeat-azure': " +
        "is at 153f6189... but expected 2e28d2f8...",
    );
  }
  return execFileSync(cmd, args, { encoding: "utf8" }).toString();
}

// ── Acceptance 1: a non-zero fetch yields a named unfit assessment, not an uncaught error ──

test("inspectInstallRoot: a failing fetch is a named no-op (unfit: fetch-failed), never an uncaught throw", () => {
  withTmp((dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);

    // Falsifier check embedded: absent the fix's try/catch, this call throws instead of
    // returning — `assert.doesNotThrow` would be redundant since a throw fails the test anyway,
    // so the state shape itself is the proof.
    const state = inspectInstallRoot(installDir, { execFile: execFileFailingFetch });

    assert.equal(state.status, "unfit");
    assert.equal(state.status === "unfit" && state.reason, "fetch-failed");
    assert.match(state.status === "unfit" ? state.detail : "", /cannot lock ref|concurrent/);
  });
});

test("assessInstallForDeploy: a failing fetch no-ops with a named reason instead of throwing out of the deploy gate", () => {
  withTmp((dir) => {
    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    const operatorDir = join(dir, "operator");
    cloneFrom(originDir, installDir);
    mkdirSync(operatorDir, { recursive: true });

    const assessment = assessInstallForDeploy(installDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
      deps: { execFile: execFileFailingFetch },
    });

    assert.equal(assessment.ok, false);
    assert.match(assessment.ok === false ? assessment.reason : "", /fetch-failed/);
  });
});

// ── Acceptance 2: a genuinely unreadable install root is still named apart from a fetch race ──

test("inspectInstallRoot: a non-repo directory (NOT-A-REPO) is a different state than a fetch race, never collapsed together", () => {
  withTmp((dir) => {
    const target = join(dir, "junk");
    mkdirSync(target);
    writeFileSync(join(target, "readme.txt"), "not a repo\n");

    // The failing-fetch stub is wired in but must never be reached: NOT-A-REPO short-circuits
    // before any git subprocess runs at all, which is itself part of what keeps the two states
    // distinct rather than funneling both through the same fetch-catch code path.
    const state = inspectInstallRoot(target, { execFile: execFileFailingFetch });

    assert.equal(state.status, "not-a-repo");
    assert.notEqual(state.status, "unfit");
  });
});

test("assessInstallForDeploy: an unreadable install root and a transient fetch race are discriminated, not the same reason string", () => {
  withTmp((dir) => {
    const operatorDir = join(dir, "operator");
    mkdirSync(operatorDir, { recursive: true });

    const junkDir = join(dir, "junk");
    mkdirSync(junkDir);
    writeFileSync(join(junkDir, "readme.txt"), "not a repo\n");
    const unreadable = assessInstallForDeploy(junkDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
    });

    const { originDir } = buildOrigin(dir);
    const installDir = join(dir, "install");
    cloneFrom(originDir, installDir);
    const fetchRace = assessInstallForDeploy(installDir, {
      operatorRepoRoot: operatorDir,
      stateRoot: join(dir, "state"),
      deps: { execFile: execFileFailingFetch },
    });

    assert.equal(unreadable.ok, false);
    assert.equal(fetchRace.ok, false);
    const unreadableReason = unreadable.ok === false ? unreadable.reason : "";
    const fetchRaceReason = fetchRace.ok === false ? fetchRace.reason : "";

    // THE discriminating assertion the falsifier names: collapse both reasons into one string
    // and this fails.
    assert.notEqual(unreadableReason, fetchRaceReason);
    assert.match(unreadableReason, /not a git checkout/);
    assert.match(fetchRaceReason, /fetch-failed/);
  });
});
