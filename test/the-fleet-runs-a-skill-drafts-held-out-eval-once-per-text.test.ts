import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { UNIT_TEST_DISCRIMINATES_NOTE, type ReplayIdleSignal } from "#src/lib/golden-corpus.js";
import { classifyProposal, loadProposalRegistry, renderInbox, type Proposal, type SkillEvalRecord } from "#src/lib/inbox.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import type { PairedGrader } from "#src/lib/paired-trial.js";
import { inboxLanes, type InboxReadyItem } from "#src/lib/panel-graph.js";
import { loadDefaultPolicy, resolveDailyCostCeiling } from "#src/lib/policy.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { replayOptIn } from "#src/lib/replay-harness.js";
import { runSkillEval, SKILL_EVAL_MAX_SPEND_USD, SKILL_EVAL_STANDING_APPROVAL, type HeldOutSelected } from "#src/lib/skill-eval.js";
import { autoEvaluateSkillDrafts as autoPass, reportSkillEvalAuto, SKILL_EVAL_AUTO_STEPS, type SkillEvalSpendFit } from "#src/lib/skill-eval-auto.js";
import { evaluateStagedSkillDraft, readSkillEvalSpendFit, skillEvalCommand, skillEvalProductionInput,
  type SkillEvalCommandInput } from "#src/lib/skill-eval-command.js";
import { skillEvalInboxStatus } from "#src/lib/skill-eval-gate.js";
import { outcomeOnlyDraftRefusal, PROCEDURAL_STEP_TEXT } from "#src/lib/skill-workshop.js";
import { deriveDayCostUsd, deriveDayUnpricedRows } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13861: the fleet runs a staged skill draft's held-out eval by itself, once per text, inside the spend limits
// that already exist, and the Inbox shows the verdict. Every seam is a fake except the registry, the ledger, the
// corpus read and the skill loader, which run for real on temp trees.

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
const iso = (ms: number): string => new Date(ms).toISOString();

const STAMP = "2026-10-01T00:00:00.000Z";
const STAMP_MS = Date.parse(STAMP);
const DAY_MS = 24 * 60 * 60_000;
const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");
const ID = "skill-draft:proc-auto";
const OTHER_ID = "skill-draft:proc-other";
const DRAFT_NAME = "types-first";
const markdownWith = (steps: string[]): string =>
  `---\nname: ${DRAFT_NAME}\ndescription: run the type checker first\napplies-to: implement\n---\n\n## Procedure\n\n${steps.map((s) => `- ${s}`).join("\n")}\n`;
const MINED = markdownWith(["Run the type checker before the tests."]);
const REWRITTEN = markdownWith(["Run the type checker before the tests.", "Rebuild the fixture after every schema change."]);
const OUTCOME_ONLY = markdownWith(Object.values(PROCEDURAL_STEP_TEXT));
const HEADROOM = { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 40 }] };
const IDLE: ReplayIdleSignal = { liveness: { state: "up", quiet: true }, headroom: HEADROOM };
const BUSY: ReplayIdleSignal = { liveness: { state: "up" }, headroom: HEADROOM };
const OPEN_FIT: SkillEvalSpendFit = { dayCostUsd: 10, unpricedRows: 0, ceilingUsd: 500 };
const STACK = {
  pin: { provider: "claude", model: "model-under-test", effort: "high", billing: "subscription" as const, stackHash: "stack-1" },
  revisions: { harnessRevision: "h1", promptRevision: "p1", toolRevision: "t1", scorerRevision: "s1", environmentRevision: "e1" },
  stackEvidence: {},
};
const MERGES: Record<string, number> = { "W1-T9100": STAMP_MS - DAY_MS, "W1-T9101": STAMP_MS + 1, "W1-T9102": STAMP_MS + DAY_MS,
  "W1-T9103": STAMP_MS + 2 * DAY_MS };

