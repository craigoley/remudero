/**
 * test/next-task-id-history.test.ts — W1-T278.
 *
 * `rmd next-task-id` unions `plan/tasks.yaml`, EVERY `plan/tasks.d/*.yaml` shard, and open
 * plan PRs' minted ids (test/task-id.test.ts, test/triage-id-mint.test.ts) — every source
 * that reads the CURRENT tree. A task filed and later FOLDED away (removed from the tree,
 * its PR long since merged) leaves no trace in any of them: the current tree, by definition,
 * no longer shows it. This suite proves the fourth source — the git HISTORY of `plan/`,
 * exposed as `taskIdsEverFiled` and layered onto the mint by `mintNextTaskIdWithHistory`
 * (both in src/run-task.ts, W1-T278's own scope) — closes that gap, degrades honestly when
 * the scan itself cannot be trusted, and never disturbs the three sources that already work.
 *
 * Every fixture here is a REAL local `git init` repo (no bare origin, no network) — cheap,
 * and history recoverable straight from the working checkout is exactly what the design
 * calls for ("without a network call and without a working-tree checkout" beyond the one
 * already on disk).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintNextTaskIdWithHistory, taskIdsEverFiled } from "../src/run-task.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A throwaway local git repo (`git init -b main`, identity configured) with an empty
 *  `plan/tasks.d/` — every fixture below commits its own `plan/tasks.yaml` history on top. */
function gitPlanFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mint-history-"));
  git(root, "init", "--quiet", "-b", "main");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  return root;
}

function writeMonolith(root: string, ids: number[]): void {
  writeFileSync(join(root, "plan", "tasks.yaml"), ids.map((n) => `- id: W1-T${n}\n  title: "t${n}"\n`).join(""));
}

function commitPlan(root: string, message: string): void {
  git(root, "add", "-A", "--", "plan");
  git(root, "commit", "--quiet", "-m", message);
}

