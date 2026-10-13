import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { UNIT_TEST_DISCRIMINATES_NOTE, type CorpusProofOutcome, type ReplayIdleSignal } from "../src/lib/golden-corpus.js";
import { loadProposalRegistry, updateProposalRegistry, type Proposal, type SkillEvalRecord } from "../src/lib/inbox.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "../src/lib/learnings.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import type { PairedGrader } from "../src/lib/paired-trial.js";
import type { Task } from "../src/lib/plan.js";
import { heldOutSetHash } from "../src/lib/skill-eval.js";
import type { SkillEvalCommandInput } from "../src/lib/skill-eval-command.js";
import {
  loadInjectableSkills,
  observeSkillSelection,
  renderSkillsPart,
  skillDraftProposalId,
  stageSkillDraft,
  workerAllowlistFromSettings,
  type SkillDraft,
} from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// Phase 4 of 5 of the held-out skill eval: `rmd skill-eval <proposal-id> --confirm-spend` evaluates a staged
// skill-workshop draft on tasks merged AFTER its text was staged, and records the verdict on its proposal. The
// drafter mines every merged run in its window, so time is the only hold-out it cannot leak through. Every seam
// here is a fake except the corpus read, the skill loader and the registry, which run for real on temp trees.

/** Loaded inside each test, so on a tree without the verb each proof FAILS rather than the file failing to load. */
const command = (): Promise<typeof import("../src/lib/skill-eval-command.js")> => import("../src/lib/skill-eval-command.js");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
const iso = (ms: number): string => new Date(ms).toISOString();

const STAMP = "2026-10-01T00:00:00.000Z";
const STAMP_MS = Date.parse(STAMP);
const DAY_MS = 24 * 60 * 60_000;
const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");
const PROPOSAL_ID = "skill-draft:proc-eval";
const DRAFT_NAME = "types-first";
const APPROVED_NAME = "review-the-diff";
const draftMarkdown = (front = "applies-to: implement"): string =>
  `---\nname: ${DRAFT_NAME}\ndescription: run the type checker first\n${front}\n---\n\n## Procedure\n\n- Run the type checker before the tests.\n`;
const HEADROOM = { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 40 }] };
const IDLE: ReplayIdleSignal = { liveness: { state: "up", quiet: true }, headroom: HEADROOM };
const STACK = {
  pin: { provider: "claude", model: "model-under-test", effort: "high", billing: "subscription" as const, stackHash: "stack-1" },
  revisions: { harnessRevision: "h1", promptRevision: "p1", toolRevision: "t1", scorerRevision: "s1", environmentRevision: "e1" },
  stackEvidence: {},
};
/** Three tasks merged after the stamp (one a single millisecond after it) and one merged a day before it. */
const AFTER = { "W1-T9101": STAMP_MS + 1, "W1-T9102": STAMP_MS + DAY_MS, "W1-T9103": STAMP_MS + 2 * DAY_MS };
const MERGES: Record<string, number> = { "W1-T9100": STAMP_MS - DAY_MS, ...AFTER };

