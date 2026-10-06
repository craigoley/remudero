import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { runDaemon } from "../src/lib/daemon.js";
import type { AsyncGitRunner } from "../src/lib/git-fetch-retry.js";
import { loadPlan } from "../src/lib/plan.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import type { GitLogCommit, ShippedGithub } from "../src/lib/retro.js";
import type { RunResult } from "../src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { asyncGit } from "../src/lib/self-sync.js";
import {
  buildRetroDaemonHooks,
  mergedCommitsSnapshotGateway,
  parseGitLogCitationCommits,
  readRetroMergedCommitsAsync,
  recordRetroAttempt,
  retroTriggerCheck,
  retroTriggerCheckAsync,
} from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// MEASURED 2026-10-06: the retro trigger full-history `git log` (retroShippedGithubGateway
// mergedCommits) ran as execFileSync on the daemon loop — 6 loop_lag rows, 279 s of sync spawn,
// single reads up to 54 s. The daemon now awaits one bounded async read per check.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));
const POLICY: Policy = { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro: { mergesThreshold: 1, daysThreshold: 99_999 } } };
const LOG_ARGS = ["log", "--format=%x1e%aI%x1f%s%x1f%b"];

function fixtureConfig(): Config {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-offloop-root-`));
  mkdirSync(join(root, "state"), { recursive: true });
  return { claudeBin: "/bin/true", root };
}

function healthyGithub(): ShippedGithub {
  return { findMergedByTrailer: () => null, headRefName: () => undefined, unavailable: () => undefined };
}

const COMMITS: GitLogCommit[] = [
  { date: "2026-10-05T10:00:00+00:00", message: "fix(a): one\n\nRemudero-Task: W1-T1" },
  { date: "2026-10-05T11:00:00+00:00", message: "chore(plan): file two" },
];

test("retro merged commits off the loop: a timer keeps firing while the read is pending", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let ticksWhenRead = -1;
  const slowRead = (): Promise<GitLogCommit[]> =>
    new Promise((resolve) => setTimeout(() => {
      ticksWhenRead = ticks;
      resolve(COMMITS);
    }, 120));
  try {
    const decision = await retroTriggerCheckAsync(new Date("2026-10-06T00:00:00.000Z"), {
      config: fixtureConfig(),
      github: healthyGithub(),
      policy: POLICY,
      readMergedCommits: slowRead,
    });
    assert.ok(ticksWhenRead >= 5, `the loop serviced only ${ticksWhenRead} timer ticks during the read`);
    assert.equal(decision?.fire, true);
    assert.equal(decision?.mergesSinceMarker, 2, "both commits are runless merges since an absent marker");
  } finally {
    clearInterval(timer);
  }
});

test("retro merged commits off the loop: a read past its bound is killed and fails by name", async () => {
  let aborted = false;
  const hung: AsyncGitRunner = (_args, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("killed"));
      }, { once: true });
    });
  await assert.rejects(readRetroMergedCommitsAsync(hung, 40), /git log --format=.* exceeded its 40ms bound and was killed/);
  assert.equal(aborted, true, "the bound aborts the child, it does not just stop waiting");

  const named = new Error("git log exceeded its 40ms bound and was killed");
  await assert.rejects(
    retroTriggerCheckAsync(new Date("2026-10-06T00:00:00.000Z"), {
      config: fixtureConfig(),
      github: healthyGithub(),
      policy: POLICY,
      readMergedCommits: () => Promise.reject(named),
    }),
    (e) => e === named,
    "the runless count re-throws the read failure, as the sync read threw, into check_failed",
  );
  const declined = await retroTriggerCheckAsync(new Date("2026-10-06T00:00:00.000Z"), {
    config: fixtureConfig(),
    github: { ...healthyGithub(), unavailable: () => "gh throttled" },
    policy: POLICY,
    readMergedCommits: () => Promise.reject(named),
  });
  assert.equal(declined, undefined, "an unavailable gateway still declines before the failed read is consumed");
});

test("retro merged commits off the loop: the async read parses exactly what the sync read parses", async () => {
  const repo = gitRepo({ kind: "retro-offloop" });
  repo.git("commit", "--quiet", "--allow-empty", "-m", "feat(x): first", "-m", "Remudero-Task: W1-T9");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(y): second\x1fodd");
  const sync = parseGitLogCitationCommits(execFileSync("git", ["-C", repo.dir, ...LOG_ARGS], { encoding: "utf8" }));
  const viaAsync = await readRetroMergedCommitsAsync(asyncGit(repo.dir));
  assert.ok(sync.length >= 3, `the fixture must hold at least three commits; saw ${sync.length}`);
  assert.deepEqual(viaAsync, sync);
  repo.cleanup();
});

test("retro merged commits off the loop: one check reads the commit log once, not once per consumer", async () => {
  const config = fixtureConfig();
  recordRetroAttempt(config.root, new Date("2026-09-01T00:00:00.000Z"));
  const now = new Date("2026-10-06T00:00:00.000Z");
  // POSITIVE CONTROL: on this fixture the sync check consumes the log on both the back-off and
  // the count path, so a single read below is the snapshot, not a path that never reads twice.
  let syncReads = 0;
  retroTriggerCheck(now, { config, policy: POLICY, github: { ...healthyGithub(), mergedCommits: () => (syncReads++, COMMITS) } });
  assert.ok(syncReads >= 2, `the fixture must reach two consumers; the sync check read ${syncReads} time(s)`);

  let reads = 0;
  const decision = await retroTriggerCheckAsync(now, {
    config,
    github: healthyGithub(),
    policy: POLICY,
    readMergedCommits: async () => (reads++, COMMITS),
  });
  assert.equal(reads, 1);
  assert.equal(decision?.mergesSinceMarker, 2);
});

test("retro merged commits off the loop: the default reader really shells out to this checkout", async () => {
  const sync = parseGitLogCitationCommits(
    execFileSync("git", ["-C", REPO_ROOT, ...LOG_ARGS], { encoding: "utf8", maxBuffer: 1 << 26 }),
  );
  const viaAsync = await readRetroMergedCommitsAsync();
  assert.ok(viaAsync.length > 0, "the real read returned no commits");
  assert.deepEqual(viaAsync, sync);
  const decision = await retroTriggerCheckAsync(new Date("2026-10-06T00:00:00.000Z"), {
    config: fixtureConfig(),
    github: healthyGithub(),
    policy: POLICY,
  });
  assert.ok((decision?.mergesSinceMarker ?? 0) > 0, "the default reader fed the runless count");
});

test("retro merged commits off the loop: the snapshot gateway forwards every other member", () => {
  const calls: string[] = [];
  const inner: ShippedGithub = {
    findMergedByTrailer: (id) => (calls.push(`find:${id}`), null),
    headRefName: (url) => (calls.push(`head:${url}`), "run-x"),
    unavailable: () => (calls.push("unavailable"), "busy"),
  };
  const ok = mergedCommitsSnapshotGateway(inner, { commits: COMMITS });
  assert.equal(ok.findMergedByTrailer("W1-T1"), null);
  assert.equal(ok.headRefName("u"), "run-x");
  assert.equal(ok.unavailable?.(), "busy");
  assert.deepEqual(ok.mergedCommits?.(), COMMITS);
  assert.deepEqual(calls, ["find:W1-T1", "head:u", "unavailable"]);
  const failed = mergedCommitsSnapshotGateway(healthyGithub(), { error: new Error("read failed") });
  assert.throws(() => failed.mergedCommits?.(), /read failed/);
});

test("retro merged commits off the loop: the daemon awaits an async retro check and acts on its fire", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-offloop-plan-`));
  writeFileSync(join(dir, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let runCalls = 0;
  let stopChecks = 0;
  const hooks = buildRetroDaemonHooks({
    check: async () => ({ fire: true, reason: "merges", mergesSinceMarker: 25, daysSinceMarker: 1 }),
    runRetro: async () => (runCalls++, 0),
  });
  await runDaemon(loadPlan(join(dir, "tasks.yaml")), {
    refreshMerged: () => () => true,
    runOne: async (id): Promise<RunResult> => {
      throw new Error(`runOne must never be called (task ${id})`);
    },
    checkStop: () => (++stopChecks > 1 ? "test bound reached" : undefined),
    sleep: async () => {},
    checkRetroTrigger: hooks.checkRetroTrigger,
    runRetroTrigger: (d) => hooks.runRetroTrigger(d),
  });
  assert.equal(runCalls, 1, "a Promise-returning check must be awaited, not read as no decision");
});
