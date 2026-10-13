/**
 * lib/skill-eval-command.ts — `rmd skill-eval <proposal-id> --confirm-spend`, the held-out skill eval's operator
 * verb (phase 4 of 5): the production caller `runSkillEval` (skill-eval.ts) never had.
 *
 * One command takes a staged skill-workshop draft from the proposal registry, derives the golden corpus from the
 * ledger union and the plan, holds out only tasks merged AFTER the draft's text was staged (`skillFileStagedAt`,
 * set by `stageSkillDraft`), attempts it with and without the draft on K held-out tasks through the sealed paired
 * dispatcher, and records the verdict on the proposal. Every side effect is a seam in {@link SkillEvalCommandInput};
 * run-task.ts supplies only what it owns, through {@link skillEvalProductionInput}.
 *
 * WHY TIME IS THE HOLD-OUT. The drafter mines every merged run in the retro window, not only the runs it cites, so
 * no list of task ids names everything it saw. A task merged after the text was staged is one it cannot have seen.
 *
 * Exit codes: 0 a passing verdict was recorded; 1 the run produced no passing record (a refusing verdict recorded,
 * a held-out selection refused, or the text changed mid-run); 2 refused before any attempt was dispatched.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deriveRuntimePins, type RuntimePins } from "./benchmark-aa-readiness.js";
import type { BenchmarkRevisionPin, BenchmarkStackEvidence } from "./benchmark-run.js";
import { systemClock, type Clock } from "./clock.js";
import { loadConfig, type Config } from "./config.js";
import { judgeInstanceLiveness, LIVENESS_WINDOW_MS, readLivenessRows } from "./fleet-liveness.js";
import { deriveGoldenCorpus, mergeCreditsFromLedger, type CorpusTaskSpec, type GoldenCorpusItem, type ReplayIdleSignal } from "./golden-corpus.js";
import type { UsageSnapshot } from "./headroom.js";
import { approvedSkillRelPath, loadProposalRegistry, updateProposalRegistry, type SkillEvalRecord } from "./inbox.js";
import { resolveInstallRoot } from "./install-root.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "./learnings.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { openLedgerUnion } from "./ledger-union.js";
import { loadMounts, mountsPath, resolveMount, type Mount } from "./mounts.js";
import { PAIRED_ATTEMPT_MAX_BUDGET_USD, sealedPairedAttemptDispatcher, type PairedAttemptDispatch, type PairedAttemptRequest,
  type PairedGrader } from "./paired-trial.js";
import { loadPlan, type Task } from "./plan.js";
import { loadDefaultPolicy } from "./policy.js";
import { replayOptIn } from "./replay-harness.js";
import { runSkillEval, selectHeldOutTasks, SKILL_EVAL_ATTEMPTABLE_TASK_TYPES, SKILL_EVAL_STEPS, type SkillEvalRunInput } from "./skill-eval.js";
import { loadInjectableSkills, observeSkillSelection, renderSkillsPart, skillFileStagedAtMs, type InjectableSkill } from "./skill-workshop.js";
import { withTempDir } from "./tmp.js";

export const SKILL_EVAL_USAGE = "usage: rmd skill-eval <proposal-id> --confirm-spend";

/** Logged instead of a proposal write when the staged text changed while its eval ran. */
export const SKILL_EVAL_STALE_STEP = "skill_eval.stale";

/** The steps the corpus reads: `review.posted` carries the scorer, `verdict.merged`/`verdict` the merge credit. */
const CORPUS_STEPS = ["review.posted", "verdict.merged", "verdict"] as const;

/** The mount both arms run on: the implement route's default class at medium risk, one stack for every task. */
export const SKILL_EVAL_MOUNT_ROUTE = { taskType: "implement", risk: "medium" } as const;

