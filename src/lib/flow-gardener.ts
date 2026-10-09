/**
 * W1-T5904 — THE FLOW GARDENER FILES A STAGE THAT SLOWS DOWN.
 *
 * Once a UTC day it measures every PR merged in the last 24 h, per class (plan / code / gardener) and per
 * stage, from rows the fleet already writes plus GitHub's CI run timings, and compares each stage's p50
 * with the 7 days before. Stages: open->merged, CI wall clock, review-queue wait (sweep.review_eligible ->
 * sweep.review_admitted, split by `surface`), ready->merged (the later of the last green review and CI
 * green, to the merge; split by `arm_surface`, light|absent=full since W1-T5922), pushes, branch updates
 * and fix rounds per PR. It writes one `flow.report` row and a markdown summary, and files ONE plan task
 * per regressed stage through the gardeners' machine-filing path, never a second while one is open.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { fixedClock, systemClock, type Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import type { GardenerDeps } from "./gardener.js";
import { ghJsonAsync } from "./github-transport.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardLandingGuard, renderMachineShard } from "./machine-filing.js";
import { loadPlan } from "./plan.js";
import { resolveRepoLayout } from "./repo-layout.js";

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

export const FLOW_REPORT_STEP = "flow.report";
export const FLOW_REGRESSION_FILED_STEP = "flow.regression_filed";
export const FLOW_REGRESSION_OPEN_STEP = "flow.regression_open";
export const FLOW_FILING_DEFERRED_STEP = "flow.filing_deferred";
export const FLOW_FILING_FAILED_STEP = "flow.filing_failed";
export const FLOW_INPUT_UNREADABLE_STEP = "flow.input_unreadable";
export const FLOW_GARDENER_FAILED_STEP = "flow.gardener_failed";
export const FLOW_STATE_FILE = "flow-gardener.json";
export const FLOW_REPORT_FILE = "flow-report.md";

export type FlowClass = "plan" | "code" | "gardener";
export const FLOW_STAGES = ["time_to_merge", "ci_wall_clock", "review_queue_wait", "ready_to_merged", "pushes", "branch_updates", "fix_rounds"] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];
const COUNT_STAGES: ReadonlySet<FlowStage> = new Set(["pushes", "branch_updates", "fix_rounds"]);

/** A stage regresses when its 24 h p50 reaches this multiple of its baseline p50. BACKSTOP: the design's
 *  stated factor; the operator's 2026-10-05 day was ~2x a healthy one (code p90 109-120 min vs p50 38). */
export const FLOW_REGRESSION_FACTOR = 2;
/** ...and moves by at least this much, so a 1 -> 2 minute wait or a 0 -> 0 count is not a regression. */
const FLOW_MIN_DELTA: Readonly<Record<"minutes" | "count", number>> = { minutes: 5, count: 1 };
/** BACKSTOP: follow-ups filed per UTC day; each stage is filed once while open, so this binds only when
 *  several stages regress together (one cause, usually) and the queue would otherwise take them all. */
export const FLOW_FILINGS_PER_DAY_MAX = 2;
/** BACKSTOP: GitHub CI reads per pass; results are cached per PR, and 80-120 PRs merged a day on 10-04..05. */
export const FLOW_GH_READS_PER_PASS_MAX = 200;
const FLOW_MIN_CURRENT_SAMPLES = 3;
const FLOW_MIN_BASELINE_SAMPLES = 5;
/** A filing not yet in the plan (its PR is still open) counts as an open follow-up this long. */
const FLOW_UNPLANNED_FILING_OPEN_MS = 7 * DAY_MS;
const FLOW_BASELINE_DAYS = 7;
const FLOW_READ_DAYS = FLOW_BASELINE_DAYS + 2;

/** Measured by hand 2026-10-04..05 (W1-T5904's note), used until 7 days of rolling history exist. */
export const FLOW_SEED_BASELINES: Readonly<Record<string, { p50: number; p90?: number }>> = {
  "code:time_to_merge:all": { p50: 38, p90: 120 },
  "plan:time_to_merge:all": { p50: 29 },
  "code:ci_wall_clock:all": { p50: 22 },
  "code:review_queue_wait:light": { p50: 45 },
};
const SEED_SOURCE = "seed-2026-10-05";

