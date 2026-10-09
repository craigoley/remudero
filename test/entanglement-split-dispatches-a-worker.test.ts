/**
 * test/entanglement-split-dispatches-a-worker.test.ts — W1-T2436.
 *
 * THE DEFECT. W1-T1095 named three inabilities the blocked_review fix rung could not resolve
 * from inside a diff; two shipped (capability 1 — RECORD-AND-RESUME, `outOfDiffBlockerFor`/
 * `prerequisiteMerged`; capability 3 — REBASE, `runFixRebase`) and one never did: capability 2,
 * THE PRODUCER — the thing that actually OPENS the prerequisite PR the other two consume. Without
 * it, an instrument-entangled PR (Standing rule 25) escalated straight to a needs-human issue
 * every time, even though the fix ("split the instrument change into its own PR") is nameable
 * mechanically from the review's own `instrumentEntanglementPaths` — a human did exactly this
 * twice on record (#3082, #3186), each time AUTHORING new code the original PR never carried
 * (this task's own rationale (3)), which is why the fix is a WORKER DISPATCH and never a
 * mechanical `git mv`/partition (a partition's own PR fails its own CI, per the two repairs on
 * record).
 *
 * GATEWAY-FREE, same discipline as test/fix-rung-no-task.test.ts's own W1-T1095 suite: every
 * `runFixRung` drive below is fed hand-rolled fakes for `spawn`/`waitForCiGreen`/
 * `readPrerequisiteState`/`readMergeFacts`/`updateBranch`/`issues`/`ledgerLines` — never a real
 * subprocess, `gh` call, or network request.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildPrerequisitePrDispatchArgs,
  priorPrerequisitePrFor,
  renderPrerequisitePrPrompt,
  runFixRung,
  type FixRungOutcome,
} from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── fixtures — mirror test/fix-rung-no-task.test.ts's own W1-T1095 helpers exactly ──────────────

function entangledReview(
  instrumentPaths: string[],
  srcPaths: string[],
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [] as CriterionVerdict[],
    testTheater: false,
    summary: `entangled: instrument path(s) ${instrumentPaths.join(", ")} changed alongside src/ path(s) ${srcPaths.join(", ")}`,
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    instrumentEntangled: true,
    instrumentEntanglementPaths: { instrumentPaths, srcPaths },
    headSha: "deadbeef",
    reviewerOutcome: "success",
  };
}

function workerResultWithReport(text: string): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

const TEST_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function testOpts() {
  return {
    taskId: "W1-T2436FIX",
    runId: "W1-T2436FIX-1730000000000",
    task: { id: "W1-T2436FIX", title: "Some task whose PR ended up instrument-entangled" },
    prUrl: "https://github.com/acme/remudero/pull/4242",
    branch: "run-W1-T2436FIX-1730000000000",
    worktreePath: "/tmp/rmd-w1-t2436-wt",
    initialSessionId: "session-0",
    mount: TEST_MOUNT,
    settingsFile: "/tmp/rmd-w1-t2436-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 3,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-w1-t2436-wt", reviewerMount: TEST_MOUNT },
  };
}

function testLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1-t2436-ledger-")), "ledger.ndjson");
}

function testIssues(calls: Array<{ title: string; body: string; labels: string[] }> = []): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/8888";
    },
  };
}

function testLog(): { lines: Array<{ step: string } & Record<string, unknown>>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const lines: Array<{ step: string } & Record<string, unknown>> = [];
  return { lines, log: (step, extra) => lines.push({ step, ...(extra ?? {}) }) };
}

const NEVER_SPAWN = async (): Promise<WorkerResult> => {
  throw new Error("must never be called — a known prerequisite is never re-dispatched");
};
const NEVER_WAIT_FOR_CI = async (): Promise<"green" | "red" | "timeout"> => {
  throw new Error("must never be called — no prerequisite PR was opened");
};
const NEVER_UPDATE_BRANCH = () => {
  throw new Error("must never be called — the prerequisite is not merged");
};
const NEVER_RUN_REVIEW = async (): Promise<never> => {
  throw new Error("must never be called — this arm returns before a re-review");
};

function baseDeps(overrides: Partial<Parameters<typeof runFixRung>[0]["deps"]> = {}) {
  const { log } = testLog();
  return {
    spawn: NEVER_SPAWN,
    waitForCiGreen: NEVER_WAIT_FOR_CI,
    runReview: NEVER_RUN_REVIEW,
    push: () => {},
    issues: testIssues(),
    ledgerPath: testLedgerPath(),
    log,
    say: () => {},
    account: (r: WorkerResult) => r,
    ledgerLines: () => [],
    ...overrides,
  };
}

// ── the two pure builders ────────────────────────────────────────────────────────────────────

test("priorPrerequisitePrFor: last-one-wins fold over fix.prerequisite_opened, keyed by pr_url", () => {
  const url = "https://github.com/acme/remudero/pull/4242";
  assert.equal(priorPrerequisitePrFor([], url), undefined, "no rows at all");
  assert.equal(
    priorPrerequisitePrFor([{ step: "fix.prerequisite_opened", pr_url: "https://github.com/acme/remudero/pull/9", prerequisite_pr: 10 }], url),
    undefined,
    "a row for a DIFFERENT pr_url never leaks across PRs",
  );
  assert.equal(
    priorPrerequisitePrFor(
      [
        { step: "fix.prerequisite_opened", pr_url: url, prerequisite_pr: 100 },
        { step: "fix.instrument_entangled", pr_url: url },
        { step: "fix.prerequisite_opened", pr_url: url, prerequisite_pr: 200 },
      ],
      url,
    ),
    200,
    "the LATEST prerequisite_opened row wins",
  );
});

test("renderPrerequisitePrPrompt: hands the worker both the instrument half AND the source half", () => {
  const prompt = renderPrerequisitePrPrompt({
    task: { id: "W1-T2436FIX", title: "some task" },
    branch: "run-W1-T2436FIX-1",
    prUrl: "https://github.com/acme/remudero/pull/4242",
    instrumentPaths: [".github/workflows/ci-gate.yml", "scripts/coverage-ratchet.mjs"],
    srcPaths: ["src/run-task.ts", "src/lib/foo.ts"],
  });
  for (const p of [".github/workflows/ci-gate.yml", "scripts/coverage-ratchet.mjs"]) {
    assert.ok(prompt.includes(p), `prompt must name instrument path ${p}`);
  }
  for (const p of ["src/run-task.ts", "src/lib/foo.ts"]) {
    assert.ok(prompt.includes(p), `prompt must name src path ${p}`);
  }
  assert.match(prompt, /PR_URL: <the new pull request's url>/, "the standard worker report contract");
  assert.match(prompt, /leave the original branch\/pr entirely alone/i, "must not touch the entangled PR itself");
});

test("buildPrerequisitePrDispatchArgs: runs in the same worktree/mount/budget, a FRESH session, restricted tools", () => {
  const args = buildPrerequisitePrDispatchArgs({
    task: { id: "W1-T2436FIX", title: "some task" },
    branch: "run-W1-T2436FIX-1",
    prUrl: "https://github.com/acme/remudero/pull/4242",
    worktreePath: "/tmp/rmd-w1-t2436-wt",
    mount: TEST_MOUNT,
    settingsFile: "/tmp/settings.json",
    config: {} as Config,
    budgetUsd: 10,
    runId: "run-1",
    taskId: "W1-T2436FIX",
    instrumentPaths: ["scripts/coverage-ratchet.mjs"],
    srcPaths: ["src/run-task.ts"],
  });
  assert.equal(args.cwd, "/tmp/rmd-w1-t2436-wt");
  assert.equal(args.resumeSessionId, undefined, "nothing to resume — a fresh session");
  assert.equal(args.model, TEST_MOUNT.model);
  assert.equal(args.maxBudgetUsd, 10);
  assert.ok(Array.isArray(args.tools) && args.tools.length > 0, "the restricted fix-worker tool set, not the SDK default");
  assert.ok(args.prompt.includes("scripts/coverage-ratchet.mjs"));
});

// ── acceptance (1)/(2): an entangled refusal DISPATCHES A WORKER, handed both halves ────────────

test("an entangled review dispatches a worker (never straight to an issue), handed the instrument half and the source half", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const { lines, log } = testLog();
  let spawnedPrompt: string | undefined;
  const deps = baseDeps({
    issues: testIssues(issueCalls),
    log,
    spawn: async (a) => {
      spawnedPrompt = a.prompt;
      return workerResultWithReport("opened it.\nPR_URL: https://github.com/acme/remudero/pull/9001");
    },
    waitForCiGreen: async () => "green",
    readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }) as never,
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome = await runFixRung({ ...testOpts(), initialSessionId: "s", initialReview: review, deps } as never);

  assert.equal(issueCalls.length, 0, "no issue was ever opened — the worker succeeded");
  assert.equal(outcome.outcome, "parked");
  assert.equal(outcome.strikes, 0, "dispatching the prerequisite never spends a strike");
  assert.ok(spawnedPrompt?.includes("scripts/coverage-ratchet.mjs"), "the worker was handed the instrument half");
  assert.ok(spawnedPrompt?.includes("src/run-task.ts"), "the worker was handed the source half");
  assert.ok(lines.some((l) => l.step === "fix.prerequisite_opened" && l.prerequisite_pr === 9001));
});

// ── acceptance (5): the "blocked on #N" string lands exactly where the parked arm already reads it ──

test("once the prerequisite is green but not yet merged, this rung PARKS with 'blocked on #N' — the same field/format capability 1's own park already uses", async () => {
  const { lines, log } = testLog();
  const deps = baseDeps({
    log,
    spawn: async () => workerResultWithReport("PR_URL: https://github.com/acme/remudero/pull/5555"),
    waitForCiGreen: async () => "green",
    readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }) as never,
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome: FixRungOutcome = await runFixRung({ ...testOpts(), initialReview: review, deps } as never);

  assert.equal(outcome.outcome, "parked");
  assert.equal(outcome.blockedOnPr, 5555);
  assert.match(outcome.reason, /blocked on #5555/);
  const parked = lines.find((l) => l.step === "fix.parked");
  assert.ok(parked, "fix.parked was logged — the SAME step capability 1's own park writes");
  assert.equal(parked?.blocked_on_pr, 5555);
});

// ── acceptance (3): a prerequisite that CANNOT GO GREEN escalates exactly as the rung does today ──

test("the dispatched worker opens no pull request at all -> escalates exactly as the rung always has", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const { lines, log } = testLog();
  const deps = baseDeps({
    issues: testIssues(issueCalls),
    log,
    spawn: async () => workerResultWithReport("I could not build a standalone prerequisite; no PR opened."),
    // waitForCiGreen stays NEVER_WAIT_FOR_CI — must never be reached with no PR to poll.
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome = await runFixRung({ ...testOpts(), initialReview: review, deps } as never);

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.reason, "instrument_entangled");
  assert.equal(outcome.strikes, 0);
  assert.equal(issueCalls.length, 1, "escalated exactly once, exactly like today's refusal");
  assert.match(issueCalls[0].body, /W1-T297/, "the same Standing rule 25 refusal (W1-T297) the rung has always filed");
  assert.match(issueCalls[0].body, /scripts\/coverage-ratchet\.mjs/);
  assert.ok(lines.some((l) => l.step === "fix.exhausted" && l.reason === "instrument_entangled"));
});

test("the prerequisite PR opens but cannot go green -> escalates exactly as the rung does today, never merges or rebases", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const { lines, log } = testLog();
  const deps = baseDeps({
    issues: testIssues(issueCalls),
    log,
    spawn: async () => workerResultWithReport("PR_URL: https://github.com/acme/remudero/pull/6001"),
    waitForCiGreen: async () => "red",
    updateBranch: NEVER_UPDATE_BRANCH as never,
    readPrerequisiteState: async () => {
      throw new Error("must never be read — the CI check already refused before any merge state matters");
    },
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome = await runFixRung({ ...testOpts(), initialReview: review, deps } as never);

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.reason, "instrument_entangled");
  assert.equal(issueCalls.length, 1);
  assert.ok(lines.some((l) => l.step === "fix.prerequisite_ci_failed" && l.prerequisite_pr === 6001));
  assert.ok(!lines.some((l) => l.step === "fix.parked" || l.step === "fix.rebased"), "no park, no rebase on a red prerequisite");
});

// ── acceptance (4): nothing merges, and re-invocation never re-dispatches a second worker ────────

test("a PR that already has a known prerequisite (per the ledger) is never re-dispatched — it just re-checks", async () => {
  const { lines, log } = testLog();
  const opts = testOpts();
  const deps = baseDeps({
    log,
    // spawn stays NEVER_SPAWN — proves no second worker is dispatched for a split already produced.
    ledgerLines: () => [{ step: "fix.prerequisite_opened", pr_url: opts.prUrl, prerequisite_pr: 7001 }],
    readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }) as never,
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome = await runFixRung({ ...opts, initialReview: review, deps } as never);

  assert.equal(outcome.outcome, "parked");
  assert.equal(outcome.blockedOnPr, 7001);
  assert.ok(!lines.some((l) => l.step === "fix.prerequisite_opened"), "no NEW prerequisite_opened row — nothing was (re-)dispatched");
});

test("once the known prerequisite merges, this rung RESUMES via the existing rebase capability — never a direct merge", async () => {
  const { lines, log } = testLog();
  const opts = testOpts();
  let updateBranchCalledWith: number | undefined;
  const deps = baseDeps({
    log,
    ledgerLines: () => [{ step: "fix.prerequisite_opened", pr_url: opts.prUrl, prerequisite_pr: 7002 }],
    readPrerequisiteState: async () => ({ ok: true, state: "MERGED" }) as never,
    readMergeFacts: async () => ({ mergeable: "MERGEABLE", behindBy: 2 }),
    updateBranch: async (n) => {
      updateBranchCalledWith = n;
      return { ok: true };
    },
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome = await runFixRung({ ...opts, initialReview: review, deps } as never);

  assert.equal(outcome.outcome, "rebased");
  assert.equal(outcome.blockedOnPr, 7002);
  // `runFixRebase` updates THIS pull request's own branch (opts.prUrl, #4242) onto its new base —
  // never the prerequisite (#7002) — via the update-branch REST call, never a merge endpoint.
  assert.equal(updateBranchCalledWith, 4242, "the update-branch REST call targets THIS PR, never a merge endpoint");
  assert.ok(lines.some((l) => l.step === "fix.resumed" && l.blocked_on_pr === 7002));
  assert.ok(lines.some((l) => l.step === "fix.rebased"));
});

test("an unreadable/failed prerequisite-state read is NEVER treated as merged — fail-safe, park instead", async () => {
  const opts = testOpts();
  const deps = baseDeps({
    ledgerLines: () => [{ step: "fix.prerequisite_opened", pr_url: opts.prUrl, prerequisite_pr: 7003 }],
    readPrerequisiteState: async () => ({ ok: false }) as never,
    updateBranch: NEVER_UPDATE_BRANCH as never,
  });
  const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
  const outcome = await runFixRung({ ...opts, initialReview: review, deps } as never);
  assert.equal(outcome.outcome, "parked");
  assert.equal(outcome.blockedOnPr, 7003);
});

// ── acceptance (6): the strike cap is unaffected — every arm above spends ZERO strikes ───────────

test("AGGREGATE: none of the entanglement-dispatch arms ever spend a strike", async () => {
  const scenarios: Array<[string, ReturnType<typeof baseDeps>]> = [
    [
      "dispatch succeeds, parks",
      baseDeps({
        spawn: async () => workerResultWithReport("PR_URL: https://github.com/acme/remudero/pull/1"),
        waitForCiGreen: async () => "green",
        readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }) as never,
      }),
    ],
    [
      "dispatch fails outright, escalates",
      baseDeps({ spawn: async () => workerResultWithReport("no PR opened") }),
    ],
  ];
  for (const [label, deps] of scenarios) {
    const review = entangledReview(["scripts/coverage-ratchet.mjs"], ["src/run-task.ts"]);
    const outcome = await runFixRung({ ...testOpts(), initialReview: review, deps } as never);
    assert.equal(outcome.strikes, 0, `${label}: strikes must stay at 0 — the cap is never touched by this capability`);
  }
});
