/**
 * THE (c3) OPEN HEAD-BRANCH CORROBORATION RUNG (W1-T377) — an open PR the ledger never recorded.
 *
 * THE MEASURED INCIDENT this exists for (2026-08-05, task W1-T350): run 1785957031821 had its
 * worktree reaped mid-run at 20:01:40, opened PR #1377 at 20:08:02, and NEVER wrote a `pr.opened`
 * ledger line. `deriveStatus`'s only route to an OPEN association is rung (a), which reads that
 * line; rungs (c)/(c2) are gated on `state === "MERGED"`. So the task read dispatchable, W1-T350
 * re-dispatched at 20:11:02, rebuilt the entire thing as #1378, merged that, and left #1377 a
 * conflicting duplicate — one full high-risk run (budget_usd 85) spent on work that already existed.
 *
 * WHAT THESE TESTS DRIVE, stated rather than implied: `deriveStatus` and `projectPlan` are the real
 * production functions and the (c3) DECISION — the ownership re-assert, the state filter, the
 * newest-wins tiebreak, the precedence ordering against every merged rung, and the null-skip — runs
 * here for real. The GitHub GATEWAY is a fixture (it is an injected `DeriveDeps.github`), but the
 * two REAL gateway implementations are driven too: `buildBatchedGithub` against an injected
 * `fetchAll` (asserting the open slice costs ZERO extra fetches), and `ghGateway` against an
 * injected `exec` (asserting the real `--state open` argv). The END-TO-END consequence — that the
 * duplicate dispatch is now refused — is proven through the REAL `nextRunnable`/`isDispatchEligible`
 * with the same `isOpenPr` closure shape run-task.ts builds.
 * LEFT UNPROVEN, named: nothing in this diff. The production `isOpenPr` closure in run-task.ts is
 * unchanged by this task (it already reads `prState === "OPEN"` off the projection), so no new
 * wiring line was added there to cover.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStatus, projectPlan, buildBatchedGithub, ghGateway, type GitHub, type PrRef, type BatchedPr, type DeriveDeps } from "../src/lib/status.js";
import { nextRunnable, type OpenPrCheck } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";

const TASK_ID = "W1-T350";
const OPEN_PR: PrRef = {
  number: 1377,
  url: "https://github.com/craigoley/remudero/pull/1377",
  state: "OPEN",
  headRefName: `run-${TASK_ID}-1785957031821`,
};

function task(id: string = TASK_ID): Task {
  return {
    id, title: "t", repo: "remudero", type: "implement",
    depends_on: [], status: "queued", verify: "auto", risk: "low", attempts: 0,
  } as unknown as Task;
}

/**
 * A gateway that finds NOTHING merged by any route — the exact state of the world at 20:11:02 on
 * 2026-08-05. `openPrs` is what rung (c3) will or will not be given.
 */
function noMergedGithub(opts: { openPrs?: PrRef[] | null; omitOpenMethod?: boolean; readFailed?: boolean } = {}): GitHub {
  const g: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => (opts.readFailed ? null : []),
    listMergedHeadBranches: () => (opts.readFailed ? null : []),
    headRefName: () => undefined,
    prBody: () => undefined,
    autoMergeArmed: () => false,
    issueByUrl: () => null,
    readFailed: () => opts.readFailed ?? false,
  };
  if (!opts.omitOpenMethod) g.listOpenHeadBranches = () => (opts.openPrs === undefined ? [] : opts.openPrs);
  return g;
}

/** `deriveStatus` deps with NO ledger at all — no `pr.opened` line, the incident's condition. */
function deps(github: GitHub, over: Partial<DeriveDeps> = {}): DeriveDeps {
  return { ledgerPath: "/nonexistent/ledger.ndjson", github, readLedger: () => [], ...over };
}

// ── THE INCIDENT, REPLAYED ────────────────────────────────────────────────────────────────────

test("an OPEN PR on the task's own run-branch is credited even though NO pr.opened line exists", () => {
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [OPEN_PR] })));

  // The premise, asserted inside the test rather than trusted: nothing merged, no ledger line.
  assert.equal(proj.merged, false, "an open PR is never a merge credit");
  assert.equal(proj.prState, "OPEN", "the projection now carries the OPEN state isOpenPr reads");
  assert.equal(proj.prNumber, 1377, "and the PR NUMBER the in-flight guard reports");
  assert.equal(proj.status, "running", "a task with an open PR is in flight, not queued");
  assert.equal(proj.source, "head-branch");
});