/** The files a regressed stage's follow-up starts from. */
const STAGE_OWNER: Readonly<Record<FlowStage, string>> = {
  time_to_merge: "src/lib/sweep.ts",
  ci_wall_clock: ".github/workflows/ci.yml",
  review_queue_wait: "src/lib/sweep.ts",
  ready_to_merged: "src/lib/sweep.ts",
  pushes: "src/lib/sweep.ts",
  branch_updates: "src/lib/sweep.ts",
  fix_rounds: "src/lib/sweep.ts",
};

const READ_STEPS = [
  "pr.opened", "pr.terminal", "sweep.review_eligible", "sweep.review_admitted", "review.posted",
  "automerge.armed", "sweep.update_branch.updated", "fix.dispatch", "review.plan_only_reviewed",
];
/** Raw-line prefilter: the stage rows, a disposition that carries `arm_surface`, a gardener's filing row. */
const FLOW_LINE = new RegExp(
  `"step":"(?:${READ_STEPS.map((s) => s.replaceAll(".", "\\.")).join("|")})"|"arm_surface"|"run_id":"GARDEN-[^"]*".*"(?:pr_url|filing_pr)":"https:`,
);

type Row = Record<string, unknown>;

export interface FlowLedgerRead {
  ok: boolean;
  rows: Row[];
  unread: string[];
}

/** The ledger union since `sinceIso`, narrowed to the rows a flow pass reads. */
export function readFlowLedger(stateDir: string, sinceIso: string): FlowLedgerRead {
  const read = readLedgerUnionRecordsSync(stateDir, { since: sinceIso, pattern: FLOW_LINE, refuseIncomplete: true });
  return { ok: read.ok, rows: read.rows, unread: read.unread };
}

export interface FlowCiReading {
  minutes: number;
  doneMs: number;
}

/** CI wall clock of the newest green `ci.yml` run at a head, or `undefined` when none completed green. */
export function flowCiReader(
  owner: string, repo: string, readJson: (args: string[]) => Promise<unknown> = ghJsonAsync,
): (headSha: string) => Promise<FlowCiReading | undefined> {
  return async (headSha) => {
    const body = await readJson(["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=20`,
      "--jq", "{workflow_runs: [.workflow_runs[] | {status, conclusion, run_started_at, updated_at}]}"]) as
      { workflow_runs?: Array<{ status?: string; conclusion?: string | null; run_started_at?: string; updated_at?: string }> } | null;
    if (!body || !Array.isArray(body.workflow_runs)) throw new Error(`flow: GitHub returned no CI runs for ${headSha}`);
    const green = body.workflow_runs
      .filter((r) => r.status === "completed" && r.conclusion === "success")
      .map((r) => ({ startMs: Date.parse(r.run_started_at ?? ""), doneMs: Date.parse(r.updated_at ?? "") }))
      .filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.doneMs))
      .sort((a, b) => b.startMs - a.startMs);
    const run = green[0];
    return run === undefined ? undefined : { minutes: (run.doneMs - run.startMs) / MIN_MS, doneMs: run.doneMs };
  };
}

type FlowPlanTask = { id: string; origin?: string; status?: string; retirement?: string };

export interface FlowGardenSources {
  readLedger?: (sinceIso: string) => FlowLedgerRead;
  readCi?: (headSha: string) => Promise<FlowCiReading | undefined>;
  planTasks?: () => FlowPlanTask[];
  mintTaskId: (filingBranch: string) => string;
}

interface FlowPr {
  number: number;
  cls: FlowClass;
  taskId?: string;
  openedMs?: number;
  mergedMs: number;
  headSha?: string;
  heads: number;
  updates: number;
  fixRounds: number;
  reviewWait: Map<string, number>;
  reviewedMs?: number;
  armedMs?: number;
  armSurface: "light" | "full";
}

const tsOf = (row: Row): number => (typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN);