function planTask(id: string, files: string[]): Task {
  return { id, title: `held-out ${id}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium",
    status: "queued", attempts: 0, files } as Task;
}

/** A merged task as the ledger records it: a discriminating `review.posted` a minute before its merge credit. */
function mergedTaskRows(merges: Record<string, number>): Record<string, unknown>[] {
  return Object.entries(merges).flatMap(([taskId, ms]) => [
    { ts: iso(ms - 60_000), step: "review.posted", task_id: taskId, run_id: `R-${taskId}`, merge_base_sha: `base-${taskId}`,
      head_sha: `head-${taskId}`, decision_verdict: { criteria: [{ claim: `claim of ${taskId}`, proof: `unit test: held-out title of ${taskId}`,
        proof_exec: "executed_pass", reason: `passed; ${UNIT_TEST_DISCRIMINATES_NOTE}` }] } },
    { ts: iso(ms), step: "verdict.merged", task_id: taskId, run_id: `R-${taskId}` },
  ]);
}

interface Fixture {
  root: string;
  registryPath: string;
  approvedDir: string;
  tasks: Task[];
  rows: LedgerLine[];
  printed: string[];
  dispatched: { taskId: string; arm: string; part: string; baseSha: string; planTaskId: string }[];
  deps: SkillEvalCommandInput;
  proposal: () => Proposal | undefined;
}

/**
 * A state dir with a real ledger and registry, an approved skill tree holding one implement skill, and fakes for the
 * plan, the dispatcher (which records the skills part each arm was given), the grader, the stack and the idle signal.
 */
function fixture(opts: { merges?: Record<string, number>; markdown?: string; proposal?: Partial<Proposal> | null; files?: string[];
  grade?: (arm: string) => CorpusProofOutcome; idle?: ReplayIdleSignal; duringDispatch?: (n: number, registryPath: string) => void } = {}): Fixture {
  const root = tmp("skill-eval-cmd-");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const merges = opts.merges ?? MERGES;
  writeLedger(mergedTaskRows(merges), { dir: stateDir });
  const registryPath = join(stateDir, "inbox-proposals.json");
  const proposals = opts.proposal === null ? [] : [{ id: PROPOSAL_ID, summary: "a staged draft", evidenceAnchors: [],
    skillFile: { name: DRAFT_NAME, markdown: opts.markdown ?? draftMarkdown() }, skillFileStagedAt: STAMP, ...opts.proposal }];
  writeFileSync(registryPath, JSON.stringify({ proposals }));
  const approvedDir = join(root, "approved-skills");
  mkdirSync(join(approvedDir, APPROVED_NAME), { recursive: true });
  writeFileSync(join(approvedDir, APPROVED_NAME, "SKILL.md"),
    `---\nname: ${APPROVED_NAME}\ndescription: d\napplies-to: implement\n---\n\nLook at the whole diff before you push.\n`);
  const tasks = Object.keys(merges).map((id) => planTask(id, opts.files ?? [`src/lib/${id}.ts`]));
  const rows: LedgerLine[] = [];
  const printed: string[] = [];
  const dispatched: Fixture["dispatched"] = [];
  const grade: PairedGrader = ({ headDir }) => {
    const verdict = (opts.grade ?? ((arm) => (arm === "with-skill" ? "pass" : "fail")))(dispatched[Number(headDir.split("/").pop())]!.arm);
    return { verdict, passed: verdict === "pass" ? 1 : 0, failed: verdict === "fail" ? 1 : 0, unmeasurable: 0, holdouts: 0, reasons: [] };
  };
  const deps: SkillEvalCommandInput = {
    registryPath: () => registryPath,
    stateDir: () => stateDir,
    approvedSkillsDir: () => approvedDir,
    loadPlanTasks: () => tasks,
    dispatcherFor: (task, item, skillsPartFor) => async (request) => {
      const n = dispatched.push({ taskId: request.taskId, arm: request.arm, part: skillsPartFor(request), baseSha: item.baseSha,
        planTaskId: task.id }) - 1;
      opts.duringDispatch?.(n, registryPath);
      return { headDir: `/heads/${n}`, headSha: `sha-${n}`, servedModel: "model-under-test", billingMode: "subscription", costUsd: 1.25,
        cleanup: () => {} };
    },
    stack: () => STACK,
    readIdle: async () => opts.idle ?? IDLE,
    log: (row) => { rows.push(row); },
    grade,
    clock: fixedClock(NOW_MS),
    print: (line) => { printed.push(line); },
  };
  return { root, registryPath, approvedDir, tasks, rows, printed, dispatched, deps,
    proposal: () => loadProposalRegistry(registryPath).find((p) => p.id === PROPOSAL_ID) };
}

const CONFIRM = [PROPOSAL_ID, "--confirm-spend"];
const refusals = (fx: Fixture): LedgerLine[] => fx.rows.filter((row) => row.step === "skill_eval.refused");

// ── the temporal hold-out stamp ──────────────────────────────────────────────────────────────────────────────────

const ALLOWLIST = workerAllowlistFromSettings({
  permissions: { deny: [], allow: [], ask: [] },
  sandbox: { enabled: true, filesystem: { denyRead: [] }, network: { allowedDomains: ["github.com"] } },
});
const REACHABLE = { reachable: true, reason: "fixture" };
const T1 = Date.parse("2026-10-02T00:00:00.000Z");
const T2 = Date.parse("2026-10-05T00:00:00.000Z");
function draft(steps: string[]): SkillDraft {
  return { name: DRAFT_NAME, description: "d", candidateHash: "c0ffee", procedureKey: "proc-stamp", supportingRuns: 3,
    markdown: `---\nname: ${DRAFT_NAME}\ndescription: d\napplies-to: implement\n---\n\n## Procedure\n${steps.map((s) => `- ${s}`).join("\n")}\n` };
}
const ONE_STEP = draft(["Run the type checker before the tests."]);
const TWO_STEPS = draft(["Run the type checker before the tests.", "Rebuild the fixture after every schema change."]);
const stampedAt = (registryPath: string): string | undefined =>
  loadProposalRegistry(registryPath).find((p) => p.id === skillDraftProposalId("proc-stamp"))?.skillFileStagedAt;
const seed = (proposal: Partial<Proposal>): string => {
  const registryPath = join(tmp("skill-stamp-"), "inbox-proposals.json");
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id: skillDraftProposalId("proc-stamp"), summary: "s", evidenceAnchors: [], ...proposal }] }));
  return registryPath;
};