test("taskIdsEverFiled + mintNextTaskIdWithHistory: an id FOLDED out of the plan is still treated as used", () => {
  const root = gitPlanFixture();
  try {
    // Commit 1: files W1-T1 and W1-T9.
    writeMonolith(root, [1, 9]);
    commitPlan(root, "chore(plan): file W1-T1 and W1-T9");
    // Commit 2: W1-T9 is FOLDED away — the current tree now tops out at W1-T1, same as if it
    // had never existed. A max-over-current-tree mint would happily hand back W1-T2.
    writeMonolith(root, [1]);
    commitPlan(root, "chore(plan): fold W1-T9 away");

    const planPath = join(root, "plan", "tasks.yaml");

    const history = taskIdsEverFiled(root, "plan");
    assert.deepEqual(history.ids, [1, 9], "the fold removed W1-T9 from the tree, never from history");
    assert.deepEqual(history.degraded, []);

    const mint = mintNextTaskIdWithHistory({ planPath, repoRoot: root });
    assert.equal(mint.id, "W1-T10", "the folded id must still be cleared, not reissued as W1-T2");
    assert.equal(mint.historyMax, 9);
    assert.equal(mint.maxSeen, 9);
    assert.deepEqual(mint.degraded, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mintNextTaskIdWithHistory: still unions the current-tree sources and open-PR mints exactly as mintNextTaskId does today", () => {
  const root = gitPlanFixture();
  try {
    writeMonolith(root, [258, 259]);
    writeFileSync(join(root, "plan", "tasks.d", "W1-T260-shard.yaml"), '- id: W1-T260\n  title: "shard-owned"\n');
    commitPlan(root, "chore(plan): seed monolith + shard");
    // Nothing in history ever exceeded W1-T260 — the history layer must not blunt or
    // override the open-PR source (W1-T300), which is what actually pushes the mint up.
    const planPath = join(root, "plan", "tasks.yaml");
    const mint = mintNextTaskIdWithHistory({
      planPath,
      repoRoot: root,
      openPrTexts: () => ["chore(plan): file the thing\n\nadds W1-T300"],
    });
    assert.equal(mint.id, "W1-T301", "the open-PR source is still the one that wins here");
    assert.deepEqual(mint.sources, { monolith: 259, shards: 260, openPrs: 300, remotePlan: null });
    assert.equal(mint.historyMax, 260, "history saw the shard's commit too, but 260 < 300 so it never surfaces as the max");
    assert.deepEqual(mint.degraded, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskIdsEverFiled: an unresolvable HEAD degrades loudly, source 'history', never a silent empty result", () => {
  const root = gitPlanFixture(); // never committed — HEAD does not exist yet
  try {
    const result = taskIdsEverFiled(root, "plan");
    assert.deepEqual(result.ids, []);
    assert.equal(result.degraded.length, 1);
    assert.equal(result.degraded[0].source, "history");
    assert.match(result.degraded[0].reason, /cannot resolve HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mintNextTaskIdWithHistory: a DEGRADED history scan is flagged non-zero, not folded in as a false all-clear", () => {
  const root = gitPlanFixture();
  try {
    // W1-T9 would be found by a real scan (same shape as the fold test above) — but the
    // injected gitRunner fails the log step, standing in for a corrupt object store or a
    // `git` that cannot be invoked. The mint must not silently report "no history ids" as
    // though that were a completed, trustworthy scan.
    writeMonolith(root, [1, 9]);
    commitPlan(root, "chore(plan): file W1-T1 and W1-T9");
    writeMonolith(root, [1]);
    commitPlan(root, "chore(plan): fold W1-T9 away");
    const planPath = join(root, "plan", "tasks.yaml");

    const realGit = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const failingGit = (args: string[]) => {
      if (args[0] === "log") throw new Error("simulated corrupt object store");
      return realGit(args);
    };

    const mint = mintNextTaskIdWithHistory({ planPath, repoRoot: root, gitRunner: failingGit });
    assert.equal(mint.degraded.length, 1, "the degraded history scan must be visible on the mint, not swallowed");
    assert.equal(mint.degraded[0].source, "history");
    assert.match(mint.degraded[0].reason, /simulated corrupt object store/);
    assert.equal(mint.historyMax, null, "a failed scan reports null, never a falsely-reassuring 0");
    assert.equal(mint.maxSeen, 1, "the mint falls back to the current-tree floor — it never claims the folded W1-T9 as cleared");
    // The exit-code contract `nextTaskIdCommand` applies (`mint.degraded.length ? 1 : 0`)
    // would refuse to treat this mint as authoritative — exactly what "refuses to mint from
    // a partial union" means in practice: it still prints A floor, but flags it, non-zero.
    assert.equal(mint.degraded.length ? 1 : 0, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskIdsEverFiled: a `--git-common-dir` read failure loses the CACHE, not the scan — still correct, just uncached, and never degraded", () => {
  const root = gitPlanFixture();
  try {
    writeMonolith(root, [1, 9]);
    commitPlan(root, "chore(plan): file W1-T1 and W1-T9");
    writeMonolith(root, [1]);
    commitPlan(root, "chore(plan): fold W1-T9 away");

    const realGit = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const noCacheGit = (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        throw new Error("simulated: cannot resolve the shared git dir");
      }
      return realGit(args);
    };

    const result = taskIdsEverFiled(root, "plan", noCacheGit);
    assert.deepEqual(result.ids, [1, 9], "the completeness of the scan itself never depends on the cache");
    assert.deepEqual(result.degraded, [], "a cache that cannot be located is a cost optimization lost, not a degraded scan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mintNextTaskIdWithHistory: a planPath OUTSIDE repoRoot has no history to scan — skipped, never degraded (back-compat for fixture-only plans)", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "mint-history-outside-"));
  const unrelatedGitRoot = gitPlanFixture();
  try {
    mkdirSync(join(fixtureRoot, "plan"), { recursive: true });
    writeFileSync(join(fixtureRoot, "plan", "tasks.yaml"), "- id: W1-T5\n  title: \"t5\"\n");
    const mint = mintNextTaskIdWithHistory({
      planPath: join(fixtureRoot, "plan", "tasks.yaml"),
      repoRoot: unrelatedGitRoot,
    });
    assert.equal(mint.historyMax, null);
    assert.deepEqual(mint.degraded, [], "an out-of-tree plan is EMPTY history, not a degradation — same doctrine as an absent tasks.d/");
    assert.equal(mint.id, "W1-T6");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(unrelatedGitRoot, { recursive: true, force: true });
  }
});

test("taskIdsEverFiled: the scan is BOUNDED by a sha-keyed cache — a second call only walks commits added since the first", () => {
  const root = gitPlanFixture();
  try {
    writeMonolith(root, [1]);
    commitPlan(root, "chore(plan): file W1-T1");

    const calls: string[][] = [];
    const spyingGit = (args: string[]) => {
      calls.push(args);
      return execFileSync("git", args, { cwd: root, encoding: "utf8" });
    };

    const first = taskIdsEverFiled(root, "plan", spyingGit);
    assert.deepEqual(first.ids, [1]);
    const firstLogCall = calls.find((a) => a[0] === "log");
    assert.ok(firstLogCall, "the cold scan must actually walk history once");
    assert.equal(firstLogCall![1], "HEAD", "a cold (no-cache) scan walks the whole history, not a bounded range");

    const gitCommonDir = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
    const cachePath = join(root, gitCommonDir, "rmd-task-id-history-cache.json");
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(cached.ids, [1], "the cache persists the scan result, keyed on the sha it scanned through");

    // A second commit, then a second scan: the cache must bound it to ONLY the new commit.
    writeMonolith(root, [1, 2]);
    commitPlan(root, "chore(plan): file W1-T2");
    calls.length = 0;
    const second = taskIdsEverFiled(root, "plan", spyingGit);
    assert.deepEqual(second.ids, [1, 2]);
    const secondLogCall = calls.find((a) => a[0] === "log");
    assert.ok(secondLogCall, "a warm scan still reads — just a bounded range");
    assert.match(secondLogCall![1], /\.\.HEAD$/, "a warm scan walks ONLY <cached sha>..HEAD, never the full history again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE 1 MiB WALL (impl-CX) ────────────────────────────────────────────────────────────────
//
// `taskIdsEverFiled`'s default runner issues `git log <range> -p -- <planRelPath>`, whose output
// is the FULL patch of every commit that ever touched the plan. On 2026-08-01 that measured
// 1,860,892 bytes across 171 commits in this repo — 1.8x Node's 1 MiB execFileSync default — and
// it grows monotonically. Without an explicit maxBuffer the scan dies `spawnSync git ENOBUFS`,
// degrades to an EMPTY id set, and the mint silently loses its only protection against reissuing
// a folded-away id. Observed live during `rmd triage`:
//   "DEGRADED: history (cannot scan plan/ history (HEAD): Error: spawnSync git ENOBUFS)"
//
// THIS TEST MUST EXCEED THE OLD LIMIT FOR REAL. An injected gitRunner returning a big string
// would prove nothing — it bypasses execFileSync, which is the thing that overflows. So the
// fixture builds a genuine repo whose `git log -p` output is over 1 MiB and lets the REAL
// default runner walk it.

test("taskIdsEverFiled: a plan history whose git log -p EXCEEDS 1 MiB scans clean through the REAL default runner", () => {
  const root = gitPlanFixture();

  // ~1.4 MiB of genuine patch: 14 commits, each adding ~100 KiB of new lines plus one new id.
  const filler = (tag: string) => Array.from({ length: 1400 }, (_, i) => `  note_${tag}_${i}: "${"x".repeat(60)}"`).join("\n");
  for (let c = 1; c <= 14; c++) {
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      Array.from({ length: c }, (_, k) => `- id: W1-T${k + 1}\n  title: "t${k + 1}"\n${filler(`c${k + 1}`)}\n`).join(""),
    );
    commitPlan(root, `chore(plan): commit ${c}`);
  }

  // The fixture must actually clear the old ceiling, or this test proves nothing.
  const bytes = Buffer.byteLength(
    execFileSync("git", ["-C", root, "log", "HEAD", "-p", "--", "plan/tasks.yaml"], { encoding: "utf8", maxBuffer: 1 << 26 }),
  );
  assert.ok(bytes > 1_048_576, `fixture must exceed Node's 1 MiB default to be meaningful, got ${bytes}`);

  // REAL default runner — no injected gitRunner, so execFileSync's maxBuffer is what is under test.
  const r = taskIdsEverFiled(root, "plan/tasks.yaml");

  assert.deepEqual(r.degraded, [], `the scan must not degrade on a >1 MiB history; got ${JSON.stringify(r.degraded)}`);
  assert.equal(r.ids.length, 14, "every id ever added must be recovered");
  assert.equal(Math.max(...r.ids), 14);
});

test("taskIdsEverFiled: a scan that fails for a NON-buffer reason still degrades LOUDLY, never a silent empty set", () => {
  // SECOND TRAP: the degraded path is CORRECT behaviour and must survive the buffer bump. An
  // empty id set with NO degradation recorded would make the mint a floor without saying so —
  // the dangerous version of this failure, worse than the crash it replaces.
  const root = gitPlanFixture();
  writeMonolith(root, [1, 2, 3]);
  commitPlan(root, "chore(plan): seed");

  const boom = (args: string[]): string => {
    if (args[0] === "log") throw new Error("git exploded for some other reason");
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
  };
  const r = taskIdsEverFiled(root, "plan/tasks.yaml", boom);

  assert.equal(r.ids.length, 0, "a scan it cannot trust contributes nothing");
  assert.equal(r.degraded.length, 1, "and it must SAY so — silence here is the dangerous failure");
  assert.equal(r.degraded[0].source, "history");
  assert.match(r.degraded[0].reason, /cannot scan plan\/ history/);
  assert.match(r.degraded[0].reason, /git exploded/, "the real cause must survive into the message");
});