function prNumberOf(row: Row): number | undefined {
  if (typeof row.pr_number === "number") return row.pr_number;
  for (const field of ["pr_url", "filing_pr"]) {
    const m = typeof row[field] === "string" ? /\/pull\/(\d+)$/.exec(row[field] as string) : null;
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Every merged PR the rows describe, with what each stage needs. */
export function flowPrs(rows: readonly Row[]): FlowPr[] {
  const byPr = new Map<number, Row[]>();
  const fixesByTask = new Map<string, number[]>();
  for (const row of [...rows].sort((a, b) => tsOf(a) - tsOf(b))) {
    if (row.step === "fix.dispatch" && typeof row.task_id === "string") fixesByTask.set(row.task_id, [...(fixesByTask.get(row.task_id) ?? []), tsOf(row)]);
    const n = prNumberOf(row);
    if (n !== undefined) byPr.set(n, [...(byPr.get(n) ?? []), row]);
  }
  const prs: FlowPr[] = [];
  for (const [number, list] of byPr) {
    // GitHub's own merged_at. A backfilled terminal row (no merged_at) and a `verdict.merged` credit
    // backfill are stamped when written, days late on 2026-10-05, so neither dates a merge.
    const terminal = list.find((r) => r.step === "pr.terminal" && r.state === "merged" && typeof r.merged_at === "string");
    const mergedMs = terminal ? Date.parse(terminal.merged_at as string) : Number.NaN;
    if (!Number.isFinite(mergedMs)) continue;
    const opened = list.find((r) => r.step === "pr.opened");
    const gardener = list.some((r) => typeof r.run_id === "string" && r.run_id.startsWith("GARDEN-"));
    const plan = list.some((r) => r.plan_only === true || r.step === "review.plan_only_reviewed");
    const openedMs = opened ? tsOf(opened) : gardener ? tsOf(list[0]!) : undefined;
    const heads = list.filter((r) => typeof r.head_sha === "string" && tsOf(r) <= mergedMs).map((r) => r.head_sha as string);
    const taskId = typeof opened?.task_id === "string" ? opened.task_id : undefined;
    const reviewWait = new Map<string, number>();
    for (const eligible of list.filter((r) => r.step === "sweep.review_eligible" && typeof r.review_key === "string")) {
      const admitted = list.find((r) => r.step === "sweep.review_admitted" && r.review_key === eligible.review_key && tsOf(r) >= tsOf(eligible));
      if (!admitted) continue;
      const surface = String(admitted.surface ?? eligible.surface ?? "full");
      reviewWait.set(surface, (reviewWait.get(surface) ?? 0) + (tsOf(admitted) - tsOf(eligible)) / MIN_MS);
    }
    const reviewed = list.filter((r) => r.step === "review.posted" && r.state === "success" && tsOf(r) <= mergedMs).at(-1);
    const armed = list.find((r) => r.step === "automerge.armed");
    prs.push({
      number,
      cls: gardener ? "gardener" : plan ? "plan" : "code",
      ...(taskId === undefined ? {} : { taskId }),
      ...(openedMs === undefined ? {} : { openedMs }),
      mergedMs,
      ...(heads.length === 0 ? {} : { headSha: heads.at(-1)! }),
      heads: new Set(heads).size,
      updates: list.filter((r) => r.step === "sweep.update_branch.updated").length,
      fixRounds: taskId === undefined || openedMs === undefined ? 0
        : (fixesByTask.get(taskId) ?? []).filter((ms) => ms >= openedMs && ms <= mergedMs).length,
      reviewWait,
      ...(reviewed ? { reviewedMs: tsOf(reviewed) } : {}),
      ...(armed ? { armedMs: tsOf(armed) } : {}),
      armSurface: list.some((r) => r.arm_surface === "light") ? "light" : "full",
    });
  }
  return prs;
}

export interface FlowSample {
  key: string;
  pr: number;
  mergedMs: number;
  value: number;
}

/** One sample per PR per stage (per surface where the stage splits); a stage with no reading has none. */
export function flowSamples(prs: readonly FlowPr[], ci: (pr: FlowPr) => FlowCiReading | undefined): FlowSample[] {
  const out: FlowSample[] = [];
  for (const pr of prs) {
    const add = (stage: FlowStage, surface: string, value: number) =>
      out.push({ key: `${pr.cls}:${stage}:${surface}`, pr: pr.number, mergedMs: pr.mergedMs, value: Math.round(value * 10) / 10 });
    const reading = ci(pr);
    if (pr.openedMs !== undefined) add("time_to_merge", "all", (pr.mergedMs - pr.openedMs) / MIN_MS);
    if (reading) add("ci_wall_clock", "all", reading.minutes);
    for (const [surface, wait] of pr.reviewWait) add("review_queue_wait", surface, wait);
    const greenMs = [pr.reviewedMs, reading?.doneMs].filter((ms): ms is number => ms !== undefined && ms <= pr.mergedMs);
    const readyMs = greenMs.length > 0 ? Math.max(...greenMs) : pr.armedMs;
    if (readyMs !== undefined) add("ready_to_merged", pr.armSurface, Math.max(0, pr.mergedMs - readyMs) / MIN_MS);
    if (pr.heads > 0) add("pushes", "all", pr.heads);
    add("branch_updates", "all", pr.updates);
    add("fix_rounds", "all", pr.fixRounds);
  }
  return out;
}

/** Nearest-rank percentile. */
function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

interface Spread { n: number; p50: number; p90: number }
const spread = (values: readonly number[]): Spread | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
};

export interface FlowStageStat {
  key: string;
  cls: FlowClass;
  stage: FlowStage;
  surface: string;
  unit: "minutes" | "count";
  current?: Spread;
  baseline?: { n?: number; p50: number; p90?: number; source: string };
  regressed: boolean;
  /** The current window's slowest PRs, slowest first. */
  slowest: Array<{ pr: number; value: number }>;
}

/** Each stage's last-24 h spread against its 7-day baseline (or the measured seed). */
export function flowStageStats(samples: readonly FlowSample[], nowMs: number): FlowStageStat[] {
  const currentFrom = nowMs - DAY_MS;
  const baselineFrom = currentFrom - FLOW_BASELINE_DAYS * DAY_MS;
  const keys = [...new Set(samples.map((s) => s.key))].sort();
  return keys.map((key) => {
    const [cls, stage, surface] = key.split(":") as [FlowClass, FlowStage, string];
    const unit = COUNT_STAGES.has(stage) ? "count" : "minutes";
    const mine = samples.filter((s) => s.key === key);
    const now = mine.filter((s) => s.mergedMs > currentFrom && s.mergedMs <= nowMs);
    const before = spread(mine.filter((s) => s.mergedMs > baselineFrom && s.mergedMs <= currentFrom).map((s) => s.value));
    const seed = FLOW_SEED_BASELINES[key];
    const baseline = before && before.n >= FLOW_MIN_BASELINE_SAMPLES ? { ...before, source: "rolling" }
      : seed ? { ...seed, source: SEED_SOURCE } : undefined;
    const current = spread(now.map((s) => s.value));
    // The comparison that files: a p50 at the stated multiple of its baseline, by a material amount.
    const regressed = current !== undefined && baseline !== undefined && current.n >= FLOW_MIN_CURRENT_SAMPLES &&
      current.p50 >= baseline.p50 * FLOW_REGRESSION_FACTOR && current.p50 - baseline.p50 >= FLOW_MIN_DELTA[unit];
    const slowest = [...now].sort((a, b) => b.value - a.value || b.pr - a.pr).slice(0, 3).map((s) => ({ pr: s.pr, value: s.value }));
    return { key, cls, stage, surface, unit, ...(current ? { current } : {}), ...(baseline ? { baseline } : {}), regressed, slowest };
  });
}

const unitLabel = (stat: FlowStageStat) => (stat.unit === "minutes" ? "min" : "per PR");
const origin = (key: string) => `flow-regression:${key}`;

/** The follow-up record for one regressed stage, rendered and linted by the shared machine-filing path. */
export function renderFlowFollowUp(stat: FlowStageStat, taskId: string, population: readonly number[]): { text: string; refused?: string } {
  const testPath = `test/the-${stat.cls}-${stat.stage.replaceAll("_", "-")}-flow-stage-recovers.test.ts`;
  const surface = stat.surface === "all" ? "" : ` on the ${stat.surface} surface`;
  const u = unitLabel(stat);
  const numbers = `p50 ${stat.current!.p50} ${u} against a ${stat.baseline!.p50} ${u} baseline`;
  const slowest = stat.slowest.map((s) => `#${s.pr} (${s.value} ${u})`).join(", ");
  return renderMachineShard({
    taskId,
    title: `THE ${stat.cls.toUpperCase()} PR ${stat.stage} STAGE SLOWED${surface.toUpperCase()} — ${numbers} over the last 24 h`,
    origin: origin(stat.key),
    files: [STAGE_OWNER[stat.stage], testPath],
    cost: stat.current!.p50 - stat.baseline!.p50,
    costPopulation: population,
    acceptance: [{
      claim: `the ${stat.cls} ${stat.stage} stage${surface} returns under ${FLOW_REGRESSION_FACTOR}x its baseline p50`,
      proof: `grep: test("the ${stat.cls} ${stat.stage} stage recovers" in ${testPath}`,
    }],
    note: `Filed by the flow gardener (W1-T5904). MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person. The gardener does not re-file this stage while this task is open.`,
    rationale: [
      `${stat.cls} PRs, stage ${stat.stage}${surface}: ${numbers} (${stat.baseline!.source}).`,
      `Last 24 h: n ${stat.current!.n}, p50 ${stat.current!.p50}, p90 ${stat.current!.p90} ${u}.`,
      `Slowest PRs: ${slowest}.`,
      "Find what these PRs share at this stage before changing a bound.",
    ],
  });
}

interface FlowState {
  lastReportDay?: string;
  ci?: Record<string, { headSha: string; mergedMs: number; reading: FlowCiReading | null }>;
  filed?: Record<string, { taskId: string; atMs: number }>;
  filings?: Array<{ day: string; key: string }>;
}

function readState(stateDir: string): FlowState {
  const raw = readFileIfExists(join(stateDir, FLOW_STATE_FILE));
  return raw === undefined ? {} : JSON.parse(raw) as FlowState;
}

/** Whether today's pass has yet to report; an unreadable state file is due (the pass names it). */
export function flowPassDue(stateDir: string, clock: Clock = systemClock): boolean {
  try {
    return readState(stateDir).lastReportDay !== clock.iso().slice(0, 10);
  } catch (e) {
    void e; // the pass itself reads the state again and ledgers it as flow.input_unreadable
    return true;
  }
}

function renderMarkdown(day: string, stats: readonly FlowStageStat[]): string {
  const cell = (v: number | undefined) => (v === undefined ? "-" : String(v));
  return [
    `# Flow report ${day}`,
    "",
    "| class | stage | surface | n | p50 | p90 | base p50 | base p90 | baseline | verdict |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...stats.map((s) => `| ${s.cls} | ${s.stage} | ${s.surface} | ${cell(s.current?.n)} | ${cell(s.current?.p50)} | ${cell(s.current?.p90)} | ` +
      `${cell(s.baseline?.p50)} | ${cell(s.baseline?.p90)} | ${s.baseline?.source ?? "none"} | ${s.regressed ? "REGRESSED" : "ok"} |`),
    "",
  ].join("\n");
}

