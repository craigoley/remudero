/**
 * W1-T14136 — a reviewer-unmet fix round runs the posted review's own semantic check on its commit, over every
 * criterion, before it pushes. It gets one more worker turn on what did not clear and records each check.
 *
 * Criteria 1, 2 and 6 call the pure functions. Criteria 3 to 5 drive runFixRung with the production fix host,
 * except that its runFixSelfCheck is a fake that records the call. The worker spawn and the push are fakes too.
 * No reviewer, no model and no network is ever reached.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, type FixCommandHost } from "#src/cli/commands/fix.js";
import type { Config } from "#src/lib/config.js";
import {
  FIX_SELF_CHECK_EXTRA_TURNS, FIX_SELF_CHECK_TIMEOUT_MS, buildFixSelfCheckPrompt, decideFixSelfCheck, metCriteriaForFix,
  runBoundedFixSelfCheck, runFixSelfCheckWith, type FixSelfCheckRunArgs, type FixSelfCheckRunResult,
} from "#src/lib/fix-self-check.js";
import type { Mount } from "#src/lib/mounts.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { deriveFixMode, renderFixPrompt } from "#src/lib/prompt-render.js";
import type { CriterionVerdict, ReviewVerdict } from "#src/lib/review.js";
import { SPECIALIST_TOOLS } from "#src/lib/specialist-panel.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { fixCommandHost } from "#test/helpers/run-task-test.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const REVIEWER: Mount = { model: "opus", effort: "high", maxTurns: 40, contextBudget: 200000, provider: "claude" };

const ACCEPTANCE: AcceptanceCriterion[] = [
  { claim: "the parser accepts a quoted field", proof: "unit test: test/parser.test.ts" },
  { claim: "the parser rejects a torn row", proof: "unit test: test/parser.test.ts" },
  { claim: "the reader keeps its old output", proof: "grep: readRows( in src/reader.ts" },
  { claim: "the writer names its version", proof: "grep: VERSION in src/writer.ts" },
];
const HOLDOUT_CLAIM = "the hidden reviewer-only claim";
const WITH_HOLDOUT: AcceptanceCriterion[] = [...ACCEPTANCE.slice(0, 3), { claim: HOLDOUT_CLAIM, proof: "grep: X in src/x.ts", holdout: true }];

/** The last posted review: only criterion 2 unmet. */
function judged(acceptance: readonly AcceptanceCriterion[]): CriterionVerdict[] {
  return acceptance.map((c, i) => ({ claim: c.claim, proof: c.proof, met: i !== 1, holdout: c.holdout,
    reason: i === 1 ? "the torn row still parses" : "proof passed", proof_exec: "not_executable" as const }));
}

