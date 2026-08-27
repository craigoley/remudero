/**
 * test/open-build-is-not-credit.test.ts — W1-T2397.
 *
 * THE ASYMMETRY. `isDispatchEligible` already sees open PRs, via `opts.isOpenPr` <-
 * `lastProj?.get(id)?.prState === "OPEN"`, resolved in `corroborateOpenByBranch` off the batched
 * gateway's OPEN half — no second call. But it attributes them by `ownsBranch` alone,
 * `^run-<taskId>-<digits>$`: ONE surface, where the merged side now has three. So an
 * operator-briefed build on a `fix/` branch is invisible and the task is dispatched again.
 * MEASURED: W1-T2387's #3102 was open and 87 minutes old when the fleet produced #3109.
 *
 * A WARN, AND MEASUREMENT IS WHY IT IS NOT A REFUSAL. The naive predicate fired 4 times in 72
 * hours and THREE OF THOSE MERGED. Nor does a bound rescue it: time-to-merge is median 18 min,
 * p90 119, p95 255, p99 864, so a staleness threshold must sit near EIGHT HOURS before it stops
 * firing on healthy work — and a refusal that is right at eight hours still costs eight hours of
 * stall. A warn that is wrong costs one line. That asymmetry is the whole argument for building
 * this at n=1, and it is also why the warn must stay cheap, quiet and side-effect-free.
 *
 * QUIET IS A REQUIREMENT, NOT A HOPE: 101 of 105 dispatches in the same window had no open
 * sibling of any kind, and the file-overlap discriminator is what keeps it that way.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSiblingBuild, projectPlan } from "../src/lib/status.js";
import type { GitHub, OpenSiblingBuild, PrRef, StatusProjection } from "../src/lib/status.js";
import { nextRunnable } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";

const TASK_FILES = ["src/lib/status.ts", "src/lib/drain.ts", "test/open-build-is-not-credit.test.ts"];

const task = (id: string, files: string[] = TASK_FILES): Task =>
  ({ id, title: id, repo: "remudero", type: "implement", verify: "auto", depends_on: [], status: "queued", files }) as unknown as Task;

const emptyLedger = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), "t2397-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
};

/** #3102's real shape: OPEN, on a `fix/` branch, touching a file W1-T2397 also declares. */
const OPEN_SIBLING: PrRef = {
  number: 3102,
  url: "https://github.com/craigoley/remudero/pull/3102",
  state: "OPEN",
  title: "fix(status): credit a merged task from the commit trailer when the body carries none",
  headRefName: "fix/trailer-surface-union",
};
/** A plan FILING that names the task — two of the four naive firings were this shape. */
const OPEN_FILING: PrRef = {
  number: 3114,
  url: "https://github.com/craigoley/remudero/pull/3114",
  state: "OPEN",
  title: "chore(plan): file the open, unmerged build that credits nothing (W1-T2397)",
  headRefName: "chore/plan-file-w1-t2397",
};
/** A build of a DIFFERENT task that merely mentions this one — the other two naive firings. */
const OPEN_MENTION: PrRef = {
  number: 3109,
  url: "https://github.com/craigoley/remudero/pull/3109",
  state: "OPEN",
  title: "fix(elsewhere): a change that mentions W1-T2397 in passing",
  headRefName: "fix/somewhere-else",
};
/** The task's OWN run branch — the in-flight case `isOpenPr` already owns. */
const OWN_RUN: PrRef = {
  number: 3120,
  url: "https://github.com/craigoley/remudero/pull/3120",
  state: "OPEN",
  title: "feat(x): this task's own run",
  headRefName: "run-W1-T2397-1787000000000",
};

const FILES: Record<string, string[]> = {
  [OPEN_SIBLING.url]: ["src/lib/status.ts", "test/trailer-surface-union.test.ts"],
  [OPEN_FILING.url]: ["plan/tasks.d/W1-T2397-a-task.yaml"],
  [OPEN_MENTION.url]: ["src/lib/sweep.ts", "test/sweep.test.ts"],
  [OWN_RUN.url]: ["src/lib/status.ts"],
};
const changedFiles = (u: string): string[] | undefined => FILES[u];

