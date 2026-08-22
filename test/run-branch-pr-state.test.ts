import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import {
  closedUnmergedRunBranchTaskIds,
  nextRunnable,
  runBranchTaskIds,
  runDrain,
  type DrainDeps,
  type MergedSet,
} from "../src/lib/drain.js";
import { readRunBranchClosedPrsOutput, type RunResult } from "../src/run-task.js";
import type { GhApiFetcher, RestPullRow } from "../src/lib/open-prs-rest.js";

// W1-T1207 — `hasPushedRunBranch` (W1-T534) was built to close a SECONDS-WIDE cache blind spot:
// the window between a branch being pushed and the cached PR projection catching up. It has no
// upper bound of its own, and GitHub deletes a head branch on MERGE but NOT ON CLOSE, so a run
// branch left standing by a CLOSED-UNMERGED pull request read as work in flight FOREVER and
// permanently un-dispatched its task (measured: W1-T1098, W1-T1101, W1-T1104, W1-T1109,
// W1-T1000002, each excluded by a PR closed in error).
//
// THE FIX reads the pull request's state rather than guessing an age bound (design (v)): OPEN and
// DRAFT still mean in flight (still blocks); no PR at all is the exact blind-spot rationale W1-T534
// quotes (still blocks); MERGED needs no rule because GitHub deletes the head (self-clears); only
// CLOSED-UNMERGED must stop blocking, because a PR that says the work is not in flight is not
// evidence the branch is either — it is a leftover.

const NONE_MERGED: MergedSet = () => false;

