import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_RUNNER_SLOTS, REPLAY_PREFIX, RehearsalRefusal, SOURCE_RULESET_ID, assertRulesetTargetsOnlyScratch, buildRehearsalRuleset,
  classifyRemoval, createGhSeam, main, parseGroupSelection, pickSample, renderReport, runRehearsal, scratchBranchName,
  sizeSample, tearDown, verdictOf,
  // @ts-ignore the executable harness module has no declaration file.
} from "#scripts/merge-queue-canary.mjs";
import { DEFAULT_SWEEP_POLICY, MERGE_QUEUE_REPLAY_HEAD_PREFIX, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-10-22T04:00:00Z");
const SCRATCH = "mq-canary/2026-10-22";
const SOURCE = {
  id: SOURCE_RULESET_ID,
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "merge_queue", parameters: { merge_method: "SQUASH", max_entries_to_build: 4, grouping_strategy: "ALLGREEN", check_response_timeout_minutes: 60 } },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "coverage-ratchet" }, { context: "test-slow" }] } },
  ],
};
const CANDIDATES = [
  { number: 10353, headSha: "b".repeat(40), files: ["src/lib/read-model-worker.ts"], ciMinutes: 16 },
  { number: 10351, headSha: "c".repeat(40), files: ["docs/a.md"], ciMinutes: 14 },
  { number: 10349, headSha: "a".repeat(40), files: ["src/lib/read-model-worker.ts", "test/x.test.ts"], ciMinutes: 18 },
];

type Group = { merged?: boolean; removal?: { reason: string; at: string }; log?: string[]; throws?: string };

/** An in-memory GitHub: it holds rulesets, branches and PRs, and records every call the harness makes. */
function fakeSeam(opts: { groups?: Record<number, Group>; checks?: (pr: number) => string; source?: unknown;
  openBase?: string; enqueueThrows?: number; failDelete?: string; budget?: { busyJobs: number; jobMinutesPerRun?: number };
  onChecks?: () => void; candidates?: typeof CANDIDATES } = {}) {
  let clock = NOW;
  const calls: string[] = [];
  const rulesets = new Map<number, unknown>([[SOURCE_RULESET_ID, opts.source ?? SOURCE]]);
  const branches = new Map<string, string>([["main", "f".repeat(40)]]);
  const prs = new Map<number, { head: string; base: string; open: boolean; replayOf: number }>();
  let nextPr = 20000;
  const groupOf = (pr: number) => opts.groups?.[prs.get(pr)!.replayOf] ?? { merged: true };
  const seam = {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    readIdentity: async () => ({ login: "remudero-fleet[bot]", kind: "app" }),
    readRuleset: async (id: number) => { calls.push(`readRuleset ${id}`); return rulesets.get(id); },
    readBranchHead: async (b: string) => branches.get(b)!,
    listGreenMergedPrs: async () => opts.candidates ?? CANDIDATES,
    readRunnerBudget: async () => opts.budget ?? { busyJobs: 0, jobMinutesPerRun: 80 },
    createBranch: async (name: string, sha: string) => { calls.push(`createBranch ${name} ${sha.slice(0, 1)}`); branches.set(name, sha); },
    deleteBranch: async (name: string) => {
      calls.push(`deleteBranch ${name}`);
      if (name === opts.failDelete) throw new Error("ref is protected");
      branches.delete(name);
    },
    createRuleset: async (payload: { conditions: { ref_name: { include: string[] } } }) => {
      calls.push(`createRuleset ${JSON.stringify(payload.conditions.ref_name.include)}`);
      rulesets.set(99, payload);
      return { id: 99 };
    },
    deleteRuleset: async (id: number) => { calls.push(`deleteRuleset ${id}`); rulesets.delete(id); },
    openPr: async (pr: { head: string; base: string }) => {
      const number = nextPr++;
      calls.push(`openPr ${pr.head} -> ${pr.base}`);
      prs.set(number, { head: pr.head, base: opts.openBase ?? pr.base, open: true, replayOf: Number(pr.head.split("/")[1]) });
      return { number, nodeId: `PR_${number}`, base: opts.openBase ?? pr.base };
    },
    closePr: async (n: number) => { calls.push(`closePr ${n}`); prs.get(n)!.open = false; },
    readPrChecks: async (n: number) => { opts.onChecks?.(); return opts.checks?.(prs.get(n)!.replayOf) ?? "green"; },
    enqueue: async (nodeId: string) => {
      calls.push(`enqueue ${nodeId}`);
      if (opts.enqueueThrows !== undefined && nodeId === `PR_${opts.enqueueThrows}`) throw new Error("not mergeable");
      return { enqueuedAt: new Date(clock).toISOString() };
    },
    readPrQueueState: async (n: number) => {
      const g = groupOf(n);
      if (g.throws) throw new Error(g.throws);
      clock += 20 * 60_000;
      const at = new Date(clock).toISOString();
      return { groupSha: `${n}`.padEnd(40, "0"), merged: g.merged === true, mergedAt: g.merged ? at : undefined, removal: g.removal };
    },
    readGroupJobs: async (sha: string) => [
      { id: Number(sha.slice(0, 5)), name: "test-slow", conclusion: "success", createdAt: "2026-10-22T04:00:00Z", startedAt: "2026-10-22T04:03:00Z", completedAt: "2026-10-22T04:15:00Z" },
    ],
    readJobLog: async (id: number) => groupOf(id).log ?? [],
  };
  return { seam, calls, rulesets, branches, prs, writes: () => calls.filter((c) => !c.startsWith("readRuleset")) };
}