test("a newly staged skill draft is stamped with the instant it was staged", () => {
  const registryPath = join(tmp("skill-stamp-"), "inbox-proposals.json");
  const result = stageSkillDraft(registryPath, ONE_STEP, ALLOWLIST, REACHABLE, {}, fixedClock(T1));
  assert.equal(result.staged, true);
  assert.equal(stampedAt(registryPath), iso(T1));
});

test("a refreshed skill draft moves its staged-at stamp to the refresh", () => {
  const registryPath = seed({ skillFile: { name: DRAFT_NAME, markdown: ONE_STEP.markdown }, skillFileStagedAt: iso(T1) });
  const result = stageSkillDraft(registryPath, TWO_STEPS, ALLOWLIST, REACHABLE, {}, fixedClock(T2));
  assert.equal(result.refreshed, true);
  assert.equal(stampedAt(registryPath), iso(T2), "the new text was staged at T2, so only tasks merged after T2 are held out from it");
});

test("a backfilled skill file is stamped with the backfill instant", () => {
  const registryPath = seed({});
  const result = stageSkillDraft(registryPath, ONE_STEP, ALLOWLIST, REACHABLE, {}, fixedClock(T2));
  assert.equal(result.backfilled, true);
  assert.equal(stampedAt(registryPath), iso(T2));
});

test("a staged draft with a skill file but no stamp is stamped on the workshop's next pass and nothing else changes", () => {
  const registryPath = seed({ summary: "kept", skillFile: { name: DRAFT_NAME, markdown: ONE_STEP.markdown } });
  const before = loadProposalRegistry(registryPath)[0]!;
  const result = stageSkillDraft(registryPath, ONE_STEP, ALLOWLIST, REACHABLE, {}, fixedClock(T2));
  assert.deepEqual(result, { refused: false, staged: false, alreadyStaged: true, stamped: true, reason: "already staged; staged-at stamp added" });
  assert.deepEqual(loadProposalRegistry(registryPath)[0], { ...before, skillFileStagedAt: iso(T2) });
  // An unparseable stamp is no stamp: the next pass replaces it with a real instant.
  const garbled = seed({ skillFile: { name: DRAFT_NAME, markdown: ONE_STEP.markdown }, skillFileStagedAt: "not-a-date" });
  assert.equal(stageSkillDraft(garbled, ONE_STEP, ALLOWLIST, REACHABLE, {}, fixedClock(T2)).stamped, true);
  assert.equal(stampedAt(garbled), iso(T2));
});

test("a stamped draft re-staged unchanged keeps its stamp and its registry bytes", () => {
  const registryPath = join(tmp("skill-stamp-"), "inbox-proposals.json");
  stageSkillDraft(registryPath, ONE_STEP, ALLOWLIST, REACHABLE, {}, fixedClock(T1));
  const bytes = readFileSync(registryPath, "utf8");
  const again = stageSkillDraft(registryPath, ONE_STEP, ALLOWLIST, REACHABLE, {}, fixedClock(T2));
  assert.deepEqual(again, { refused: false, staged: false, alreadyStaged: true, reason: "already staged" });
  assert.equal(readFileSync(registryPath, "utf8"), bytes);
  assert.equal(stampedAt(registryPath), iso(T1));
});