const ONE_TASK_YAML = `
- id: A
  title: a run branch task
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: B
  title: independent fallback candidate
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

function plan() {
  return loadPlanFromYaml(ONE_TASK_YAML, "fixture");
}

/** Raw `git ls-remote --heads origin 'run-*'` output naming exactly the given task ids. */
function lsRemoteRunBranches(...taskIds: string[]): string {
  return taskIds.map((id, i) => `abc123def4560${i}\trefs/heads/run-${id}-178688648869${i}`).join("\n");
}

/** Raw `pulls?state=closed` rows ({@link closedUnmergedRunBranchTaskIds}'s own input shape). */
function closedPrRows(...entries: Array<{ ref: string; merged: boolean }>): string {
  return entries.map((e) => `${e.ref}\t${!e.merged}`).join("\n");
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

// ── PURE PARSER: closedUnmergedRunBranchTaskIds ─────────────────────────────────────────────────

test("W1-T1207: closedUnmergedRunBranchTaskIds names only the unmerged-closed rows, by the SAME taskIdFromRunBranch extractor runBranchTaskIds already uses", () => {
  const raw = [
    // `head.ref` from the REST API is a BARE branch name (never `refs/heads/...`) — the same
    // shape `readRunBranchClosedPrsOutput` (run-task.ts) emits.
    "run-A-1786886488695\ttrue", // closed, unmerged — the leftover case
    "run-B-1786886488696\tfalse", // closed, MERGED — never appears in practice (GitHub deletes
    // the head), included only to prove a merged row is not misread as unmerged
    "", // blank line — skipped, never thrown
    "not-a-run-branch\ttrue", // no task id parses out — skipped
  ].join("\n");
  const ids = closedUnmergedRunBranchTaskIds(raw);
  assert.deepEqual([...ids], ["A"]);
});

test("W1-T1207: closedUnmergedRunBranchTaskIds degrades a malformed row to 'not observed', never a crash", () => {
  assert.equal(closedUnmergedRunBranchTaskIds("").size, 0);
  assert.equal(closedUnmergedRunBranchTaskIds("garbage\n\nrefs/heads/run-A-1\tmaybe").size, 0, "'maybe' is not the literal 'true' the merged_at==null discriminator requires");
});

// ── ACCEPTANCE 1: a closed-and-unmerged PR's branch no longer blocks dispatch ───────────────────

test("W1-T1207: nextRunnable admits a task whose pushed branch's PR is CLOSED AND UNMERGED", () => {
  const sweep = runBranchTaskIds(lsRemoteRunBranches("A"));
  const closedUnmerged = closedUnmergedRunBranchTaskIds(closedPrRows({ ref: "run-A-1786886488690", merged: false }));
  const next = nextRunnable(plan(), NONE_MERGED, {
    // The exact composition `hasPushedRunBranch`'s own doc prescribes: pushed AND NOT closed-unmerged.
    hasPushedRunBranch: (id) => sweep.has(id) && !closedUnmerged.has(id),
  });
  assert.equal(next?.id, "A", "A's branch is a leftover from an abandoned attempt, not evidence of work in flight");
});

// ── ACCEPTANCE 2: an open or draft PR's branch keeps blocking ───────────────────────────────────

test("W1-T1207: nextRunnable still refuses a task whose pushed branch's PR is OPEN (or DRAFT) — absent from the closed-PR sweep entirely", () => {
  const sweep = runBranchTaskIds(lsRemoteRunBranches("A"));
  // An OPEN or DRAFT pull request never appears on a `state=closed` page at all — GitHub's `state`
  // filter excludes it outright — so the closed-unmerged set built from that sweep is empty here,
  // by construction, exactly as it would be against the real API.
  const closedUnmerged = closedUnmergedRunBranchTaskIds("");
  const next = nextRunnable(plan(), NONE_MERGED, {
    hasPushedRunBranch: (id) => sweep.has(id) && !closedUnmerged.has(id),
  });
  assert.equal(next?.id, "B", "A stays blocked — an OPEN/DRAFT PR means the work is still in flight");
});

// ── ACCEPTANCE 3: no PR at all keeps blocking — the exact blind spot W1-T534 was built to close ──

test("W1-T1207: nextRunnable still refuses a task whose branch has NO pull request at all", () => {
  const sweep = runBranchTaskIds(lsRemoteRunBranches("A"));
  // No PR ⇒ no row anywhere, open or closed ⇒ the closed-unmerged set is empty, same as the OPEN
  // case above — this is deliberate (design (ii)): treating a PR-less branch as dispatchable would
  // reintroduce exactly the collision W1-T534 exists to prevent.
  const closedUnmerged = closedUnmergedRunBranchTaskIds("");
  const next = nextRunnable(plan(), NONE_MERGED, {
    hasPushedRunBranch: (id) => sweep.has(id) && !closedUnmerged.has(id),
  });
  assert.equal(next?.id, "B", "a branch merely pushed ahead of its PR is the blind spot itself — it must keep blocking");
});

test("W1-T1207: hasPushedRunBranch omitted (or readClosedRunBranchPrs omitted) behaves EXACTLY as before this task existed", () => {
  const sweep = runBranchTaskIds(lsRemoteRunBranches("A"));
  // No `readClosedRunBranchPrs` supplied in production shape ⇒ `closedUnmergedRunBranches` stays
  // `undefined` ⇒ `!closedUnmergedRunBranches?.has(id)` is `!undefined` ⇒ always `true` ⇒ blocks on
  // ANY pushed branch, byte-identical to W1-T916's own behaviour.
  const next = nextRunnable(plan(), NONE_MERGED, { hasPushedRunBranch: (id) => sweep.has(id) });
  assert.equal(next?.id, "B", "with no PR-state read at all, a pushed branch blocks unconditionally, unchanged");
});

// ── ACCEPTANCE 4: the branch state is read ONCE PER PASS, never once per candidate ───────────────

test("W1-T1207: runDrain reads readClosedRunBranchPrs exactly ONCE per pass, however many candidates it evaluates", async () => {
  const twoTaskPlan = loadPlanFromYaml(
    `