test("W1-T7736: the rehearsal ruleset targets only the scratch branch and never main", async () => {
  assert.equal(scratchBranchName(NOW), SCRATCH);
  const payload = buildRehearsalRuleset(SOURCE, SCRATCH);
  assert.deepEqual(payload.conditions.ref_name.include, [`refs/heads/${SCRATCH}`]);
  assert.deepEqual(payload.rules.map((r: { type: string }) => r.type), ["merge_queue", "required_status_checks"]);
  assert.deepEqual(payload.rules[0].parameters, SOURCE.rules[0].parameters, "the queue parameters are copied verbatim");
  assert.notEqual(payload.rules[0].parameters, SOURCE.rules[0].parameters, "a copy, so the source is never mutated");
  const named = (include: unknown, target = "branch") => ({ ...payload, target, conditions: { ref_name: { include, exclude: [] } } });
  for (const [include, why] of [
    [["~DEFAULT_BRANCH"], /~DEFAULT_BRANCH/], [["~ALL"], /~ALL/], [["refs/heads/main"], /names main/], [["main"], /names main/],
    [["refs/heads/mq-canary/*"], /wildcard/], [[`refs/heads/${SCRATCH}`, "refs/heads/main"], /exactly the scratch branch/],
    [["refs/heads/mq-canary/2026-10-21"], /not refs\/heads\/mq-canary\/2026-10-22/], [undefined, /exactly the scratch branch/],
  ] as const) {
    assert.throws(() => assertRulesetTargetsOnlyScratch(named(include), SCRATCH), (e: Error) => e instanceof RehearsalRefusal && why.test(e.message));
  }
  assert.throws(() => assertRulesetTargetsOnlyScratch(named([`refs/heads/${SCRATCH}`], "tag"), SCRATCH), /not a branch/);
  assert.throws(() => assertRulesetTargetsOnlyScratch(named(["refs/heads/main"]), "main"), /not a mq-canary/);
  assert.throws(() => buildRehearsalRuleset({ id: 1, rules: [] }, SCRATCH), /no merge_queue rule/);
  const noChecks = buildRehearsalRuleset({ id: 1, rules: [SOURCE.rules[0]] }, SCRATCH);
  assert.equal(noChecks.rules.length, 1);

  // A source with no queue rule is refused BEFORE any write: nothing is created.
  const refused = fakeSeam({ source: { id: SOURCE_RULESET_ID, rules: [] } });
  await assert.rejects(runRehearsal(refused.seam, { live: true }), RehearsalRefusal);
  assert.deepEqual(refused.writes(), []);

  // A live run writes only the scratch-scoped ruleset and never writes ruleset 24525891.
  const live = fakeSeam();
  await runRehearsal(live.seam, { live: true });
  assert.ok(live.calls.includes(`createRuleset ["refs/heads/${SCRATCH}"]`));
  assert.deepEqual(live.writes().filter((c) => c.includes(String(SOURCE_RULESET_ID))), []);
  assert.deepEqual(live.rulesets.get(SOURCE_RULESET_ID), SOURCE, "the source ruleset is untouched");
});

