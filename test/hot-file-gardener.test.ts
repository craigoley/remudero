/**
 * W1-T4803: the fleet finds the files its pull requests collide on. Every merge-conflict fix round
 * records its conflicted paths; files are ranked by the recency-weighted PR MINUTES their conflicts
 * cost (never by conflict count); the costliest file no task tracks is filed as one plan-only
 * restructuring proposal naming the remedy that fits its shape.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "../src/lib/clock.js";
import { rule15SplitViolation } from "../src/lib/ci-parity.js";
import { runGarden, type GardenCheckout, type GardenerDeps } from "../src/lib/gardener.js";
import {
  HOT_FILE_REMEDIES,
  backfillConflictedFiles,
  conflictedFilePaths,
  hotFileGardenSpec,
  hotFileMetric,
  hotFileOrigin,
  hotFileRemedy,
  hotFileRoundsFromLedger,
  hotFileShardYaml,
  priceHotFiles,
  readMainHistory,
  type HotFileGardenSources,
  type MainCommit,
} from "../src/lib/hot-file-gardener.js";
import { planOnlyDiff } from "../src/lib/review.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

const at = (h: number, m: number): string => new Date(Date.UTC(2026, 8, 29, h, m)).toISOString();

/** One PR's merge-conflict round: `pr.opened`, then a `fix.dispatch` `minutes` later. */
function conflictRound(pr: number, openHour: number, minutes: number, files?: string[]): LedgerRecord[] {
  const run = `run-${pr}`;
  const end = openHour * 60 + minutes;
  return [
    { step: "pr.opened", run_id: run, pr_url: `https://github.com/acme/remudero/pull/${pr}`, ts: at(openHour, 0) },
    {
      step: "fix.dispatch",
      run_id: run,
      mode: "merge-conflict",
      round: 1,
      head_sha: `${pr}`.padStart(40, "a"),
      ts: at(Math.floor(end / 60), end % 60),
      ...(files ? { conflicted_files: files } : {}),
    },
  ];
}

test("W1-T4803: a merge-conflict fix round records its conflicted paths", () => {
  // The helper the fix rung logs its row with: the paths of the round's conflict evidence.
  const evidence = {
    files: [
      { path: "scripts/test-tier-manifest.json", oursDeleted: 1, theirsDeleted: 2 },
      { path: "plan/plan-index.json", oursDeleted: 0, theirsDeleted: 0 },
      { path: "plan/plan-index.json", oursDeleted: 0, theirsDeleted: 0 },
    ],
  };
  assert.deepEqual(conflictedFilePaths(evidence), ["scripts/test-tier-manifest.json", "plan/plan-index.json"]);
  assert.equal(conflictedFilePaths(undefined), undefined, "a round with no conflict evidence records no paths");

  // What the row carries is what the ranking then reads back — recorded, never inferred.
  const row = { ...conflictRound(7, 1, 30)[1]!, conflicted_files: conflictedFilePaths(evidence) };
  const { rounds } = hotFileRoundsFromLedger([conflictRound(7, 1, 30)[0]!, row]);
  assert.deepEqual(rounds.map((r) => [r.file, r.minutes, r.inferred]), [
    ["scripts/test-tier-manifest.json", 15, false],
    ["plan/plan-index.json", 15, false],
  ]);
});

test("W1-T4803: files rank by conflict minutes rather than count", () => {
  // `many.json`: ten one-minute conflicts. `few.json`: two forty-minute ones.
  const ledger: LedgerRecord[] = [];
  for (let i = 0; i < 10; i++) ledger.push(...conflictRound(100 + i, 1, 1, ["many.json"]));
  for (let i = 0; i < 2; i++) ledger.push(...conflictRound(200 + i, 2, 40, ["few.json"]));
  const nowMs = Date.parse(at(4, 0));
  const priced = priceHotFiles(hotFileRoundsFromLedger(ledger).rounds, nowMs);
  const many = priced.find((p) => p.file === "many.json")!;
  const few = priced.find((p) => p.file === "few.json")!;
  assert.ok(many.rounds > few.rounds, "ranked by count, many.json would win");
  assert.equal(priced[0]!.file, "few.json", "ranked by minutes, the two forty-minute conflicts win");
  assert.ok(few.minutes > many.minutes * 5);

  // Recency: the same 40 minutes a fortnight ago count a quarter.
  const old = [...conflictRound(300, 1, 40, ["old.json"])];
  const weighted = priceHotFiles(hotFileRoundsFromLedger(old).rounds, Date.parse(at(1, 40)) + 14 * 24 * 3_600_000);
  assert.equal(weighted[0]!.minutes, 10);
});