// ── the verb's refusals ──────────────────────────────────────────────────────────────────────────────────────────

test("without --confirm-spend skill-eval reads nothing and dispatches nothing", async () => {
  const { skillEvalCommand } = await command();
  const touched: string[] = [];
  const never = (name: string) => (): never => { touched.push(name); throw new Error(`${name} must not be called`); };
  const printed: string[] = [];
  const deps: SkillEvalCommandInput = { registryPath: never("registryPath"), stateDir: never("stateDir"), approvedSkillsDir: never("approvedSkillsDir"),
    loadPlanTasks: never("loadPlanTasks"), dispatcherFor: never("dispatcherFor"), stack: never("stack"), readIdle: never("readIdle"),
    log: never("log"), readLedger: never("readLedger"), print: (line) => { printed.push(line); } };
  assert.equal(await skillEvalCommand([PROPOSAL_ID], deps), 2);
  assert.deepEqual(touched, []);
  assert.match(printed.join("\n"), /--confirm-spend/);
});

test("skill-eval without exactly one proposal id prints its usage and reads nothing", async () => {
  const { skillEvalCommand, SKILL_EVAL_USAGE } = await command();
  const fx = fixture();
  assert.equal(await skillEvalCommand(["--confirm-spend"], fx.deps), 2);
  assert.equal(await skillEvalCommand([PROPOSAL_ID, "--confirm-spend", "--bogus"], fx.deps), 2);
  assert.equal(fx.printed[0], SKILL_EVAL_USAGE);
  assert.match(fx.printed[1]!, /^usage: rmd skill-eval .*bogus/);
  assert.deepEqual(fx.rows, []);
});

test("skill-eval refuses a proposal id the registry does not hold", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ proposal: null });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  assert.deepEqual(refusals(fx).map((row) => [row.reason, row.task_id, row.run_id]), [["proposal-not-found", PROPOSAL_ID, `SKILL-EVAL-${NOW_MS}`]]);
  assert.deepEqual(fx.dispatched, []);
});

test("skill-eval refuses a proposal that carries no skill file", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ proposal: { skillFile: undefined } });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  assert.deepEqual(refusals(fx).map((row) => row.reason), ["no-skill-file"]);
});

test("skill-eval refuses a skill name that is not one safe path segment", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ proposal: { skillFile: { name: "../escape", markdown: draftMarkdown() } } });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  assert.deepEqual(refusals(fx).map((row) => row.reason), ["skill-name-unsafe"]);
});

test("skill-eval refuses an unstamped draft and names the workshop pass that stamps it", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ proposal: { skillFileStagedAt: undefined } });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  const [row] = refusals(fx);
  assert.equal(row!.reason, "not-stamped");
  assert.match(String(row!.detail), /skill workshop's next pass stamp/);
  assert.deepEqual(fx.dispatched, []);
});

/** An eval already recorded on the proposal, by default a pass for the fixture's own draft text. */
const recordedEval = (over: Partial<SkillEvalRecord> = {}): SkillEvalRecord => ({ draftSha256: sha256(draftMarkdown()),
  heldOutSetHash: "h", taskIds: Object.keys(AFTER), verdict: "pass", reason: "held-out-benefit", detail: "d", delta: 1,
  measurableTasks: 3, totalCostUsd: 15, evaluatedAt: "2026-10-12T00:00:00.000Z", ...over });

test("skill-eval refuses to re-judge a text that already carries a recorded verdict", async () => {
  const { skillEvalCommand } = await command();
  for (const prior of [recordedEval(), recordedEval({ verdict: "refuse", reason: "no-benefit" })]) {
    const fx = fixture({ proposal: { skillEval: prior } });
    assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
    const [row] = refusals(fx);
    assert.equal(row!.reason, "already-judged");
    assert.match(String(row!.detail), new RegExp(`already judged ${prior.verdict} \\(${prior.reason}\\).*launder`));
    assert.deepEqual(fx.dispatched, []);
    assert.deepEqual(fx.proposal()!.skillEval, prior, "the first verdict stands");
  }
});

