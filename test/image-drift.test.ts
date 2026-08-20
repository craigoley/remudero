/**
 * test/image-drift.test.ts — W1-T1021: THE RUNNING IMAGE CAN FALL ARBITRARILY FAR BEHIND MAIN
 * AND NOTHING NOTICES.
 *
 * REAL GIT FIXTURES, NOT A MOCKED PLUMBING LAYER — same discipline test/self-sync.test.ts
 * already applies to `checkServiceFreshness`: `checkImageDrift`'s default `git` dep IS
 * `execFileSync("git", ...)`, so these tests build a real, throwaway repo and drive the real
 * `cat-file`/`log`/`merge-base --is-ancestor` plumbing rather than asserting against a fake that
 * could silently drift from what git actually does.
 *
 * ONLY `readStamp` is faked (never a real `/etc/rmd-build-sha` — that file is a fixed,
 * environment-specific path this test suite must not depend on).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkImageDrift, IMAGE_DRIFT_STEP } from "../src/lib/image-drift.js";
import { serviceFreshnessGate } from "../src/run-task.js";
import type { ServiceFreshness } from "../src/lib/self-sync.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A real, throwaway repo carrying BOTH a baked path (`deploy/entrypoint.sh`) and a
 *  never-baked source path (`src/foo.ts`) — the exact split this detector's whole predicate
 *  rests on. Returns the repo dir plus a `commit` helper that writes+commits and returns the
 *  new HEAD sha, so each test can narrate its own commit sequence. */
function repoFixture(): { dir: string; commit: (path: string, content: string, message: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-image-drift-"));
  mkdirSync(join(dir, "deploy"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "deploy", "entrypoint.sh"), "#!/bin/sh\necho boot\n");
  writeFileSync(join(dir, "deploy", "Dockerfile"), "FROM node:22-bookworm-slim\n");
  writeFileSync(join(dir, "src", "foo.ts"), "export const foo = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "init: baked + source paths"]);
  const commit = (path: string, content: string, message: string): string => {
    writeFileSync(join(dir, path), content);
    git(dir, ["add", path]);
    git(dir, ["commit", "--quiet", "-m", message]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  return { dir, commit };
}

test("W1-T1021: a source-only merge does not report image drift", () => {
  const { dir, commit } = repoFixture();
  // A commit touching ONLY src/ — never deploy/entrypoint.sh or deploy/Dockerfile.
  const buildSha = commit("src/foo.ts", "export const foo = 2;\n", "src-only change");
  const finding = checkImageDrift(dir, { readStamp: () => buildSha });
  assert.equal(finding.status, "fresh", `a source-only merge must never report drift (got ${JSON.stringify(finding)})`);
});

test("W1-T1021: a baked entrypoint change after the build reports drift", () => {
  const { dir, commit } = repoFixture();
  const buildSha = git(dir, ["rev-parse", "HEAD"]); // the image was built at the INIT commit
  // AFTER the build, deploy/entrypoint.sh changes on main — the image never picked it up.
  const bakedSha = commit("deploy/entrypoint.sh", "#!/bin/sh\necho boot v2\n", "entrypoint: v2");
  const finding = checkImageDrift(dir, { readStamp: () => buildSha });
  assert.equal(finding.status, "drift");
  assert.equal((finding as { buildSha: string }).buildSha, buildSha);
  assert.equal((finding as { bakedSha: string }).bakedSha, bakedSha);
});

test("W1-T1021: an absent build sha file reports not applicable", () => {
  const { dir } = repoFixture();
  const finding = checkImageDrift(dir, { readStamp: () => undefined });
  assert.deepEqual(finding, { status: "not-applicable" });
});

test("W1-T1021: a non sha build stamp reports unmeasurable", () => {
  const { dir } = repoFixture();
  // deploy/Dockerfile's own `ARG RMD_BUILD_SHA=unknown` default — a hand-built image without
  // the build arg writes exactly this literal.
  const finding = checkImageDrift(dir, { readStamp: () => "unknown" });
  assert.equal(finding.status, "unmeasurable");
});

test("W1-T1021: a build sha this checkout's history cannot resolve reports unmeasurable, never drift", () => {
  const { dir } = repoFixture();
  const finding = checkImageDrift(dir, { readStamp: () => "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  assert.equal(finding.status, "unmeasurable");
});

test("checkImageDrift: a stamp file that is genuinely absent from disk (default readStamp) degrades to not-applicable, never throws", () => {
  const finding = checkImageDrift("/nonexistent/repo/for/tests", { stampPath: join(tmpdir(), `rmd-image-drift-stamp-absent-${process.pid}`) });
  assert.deepEqual(finding, { status: "not-applicable" });
});

test("checkImageDrift: neither baked path has ever been touched -> fresh (nothing to be behind)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-image-drift-nobaked-"));
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "no deploy/ at all\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "init, no baked paths"]);
  const buildSha = git(dir, ["rev-parse", "HEAD"]);
  const finding = checkImageDrift(dir, { readStamp: () => buildSha });
  assert.deepEqual(finding, { status: "fresh", buildSha });
});

// ── ACCEPTANCE 5: the daemon freshness gate reaches the check, ledgering IMAGE_DRIFT_STEP on a
// drift finding and nothing on the other three outcomes — same assess/emit split as the
// daemon.tree_dirty/daemon.stale_code pair it sits beside ─────────────────────────────────────

function readSteps(ledgerPath: string): string[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).step as string);
}

const ASSESSED_CLEAN: ServiceFreshness = { status: "assessed", dirty: false, behind: null };

test("W1-T1021: the freshness gate reaches the image drift check", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-image-drift-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  let calls = 0;
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => ASSESSED_CLEAN,
    ledgerPath,
    ensureInstallFresh: () => false,
    checkImageDrift: () => {
      calls++;
      return { status: "fresh", buildSha: "abc1234" };
    },
  });
  assert.equal(calls, 1, "serviceFreshnessGate must reach checkImageDrift on every assessed tick");
  assert.deepEqual(readSteps(ledgerPath), [], "a fresh finding ledgers nothing");
});