/** Every side effect of {@link skillEvalCommand}. Each is called only once the verb needs it. */
export interface SkillEvalCommandInput {
  /** The proposal registry the retro stages skill drafts into. */
  registryPath: () => string;
  /** The state dir whose ledger union the corpus is derived from. */
  stateDir: () => string;
  /** The approved skill tree production loads (`<repoRoot>/.claude/skills`). */
  approvedSkillsDir: () => string;
  loadPlanTasks: () => readonly Task[];
  /** One sealed dispatcher per held-out task, at the item's base, rendering `skillsPartFor`'s part per arm. */
  dispatcherFor: (task: Task, item: GoldenCorpusItem, skillsPartFor: (request: PairedAttemptRequest<string>) => string)
    => PairedAttemptDispatch<string>;
  stack: () => SkillEvalRunInput["stack"];
  readIdle: () => Promise<ReplayIdleSignal>;
  log: (row: LedgerLine) => void;
  /** Absent: {@link openLedgerUnion} over every rotation form, reporting each unread source. */
  readLedger?: (stateDir: string, onUnread: (path: string) => void) => AsyncIterable<Record<string, unknown>>;
  /** Absent: each item's proofs through the reviewer's own executor. */
  grade?: PairedGrader;
  clock?: Clock;
  print?: (line: string) => void;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The loader's own order: directory names compared by code unit, as `readdirSync(...).sort()` leaves them. */
const byName = (a: InjectableSkill, b: InjectableSkill): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function readCorpusRows(stateDir: string, onUnread: (path: string) => void): AsyncIterable<Record<string, unknown>> {
  return openLedgerUnion(stateDir, { step: CORPUS_STEPS, onUnreadArchive: onUnread, onUnreadLive: onUnread });
}

/**
 * `rmd skill-eval <proposal-id> --confirm-spend`. Refuses without `--confirm-spend` having read nothing, then refuses
 * a proposal that is absent, carries no skill file, names an unsafe skill or carries no staged-at stamp; derives the
 * corpus and holds out every task merged at or before the stamp; refuses a draft the skill loader would not inject
 * into some held-out task's prompt, since both arms would then be identical; runs the eval; and records the verdict
 * only while the staged text is still the one evaluated.
 */
export async function skillEvalCommand(argv: readonly string[], input: SkillEvalCommandInput): Promise<number> {
  const print = input.print ?? ((line: string) => console.log(line));
  let positionals: string[];
  try {
    positionals = parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: { "confirm-spend": { type: "boolean" } } }).positionals;
  } catch (error) {
    const reason = `arguments-invalid: ${(error as Error).message}`;
    print(`${SKILL_EVAL_USAGE} (${reason})`);
    return 2;
  }
  const proposalId = positionals.length === 1 ? positionals[0]! : undefined;
  if (proposalId === undefined) {
    print(SKILL_EVAL_USAGE);
    return 2;
  }
  const optIn = replayOptIn(argv);
  if (!optIn.enabled) {
    print(`skill-eval: ${optIn.reason}`);
    return 2;
  }
  const clock = input.clock ?? systemClock;
  const runId = `SKILL-EVAL-${clock.now()}`;
  const write = (step: string, fields: Record<string, unknown>): void => input.log({ ...fields, run_id: runId, task_id: proposalId, step });
  const refuse = (code: number, reason: string, detail: string, fields: Record<string, unknown> = {}): number => {
    write(SKILL_EVAL_STEPS.refused, { reason, detail, ...fields });
    print(`skill-eval: refused ${proposalId}: ${reason}: ${detail}`);
    return code;
  };

  const registryPath = input.registryPath();
  const proposal = loadProposalRegistry(registryPath).find((p) => p.id === proposalId);
  if (proposal === undefined) return refuse(2, "proposal-not-found", `no proposal ${proposalId} in ${registryPath}`);
  const skillFile = proposal.skillFile;
  if (skillFile === undefined) return refuse(2, "no-skill-file", `${proposalId} carries no skill file to evaluate`);
  if (approvedSkillRelPath(skillFile.name) === null) {
    return refuse(2, "skill-name-unsafe", `the skill name ${JSON.stringify(skillFile.name)} is not a single safe path segment`);
  }
  const stagedAtMs = skillFileStagedAtMs(proposal.skillFileStagedAt);
  if (stagedAtMs === null) {
    return refuse(2, "not-stamped", `${proposalId}'s skill file carries no parseable skillFileStagedAt `
      + `(${JSON.stringify(proposal.skillFileStagedAt ?? null)}); let the skill workshop's next pass stamp it`);
  }

  // The draft as production would load it once approved: the same loader, over a temp tree. Never .claude/skills/,
  // since a file there is a release.
  const draftSkill: InjectableSkill | undefined = (await withTempDir("skill-eval-draft", (dir) => {
    mkdirSync(join(dir, skillFile.name), { recursive: true });
    writeFileSync(join(dir, skillFile.name, "SKILL.md"), skillFile.markdown, "utf8");
    return loadInjectableSkills(dir);
  }))[0];
  if (draftSkill === undefined) {
    return refuse(2, "draft-not-injected", "the draft declares no applies-to the skill loader accepts, so no worker would receive it",
      { task_ids: [] });
  }
  const taskType = draftSkill.appliesTo.find((type) => SKILL_EVAL_ATTEMPTABLE_TASK_TYPES.includes(type)) ?? draftSkill.appliesTo[0]!;

  // ONE pass over the ledger union, every rotation form. An unread source could hide a task's earlier merge, which
  // would date it after the stamp, so a partial read refuses rather than draws.
  const unread: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for await (const row of (input.readLedger ?? readCorpusRows)(input.stateDir(), (path) => unread.push(path))) rows.push(row);
  if (unread.length > 0) return refuse(2, "ledger-unreadable", `unread ledger source(s): ${unread.join(", ")}`);
  const tasks = input.loadPlanTasks();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const specs = new Map<string, CorpusTaskSpec>(tasks.map((task) => [task.id, { type: task.type, verify: task.verify, files: task.files ?? [] }]));
  // LIMIT: merge credit comes from ledger rows alone. That UNDER-credits (a `Remudero-Task:` trailer or a
  // `run-<id>-*` branch is another credit path), so a task it misses is absent from the pool, never wrongly admitted.
  const corpus = deriveGoldenCorpus({ reviewLines: rows, merged: mergeCreditsFromLedger(rows), nowMs: clock.now(), tasks: specs });
  const excludedTaskIds = corpus.items.filter((item) => Date.parse(item.mergedAt) <= stagedAtMs).map((item) => item.taskId);
  const selection = selectHeldOutTasks({ corpus: corpus.items, draft: { markdown: skillFile.markdown, taskType }, excludedTaskIds });
  if (!selection.ok) {
    return refuse(1, selection.reason, selection.detail, { task_ids: selection.taskIds, draft_sha256: selection.draftSha256,
      eligible_count: selection.eligibleCount, excluded_by_stamp: excludedTaskIds.length });
  }

  // The arms. Without: the skills part production renders today for the task (no withholding). With: the part it
  // would render were the draft approved, i.e. the same selection over the approved tree plus the draft.
  const approved = loadInjectableSkills(input.approvedSkillsDir());
  const withDraft = [...approved.filter((skill) => skill.name !== draftSkill.name), draftSkill].sort(byName);
  const parts = new Map<string, { with: string; without: string }>();
  const notInjected: string[] = [];
  for (const item of selection.items) {
    const task = taskById.get(item.taskId)!;
    const withSkill = observeSkillSelection(withDraft, task.type, DEFAULT_KNOWLEDGE_BUDGET_CHARS, task.files);
    if (!withSkill.observation.selected_names.includes(draftSkill.name)) notInjected.push(item.taskId);
    parts.set(item.taskId, { with: renderSkillsPart(withSkill.selected),
      without: renderSkillsPart(observeSkillSelection(approved, task.type, DEFAULT_KNOWLEDGE_BUDGET_CHARS, task.files).selected) });
  }
  if (notInjected.length > 0) {
    return refuse(2, "draft-not-injected", `the draft is not selected into the with-skill prompt of ${notInjected.join(", ")} `
      + "(applies-to, when-paths or the knowledge budget), so both arms would be identical", { task_ids: notInjected,
      draft_sha256: selection.draftSha256 });
  }

  const run = await runSkillEval({
    selection, draftMarkdown: skillFile.markdown, argv, grade: input.grade, stack: input.stack(), idle: await input.readIdle(),
    dispatcherFor: (item) => {
      const part = parts.get(item.taskId)!;
      return input.dispatcherFor(taskById.get(item.taskId)!, item, (request) => (request.arm === "with-skill" ? part.with : part.without));
    },
    // Every row names the proposal as its task; an attempt's held-out task rides beside it.
    log: (step, { task_id: heldOutTaskId, ...fields }) => write(step, { ...fields,
      ...(heldOutTaskId === undefined ? {} : { held_out_task_id: heldOutTaskId }) }),
  });
  if (run.state === "refused") {
    print(`skill-eval: refused ${proposalId}: ${run.reason}: ${run.detail}`);
    return 2;
  }
  const { verdict } = run;
  // inbox.ts declares SkillEvalRecord structurally, never importing skill-eval.ts: the drafter imports inbox.ts.
  const record: SkillEvalRecord = { draftSha256: selection.draftSha256, heldOutSetHash: selection.heldOutSetHash,
    taskIds: selection.items.map((item) => item.taskId), verdict: verdict.verdict, reason: verdict.reason, detail: verdict.detail,
    delta: verdict.delta, measurableTasks: verdict.measurableTasks, totalCostUsd: verdict.totalCostUsd, evaluatedAt: clock.iso() };
  // The workshop can refresh the staged text while the eval runs: record the verdict only on the text it measured.
  const written = updateProposalRegistry(registryPath, (current) => {
    const stored = current.find((p) => p.id === proposalId)?.skillFile?.markdown;
    if (stored === undefined || sha256(stored) !== selection.draftSha256) return null;
    return current.map((p) => (p.id === proposalId ? { ...p, skillEval: record } : p));
  });
  const summary = `${verdict.verdict} (${verdict.reason}): delta ${verdict.delta} over ${verdict.measurableTasks} measurable task(s), `
    + `$${verdict.totalCostUsd.toFixed(2)}`;
  if (written === null) {
    write(SKILL_EVAL_STALE_STEP, { reason: "draft-changed-mid-run", detail: "the staged skill file is no longer the text this run evaluated",
      draft_sha256: selection.draftSha256, held_out_set_hash: selection.heldOutSetHash, verdict: verdict.verdict, verdict_reason: verdict.reason });
    print(`skill-eval: ${proposalId} ${summary}; NOT recorded: the staged text changed during the run`);
    return 1;
  }
  print(`skill-eval: ${proposalId} ${summary}; recorded on the proposal`);
  return verdict.verdict === "pass" ? 0 : 1;
}