export interface FlowPassResult {
  ran: boolean;
  stats: FlowStageStat[];
  filed: string[];
}

/** One daily pass: measure, report, and file each regressed stage that has no open follow-up. */
export async function runFlowGardener(
  deps: GardenerDeps, sources: FlowGardenSources, opts: { ghReadsPerPass?: number } = {},
): Promise<FlowPassResult> {
  const clock = deps.clock ?? systemClock;
  const nowMs = clock.now();
  const day = clock.iso().slice(0, 10);
  const unreadable = (input: string, extra: Record<string, unknown>) => deps.log(FLOW_INPUT_UNREADABLE_STEP, { input, ...extra });
  let state: FlowState = {};
  try {
    state = readState(deps.stateDir);
  } catch (e) {
    unreadable("state", { error: String((e as Error)?.message ?? e) });
  }
  if (state.lastReportDay === day) return { ran: false, stats: [], filed: [] };
  const sinceIso = fixedClock(nowMs - FLOW_READ_DAYS * DAY_MS).iso();
  const ledger = (sources.readLedger ?? ((iso) => readFlowLedger(deps.stateDir, iso)))(sinceIso);
  if (!ledger.ok) {
    unreadable("ledger", { unread: ledger.unread });
    return { ran: false, stats: [], filed: [] };
  }
  const prs = flowPrs(ledger.rows).filter((pr) => pr.mergedMs > nowMs - (FLOW_BASELINE_DAYS + 1) * DAY_MS && pr.mergedMs <= nowMs);

  // CI wall clock from GitHub: newest merges first, each PR read once and cached by its merged head.
  const cache = { ...(state.ci ?? {}) };
  const readCi = sources.readCi ?? (() => Promise.resolve(undefined));
  const budget = Math.min(opts.ghReadsPerPass ?? FLOW_GH_READS_PER_PASS_MAX, FLOW_GH_READS_PER_PASS_MAX);
  let read = 0;
  let skipped = 0;
  const errors: Array<{ pr: number; error: string }> = [];
  for (const pr of [...prs].sort((a, b) => b.mergedMs - a.mergedMs || a.number - b.number)) {
    if (pr.headSha === undefined || cache[pr.number]?.headSha === pr.headSha) continue;
    if (read >= budget) {
      skipped++;
      continue;
    }
    read++;
    try {
      cache[pr.number] = { headSha: pr.headSha, mergedMs: pr.mergedMs, reading: (await readCi(pr.headSha)) ?? null };
    } catch (e) {
      errors.push({ pr: pr.number, error: String((e as Error)?.message ?? e) });
    }
  }
  if (errors.length > 0) unreadable("github", { count: errors.length, first_error: errors[0]!.error, prs: errors.slice(0, 10).map((e) => e.pr) });
  for (const [n, entry] of Object.entries(cache)) if (entry.mergedMs <= nowMs - FLOW_READ_DAYS * DAY_MS) delete cache[n];

  const stats = flowStageStats(flowSamples(prs, (pr) => cache[pr.number]?.reading ?? undefined), nowMs);
  const regressed = stats.filter((s) => s.regressed).sort((a, b) =>
    (b.current!.p50 / Math.max(b.baseline!.p50, 1)) - (a.current!.p50 / Math.max(a.baseline!.p50, 1)) || a.key.localeCompare(b.key));
  const inWindow = (from: number, to: number) => prs.filter((pr) => pr.mergedMs > from && pr.mergedMs <= to).length;
  writeAtomic(join(deps.stateDir, FLOW_REPORT_FILE), renderMarkdown(day, stats));
  deps.log(FLOW_REPORT_STEP, {
    day,
    prs_current: inWindow(nowMs - DAY_MS, nowMs),
    prs_baseline: inWindow(nowMs - (FLOW_BASELINE_DAYS + 1) * DAY_MS, nowMs - DAY_MS),
    stages: stats,
    regressions: regressed.map((s) => s.key),
    ci_read: read,
    ci_unread: errors.length,
    ci_skipped: skipped,
  });

  const filed = await fileRegressions(deps, sources, state, regressed, { nowMs, day });
  const next: FlowState = { ...state, ci: cache, ...(filed.decided ? { lastReportDay: day } : {}) };
  mkdirSync(deps.stateDir, { recursive: true });
  writeAtomic(join(deps.stateDir, FLOW_STATE_FILE), JSON.stringify(next) + "\n");
  return { ran: true, stats, filed: filed.keys };
}