// ── the predicate ────────────────────────────────────────────────────────────────────────────

test("acceptance 1: an open build on a branch that is NOT this task's own run branch is observed", () => {
  const sib = openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_SIBLING], changedFiles);
  assert.ok(sib, "the #3102 shape is observed");
  assert.equal(sib!.prNumber, 3102);
});

test("acceptance 2: the observation names the PR and the overlapping paths, never a bare count", () => {
  const sib = openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_SIBLING], changedFiles)!;
  assert.equal(sib.prUrl, OPEN_SIBLING.url);
  assert.equal(sib.headRefName, "fix/trailer-surface-union");
  assert.deepEqual(sib.overlappingPaths, ["src/lib/status.ts"], "the path that made it a build of THIS task");
});

test("acceptance 4: an open PR that merely MENTIONS the task, touching none of its files, is not observed", () => {
  // Two of the four naive firings were this shape, and both merged. Prose is not the signal.
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_MENTION], changedFiles), undefined);
});

test("acceptance 5: a plan FILING that names the task is not mistaken for a build of it", () => {
  // A filing touches `plan/` alone, so the file-overlap test drops it by construction.
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_FILING], changedFiles), undefined);
});

test("the task's OWN run branch is excluded — that is the in-flight case isOpenPr already owns", () => {
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [OWN_RUN], changedFiles), undefined);
  // ...and it is excluded by BRANCH, not by luck: the same PR under another branch name IS seen.
  assert.ok(openSiblingBuild("W1-T2397", TASK_FILES, [{ ...OWN_RUN, headRefName: "fix/renamed" }], changedFiles));
});

test("QUIET ON THE COMMON CASE: the 101-of-105 shape — open PRs exist, none touches a declared file", () => {
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_FILING, OPEN_MENTION], changedFiles), undefined);
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [], changedFiles), undefined, "no open PRs at all");
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, null, changedFiles), undefined, "a FAILED open read observes nothing");
  assert.equal(openSiblingBuild("W1-T2397", undefined, [OPEN_SIBLING], changedFiles), undefined, "a task declaring no files");
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_SIBLING], undefined), undefined, "no file reader");
  assert.equal(openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_SIBLING], () => undefined), undefined, "an UNREADABLE file list is never a guess");
});

// ── the projection carries it, and carries nothing else differently ──────────────────────────

function gateway(open: PrRef[]): GitHub {
  const g = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: (u: string) => open.find((p) => p.url === u)?.headRefName,
    prBody: (u: string) => open.find((p) => p.url === u)?.title,
    listOpenHeadBranches: () => open,
    listMergedHeadBranches: () => [],
  } as unknown as GitHub;
  (g as unknown as { changedFiles: (u: string) => string[] | undefined }).changedFiles = changedFiles;
  return g;
}
const project = (open: PrRef[], id = "W1-T2397"): StatusProjection =>
  projectPlan({ tasks: [task(id)] } as unknown as Plan, { ledgerPath: emptyLedger(), github: gateway(open) }).get(id)!;

test("the projection carries the observation, and `prState` — what isOpenPr reads — is byte-identical with and without it", () => {
  const withSib = project([OPEN_SIBLING]);
  const without = project([OPEN_MENTION]);
  assert.ok(withSib.openSiblingBuild, "observed");
  assert.equal(without.openSiblingBuild, undefined, "and quiet on the common case");

  // Q1: THE OBSERVATION MUST NOT FEED `isOpenPr`. `isOpenPr` is
  // `lastProj?.get(id)?.prState === "OPEN"` — so this is the field that must not move.
  assert.equal(withSib.prState, without.prState, "prState is untouched by the observation");
  const strip = (p: Record<string, unknown>) => { const c = { ...p }; delete c.openSiblingBuild; return c; };
  assert.deepEqual(strip(withSib as unknown as Record<string, unknown>), strip(without as unknown as Record<string, unknown>),
    "every other projection field is byte-identical — the observation adds a field and changes nothing");
});

// ── the dispatch route: observe, then dispatch anyway ────────────────────────────────────────