/** A revision pin as the one string a stack's `revisions` row records: its revision, or `unavailable:<reason>`. */
function revisionText(pin: BenchmarkStackEvidence["harnessRevision"]): string {
  if (pin === undefined) return "unavailable:not-pinned";
  if ("state" in pin) return `unavailable:${pin.reason}`;
  return ([] as BenchmarkRevisionPin[]).concat(pin).map((entry) => entry.revision).join(",");
}

/**
 * The one stack both arms run on: the mount's model and effort on its provider (Claude when the row names none,
 * so the routing auction cannot put the two arms on different providers), with this process's runtime pins.
 */
export function skillEvalStack(pins: RuntimePins, mount: Pick<Mount, "model" | "effort" | "provider">): SkillEvalRunInput["stack"] {
  const revisions = { harnessRevision: revisionText(pins.harnessRevision), promptRevision: revisionText(pins.revisions.promptRevision),
    toolRevision: revisionText(pins.revisions.toolRevision), scorerRevision: revisionText(pins.revisions.scorerRevision),
    environmentRevision: revisionText(pins.revisions.environmentRevision) };
  const provider = mount.provider ?? "claude";
  const stackHash = sha256(JSON.stringify({ provider, model: mount.model, effort: mount.effort, revisions })).slice(0, 16);
  return { pin: { provider, model: mount.model, effort: mount.effort, billing: provider === "cash" ? "api" : "subscription", stackHash },
    revisions, stackEvidence: { harnessRevision: pins.harnessRevision, ...pins.revisions } };
}