/** File each regressed stage once while open, at most {@link FLOW_FILINGS_PER_DAY_MAX} a day; updates `state`. */
async function fileRegressions(
  deps: GardenerDeps, sources: FlowGardenSources, state: FlowState, regressed: readonly FlowStageStat[], at: { nowMs: number; day: string },
): Promise<{ decided: boolean; keys: string[] }> {
  if (regressed.length === 0) return { decided: true, keys: [] };
  let tasks: FlowPlanTask[];
  try {
    tasks = (sources.planTasks ?? (() => loadPlan(resolveRepoLayout(deps.repoRoot).planMonolith).tasks))();
  } catch (e) {
    deps.log(FLOW_INPUT_UNREADABLE_STEP, { input: "plan", error: String((e as Error)?.message ?? e) });
    return { decided: false, keys: [] };
  }
  const closed = (t: FlowPlanTask) => t.status === "merged" || t.status === "done" || t.retirement !== undefined;
  const filed = { ...(state.filed ?? {}) };
  const filings = [...(state.filings ?? [])].slice(-30);
  const keys: string[] = [];
  const population = regressed.map((s) => s.current!.p50 - s.baseline!.p50);
  for (const stat of regressed) {
    const planned = tasks.find((t) => t.origin === origin(stat.key) && !closed(t));
    const mine = filed[stat.key];
    const mineInPlan = mine ? tasks.find((t) => t.id === mine.taskId) : undefined;
    const openId = planned?.id ?? (mine && (mineInPlan ? !closed(mineInPlan) : at.nowMs - mine.atMs < FLOW_UNPLANNED_FILING_OPEN_MS) ? mine.taskId : undefined);
    if (openId !== undefined) {
      deps.log(FLOW_REGRESSION_OPEN_STEP, { key: stat.key, task_id: openId });
      continue;
    }
    if (filings.filter((f) => f.day === at.day).length >= FLOW_FILINGS_PER_DAY_MAX) {
      deps.log(FLOW_FILING_DEFERRED_STEP, { key: stat.key, bound: FLOW_FILINGS_PER_DAY_MAX });
      continue;
    }
    try {
      const landed = await landFollowUp(deps, sources.mintTaskId, stat, population);
      filed[stat.key] = { taskId: landed.taskId, atMs: at.nowMs };
      filings.push({ day: at.day, key: stat.key });
      keys.push(stat.key);
      deps.log(FLOW_REGRESSION_FILED_STEP, { key: stat.key, task_id: landed.taskId, filing_pr: landed.prUrl, slowest: stat.slowest.map((s) => s.pr) });
    } catch (e) {
      deps.log(FLOW_FILING_FAILED_STEP, { key: stat.key, error: String((e as Error)?.message ?? e) });
    }
  }
  state.filed = filed;
  state.filings = filings;
  return { decided: true, keys };
}