test("an unmeasured eval of the same text or a verdict on an earlier text does not block a new eval", async () => {
  const { skillEvalCommand } = await command();
  for (const prior of [recordedEval({ verdict: "refuse", reason: "too-few-measurable-tasks", measurableTasks: 0 }),
    recordedEval({ draftSha256: sha256("an earlier text of the draft") })]) {
    const fx = fixture({ proposal: { skillEval: prior } });
    assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 0);
    assert.deepEqual(refusals(fx), []);
    assert.equal(fx.proposal()!.skillEval!.evaluatedAt, iso(NOW_MS), "this run's verdict is recorded in place of the prior one");
  }
});

test("a draft with no applies-to refuses as not injectable before the ledger is read", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ markdown: draftMarkdown("audience: humans") });
  fx.deps.readLedger = () => { throw new Error("the corpus must not be read for a draft no worker can receive"); };
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  assert.deepEqual(refusals(fx).map((row) => [row.reason, row.task_ids]), [["draft-not-injected", []]]);
});

test("an unread ledger source refuses the eval before any draw", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture();
  fx.deps.readLedger = async function* (_stateDir, onUnread) { onUnread("/state/ledger.20261001T000000Z.ndjson.gz"); };
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  const [row] = refusals(fx);
  assert.equal(row!.reason, "ledger-unreadable");
  assert.match(String(row!.detail), /ledger\.20261001T000000Z\.ndjson\.gz/);
});

test("a task merged one millisecond after the stamp is held out and one merged at the stamp is excluded", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ merges: { "W1-T9200": STAMP_MS, "W1-T9201": STAMP_MS + 1, "W1-T9202": STAMP_MS + DAY_MS } });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 1, "a refused draw exits 1");
  const [row] = refusals(fx);
  assert.equal(row!.reason, "too-few-eligible");
  assert.deepEqual([...(row!.task_ids as string[])].sort(), ["W1-T9201", "W1-T9202"], "eligible: merged after the stamp, never at it");
  assert.equal(row!.excluded_by_stamp, 1);
  assert.equal(fx.proposal()!.skillEval, undefined, "a refused draw writes nothing, so a later run can retry");
  assert.deepEqual(fx.dispatched, []);
});

test("a draft the with-skill prompt would not inject refuses before any dispatch", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ markdown: draftMarkdown("applies-to: implement\nwhen-paths: docs/**") });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  const [row] = refusals(fx);
  assert.equal(row!.reason, "draft-not-injected");
  assert.deepEqual([...(row!.task_ids as string[])].sort(), Object.keys(AFTER), "every held-out task whose prompt would lack the draft is named");
  assert.deepEqual(fx.dispatched, []);
  assert.equal(fx.proposal()!.skillEval, undefined);
});

test("an eval the fleet is not idle for exits 2 and records nothing", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ idle: { liveness: { state: "up" }, headroom: HEADROOM } });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 2);
  assert.deepEqual(refusals(fx).map((row) => [row.reason, row.task_id]), [["fleet-not-idle", PROPOSAL_ID]]);
  assert.deepEqual(fx.dispatched, []);
  assert.equal(fx.proposal()!.skillEval, undefined);
});

// ── the arms and the recorded verdict ────────────────────────────────────────────────────────────────────────────