/**
 * The production seams, wired as `benchmarkAaReadinessRuntime` (sealed dispatcher per task on the per-attempt cap,
 * runtime pins from this process) and `benchmarkReviewerReplayCommand`'s `readIdle` (this instance's liveness and
 * measured headroom) wire theirs. run-task.ts hands over what it owns: the checkout, the harness revision it executes
 * (`workerBoundaryStack`) and its usage reader (`readUsageSnapshotPreferSdk`). Config loads on first use, so a refused
 * invocation reads nothing.
 */
export function skillEvalProductionInput(repoRoot: string, harnessRevision: BenchmarkStackEvidence["harnessRevision"],
  readHeadroom: (config: Config) => Promise<UsageSnapshot | undefined>,
  options: { loadConfig?: () => Config; clock?: Clock; workerAbandonMs?: number } = {}): SkillEvalCommandInput {
  let loaded: Config | undefined;
  const config = (): Config => (loaded ??= (options.loadConfig ?? loadConfig)());
  const clock = options.clock ?? systemClock;
  const stateDir = (): string => join(config().root, "state");
  return {
    registryPath: () => join(stateDir(), "inbox-proposals.json"),
    stateDir,
    approvedSkillsDir: () => join(repoRoot, ".claude", "skills"),
    loadPlanTasks: () => loadPlan(join(repoRoot, "plan", "tasks.yaml")).tasks,
    dispatcherFor: (task, item, skillsPartFor) => sealedPairedAttemptDispatcher({ task, config: config(),
      repoDir: join(config().root, "repos", task.repo), baseRef: item.baseSha, maxBudgetUsd: PAIRED_ATTEMPT_MAX_BUDGET_USD,
      clockBoundMs: options.workerAbandonMs ?? loadDefaultPolicy().values.workerAbandon, clock, skillsPartFor }),
    stack: () => skillEvalStack(deriveRuntimePins({ harnessRevision, installRoot: resolveInstallRoot(config()) }),
      resolveMount(loadMounts(mountsPath(repoRoot)), SKILL_EVAL_MOUNT_ROUTE.taskType, SKILL_EVAL_MOUNT_ROUTE.risk)),
    readIdle: async () => {
      const instance = { name: "operator-skill-eval", repo: "operator/skill-eval", stateDir: stateDir() };
      const nowMs = clock.now();
      return { liveness: judgeInstanceLiveness(instance, readLivenessRows(instance, nowMs - LIVENESS_WINDOW_MS), nowMs),
        headroom: await readHeadroom(config()) };
    },
    log: (row) => appendLedger(ledgerPathFor(config()), row, { clock }),
    clock,
  };
}