function commit(repoDir: string, file: string[], iso: string, subject: string): void {
  for (const f of file) writeFileSync(join(repoDir, f), `${subject}\n${iso}\n`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  };
  execFileSync("git", ["-C", repoDir, "add", "--", ...file], { env });
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", subject], { env });
}

test("W1-T4803: a pathless round is backfilled from git and marked inferred", () => {
  const repo = gitRepo({ kind: "hot-file-backfill" });
  // PR #5 opens at 01:00 and its conflict round ends at 01:30. Between, main changes a.json and
  // b.json; PR #5's own squash commit (later) changes a.json and c.json. Only a.json can have collided.
  commit(repo.dir, ["b.json"], at(0, 30), "chore: seed (#1)");
  commit(repo.dir, ["a.json", "b.json"], at(1, 10), "chore: main moves (#9)");
  commit(repo.dir, ["a.json", "c.json"], at(2, 0), "feat: the PR itself (#5)");
  const history = readMainHistory(repo.dir, "2026-09-01T00:00:00Z");
  assert.deepEqual(backfillConflictedFiles(history, { pr: 5, openedAt: at(1, 0), at: at(1, 30) }), ["a.json"]);
  assert.deepEqual(backfillConflictedFiles(history, { pr: 77, openedAt: at(1, 0), at: at(1, 30) }), [], "a PR with no squash commit is not guessed");

  const ledger = [...conflictRound(5, 1, 30), ...conflictRound(6, 3, 20, ["x.json", "y.json"])];
  const { rounds, unattributedMinutes } = hotFileRoundsFromLedger(ledger, (q) => backfillConflictedFiles(history, q));
  const inferred = rounds.filter((r) => r.inferred);
  assert.deepEqual(inferred.map((r) => [r.pr, r.file, r.minutes]), [[5, "a.json", 30]]);
  assert.equal(rounds.filter((r) => !r.inferred).length, 2, "recorded attributions stay recorded");
  assert.equal(unattributedMinutes, 0);

  // The mark survives pricing: a file's minutes say how much of them git history inferred.
  const priced = priceHotFiles(rounds, Date.parse(at(4, 0)));
  const a = priced.find((p) => p.file === "a.json")!;
  assert.equal(a.inferredMinutes, a.minutes);
  assert.equal(a.recordedMinutes, 0);
  assert.equal(priced.find((p) => p.file === "x.json")!.inferredMinutes, 0);

  // Without a backfill (or when it finds nothing) the minutes are counted unattributed, never dropped.
  assert.equal(hotFileRoundsFromLedger(ledger).unattributedMinutes, 30);
});

const nowMs = Date.parse("2026-09-29T12:00:00.000Z");

function fixture(kind: string, ledger: LedgerRecord[], land: GardenCheckout["land"], origins: string[] = []) {
  const repo = gitRepo({ kind });
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let minted = 0;
  const deps: GardenerDeps = {
    stateDir,
    repoRoot: repo.dir,
    openWorkspace: () => ({ root: repo.dir, branch: "hot-file-garden-1", land, dispose: () => {} }),
    log: (step, extra) => { events.push({ step, extra }); },
    clock: clockFromMillisFn(() => nowMs),
    seed: 3,
  };
  const sources: HotFileGardenSources = {
    ledgerRecords: () => ledger,
    mainHistory: () => [],
    planOrigins: () => origins,
    mintTaskId: () => `W1-T96${String(++minted).padStart(2, "0")}`,
  };
  return { repo, deps, events, sources, spec: hotFileGardenSpec(deps, sources) };
}