function worker(text: string): WorkerResult {
  return { sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

const verdicts = (...lines: string[]) => lines.join("\n");
const ALL_PASS = verdicts("REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: PASS", "REVIEW_VERDICT 3: PASS", "REVIEW_VERDICT 4: PASS");
const TWO_AND_FOUR_FAIL = verdicts("REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: FAIL (a) the torn row still parses at the new head",
  "REVIEW_VERDICT 3: PASS", "REVIEW_VERDICT 4: FAIL (c) the hidden path broke");

test("W1-T14136 criterion 1: the self-check prompt judges every criterion, not only the unmet ones", () => {
  const prompt = buildFixSelfCheckPrompt({ task: { id: "W1-T9", acceptance: ACCEPTANCE }, prUrl: "https://github.com/acme/r/pull/9",
    owner: "acme", repo: "r", commitSha: "abc123fixcommit",
    priorReasons: judged(ACCEPTANCE).map((c, i) => ({ criterionIndex: i + 1, met: c.met, reason: c.reason })) });
  assert.equal(prompt.match(/^\s+\d+\. CLAIM: /gm)?.length, 4, "one CLAIM line per criterion, met and unmet");
  for (const c of ACCEPTANCE) assert.ok(prompt.includes(`CLAIM: ${c.claim}`), c.claim);
  assert.match(prompt, /for n = 1\.\.4\./, "the verdict contract asks for all four");
  assert.match(prompt, /abc123fixcommit/, "it names the commit it judges");
  assert.match(prompt, /git diff \$\(git merge-base origin\/main HEAD\)\.\.HEAD/, "it reads the local, unpushed diff");
  assert.match(prompt, /Criterion 2 \(unmet\): "the torn row still parses"/, "the earlier ruling is re-checked");
  assert.match(prompt, /Do NOT post the/, "the review prompt still forbids posting a status");
  // A holdout is judged here exactly as the posted review judges it.
  const withHoldout = buildFixSelfCheckPrompt({ task: { id: "W1-T9", acceptance: WITH_HOLDOUT }, prUrl: "https://github.com/acme/r/pull/9",
    owner: "acme", repo: "r", commitSha: "abc123fixcommit" });
  assert.equal(withHoldout.match(/^\s+\d+\. CLAIM: /gm)?.length, 4);
  assert.ok(withHoldout.includes(HOLDOUT_CLAIM));
});

test("W1-T14136 criterion 2: only an observed PASS clears; the worker list holds visible criteria only", () => {
  assert.deepEqual(decideFixSelfCheck(ALL_PASS, ACCEPTANCE),
    { state: "clear", criteriaTotal: 4, clearedCount: 4, unclearedIndices: [], workerItems: [] });
  const failed = decideFixSelfCheck(verdicts("REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: FAIL (a) still parses",
    "REVIEW_VERDICT 3: PASS", "REVIEW_VERDICT 4: PASS"), ACCEPTANCE);
  assert.equal(failed.state, "uncleared");
  assert.deepEqual(failed.unclearedIndices, [2]);
  assert.deepEqual(failed.workerItems, [{ criterionIndex: 2, claim: ACCEPTANCE[1]!.claim, clause: "(a) still parses" }]);
  const unable = decideFixSelfCheck(verdicts("REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: PASS",
    "REVIEW_VERDICT 3: UNABLE the sandbox refused git", "REVIEW_VERDICT 4: PASS"), ACCEPTANCE);
  assert.equal(unable.state, "uncleared");
  assert.deepEqual(unable.unclearedIndices, [3]);
  assert.match(unable.workerItems[0]!.clause, /^UNABLE the sandbox refused git/);
  const missing = decideFixSelfCheck(verdicts("REVIEW_VERDICT 1: PASS", "REVIEW_VERDICT 2: PASS", "REVIEW_VERDICT 3: PASS"), ACCEPTANCE);
  assert.equal(missing.state, "uncleared", "a missing line is never a pass");
  assert.deepEqual(missing.unclearedIndices, [4]);
  assert.equal(missing.clearedCount, 3);
  assert.equal(decideFixSelfCheck("", ACCEPTANCE).unclearedIndices.length, 4, "no output clears nothing");
  const hidden = decideFixSelfCheck(TWO_AND_FOUR_FAIL, WITH_HOLDOUT);
  assert.deepEqual(hidden.unclearedIndices, [2, 4], "the holdout FAIL is counted");
  assert.deepEqual(hidden.workerItems.map((i) => i.criterionIndex), [2], "but never shown to the worker");
  assert.ok(!JSON.stringify(hidden.workerItems).includes("hidden"), "neither its claim nor its clause");
});

interface Rig {
  events: string[];
  checks: FixSelfCheckRunArgs[];
  spawns: SpawnWorkerArgs[];
  pushes: string[];
  rows: Array<{ step: string } & Record<string, unknown>>;
  comments: number;
  repo: GitRepo;
  outcome: Awaited<ReturnType<typeof runFixRung>>;
}

/** One reviewer-unmet strike on a real fixture worktree. Each worker turn edits and commits, as a shell worker does. */
async function strike(opts: {
  transcripts?: string[];
  throws?: boolean;
  wired?: boolean;
  acceptance?: AcceptanceCriterion[];
  ciFailures?: { name: string; logTail: string }[];
}): Promise<Rig> {
  const repo = gitRepo({ kind: "w1t14136" });
  const base = repo.git("rev-parse", "HEAD");
  const acceptance = opts.acceptance ?? ACCEPTANCE;
  const rig = { events: [] as string[], checks: [] as FixSelfCheckRunArgs[], spawns: [] as SpawnWorkerArgs[],
    pushes: [] as string[], rows: [] as Rig["rows"], comments: 0, repo };
  const transcripts = [...(opts.transcripts ?? [])];
  const review = (state: "failure" | "success"): ReviewVerdict & { headSha: string; reviewerOutcome: string } => ({
    state, criteria: state === "failure" ? judged(acceptance) : judged(acceptance).map((c) => ({ ...c, met: true })),
    testTheater: false, summary: state === "failure" ? "unmet: the parser rejects a torn row" : "met", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha: base, reviewerOutcome: state });
  const host: FixCommandHost = { ...fixCommandHost(), ...(opts.wired === false ? { runFixSelfCheck: undefined } : {
    runFixSelfCheck: async (args: FixSelfCheckRunArgs): Promise<FixSelfCheckRunResult> => {
      rig.events.push(`self-check ${args.commitSha}`);
      rig.checks.push(args);
      if (opts.throws) throw new Error("reviewer provider unavailable");
      return { transcript: transcripts.shift() ?? ALL_PASS };
    } }) };
  const outcome = await runFixRung({
    taskId: "W1-T9", runId: "W1-T9-run", prUrl: "https://github.com/acme/remudero/pull/9", branch: "run-W1-T9-1",
    task: { id: "W1-T9", title: "the parser rejects a torn row", files: ["src/parser.ts"], acceptance },
    worktreePath: repo.dir, initialSessionId: "initial-session", mount: MOUNT, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir } as Config, budgetUsd: 10, strikeCap: 1, initialReview: review("failure"),
    ...(opts.ciFailures ? { ciFailures: opts.ciFailures } : {}),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: REVIEWER },
    deps: {
      spawn: async (args: SpawnWorkerArgs) => {
        rig.spawns.push(args);
        rig.events.push(`worker ${rig.spawns.length}`);
        writeFileSync(join(repo.dir, "parser.txt"), `turn ${rig.spawns.length}\n`);
        repo.git("add", "parser.txt");
        repo.git("commit", "-qm", `fix: turn ${rig.spawns.length}`);
        return worker("REPORT\nthe torn row is refused now");
      },
      waitForCiGreen: async () => "green" as const,
      runReview: async () => review("success"),
      fetchPrBody: async () => "REPORT",
      push: (_cwd: string, _branch: string, sha: string) => { rig.pushes.push(sha); rig.events.push(`push ${sha}`); },
      issues: { create: () => { rig.comments++; return "https://github.com/acme/remudero/issues/1"; }, listOpen: () => [],
        comment: () => { rig.comments++; } },
      ledgerPath: join(repo.dir, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => { rig.rows.push({ step, ...(extra ?? {}) }); },
      say: () => {},
      account: (result: WorkerResult) => result,
    },
  } as Parameters<typeof runFixRung>[0], host);
  return { ...rig, outcome };
}

const selfChecks = (rig: Rig) => rig.rows.filter((r) => r.step === "fix.self_check");

test("W1-T14136 criterion 3: the strike self-checks its commit before the push, and gets one more turn when uncleared", async () => {
  const uncleared = await strike({ transcripts: [TWO_AND_FOUR_FAIL, ALL_PASS], acceptance: WITH_HOLDOUT });
  const [first, second] = uncleared.checks.map((c) => c.commitSha);
  assert.ok(first && second && first !== second, "the second check judges the extra turn's commit");
  assert.deepEqual(uncleared.events, ["worker 1", `self-check ${first}`, "worker 2", `self-check ${second}`, `push ${second}`]);
  assert.equal(FIX_SELF_CHECK_EXTRA_TURNS, 1);
  const turn = uncleared.spawns[1]!;
  assert.equal(turn.cwd, uncleared.repo.dir, "the extra turn runs in the same worktree");
  assert.match(turn.prompt, /SELF-CHECK UNCLEARED/);
  assert.ok(turn.prompt.includes(`criterion 2: ${ACCEPTANCE[1]!.claim}`));
  assert.ok(turn.prompt.includes("reviewer: (a) the torn row still parses at the new head"));
  assert.ok(!turn.prompt.includes("the hidden path broke"), "the holdout's clause is not shown");
  assert.ok(!uncleared.spawns[0]!.prompt.includes(HOLDOUT_CLAIM) && !turn.prompt.includes(HOLDOUT_CLAIM), "nor its claim");
  assert.equal(uncleared.checks[0]!.mount, REVIEWER, "the review lane's reviewer mount judges it");
  assert.equal(uncleared.checks[0]!.worktreePath, uncleared.repo.dir);
  // The control: a clear first check pushes at once, with no extra turn.
  const clear = await strike({ transcripts: [ALL_PASS] });
  const [only] = clear.checks.map((c) => c.commitSha);
  assert.deepEqual(clear.events, ["worker 1", `self-check ${only}`, `push ${only}`]);
});

test("W1-T14136 criterion 4: each self-check writes one fix.self_check row, and a still-uncleared round still pushes", async () => {
  const rig = await strike({ transcripts: [TWO_AND_FOUR_FAIL, TWO_AND_FOUR_FAIL] });
  const rows = selfChecks(rig);
  assert.equal(rows.length, 2);
  const roundId = rig.rows.find((r) => r.step === "fix.dispatch")?.round_id;
  assert.ok(typeof roundId === "string");
  for (const [i, row] of rows.entries()) {
    assert.equal(row.round_id, roundId);
    assert.equal(row.strike, 1);
    assert.equal(row.head_sha, rig.checks[i]!.commitSha);
    assert.equal(row.attempt, i + 1);
    assert.equal(row.state, "uncleared");
    assert.equal(row.criteria_total, 4);
    assert.equal(row.cleared_count, 2);
    assert.equal(row.uncleared_count, 2);
    assert.deepEqual(row.uncleared_indices, [2, 4]);
    assert.equal(typeof row.duration_ms, "number");
  }
  assert.deepEqual(rig.pushes, [rig.checks[1]!.commitSha], "the posted review stays the only gate");
  assert.equal(rig.comments, 0, "the self-check posts no comment or issue");
  const clear = selfChecks(await strike({ transcripts: [ALL_PASS] }));
  assert.equal(clear.length, 1);
  assert.equal(clear[0]!.state, "clear");
  assert.equal(clear[0]!.cleared_count, 4);
  assert.deepEqual(clear[0]!.uncleared_indices, []);
});

test("W1-T14136 criterion 5: a failed or late self-check is recorded unavailable and the round pushes as before", async () => {
  const baseline = await strike({ wired: false });
  assert.equal(baseline.checks.length, 0);
  const failed = await strike({ throws: true });
  const rows = selfChecks(failed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "unavailable");
  assert.match(String(rows[0]!.reason), /reviewer provider unavailable/);
  assert.equal(failed.spawns.length, 1, "no extra worker turn");
  assert.equal(failed.pushes.length, 1, "the round still pushes");
  assert.equal(failed.pushes[0], failed.checks[0]!.commitSha);
  assert.equal(failed.outcome.strikes, baseline.outcome.strikes, "no extra strike");
  assert.equal(failed.rows.filter((r) => r.step === "fix.dispatch").length, 1);
  // The bound: 15 minutes, handed to the host, and enforced here whatever the host does.
  assert.equal(FIX_SELF_CHECK_TIMEOUT_MS, 15 * 60_000);
  assert.equal(failed.checks[0]!.timeoutMs, FIX_SELF_CHECK_TIMEOUT_MS);
  const controller = new AbortController();
  await assert.rejects(runBoundedFixSelfCheck(new Promise<never>(() => {}), controller, 5), /passed its 5 ms bound/);
  assert.equal(controller.signal.aborted, true, "the reviewer it started is told to stop");
  assert.equal(await runBoundedFixSelfCheck(Promise.resolve("done"), new AbortController(), 1000), "done");
  // Other round modes never run one.
  const ciLog = await strike({ ciFailures: [{ name: "unit", logTail: "not ok 1 - parser" }] });
  assert.equal(ciLog.checks.length, 0, "a ci-log round runs no self-check");
  assert.equal(ciLog.pushes.length, 1);
  for (const evidence of [
    { mergeConflict: { files: [{ path: "a.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "", theirsLog: "" } },
    { review: { unmetCriteria: [{ ...judged(ACCEPTANCE)[1]!, reason: "matched 0/2 proof keywords" }], summary: "" } },
    { actionableGateFailures: [{ reason: "test theater: added tests assert nothing" }] },
  ]) assert.notEqual(deriveFixMode(evidence as Parameters<typeof deriveFixMode>[0]), "reviewer-unmet");
});

test("W1-T14136 criterion 6: the reviewer-unmet fix prompt keeps every visible met criterion in view", () => {
  const indexed = (acceptance: readonly AcceptanceCriterion[]) => judged(acceptance).map((c, i) => ({ ...c, criterionIndex: i + 1 }));
  const render = (acceptance: AcceptanceCriterion[]) => renderFixPrompt({ task: { id: "W1-T9", title: "t" }, round: 1,
    branch: "run-W1-T9-1", evidence: { review: { unmetCriteria: indexed(acceptance).filter((c) => !c.met), summary: "unmet",
      metCriteria: metCriteriaForFix(indexed(acceptance)) } } });
  const prompt = render(ACCEPTANCE);
  const keep = prompt.slice(prompt.indexOf("KEEP MET:"));
  assert.ok(prompt.indexOf("KEEP MET:") > 0, "a KEEP MET section");
  assert.match(keep, /the self-check judges all of them before the push/);
  for (const i of [1, 3, 4]) assert.ok(keep.includes(`${i}. claim: ${ACCEPTANCE[i - 1]!.claim}\n   proof: ${ACCEPTANCE[i - 1]!.proof}`), `criterion ${i}`);
  assert.ok(!keep.includes(ACCEPTANCE[1]!.claim), "criterion 2 is not kept met");
  assert.ok(prompt.slice(0, prompt.indexOf("KEEP MET:")).includes(`2. claim: ${ACCEPTANCE[1]!.claim}`), "it is in the UNMET list");
  const hidden = render(WITH_HOLDOUT);
  assert.ok(!hidden.includes(HOLDOUT_CLAIM), "a holdout never appears");
  assert.deepEqual(metCriteriaForFix(indexed(WITH_HOLDOUT)).map((c) => c.criterionIndex), [1, 3]);
  // With nothing met, no section is rendered.
  const none = renderFixPrompt({ task: { id: "W1-T9", title: "t" }, round: 1, branch: "b",
    evidence: { review: { unmetCriteria: indexed(ACCEPTANCE).filter((c) => !c.met), summary: "unmet", metCriteria: [] } } });
  assert.ok(!none.includes("KEEP MET:"));
});

test("W1-T14136: the production host spawns the review lane's read-only reviewer, never under the test runner", async () => {
  const spawned: SpawnWorkerArgs[] = [];
  const controller = new AbortController();
  const result = await runFixSelfCheckWith(async (args) => { spawned.push(args); return worker(ALL_PASS); }, {
    worktreePath: "/wt", commitSha: "abc", prompt: "judge it", timeoutMs: FIX_SELF_CHECK_TIMEOUT_MS, signal: controller.signal,
    mount: REVIEWER, settingsFile: "/s.json", config: { root: "/r" } as Config, budgetUsd: 3, runId: "R", taskId: "W1-T9" });
  assert.equal(result.transcript, ALL_PASS);
  const args = spawned[0]!;
  assert.equal(args.cwd, "/wt");
  assert.equal(args.model, REVIEWER.model);
  assert.equal(args.mountProvider, REVIEWER.provider);
  assert.equal(args.effort, REVIEWER.effort);
  assert.equal(args.maxTurns, REVIEWER.maxTurns);
  assert.deepEqual(args.tools, SPECIALIST_TOOLS);
  assert.ok(!args.tools!.some((t) => ["Write", "Edit", "MultiEdit"].includes(t)), "read-only tools");
  assert.equal(args.sandboxIntent, "disposable-review");
  assert.equal(args.signal, controller.signal);
  assert.equal(args.resumeSessionId, undefined, "a fresh session");
  assert.equal(fixCommandHost().runFixSelfCheck, undefined, "tests never start a paid reviewer");
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(typeof fixCommandHost().runFixSelfCheck, "function", "the daemon's fix host wires it");
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved;
  }
});