test("FALSIFIER: the same world with the rung's input withheld derives the dispatchable shape that caused the duplicate", () => {
  // `listOpenHeadBranches` ABSENT is precisely pre-W1-T377 behaviour. This is the projection that
  // let W1-T350 re-dispatch — asserted here so the fix's effect is measured, not assumed.
  const proj = deriveStatus(task(), deps(noMergedGithub({ omitOpenMethod: true })));
  assert.equal(proj.prState, undefined, "no OPEN association at all");
  assert.equal(proj.prNumber, undefined);
  assert.equal(proj.status, "queued", "which is what `dispatchable` looks like");
  assert.equal(proj.source, "none");
});

test("THE CONSEQUENCE, end to end: the duplicate dispatch is refused by the REAL nextRunnable", () => {
  // Drives the production eligibility chain with the SAME isOpenPr closure shape run-task.ts
  // builds off the projection — the actual mechanism that failed at 20:11:02.
  const plan: Plan = { tasks: [task()], byId: new Map([[TASK_ID, task()]]) } as unknown as Plan;
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [OPEN_PR] })));
  const isOpenPr: OpenPrCheck = (id) => (id === proj.taskId && proj.prState === "OPEN" ? proj.prNumber : undefined);

  const skipped: Array<{ id: string; pr: number }> = [];
  const picked = nextRunnable(plan, () => false, {
    isOpenPr,
    onSkip: (t, pr) => skipped.push({ id: t.id, pr }),
  });

  assert.equal(picked, undefined, "the task is NOT offered for dispatch a second time");
  assert.deepEqual(skipped, [{ id: TASK_ID, pr: 1377 }], "it is skipped AS IN-FLIGHT, naming the real PR");
});

test("FALSIFIER on the consequence: withhold the rung's input and the SAME chain re-dispatches", () => {
  const plan: Plan = { tasks: [task()], byId: new Map([[TASK_ID, task()]]) } as unknown as Plan;
  const proj = deriveStatus(task(), deps(noMergedGithub({ omitOpenMethod: true })));
  const isOpenPr: OpenPrCheck = (id) => (id === proj.taskId && proj.prState === "OPEN" ? proj.prNumber : undefined);

  const picked = nextRunnable(plan, () => false, { isOpenPr });
  assert.equal(picked?.id, TASK_ID, "the pre-fix world hands the task straight back out — the duplicate build");
});

// ── OWNERSHIP IS RE-ASSERTED, NEVER ASSUMED ───────────────────────────────────────────────────

test("a FOREIGN run-branch never credits this task — ownership is re-asserted on every candidate", () => {
  // The batched index groups by a loose `run-(.+)-\d+` capture, so a caller CAN hand this rung
  // another task's PR. `ownsBranch` is the gate that must catch it: a false OPEN credit here would
  // wedge an unrelated task out of dispatch.
  const foreign: PrRef = { ...OPEN_PR, number: 1400, headRefName: "run-W1-T999-1785957031821" };
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [foreign] })));
  assert.equal(proj.prState, undefined, "no credit from a branch claiming another task");
  assert.equal(proj.source, "none");

  // PAIRED POSITIVE CONTROL — without it this test passes on a rung that credits NOTHING, which is
  // exactly what the falsifier run produces. The discrimination is the claim, not the refusal.
  const own = deriveStatus(task(), deps(noMergedGithub({ openPrs: [foreign, OPEN_PR] })));
  assert.equal(own.prNumber, 1377, "the SAME call credits this task's own branch — so the refusal above discriminates");
});

test("a CLOSED PR on this task's own branch does not credit — the state filter is real", () => {
  const closed: PrRef = { ...OPEN_PR, state: "CLOSED" };
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [closed] })));
  assert.equal(proj.prState, undefined, "abandoned work must not look in-flight forever");
  assert.equal(proj.source, "none");

  // PAIRED POSITIVE CONTROL, same reason as the foreign-branch test above.
  const open = deriveStatus(task(), deps(noMergedGithub({ openPrs: [{ ...closed, state: "OPEN" }] })));
  assert.equal(open.prState, "OPEN", "flipping ONLY the state credits — so the filter is what refused");
});