test("serviceFreshnessGate: a DRIFT finding ledgers daemon.image_drift with both shas", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-image-drift-drift-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => ASSESSED_CLEAN,
    ledgerPath,
    ensureInstallFresh: () => false,
    checkImageDrift: () => ({ status: "drift", buildSha: "aaaaaaa", bakedSha: "bbbbbbb" }),
  });
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const row = lines.find((l) => l.step === IMAGE_DRIFT_STEP);
  assert.ok(row, "daemon.image_drift must be ledgered on a drift finding");
  assert.equal(row.build_sha, "aaaaaaa");
  assert.equal(row.baked_sha, "bbbbbbb");
});

test("serviceFreshnessGate: not-applicable and unmeasurable findings ledger nothing — never a guessed drift", () => {
  for (const finding of [{ status: "not-applicable" as const }, { status: "unmeasurable" as const, reason: "no history" }]) {
    const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-image-drift-degraded-"));
    const ledgerPath = join(dir, "ledger.ndjson");
    serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
      checkServiceFreshness: () => ASSESSED_CLEAN,
      ledgerPath,
      ensureInstallFresh: () => false,
      checkImageDrift: () => finding,
    });
    assert.deepEqual(readSteps(ledgerPath), [], `${finding.status} must ledger nothing`);
  }
});

test("serviceFreshnessGate: guarded/degraded NEVER consults checkImageDrift at all — a service is never blocked checking its own image", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-image-drift-guard-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  let calls = 0;
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    ledgerPath,
    checkImageDrift: () => {
      calls++;
      return { status: "fresh", buildSha: "abc1234" };
    },
  });
  assert.equal(calls, 0, "guarded status short-circuits before checkImageDrift is ever consulted");
});
