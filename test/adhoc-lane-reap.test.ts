import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import type { WorktreeReapSummary } from "../src/lib/worker.js";
import { ADHOC_LANE_REAP_GRACE_MS, adhocLaneRoot, reapStaleWorktrees, runAdhocLaneReapRung } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * test/adhoc-lane-reap.test.ts — W1-T2847, the REAP half.
 *
 * The rung adds exactly two things to the existing reaper: a different root
 * ({@link adhocLaneRoot}) and a human-scaled age ceiling. Everything else — the removal mechanics
 * and the whole liveness doctrine — is INHERITED from `reapStaleWorktrees`, deliberately, because
 * re-implementing either is how this repo destroyed live work on 2026-07-31.
 *
 * So this suite proves three things and refuses to re-litigate a fourth:
 *   - the wiring (which root, which ceiling, which dryRun) — through an injected reaper;
 *   - that removal really goes through the PARENT — driven against a real git repo with a real
 *     linked worktree, asserting the admin record died with the directory. A bare `rmSync` leaves
 *     the record stranded and `git worktree list` reports it `prunable`, which is precisely the
 *     2026-07-31 failure and precisely what this assertion discriminates;
 *   - that a lane on a branch still live upstream is kept HOWEVER OLD.
 * It does NOT assert "N lanes were reclaimed". Against the measured population — 180 lanes, every
 * one on a live branch — a correct implementation reclaims ZERO today. The value is the bound.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });

function cfg(root: string): Config {
  return { root } as unknown as Config;
}
function summaryOf(over: Partial<WorktreeReapSummary> = {}): WorktreeReapSummary {
  return { reaped: [], reapedLocks: [], kept: [], keptReasons: [], ...over };
}

/** A real repo whose ad-hoc lane root holds one real LINKED worktree, aged past the ceiling.
 *  Returns the config root, the parent repo, the lane path and its branch name. */