test("a branch with no epoch suffix does not credit — ownsBranch requires the timestamped form", () => {
  const bare: PrRef = { ...OPEN_PR, headRefName: `run-${TASK_ID}` };
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [bare] })));
  assert.equal(proj.prState, undefined);

  const suffixed = deriveStatus(task(), deps(noMergedGithub({ openPrs: [{ ...bare, headRefName: `run-${TASK_ID}-7` }] })));
  assert.equal(suffixed.prState, "OPEN", "adding ONLY the epoch suffix credits — so the form is what refused");
});

test("TWO open branches for one task: the NEWEST wins — that task has already been dispatched twice", () => {
  const older: PrRef = { ...OPEN_PR, number: 1377 };
  const newer: PrRef = { number: 1378, url: "u/1378", state: "OPEN", headRefName: `run-${TASK_ID}-1785960395408` };
  // Deliberately passed oldest-first so the sort, not the input order, decides.
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [older, newer] })));
  assert.equal(proj.prNumber, 1378, "the newest open run-branch is the one still working");
});

// ── PRECEDENCE: (c3) CAN ONLY FILL A HOLE, NEVER DISPLACE A CREDIT ─────────────────────────────
//
// These matter more than the feature. A rung that outranks a MERGED credit would re-open settled
// tasks and strand them; one that outranks `ownResult` would discard the ledger's own association.

test("PRECEDENCE: a MERGED trailer credit still wins over an open branch hit", () => {
  const mergedPr: PrRef = { number: 900, url: "u/900", state: "MERGED", headRefName: `run-${TASK_ID}-111` };
  const g = noMergedGithub({ openPrs: [OPEN_PR] });
  g.findMergedByTrailer = () => mergedPr;
  g.headRefName = () => `run-${TASK_ID}-111`;
  g.prBody = () => `Remudero-Task: ${TASK_ID}\n`;

  const proj = deriveStatus(task(), deps(g));
  assert.equal(proj.merged, true, "merged is terminal — an open sibling never un-merges a task");
  assert.equal(proj.prNumber, 900);
  assert.equal(proj.source, "trailer");
});

test("PRECEDENCE: a MERGED head-branch corroboration (c2) still wins over (c3)", () => {
  const mergedPr: PrRef = { number: 901, url: "u/901", state: "MERGED", headRefName: `run-${TASK_ID}-111` };
  const g = noMergedGithub({ openPrs: [OPEN_PR] });
  g.listMergedHeadBranches = () => [mergedPr];
  g.findMergedByHeadBranch = () => [mergedPr];

  const proj = deriveStatus(task(), deps(g, { mergedHeadBranches: () => [mergedPr] }));
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 901, "(c2) resolved first — (c3) is strictly below it");
});

test("PRECEDENCE: the ledger's OWN pr.opened association (rung a) is not displaced by (c3)", () => {
  const ledgerPr: PrRef = { number: 1300, url: "u/1300", state: "OPEN", headRefName: `run-${TASK_ID}-999` };
  const g = noMergedGithub({ openPrs: [OPEN_PR] });
  g.prByRef = (ref) => (String(ref) === "u/1300" ? ledgerPr : null);

  const proj = deriveStatus(
    task(),
    deps(g, { readLedger: () => [{ step: "pr.opened", task_id: TASK_ID, pr_url: "u/1300" }] }),
  );
  assert.equal(proj.prNumber, 1300, "rung (a) still owns the association when it HAS one");
  assert.equal(proj.source, "ledger", "and (c3) did not overwrite its provenance");
});

// ── FAILURE HANDLING: null SKIPS, it never invents an absence ──────────────────────────────────

test("a FAILED open read (null) skips the rung and lets W1-T119 defer — never a false 'no open PR'", () => {
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: null, readFailed: true })));
  assert.equal(proj.indeterminate, true, "an unreadable GitHub defers rather than concluding anything");
  assert.equal(proj.source, "throttled");
  assert.equal(proj.prState, undefined, "and no OPEN credit was fabricated from a failed read");
});