async function landFollowUp(
  deps: GardenerDeps, mintTaskId: (branch: string) => string, stat: FlowStageStat, population: readonly number[],
): Promise<{ taskId: string; prUrl: string }> {
  const workspace = await deps.openWorkspace();
  try {
    if (!workspace.branch) throw new Error("flow: filing workspace has no branch for task-id reservation");
    const taskId = mintTaskId(workspace.branch);
    const rendered = renderFlowFollowUp(stat, taskId, population);
    if (rendered.refused) throw new Error(`flow: follow-up record refused by lint (${rendered.refused})`);
    const relativePath = join("plan", "tasks.d", `${taskId}-flow-${stat.key.replaceAll(":", "-").replaceAll("_", "-")}.yaml`);
    mkdirSync(join(workspace.root, "plan", "tasks.d"), { recursive: true });
    writeAtomic(join(workspace.root, relativePath), rendered.text);
    const refused = machineShardLandingGuard(deps)(workspace.root, [relativePath]);
    if (refused !== undefined) throw new Error(`flow: follow-up record failed lint-plan's machine-filing admission: ${refused}`);
    const prUrl = await workspace.land({
      paths: [relativePath],
      title: `chore(plan): file the ${stat.cls} ${stat.stage} flow regression`,
      body: `The W1-T5904 flow gardener measured ${stat.key}: p50 ${stat.current!.p50} against a ${stat.baseline!.p50} baseline ` +
        `(${stat.baseline!.source}). Slowest: ${stat.slowest.map((s) => `#${s.pr}`).join(", ")}.\n\n` +
        `## Acceptance\n\n- claim: the flow regression is recorded as a parked task\n  proof: grep: ${origin(stat.key)} in ${relativePath}`,
    });
    if (!prUrl) throw new Error("flow: follow-up PR was not opened");
    return { taskId, prUrl };
  } finally {
    await workspace.dispose();
  }
}