function laneFixture(): { root: string; repo: string; lane: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}adhoc-lane-reap-`));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "--quiet", "-b", "main"], repo);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "-A"], repo);
  git(["commit", "--quiet", "-m", "first"], repo);
  const laneRoot = adhocLaneRoot(cfg(join(root, "rmd-root")));
  mkdirSync(laneRoot, { recursive: true });
  const branch = "alloc";
  const lane = join(laneRoot, branch);
  git(["worktree", "add", "--quiet", "-b", branch, lane], repo);
  // Age every entry past the ceiling so the age gate cannot be what keeps it.
  const old = (Date.now() - ADHOC_LANE_REAP_GRACE_MS * 2) / 1000;
  for (const p of [lane, join(lane, "f.txt"), join(lane, ".git")]) {
    try {
      utimesSync(p, old, old);
    } catch {
      /* best-effort ageing — the assertions below say whether it was enough */
    }
  }
  return { root: join(root, "rmd-root"), repo, lane, branch };
}

// ── acceptance 2: removal goes through the parent, not a bare recursive delete ─────────────────

test("W1-T2847 (acceptance 2): an armed lane reap removes the worktree THROUGH ITS PARENT — the admin record dies with the directory, never stranded prunable", () => {
  const { root, repo, lane, branch } = laneFixture();
  assert.ok(existsSync(lane), "fixture: the lane exists before the pass");

  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const summary = runAdhocLaneReapRung(cfg(root), (s, f) => lines.push([s, f]), {
    enabled: () => true, // ARMED, deliberately: this is the only test here that deletes
    // The branch is local-only in this fixture, so git's own ls-remote would fail-close to KEEP.
    // Answering "not live upstream" is what makes the removal path reachable at all.
    reap: ((r: string, o: Record<string, unknown>) =>
      reapStaleWorktrees(r, {
        ...o,
        branchIsLiveUpstream: () => false,
      })) as never,
  });

  assert.ok(summary, "the rung returned a summary");
  assert.deepEqual(summary.reaped, [branch], `expected the lane reaped; kept=${JSON.stringify(summary.keptReasons)}`);
  assert.ok(!existsSync(lane), "the directory is gone");

  // THE DISCRIMINATOR. A bare `rmSync` also makes the directory disappear — and leaves git's admin
  // record behind, which `git worktree list --porcelain` then reports `prunable`. Only removal
  // through the parent takes the record with it. This assertion is the whole point of criterion 2.
  const porcelain = git(["worktree", "list", "--porcelain"], repo);
  assert.doesNotMatch(porcelain, /^prunable/m, `a stranded admin record is the 2026-07-31 failure:\n${porcelain}`);
  assert.ok(!porcelain.includes(lane), "and the lane is no longer registered at all");

  const row = lines.find(([s]) => s === "adhoc_lane.reap");
  assert.ok(row, "the removal is ledgered");
  assert.equal(row[1]?.dry_run, false, "armed passes record that they were armed");
});

// ── acceptance 3: a live upstream branch is kept however old ───────────────────────────────────

test("W1-T2847 (acceptance 3): a lane whose branch is still live upstream is NEVER reaped, however far past the ceiling it is", () => {
  const { root, repo, lane } = laneFixture();
  const summary = runAdhocLaneReapRung(cfg(root), () => {}, {
    enabled: () => true, // armed, so a keep here is the doctrine and not the survey
    reap: ((r: string, o: Record<string, unknown>) =>
      reapStaleWorktrees(r, {
        ...o,
        branchIsLiveUpstream: () => true, // an open, unmerged PR
      })) as never,
  });
  assert.ok(summary);
  assert.deepEqual(summary.reaped, [], "age never overrides a live branch");
  assert.ok(existsSync(lane), "and the directory survives");
  assert.ok(
    (summary.keptReasons ?? []).some((k) => k.reason === "live-branch"),
    `the keep must be attributed to the branch, not to age — saw ${JSON.stringify(summary.keptReasons)}`,
  );
  assert.doesNotMatch(git(["worktree", "list", "--porcelain"], repo), /^prunable/m);
});

// ── acceptance 4: survey first — ledger what it WOULD reclaim before it may delete ─────────────

test("W1-T2847 (acceptance 4a): the rung ships DISARMED — the reaper is called in dry-run and the survey still counts what it would reclaim", () => {
  let sawDryRun: boolean | undefined;
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  runAdhocLaneReapRung(cfg("/nonexistent-root"), (s, f) => lines.push([s, f]), {
    root: () => "/fake-lane-root",
    // NO `enabled` supplied — this is the SHIPPED default, which is the claim under test.
    reap: ((_r: string, o: { dryRun?: boolean }) => {
      sawDryRun = o.dryRun;
      return summaryOf({ reaped: ["alloc", "board"] });
    }) as never,
  });
  assert.equal(sawDryRun, true, "the default must survey, not delete — 180 live operator lanes sit under this root");
  const row = lines.find(([s]) => s === "adhoc_lane.reap");
  assert.ok(row, "and it is ledgered even though nothing was removed — that IS the deliverable while disarmed");
  assert.equal(row[1]?.dry_run, true);
  assert.equal(row[1]?.reaped, 2, "the survey names the size of what it would have reclaimed");
  assert.equal(row[1]?.root, "/fake-lane-root", "and which root it surveyed");
});

test("W1-T2847 (acceptance 4b): a DISARMED pass over a real aged lane deletes nothing while still counting it", () => {
  const { root, repo, lane } = laneFixture();
  const summary = runAdhocLaneReapRung(cfg(root), () => {}, {
    reap: ((r: string, o: Record<string, unknown>) =>
      reapStaleWorktrees(r, {
        ...o,
        branchIsLiveUpstream: () => false,
      })) as never,
  });
  assert.ok(summary);
  assert.deepEqual(summary.reaped, ["alloc"], "it qualified");
  assert.ok(existsSync(lane), "and survived — the survey looked and did not touch");
  assert.ok(existsSync(join(lane, ".git")), "including its admin link");
  assert.doesNotMatch(git(["worktree", "list", "--porcelain"], repo), /^prunable/m);
});

// ── the wiring: which root and which ceiling the rung actually passes ──────────────────────────

test("W1-T2847: the rung passes adhocLaneRoot and the LANE ceiling — not worktreesDir and not the run-scoped grace", () => {
  let sawRoot: string | undefined;
  let sawOpts: { maxAgeMs?: number } = {};
  runAdhocLaneReapRung(cfg("/srv/rmd-root"), () => {}, {
    reap: ((r: string, o: typeof sawOpts) => {
      sawRoot = r;
      sawOpts = o;
      return summaryOf();
    }) as never,
  });
  assert.equal(sawRoot, "/srv/rmd-root/lanes", "the lane root, derived from config.root");
  assert.equal(sawOpts.maxAgeMs, ADHOC_LANE_REAP_GRACE_MS, "and its own human-scaled ceiling");
});

test("W1-T2847: an unreadable lane root is best-effort — the rung ledgers the error and never throws into the dispatch", () => {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const summary = runAdhocLaneReapRung(cfg("/srv/rmd-root"), (s, f) => lines.push([s, f]), {
    reap: (() => {
      throw new Error("boom");
    }) as never,
  });
  assert.equal(summary, null, "a reclaim rung never blocks a dispatch");
  const err = lines.find(([s]) => s === "adhoc_lane.reap.error");
  assert.ok(err, "and it says so rather than failing silently");
  assert.match(String(err[1]?.error), /boom/);
});

test("W1-T2847: an activity-unknown keep earns its own row — the reaper declining to decide is what bounds growth", () => {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  runAdhocLaneReapRung(cfg("/srv/rmd-root"), (s, f) => lines.push([s, f]), {
    reap: (() => summaryOf({ kept: ["board"], keptReasons: [{ name: "board", reason: "activity-unknown" }] })) as never,
  });
  const row = lines.find(([s]) => s === "adhoc_lane.reap.undecidable");
  assert.ok(row, "W1-T378's doctrine, inherited rather than re-decided");
  assert.deepEqual(row[1]?.kept, ["board"]);
});

// ── the WIRING end: runTaskBody really calls the rung ─────────────────────────────────────────

test("W1-T2847 (wiring): runTaskBody CALLS runAdhocLaneReapRung — beside the worktree boot rung, and the assertion cannot be satisfied by a comment", () => {
  // THE #339/W1-T281 SHAPE, GUARDED. The call site is introduced by a comment block that names
  // `runWorktreeReapRung` and quotes the shard, so a naive source grep would pass on wiring that
  // was never built. Strip every `//` line first, then look for the CALL with its open paren.
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

  const bodyIdx = code.indexOf("async function runTaskBody(");
  assert.ok(bodyIdx >= 0, "run-task.ts defines the one-shot dispatch body");
  const bootIdx = code.indexOf("logWorktreeReapBootSurvey(config", bodyIdx);
  assert.ok(bootIdx > bodyIdx, "the sibling worktree boot rung is called there");
  const laneIdx = code.indexOf("runAdhocLaneReapRung(config", bodyIdx);
  assert.ok(laneIdx > bodyIdx, "and the ad-hoc lane rung is called there too — a rung with no call site is dead code");
  assert.ok(laneIdx > bootIdx, "after its sibling: the same start-of-run reclaim position, one root over");

  // THE CONTROL for the comment-stripping. The un-stripped source DOES mention the sibling rung's
  // name in prose above the call; if this reads 0 the filter is wrong rather than the source
  // clean, and the assertions above would be vacuous.
  const inComments = src
    .split("\n")
    .filter((l) => l.trim().startsWith("//") && l.includes("runWorktreeReapRung"));
  assert.ok(inComments.length > 0, "the filter is doing real work — prose really does name a rung here");
});