test("W1-T7736: a replayed head is opened against the scratch branch and enqueued", async () => {
  const f = fakeSeam();
  const result = await runRehearsal(f.seam, { live: true });
  assert.deepEqual(result.sample, [10353, 10349, 10351], "the conflicting pair leads the sample");
  assert.deepEqual(result.conflictPair, { prs: [10353, 10349], files: ["src/lib/read-model-worker.ts"] });
  assert.ok(f.calls.includes(`createBranch ${SCRATCH} f`), "the scratch branch starts at main's head");
  for (const c of result.sample) {
    const head = `${REPLAY_PREFIX}${c}`;
    const sha = CANDIDATES.find((x) => x.number === c)!.headSha.slice(0, 1);
    assert.ok(f.calls.includes(`createBranch ${head} ${sha}`), `${head} is the replayed head`);
    assert.ok(f.calls.includes(`openPr ${head} -> ${SCRATCH}`));
  }
  assert.equal(f.calls.filter((c) => c.startsWith("openPr") && !c.endsWith(SCRATCH)).length, 0, "never against main");
  assert.deepEqual(f.calls.filter((c) => c.startsWith("enqueue")), ["enqueue PR_20000", "enqueue PR_20001", "enqueue PR_20002"]);

  // GitHub answering with another base is refused, and everything made so far is torn down.
  const wrong = fakeSeam({ openBase: "main" });
  const refused = await runRehearsal(wrong.seam, { live: true });
  assert.match(refused.failure, /opened against main/);
  assert.equal(wrong.calls.filter((c) => c.startsWith("enqueue")).length, 0);
  assert.equal(wrong.rulesets.has(99), false);

  // A red replay PR and a refused enqueue are each recorded, never retried.
  const red = fakeSeam({ checks: (n) => (n === 10351 ? "red" : "green"), enqueueThrows: 20001 });
  const r = await runRehearsal(red.seam, { live: true });
  assert.deepEqual(r.groups.map((g: { replayOf: number; outcome: string }) => [g.replayOf, g.outcome]),
    [[10353, "pass"], [10349, "ejected"], [10351, "ejected"]]);
  assert.match(r.groups[1].ejectionReason, /enqueuePullRequest refused: not mergeable/);
  assert.match(r.groups[2].ejectionReason, /required checks were red/);

  // Checks that never finish time out at the harness deadline.
  const stuck = await runRehearsal(fakeSeam({ checks: () => "pending" }).seam, { live: true, windowMinutes: 1 });
  assert.ok(stuck.groups.every((g: { outcome: string }) => g.outcome === "timeout"));
});