test("the with-skill part carries the draft and the without-skill part does not, and an approved skill rides in both", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture();
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 0);
  assert.deepEqual([...new Set(fx.dispatched.map((d) => d.taskId))].sort(), Object.keys(AFTER), "the held-out set is every task merged after the stamp");
  assert.equal(fx.dispatched.length, 12, "K = 3 tasks x R = 2 trials x 2 arms");
  const approved = loadInjectableSkills(fx.approvedDir);
  for (const d of fx.dispatched) {
    const task = fx.tasks.find((t) => t.id === d.taskId)!;
    assert.equal(d.planTaskId, d.taskId);
    assert.equal(d.baseSha, `base-${d.taskId}`, "each attempt is cut at its held-out task's own base");
    assert.match(d.part, new RegExp(`## skill: ${APPROVED_NAME}`), "the approved tree rides in both arms");
    if (d.arm === "with-skill") assert.match(d.part, new RegExp(`## skill: ${DRAFT_NAME}`));
    else {
      assert.doesNotMatch(d.part, new RegExp(DRAFT_NAME));
      assert.equal(d.part, renderSkillsPart(observeSkillSelection(approved, task.type, DEFAULT_KNOWLEDGE_BUDGET_CHARS, task.files).selected),
        "the without-skill arm gets exactly the part production renders today");
    }
  }
  const attempts = fx.rows.filter((row) => row.step === "skill_eval.attempt");
  assert.equal(attempts.length, 12);
  assert.ok(attempts.every((row) => row.task_id === PROPOSAL_ID && row.run_id === `SKILL-EVAL-${NOW_MS}`
    && Object.keys(AFTER).includes(String(row.held_out_task_id))), "each row names the proposal; the held-out task rides beside it");
});

test("a passing verdict is recorded on the proposal for the text it measured", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture();
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 0);
  const recorded = fx.proposal()!.skillEval!;
  assert.deepEqual({ ...recorded, taskIds: [...recorded.taskIds].sort() }, {
    draftSha256: sha256(draftMarkdown()), heldOutSetHash: heldOutSetHash(Object.keys(AFTER)), taskIds: Object.keys(AFTER), verdict: "pass",
    reason: "held-out-benefit", detail: "mean pass-rate gain 1 with no task regressed", delta: 1, measurableTasks: 3, totalCostUsd: 15,
    evaluatedAt: iso(NOW_MS) });
  assert.match(fx.printed.at(-1)!, /pass \(held-out-benefit\).*recorded on the proposal/);
});

test("a refusing verdict is recorded on the proposal and exits 1", async () => {
  const { skillEvalCommand } = await command();
  const fx = fixture({ grade: () => "pass" });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 1);
  const recorded = fx.proposal()!.skillEval!;
  assert.equal(recorded.verdict, "refuse");
  assert.equal(recorded.reason, "no-benefit");
  assert.equal(recorded.delta, 0);
  assert.equal(recorded.draftSha256, sha256(draftMarkdown()));
});

test("a draft refreshed while its eval runs is not recorded and logs skill_eval.stale", async () => {
  const { skillEvalCommand } = await command();
  const refreshed = `${draftMarkdown()}- Rebuild the fixture after every schema change.\n`;
  const fx = fixture({ duringDispatch: (n, registryPath) => {
    if (n === 0) updateProposalRegistry(registryPath, (current) => current.map((p) => ({ ...p, skillFile: { name: DRAFT_NAME, markdown: refreshed } })));
  } });
  assert.equal(await skillEvalCommand(CONFIRM, fx.deps), 1);
  assert.equal(fx.proposal()!.skillEval, undefined, "the verdict names text that is no longer staged");
  assert.equal(fx.proposal()!.skillFile!.markdown, refreshed, "the workshop's refresh survives");
  const stale = fx.rows.filter((row) => row.step === "skill_eval.stale");
  assert.deepEqual(stale.map((row) => [row.reason, row.draft_sha256, row.verdict]), [["draft-changed-mid-run", sha256(draftMarkdown()), "pass"]]);
});

// ── the production seams ─────────────────────────────────────────────────────────────────────────────────────────

test("skillEvalStack pins both arms to one provider, model and effort and names every unavailable pin", async () => {
  const { skillEvalStack } = await command();
  const sha = "a".repeat(40);
  const pins = { harnessRevision: undefined, revisions: {
    promptRevision: { source: "resolved-artifact" as const, revision: sha },
    toolRevision: { state: "unavailable" as const, reason: "executing-source-not-clean" },
    scorerRevision: [{ source: "resolved-artifact" as const, revision: sha }, { source: "trial-manifest" as const, revision: "b".repeat(40) }],
    environmentRevision: { state: "unavailable" as const, reason: "artifact-not-resolved" } } };
  const claude = skillEvalStack(pins, { model: "sonnet", effort: "high" });
  assert.deepEqual(claude.revisions, { harnessRevision: "unavailable:not-pinned", promptRevision: sha, toolRevision: "unavailable:executing-source-not-clean",
    scorerRevision: `${sha},${"b".repeat(40)}`, environmentRevision: "unavailable:artifact-not-resolved" });
  assert.deepEqual({ ...claude.pin, stackHash: typeof claude.pin.stackHash }, { provider: "claude", model: "sonnet", effort: "high",
    billing: "subscription", stackHash: "string" });
  assert.deepEqual(claude.stackEvidence, { harnessRevision: undefined, ...pins.revisions });
  const cash = skillEvalStack(pins, { model: "gpt-5.6-terra", effort: "high", provider: "cash" });
  assert.equal(cash.pin.billing, "api");
  assert.notEqual(cash.pin.stackHash, claude.pin.stackHash);
});