- id: A
  title: has a closed-unmerged run branch
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: B
  title: also has a closed-unmerged run branch
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: C
  title: has no run branch at all
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`,
    "fixture",
  );
  let closedReads = 0;
  let pushedReads = 0;
  const ran: string[] = [];
  const merged = new Set<string>();
  await runDrain(
    twoTaskPlan,
    {
      // Tracks what `runOne` below actually merged — a fixed `() => false` would let `nextRunnable`
      // offer the SAME just-dispatched task again next iteration, since nothing else marks it done.
      refreshMerged: () => (id) => merged.has(id),
      readPushedRunBranches: () => {
        pushedReads++;
        return lsRemoteRunBranches("A", "B");
      },
      readClosedRunBranchPrs: () => {
        closedReads++;
        return closedPrRows({ ref: "run-A-1786886488690", merged: false }, { ref: "run-B-1786886488691", merged: false });
      },
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
    },
    { max: 3 },
  );
  assert.deepEqual(ran.sort(), ["A", "B", "C"], "all three dispatch — the closed-unmerged branches never block");
  assert.equal(pushedReads, 1, "the pushed-branch ls-remote sweep is read once per pass, not once per candidate");
  assert.equal(closedReads, 1, "the closed-PR sweep is read once per pass, not once per candidate — the whole cost argument");
});

test("W1-T1207: the lane dispatch path (runDrainLanes) also reads readClosedRunBranchPrs exactly once per pass", async () => {
  let closedReads = 0;
  const ran: string[] = [];
  const merged = new Set<string>();
  await runDrain(
    plan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      readPushedRunBranches: () => lsRemoteRunBranches("A"),
      readClosedRunBranchPrs: () => {
        closedReads++;
        return closedPrRows({ ref: "run-A-1786886488690", merged: false });
      },
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
    },
    { max: 2, laneCount: 2 },
  );
  assert.ok(ran.includes("A"), "A dispatches on the lanes path too — the same predicate composition applies there");
  assert.equal(closedReads, 1, "hoisted once above the lanes loop, exactly like pushedRunBranches");
});

// ── ACCEPTANCE 5: no dispatch path deletes or rewrites a run branch ─────────────────────────────

test("W1-T1207: readRunBranchClosedPrsOutput issues only a READ-shaped `pulls?state=closed` call — never a delete/rewrite verb — and its output is inert data, not a command", () => {
  const seenArgs: string[][] = [];
  const fetch: GhApiFetcher = (args) => {
    seenArgs.push(args);
    const page = Number(new URLSearchParams(args[1].split("?")[1]).get("page"));
    if (page > 1) return [] as RestPullRow[];
    return [
      { number: 1, html_url: "x", updated_at: "t", head: { ref: "run-A-1786886488690" }, merged_at: null } as RestPullRow,
    ];
  };
  const out = readRunBranchClosedPrsOutput("o", "r", fetch);
  assert.equal(out, "run-A-1786886488690\ttrue", "the output is a plain data row — no branch name is ever handed to a mutating command");
  assert.ok(seenArgs.length > 0, "the fetcher was actually invoked");
  for (const args of seenArgs) {
    assert.equal(args[0], "api", "every call is a `gh api` read");
    assert.match(args[1], /pulls\?state=closed/, "every call reads the closed-PR LIST endpoint");
    assert.ok(
      !args.some((a) => /^-X$|^--method$|delete/i.test(a)),
      "no call ever carries a mutating HTTP method or the word 'delete'",
    );
  }
});

test("W1-T1207: readRunBranchClosedPrsOutput fails TOWARD still-blocking (empty output), the opposite direction from readPushedRunBranchesOutput's own fail-open", () => {
  const thrown = readRunBranchClosedPrsOutput("o", "r", () => {
    throw new Error("rate limited");
  });
  assert.equal(thrown, "", "a throw yields empty output");
  assert.equal(
    closedUnmergedRunBranchTaskIds(thrown).size,
    0,
    "which parses to an EMPTY exclusion set — every pushed branch keeps blocking, never wrongly unblocked",
  );
});

test("W1-T1207: DrainDeps carries no branch-deletion capability at all — the guard can only READ PR state, by construction", async () => {
  // A structural proof, not a behavioural one: `readClosedRunBranchPrs`/`readPushedRunBranches` are
  // both typed `() => string` — nullary readers with no branch-name/sha parameter a caller could
  // even aim at a delete. `rmd reap-branches` (run-task.ts) remains the sole DRY-RUN reporter; this
  // pass never calls it and never constructs a delete-shaped `gh`/`git` invocation anywhere in the
  // dispatch chain, which the assertions above already exercise end to end.
  const deps: DrainDeps = {
    refreshMerged: () => () => false,
    readPushedRunBranches: () => lsRemoteRunBranches("A"),
    readClosedRunBranchPrs: () => closedPrRows({ ref: "run-A-1786886488690", merged: false }),
    runOne: async (id) => okResult(id),
  };
  assert.equal(deps.readPushedRunBranches!.length, 0, "nullary — no branch it could target for mutation");
  assert.equal(deps.readClosedRunBranchPrs!.length, 0, "nullary — same contract");
  const summary = await runDrain(plan(), deps, { max: 1 });
  assert.deepEqual(summary.merged, ["A"], "dispatch proceeded from a READ alone — nothing was deleted or rewritten to get there");
});