test("W1-T7736: the report records completion time, outcome and suite selection per group", async () => {
  const f = fakeSeam({ groups: {
    10353: { merged: true, log: ["noise", "W1-T5940: merge group selection -> 12 suite(s) over 1 member(s)"] },
    10349: { removal: { reason: "MERGE_CONFLICT", at: "2026-10-22T05:00:00Z" }, log: ["W1-T5940: merge group selection -> FULL: too few suites to shard"] },
    10351: { merged: true },
  } });
  const result = await runRehearsal(f.seam, { live: true });
  const [pass, conflict, unlogged] = result.groups;
  assert.equal(pass.outcome, "pass");
  assert.equal(pass.durationMin, 20);
  assert.deepEqual(pass.selection, { mode: "affected", suites: 12, why: "12 suite(s) over 1 member(s)" });
  assert.deepEqual(pass.jobs, [{ name: "test-slow", conclusion: "success", queueWaitMin: 3, runMin: 12 }]);
  assert.equal(conflict.outcome, "ejected");
  assert.equal(conflict.ejectionReason, "MERGE_CONFLICT");
  assert.deepEqual(conflict.selection, { mode: "full", suites: 0, why: "too few suites to shard" });
  assert.equal(unlogged.selection.mode, "unknown");
  const report = renderReport(result, ["- a note"]);
  assert.match(report, /\| #20000 \| #10353 \| 200000000000 \| 20 \| pass \| — \| affected \(12 suites\): 12 suite\(s\) over 1 member\(s\) \| test-slow 3\/12 \|/);
  assert.match(report, /\| ejected \| MERGE_CONFLICT \| full: too few suites to shard \|/);
  assert.match(report, /conflicting pair: #10353 x #10349 \(src\/lib\/read-model-worker\.ts\)/);
  assert.match(report, /## Baseline: 2026-10-05/);
  assert.match(report, /## Notes\n\n- a note/);
  assert.match(report, /^merge-queue canary verdict: go — 3 group\(s\) finished, the slowest in 60 min; teardown complete$/m);

  assert.equal(classifyRemoval("TIMED_OUT"), "timeout");
  assert.equal(classifyRemoval("FAILED_CHECKS"), "fail");
  assert.equal(classifyRemoval("MANUAL"), "ejected");
  const job = { name: "x", conclusion: null, createdAt: undefined, startedAt: undefined, completedAt: undefined };
  const timedOut = { ...result, groups: [{ ...pass, outcome: "timeout", ejectionReason: undefined, groupSha: undefined, jobs: [job], selection: undefined }] };
  assert.match(renderReport(timedOut), /\| #20000 \| #10353 \| — \| 20 \| timeout \| — \| — \| x —\/— \|/);
  assert.equal(verdictOf(timedOut).reason, "#20000 timeout (no reason)");

  // The dry run makes only reads, and says no group has run.
  const dry = fakeSeam();
  const plan = await runRehearsal(dry.seam);
  assert.deepEqual(dry.writes(), []);
  const dryReport = renderReport({ ...plan, identity: undefined });
  assert.match(dryReport, /No merge group ran\./);
  assert.match(dryReport, /ran as `unknown` \(unknown\)/);
  assert.match(dryReport, /Nothing was created/);
  assert.match(dryReport, /^merge-queue canary verdict: no-go — dry run only/m);
  assert.match(renderReport({ ...plan, sample: [], conflictPair: null, requiredChecks: undefined, identity: { login: "x", kind: "y", note: "z" } }),
    /- ran as `x` \(y\)\n- z\n[\s\S]*required checks: none\n[\s\S]*sample: none\n- conflicting pair: none in the sample/);

  // The sample is sized from the runner budget and a CI run's measured job-minutes, never a fixed count.
  assert.deepEqual(sizeSample({ candidates: 9, budget: { freeJobSlots: 10, jobMinutesPerRun: 150 }, maxEntriesToBuild: 4, windowMinutes: 120 }),
    { size: 8, concurrent: 4, slotMinutes: 1200, groupCost: 150 });
  assert.deepEqual(sizeSample({ candidates: 9, budget: { freeJobSlots: 0, jobMinutesPerRun: 150 }, maxEntriesToBuild: 4, windowMinutes: 120 }),
    { size: 0, concurrent: 0, slotMinutes: 0, groupCost: 150 });
  // jobs x wall-clock is no price: with no measured job-minutes the window fits no group.
  assert.deepEqual(sizeSample({ candidates: 9, groupCiMinutes: 30, budget: { freeJobSlots: 10, jobsPerRun: 5 }, maxEntriesToBuild: 4, windowMinutes: 120 }),
    { size: 0, concurrent: 0, slotMinutes: 1200, groupCost: undefined });
  assert.equal(DEFAULT_RUNNER_SLOTS, 114, "the default is the 2026-10-27 observed concurrency floor, not Free's 20");
  assert.equal(pickSample(CANDIDATES, 1).conflictPair, null);
  const full = fakeSeam({ budget: { busyJobs: DEFAULT_RUNNER_SLOTS, jobMinutesPerRun: 80 } });
  const noRoom = await runRehearsal(full.seam, { live: true });
  assert.match(verdictOf(noRoom).reason, /leaves room for no group/);
  assert.deepEqual(full.writes(), []);
  assert.equal(verdictOf({ live: true, teardown: [], groups: [] }).reason, "no group ran");
  const none = await runRehearsal(fakeSeam({ candidates: [], budget: { busyJobs: 0 } }).seam);
  assert.equal(none.groupCiMinutes, undefined, "no green PR means no observed duration, and no sample");
  assert.equal(none.sizing.size, 0);
  assert.match(renderReport(none), /\/ — job-min per group = 0 group\(s\)/);
});

test("W1-T7736: the rehearsal tears down even when a group fails", async () => {
  const assertTornDown = (f: ReturnType<typeof fakeSeam>) => {
    assert.equal(f.rulesets.has(99), false, "the rehearsal ruleset is gone");
    assert.deepEqual([...f.branches.keys()], ["main"], "the scratch and replay branches are gone");
    assert.ok([...f.prs.values()].every((p) => !p.open), "every replay PR is closed");
  };
  // A group whose read throws mid-rehearsal.
  const threw = fakeSeam({ groups: { 10349: { throws: "GraphQL 502" } } });
  const r = await runRehearsal(threw.seam, { live: true });
  assert.equal(r.failure, "GraphQL 502");
  assertTornDown(threw);
  assert.equal(r.teardown.length, 1 + 3 + 4);
  assert.ok(r.teardown.every((s: { ok: boolean }) => s.ok));
  assert.match(verdictOf(r).reason, /the rehearsal failed: GraphQL 502/);

  // A group the queue ejects for red checks.
  const failed = fakeSeam({ groups: { 10351: { removal: { reason: "FAILED_CHECKS", at: "2026-10-22T05:00:00Z" } } } });
  const fr = await runRehearsal(failed.seam, { live: true });
  assertTornDown(failed);
  assert.match(renderReport(fr), /^merge-queue canary verdict: no-go — #20002 fail \(FAILED_CHECKS\)$/m);

  // A group that never leaves the queue is a timeout at the harness deadline, and is still torn down.
  const stalled = fakeSeam({ groups: { 10351: { merged: false } } });
  const st = await runRehearsal(stalled.seam, { live: true, windowMinutes: 30 });
  assert.deepEqual(st.groups.map((g: { outcome: string }) => g.outcome), ["pass", "pass", "timeout"]);
  assert.equal(st.groups[2].ejectionReason, "harness deadline passed");
  assertTornDown(stalled);

  // An interrupt (SIGINT) mid-rehearsal, through the CLI.
  const handlers = new Map<string, () => void>();
  const interrupted = fakeSeam({ onChecks: () => handlers.get("SIGINT")?.(), checks: () => "pending" });
  const logged: string[] = [];
  const code = await main(["--live"], { seam: interrupted.seam, log: (l: string) => logged.push(l),
    onSignal: (s: string, h: () => void) => handlers.set(s, h) });
  assert.equal(code, 1);
  assert.deepEqual([...handlers.keys()], ["SIGINT", "SIGTERM"]);
  assert.match(logged[0], /no-go — the rehearsal failed: merge-queue canary interrupted/);
  assertTornDown(interrupted);

  // A failed teardown step is recorded and never skips the next one.
  const sticky = fakeSeam({ failDelete: SCRATCH });
  const sr = await runRehearsal(sticky.seam, { live: true });
  assert.deepEqual(sr.teardown.filter((s: { ok: boolean }) => !s.ok), [{ step: `delete branch ${SCRATCH}`, ok: false, error: "ref is protected" }]);
  assert.equal(sticky.rulesets.has(99), false);
  assert.match(renderReport(sr), /FAILED: delete branch mq-canary\/2026-10-22 — ref is protected/);
  assert.match(verdictOf(sr).reason, /teardown incomplete/);
  assert.deepEqual(await tearDown(sticky.seam, { ruleset: undefined, prs: [], branches: [] }), []);
});

function sweepFixture(scope: TestContext, headRefName: string) {
  const ledgerPath = join(ownedFixtureDir(scope, "mq-canary-sweep").dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 20000, prUrl: "https://github.com/fixture/repo/pull/20000", isDependabot: true, headRefName,
    headSha: "a".repeat(40), reviewState: "none", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false, mergeable: true, mergeState: "clean",
  };
  const unexpected = () => { assert.fail("no lane but the dependency lane may act in this fixture"); };
  const acted: number[] = [];
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "SWEEP-mq-canary", now: () => Date.now(),
    arm: unexpected, close: unexpected, dispatchFix: unexpected, escalate: unexpected,
    depReview: (p) => { acted.push(p.prNumber); return "hold"; },
    log: (step, fields) => { logged.push([step, fields]); },
  };
  return { pass: () => runSweep([pr], deps, DEFAULT_SWEEP_POLICY), acted, logged };
}

test("W1-T7736: the sweep never acts on a replay pull request", async (t) => {
  assert.equal(MERGE_QUEUE_REPLAY_HEAD_PREFIX, REPLAY_PREFIX, "the sweep and the harness name replay heads alike");
  const replay = sweepFixture(t, `${REPLAY_PREFIX}10349`);
  const summary = await replay.pass();
  assert.deepEqual(replay.acted, [], "no lane acts on a replay PR");
  assert.deepEqual(summary.actions, []);
  assert.deepEqual(replay.logged.filter(([s]) => s === "sweep.replay_pr_excluded"),
    [["sweep.replay_pr_excluded", { pr_number: 20000, head_ref: `${REPLAY_PREFIX}10349` }]]);
  // Control: the same PR on an ordinary head IS acted on, so the fixture reaches a lane.
  const ordinary = sweepFixture(t, "run-W1-T1-1");
  await ordinary.pass();
  assert.deepEqual(ordinary.acted, [20000]);
});

test("W1-T7736: the real seam builds its GitHub calls on the paced transport", async () => {
  const reads: string[][] = [];
  const writes: Array<{ args: string[]; input?: string }> = [];
  const answers: Array<[RegExp, unknown]> = [
    [/viewer/, { data: { viewer: { login: "remudero-fleet[bot]" } } }],
    [/search/, { data: { search: { nodes: [
      { number: 1, headRefOid: "s1", files: { nodes: [{ path: "a" }] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { name: "ci", conclusion: "SUCCESS", startedAt: "2026-10-22T00:00:00Z", completedAt: "2026-10-22T00:10:00Z" },
        { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-10-22T00:01:00Z", completedAt: "2026-10-22T00:16:00Z" }, {}] } } } }] } },
      { number: 2, headRefOid: "s2", files: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
    ] } } }],
    [/enqueuePullRequest/, { data: { enqueuePullRequest: { mergeQueueEntry: { enqueuedAt: "t0" } } } }],
    [/pullRequest\(number: 7\)/, { data: { repository: { pullRequest: { merged: false, mergedAt: null, mergeQueueEntry: { headCommit: { oid: "g" } },
      timelineItems: { nodes: [{ reason: "MERGE_CONFLICT", createdAt: "t1" }] } } } } }],
    [/pullRequest\(number: 8\)/, { data: { repository: { pullRequest: { merged: true, mergedAt: "t2", mergeQueueEntry: null, timelineItems: { nodes: [] } } } } }],
    [/rulesets\/24525891/, { id: SOURCE_RULESET_ID }],
    [/git\/ref\/heads\/main/, { object: { sha: "m" } }],
    // Busy capacity is counted in JOBS: two running runs and one queued run hold four busy jobs.
    [/status=in_progress/, { workflow_runs: [{ id: 11 }, { id: 12 }] }], [/status=queued/, { workflow_runs: [{ id: 13 }] }],
    [/runs\/11\/jobs/, { jobs: [{ status: "in_progress" }, { status: "completed" }, { status: "queued" }] }],
    [/runs\/12\/jobs/, { jobs: [{ status: "in_progress" }] }], [/runs\/13\/jobs/, { jobs: [{ status: "queued" }] }],
    // A run's price is its jobs' runner minutes: skipped and never-started jobs hold no runner.
    [/workflows\/ci\.yml\/runs/, { workflow_runs: [{ id: 5 }, { id: 15 }, { id: 25 }] }],
    [/runs\/5\/jobs/, { jobs: [
      { conclusion: "success", started_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T00:30:00Z" },
      { conclusion: "skipped", started_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T00:30:00Z" },
      { conclusion: "cancelled", started_at: null, completed_at: "2026-10-27T00:30:00Z" },
      { conclusion: "success", started_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T00:10:00Z" }] }],
    [/runs\/15\/jobs/, { jobs: [{ conclusion: "failure", started_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T01:00:00Z" }] }],
    [/runs\/25\/jobs/, { jobs: [{ conclusion: "success", started_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T00:10:00Z" }] }],
    // Priced 40, 60 and 10: the median would say 40; the costliest, 60, is the price.
    [/pulls\/7$/, { head: { sha: "h7" } }], [/pulls\/8$/, { head: { sha: "h8" } }], [/pulls\/9$/, { head: { sha: "h9" } }],
    [/commits\/h7\/check-runs/, { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }],
    [/commits\/h8\/check-runs/, { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }],
    [/commits\/h9\/check-runs/, { check_runs: [] }],
    [/event=merge_group/, { workflow_runs: [{ id: 6 }] }],
    [/runs\/6\/jobs/, { jobs: [{ id: 3, name: "test-slow", conclusion: "success", created_at: "a", started_at: "b", completed_at: "c" }] }],
  ];
  let waits = 0;
  const seam = createGhSeam({ owner: "o", repo: "r",
    pacer: { waitAsync: async () => { waits++; }, wait: () => {}, recordResult: () => {} },
    readExec: (_file: string, args: string[]) => {
      reads.push(args);
      const hit = answers.find(([re]) => args.some((a) => re.test(a)));
      assert.ok(hit, `unanswered read ${args.join(" ")}`);
      return `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 4999\n\n${JSON.stringify(hit[1])}`;
    },
    exec: (args: string[], o: { input?: string }) => {
      writes.push({ args, input: o.input });
      if (args.some((a) => /logs$/.test(a))) return "x\nW1-T5940: merge group selection -> FULL: no merge group base\n";
      if (args.includes("POST") && args.some((a) => a.endsWith("/pulls"))) return JSON.stringify({ number: 7, node_id: "N7", base: { ref: SCRATCH } });
      return args.includes("DELETE") ? "" : "{\"id\": 42}";
    } });
  assert.deepEqual(await seam.readIdentity(), { login: "remudero-fleet[bot]", kind: "GitHub App installation token (the fleet's service identity)" });
  assert.deepEqual(await seam.readRuleset(SOURCE_RULESET_ID), { id: SOURCE_RULESET_ID });
  assert.equal(await seam.readBranchHead("main"), "m");
  assert.deepEqual(await seam.listGreenMergedPrs(), [{ number: 1, headSha: "s1", files: ["a"], green: true, ciMinutes: 16 }]);
  assert.deepEqual(await seam.readRunnerBudget(), { busyJobs: 4, jobMinutesPerRun: 60 });
  assert.deepEqual(await seam.createRuleset({ name: "n" }), { id: 42 });
  assert.deepEqual(await seam.deleteRuleset(42), {});
  await seam.createBranch("mq-canary/x", "s");
  await seam.deleteBranch("mq-canary/x");
  assert.deepEqual(await seam.openPr({ head: "h", base: SCRATCH }), { number: 7, nodeId: "N7", base: SCRATCH });
  await seam.closePr(7);
  assert.equal(await seam.readPrChecks(7, ["ci"]), "red");
  assert.equal(await seam.readPrChecks(8, ["ci"]), "green");
  assert.equal(await seam.readPrChecks(9, ["ci"]), "pending");
  assert.deepEqual(await seam.enqueue("N7"), { enqueuedAt: "t0" });
  assert.deepEqual(await seam.readPrQueueState(7), { merged: false, mergedAt: null, groupSha: "g", removal: { reason: "MERGE_CONFLICT", at: "t1" } });
  assert.deepEqual(await seam.readPrQueueState(8), { merged: true, mergedAt: "t2", groupSha: undefined, removal: undefined });
  assert.deepEqual(await seam.readGroupJobs("g"), [{ id: 3, name: "test-slow", conclusion: "success", createdAt: "a", startedAt: "b", completedAt: "c" }]);
  assert.deepEqual(parseGroupSelection(await seam.readJobLog(3)), { mode: "full", suites: 0, why: "no merge group base" });
  assert.deepEqual(writes.map((w) => w.args.slice(0, 4).join(" ")), [
    "api -X POST repos/o/r/rulesets", "api -X DELETE repos/o/r/rulesets/42", "api -X POST repos/o/r/git/refs",
    "api -X DELETE repos/o/r/git/refs/heads/mq-canary/x", "api -X POST repos/o/r/pulls", "api -X PATCH repos/o/r/pulls/7",
    "api repos/o/r/actions/jobs/3/logs"]);
  assert.equal(writes[0].input, "{\"name\":\"n\"}", "the payload goes on stdin");
  assert.ok(writes[0].args.includes("--input"));
  assert.equal(writes[1].input, "");
  assert.ok(reads.some((a) => a.includes("id=N7")), "the enqueue mutation carries the node id as a variable");
  assert.ok(!writes.some((w) => w.args.some((a) => a.includes(String(SOURCE_RULESET_ID)))), "no write ever names the source ruleset");
  assert.equal(waits, reads.length + writes.length, "every call waits on the pacer first");
  const quiet = createGhSeam({ pacer: { waitAsync: async () => {}, wait: () => {}, recordResult: () => {} },
    readExec: () => JSON.stringify({ total_count: 0, workflow_runs: [] }), exec: () => "" });
  assert.deepEqual(await quiet.readRunnerBudget(), { busyJobs: 0, jobMinutesPerRun: undefined }, "no CI run read leaves no price, so no group");
  await seam.sleep(1);
  assert.equal(typeof seam.now(), "number");
});

test("W1-T7736: the harness CLI writes the report and really runs as a script", async () => {
  const written: Array<[string, string]> = [];
  const logged: string[] = [];
  const f = fakeSeam();
  const code = await main(["--report", "out.md", "--runner-slots", "10", "--note", "first", "--note", "second"], { seam: f.seam,
    write: (p: string, s: string) => written.push([p, s]), log: (l: string) => logged.push(l), onSignal: () => {} });
  assert.equal(code, 1, "a dry run is never a go");
  assert.equal(written[0][0], "out.md");
  assert.match(written[0][1], /runner budget: 10 slots, 0 jobs busy \(running or queued\), 80 job-min per CI run/);
  assert.match(written[0][1], /sizing: 1200 free slot-min in the window \/ 80 job-min per group = 3 group\(s\), up to 3 building at once/);
  assert.match(written[0][1], /## Notes\n\n- first\n- second\n/);
  assert.deepEqual(f.writes(), []);
  assert.equal(logged[0], "merge-queue canary verdict: no-go — dry run only — no merge group has run on GitHub yet");
  const go = await main(["--live"], { seam: fakeSeam().seam, log: () => {}, onSignal: () => {} });
  assert.equal(go, 0);
  assert.equal(await main(["--help"], { seam: f.seam, log: () => {} }), 0);
  const help = execFileSync(process.execPath, ["--import", "tsx", "scripts/merge-queue-canary.mjs", "--help"],
    { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(help, /rehearse the merge queue on a scratch branch/);
});