const plan = (id = "W1-T2397"): Plan => ({ tasks: [task(id)] }) as unknown as Plan;
const noneMerged = () => false;
const SIB: OpenSiblingBuild = { prNumber: 3102, prUrl: OPEN_SIBLING.url, headRefName: "fix/trailer-surface-union", overlappingPaths: ["src/lib/status.ts"] };

test("acceptance 3: the dispatch STILL PROCEEDS — an open PR is not proof the work is done", () => {
  const seen: Array<{ id: string; pr: number }> = [];
  const picked = nextRunnable(plan(), noneMerged, {
    openSiblingBuildFor: () => SIB,
    onOpenSiblingBuild: (t, s) => seen.push({ id: t.id, pr: s.prNumber }),
  });
  assert.equal(picked?.id, "W1-T2397", "the task is dispatched anyway — this is a warn, never a refusal");
  assert.deepEqual(seen, [{ id: "W1-T2397", pr: 3102 }], "and the observation names both the task and the open PR");
});

test("acceptance 3 (control): the SAME task is dispatched identically with no observation wired at all", () => {
  const withOut = nextRunnable(plan(), noneMerged, {});
  const withObs = nextRunnable(plan(), noneMerged, { openSiblingBuildFor: () => SIB, onOpenSiblingBuild: () => {} });
  assert.equal(withOut?.id, "W1-T2397", "the control is not vacuous — this fixture really is dispatchable");
  assert.equal(withOut?.id, withObs?.id, "the selection is byte-identical either way");
});

test("the observation fires ONCE per dispatch, not once per candidate — that is what keeps it quiet", () => {
  let calls = 0;
  const many = { tasks: [task("W1-T1"), task("W1-T2"), task("W1-T3")] } as unknown as Plan;
  const picked = nextRunnable(many, noneMerged, { openSiblingBuildFor: () => SIB, onOpenSiblingBuild: () => { calls++; } });
  assert.ok(picked, "something was dispatched");
  assert.equal(calls, 1, "one observation for the one task actually dispatched");
});

test("a THROWING observation still dispatches — a warn that costs a dispatch would invert the argument", () => {
  const picked = nextRunnable(plan(), noneMerged, {
    openSiblingBuildFor: () => SIB,
    onOpenSiblingBuild: () => { throw new Error("the observation blew up"); },
  });
  assert.equal(picked?.id, "W1-T2397");
});

test("acceptance 6: the in-flight check that already refuses a dispatch is unchanged", () => {
  const withObs = nextRunnable(plan(), noneMerged, {
    isOpenPr: () => 3120,
    openSiblingBuildFor: () => SIB,
    onOpenSiblingBuild: () => {},
  });
  assert.equal(withObs, undefined, "still refused by the in-flight guard — this task widens nothing there");
  assert.equal(nextRunnable(plan(), noneMerged, { isOpenPr: () => 3120 }), undefined, "and identically without the observation");
});

test("acceptance 7: the merged credit paths are untouched — a merged task still refuses exactly as today", () => {
  const merged = (id: string) => id === "W1-T2397";
  assert.equal(nextRunnable(plan(), merged, {}), undefined);
  assert.equal(
    nextRunnable(plan(), merged, { openSiblingBuildFor: () => SIB, onOpenSiblingBuild: () => {} }),
    undefined,
    "and the observation cannot resurrect a merged task",
  );
});

test("acceptance 8: nothing added paces or throttles or sleeps a call", () => {
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = ((...a: unknown[]) => { timers++; return (realTimeout as unknown as (...x: unknown[]) => unknown)(...a); }) as typeof setTimeout;
  globalThis.setInterval = ((...a: unknown[]) => { timers++; return (realInterval as unknown as (...x: unknown[]) => unknown)(...a); }) as typeof setInterval;
  try {
    openSiblingBuild("W1-T2397", TASK_FILES, [OPEN_SIBLING], changedFiles);
    nextRunnable(plan(), noneMerged, { openSiblingBuildFor: () => SIB, onOpenSiblingBuild: () => {} });
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  assert.equal(timers, 0);
});