test("the production seams resolve the registry, ledger, plan, mounts, liveness and a sealed dispatcher", async () => {
  const { skillEvalProductionInput } = await command();
  const repoRoot = tmp("skill-eval-repo-");
  mkdirSync(join(repoRoot, "plan"), { recursive: true });
  writeFileSync(join(repoRoot, "plan", "tasks.yaml"),
    "- id: W1-T9101\n  title: a held-out task\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/lib/a.ts]\n");
  mkdirSync(join(repoRoot, ".remudero"), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../.remudero/mounts.yaml", import.meta.url)), join(repoRoot, ".remudero", "mounts.yaml"));
  const root = tmp("skill-eval-root-");
  let configLoads = 0;
  // A past instant: a row stamped after the file's own mtime would draw a ledger.future_stamp row beside it.
  const deps = skillEvalProductionInput(repoRoot, { state: "unavailable", reason: "executing-source-not-clean" },
    async (config) => (config.root === root ? HEADROOM : undefined),
    { loadConfig: () => { configLoads += 1; return { root } as Config; }, clock: fixedClock(STAMP_MS) });
  assert.equal(configLoads, 0, "building the seams reads nothing");
  assert.equal(deps.registryPath(), join(root, "state", "inbox-proposals.json"));
  assert.equal(deps.stateDir(), join(root, "state"));
  assert.equal(deps.approvedSkillsDir(), join(repoRoot, ".claude", "skills"));
  assert.deepEqual(deps.loadPlanTasks().map((task) => [task.id, task.files]), [["W1-T9101", ["src/lib/a.ts"]]]);
  const stack = deps.stack();
  assert.deepEqual([stack.pin.provider, stack.pin.model, stack.pin.effort], ["claude", "sonnet", "high"], "the implement route at medium risk");
  assert.equal(stack.revisions.harnessRevision, "unavailable:executing-source-not-clean");
  deps.log({ run_id: "SKILL-EVAL-1", task_id: PROPOSAL_ID, step: "skill_eval.refused", reason: "probe" });
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(ledger.map((row) => [row.step, row.task_id, row.ts]), [["skill_eval.refused", PROPOSAL_ID, STAMP]]);
  const idle = await deps.readIdle();
  assert.equal(idle.headroom, HEADROOM);
  assert.equal(idle.liveness?.state, "down", "this instance's own liveness is judged: no sweep in the window, so never idle");
  const task = deps.loadPlanTasks()[0]!;
  const dispatch = deps.dispatcherFor(task, { taskId: task.id, baseSha: "base", mergedAt: STAMP, creditSource: "ledger", proofs: [],
    freshness: { ageDays: 1 }, heldOut: true }, () => "");
  assert.equal(typeof dispatch, "function", "a sealed dispatcher is built per task and dispatches nothing until called");
  assert.equal(configLoads, 1, "config loads once, on first use");
});

test("rmd skill-eval is a registered verb that refuses without --confirm-spend", async () => {
  const { COMMANDS, HANDLERS } = await import("../src/run-task.js");
  assert.ok(COMMANDS.some((c) => c.name === "skill-eval" && c.syntax === "rmd skill-eval <proposal-id> --confirm-spend"));
  const handler = HANDLERS.get("skill-eval");
  assert.ok(handler, "the verb dispatches");
  assert.equal(await handler([PROPOSAL_ID]), 2, "without --confirm-spend it refuses having read nothing");
});