test("REGRESSION LOCK: a gateway WITHOUT the method behaves exactly as before this task", () => {
  // Every pre-existing GitHub fixture in the suite is this shape. `absent ⇒ skip` must hold, or
  // this change would alter derivation for every caller that predates it.
  const proj = deriveStatus(task(), deps(noMergedGithub({ omitOpenMethod: true })));
  assert.equal(proj.source, "none");
  assert.equal(proj.status, "queued");
  assert.equal(proj.merged, false);
});

test("REGRESSION LOCK: an empty open list is a genuine 'no open PR', not a deferral", () => {
  const proj = deriveStatus(task(), deps(noMergedGithub({ openPrs: [] })));
  assert.equal(proj.source, "none");
  assert.equal(proj.indeterminate, undefined, "[] is an answer; only null defers");
});

// ── projectPlan BATCHES THE OPEN INDEX ────────────────────────────────────────────────────────

test("projectPlan groups the ONE open fetch by task client-side, and credits the right task", () => {
  let openFetches = 0;
  const mine: PrRef = { ...OPEN_PR };
  const theirs: PrRef = { number: 1400, url: "u/1400", state: "OPEN", headRefName: "run-W1-T999-222" };
  const g = noMergedGithub();
  g.listOpenHeadBranches = () => {
    openFetches++;
    return [mine, theirs];
  };

  const plan = { tasks: [task(TASK_ID), task("W1-T999")] } as unknown as Plan;
  const byId = projectPlan(plan, { ledgerPath: "/nonexistent", github: g, readLedger: () => [] } as DeriveDeps);

  assert.equal(openFetches, 1, "ONE fetch for the whole plan, not one per task");
  assert.equal(byId.get(TASK_ID)?.prNumber, 1377, "each task got its OWN branch's PR");
  assert.equal(byId.get("W1-T999")?.prNumber, 1400);
});

// ── THE TWO REAL GATEWAYS ─────────────────────────────────────────────────────────────────────

test("buildBatchedGithub serves the open slice from the SAME fetch — zero extra calls", () => {
  // The cost claim in the interface doc, asserted rather than asserted-in-prose: the batched
  // gateway already fetches `--state all`, so listOpenHeadBranches must add no fetch of its own.
  let fetches = 0;
  const rows: BatchedPr[] = [
    { number: 1377, url: "u/1377", state: "OPEN", headRefName: `run-${TASK_ID}-1785957031821` },
    { number: 900, url: "u/900", state: "MERGED", headRefName: `run-${TASK_ID}-111` },
    { number: 800, url: "u/800", state: "CLOSED", headRefName: `run-${TASK_ID}-000` },
  ];
  const g = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => {
      fetches++;
      return rows;
    },
  });

  const open = g.listOpenHeadBranches?.();
  const merged = g.listMergedHeadBranches?.();
  assert.equal(fetches, 1, "both slices came out of ONE fetch");
  assert.deepEqual(open?.map((p) => p.number), [1377], "only the OPEN row");
  assert.deepEqual(merged?.map((p) => p.number), [900], "and the merged twin is unchanged");
});

test("buildBatchedGithub returns null (never []) for the open slice when the fetch FAILED", () => {
  const g = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => {
      throw new Error("gh exhausted");
    },
  });
  assert.equal(g.listOpenHeadBranches?.(), null, "a failed read must stay distinguishable from zero open PRs");
  assert.equal(g.readFailed?.(), true);
});

test("ghGateway issues the REAL --state open argv and parses the rows", () => {
  const argvs: string[][] = [];
  const g = ghGateway("craigoley", "remudero", {
    exec: (args) => {
      argvs.push(args);
      return JSON.stringify([{ number: 1377, url: "u/1377", state: "OPEN", headRefName: `run-${TASK_ID}-1` }]);
    },
  });

  const open = g.listOpenHeadBranches?.();
  assert.deepEqual(open?.map((p) => p.number), [1377]);
  const argv = argvs.at(-1) ?? [];
  assert.ok(argv.includes("--state") && argv[argv.indexOf("--state") + 1] === "open", `--state open, got ${argv.join(" ")}`);
  assert.ok(argv.includes("headRefName") || argv.some((a) => a.includes("headRefName")), "the head ref is requested");
});
