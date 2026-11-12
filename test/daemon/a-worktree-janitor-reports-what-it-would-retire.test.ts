/**
 * W1-T11941 — A WORKTREE JANITOR REPORTS WHAT IT WOULD RETIRE, AND RETIRES NOTHING.
 *
 * src/lib/worktree-retire.ts reads the operator checkout's `git worktree list`, classifies every
 * registration (clean, a day old, unclaimed, no open PR, published), and writes one
 * `worktree_retire.would_retire` row per qualifying tree and one `worktree_retire.kept` row per refusal,
 * each naming its reason. Criteria 1 and 4 run the REAL git ports against a fixture origin, clone and
 * worktrees cut at arbitrary paths; criteria 2 and 3 drive the classifier through injected ports.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixedClock, systemClock } from "#src/lib/clock.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  classifyRegisteredWorktrees, CONTAINER_HOME_PREFIX, defaultLastActivityMs, defaultOpenPrHeads, parseTaskCredits, parseWorktreeList,
  repoSlugOfRemoteUrl, reportRetirableWorktrees, taskIdOfRunBranch, WORKTREE_RETIRE_KEPT_STEP, WORKTREE_RETIRE_PASS_STEP,
  WORKTREE_RETIRE_WOULD_RETIRE_STEP, type WorktreeRegistration, type WorktreeRetirePorts,
} from "#src/lib/worktree-retire.js";
import { GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const DAY = 24 * 60 * 60 * 1000;
const ID = GIT_REPO_FIXTURE_IDENTITY;

type Row = { step: string; extra: Record<string, unknown> };
const recorder = () => {
  const rows: Row[] = [];
  return { rows, log: (step: string, extra: Record<string, unknown> = {}) => void rows.push({ step, extra }) };
};
const pathsOf = (rows: readonly Row[], step: string) => rows.filter((r) => r.step === step).map((r) => r.extra.path as string).sort();

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: ID.name, GIT_AUTHOR_EMAIL: ID.email, GIT_COMMITTER_NAME: ID.name, GIT_COMMITTER_EMAIL: ID.email, ...env },
  }).trim();
}

/** A bare origin, an operator clone, and worktrees cut at paths no root list would name. */
describe("the real git ports over a fixture operator checkout", () => {
  let root: string;
  let checkout: string;
  const wt: Record<string, string> = {};
  const threeDaysAgo = new Date(Date.now() - 3 * DAY).toISOString();

  before(() => {
    root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11941-janitor-`));
    const origin = join(root, "origin.git");
    checkout = join(root, "operator", "remudero");
    mkdirSync(join(root, "operator"));
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "--quiet", origin, checkout], { stdio: "ignore" });
    git(checkout, ["commit", "--quiet", "--allow-empty", "-m", "chore: seed"]);
    git(checkout, ["push", "--quiet", "origin", "main"]);
    const cut = (name: string, dir: string, branch: string, commit: boolean, push: boolean) => {
      wt[name] = join(root, dir, name);
      git(checkout, ["worktree", "add", "--quiet", "-b", branch, wt[name]!, "main"]);
      if (commit) git(wt[name]!, ["commit", "--quiet", "--allow-empty", "-m", `chore: ${name}`], { GIT_COMMITTER_DATE: threeDaysAgo });
      if (push) git(wt[name]!, ["push", "--quiet", "origin", branch]);
    };
    cut("pushed", "somewhere-else", "run-W1-T9001-1794000000001", true, true);
    cut("credited", "another-root/deeper", "run-W1-T9002-1794000000002", true, false);
    cut("dirty", "somewhere-else", "run-W1-T9003-1794000000003", true, true);
    cut("unpushed", "hand", "hand-unpushed", true, false);
    cut("claimed", "hand", "run-W1-T9004-1794000000004", true, true);
    cut("missing", "gone", "run-W1-T9005-1794000000005", true, true);
    writeFileSync(join(wt.dirty!, "scratch.txt"), "uncommitted\n");
    git(checkout, ["push", "--quiet", "origin", "main:refs/rmd-dispatch/W1-T9004"]);
    git(checkout, ["commit", "--quiet", "--allow-empty", "-m", "feat: land t9002\n\nRemudero-Task: W1-T9002\n\nCo-authored-by: x <x@x.invalid>"]);
    git(checkout, ["push", "--quiet", "origin", "main"]);
    rmSync(wt.missing!, { recursive: true, force: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const pass = async () => {
    const { rows, log } = recorder();
    // GitHub is the one read with no local stand-in; every other port is the module's real default.
    const summary = await reportRetirableWorktrees({
      operatorCheckout: checkout, clock: fixedClock(Date.now() + 2 * DAY), openPrHeads: async () => new Set<string>(),
      // A host whose TMPDIR sits under the container home would otherwise refuse every fixture tree.
      containerHomePrefix: "/no-container-home-in-this-fixture/",
    }, log);
    return { rows, summary: summary! };
  };

  it("W1-T11941 criterion 1: the roots come from the operator checkout's git worktree list, and each qualifying tree gets one would-retire row naming its reason", async () => {
    const registered = parseWorktreeList(git(checkout, ["worktree", "list", "--porcelain"])).map((r) => r.path).sort();
    const { rows, summary } = await pass();
    const reported = [...pathsOf(rows, WORKTREE_RETIRE_WOULD_RETIRE_STEP), ...pathsOf(rows, WORKTREE_RETIRE_KEPT_STEP)].sort();
    assert.deepEqual(reported, registered, "every registration git lists, and nothing else, is classified");
    assert.equal(summary.registered, 7);
    const would = rows.filter((r) => r.step === WORKTREE_RETIRE_WOULD_RETIRE_STEP);
    assert.deepEqual(would.map((r) => [r.extra.path, r.extra.reason]).sort(), [
      [wt.credited, "credited-by-trailer"],
      [wt.pushed, "fully-pushed"],
    ].sort());
    assert.ok(would.every((r) => r.extra.mode === "shadow"));
    assert.equal(would.find((r) => r.extra.path === wt.credited)!.extra.task_id, "W1-T9002");
    const passRow = rows.find((r) => r.step === WORKTREE_RETIRE_PASS_STEP)!;
    assert.deepEqual([passRow.extra.registered, passRow.extra.would_retire, passRow.extra.kept], [7, 2, 5]);
  });

  it("W1-T11941 criterion 4: a shadow pass removes no path, runs no worktree remove, branch delete or prune, and only reports a missing path", async () => {
    const snapshot = () => ({
      list: git(checkout, ["worktree", "list", "--porcelain"]),
      branches: git(checkout, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
      present: Object.entries(wt).map(([name, p]) => [name, existsSync(p)]),
    });
    const before = snapshot();
    const { rows } = await pass();
    assert.deepEqual(snapshot(), before, "registrations, branches and directories are byte-identical after the pass");
    assert.ok(existsSync(wt.pushed!) && existsSync(wt.credited!), "a would-retire tree is still on disk");
    assert.match(before.list, new RegExp(`worktree ${wt.missing}\\n[^]*?prunable`), "the missing tree stays registered: no prune ran");
    const missing = rows.find((r) => r.extra.path === wt.missing)!;
    assert.deepEqual([missing.step, missing.extra.reason, missing.extra.pruned], [WORKTREE_RETIRE_KEPT_STEP, "path-missing", false]);
  });

  it("the real ports name each refused tree's reason", async () => {
    const { rows } = await pass();
    const reason = (p: string) => rows.find((r) => r.extra.path === p)?.extra.reason;
    assert.deepEqual([reason(checkout), reason(wt.dirty!), reason(wt.unpushed!), reason(wt.claimed!)],
      ["main-worktree", "dirty", "unpushed-commits", "dispatch-claimed"]);
  });

  it("a second tick inside the interval reads nothing", async () => {
    const opts = { operatorCheckout: checkout, clock: systemClock, openPrHeads: async () => new Set<string>() };
    assert.ok(await reportRetirableWorktrees(opts, () => {}));
    assert.equal(await reportRetirableWorktrees(opts, () => {}), undefined);
  });

  it("the real ports fail closed when origin, its main or the GitHub repo cannot be read", async () => {
    const broken = join(root, "broken", "remudero");
    execFileSync("git", ["clone", "--quiet", join(root, "origin.git"), broken], { stdio: "ignore" });
    const run = join(root, "broken-trees", "run-W1-T9100-1794000000100");
    const hand = join(root, "broken-trees", "hand");
    git(broken, ["worktree", "add", "--quiet", "-b", "run-W1-T9100-1794000000100", run, "origin/main"]);
    git(broken, ["worktree", "add", "--quiet", "-b", "hand-x", hand, "origin/main"]);
    git(broken, ["remote", "set-url", "origin", join(root, "no-such-origin.git")]);
    git(broken, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const { rows, log } = recorder();
    const summary = await reportRetirableWorktrees({
      operatorCheckout: broken, clock: fixedClock(Date.now() + 2 * DAY), containerHomePrefix: "/no-container-home-in-this-fixture/",
    }, log);
    assert.deepEqual(summary!.kept.map((o) => [o.path, o.reason]), [
      [broken, "main-worktree"], [hand, "pr-state-unreadable"], [run, "claims-unreadable"],
    ]);
    assert.deepEqual(rows.filter((r) => r.step === "worktree_retire.read_failed").map((r) => r.extra.what).sort(),
      ["credits", "dispatch-claims", "open-prs"]);
    writeFileSync(join(hand, ".git"), "gitdir: /nowhere\n");
    assert.equal(defaultLastActivityMs(hand), undefined, "a refused .git pointer leaves the age unanswered");
    assert.equal(defaultLastActivityMs(join(root, "absent")), undefined);
  });

  it("an unreadable worktree list writes one pass row naming it and classifies nothing", async () => {
    const { rows, log } = recorder();
    const summary = await reportRetirableWorktrees({ operatorCheckout: join(root, "no-such-checkout") }, log);
    assert.ok(summary?.listUnreadable);
    assert.deepEqual(rows.filter((r) => r.step.startsWith("worktree_retire.") && r.step !== "worktree_retire.read_failed").map((r) => [r.step, r.extra.reason]),
      [[WORKTREE_RETIRE_PASS_STEP, "worktree-list-unreadable"]]);
  });
});

/** A registration that passes every gate; each refusal case below changes exactly one fact of it. */
function ports(over: Partial<WorktreeRetirePorts> = {}): WorktreeRetirePorts {
  return {
    listWorktrees: async () => "",
    pathExists: () => true,
    lastActivityMs: () => NOW - 3 * DAY,
    countDirtyFiles: async () => 0,
    unpushedCommits: async () => 0,
    headCommittedAtMs: async () => NOW - 3 * DAY,
    dispatchClaims: async () => new Set<string>(),
    openPrHeads: async () => new Set<string>(),
    credits: async () => new Map(),
    ...over,
  };
}
const NOW = Date.parse("2026-11-12T00:00:00Z");
const MAIN: WorktreeRegistration = { path: "/srv/operator/remudero", branch: "main", bare: false, locked: false };
const CANDIDATE: WorktreeRegistration = { path: "/srv/hand/run-W1-T7001-1794000000000", branch: "run-W1-T7001-1794000000000", bare: false, locked: false };
const classify = (p: WorktreeRetirePorts, reg = CANDIDATE) =>
  classifyRegisteredWorktrees([MAIN, reg], p, { nowMs: NOW, operatorCheckout: MAIN.path });

describe("the refusal gates", () => {
  it("W1-T11941 criterion 2: a dirty, too-young, claimed, open-PR or unpushed tree is refused with its named reason and gets no would-retire row", async () => {
    const control = await classify(ports());
    assert.deepEqual(control.wouldRetire.map((o) => [o.path, o.reason]), [[CANDIDATE.path, "fully-pushed"]], "positive control: the base qualifies");
    const cases: Array<[string, Partial<WorktreeRetirePorts>]> = [
      ["dirty", { countDirtyFiles: async () => 3 }],
      ["too-young", { lastActivityMs: () => NOW - DAY + 60_000 }],
      ["dispatch-claimed", { dispatchClaims: async () => new Set(["W1-T7001"]) }],
      // Another run of the same task holds the open PR: still this task's work in flight.
      ["open-pr", { openPrHeads: async () => new Set(["run-W1-T7001-1794999999999"]) }],
      ["unpushed-commits", { unpushedCommits: async () => 2 }],
    ];
    for (const [reason, over] of cases) {
      const s = await classify(ports(over));
      assert.equal(s.wouldRetire.length, 0, `${reason}: no would-retire row`);
      assert.equal(s.kept.find((o) => o.path === CANDIDATE.path)?.reason, reason);
    }
  });

  it("an unanswerable gate is never a yes", async () => {
    const cases: Array<[string, Partial<WorktreeRetirePorts>]> = [
      ["claims-unreadable", { dispatchClaims: async () => undefined }],
      ["pr-state-unreadable", { openPrHeads: async () => undefined }],
      ["unreadable", { lastActivityMs: () => undefined }],
      ["unreadable", { countDirtyFiles: async () => undefined }],
      ["unreadable", { unpushedCommits: async () => undefined }],
      ["unreadable", { unpushedCommits: async () => 1, credits: async () => new Map([["W1-T7001", { sha: "c0", committedAtMs: NOW - DAY }]]), headCommittedAtMs: async () => undefined }],
      ["unpushed-commits", { unpushedCommits: async () => 1, credits: async () => new Map([["W1-T7001", { sha: "c0", committedAtMs: NOW - 4 * DAY }]]) }],
    ];
    for (const [reason, over] of cases) {
      const s = await classify(ports(over));
      assert.equal(s.wouldRetire.length, 0, reason);
      assert.equal(s.kept.find((o) => o.path === CANDIDATE.path)?.reason, reason);
    }
    const bare = await classify(ports(), { ...CANDIDATE, bare: true });
    const locked = await classify(ports(), { ...CANDIDATE, locked: true });
    assert.deepEqual([bare.kept[1]!.reason, locked.kept[1]!.reason], ["bare", "locked"]);
  });
});

/**
 * THE CANDIDATE TABLE. One registration per line: tier, path, branch (`-` = detached), age in days, dirty
 * files, unpushed commits, flags. The 2026-11-10 inventory itself is not in the repository; this table is
 * a stand-in shaped to its per-root counts (.claude/worktrees 38, rmd-mint 25, rmd-work 11, rmd-state2 4,
 * Remudero/worktrees 3, /mnt/scratch/hand 4, plus the operator checkout and 11 container registrations,
 * 97 in all) with 20 rows marked Tier A. Flags: claim, pr, locked, missing, credited (the task's trailer
 * landed after HEAD), late (HEAD was committed after that trailer).
 */
const RECORDED_CANDIDATES = `
- /home/craigoleyagent/remudero main 0 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/spry-moth-0 - 38 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/brisk-ibis-1 claude/brisk-ibis-1 7 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/wry-ibis-2 claude/wry-ibis-2 22 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/zany-moth-3 claude/zany-moth-3 25 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/wry-lynx-4 - 8 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/zany-ibis-5 claude/zany-ibis-5 16 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/bold-lynx-6 claude/bold-lynx-6 22 0 0 -
A /home/craigoleyagent/remudero/.claude/worktrees/spry-newt-7 claude/spry-newt-7 39 0 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/wry-moth-8 - 22 41 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/wry-newt-9 claude/wry-newt-9 0 0 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/brisk-heron-10 claude/brisk-heron-10 34 0 1 -
- /home/craigoleyagent/remudero/.claude/worktrees/spry-vole-11 claude/spry-vole-11 23 0 0 pr
- /home/craigoleyagent/remudero/.claude/worktrees/bold-moth-12 - 23 0 7 -
- /home/craigoleyagent/remudero/.claude/worktrees/spry-heron-13 claude/spry-heron-13 6 0 7 -
- /home/craigoleyagent/remudero/.claude/worktrees/glad-newt-14 claude/glad-newt-14 5 0 0 missing
- /home/craigoleyagent/remudero/.claude/worktrees/calm-finch-15 claude/calm-finch-15 28 0 0 locked
- /home/craigoleyagent/remudero/.claude/worktrees/calm-lynx-16 - 31 17 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/spry-otter-17 claude/spry-otter-17 0 0 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/calm-heron-18 claude/calm-heron-18 34 0 4 -
- /home/craigoleyagent/remudero/.claude/worktrees/wry-otter-19 claude/wry-otter-19 16 0 0 pr
- /home/craigoleyagent/remudero/.claude/worktrees/glad-vole-20 - 7 0 5 -
- /home/craigoleyagent/remudero/.claude/worktrees/calm-ibis-21 claude/calm-ibis-21 10 0 4 -
- /home/craigoleyagent/remudero/.claude/worktrees/zany-moth-22 claude/zany-moth-22 14 0 0 missing
- /home/craigoleyagent/remudero/.claude/worktrees/wry-ibis-23 claude/wry-ibis-23 5 0 0 locked
- /home/craigoleyagent/remudero/.claude/worktrees/bold-otter-24 - 26 19 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/brisk-vole-25 claude/brisk-vole-25 0 0 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/wry-finch-26 claude/wry-finch-26 20 0 9 -
- /home/craigoleyagent/remudero/.claude/worktrees/keen-ibis-27 claude/keen-ibis-27 17 0 0 pr
- /home/craigoleyagent/remudero/.claude/worktrees/spry-ibis-28 - 35 0 6 -
- /home/craigoleyagent/remudero/.claude/worktrees/keen-finch-29 claude/keen-finch-29 35 0 7 -
- /home/craigoleyagent/remudero/.claude/worktrees/bold-newt-30 claude/bold-newt-30 9 0 0 missing
- /home/craigoleyagent/remudero/.claude/worktrees/keen-moth-31 claude/keen-moth-31 32 0 0 locked
- /home/craigoleyagent/remudero/.claude/worktrees/bold-otter-32 - 13 6 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/keen-vole-33 claude/keen-vole-33 0 0 0 -
- /home/craigoleyagent/remudero/.claude/worktrees/keen-ibis-34 claude/keen-ibis-34 17 0 7 -
- /home/craigoleyagent/remudero/.claude/worktrees/brisk-ibis-35 claude/brisk-ibis-35 27 0 0 pr
- /home/craigoleyagent/remudero/.claude/worktrees/wry-ibis-36 - 15 0 9 -
- /home/craigoleyagent/remudero/.claude/worktrees/spry-lynx-37 claude/spry-lynx-37 36 0 5 -
A /home/craigoleyagent/rmd-mint/run-W1-T4268-1791792493006 run-W1-T4268-1791792493006 23 0 1 credited
A /home/craigoleyagent/rmd-mint/run-W1-T7880-1791084966706 run-W1-T7880-1791084966706 10 0 0 -
A /home/craigoleyagent/rmd-mint/run-W1-T5861-1791996234658 run-W1-T5861-1791996234658 31 0 1 credited
A /home/craigoleyagent/rmd-mint/run-W1-T3554-1793162988229 run-W1-T3554-1793162988229 12 0 0 -
A /home/craigoleyagent/rmd-mint/run-W1-T10099-1791915548092 run-W1-T10099-1791915548092 35 0 1 credited
A /home/craigoleyagent/rmd-mint/run-W1-T8651-1793281357534 run-W1-T8651-1793281357534 14 0 0 -
A /home/craigoleyagent/rmd-mint/run-W1-T5746-1791032053816 run-W1-T5746-1791032053816 30 0 5 credited
- /home/craigoleyagent/rmd-mint/run-W1-T8009-1792767685203 run-W1-T8009-1792767685203 7 33 0 -
- /home/craigoleyagent/rmd-mint/run-W1-T9582-1793088674630 run-W1-T9582-1793088674630 0 0 0 -
- /home/craigoleyagent/rmd-mint/run-W1-T11598-1793217479850 run-W1-T11598-1793217479850 18 0 0 claim
- /home/craigoleyagent/rmd-mint/run-W1-T8666-1792895656841 run-W1-T8666-1792895656841 20 0 0 pr
- /home/craigoleyagent/rmd-mint/run-W1-T11768-1792973209059 run-W1-T11768-1792973209059 27 0 7 -
- /home/craigoleyagent/rmd-mint/run-W1-T10022-1791732669989 run-W1-T10022-1791732669989 24 0 5 credited,late
- /home/craigoleyagent/rmd-mint/run-W1-T5464-1794323576087 run-W1-T5464-1794323576087 23 0 0 missing
- /home/craigoleyagent/rmd-mint/run-W1-T7273-1793685908316 run-W1-T7273-1793685908316 23 0 0 locked
- /home/craigoleyagent/rmd-mint/run-W1-T5871-1793660582765 run-W1-T5871-1793660582765 4 28 0 -
- /home/craigoleyagent/rmd-mint/run-W1-T9982-1792617621938 run-W1-T9982-1792617621938 0 0 0 -
- /home/craigoleyagent/rmd-mint/run-W1-T11745-1792213765293 run-W1-T11745-1792213765293 3 0 0 claim
- /home/craigoleyagent/rmd-mint/run-W1-T7593-1794220345428 run-W1-T7593-1794220345428 19 0 0 pr
- /home/craigoleyagent/rmd-mint/run-W1-T7370-1791713355513 run-W1-T7370-1791713355513 28 0 2 -
- /home/craigoleyagent/rmd-mint/run-W1-T10055-1791026349274 run-W1-T10055-1791026349274 37 0 6 credited,late
- /home/craigoleyagent/rmd-mint/run-W1-T11154-1791494667092 run-W1-T11154-1791494667092 35 0 0 missing
- /home/craigoleyagent/rmd-mint/run-W1-T10251-1791267894417 run-W1-T10251-1791267894417 8 0 0 locked
- /home/craigoleyagent/rmd-mint/run-W1-T4395-1792581532755 run-W1-T4395-1792581532755 12 15 0 -
- /home/craigoleyagent/rmd-mint/run-W1-T3372-1791801334137 run-W1-T3372-1791801334137 0 0 0 -
A /home/craigoleyagent/rmd-work/run-W1-T6408-1792252141662 run-W1-T6408-1792252141662 12 0 3 credited
A /home/craigoleyagent/rmd-work/run-W1-T6743-1792331694962 run-W1-T6743-1792331694962 5 0 0 -
A /home/craigoleyagent/rmd-work/run-W1-T6855-1791851441596 run-W1-T6855-1791851441596 9 0 1 credited
- /home/craigoleyagent/rmd-work/run-W1-T4456-1791117551973 run-W1-T4456-1791117551973 32 23 0 -
- /home/craigoleyagent/rmd-work/run-W1-T9576-1793387577528 run-W1-T9576-1793387577528 0 0 0 -
- /home/craigoleyagent/rmd-work/run-W1-T9605-1793535139315 run-W1-T9605-1793535139315 34 0 0 claim
- /home/craigoleyagent/rmd-work/run-W1-T4776-1791842125876 run-W1-T4776-1791842125876 25 0 0 pr
- /home/craigoleyagent/rmd-work/run-W1-T11535-1791767837915 run-W1-T11535-1791767837915 14 0 3 -
- /home/craigoleyagent/rmd-work/run-W1-T5245-1793618311302 run-W1-T5245-1793618311302 32 0 8 credited,late
- /home/craigoleyagent/rmd-work/run-W1-T10410-1793046336964 run-W1-T10410-1793046336964 29 0 0 missing
- /home/craigoleyagent/rmd-work/run-W1-T9150-1791627880275 run-W1-T9150-1791627880275 5 0 0 locked
- /home/craigoleyagent/rmd-state2/worktrees/run-W1-T8288-1791079485411 run-W1-T8288-1791079485411 29 13 0 -
- /home/craigoleyagent/rmd-state2/worktrees/run-W1-T4498-1793010439410 run-W1-T4498-1793010439410 0 0 0 -
- /home/craigoleyagent/rmd-state2/worktrees/run-W1-T4569-1793744932116 run-W1-T4569-1793744932116 8 0 0 claim
- /home/craigoleyagent/rmd-state2/worktrees/run-W1-T3183-1792728501210 run-W1-T3183-1792728501210 32 0 0 pr
A /home/craigoleyagent/Remudero/worktrees/run-W1-T7211-1792710260753 run-W1-T7211-1792710260753 20 0 5 credited
- /home/craigoleyagent/Remudero/worktrees/run-W1-T6525-1791245526427 run-W1-T6525-1791245526427 20 26 0 -
- /home/craigoleyagent/Remudero/worktrees/run-W1-T5285-1794379641765 run-W1-T5285-1794379641765 0 0 0 -
A /mnt/scratch/hand/hand-preflight-0 - 6 0 0 -
- /mnt/scratch/hand/hand-serve-1 hand-serve-1 27 34 0 -
- /mnt/scratch/hand/hand-deploy-2 hand-deploy-2 0 0 0 -
- /mnt/scratch/hand/hand-preflight-3 - 20 0 7 -
- /home/node/Remudero/worktrees/run-W1-T6482-1793242295370 run-W1-T6482-1793242295370 30 0 0 -
- /home/node/Remudero/worktrees/run-W1-T10536-1792120422441 run-W1-T10536-1792120422441 19 0 0 -
- /home/node/Remudero/worktrees/run-W1-T3866-1791058518191 run-W1-T3866-1791058518191 23 0 0 -
- /home/node/Remudero/worktrees/run-W1-T11890-1792468131461 run-W1-T11890-1792468131461 28 0 0 -
- /home/node/Remudero/worktrees/run-W1-T4088-1793200125338 run-W1-T4088-1793200125338 25 0 0 -
- /home/node/Remudero/worktrees/run-W1-T7099-1793252340821 run-W1-T7099-1793252340821 15 0 0 -
- /home/node/Remudero/worktrees/run-W1-T11015-1792026549022 run-W1-T11015-1792026549022 14 0 0 -
- /home/node/Remudero/worktrees/run-W1-T9420-1793041361775 run-W1-T9420-1793041361775 24 0 0 -
- /home/node/Remudero/worktrees/run-W1-T4327-1793577918768 run-W1-T4327-1793577918768 16 0 0 -
- /home/node/Remudero/worktrees/run-W1-T3011-1792700532028 run-W1-T3011-1792700532028 8 0 0 -
- /home/node/Remudero/worktrees/run-W1-T5183-1792771385614 run-W1-T5183-1792771385614 11 0 0 -
`;

describe("replay", () => {
  it("W1-T11941 criterion 3: replayed against the candidate table it selects exactly the 20 Tier A paths and never a container /home/node registration", async () => {
    const recs = RECORDED_CANDIDATES.trim().split("\n").map((line) => {
      const [tier, path, branch, age, dirty, unpushed, flags] = line.trim().split(/ +/);
      return { tier, path: path!, branch: branch === "-" ? undefined : branch, ageMs: Number(age) * DAY,
        dirty: Number(dirty), unpushed: Number(unpushed), flags: new Set(flags!.split(",")) };
    });
    assert.equal(recs.length, 97, "the table holds the inventory's 97 registrations");
    const by = new Map(recs.map((r) => [r.path, r]));
    const credit = { sha: "f00d", committedAtMs: NOW - DAY };
    const replay = ports({
      pathExists: (p) => !by.get(p)!.flags.has("missing"),
      lastActivityMs: (p) => NOW - by.get(p)!.ageMs,
      countDirtyFiles: async (p) => by.get(p)!.dirty,
      unpushedCommits: async (p) => by.get(p)!.unpushed,
      headCommittedAtMs: async (p) => credit.committedAtMs + (by.get(p)!.flags.has("late") ? 1 : -1) * 60_000,
      dispatchClaims: async () => new Set(recs.filter((r) => r.flags.has("claim")).map((r) => taskIdOfRunBranch(r.branch)!)),
      openPrHeads: async () => new Set(recs.filter((r) => r.flags.has("pr")).map((r) => r.branch!)),
      credits: async () => new Map(recs.filter((r) => r.flags.has("credited")).map((r) => [taskIdOfRunBranch(r.branch)!, credit])),
    });
    const regs = recs.map((r) => ({ path: r.path, branch: r.branch, bare: false, locked: r.flags.has("locked") }));
    const s = await classifyRegisteredWorktrees(regs, replay, { nowMs: NOW, operatorCheckout: recs[0]!.path });
    const tierA = recs.filter((r) => r.tier === "A").map((r) => r.path).sort();
    assert.equal(tierA.length, 20);
    assert.deepEqual(s.wouldRetire.map((o) => o.path).sort(), tierA, "exactly the Tier A paths, and none of the others");
    assert.ok(s.wouldRetire.every((o) => !o.path.startsWith(CONTAINER_HOME_PREFIX)));
    const container = s.kept.filter((o) => o.path.startsWith(CONTAINER_HOME_PREFIX));
    assert.equal(container.length, 11);
    assert.ok(container.every((o) => o.reason === "container-registration"), "a container registration is refused before any other gate reads it");
  });
});

describe("the parsers and the open-PR read", () => {
  it("parses porcelain, run branches, trailers and GitHub remotes", () => {
    assert.deepEqual(parseWorktreeList("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\nlocked why\n\nworktree /c\nbare\n"), [
      { path: "/a", head: "1", branch: "main", bare: false, locked: false },
      { path: "/b", head: "2", bare: false, locked: true },
      { path: "/c", bare: true, locked: false },
    ]);
    assert.deepEqual([taskIdOfRunBranch("run-W1-T1-1794000000000"), taskIdOfRunBranch("run-unfiled-1794000000000"), taskIdOfRunBranch("claude/x"), taskIdOfRunBranch(undefined)],
      ["W1-T1", undefined, undefined, undefined]);
    const credits = parseTaskCredits("a\x1f100\x1ffix: x\n\nRemudero-Task: W1-T5\n\nCo-authored-by: y\x1e\nb\x1f200\x1ffeat: y\n\nRemudero-Task: W1-T5\x1e\nc\x1fbad\x1fRemudero-Task: W1-T6\x1e");
    assert.deepEqual([...credits], [["W1-T5", { sha: "b", committedAtMs: 200_000 }]]);
    assert.deepEqual([repoSlugOfRemoteUrl("https://github.com/craigoley/remudero.git"), repoSlugOfRemoteUrl("git@github.com:o/r"), repoSlugOfRemoteUrl("/tmp/origin.git")],
      ["craigoley/remudero", "o/r", undefined]);
  });

  it("reads open PR heads and fails closed on a failed, malformed or unaddressable read", async () => {
    const seen: string[][] = [];
    const heads = await defaultOpenPrHeads("o/r", () => {}, async (args) => { seen.push(args); return [{ headRefName: "run-W1-T1-1794000000000" }]; });
    assert.deepEqual([...heads!], ["run-W1-T1-1794000000000"]);
    assert.deepEqual(seen[0]!.slice(0, 5), ["pr", "list", "--repo", "o/r", "--state"]);
    const { rows, log } = recorder();
    assert.equal(await defaultOpenPrHeads("o/r", log, async () => { throw new Error("gh down"); }), undefined);
    assert.equal(await defaultOpenPrHeads("o/r", log, async () => [{ number: 1 }]), undefined);
    assert.equal(await defaultOpenPrHeads(undefined, log), undefined);
    assert.deepEqual(rows.map((r) => r.extra.what), ["open-prs", "open-prs", "open-prs"]);
  });
});

describe("the daemon tick", () => {
  it("calls the janitor on every tick and logs a failed pass without stopping", async () => {
    const plan = loadPlanFromYaml("- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n", "t11941-tick");
    const steps: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lists = 0;
    let sleeps = 0;
    const result = await runDaemon(plan, {
      refreshMerged: () => () => false,
      runOne: async () => { await gate; return { taskId: "A", runId: "A-run", merged: true, costUsd: 0, verdict: "merged" }; },
      sweepLight: async () => {},
      worktreeRetire: {
        operatorCheckout: "/srv/operator/remudero", intervalMs: 0, ...ports({
          listWorktrees: async () => { lists++; return `worktree /srv/operator/remudero\nHEAD 1\nbranch refs/heads/main\n`; },
          dispatchClaims: async () => { if (lists >= 2) throw new Error("ls-remote exploded"); return new Set(); },
        }),
      },
      sleep: async () => {
        sleeps++;
        await new Promise((r) => setImmediate(r));
        if (steps.filter((s) => s === "daemon.alive").length >= 3 || sleeps >= 10) release?.();
      },
      log: (step) => void steps.push(step),
    } satisfies DaemonDeps, { max: 1 });
    assert.equal(result.stopReason, "max_reached");
    assert.ok(lists >= 2, `the janitor ran on more than one tick (${lists})`);
    assert.ok(steps.includes(WORKTREE_RETIRE_PASS_STEP), "a pass row reached the daemon's ledger log");
    assert.ok(steps.includes("daemon.worktree_retire_report.error"), "a thrown pass is logged and the daemon carries on");
  });
});