// ── design (vi): the unmanaged-lane report is WIRED, not an exported orphan ────────────────────

test("W1-T2847: given a repoDir the rung REPORTS the lanes outside both managed roots, and never acts on them", () => {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const summary = runAdhocLaneReapRung(cfg("/srv/rmd-root"), (s, f) => lines.push([s, f]), {
    repoDir: "/srv/repo",
    reap: (() => summaryOf()) as never,
    listUnmanaged: (() => ["/srv/rmd-root/atbase", "/Users/someone/board"]) as never,
  });
  assert.ok(summary);
  const row = lines.find(([s]) => s === "adhoc_lane.unmanaged");
  assert.ok(row, "the invisible population is what let 4.7G accumulate with no ledger row");
  assert.equal(row[1]?.count, 2);
  assert.deepEqual(row[1]?.lanes, ["/srv/rmd-root/atbase", "/Users/someone/board"]);
  assert.equal(summary.reaped.length, 0, "reported, never reaped — these are outside both managed roots by definition");
});

test("W1-T2847: with NO repoDir the report is skipped entirely rather than guessing a registration", () => {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  runAdhocLaneReapRung(cfg("/srv/rmd-root"), (s, f) => lines.push([s, f]), {
    reap: (() => summaryOf()) as never,
    listUnmanaged: (() => {
      throw new Error("must not be called without a repoDir");
    }) as never,
  });
  assert.equal(lines.find(([s]) => s === "adhoc_lane.unmanaged"), undefined);
});

test("W1-T2847 (wiring): the run-task call site supplies repoDir, so the report has a producer rather than being an exported orphan", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  assert.match(
    code,
    /runAdhocLaneReapRung\(config, log, \{ repoDir \}\)/,
    "without repoDir the unmanaged report never runs and unmanagedWorktreeLanes is dead code",
  );
});