test("W1-T4803: the costliest untracked hot file is filed plan-only with its remedy", () => {
  const ledger = [
    ...conflictRound(10, 8, 45, ["scripts/test-tier-manifest.json"]),
    ...conflictRound(11, 9, 20, ["scripts/comment-load-baseline.json"]),
  ];
  let diff = "";
  let base = "";
  const landed: string[][] = [];
  const fx = fixture("hot-file-filing", ledger, (opts) => {
    landed.push(opts.paths);
    fx.repo.git("add", "--", ...opts.paths);
    fx.repo.git("commit", "-q", "-m", opts.title);
    diff = fx.repo.git("diff", base, "HEAD");
    return "https://github.com/acme/remudero/pull/99";
  });
  base = fx.repo.git("rev-parse", "HEAD");
  const pass = runGarden(fx.spec, fx.deps);
  assert.equal(pass.prUrl, "https://github.com/acme/remudero/pull/99");
  assert.equal(landed.length, 1);
  assert.equal(landed[0]!.length, 1, "ONE path: the shard alone, never a garden log beside it");
  assert.match(landed[0]![0]!, /^plan\/tasks\.d\/W1-T9601-hot-file-.*\.yaml$/);
  assert.equal(rule15SplitViolation(diff).refused, false, "a shard-only filing is the plan-only shape Rule 15 exempts");
  assert.ok(planOnlyDiff(diff));

  const shard = readFileSync(join(fx.repo.dir, landed[0]![0]!), "utf8");
  assert.match(shard, /origin: "hot-file:scripts\/test-tier-manifest\.json"/, "the costliest file, by minutes");
  assert.match(shard, /GENERATE-IN-CI/, "a manifest is derivable from the tree");
  assert.match(shard, /44\.4 PR minute\(s\) across 1 round\(s\) on 1 pull request\(s\)/, "the BEFORE measurement: 45 minutes, recency-weighted four hours on");
  assert.doesNotMatch(shard, /comment-load-baseline/, "one file per shard");
  assert.equal(pass.scorecard?.untracked, "scripts/test-tier-manifest.json");

  // Idempotent: once a task holds the origin, the next costliest file is the candidate.
  const tracked = fixture("hot-file-tracked", ledger, () => assert.fail("nothing to land"), [hotFileOrigin("scripts/test-tier-manifest.json")]);
  assert.equal(tracked.spec.inventory().untracked?.file, "scripts/comment-load-baseline.json");
  assert.equal(hotFileRemedy("scripts/comment-load-baseline.json"), "split-per-entry");
  assert.equal(hotFileRemedy("state/ci-friction-garden-log.md"), "append-only");
  assert.equal(hotFileRemedy(".gitignore"), "merge-driver");
  assert.deepEqual([...HOT_FILE_REMEDIES], ["generate-in-ci", "split-per-entry", "append-only", "merge-driver"]);
});

test("W1-T4803: a source module is priced but never filed", () => {
  const ledger = [
    ...conflictRound(20, 1, 120, ["src/run-task.ts"]),
    ...conflictRound(21, 5, 90, ["plan/tasks.d/W1-T1-x.yaml"]),
    ...conflictRound(22, 8, 25, ["plan/plan-index.json"]),
  ];
  const fx = fixture("hot-file-source", ledger, () => "https://github.com/acme/remudero/pull/98");
  const inv = fx.spec.inventory();
  assert.equal(inv.ranked[0]!.file, "src/run-task.ts", "the source module is the costliest file");
  assert.equal(inv.untracked?.file, "plan/plan-index.json", "but the costliest FILABLE file is the data file");
  assert.equal(hotFileRemedy("src/run-task.ts"), undefined);
  assert.equal(hotFileRemedy("plan/tasks.d/W1-T1-x.yaml"), undefined);
  assert.throws(() => hotFileShardYaml(inv.ranked[0]!, "W1-T9999"), /never filed for restructuring/);

  const pass = runGarden(fx.spec, fx.deps);
  const ranked = (pass.scorecard?.ranked ?? []) as Array<{ file: string; minutes: number; remedy: string | null }>;
  assert.deepEqual(
    ranked.map((r) => [r.file, r.remedy]),
    [["src/run-task.ts", null], ["plan/tasks.d/W1-T1-x.yaml", null], ["plan/plan-index.json", "generate-in-ci"]],
    "priced and reported in the scorecard, but only the data file has a remedy",
  );
  assert.ok(pass.plan?.actions.every((a) => a.target === "plan/plan-index.json"));
  assert.ok(!(pass.plan?.actions ?? []).some((a) => a.target.startsWith("src/")));
});

test("W1-T4803: a filed file that stops conflicting credits its remedy", () => {
  const file = "scripts/test-tier-manifest.json";
  const commits = (n: number): MainCommit[] => Array.from({ length: n }, (_, i) => ({ sha: `s${i}`, at: at(1, i), subject: `chore (#${i})`, files: [file] }));
  const ledger = conflictRound(30, 1, 45, [file]);
  const build = (merged: number) => {
    const fx = fixture("hot-file-metric", ledger, () => undefined, [hotFileOrigin(file)]);
    const sources = { ...fx.sources, mainHistory: () => commits(merged) };
    return hotFileGardenSpec(fx.deps, sources).inventory();
  };
  const before = hotFileMetric(build(4), "generate-in-ci");
  const after = hotFileMetric(build(14), "generate-in-ci");
  assert.deepEqual(before, { trials: 4, successes: 3 });
  assert.deepEqual(after, { trials: 14, successes: 13 });
  assert.ok(after.successes / after.trials > before.successes / before.trials, "ten clean merges since raise the class's rate");
  assert.deepEqual(hotFileMetric(build(4), "append-only"), { trials: 0, successes: 0 }, "another remedy's record is untouched");
});