function planTask(id: string): Task {
  return { id, title: `held-out ${id}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium",
    status: "queued", attempts: 0, files: [`src/lib/${id}.ts`] } as Task;
}

function mergedTaskRows(): Record<string, unknown>[] {
  return Object.entries(MERGES).flatMap(([taskId, ms]) => [
    { ts: iso(ms - 60_000), step: "review.posted", task_id: taskId, run_id: `R-${taskId}`, merge_base_sha: `base-${taskId}`,
      head_sha: `head-${taskId}`, decision_verdict: { criteria: [{ claim: `claim of ${taskId}`, proof: `unit test: held-out title of ${taskId}`,
        proof_exec: "executed_pass", reason: `passed; ${UNIT_TEST_DISCRIMINATES_NOTE}` }] } },
    { ts: iso(ms), step: "verdict.merged", task_id: taskId, run_id: `R-${taskId}` },
  ]);
}

interface Fixture {
  repoRoot: string;
  stateDir: string;
  registryPath: string;
  rows: LedgerLine[];
  printed: string[];
  dispatched: { taskId: string; arm: string; claimAtDispatch: Proposal["skillEvalAuto"] }[];
  deps: SkillEvalCommandInput;
  proposal: (id?: string) => Proposal | undefined;
  skillsTree: () => string[];
  /** Mutable: the gates the next pass reads. */
  gates: { idle: ReplayIdleSignal; fit: SkillEvalSpendFit };
}

function fixture(opts: { proposals?: Partial<Proposal>[]; ledger?: Record<string, unknown>[]; dispatch?: "ok" | "throw" } = {}): Fixture {
  const repoRoot = tmp("skill-eval-auto-");
  const stateDir = join(repoRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeLedger([...mergedTaskRows(), ...(opts.ledger ?? [])], { dir: stateDir });
  const registryPath = join(stateDir, "inbox-proposals.json");
  const proposals = (opts.proposals ?? [{}]).map((p) => ({ id: ID, summary: "a staged draft", evidenceAnchors: [],
    skillFile: { name: DRAFT_NAME, markdown: MINED }, skillFileStagedAt: STAMP, ...p }));
  writeFileSync(registryPath, JSON.stringify({ proposals }));
  // The approved skill tree production loads: <repoRoot>/.claude/skills.
  const approvedDir = join(repoRoot, ".claude", "skills");
  mkdirSync(join(approvedDir, "review-the-diff"), { recursive: true });
  writeFileSync(join(approvedDir, "review-the-diff", "SKILL.md"),
    "---\nname: review-the-diff\ndescription: d\napplies-to: implement\n---\n\nLook at the whole diff before you push.\n");
  const tasks = Object.keys(MERGES).map(planTask);
  const rows: LedgerLine[] = [];
  const printed: string[] = [];
  const dispatched: Fixture["dispatched"] = [];
  const gates = { idle: IDLE, fit: OPEN_FIT };
  const proposal = (id = ID): Proposal | undefined => loadProposalRegistry(registryPath).find((p) => p.id === id);
  const grade: PairedGrader = ({ headDir }) => {
    const verdict = dispatched[Number(headDir.split("/").pop())]!.arm === "with-skill" ? "pass" : "fail";
    return { verdict, passed: verdict === "pass" ? 1 : 0, failed: verdict === "fail" ? 1 : 0, unmeasurable: 0, holdouts: 0, reasons: [] };
  };
  const deps: SkillEvalCommandInput = {
    registryPath: () => registryPath,
    stateDir: () => stateDir,
    approvedSkillsDir: () => approvedDir,
    loadPlanTasks: () => tasks,
    dispatcherFor: (_task, _item, skillsPartFor) => async (request) => {
      skillsPartFor(request);
      if (opts.dispatch === "throw") throw new Error("dispatch must not happen");
      const n = dispatched.push({ taskId: request.taskId, arm: request.arm, claimAtDispatch: proposal()?.skillEvalAuto }) - 1;
      return { headDir: `/heads/${n}`, headSha: `sha-${n}`, servedModel: "model-under-test", billingMode: "subscription", costUsd: 1.25,
        cleanup: () => {} };
    },
    stack: () => STACK,
    readIdle: async () => gates.idle,
    readSpendFit: () => gates.fit,
    log: (row) => { rows.push(row); },
    grade,
    clock: fixedClock(NOW_MS),
    print: (line) => { printed.push(line); },
  };
  const skillsTree = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else out.push(`${relative(approvedDir, path)}:${sha256(readFileSync(path, "utf8"))}`);
      }
    };
    walk(approvedDir);
    return out;
  };
  return { repoRoot, stateDir, registryPath, rows, printed, dispatched, deps, proposal, skillsTree, gates };
}

const READINESS = { plan: { byId: new Map() } as unknown as Plan, isMerged: () => false, grepAnchorTrue: () => true,
  openProposalIds: new Set<string>(), isRatified: () => false };

/** The pass as the retro wires it: the one eval path over the same input. */
const autoEvaluateSkillDrafts = (input: SkillEvalCommandInput) =>
  autoPass(input, (proposalId, approval, runId) => evaluateStagedSkillDraft(proposalId, approval, input, runId));

const stepRows = (fx: Fixture, step: string): LedgerLine[] => fx.rows.filter((row) => row.step === step);
/** 3 held-out tasks x 2 trials x 2 arms. */
const ONE_EVAL = 12;

// ── criterion 1 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13861 criterion 1: an open staged draft that passes the whole-draft check is evaluated once, claimed first, and its verdict is recorded", async () => {
  const fx = fixture();
  const result = await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL);
  assert.equal(result.proposalId, ID);
  // The claim is on the registry entry before the first attempt, naming the stored text.
  assert.equal(fx.dispatched[0]!.claimAtDispatch?.state, "claimed");
  assert.equal(fx.dispatched[0]!.claimAtDispatch?.draftSha256, sha256(MINED));
  const claimed = stepRows(fx, SKILL_EVAL_AUTO_STEPS.claimed);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.task_id, ID);
  assert.equal(claimed[0]!.draft_sha256, sha256(MINED));
  const firstAttempt = fx.rows.findIndex((row) => row.step === "skill_eval.attempt");
  assert.ok(fx.rows.indexOf(claimed[0]!) < firstAttempt, "the claim row is written before the first attempt");
  assert.equal(claimed[0]!.run_id, fx.rows[firstAttempt]!.run_id, "the claim names the eval's own run");
  // The verdict is recorded the way `rmd skill-eval` records it.
  const record = fx.proposal()!.skillEval!;
  assert.equal(record.draftSha256, sha256(MINED));
  assert.equal(record.verdict, "pass");
  assert.equal(record.reason, "held-out-benefit");
  assert.equal(record.evaluatedAt, iso(NOW_MS));
  assert.ok(fx.printed.some((line) => line.includes("recorded on the proposal")));
  assert.equal(stepRows(fx, "skill_eval.refused").length, 0);
  // No argv carries --confirm-spend: the spend was approved by the standing approval, and nothing names the flag.
  assert.equal(claimed[0]!.approval, SKILL_EVAL_STANDING_APPROVAL.ref);
  assert.ok(![...fx.rows.map((row) => JSON.stringify(row)), ...fx.printed].some((line) => line.includes("confirm-spend")));
});

// ── criterion 2 ───────────────────────────────────────────────────────────────────────────────────────────────

const assertUntouched = async (fx: Fixture, why: string): Promise<void> => {
  const before = readFileSync(fx.registryPath, "utf8");
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0, why);
  assert.equal(readFileSync(fx.registryPath, "utf8"), before, `${why}: no claim`);
  assert.equal(stepRows(fx, SKILL_EVAL_AUTO_STEPS.claimed).length + stepRows(fx, SKILL_EVAL_AUTO_STEPS.waiting).length, 0, `${why}: no row`);
};

test("W1-T13861 criterion 2: a draft below the quality bar, closed, declined or ratified gets no eval, no claim and no row", async () => {
  assert.notEqual(outcomeOnlyDraftRefusal(OUTCOME_ONLY), undefined);
  assert.equal(outcomeOnlyDraftRefusal(MINED), undefined);
  await assertUntouched(fixture({ proposals: [{ skillFile: { name: DRAFT_NAME, markdown: OUTCOME_ONLY } }] }), "an outcome-only text");
  await assertUntouched(fixture({ proposals: [{ skillDraftClose: { at: STAMP, reason: "withdrawn: x", skillSha256: sha256(MINED) } }] }),
    "a draft the workshop closed");
  await assertUntouched(fixture({ ledger: [{ ts: iso(NOW_MS - 1000), step: "panel.proposal_declined", task_id: ID, run_id: "P-1",
    reason: "not useful" }] }), "a declined draft");
  await assertUntouched(fixture({ ledger: [{ ts: iso(NOW_MS - 1000), step: "ratify.approved", task_id: ID, run_id: "P-2" }] }),
    "a ratified draft");
});

test("W1-T13861 criterion 2: a declined draft that the operator restored is open again", async () => {
  const fx = fixture({ ledger: [
    { ts: iso(NOW_MS - 2000), step: "panel.proposal_declined", task_id: ID, run_id: "P-1", reason: "not now" },
    { ts: iso(NOW_MS - 1000), step: "panel.proposal_restored", task_id: ID, run_id: "P-1" },
  ] });
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL);
});

test("W1-T13861 criterion 2: an unreadable ledger leaves every draft alone", async () => {
  const fx = fixture();
  appendFileSync(join(fx.stateDir, "ledger.ndjson"), "{\"torn\":");
  const before = readFileSync(fx.registryPath, "utf8");
  const result = await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0);
  assert.equal(readFileSync(fx.registryPath, "utf8"), before);
  assert.match(result.reason, /incomplete ledger union/);
});

test("W1-T13861 criterion 2: a registry with no skill draft reads no gate", async () => {
  const fx = fixture({ proposals: [{ id: "followup:x", skillFile: undefined }] });
  fx.deps.readIdle = async () => { throw new Error("no gate may be read"); };
  const result = await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(result.proposalId, undefined);
  assert.match(result.reason, /no skill draft is waiting/);
});

// ── criterion 3 ───────────────────────────────────────────────────────────────────────────────────────────────

const record = (markdown: string, over: Partial<SkillEvalRecord> = {}): SkillEvalRecord => ({ draftSha256: sha256(markdown),
  heldOutSetHash: "h", taskIds: [], verdict: "refuse", reason: "no-benefit", detail: "d", delta: 0, measurableTasks: 3, totalCostUsd: 1,
  evaluatedAt: STAMP, ...over });

test("W1-T13861 criterion 3: invariant:one-eval-per-text a judged text, a too-few-measurable text and a claimed text get no second eval", async () => {
  const fx = fixture();
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL);
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL, "the second pass dispatches nothing");
  await assertUntouched(fixture({ proposals: [{ skillEval: record(MINED, { reason: "too-few-measurable-tasks" }) }] }),
    "a too-few-measurable verdict on this text");
  await assertUntouched(fixture({ proposals: [{ skillEvalAuto: { draftSha256: sha256(MINED), state: "claimed", runId: "SKILL-EVAL-1",
    at: STAMP } }] }), "a claim with no verdict (a run that stopped or crashed)");
});

test("W1-T13861 criterion 3: after the workshop rewrites the text, the new text is evaluated once", async () => {
  const fx = fixture({ proposals: [{ skillFile: { name: DRAFT_NAME, markdown: REWRITTEN }, skillEval: record(MINED),
    skillEvalAuto: { draftSha256: sha256(MINED), state: "claimed", runId: "SKILL-EVAL-1", at: STAMP } }] });
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL);
  assert.equal(fx.proposal()!.skillEval!.draftSha256, sha256(REWRITTEN));
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL);
});

// ── criterion 4 ───────────────────────────────────────────────────────────────────────────────────────────────

async function assertWaits(fx: Fixture, pattern: RegExp): Promise<void> {
  await autoEvaluateSkillDrafts(fx.deps);
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0);
  const waiting = stepRows(fx, SKILL_EVAL_AUTO_STEPS.waiting);
  assert.equal(waiting.length, 1, "the same reason on the next pass writes no second row");
  assert.match(String(waiting[0]!.reason), pattern);
  assert.equal(stepRows(fx, SKILL_EVAL_AUTO_STEPS.claimed).length, 0);
  const auto = fx.proposal()!.skillEvalAuto!;
  assert.equal(auto.state, "waiting", "no claim is written");
  assert.match(String(auto.reason), pattern);
  fx.gates.idle = IDLE;
  fx.gates.fit = OPEN_FIT;
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL, "a later pass with every gate open runs the eval");
}

test("W1-T13861 criterion 4: invariant:gates-wait-never-bypass a busy fleet waits", async () => {
  const fx = fixture();
  fx.gates.idle = BUSY;
  await assertWaits(fx, /not in quiet mode/);
});

test("W1-T13861 criterion 4: a day whose cost plus the eval limit is above the daily ceiling waits", async () => {
  const fx = fixture();
  fx.gates.fit = { dayCostUsd: 500 - SKILL_EVAL_MAX_SPEND_USD + 0.01, unpricedRows: 0, ceilingUsd: 500 };
  await assertWaits(fx, /^daily-cost-ceiling/);
  const at = fixture();
  at.gates.fit = { dayCostUsd: 500 - SKILL_EVAL_MAX_SPEND_USD, unpricedRows: 0, ceilingUsd: 500 };
  await autoEvaluateSkillDrafts(at.deps);
  assert.equal(at.dispatched.length, ONE_EVAL, "at the ceiling exactly, the eval fits");
});

test("W1-T13861 criterion 4: a day with unpriced rows waits", async () => {
  const fx = fixture();
  fx.gates.fit = { dayCostUsd: 0, unpricedRows: 2, ceilingUsd: 500 };
  await assertWaits(fx, /^daily-cost-unpriced/);
});

test("W1-T13861 criterion 4: a cash stack with too little allowance, or an unreadable one, waits", async () => {
  const fx = fixture();
  fx.gates.fit = { ...OPEN_FIT, cash: { remainingUsd: SKILL_EVAL_MAX_SPEND_USD - 1 } };
  await assertWaits(fx, /^cash-allowance:/);
  const unset = fixture();
  unset.gates.fit = { ...OPEN_FIT, cash: { unreadable: "cash provider requires a dailyCapUsd before any paid request" } };
  await assertWaits(unset, /^cash-allowance-unreadable: .*dailyCapUsd/);
  const enough = fixture();
  enough.gates.fit = { ...OPEN_FIT, cash: { remainingUsd: SKILL_EVAL_MAX_SPEND_USD } };
  await autoEvaluateSkillDrafts(enough.deps);
  assert.equal(enough.dispatched.length, ONE_EVAL);
});

test("W1-T13861 criterion 4: an input with no spend reading waits, and a new reason writes a new row", async () => {
  const fx = fixture();
  delete fx.deps.readSpendFit;
  await autoEvaluateSkillDrafts(fx.deps);
  fx.gates.idle = BUSY;
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0);
  assert.deepEqual(stepRows(fx, SKILL_EVAL_AUTO_STEPS.waiting).map((row) => String(row.reason).split(":")[0]),
    ["spend-not-measured", "refusing to replay"]);
});

test("W1-T13861 criterion 4: the production spend reading is the day's ledgered cost, the effective ceiling and, for cash, the allowance", () => {
  const root = tmp("skill-eval-fit-");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const rows = [
    { ts: iso(NOW_MS - 60_000), step: "verdict", run_id: "R-1", task_id: "W1-T1", cost_usd: 42.5, outcome: "merged" },
    { ts: iso(NOW_MS - 30_000), step: "verdict", run_id: "R-2", task_id: "W1-T2", outcome: "merged" },
  ];
  writeLedger(rows, { dir: stateDir });
  writeFileSync(join(stateDir, "DAILY_COST_CEILING_OVERRIDE"), JSON.stringify({ usd: 300, setAt: STAMP }));
  const config = { root } as Config;
  const input = skillEvalProductionInput(REPO_ROOT, undefined, async () => undefined,
    { loadConfig: () => config, clock: fixedClock(NOW_MS) });
  const fit = input.readSpendFit!();
  assert.equal(fit.dayCostUsd, deriveDayCostUsd(rows, NOW_MS));
  assert.equal(fit.unpricedRows, deriveDayUnpricedRows(rows, NOW_MS));
  assert.equal(fit.ceilingUsd, 300);
  assert.equal(fit.ceilingUsd, resolveDailyCostCeiling(root, loadDefaultPolicy()).usd);
  assert.equal(fit.cash, undefined, "the implement/medium mount runs on the Claude subscription");
  const cashPin = { billing: "api" as const, model: "cash-model" };
  const noCap = readSkillEvalSpendFit(config, cashPin, fixedClock(NOW_MS), loadDefaultPolicy());
  assert.ok(noCap.cash !== undefined && "unreadable" in noCap.cash && /dailyCapUsd/.test(noCap.cash.unreadable));
  const capped = readSkillEvalSpendFit({ root, dailyCapUsd: 50 } as Config, cashPin, fixedClock(NOW_MS), loadDefaultPolicy());
  assert.deepEqual(capped.cash, { remainingUsd: 50 });
});

// ── criterion 5 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13861 criterion 5: a held-out selection that refuses before any dispatch removes the claim", async () => {
  // Every merge predates the stamp, so nothing is held out.
  const fx = fixture({ proposals: [{ skillFileStagedAt: iso(NOW_MS) }], dispatch: "throw" });
  const result = await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0);
  assert.equal(stepRows(fx, SKILL_EVAL_AUTO_STEPS.claimed).length, 1);
  assert.equal(stepRows(fx, "skill_eval.refused")[0]!.reason, "too-few-eligible");
  assert.equal(fx.proposal()!.skillEvalAuto, undefined, "the claim is removed, so the draft waits for the next pass");
  assert.match(result.reason, /released/);
});

test("W1-T13861 criterion 5: runSkillEval refusing with zero attempts removes the claim, and a pass starts at most one eval", async () => {
  const fx = fixture({ proposals: [{}, { id: OTHER_ID, skillFile: { name: "other-draft", markdown: MINED.replace(DRAFT_NAME, "other-draft") } }] });
  // Quiet at the auto gate, busy by the time runSkillEval reads it.
  let reads = 0;
  fx.deps.readIdle = async () => (reads++ === 0 ? IDLE : BUSY);
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0);
  assert.equal(stepRows(fx, "skill_eval.refused")[0]!.reason, "fleet-not-idle");
  assert.equal(fx.proposal()!.skillEvalAuto, undefined);
  assert.equal(fx.proposal(OTHER_ID)!.skillEvalAuto, undefined, "the pass does not move on to a second draft");
  fx.deps.readIdle = async () => IDLE;
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, ONE_EVAL, "one eval in this pass");
  assert.equal(fx.proposal(OTHER_ID)!.skillEval, undefined);
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 2 * ONE_EVAL, "the next draft gets the next pass");
  assert.equal(fx.proposal(OTHER_ID)!.skillEval!.verdict, "pass");
});

test("W1-T13861 criterion 5: a cancelled run keeps its claim", async () => {
  const fx = fixture();
  fx.deps.control = { finishByMs: 1000, shutdownReserveMs: 100 };
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.proposal()!.skillEvalAuto?.state, "claimed");
  assert.equal(fx.proposal()!.skillEval, undefined);
});

test("W1-T13861 criterion 5: a text rewritten between the read and the claim is not claimed", async () => {
  const fx = fixture();
  const realIdle = fx.deps.readIdle;
  fx.deps.readIdle = async () => {
    const raw = JSON.parse(readFileSync(fx.registryPath, "utf8")) as { proposals: Proposal[] };
    raw.proposals[0]!.skillFile = { name: DRAFT_NAME, markdown: REWRITTEN };
    writeFileSync(fx.registryPath, JSON.stringify(raw));
    return realIdle();
  };
  const result = await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.dispatched.length, 0);
  assert.equal(fx.proposal()!.skillEvalAuto, undefined);
  assert.match(result.reason, /changed before it was claimed/);
});

test("W1-T13861 criterion 5: the retro's report says what the pass did and never throws", async () => {
  const said: string[] = [];
  await reportSkillEvalAuto(async () => ({ reason: "no skill draft is waiting for an eval" }), (line) => said.push(line));
  await reportSkillEvalAuto(async () => { throw new Error("registry locked"); }, (line) => said.push(line));
  assert.deepEqual(said, ["skill eval: no skill draft is waiting for an eval", "skill eval: the auto pass failed: registry locked"]);
});

// ── criterion 6 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13861 criterion 6: the operator verb still needs --confirm-spend, and the standing approval is only the code value", async () => {
  const fx = fixture();
  const reads: string[] = [];
  const guarded = new Proxy(fx.deps, { get: (target, key) => { reads.push(String(key)); return target[key as keyof SkillEvalCommandInput]; } });
  assert.equal(await skillEvalCommand([ID], guarded), 2);
  assert.deepEqual(reads.filter((key) => key !== "print"), [], "refused having read nothing");
  assert.equal(replayOptIn([ID]).enabled, false);
  assert.equal(SKILL_EVAL_STANDING_APPROVAL.ref, "operator-session#skill-eval-runs-itself-2026-11-19");
  assert.ok(Object.isFrozen(SKILL_EVAL_STANDING_APPROVAL));
  // A copy with the same text (what argv, an environment variable or a config file could carry) is not the approval.
  const selection: HeldOutSelected = { ok: true, items: [], draftSha256: sha256(MINED), heldOutSetHash: "h", eligibleCount: 0 };
  const logged: string[] = [];
  const base = { selection, draftMarkdown: MINED, argv: [] as string[], idle: IDLE, stack: STACK, log: (step: string) => logged.push(step),
    dispatcherFor: () => { throw new Error("no dispatch"); } };
  const copy = await runSkillEval({ ...base, standingApproval: JSON.parse(JSON.stringify(SKILL_EVAL_STANDING_APPROVAL)) as typeof SKILL_EVAL_STANDING_APPROVAL });
  assert.equal(copy.state === "refused" && copy.reason, "spend-not-confirmed");
  const real = await runSkillEval({ ...base, standingApproval: SKILL_EVAL_STANDING_APPROVAL });
  assert.equal(real.state === "refused" && real.reason, "too-few-held-out-tasks", "the real value passes consent; every other check still applies");
  const busy = await runSkillEval({ ...base, idle: BUSY, standingApproval: SKILL_EVAL_STANDING_APPROVAL });
  assert.equal(busy.state === "refused" && busy.reason, "fleet-not-idle");
});

// ── criterion 7 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13861 criterion 7: the Inbox line for each eval state, in `rmd inbox` and on the panel's ready item", async () => {
  const claimed = { draftSha256: sha256(MINED), state: "claimed" as const, runId: "SKILL-EVAL-1", at: STAMP };
  const waiting = { draftSha256: sha256(MINED), state: "waiting" as const, reason: "daily-cost-ceiling: x", at: STAMP };
  const cases: [Partial<Proposal>, string][] = [
    [{ skillEval: record(MINED, { verdict: "pass", reason: "held-out-benefit" }) }, "eval passed — ready to approve"],
    [{ skillEval: record(MINED) }, "eval failed: no-benefit"],
    [{ skillEvalAuto: claimed }, `eval running or stopped since ${STAMP}`],
    [{ skillEvalAuto: waiting }, "eval waiting: daily-cost-ceiling: x"],
    [{}, "eval not run yet"],
    [{ skillEval: record(REWRITTEN, { verdict: "pass" }), skillEvalAuto: { ...claimed, draftSha256: sha256(REWRITTEN) } }, "eval not run yet"],
  ];
  for (const [over, line] of cases) {
    const proposal = { id: ID, summary: "s", evidenceAnchors: [], skillFile: { name: DRAFT_NAME, markdown: MINED }, ...over } as Proposal;
    assert.equal(skillEvalInboxStatus(MINED, proposal.skillEval, proposal.skillEvalAuto), line);
    const classification = classifyProposal(proposal, undefined, READINESS);
    assert.equal(classification.state, "ready");
    const text = renderInbox([classification]);
    assert.ok(text.includes(`READY — ${ID}\n  draft: not cached\n  ${line}`), text);
    const root = tmp("skill-eval-lanes-");
    const lanes = inboxLanes({ proposals: [proposal], classifications: [classification],
      ledgerLines: Object.assign([], { torn: 0, present: true }) } as never, root);
    const items = [...lanes.ready, ...lanes.needsYou.ready] as InboxReadyItem[];
    assert.ok(items.length > 0 && items.every((item) => item.skillEvalStatus === line), JSON.stringify(items));
  }
  // A ready item that is not a skill draft carries no eval line.
  const plain = { id: "followup:x", summary: "s", evidenceAnchors: [] } as Proposal;
  const lanes = inboxLanes({ proposals: [plain], classifications: [{ proposalId: plain.id, state: "ready", reasons: [] }],
    ledgerLines: Object.assign([], { torn: 0, present: true }) } as never, tmp("skill-eval-lanes-"));
  assert.ok([...lanes.ready, ...lanes.needsYou.ready].every((item) => !("skillEvalStatus" in item)));
  assert.ok(!renderInbox([{ proposalId: plain.id, state: "ready", reasons: [] }]).includes("eval "));
});

// ── criterion 8 ───────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13861 criterion 8: invariant:approve-only-writes-skills an auto pass writes nothing under .claude/skills, even after a pass", async () => {
  const fx = fixture();
  const before = fx.skillsTree();
  await autoEvaluateSkillDrafts(fx.deps);
  assert.equal(fx.proposal()!.skillEval!.verdict, "pass");
  assert.deepEqual(fx.skillsTree(), before);
  assert.deepEqual(readdirSync(join(fx.repoRoot, ".claude", "skills")), ["review-the-diff"]);
});

test("W1-T13861: the two new ledger steps are declared", () => {
  for (const step of [SKILL_EVAL_AUTO_STEPS.waiting, SKILL_EVAL_AUTO_STEPS.claimed]) {
    assert.deepEqual(meaningOfStep(step)?.writer, ["autoEvaluateSkillDrafts"], step);
  }
});
