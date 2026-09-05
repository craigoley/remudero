/** `rmd retro` — the deterministic gather (no LLM) that feeds the Architect retro. It reduces the
 *  ledger and LEARNINGS into a structured gather a higher-tier Architect worker then synthesises
 *  into a plan-only PR: generation deterministic here, publication with the gate and the human. */

import { execFileSync } from "node:child_process";
// Import the DEFAULT export so a test's `t.mock.method` can intercept the marker's reads and
// writes: named `node:fs` bindings are non-configurable and mocking one throws (W1-T207).
import fsMarker from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { updateProposalRegistry, type EvidenceAnchor, type Proposal, type UpdateProposalRegistryOpts } from "./inbox.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD } from "./learnings.js";
import type { Lifecycle, LearningEntry, PromotionResult } from "./learnings.js";
import { resolveMountForClass, type Mounts } from "./mounts.js";
import {
  scanPlanCoherence,
  type PlanCoherenceFinding,
  type PlanCoherenceShardEntry,
} from "./plan-coherence.js";
import type { Task } from "./plan.js";
import { findExportDefinition, isExportReachable } from "./reachability.js";
import { REPLAY_RESULT_STEP } from "./replay.js";
import { utcWeekWindowMs } from "./sweep.js";
import { DEFAULT_TASK_CLASS } from "./task-class.js";
import { lintTask, type LintOpts, type LintViolation } from "./task-linter.js";
import type { QuestionEntry } from "./worker.js";

/** One parsed ledger line (superset of ledger.ts LedgerLine, as read back). */
export interface LedgerRecord {
  ts?: string;
  run_id?: string;
  task_id?: string;
  step?: string;
  [k: string]: unknown;
}

/** Parse an NDJSON ledger, skipping malformed lines (best-effort, deterministic). */
export function parseLedger(ndjson: string): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LedgerRecord);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** The reduced summary of ONE run (all lines sharing a run_id). */
export interface RunSummary {
  runId: string;
  taskId: string;
  type: string;
  startTs: string;
  verdict: string;
  costUsd: number;
  numTurns: number;
  prUrl?: string;
  /** The ledger-claimed PR url a `correction.provenance` line overrode; `prUrl` above is always
   *  the truth. Why: the false-attribution class (W1-T51/P9-b), docs/forensics/retro.md. */
  correctedFromPrUrl?: string;
  /** The task's risk band at `run.start`, if logged (§9 mount axis). {@link mineOverrunClasses}
   *  groups overruns by (type, risk) — the axis mounts.yaml routes on — rather than by type. */
  risk?: string;
  /** The task's routing CLASS at `run.start`, if logged (W1-T167) — the third mount-routing axis.
   *  {@link aggregateByClass} groups on it to judge whether the cheaper mounts still merge. */
  taskClass?: string;
  /** The worker-error `subtype` off the terminal `verdict` line; a clean or non-error one has none. */
  subtype?: string;
  /** The terminal `verdict` line's prose `reason`, when logged — the fallback input for
   *  {@link resolveGuardCheck} on a line predating the structured fields below (W1-T91/P23). */
  reason?: string;
  /** The guard class (`isolation`, `containment`, ...) off the terminal `verdict` line, when a
   *  guard block wrote it structurally. {@link resolveGuardCheck} tolerates its absence. */
  guard?: string;
  /** The specific probe the guard ran (`inherited-functions`, ...), alongside `guard` above. */
  check?: string;
  /** What the probe OBSERVED: proven-holding, proven-broken or UNPROVEN, never a boolean. */
  observed?: string;
  /** Summed `TokenUsage.output` over every DONE_STEPS line. Optional only so a pre-W1-T930 fixture
   *  compiles; every reader treats an absent value as 0, never as unknown. */
  outputTokens?: number;
}

const DONE_STEPS = new Set(["recon.done", "implement.done", "implement.resumed"]);

/** The `correction.provenance` line for this run, if any — a first-class ledger EVENT (P9-iv):
 *  the operator wrote the truth over a false claim, so every reducer honours it. Last one wins. */
function correctionFor(lines: LedgerRecord[]): string | undefined {
  let url: string | undefined;
  for (const l of lines) {
    if (l.step === "correction.provenance" && typeof l.actual_pr_url === "string") url = l.actual_pr_url;
  }
  return url;
}

/** `l.tokens.output` off one ledger line. Returns 0, never a thrown TypeError, for any shape that
 *  is not the real `TokenUsage` — hand-built fixtures and pre-token-ledgering lines included. */
function outputTokensOf(l: LedgerRecord): number {
  const t = l.tokens;
  if (t && typeof t === "object" && "output" in t) {
    const v = (t as { output?: unknown }).output;
    if (typeof v === "number") return v;
  }
  return 0;
}

/** Reduce ledger lines into per-run summaries, keyed by run_id (deterministic). */
export function gatherRuns(records: LedgerRecord[]): RunSummary[] {
  const byRun = new Map<string, LedgerRecord[]>();
  for (const r of records) {
    if (!r.run_id) continue;
    const arr = byRun.get(r.run_id) ?? [];
    arr.push(r);
    byRun.set(r.run_id, arr);
  }
  const runs: RunSummary[] = [];
  for (const [runId, lines] of byRun) {
    const start = lines.find((l) => l.step === "run.start");
    if (!start) continue; // a run with no start is a torn fragment — skip
    const verdictLine = lines.find((l) => l.step === "verdict");
    const numTurns = lines
      .filter((l) => l.step && DONE_STEPS.has(l.step))
      .reduce((s, l) => s + (typeof l.num_turns === "number" ? l.num_turns : 0), 0);
    // Same DONE_STEPS scope as numTurns above: recon and implement (plus its resume) are the
    // worker calls that spend this run's own output tokens. A reviewer call ledgers its own run_id.
    const outputTokens = lines
      .filter((l) => l.step && DONE_STEPS.has(l.step))
      .reduce((s, l) => s + outputTokensOf(l), 0);
    const costLine = verdictLine ?? lines.find((l) => typeof l.cost_usd === "number");
    const prLine =
      lines.find((l) => l.step === "pr.opened") ?? verdictLine ?? lines.find((l) => l.pr_url);
    const claimedPrUrl = typeof prLine?.pr_url === "string" ? prLine.pr_url : undefined;
    const correctedUrl = correctionFor(lines);
    runs.push({
      runId,
      taskId: String(start.task_id ?? ""),
      type: String(start.type ?? "unknown"),
      startTs: String(start.ts ?? ""),
      verdict: String(verdictLine?.verdict ?? "incomplete"),
      costUsd: typeof costLine?.cost_usd === "number" ? costLine.cost_usd : 0,
      numTurns,
      outputTokens,
      prUrl: correctedUrl ?? claimedPrUrl,
      ...(correctedUrl !== undefined ? { correctedFromPrUrl: claimedPrUrl } : {}),
      ...(typeof start.risk === "string" ? { risk: start.risk } : {}),
      ...(typeof start.task_class === "string" ? { taskClass: start.task_class } : {}),
      ...(typeof verdictLine?.subtype === "string" ? { subtype: verdictLine.subtype } : {}),
      ...(typeof verdictLine?.reason === "string" ? { reason: verdictLine.reason } : {}),
      // The structured guard-cause fields, when the verdict line carried them (W1-T91/P23).
      ...(typeof verdictLine?.guard === "string" ? { guard: verdictLine.guard } : {}),
      ...(typeof verdictLine?.check === "string" ? { check: verdictLine.check } : {}),
      ...(typeof verdictLine?.observed === "string" ? { observed: verdictLine.observed } : {}),
    });
  }
  // Deterministic order: by start timestamp then run id.
  runs.sort((a, b) => (a.startTs < b.startTs ? -1 : a.startTs > b.startTs ? 1 : a.runId < b.runId ? -1 : 1));
  return runs;
}

/** Calibration aggregate for one task type — the numbers mounts.yaml (W1-T5) needs. */
export interface TypeCalibration {
  type: string;
  runs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgTurns: number;
  merged: number;
}

/** Aggregate runs BY TASK TYPE (the calibration table). Deterministic, ordered. */
export function aggregateByType(runs: RunSummary[]): TypeCalibration[] {
  const byType = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const arr = byType.get(r.type) ?? [];
    arr.push(r);
    byType.set(r.type, arr);
  }
  const out: TypeCalibration[] = [];
  for (const [type, rs] of byType) {
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    const totalTurns = rs.reduce((s, r) => s + r.numTurns, 0);
    out.push({
      type,
      runs: rs.length,
      totalCostUsd: round(totalCost),
      avgCostUsd: round(totalCost / rs.length),
      avgTurns: round(totalTurns / rs.length),
      merged: rs.filter((r) => r.verdict === "merged").length,
    });
  }
  out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return out;
}

/** Below this fraction of a class's runs reporting a nonzero `numTurns`, the per-merge denominator
 *  is too thin to trust. Exported so a test pins the boundary. Why: docs/forensics/retro.md. */
export const MIN_TURN_COVERAGE_FOR_PER_MERGE = 0.5;

/** Calibration for one task CLASS (W1-T167) on the routing table's third axis, plus `mergeRate`.
 *  The per-MERGE fields (W1-T930) sit beside the per-run ones: turns per RUN are gameable, because
 *  a refused run is short, and turns per MERGE are not. Why: docs/forensics/retro.md. */
export interface ClassCalibration {
  taskClass: string;
  runs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgTurns: number;
  merged: number;
  mergeRate: number;
  /** Total `TokenUsage.output` for this class — the dominant spend term, uncolumned before W1-T930. */
  totalOutputTokens: number;
  /** Fraction of this class's runs with a nonzero logged `numTurns`, so a thin numerator never
   *  reads as a solid one; below {@link MIN_TURN_COVERAGE_FOR_PER_MERGE} the cells are caveated. */
  turnCoverage: number;
  /** Which merge-crediting mechanism `mergedForDenominator` divides by: `"shipped"` for the
   *  trailer-matched union, `"ledger"` for the verdict count. Always set. */
  mergeSource: "ledger" | "shipped";
  /** The merge count the per-merge fields divide by — NOT always `merged` (see `mergeSource`). */
  mergedForDenominator: number;
  /** Turns per MERGED PR. The numerator is all turns, refused runs included, so refusing more
   *  cannot lower it. `null` only at a zero denominator: division by zero never reads as 0. */
  turnsPerMerge: number | null;
  /** Output tokens per MERGED PR, same discipline as `turnsPerMerge`; `null` at a zero denominator. */
  outputTokensPerMerge: number | null;
}

/** Aggregate runs BY TASK CLASS (W1-T167) — {@link aggregateByType} grouped on `taskClass`. A run
 *  with no class groups under `"unknown"`; `shipped` is joined back by `runId`, never re-read. */
export function aggregateByClass(runs: RunSummary[], shipped?: ShippedRecord[]): ClassCalibration[] {
  const byClass = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const key = r.taskClass ?? "unknown";
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  // runId -> class: the join `shipped` needs, since it carries no taskClass of its own.
  const classOfRun = new Map<string, string>();
  for (const r of runs) classOfRun.set(r.runId, r.taskClass ?? "unknown");
  const shippedByClass = new Map<string, number>();
  if (shipped) {
    for (const s of shipped) {
      const key = classOfRun.get(s.runId) ?? "unknown";
      shippedByClass.set(key, (shippedByClass.get(key) ?? 0) + 1);
    }
  }
  const out: ClassCalibration[] = [];
  for (const [taskClass, rs] of byClass) {
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    const totalTurns = rs.reduce((s, r) => s + r.numTurns, 0);
    const totalOutputTokens = rs.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
    const merged = rs.filter((r) => r.verdict === "merged").length;
    // Nonzero-numTurns coverage — the numerator-trust signal, independent of the denominator.
    const runsWithTurns = rs.filter((r) => r.numTurns > 0).length;
    const turnCoverage = round(runsWithTurns / rs.length);
    const mergeSource: "ledger" | "shipped" = shipped ? "shipped" : "ledger";
    const mergedForDenominator = shipped ? (shippedByClass.get(taskClass) ?? 0) : merged;
    out.push({
      taskClass,
      runs: rs.length,
      totalCostUsd: round(totalCost),
      avgCostUsd: round(totalCost / rs.length),
      avgTurns: round(totalTurns / rs.length),
      merged,
      mergeRate: round(merged / rs.length),
      totalOutputTokens,
      turnCoverage,
      mergeSource,
      mergedForDenominator,
      turnsPerMerge: mergedForDenominator === 0 ? null : round(totalTurns / mergedForDenominator),
      outputTokensPerMerge: mergedForDenominator === 0 ? null : round(totalOutputTokens / mergedForDenominator),
    });
  }
  out.sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0));
  return out;
}

/** One resolved MODEL TIER's share of THIS WEEK's burn (P34 (d), W1-T250). Turns are the burn
 *  unit, because weekly caps meter model time; `costUsdThisWeek` is context and drives nothing. */
export interface ModelClassWeeklyBurn {
  /** The model tier this share burned on, or `"unresolved"` when a run's (task_type, risk) has no
   *  route: read-only reporting over a legacy ledger surfaces a config gap rather than crashing. */
  model: string;
  runs: number;
  turnsThisWeek: number;
  /** Imputed-dollar context only (clause c) — never the share driver. */
  costUsdThisWeek: number;
  /** `turnsThisWeek` over every resolved model's turns this week; `0` for an empty week rather
   *  than a divide-by-zero. The cross-file invariant this task ratifies. */
  shareOfWeeklyBurn: number;
}

/** Aggregate THIS WEEK's runs by the model each resolves to under `.remudero/mounts.yaml`. This IS
 *  the join P34 (d) asserts: mounts.yaml alone accounts nothing, the ledger alone has no model to
 *  bucket against. `now` fixes the week via {@link utcWeekWindowMs}; no route reads
 *  `"unresolved"`, because a stale ledger line must not crash reporting over it. */
export function aggregateWeeklyBurnByModelClass(runs: RunSummary[], mounts: Mounts, now: number): ModelClassWeeklyBurn[] {
  const [weekStart, weekEnd] = utcWeekWindowMs(now);
  const inWeek = runs.filter((r) => {
    const ts = Date.parse(r.startTs);
    return Number.isFinite(ts) && ts >= weekStart && ts < weekEnd;
  });
  const byModel = new Map<string, RunSummary[]>();
  for (const r of inWeek) {
    let model = "unresolved";
    try {
      model = resolveMountForClass(mounts, r.type, r.risk ?? "unknown", r.taskClass ?? DEFAULT_TASK_CLASS).mount.model;
    } catch {
      model = "unresolved"; // no route for this run's (task_type, risk) — a config gap, surfaced not thrown
    }
    const arr = byModel.get(model) ?? [];
    arr.push(r);
    byModel.set(model, arr);
  }
  const totalTurns = inWeek.reduce((s, r) => s + r.numTurns, 0);
  const out: ModelClassWeeklyBurn[] = [];
  for (const [model, rs] of byModel) {
    const turns = rs.reduce((s, r) => s + r.numTurns, 0);
    const cost = rs.reduce((s, r) => s + r.costUsd, 0);
    out.push({
      model,
      runs: rs.length,
      turnsThisWeek: turns,
      costUsdThisWeek: round(cost),
      shareOfWeeklyBurn: totalTurns === 0 ? 0 : round(turns / totalTurns),
    });
  }
  out.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return out;
}

/** Verdict distribution across runs (deterministic key order). */
export function verdictDistribution(runs: RunSummary[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of runs) dist[r.verdict] = (dist[r.verdict] ?? 0) + 1;
  return Object.fromEntries(Object.entries(dist).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Merged runs strictly AFTER the marker ts, keyed by task (Remudero-Task trailer). */
export function mergedSince(runs: RunSummary[], sinceTs: string | undefined): RunSummary[] {
  return runs.filter((r) => r.verdict === "merged" && (!sinceTs || r.startTs > sinceTs));
}

// ── W1-T51: the SHIPPED union (ledger ∪ GitHub-derived trailered merges) ──────
//
// `mergedSince` keys only on ledger verdict==='merged', so a PR that merges GATE-SIDE after its
// run ended another terminal verdict is invisible to it. `shippedSince` unions both sources;
// `mergedSince` itself is untouched (MASTER-PLAN P11).

/** A run's own worktree branch — deterministic, matches run-task.ts's `run-<runId>` naming. */
export function ownBranchOf(runId: string): string {
  return `run-${runId}`;
}

/** ONE cheap `gh api rate_limit` probe, checked once per retro BEFORE any merge is credited, so a
 *  throttle is NAMED rather than read as "GitHub has no evidence" (W1-T132). Never throws. TRAP:
 *  the `<= 0` threshold is COPIED from `isBucketExhausted`, because importing it would close a
 *  dependency cycle. Why: docs/forensics/retro.md (W1-T2305). */
export function probeGithubThrottle(): string | undefined {
  try {
    const out = execFileSync("gh", ["api", "rate_limit", "--jq", ".rate.remaining"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const remaining = Number(out);
    if (Number.isFinite(remaining) && remaining <= 0) {
      return "GitHub API rate limit exhausted (0 remaining)";
    }
    return undefined;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = String(err.stderr ?? err.message ?? "").trim();
    return `gh rate_limit probe failed: ${stderr || "unknown error"}`;
  }
}

/** One credited SHIPPED entry — either a ledger-native merge or a GitHub-discovered gate-side merge. */
export interface ShippedRecord {
  taskId: string;
  runId: string;
  prUrl: string;
  costUsd: number;
  numTurns: number;
  source: "ledger" | "github";
  /** Present ONLY for a GitHub-discovered merge whose run did NOT end verdict=merged. */
  annotation?: string;
}

/** The GitHub queries `shippedSince` needs: a trailer lookup for the union half, and a PR's head
 *  branch for the P9 ownership assert — run-task.ts's `PrHeadGateway` shape at the READ side. */
export interface ShippedGithub {
  /** Find a MERGED PR whose body contains `Remudero-Task: <taskId>`. null if none. */
  findMergedByTrailer(taskId: string): { number: number; url: string } | null;
  /** The PR's head branch name, or undefined if it cannot be resolved. */
  headRefName(prUrl: string): string | undefined;
  /** DEGRADE LOUDLY (W1-T132): a known-throttled or erroring gateway returns a reason NAMING it,
   *  `undefined` when healthy. Checked once per {@link buildGather} call, before any credit is
   *  rendered, so a zero-merge read never passes as a confirmed "nothing shipped". */
  unavailable?(): string | undefined;
  /** Every commit merged into this repo's default branch, full history. Backs
   *  {@link runlessMergesSince}, the trigger's only route to a merge {@link shippedSince} cannot
   *  reach. OPTIONAL, degrading to zero added merges and never a throw (W1-T2288). */
  mergedCommits?(): GitLogCommit[];
}

/** The result of the SHIPPED union: what got credited, and every named discrepancy. */
export interface ShippedResult {
  shipped: ShippedRecord[];
  discrepancies: string[];
}

/** UNION ledger-merged runs with GitHub-derived merged, `Remudero-Task`-trailered PRs, scoped to
 *  runs started strictly after `sinceTs` (W1-T51). A ledger-ABSENT merge is credited with source
 *  "github" and annotated `gate-side merge; run ended <verdict>`.
 *
 *  P9 OWNERSHIP ASSERT: before crediting ANY merge, the PR's `headRefName` must equal the claiming
 *  run's OWN branch ({@link ownBranchOf}). A stale or foreign trailer is REJECTED and named in
 *  `discrepancies` — never silently dropped, never silently trusted. `runs` already carries the
 *  correction override, so the assert checks the truth. Why: docs/forensics/retro.md. */
export function shippedSince(
  runs: RunSummary[],
  sinceTs: string | undefined,
  github: ShippedGithub,
): ShippedResult {
  const scoped = sinceTs ? runs.filter((r) => r.startTs > sinceTs) : runs;
  const shipped: ShippedRecord[] = [];
  const discrepancies: string[] = [];

  for (const r of scoped) {
    const ownBranch = ownBranchOf(r.runId);
    if (r.verdict === "merged") {
      if (!r.prUrl) {
        discrepancies.push(`${r.taskId} (${r.runId}): ledger verdict=merged but has no pr_url — cannot credit`);
        continue;
      }
      const head = github.headRefName(r.prUrl);
      if (head !== ownBranch) {
        discrepancies.push(
          `${r.taskId} (${r.runId}): REJECTED — ledger claims ${r.prUrl} but its head branch ` +
            `("${head ?? "unresolved"}") is not this run's own branch ("${ownBranch}") — stale/foreign trailer, never credited`,
        );
        continue;
      }
      shipped.push({ taskId: r.taskId, runId: r.runId, prUrl: r.prUrl, costUsd: r.costUsd, numTurns: r.numTurns, source: "ledger" });
    } else {
      const pr = github.findMergedByTrailer(r.taskId);
      if (!pr) continue; // no GitHub evidence either — genuinely not shipped
      const head = github.headRefName(pr.url);
      if (head !== ownBranch) {
        discrepancies.push(
          `${r.taskId} (${r.runId}): REJECTED — GitHub trailer names ${pr.url} but its head branch ` +
            `("${head ?? "unresolved"}") is not this run's own branch ("${ownBranch}") — stale/foreign trailer, never credited`,
        );
        continue;
      }
      shipped.push({
        taskId: r.taskId,
        runId: r.runId,
        prUrl: pr.url,
        costUsd: r.costUsd,
        numTurns: r.numTurns,
        source: "github",
        annotation: `gate-side merge; run ended ${r.verdict}`,
      });
      discrepancies.push(
        `${r.taskId} (${r.runId}): ledger verdict=${r.verdict} but GitHub shows ${pr.url} MERGED — gate-side merge, now credited`,
      );
    }
  }

  shipped.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return { shipped, discrepancies };
}

/** The ledger-only fallback when no gateway is wired: `mergedSince` crediting, no unverified claim. */
function ledgerOnlyShipped(merged: RunSummary[]): ShippedRecord[] {
  return merged
    .filter((r): r is RunSummary & { prUrl: string } => typeof r.prUrl === "string")
    .map((r) => ({ taskId: r.taskId, runId: r.runId, prUrl: r.prUrl, costUsd: r.costUsd, numTurns: r.numTurns, source: "ledger" as const }));
}

// ── W1-T2288: the retro TRIGGER's merges beyond shippedSince's reach ─────────
//
// `shippedSince` iterates `runs`, reduced from the LEDGER, so a merge with NO run is structurally
// unreachable rather than undercounted — a plan, triage or feedback filing is exactly that.
// `runlessMergesSince` is the DISJOINT complement, read off `git log`, which cannot rotate out.

/** The anchored trailer form status.ts and autonomy.ts use — reused so no credit path disagrees. */
const RETRO_TRAILER_RE = /^Remudero-Task:\s*(\S+)\s*$/m;

/** Every commit merged strictly after `sinceTs` (the boundary {@link shippedSince} uses) whose
 *  task has NO run. An untrailered commit is always included; a trailered one only when
 *  `taskIdsWithRuns` lacks its id, because a trailered commit whose task HAS a run is
 *  `shippedSince`'s to credit and counting it here would double it. This never inspects a head
 *  branch and never re-derives the P9 assert. */
export function runlessMergesSince(
  commits: GitLogCommit[],
  sinceTs: string | undefined,
  taskIdsWithRuns: ReadonlySet<string>,
): GitLogCommit[] {
  return commits.filter((c) => {
    if (sinceTs && !(c.date > sinceTs)) return false;
    const taskId = RETRO_TRAILER_RE.exec(c.message)?.[1];
    return !taskId || !taskIdsWithRuns.has(taskId);
  });
}

/** Count LEARNINGS entries (top-level `- ` bullets) — used for the added-since delta. */
export function learningsCount(learningsMd: string): number {
  return learningsMd.split("\n").filter((l) => /^- /.test(l)).length;
}

/** Files under `src/` or `test/` in a diff. A retro is PLAN-ONLY, so non-empty fails it closed. */
export function codeFilesInDiff(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)]
    .map((m) => m[1])
    .filter((f) => /^(src|test)\//.test(f));
}

// ── The Tier Invariant (G-17): the retro Architect outranks implement workers ──

/** Model → tier rank. Higher = more capable. Substring-matched, lineup-config'd. */
export const MODEL_TIER: Record<string, number> = {
  haiku: 1,
  sonnet: 2,
  opus: 3,
  fable: 3,
};

/** Tier rank of a model string (substring match; unknown → 0). */
export function tierOf(model: string): number {
  const m = model.toLowerCase();
  for (const [name, rank] of Object.entries(MODEL_TIER)) if (m.includes(name)) return rank;
  return 0;
}

/** Enforce G-17, fail-closed: a same-or-lower-tier synthesizer is not an Architect, so this throws. */
export function assertArchitectAboveWorker(architectModel: string, workerModel: string): void {
  if (tierOf(architectModel) <= tierOf(workerModel)) {
    throw new Error(
      `G-17 Tier Invariant: retro Architect (${architectModel}, tier ${tierOf(architectModel)}) must ` +
        `ride a HIGHER tier than implement workers (${workerModel}, tier ${tierOf(workerModel)}).`,
    );
  }
}

// ── G-17 evidence (W1-T2239): the Architect-lane share of spend, measured ──
//
// MASTER-PLAN §9 gives G-17 two reasons: ratification authority, untouched here, and CAPABILITY,
// never measured against this repo's own ledger. This is that measurement, an INPUT to the retro
// and never a change to the invariant: {@link assertArchitectAboveWorker} still throws
// unconditionally and no mounts.yaml row is read or written. Why: docs/forensics/retro.md.

/** EXPORTED for mount-headroom-sweep.mjs (W1-T2668): two copies of this mapping would drift. */
export const ARCHITECT_LANE_STEPS: Readonly<Record<string, string>> = {
  retro: "retro.synthesized",
  triage: "triage.synthesized",
  plan: "plan.synthesized",
  inbox_draft: "inbox.draft_synthesized",
};

/** Non-Architect lanes, for SCALE ONLY: a share needs a denominator to sit beside. */
const COMPARISON_LANE_STEPS: Readonly<Record<string, string>> = {
  implement: "verdict",
  reviewer: "review.reviewer",
};

/** The bucket for a row with no `model` key — NEVER folded into a real model's count. */
export const UNATTRIBUTED_MODEL = "unattributed";

/** One model's row-count within a single lane (see {@link UNATTRIBUTED_MODEL}). */
export interface LaneModelShare {
  model: string;
  rows: number;
}

/** One lane's measured spend: rows, NOTIONAL (never billed) cost, newest row, model attribution. */
export interface LaneSpend {
  lane: string;
  step: string;
  rows: number;
  /** Sum of each row's `cost_usd`, falling back to `total_cost_usd` — {@link gatherRuns}'s own
   *  precedence. NOTIONAL, API-equivalent price on a subscription install, never billed spend. */
  costUsd: number;
  /** The most recent `ts` this lane's rows carried; absent only when the lane logged none. */
  newestTs?: string;
  models: LaneModelShare[];
}

/** `r.cost_usd`, falling back to `r.total_cost_usd` — {@link gatherRuns}'s own precedence. */
function costOf(r: LedgerRecord): number {
  if (typeof r.cost_usd === "number") return r.cost_usd;
  if (typeof r.total_cost_usd === "number") return r.total_cost_usd;
  return 0;
}

function laneSpendOf(lane: string, step: string, rows: LedgerRecord[]): LaneSpend {
  const models = new Map<string, number>();
  let newestTs: string | undefined;
  for (const r of rows) {
    const model = typeof r.model === "string" && r.model.length > 0 ? r.model : UNATTRIBUTED_MODEL;
    models.set(model, (models.get(model) ?? 0) + 1);
    if (typeof r.ts === "string" && (newestTs === undefined || r.ts > newestTs)) newestTs = r.ts;
  }
  return {
    lane,
    step,
    rows: rows.length,
    costUsd: round(rows.reduce((s, r) => s + costOf(r), 0)),
    ...(newestTs !== undefined ? { newestTs } : {}),
    models: [...models.entries()]
      .map(([model, n]) => ({ model, rows: n }))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
  };
}

/** The G-17-evidence gather: six lanes, the Architect share, and the WINDOW seen, so a stale
 *  corpus cannot read as a current share. */
export interface ArchitectLaneShareReport {
  architectLanes: LaneSpend[];
  comparisonLanes: LaneSpend[];
  architectRows: number;
  /** NOTIONAL / API-equivalent — see {@link LaneSpend.costUsd}. */
  architectCostUsd: number;
  totalRows: number;
  /** NOTIONAL / API-equivalent — see {@link LaneSpend.costUsd}. */
  totalCostUsd: number;
  /** `architectCostUsd / totalCostUsd`; `0` for an empty corpus, not a divide-by-zero. */
  shareOfSpend: number;
  windowStartTs?: string;
  windowEndTs?: string;
}

/** Measure the Architect-lane share of spend over `records` — a PURE reduction over the records
 *  `buildGather` hands it, never a file. Each row is bucketed by `step` into at most one lane. */
export function architectLaneShare(records: LedgerRecord[]): ArchitectLaneShareReport {
  const laneOfStep = new Map<string, string>();
  for (const [lane, step] of Object.entries(ARCHITECT_LANE_STEPS)) laneOfStep.set(step, lane);
  for (const [lane, step] of Object.entries(COMPARISON_LANE_STEPS)) laneOfStep.set(step, lane);

  const rowsByLane = new Map<string, LedgerRecord[]>();
  for (const lane of laneOfStep.values()) rowsByLane.set(lane, []);
  let windowStartTs: string | undefined;
  let windowEndTs: string | undefined;
  for (const r of records) {
    const lane = typeof r.step === "string" ? laneOfStep.get(r.step) : undefined;
    if (!lane) continue;
    rowsByLane.get(lane)!.push(r);
    if (typeof r.ts === "string") {
      if (windowStartTs === undefined || r.ts < windowStartTs) windowStartTs = r.ts;
      if (windowEndTs === undefined || r.ts > windowEndTs) windowEndTs = r.ts;
    }
  }

  const architectLanes = Object.entries(ARCHITECT_LANE_STEPS).map(([lane, step]) =>
    laneSpendOf(lane, step, rowsByLane.get(lane) ?? []),
  );
  const comparisonLanes = Object.entries(COMPARISON_LANE_STEPS).map(([lane, step]) =>
    laneSpendOf(lane, step, rowsByLane.get(lane) ?? []),
  );
  const allLanes = [...architectLanes, ...comparisonLanes];
  const architectRows = architectLanes.reduce((s, l) => s + l.rows, 0);
  const architectCostUsd = round(architectLanes.reduce((s, l) => s + l.costUsd, 0));
  const totalRows = allLanes.reduce((s, l) => s + l.rows, 0);
  const totalCostUsd = round(allLanes.reduce((s, l) => s + l.costUsd, 0));
  return {
    architectLanes,
    comparisonLanes,
    architectRows,
    architectCostUsd,
    totalRows,
    totalCostUsd,
    shareOfSpend: totalCostUsd === 0 ? 0 : round(architectCostUsd / totalCostUsd),
    ...(windowStartTs !== undefined ? { windowStartTs } : {}),
    ...(windowEndTs !== undefined ? { windowEndTs } : {}),
  };
}

/** Render one {@link ArchitectLaneShareReport} lane row (markdown table body). */
function laneSpendRow(l: LaneSpend): string {
  const models = l.models.length ? l.models.map((m) => `${m.model}×${m.rows}`).join(", ") : "(no rows)";
  return `| ${l.lane} (\`${l.step}\`) | ${l.rows} | $${l.costUsd.toFixed(2)} | ${l.newestTs ?? "(none)"} | ${models} |`;
}

/** Render the lane table — Architect lanes first, in the SAME row shape, so the share is legible. */
export function architectLaneShareTable(g: ArchitectLaneShareReport): string {
  return [
    "| lane (`step`) | rows | notional $ (api-equivalent, NOT billed) | newest row | models (unattributed = no `model` key) |",
    "|---|---|---|---|---|",
    ...g.architectLanes.map(laneSpendRow),
    ...g.comparisonLanes.map(laneSpendRow),
  ].join("\n");
}

/** Render the G-17-evidence section, printed beside the per-class calibration table (W1-T2239). */
export function renderArchitectLaneShare(g: ArchitectLaneShareReport): string {
  const windowLine =
    g.windowStartTs !== undefined && g.windowEndTs !== undefined
      ? `Window covered: ${g.windowStartTs} → ${g.windowEndTs} · newest row seen: ${g.windowEndTs} — ` +
        `a corpus this stale reads as a HISTORICAL share, never a current one.`
      : "Window covered: (no rows in any of the six lanes below) — no window, no share to trust.";
  return [
    "## G-17 Architect-lane share of spend (W1-T2239 — evidence for the capability half, not a tier move)",
    "MASTER-PLAN §9's ratification-authority half of G-17 is unaffected by anything below; this " +
      "measures ONLY the capability half (a higher-tier Architect authors better harness text), " +
      "which this repo has never tested against its own ledger. `assertArchitectAboveWorker` keeps " +
      "throwing on a same-or-lower-tier Architect regardless of this number, and no mount row moves.",
    windowLine,
    `Architect lanes (retro + triage + plan + inbox-draft): ${g.architectRows} rows, ` +
      `$${g.architectCostUsd.toFixed(2)} notional — ${(g.shareOfSpend * 100).toFixed(1)}% of the ` +
      `${g.totalRows}-row / $${g.totalCostUsd.toFixed(2)}-notional measured total below.`,
    "Every $ figure on this table is NOTIONAL / API-EQUIVALENT price on a subscription install " +
      "(MASTER-PLAN's own cost semantics) — never billed spend.",
    "",
    architectLaneShareTable(g),
  ].join("\n");
}

// ── The full gather + its rendering ───────────────────────────────────────

// ── MAST-coded verdicts (W1-T89, ratifies P18's mineable core) ─────────────
//
// MAST (Cemri et al., NeurIPS 2025 [research: mast-neurips2025]) names 14 failure modes across
// three categories. plan/mast-mapping.yaml holds the verdict -> MAST mapping as DATA (Rule 2,
// never LLM-classified), applied READ-SIDE so the ledger codes with zero rewrites.
// Why: docs/forensics/retro.md.

/** One row of plan/mast-mapping.yaml: a verdict class, optionally qualified by `subtype`, coded to
 *  one MAST mode and category. `provisional` marks a row still being refined, not a code path. */
export interface MastMappingRow {
  verdict: string;
  subtype?: string;
  mastMode: string;
  category: string;
  provisional?: boolean;
  comment?: string;
}

/** The whole parsed mapping table -- an ordered list of rows, matched most-specific-first. */
export interface MastMapping {
  rows: MastMappingRow[];
}

/** plan/mast-mapping.yaml is structurally invalid (not a fixture bug, a file bug). */
export class MastMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MastMappingError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse and validate raw YAML into a {@link MastMapping}. Pure. Fails LOUDLY on a malformed row:
 *  a mapping this central is never leniently guessed at. */
export function parseMastMapping(yamlText: string): MastMapping {
  const raw = parseYaml(yamlText);
  if (!isPlainObject(raw) || !Array.isArray(raw.rows)) {
    throw new MastMappingError("mast-mapping.yaml must be a mapping with a 'rows' array.");
  }
  const rows: MastMappingRow[] = raw.rows.map((row: unknown, i: number) => {
    if (!isPlainObject(row)) throw new MastMappingError(`mast-mapping.yaml rows[${i}] must be a mapping.`);
    const { verdict, subtype, mast_mode, category, provisional, comment } = row;
    if (typeof verdict !== "string" || !verdict) {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].verdict must be a non-empty string.`);
    }
    if (typeof mast_mode !== "string" || !mast_mode) {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].mast_mode must be a non-empty string.`);
    }
    if (typeof category !== "string" || !category) {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].category must be a non-empty string.`);
    }
    if (subtype !== undefined && typeof subtype !== "string") {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].subtype must be a string when present.`);
    }
    if (provisional !== undefined && typeof provisional !== "boolean") {
      throw new MastMappingError(`mast-mapping.yaml rows[${i}].provisional must be a boolean when present.`);
    }
    return {
      verdict,
      ...(typeof subtype === "string" ? { subtype } : {}),
      mastMode: mast_mode,
      category,
      ...(provisional === true ? { provisional: true } : {}),
      ...(typeof comment === "string" ? { comment } : {}),
    };
  });
  return { rows };
}

/** Load + parse plan/mast-mapping.yaml (or any path holding the same shape) from disk. */
export function loadMastMapping(path: string): MastMapping {
  return parseMastMapping(fsMarker.readFileSync(path, "utf8"));
}

/** Find the row coding one run, exact (verdict, subtype) before bare verdict; undefined means the
 *  caller codes it unmapped rather than guessing. */
export function mastRowFor(mapping: MastMapping, run: Pick<RunSummary, "verdict" | "subtype">): MastMappingRow | undefined {
  if (run.subtype) {
    const exact = mapping.rows.find((r) => r.verdict === run.verdict && r.subtype === run.subtype);
    if (exact) return exact;
  }
  return mapping.rows.find((r) => r.verdict === run.verdict && r.subtype === undefined);
}

/** The per-cycle MAST failure distribution `rmd retro` reports (W1-T89). */
export interface MastCategoryDistribution {
  /** category -> count, deterministic order. A `merged` run never reaches {@link mastRowFor}. */
  byCategory: Record<string, number>;
  /** Every unmapped failure verdict, named and visible, never folded into a guessed category. */
  unmapped: Record<string, number>;
}

function sortedCountRecord(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Verdicts the MAST taxonomy treats as a CREDITED outcome: out of scope for a FAILURE
 *  distribution, never an infrastructure event, never a task defect. `merged`;
 *  `already_satisfied` (W1-T272); and `task_already_merged` (W1-T319), a pre-spawn refusal where
 *  no worker ran. DATA-shaped and shared by every reducer below, so none is miscounted as an
 *  unmapped failure. Why: docs/forensics/retro.md. */
const CREDITED_VERDICTS: ReadonlySet<string> = new Set(["merged", "already_satisfied", "task_already_merged"]);

/** Reduce a cycle's runs into a {@link MastCategoryDistribution}. The mapping is DATA, so a row
 *  edit alone flips a fixture's outcome (mast-mapping.test.ts). */
export function mastCategoryDistribution(runs: RunSummary[], mapping: MastMapping): MastCategoryDistribution {
  const byCategory: Record<string, number> = {};
  const unmapped: Record<string, number> = {};
  for (const r of runs) {
    if (CREDITED_VERDICTS.has(r.verdict)) continue;
    const row = mastRowFor(mapping, r);
    if (row) {
      byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    } else {
      const key = r.subtype ? `${r.verdict}:${r.subtype}` : r.verdict;
      unmapped[key] = (unmapped[key] ?? 0) + 1;
    }
  }
  return { byCategory: sortedCountRecord(byCategory), unmapped: sortedCountRecord(unmapped) };
}

/** Render the MAST category table, with an optional trend column against the prior cycle. */
export function mastDistributionTable(dist: MastCategoryDistribution, priorByCategory?: Record<string, number>): string {
  const categories = [...new Set([...Object.keys(dist.byCategory), ...Object.keys(priorByCategory ?? {})])].sort();
  const rows = categories.map((c) => {
    const cur = dist.byCategory[c] ?? 0;
    if (!priorByCategory) return `| ${c} | ${cur} |`;
    const before = priorByCategory[c] ?? 0;
    const delta = cur - before;
    const trend = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
    return `| ${c} | ${cur} | ${trend} |`;
  });
  const unmappedLines = Object.entries(dist.unmapped).map(([k, n]) => `- ${k}: ${n}`);
  return [
    priorByCategory ? "| category | count | trend vs prior cycle |" : "| category | count |",
    priorByCategory ? "|---|---|---|" : "|---|---|",
    ...(rows.length ? rows : ["| (no coded failures this cycle) | 0 |" + (priorByCategory ? " |" : "")]),
    "",
    unmappedLines.length
      ? "Unmapped verdict classes (named, never guessed):"
      : "Unmapped verdict classes: (none)",
    ...unmappedLines,
  ].join("\n");
}

// ── W1-T91/P23: guard-fired blocks classify as INFRASTRUCTURE, never a task defect ──
//
// A guard firing is the harness's OWN preflight catching a HOST condition before any task work
// ran: proof the guard worked. Coded off plan/mast-mapping.yaml's `category: infrastructure` rows
// (Rule 2), so the row IS the classifier — remove it and these runs report unmapped, never
// silently mis-coded. Why: docs/forensics/retro.md.

/** DATA fallback table (Rule 2): a `verdict` line predating the structured `guard`/`check` fields
 *  carries only prose in `reason`. Each row names the verdict class, a pattern the prose must
 *  match — never inferring off the bare verdict — and the guard/check it codes to. */
export interface GuardReasonFallbackRow {
  verdict: string;
  pattern: RegExp;
  guard: string;
  check: string;
}

export const GUARD_REASON_FALLBACK_ROWS: readonly GuardReasonFallbackRow[] = [
  {
    verdict: "blocked_isolation",
    pattern: /isolation_preflight_failed/i,
    guard: "isolation",
    check: "inherited-functions",
  },
  {
    verdict: "blocked_containment",
    pattern: /containment (?:preflight|UNPROVEN)/i,
    guard: "containment",
    check: "outside-cwd-denial",
  },
];

/** Resolve a run's guard and check from the structured fields, else a prose-pattern fallback;
 *  undefined when NEITHER resolves it. */
export function resolveGuardCheck(r: Pick<RunSummary, "verdict" | "guard" | "check" | "reason">): { guard: string; check: string } | undefined {
  if (r.guard && r.check) return { guard: r.guard, check: r.check };
  const row = GUARD_REASON_FALLBACK_ROWS.find((f) => f.verdict === r.verdict && r.reason && f.pattern.test(r.reason));
  return row ? { guard: row.guard, check: row.check } : undefined;
}

/** One guard-fired block, classified INFRASTRUCTURE (never a task defect). */
export interface InfrastructureEvent {
  runId: string;
  taskId: string;
  verdict: string;
  guard: string;
  check: string;
  /** The preflight's observed state, three-state and never a boolean; absent on a prose-only line. */
  observed?: string;
}

/** Mine `runs` for every run the mapping codes `category: infrastructure` (Rule 2). An unresolved
 *  guard/check still counts, named "unknown". */
export function infrastructureEvents(runs: RunSummary[], mapping: MastMapping): InfrastructureEvent[] {
  const out: InfrastructureEvent[] = [];
  for (const r of runs) {
    if (CREDITED_VERDICTS.has(r.verdict)) continue;
    const row = mastRowFor(mapping, r);
    if (row?.category !== "infrastructure") continue;
    const gc = resolveGuardCheck(r) ?? { guard: "unknown", check: "unknown" };
    out.push({
      runId: r.runId,
      taskId: r.taskId,
      verdict: r.verdict,
      guard: gc.guard,
      check: gc.check,
      ...(r.observed !== undefined ? { observed: r.observed } : {}),
    });
  }
  out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

/** Recurrence of ONE (guard, check) pair across runs. The same check firing across N runs on one
 *  host IS a host signal, worth trending even though none of its runs counts as a task defect. */
export interface InfrastructureRecurrence {
  guard: string;
  check: string;
  count: number;
  taskIds: string[];
  runIds: string[];
}

/** Group {@link infrastructureEvents} by (guard, check), deterministic — the recurrence trend. */
export function infrastructureRecurrence(events: InfrastructureEvent[]): InfrastructureRecurrence[] {
  const byKey = new Map<string, InfrastructureEvent[]>();
  for (const e of events) {
    const key = `${e.guard} ${e.check}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }
  const out: InfrastructureRecurrence[] = [...byKey.entries()].map(([key, es]) => {
    const [guard, check] = key.split(" ");
    return {
      guard,
      check,
      count: es.length,
      taskIds: [...new Set(es.map((e) => e.taskId))].sort(),
      runIds: es.map((e) => e.runId).sort(),
    };
  });
  out.sort((a, b) => (a.guard + a.check < b.guard + b.check ? -1 : a.guard + a.check > b.guard + b.check ? 1 : 0));
  return out;
}

/** Per-task DEFECT count (W1-T91/P23 part ii): every non-merged run for that task EXCLUDING
 *  guard-fired infrastructure events, because a guard firing correctly is a host signal. Driven by
 *  the SAME mapping `category` {@link infrastructureEvents} reads — one classifier, not two. */
export function taskDefectCounts(runs: RunSummary[], mapping: MastMapping): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) {
    if (CREDITED_VERDICTS.has(r.verdict)) continue;
    const row = mastRowFor(mapping, r);
    if (row?.category === "infrastructure") continue; // guard-fired, not a task defect
    out[r.taskId] = (out[r.taskId] ?? 0) + 1;
  }
  return sortedCountRecord(out);
}

/** Render the infrastructure section, mirroring {@link mastDistributionTable}'s shape. */
export function renderInfrastructure(events: InfrastructureEvent[], recurrence: InfrastructureRecurrence[]): string {
  if (events.length === 0) {
    return "## Infrastructure events (guard-fired blocks — never a task defect)\n\nNone this cycle.";
  }
  const recurLines = recurrence
    .filter((r) => r.count >= 2)
    .map((r) => `- ${r.guard}/${r.check}: ${r.count}x across ${r.taskIds.join(", ")} — a HOST signal, not a task signal`);
  return [
    "## Infrastructure events (guard-fired blocks — never a task defect)",
    "",
    `${events.length} guard-fired block(s) this cycle, excluded from every task's defect count:`,
    ...events.map((e) => `- ${e.taskId} (${e.runId}): ${e.guard}/${e.check}${e.observed ? ` — observed: ${e.observed}` : ""}`),
    "",
    recurLines.length ? "### Recurrence trend (same check firing repeatedly on one host)" : "### Recurrence trend: none (each check fired once)",
    ...recurLines,
  ].join("\n");
}

// ── Mutation gate lifetime (W1-T393, MASTER-PLAN §11 D-10) ────────────────
//
// D-10 stood open for seven retro cycles on a prose demand no gather rung executed. Clause (i) is
// to READ THE GATE'S OWN HISTORY, never re-run Stryker here; that history exists nowhere durable,
// and THAT is the finding. So this ships the emission plus a rung reading it, reporting "starts
// now, N=0" as a stated limitation. `MUTATION_GATE_VERDICT_STEP` joins
// `DECISION_RELEVANT_LEDGER_STEPS` in the SAME change, because a lifetime count rotation could
// reset would recreate the defect. Why: docs/forensics/retro.md.

/** The ledger step for `mutation-ratchet`'s PR-gate verdict: one line per REAL Stryker run. */
export const MUTATION_GATE_VERDICT_STEP = "mutation.ratchet_verdict";

/** The per-run fields {@link mutationGateVerdictLine} carries — the Stryker totals the ratchet
 *  already computes, plus the binary conclusion those totals must never stand in for. */
export interface MutationGateVerdictInput {
  /** Identifies this CI run (a head sha or Actions run id): the gate has no Remudero `run_id`, it
   *  is a required check on every PR rather than an `rmd`-dispatched run. */
  runId: string;
  taskId?: string;
  prUrl?: string;
  /** Whether `scripts/mutation-ratchet.mjs`'s ratchet comparison passed or failed THIS run —
   *  clause (ii)'s decision variable; never let `killed`/`survived` stand in for this. */
  conclusion: "success" | "failure";
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
}

/** Build (never write) one mutation-ratchet verdict line — the builder/writer split used here. */
export function mutationGateVerdictLine(input: MutationGateVerdictInput): LedgerLine {
  return {
    run_id: input.runId,
    task_id: input.taskId ?? "mutation-ratchet",
    step: MUTATION_GATE_VERDICT_STEP,
    ...(input.prUrl ? { pr_url: input.prUrl } : {}),
    conclusion: input.conclusion,
    killed: input.killed,
    survived: input.survived,
    timeout: input.timeout,
    no_coverage: input.noCoverage,
  };
}

/** Dependencies for {@link recordMutationGateVerdict} — a test spies on `writeLedger`. */
export interface MutationGateVerdictDeps {
  ledgerPath: string;
  writeLedger?: typeof appendLedger;
}

/** Append one {@link mutationGateVerdictLine}. UNWIRED here, because the call site lives in
 *  `mutation-ratchet.mjs`/`ci.yml`; shipped now so the step and its rotation survival land once. */
export function recordMutationGateVerdict(input: MutationGateVerdictInput, deps: MutationGateVerdictDeps): void {
  const writeLedger = deps.writeLedger ?? appendLedger;
  writeLedger(deps.ledgerPath, mutationGateVerdictLine(input));
}

/** One PR on which `mutation-ratchet` concluded FAILURE — clause (ii)'s escape count, named. */
export interface MutationGateEscape {
  runId: string;
  prUrl?: string;
}

/** The rung D-10 asks for, folded over `MUTATION_GATE_VERDICT_STEP` lines. `positiveControl:
 *  false` is an UNMEASURED history, never "zero escapes"; `true` with `escapeCount: 0` is (P48). */
export interface MutationGateLifetimeReport {
  positiveControl: boolean;
  runCount: number;
  killed: number;
  survived: number;
  escapeCount: number;
  escapes: MutationGateEscape[];
}

/** READ ONLY: never runs Stryker, never touches disk, and folds over the FULL `records` — a
 *  marker-scoped read would truncate "lifetime" into "since last retro". */
export function mutationGateLifetime(records: LedgerRecord[]): MutationGateLifetimeReport {
  const verdicts = records.filter((r) => r.step === MUTATION_GATE_VERDICT_STEP);
  if (verdicts.length === 0) {
    return { positiveControl: false, runCount: 0, killed: 0, survived: 0, escapeCount: 0, escapes: [] };
  }
  let killed = 0;
  let survived = 0;
  const escapes: MutationGateEscape[] = [];
  for (const r of verdicts) {
    killed += typeof r.killed === "number" ? r.killed : 0;
    survived += typeof r.survived === "number" ? r.survived : 0;
    if (r.conclusion === "failure") {
      escapes.push({
        runId: String(r.run_id ?? "?"),
        ...(typeof r.pr_url === "string" ? { prUrl: r.pr_url } : {}),
      });
    }
  }
  return { positiveControl: true, runCount: verdicts.length, killed, survived, escapeCount: escapes.length, escapes };
}

/** Render the mutation-gate-lifetime section — THE section D-10 waited seven cycles for. */
export function renderMutationGateLifetime(r: MutationGateLifetimeReport): string {
  if (!r.positiveControl) {
    return [
      "## Mutation gate lifetime (D-10, W1-T393) — NO POSITIVE CONTROL: 0 verdicts recorded",
      "",
      "This is NOT \"zero escapes\" — it is an unmeasured history (P48: no naked zero). No " +
        `\`${MUTATION_GATE_VERDICT_STEP}\` ledger line has ever been recorded — this rung starts ` +
        "now, N=0, a stated limitation, never an empty result. The CI-side emission call site " +
        "(inside `scripts/mutation-ratchet.mjs`/`ci.yml`, after a real `npx stryker run`) is a " +
        "follow-up, not yet wired (out of this task's scope).",
    ].join("\n");
  }
  const escapeLines = r.escapes.length
    ? r.escapes.map((e) => `- ${e.runId}${e.prUrl ? ` → ${e.prUrl}` : ""}`)
    : ["- (none)"];
  return [
    `## Mutation gate lifetime (D-10, W1-T393): ${r.runCount} run(s) recorded`,
    "",
    `Has \`mutation-ratchet\` EVER concluded FAILURE on a PR: ${r.escapeCount > 0 ? "YES" : "NO"} (${r.escapeCount} escape(s))`,
    `Killed ${r.killed} / survived ${r.survived} (supporting totals — never a stand-in for the escape count above)`,
    "",
    "Escapes:",
    ...escapeLines,
  ].join("\n");
}

// ── §5A/§9 replay pass-rate (W1-T165) — the missing Self-Harness leg ────────
//
// READ ONLY like the rung above: never runs a golden, never touches sandbox. Folds whatever
// {@link REPLAY_RESULT_STEP} lines `recordReplayResults` wrote, scoped to THIS CYCLE —
// deliberately unlike `mutationGateLifetime`'s all-time figure.

/** `n passed / n goldens` for the cycle. `ranThisCycle: false` (P48) means NO replay line was
 *  recorded in this window at all — an unmeasured cycle, never a "0% pass rate". */
export interface ReplayCalibration {
  ranThisCycle: boolean;
  total: number;
  passed: number;
  rate: number;
}

/** Fold `REPLAY_RESULT_STEP` lines within `sinceTs` (undefined means all-time) into the cycle's
 *  pass-rate. A non-boolean `passed` is simply not counted, never thrown on. */
export function replayPassRateForCycle(records: LedgerRecord[], sinceTs?: string): ReplayCalibration {
  const lines = records.filter((r) => {
    if (r.step !== REPLAY_RESULT_STEP || typeof r.passed !== "boolean") return false;
    if (!sinceTs) return true;
    return typeof r.ts === "string" && r.ts > sinceTs;
  });
  const total = lines.length;
  const passed = lines.filter((r) => r.passed === true).length;
  return { ranThisCycle: total > 0, total, passed, rate: total ? passed / total : 0 };
}

/** Render the replay-pass-rate section, alongside the other calibration tables. */
export function renderReplayCalibration(r: ReplayCalibration): string {
  if (!r.ranThisCycle) {
    return [
      "## Replay pass-rate (golden-task regression suite, W1-T165) — the Self-Harness leg",
      "",
      "No replay run recorded this cycle — NOT a confirmed 0% (P48: no naked zero); the golden " +
        "suite simply did not run against a candidate harness this cycle.",
    ].join("\n");
  }
  return [
    "## Replay pass-rate (golden-task regression suite, W1-T165) — the Self-Harness leg",
    "",
    `Replay pass-rate this cycle: ${r.passed}/${r.total} goldens (${(r.rate * 100).toFixed(0)}%)`,
  ].join("\n");
}

export interface RetroGather {
  sinceTs?: string;
  totalRuns: number;
  byType: TypeCalibration[];
  /** W1-T167: per-class cost and merge rate — the measurement half of the routing hypothesis. */
  byClass: ClassCalibration[];
  /** P34 (d), W1-T250: THIS WEEK's burn by model tier. Present ONLY when `buildGather` got a
   *  `mounts` table — omission degrades the section out, never a silent empty-array zero. */
  weeklyBurnByModelClass?: ModelClassWeeklyBurn[];
  verdicts: Record<string, number>;
  mergedSince: RunSummary[];
  /** The SHIPPED union (W1-T51) — ledger ∪ GitHub-derived, ownership-asserted, correction-aware. */
  shipped: ShippedRecord[];
  /** Every named discrepancy the union found (gate-side additions AND rejected foreign trailers). */
  discrepancies: string[];
  /** W1-T73: every MERGED run whose `review.posted` matched a degraded-success signal. */
  degradedSuccess: DegradedSuccessFinding[];
  /** W1-T87/P13: the other half of the flywheel — merged-run shapes shared by two or more runs,
   *  mined as procedural-learning candidates for the Architect to phrase and ratify. */
  proceduralCandidates: ProceduralCandidate[];
  learningsNow: number;
  learningsAtMarker: number;
  /** W1-T132: present ONLY when `opts.github.unavailable()` named a reason. `renderGather` refuses
   *  to present `shipped` as a complete count while this is set. */
  githubUnavailable?: string;
  /** W1-T89/P18: this cycle's failure distribution BY MAST CATEGORY. Defaults to an empty table,
   *  reporting every failure verdict unmapped — a visible degrade, never a build failure. */
  mast: MastCategoryDistribution;
  /** The PRIOR cycle's `mast.byCategory`, when the marker carried one, so `renderGather` can
   *  show a trend without re-reading the marker. Absent on the first MAST-coded retro. */
  priorMastCategoryCounts?: Record<string, number>;
  /** W1-T91/P23: every guard-fired block this cycle, classified INFRASTRUCTURE and never a task
   *  defect — mined off the SAME mapping as `mast`, over the same `scoped` window. */
  infrastructureEvents: InfrastructureEvent[];
  /** W1-T91/P23: `infrastructureEvents` by (guard, check) — the trend naming a host signal. */
  infrastructureRecurrence: InfrastructureRecurrence[];
  /** W1-T91/P23: per-task defect counts over `scoped`, excluding every guard-fired event. */
  taskDefectCounts: Record<string, number>;
  /** W1-T105: unharvested follow-ups over the FULL ledger, deduped against `opts.openTitles`. */
  followups: FollowupHarvest;
  /** W1-T393/D-10: `mutation-ratchet`'s LIFETIME kill/survive/escape record, folded over the
   *  FULL ledger (never `scoped` — see {@link mutationGateLifetime}'s doc for why). */
  mutationGateLifetime: MutationGateLifetimeReport;
  /** W1-T165: the golden-task replay pass-rate FOR THIS CYCLE (`sinceTs`-scoped, unlike
   *  `mutationGateLifetime` above — see {@link replayPassRateForCycle}'s doc for why). */
  replay: ReplayCalibration;
  /** W1-T2239: the G-17 Architect-lane share of spend, over the FULL `records` and never `scoped`
   *  — a stale-corpus HISTORICAL share is still the figure asked for (see the window fields). */
  architectLaneShare: ArchitectLaneShareReport;
  /** W1-T2642: the plan-coherence census — ALWAYS present. buildGather still never touches disk: a
   *  caller omitting `opts.planCoherence` gets `{ kind: "unexamined", reason }`, because omission
   *  reads as "nothing calls this" while a stated `unexamined` is a real, rendered answer. */
  planCoherence: PlanCoherenceReport;
}

/** Build the whole deterministic gather from raw inputs. Pure over its injected `github` gateway:
 *  omit it and `shipped` degrades to the ledger-only list, with no ownership assert. */
export function buildGather(opts: {
  ledgerNdjson: string;
  learningsMd: string;
  sinceTs?: string;
  learningsAtMarker?: number;
  /** GitHub gateway for the SHIPPED union (W1-T51/P9). Omit to fall back ledger-only. */
  github?: ShippedGithub;
  /** W1-T89/P18: the already-loaded verdict -> MAST mapping; buildGather never touches disk.
   *  Omit and every failure verdict reports unmapped rather than the gather refusing. */
  mastMapping?: MastMapping;
  /** The prior cycle's `mast.byCategory` for the trend column; the marker is never read here. */
  priorMastCategoryCounts?: Record<string, number>;
  /** W1-T105 design (iv): open task titles and proposal text for the follow-up harvest's dedup;
   *  buildGather never reads the plan itself. Omit and every follow-up mints. */
  openTitles?: string[];
  /** P34 (d), W1-T250: the already-loaded mounts table, same discipline as `mastMapping`. Omit and
   *  `weeklyBurnByModelClass` is omitted entirely, never a silently empty array. */
  mounts?: Mounts;
  /** Epoch ms defining "this week", injected so buildGather stays pure. Ignored without `mounts`. */
  now?: number;
  /** W1-T1013: the follow-up harvest's OWN ndjson corpus — the archive ∪ live union, scoped by the
   *  caller to the three steps {@link mineFollowups} reads. A SEPARATE input rather than swapping
   *  `ledgerNdjson`, because every other miner is scoped against its own single-file read. */
  followupLedgerNdjson?: string;
  /** W1-T2642: the census's raw inputs — the monolith blob plus a shard listing, or the stated
   *  reason it could not be listed. buildGather stays FS-free. Omit and the rung still runs
   *  against an `{ ok: false, reason }` default, so the report says `unexamined`. */
  planCoherence?: { monolith: { path: string; text: string }; shards: PlanCoherenceShardListing };
}): RetroGather {
  const records = parseLedger(opts.ledgerNdjson);
  const followupRecords = opts.followupLedgerNdjson !== undefined ? parseLedger(opts.followupLedgerNdjson) : records;
  const runs = gatherRuns(records);
  const scoped = opts.sinceTs ? runs.filter((r) => r.startTs > opts.sinceTs!) : runs;
  const merged = mergedSince(runs, opts.sinceTs);
  const { shipped, discrepancies } = opts.github
    ? shippedSince(runs, opts.sinceTs, opts.github)
    : { shipped: ledgerOnlyShipped(merged), discrepancies: [] as string[] };
  // Checked ONCE, after the union runs so a healthy union still gets full credit: a reason here
  // means the read layer is untrustworthy, whatever shippedSince managed to resolve (W1-T132).
  const githubUnavailable = opts.github?.unavailable?.();
  // Computed once, shared by the events list and its recurrence trend — never two reads.
  const mapping = opts.mastMapping ?? { rows: [] };
  const infraEvents = infrastructureEvents(scoped, mapping);
  return {
    sinceTs: opts.sinceTs,
    totalRuns: scoped.length,
    byType: aggregateByType(scoped),
    // `shipped` is ALWAYS passed: it is the more-accurate-or-equal merge count, so the per-merge
    // figures never divide by the ledger-verdict count MASTER-PLAN says undercounts by over half.
    byClass: aggregateByClass(scoped, shipped),
    // FULL `runs`, never `scoped`: "this week" is an absolute calendar window, so a fresh
    // `sinceTs` must not truncate a week in progress. Omitted entirely without a `mounts` table.
    ...(opts.mounts ? { weeklyBurnByModelClass: aggregateWeeklyBurnByModelClass(runs, opts.mounts, opts.now ?? Date.now()) } : {}),
    verdicts: verdictDistribution(scoped),
    mergedSince: merged,
    shipped,
    discrepancies,
    // Mined over the SAME scoped-merged set the marker window bounds, so a finding never
    // re-surfaces for a run the marker has moved past (W1-T73).
    degradedSuccess: mineDegradedSuccess(merged, records),
    // Same marker-scoped window as degradedSuccess above (W1-T87/P13).
    proceduralCandidates: mineProceduralCandidates(merged, records),
    learningsNow: learningsCount(opts.learningsMd),
    learningsAtMarker: opts.learningsAtMarker ?? 0,
    ...(githubUnavailable ? { githubUnavailable } : {}),
    // SAME `scoped` window as verdicts above — the whole cycle's runs, not just the merged
    // subset, since anything narrower would miss runs mergedSince excludes by definition.
    mast: mastCategoryDistribution(scoped, mapping),
    ...(opts.priorMastCategoryCounts ? { priorMastCategoryCounts: opts.priorMastCategoryCounts } : {}),
    // SAME `scoped` window and mapping as `mast`: one classifier read twice (W1-T91/P23).
    infrastructureEvents: infraEvents,
    infrastructureRecurrence: infrastructureRecurrence(infraEvents),
    taskDefectCounts: taskDefectCounts(scoped, mapping),
    // The FULL ledger, never `scoped`: a followup must survive past the marker window, and
    // W1-T1013 makes "full" the archive ∪ live union, because rotation truncates the live file.
    followups: mineFollowups(followupRecords, opts.openTitles ?? []),
    // FULL `records`: a LIFETIME figure truncated to one cycle is not a lifetime figure (D-10).
    mutationGateLifetime: mutationGateLifetime(records),
    // `opts.sinceTs`-scoped, unlike `mutationGateLifetime`: W1-T165 asks for a per-cycle figure.
    replay: replayPassRateForCycle(records, opts.sinceTs),
    // FULL `records`: a measurement of the fleet's own allocation must not truncate (W1-T2239).
    architectLaneShare: architectLaneShare(records),
    // UNCONDITIONAL, never gated on `opts.planCoherence`. The `{ ok: false, reason }` default
    // renders `unexamined` with a stated reason, never a silent omission or a bare zero (P48).
    planCoherence: planCoherenceRung(
      opts.planCoherence?.monolith ?? { path: "plan/tasks.yaml", text: "" },
      opts.planCoherence?.shards ?? {
        ok: false,
        reason: "buildGather's opts.planCoherence was not supplied (no caller has wired plan/tasks.yaml + plan/tasks.d/ reads in yet)",
      },
    ),
  };
}

/** Render the calibration table (markdown) — printed by --dry-run and fed to the Architect. */
export function calibrationTable(byType: TypeCalibration[]): string {
  const rows = byType.map(
    (t) => `| ${t.type} | ${t.runs} | ${t.merged} | $${t.avgCostUsd.toFixed(3)} | ${t.avgTurns} | $${t.totalCostUsd.toFixed(3)} |`,
  );
  return [
    "| task_type | runs | merged | avg $ | avg turns | total $ |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Render one per-merge cell: a thin-coverage figure is STILL PRINTED and flagged, never laundered
 *  or blanked, and only the zero-merge case renders as a non-numeric marker, never `0` or `NaN`. */
function perMergeCell(value: number | null, turnCoverage: number): string {
  if (value === null) return `n/a (0 merges)`;
  if (turnCoverage < MIN_TURN_COVERAGE_FOR_PER_MERGE) {
    return `${value} ⚠ ${(turnCoverage * 100).toFixed(0)}% coverage — DO NOT USE`;
  }
  return `${value}`;
}

/** Render the per-class calibration table (W1-T167). W1-T930 appends the per-merge columns AFTER
 *  the existing per-run ones; every column already here keeps its order and format. */
export function classCalibrationTable(byClass: ClassCalibration[]): string {
  const rows = byClass.map(
    (c) =>
      `| ${c.taskClass} | ${c.runs} | ${c.merged} | ${(c.mergeRate * 100).toFixed(0)}% | $${c.avgCostUsd.toFixed(3)} | ${c.avgTurns} | $${c.totalCostUsd.toFixed(3)} | ` +
      `${c.totalOutputTokens} | ${c.mergeSource} (n=${c.mergedForDenominator}) | ` +
      `${perMergeCell(c.turnsPerMerge, c.turnCoverage)} | ` +
      `${perMergeCell(c.outputTokensPerMerge, c.turnCoverage)} |`,
  );
  return [
    "| task_class | runs | merged | merge rate | avg $ | avg turns | total $ | output tokens | merge source | turns/merge | output tokens/merge |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Render the per-model-tier weekly-burn table (P34 (d), W1-T250) — is cheap work staying off
 *  the capable model's weekly cap? */
export function modelClassWeeklyBurnTable(byModel: ModelClassWeeklyBurn[]): string {
  const rows = byModel.map(
    (m) => `| ${m.model} | ${m.runs} | ${m.turnsThisWeek} | ${(m.shareOfWeeklyBurn * 100).toFixed(1)}% | $${m.costUsdThisWeek.toFixed(3)} |`,
  );
  return [
    "| model | runs | turns this week | share of weekly burn | $ this week (context only) |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Render the full gather as a human/Architect-readable report. */
export function renderGather(g: RetroGather): string {
  // A throttled, errored or absent gateway must SAY SO BY NAME and never let the SHIPPED section
  // read as a confirmed zero: an empty list gets an INDETERMINATE line, not "(none)" (W1-T132).
  const shippedLines = g.shipped.length
    ? g.shipped.map(
        (s) =>
          `- ${s.taskId} → ${s.prUrl} · $${s.costUsd.toFixed(3)} · ${s.numTurns} turns` +
          (s.annotation ? ` · (${s.annotation})` : ""),
      )
    : g.githubUnavailable
      ? [`- INDETERMINATE — GitHub gateway unavailable (${g.githubUnavailable}); this is NOT a confirmed zero, never read it as "nothing shipped"`]
      : ["- (none)"];
  return [
    `# Retro gather${g.sinceTs ? ` (since ${g.sinceTs})` : " (all-time — first retro)"}`,
    "",
    ...(g.githubUnavailable
      ? [
          `## ⚠ GITHUB GATEWAY UNAVAILABLE — ${g.githubUnavailable}`,
          "The SHIPPED count below is INCOMPLETE — degrading LOUDLY (W1-T132) rather than silently " +
            "presenting a ledger-only read as a complete one. Gate-side merges may exist that this " +
            "gather could not observe; do not treat this run's SHIPPED list as authoritative.",
          "",
        ]
      : []),
    `Runs in scope: ${g.totalRuns}`,
    `Verdicts: ${JSON.stringify(g.verdicts)}`,
    `LEARNINGS entries: ${g.learningsNow} now (${g.learningsNow - g.learningsAtMarker} added since marker)`,
    "",
    "## Calibration (BY TASK TYPE) — the numbers mounts.yaml (W1-T5) needs",
    calibrationTable(g.byType),
    "",
    "## Calibration (BY TASK CLASS, W1-T167) — is the docs/plan-lint routing discount paying off",
    classCalibrationTable(g.byClass),
    "",
    renderArchitectLaneShare(g.architectLaneShare),
    "",
    renderReplayCalibration(g.replay),
    "",
    ...(g.weeklyBurnByModelClass
      ? [
          "## Weekly burn BY MODEL CLASS (P34 clause (d), W1-T250) — objective: weekly-limit burn per model class, never imputed dollars",
          modelClassWeeklyBurnTable(g.weeklyBurnByModelClass),
          "",
        ]
      : []),
    "## Merged since marker (keyed by Remudero-Task)",
    ...(g.mergedSince.length
      ? g.mergedSince.map((r) => `- ${r.taskId} → ${r.prUrl ?? "(no pr)"} · $${r.costUsd.toFixed(3)} · ${r.numTurns} turns`)
      : ["- (none)"]),
    "",
    "## SHIPPED since marker (W1-T51 — ledger ∪ GitHub-derived trailered merges, ownership-asserted)",
    ...shippedLines,
    ...(g.discrepancies.length
      ? ["", "## Discrepancies (ledger vs GitHub — every gate-side addition and rejected foreign trailer)", ...g.discrepancies.map((d) => `- ${d}`)]
      : []),
    "",
    "## Failure distribution BY MAST CATEGORY (W1-T89, ratifies P18 — plan/mast-mapping.yaml)",
    mastDistributionTable(g.mast, g.priorMastCategoryCounts),
    "",
    // Guard-fired blocks are already excluded from `mast`'s agent-failure categories; this is the
    // per-guard/check view plus the per-task defect exclusion the defect stats must honour.
    renderInfrastructure(g.infrastructureEvents, g.infrastructureRecurrence),
    "",
    renderMutationGateLifetime(g.mutationGateLifetime),
    "",
    renderDegradedSuccess(g.degradedSuccess),
    "",
    renderProceduralCandidates(g.proceduralCandidates),
    "",
    renderFollowupCandidates(g.followups),
    // W1-T2642: ALWAYS printed — `g.planCoherence` is never undefined (see its own field doc).
    "",
    renderPlanCoherence(g.planCoherence),
  ].join("\n");
}

// ── §5C plan-health sweep (W1-T20d, Standing rule 20) ─────────────────────
//
// Rules are enforced FORWARD-ONLY at authoring time, so nothing re-checked an already-authored
// task against a rule added after it was written. The retro closes that gap: it re-lints the WHOLE
// open queue every run. Why, measured (W1-T12): docs/forensics/retro.md.

/** Statuses meaning a task already shipped, read from the DECORATIVE yaml `status:` field, which
 *  plan/tasks.yaml's header says is initial-state only: real merge state is DERIVED FROM GITHUB.
 *  Scoped to {@link yamlMergedFallback}, itself pure-unit-test-only. Why production must never
 *  trust it, measured: docs/forensics/retro.md (W1-T367). */
const CLOSED_TASK_STATUSES = new Set(["merged", "done"]);

/** The pure-unit-test-only default {@link planHealthSweep} uses with no derived `isMerged`. */
function yamlMergedFallback(task: Task): boolean {
  return CLOSED_TASK_STATUSES.has(task.status);
}

/** One OPEN task in violation, BLOCKING violations only: a WARN never files a corrective task. */
export interface PlanHealthFlag {
  taskId: string;
  violations: LintViolation[];
}

/** A proposed corrective task, one per violating OPEN task — DATA for the Architect's plan-only PR
 *  to ratify. That is scope, not a prohibition: §12 rule 27 permits automatic filing (W1-T2456). */
export interface CorrectiveTaskProposal {
  /** The OPEN task this proposal corrects. */
  forTaskId: string;
  title: string;
  /** Always `retro#plan-health` — the sweep is the origin, satisfying Rule 17. */
  origin: string;
  violations: LintViolation[];
}

export interface PlanHealthReport {
  flags: PlanHealthFlag[];
  correctiveTasks: CorrectiveTaskProposal[];
}

/** RE-GRADE every OPEN task against every standing rule the deterministic linter encodes — the
 *  forward-only gap Standing rule 20 names. A merged or done task is out of scope. Pure: no I/O
 *  and no plan write, so the corrective tasks are PROPOSALS the Architect stage files.
 *
 *  "Already shipped" is decided by `isMerged`, NEVER by the yaml `status:` field. The
 *  {@link yamlMergedFallback} default exists only so this stays callable from a pure unit test.
 *  An unresolved read is safe to leave in scope: the worst case is one extra advisory proposal. */
export function planHealthSweep(
  tasks: Task[],
  optsFor: (task: Task) => LintOpts = () => ({}),
  isMerged: (task: Task) => boolean = yamlMergedFallback,
): PlanHealthReport {
  const flags: PlanHealthFlag[] = [];
  const correctiveTasks: CorrectiveTaskProposal[] = [];
  for (const task of tasks) {
    if (isMerged(task)) continue; // out of scope — already shipped (derived; see doc above)
    const { violations } = lintTask(task, optsFor(task));
    const blocking = violations.filter((v) => v.severity === "block");
    if (blocking.length === 0) continue; // clean, or WARN-only — nothing to file
    flags.push({ taskId: task.id, violations: blocking });
    correctiveTasks.push({
      forTaskId: task.id,
      title: `Plan-health: fix ${task.id} — ${blocking.map((v) => v.check).join(", ")}`,
      origin: "retro#plan-health",
      violations: blocking,
    });
  }
  return { flags, correctiveTasks };
}

/** Render the plan-health report (markdown) — printed by `--dry-run` and fed to the Architect. */
export function renderPlanHealth(report: PlanHealthReport): string {
  if (report.flags.length === 0) return "## Plan-health sweep\n\nNo violations across the open queue.";
  return [
    "## Plan-health sweep — OPEN queue re-graded against every standing rule",
    "",
    ...report.flags.map(
      (f) => `- ${f.taskId}: ${f.violations.map((v) => `[${v.check}] ${v.message}`).join("; ")}`,
    ),
    "",
    "### Corrective tasks proposed (for the Architect's plan-only PR)",
    ...report.correctiveTasks.map((c) => `- ${c.title} (origin: ${c.origin})`),
  ].join("\n");
}

// ── Mining overruns for a CLASS-level fix (W1-T20d, Standing rule 20/§5C) ──
//
// MASTER-PLAN §5C: if a CLASS of task overruns, propose a CLASS-level fix, not another per-task
// patch. Why: W1-T6, W1-T9 and W1-T12 were three separate rescues for one class before the
// pattern was named — the reactive-diagnosis anti-pattern this kills.

/** Terminal verdicts representing an OVERRUN or blocked outcome worth mining for a class pattern:
 *  every non-merge terminal state EXCEPT the guard-fired classes, which catch a HOST condition —
 *  mining them would propose "decompose this task class" over a populated `~/.bashrc`. DATA, not
 *  hardcoded logic. `already_satisfied` and `task_already_merged` are deliberately ABSENT;
 *  {@link CREDITED_VERDICTS} covers both. Why: docs/forensics/retro.md. */
export const OVERRUN_VERDICTS: ReadonlySet<string> = new Set([
  "blocked",
  "blocked_ci",
  "blocked_review",
  "blocked_budget",
  "blocked_inflight",
  "blocked_git_fetch",
  "blocked_illformed",
  "blocked_transient",
  "no_pr",
  "pr_attribution_failed",
  "failed",
]);

/** A run counts as an overrun: a listed verdict, or a `failed` run naming the max-turns class. */
function isOverrunRun(r: RunSummary): boolean {
  return OVERRUN_VERDICTS.has(r.verdict);
}

/** The (task_type × risk) key — mounts.yaml's own axes, so a mined class maps onto a mount row. */
function overrunClassKey(r: RunSummary): string {
  return `${r.type}:${r.risk ?? "unknown"}`;
}

/** ONE class-level fix per (type, risk) class — never one proposal per task, the anti-pattern. */
export interface ClassOverrunProposal {
  taskType: string;
  risk: string;
  count: number;
  taskIds: string[];
  verdicts: string[];
  proposal: string;
}

/** MINE the ledger's overrun and blocked verdicts for a task-CLASS pattern: ONE proposal per
 *  (type, risk) class meeting `opts.threshold` (default 2), never one per offending task. */
export function mineOverrunClasses(
  runs: RunSummary[],
  opts: { threshold?: number } = {},
): ClassOverrunProposal[] {
  const threshold = opts.threshold ?? 2;
  const byClass = new Map<string, RunSummary[]>();
  for (const r of runs) {
    if (!isOverrunRun(r)) continue;
    const key = overrunClassKey(r);
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  const out: ClassOverrunProposal[] = [];
  for (const [key, rs] of byClass) {
    if (rs.length < threshold) continue; // one incident is not yet a pattern
    const [taskType, risk] = key.split(":");
    out.push({
      taskType,
      risk,
      count: rs.length,
      taskIds: [...new Set(rs.map((r) => r.taskId))].sort(),
      verdicts: [...new Set(rs.map((r) => r.subtype ?? r.verdict))].sort(),
      proposal:
        `${rs.length} overrun(s) across ${taskType}×${risk} (${[...new Set(rs.map((r) => r.taskId))].sort().join(", ")}) ` +
        `— propose ONE class-level fix (raise this class to risk:high / decompose at plan time per Rule 19, ` +
        `or adjust mounts.yaml's ${taskType}×${risk} turn budget), not ${rs.length} per-task patches`,
    });
  }
  out.sort((a, b) => (a.taskType + a.risk < b.taskType + b.risk ? -1 : a.taskType + a.risk > b.taskType + b.risk ? 1 : 0));
  return out;
}

/** Render the mined overrun proposals (markdown) — printed by `--dry-run` and fed to the Architect. */
export function renderOverrunProposals(proposals: ClassOverrunProposal[]): string {
  if (proposals.length === 0) return "## Overrun mining\n\nNo class-level pattern found (each class is below threshold).";
  return ["## Overrun mining — CLASS-level fixes proposed", "", ...proposals.map((p) => `- ${p.proposal}`)].join("\n");
}

// ── Degraded-success mining (W1-T73) ──────────────────────────────────────
//
// The overrun mining above reads FAILURE verdicts. It is blind to a run that ended MERGED — a
// claimed PASS — that took a WEAKER path than its own acceptance criteria named. `review.posted`'s
// `proof_exec` array already recorded that, per criterion, and nothing read it. The signal set
// below is DATA: the next class is a table row, never new mining code.
// Why, with the measured retro: docs/forensics/retro.md.

/** The reduced `review.posted` facts one signal predicate judges against — the run's MOST RECENT
 *  posting, because a run may re-post across fix strikes and only the latest reflects the merge. */
export interface ReviewPostedSummary {
  runId: string;
  taskId: string;
  /** Count of criteria whose `proof_exec` is `executed_pass`/`executed_fail`. */
  executed: number;
  /** Total criteria judged (the ledgered `proof_exec` array's length). */
  total: number;
  /** W1-T72's flag: EVERY criterion floored while at least one dialect proof was written. */
  floorDegraded: boolean;
  /** W1-T63/P10-a: the advisory reviewer's terminal subtype, when logged; absent otherwise. */
  reviewerOutcome?: string;
}

/** Reduce every `review.posted` line to the LATEST posting per run_id. A run that never posted has
 *  no entry: there is nothing to mine. */
export function latestReviewPostedByRun(records: LedgerRecord[]): Map<string, ReviewPostedSummary> {
  const out = new Map<string, ReviewPostedSummary>();
  for (const r of records) {
    if (r.step !== "review.posted" || !r.run_id) continue;
    const proofExec = Array.isArray(r.proof_exec) ? (r.proof_exec as unknown[]) : [];
    const executed = proofExec.filter((p) => p === "executed_pass" || p === "executed_fail").length;
    out.set(String(r.run_id), {
      runId: String(r.run_id),
      taskId: String(r.task_id ?? ""),
      executed,
      total: proofExec.length,
      floorDegraded: r.floor_degraded === true,
      ...(typeof r.reviewer_outcome === "string" ? { reviewerOutcome: r.reviewer_outcome } : {}),
    });
  }
  return out;
}

/** One weaker-path-than-claimed signal — DATA: the next class is a ROW, never new executor code. */
export interface DegradedSuccessSignal {
  /** Stable identifier, named on every finding this signal produces. */
  key: string;
  matches: (r: ReviewPostedSummary) => boolean;
  /** Human-readable explanation, folded into the finding's rendered line. */
  describe: (r: ReviewPostedSummary) => string;
}

/** The shipped signal table. Row 1 is the canonical fixture (RETRO-1784213948025 / W1-T65); row 2
 *  is W1-T73's named second class — proof the set generalises as data. */
export const DEGRADED_SUCCESS_SIGNALS: ReadonlyArray<DegradedSuccessSignal> = [
  {
    key: "zero_executed_dialect",
    matches: (r) => r.total > 0 && r.executed === 0 && r.floorDegraded,
    describe: (r) =>
      `proof_exec ${r.executed}/${r.total} executed, floor_degraded — >=1 dialect-prefixed proof was ` +
      `present yet nothing was OBSERVED on the PR head`,
  },
  {
    key: "reviewer_error_max_turns",
    matches: (r) => r.reviewerOutcome === "error_max_turns",
    describe: () => "reviewer_outcome=error_max_turns — the advisory reviewer never completed a real pass",
  },
];

/** One DEGRADED-SUCCESS finding — a MERGED run whose review.posted matched a signal. */
export interface DegradedSuccessFinding {
  runId: string;
  taskId: string;
  signal: string;
  description: string;
}

/** Mine MERGED runs for degraded-success telemetry (W1-T73): a claimed PASS matching a
 *  {@link DegradedSuccessSignal}. A run matching several emits one finding PER signal. */
export function mineDegradedSuccess(
  runs: RunSummary[],
  records: LedgerRecord[],
  signals: ReadonlyArray<DegradedSuccessSignal> = DEGRADED_SUCCESS_SIGNALS,
): DegradedSuccessFinding[] {
  const posted = latestReviewPostedByRun(records);
  const findings: DegradedSuccessFinding[] = [];
  for (const r of runs) {
    if (r.verdict !== "merged") continue;
    const summary = posted.get(r.runId);
    if (!summary) continue; // no review.posted line for this run — nothing to mine
    for (const signal of signals) {
      if (signal.matches(summary)) {
        findings.push({ runId: r.runId, taskId: r.taskId, signal: signal.key, description: signal.describe(summary) });
      }
    }
  }
  findings.sort((a, b) => {
    const ka = a.taskId + a.signal;
    const kb = b.taskId + b.signal;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return findings;
}

/** Render the mined degraded-success findings (markdown) — printed by `--dry-run` and fed to the Architect. */
export function renderDegradedSuccess(findings: DegradedSuccessFinding[]): string {
  if (findings.length === 0) {
    return "## Degraded-success mining\n\nNo merged run posted a weaker-path-than-claimed signal.";
  }
  return [
    "## Degraded-success mining — a PASS that used a weaker path than its criteria named",
    "",
    ...findings.map((f) => `- ${f.taskId} (${f.runId}): [${f.signal}] ${f.description}`),
  ].join("\n");
}

// ── Procedural-success mining (W1-T87, ratifies P13) ──────────────────────
//
// Everything above mines FAILURE, or a weaker-than-claimed PASS — half the compounding loop P13
// names. The other half was blind: a run that merged CLEAN, first attempt, every criterion
// actually OBSERVED, is a POSITIVE signal whose shape was captured nowhere. This mines that shape
// DETERMINISTICALLY (Rule 2 — the signal set is DATA), so every field is computed before any LLM
// sees it, and {@link phraseProceduralCandidate} is the ONLY place an LLM enters. A shape needs
// `threshold` (default 2) supporting runs. Why: docs/forensics/retro.md.

/** The reduced facts one {@link ProceduralSuccessSignal} judges a MERGED run against. */
export interface ProceduralRunContext {
  runId: string;
  taskId: string;
  taskType: string;
  numTurns: number;
  /** Count of `fix.dispatch` ledger lines for this run — zero means it never needed a fix rung. */
  fixDispatchCount: number;
  /** This run's latest `review.posted` reduction, if any (see {@link latestReviewPostedByRun}). */
  review?: ReviewPostedSummary;
}

/** One deterministic success shape — DATA: the next class is a ROW, never new mining code. */
export interface ProceduralSuccessSignal {
  key: string;
  matches: (ctx: ProceduralRunContext) => boolean;
  describe: (ctx: ProceduralRunContext) => string;
}

/** The shipped signal table (W1-T87/P13): "single-strike merges" and "proof_exec executed_pass patterns" (design note), named exactly. */
export const PROCEDURAL_SUCCESS_SIGNALS: ReadonlyArray<ProceduralSuccessSignal> = [
  {
    key: "clean_single_strike",
    matches: (ctx) => ctx.fixDispatchCount === 0,
    describe: (ctx) => `merged with zero fix.dispatch lines — resolved on the first attempt (${ctx.numTurns} turns)`,
  },
  {
    key: "fully_executed_proof",
    matches: (ctx) =>
      ctx.review !== undefined && ctx.review.total > 0 && ctx.review.executed === ctx.review.total && !ctx.review.floorDegraded,
    describe: (ctx) =>
      `proof_exec ${ctx.review!.executed}/${ctx.review!.total} executed — every criterion OBSERVED, never keyword-floored`,
  },
];

/** Count of `fix.dispatch` ledger lines per `run_id` — zero means a run never needed a fix rung. */
export function fixDispatchCountByRun(records: LedgerRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (r.step !== "fix.dispatch" || !r.run_id) continue;
    const key = String(r.run_id);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** ONE mined procedural-success candidate — a reusable shape shared by >= `threshold` merged runs. */
export interface ProceduralCandidate {
  /** Always `"procedural"` — the tag a drafted learning carries once the Architect ratifies it. */
  kind: "procedural";
  /** Deterministic grouping key: `${taskType}:${signals.join("+")}`. */
  shapeKey: string;
  taskType: string;
  /** The matched signal keys this shape shares, sorted. */
  signals: string[];
  runIds: string[];
  taskIds: string[];
  supportingRuns: number;
}

/** MINE merged runs for a procedure shape shared by at least `opts.threshold` runs (default 2 — a
 *  single success is an anecdote). Pure over the summaries plus raw records: no LLM, no I/O. */
export function mineProceduralCandidates(
  runs: RunSummary[],
  records: LedgerRecord[],
  opts: { threshold?: number; signals?: ReadonlyArray<ProceduralSuccessSignal> } = {},
): ProceduralCandidate[] {
  const threshold = opts.threshold ?? 2;
  const signals = opts.signals ?? PROCEDURAL_SUCCESS_SIGNALS;
  const fixCounts = fixDispatchCountByRun(records);
  const reviewByRun = latestReviewPostedByRun(records);

  const byShape = new Map<string, RunSummary[]>();
  const shapeSignals = new Map<string, string[]>();
  for (const r of runs) {
    if (r.verdict !== "merged") continue;
    const ctx: ProceduralRunContext = {
      runId: r.runId,
      taskId: r.taskId,
      taskType: r.type,
      numTurns: r.numTurns,
      fixDispatchCount: fixCounts.get(r.runId) ?? 0,
      review: reviewByRun.get(r.runId),
    };
    const matched = signals
      .filter((s) => s.matches(ctx))
      .map((s) => s.key)
      .sort();
    if (matched.length === 0) continue; // nothing this run demonstrates — not a candidate
    const shapeKey = `${r.type}:${matched.join("+")}`;
    const arr = byShape.get(shapeKey) ?? [];
    arr.push(r);
    byShape.set(shapeKey, arr);
    shapeSignals.set(shapeKey, matched);
  }

  const out: ProceduralCandidate[] = [];
  for (const [shapeKey, rs] of byShape) {
    if (rs.length < threshold) continue; // one success is an anecdote, not a procedure
    const taskType = shapeKey.slice(0, shapeKey.indexOf(":"));
    out.push({
      kind: "procedural",
      shapeKey,
      taskType,
      signals: shapeSignals.get(shapeKey) ?? [],
      runIds: [...new Set(rs.map((r) => r.runId))].sort(),
      taskIds: [...new Set(rs.map((r) => r.taskId))].sort(),
      supportingRuns: rs.length,
    });
  }
  out.sort((a, b) => (a.shapeKey < b.shapeKey ? -1 : a.shapeKey > b.shapeKey ? 1 : 0));
  return out;
}

/** Render the mined procedural candidates (markdown) — printed by `--dry-run` and fed to the Architect, which drafts the actual learning. W1-T2456: this cited "Standing rule 15", which carries no such doctrine — see §12 rule 27. */
export function renderProceduralCandidates(candidates: ProceduralCandidate[]): string {
  if (candidates.length === 0) {
    return "## Procedural-success mining (P13)\n\nNo shape shared by >=2 merged runs yet.";
  }
  return [
    "## Procedural-success mining (P13) — reusable shapes proposed for a procedural learning",
    "",
    ...candidates.map((c) => `- ${c.taskType} × [${c.signals.join(", ")}] — ${c.supportingRuns} run(s): ${c.taskIds.join(", ")}`),
  ].join("\n");
}

// ── Follow-up harvest (W1-T105) ────────────────────────────────────────────
//
// The operator's requirement, verbatim: "ensure that if any implementations come back with
// follow-up research, actions, tasks, etc — they get added to the plan." A worker's REPORT may
// carry an optional `## Follow-ups` section (§2 OUTPUT CONTRACT), and run-task.ts ledgers each
// entry as a `report.followups` event with provenance. This module mines that stream into
// proposal candidates (W1-T2456: §12 rule 27 governs).

/** One followup entry off a `report.followups` event, with provenance and a stable `entryId`. */
export interface FollowupCandidate {
  entryId: string;
  type: "research" | "task" | "action";
  text: string;
  runId: string;
  taskId: string;
  /** Set ONLY when this entry lands in `deduped` through a NAMED refusal arm owing the reader more
   *  than "matched an open title" — currently just {@link decorativeStatusFlipReason}. */
  reason?: string;
  prUrl?: string;
}

/** Pure mining result: what to show the Architect, what was already covered, and the ledger lines
 *  the CALLER appends on a real pass — never `mineFollowups`, so `--dry-run` stays a pure read. */
export interface FollowupHarvest {
  candidates: FollowupCandidate[];
  deduped: FollowupCandidate[];
  harvestLines: LedgerLine[];
}

/** Significant words only (>=3 chars), so "a"/"is"/"to" noise cannot inflate overlap. */
function significantWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
}

/** True when `text` is ALREADY substantially covered by a title — at least 60% of its own
 *  significant words appear in `titleWords`. Deliberately asymmetric, because a followup note is
 *  terser than the title it duplicates. The title's word set is PRE-COMPUTED once per title. */
function followupMatchesTitle(text: string, titleWords: Set<string>): boolean {
  const textWords = significantWords(text);
  if (textWords.size === 0) return false;
  let overlap = 0;
  for (const w of textWords) if (titleWords.has(w)) overlap++;
  return overlap / textWords.size >= 0.6;
}

// ── W1-T2638: refuse a "flip the decorative yaml `status:` field" follow-up at harvest ─────
//
// Dispatch eligibility and dependency satisfaction both resolve through the GitHub-derived
// projection, never a task's yaml `status:` field (W1-T367) — but that refutation lives in a shard
// `mineFollowups` never reads, so the class recurred a FOURTH time. This is the narrowest place it
// can die: BEFORE a candidate becomes a proposal id.
//
// THE SCOPE FENCE IS THE HALF MOST LIKELY TO BE GOT WRONG. This refuses ONLY an entry editing a
// task's yaml `status:` toward a merged-meaning value or one outside TASK_STATUSES. It never
// refuses an entry about `blocked`, the one status that genuinely gates dispatch, nor the
// `retirement:` field, nor the derived projection. Ambiguity resolves toward HARVESTING, never a
// silent drop. Why: docs/forensics/retro.md.

/** TASK_STATUSES (plan.ts:15-26), mirrored rather than imported — this module stays a leaf over
 *  the ledger and gains no dependency on the plan loader for one closed-vocabulary check. */
const KNOWN_TASK_STATUSES = new Set([
  "queued",
  "recon",
  "prompted",
  "running",
  "review",
  "fixing",
  "diagnosing",
  "blocked",
  "merged",
  "done",
]);

/** plan.ts's `MERGED_STATUSES`. A follow-up asking to hand-set `status:` to either is the shape
 *  W1-T367 refutes. */
const MERGED_MEANING_STATUSES = new Set(["merged", "done"]);

/** Matches an entry naming the yaml `status:` field itself, anchored on the colon spelling all
 *  four recurrences used — and NOT `retirement:`, a bare mention of "status", or the derived
 *  projection. EXPORTED so a test drives both arms by identifier, per the `_RE` census. */
export const STATUS_FIELD_RE = /`?status:`?\s*field/i;

/** The value a `STATUS_FIELD_RE`-matching entry asks to set the field TO, or `undefined` with no
 *  unambiguous target. Callers treat `undefined` as "leave it alone": ambiguity always harvests. */
function statusFlipTarget(text: string): string | undefined {
  const fromTo = text.match(/field\s+from\s+[`'"]?[a-z0-9]+[`'"]?\s+to\s+[`'"]?([a-z0-9]+)[`'"]?/i);
  if (fromTo) return fromTo[1]!.toLowerCase();
  const bareTo = text.match(/status:`?\s*field[^.]*?\bto\s+[`'"]?([a-z0-9]+)[`'"]?/i);
  if (bareTo) return bareTo[1]!.toLowerCase();
  return undefined;
}

/** `undefined` unless `text` is, in scope, a decorative yaml `status:` flip — see the section doc
 *  for the fence. In scope it returns the REASON to record: the refutation, the fail-close an
 *  out-of-schema value causes, and the sanctioned remedy. The reason must teach, not just decline. */
function decorativeStatusFlipReason(text: string): string | undefined {
  if (!STATUS_FIELD_RE.test(text)) return undefined;
  const target = statusFlipTarget(text);
  if (!target || target === "blocked") return undefined;
  const outOfVocabulary = !KNOWN_TASK_STATUSES.has(target);
  if (!outOfVocabulary && !MERGED_MEANING_STATUSES.has(target)) return undefined;
  return (
    "decorative yaml `status:` flip refused (W1-T2638, refutation per W1-T367): dispatch " +
    "eligibility (drain.ts's isDispatchEligible) resolves through isMerged's GitHub-derived " +
    "projection before ever comparing t.status, and dependency satisfaction runs through an " +
    "injected MergedResolver whose yaml-trusting default (plan.ts's yamlStatusMerged) is scoped " +
    "to fixture tests only — so the field is decorative and neither harm this class of entry " +
    "cites is reachable" +
    (outOfVocabulary
      ? `; "${target}" is additionally not a TASK_STATUSES member, so writing it fail-closes ` +
        "loadPlan over the whole merged plan"
      : "") +
    ". If the task named here is genuinely uncredited, the sanctioned remedy is an operator " +
    "correction (`rmd correct <id> --pr <n>`, W1-T75), never a yaml edit."
  );
}

/** Mine every `report.followups` event for entries not yet harvested or deduped. PURE over
 *  `records`, idempotent, and never writing a ledger line itself. An entry already named by a
 *  `followup.harvested` or `.deduped` line is skipped: a followup must survive PAST the marker
 *  window, so this module tracks it explicitly rather than relying on marker scoping.
 *
 *  The entry id is `run_id:ts:index` (W1-T2252). `run_id` alone is not enough: one run emits
 *  `report.followups` from up to five call sites, and with `index` restarting per row a second
 *  row's entry 0 collided onto the first row's id and was silently dropped. Why, with the measured
 *  collision rate: docs/forensics/retro.md. `openTitles` is the caller's set of open titles; an
 *  entry largely covered by one is DEDUPED rather than minted twice. */
export function mineFollowups(records: LedgerRecord[], openTitles: string[] = []): FollowupHarvest {
  const processed = new Set<string>();
  for (const r of records) {
    if (r.step === "followup.harvested" || r.step === "followup.deduped") {
      const id = typeof r.entry_id === "string" ? r.entry_id : undefined;
      if (id) processed.add(id);
    }
  }
  // Tokenized ONCE per title, not per (entry × title): `openTitles` is the same set throughout.
  const openTitleWordSets = openTitles.map(significantWords);
  const candidates: FollowupCandidate[] = [];
  const deduped: FollowupCandidate[] = [];
  const harvestLines: LedgerLine[] = [];
  for (const r of records) {
    if (r.step !== "report.followups") continue;
    const entries = Array.isArray(r.entries) ? (r.entries as Array<{ type?: string; text?: string }>) : [];
    entries.forEach((e, i) => {
      const type = e?.type;
      const text = e?.text;
      if (type !== "research" && type !== "task" && type !== "action") return;
      if (typeof text !== "string" || !text.trim()) return;
      const entryId = `${r.run_id ?? "?"}:${r.ts ?? "?"}:${i}`;
      if (processed.has(entryId)) return;
      const candidate: FollowupCandidate = {
        entryId,
        type,
        text,
        runId: String(r.run_id ?? "?"),
        taskId: String(r.task_id ?? "?"),
        ...(typeof r.pr_url === "string" ? { prUrl: r.pr_url } : {}),
      };
      const statusFlipReason = decorativeStatusFlipReason(text);
      const isDup = statusFlipReason !== undefined || openTitleWordSets.some((titleWords) => followupMatchesTitle(text, titleWords));
      if (isDup) {
        deduped.push(statusFlipReason !== undefined ? { ...candidate, reason: statusFlipReason } : candidate);
        harvestLines.push({
          run_id: candidate.runId,
          task_id: candidate.taskId,
          step: "followup.deduped",
          entry_id: entryId,
          type,
          text,
          ...(statusFlipReason !== undefined ? { reason: statusFlipReason } : {}),
        });
      } else {
        candidates.push(candidate);
        harvestLines.push({ run_id: candidate.runId, task_id: candidate.taskId, step: "followup.harvested", entry_id: entryId, type, text });
      }
    });
  }
  return { candidates, deduped, harvestLines };
}

/** Dependencies for {@link recordFollowupHarvest} — a test spies on `writeLedger`, not disk. */
export interface FollowupHarvestDeps {
  ledgerPath: string;
  writeLedger?: typeof appendLedger;
}

/** Append every {@link FollowupHarvest.harvestLines} entry so a later {@link mineFollowups} pass
 *  mints neither the candidate nor the dedup match again. Invoked ONLY on a real retro. */
export function recordFollowupHarvest(harvest: FollowupHarvest, deps: FollowupHarvestDeps): void {
  const writeLedger = deps.writeLedger ?? appendLedger;
  for (const line of harvest.harvestLines) writeLedger(deps.ledgerPath, line);
}

/** Render the follow-up harvest — every line a CANDIDATE citing its origin verbatim, never an
 *  instruction to file. W1-T2456: the old "Rule 15" citation was false; §12 rule 27 governs. */
export function renderFollowupCandidates(harvest: FollowupHarvest): string {
  const lines = [
    // W1-T2456: the "(rule 15)" this heading cited carries no such doctrine. The harvest still
    // emits candidates rather than tasks, so only the false citation was dropped.
    "## Follow-up harvest (W1-T105) — PROPOSAL CANDIDATES, not filed by this rung",
    "",
  ];
  if (harvest.candidates.length === 0) {
    lines.push("No unharvested follow-up this cycle.");
  } else {
    lines.push(
      ...harvest.candidates.map(
        (c) => `- [${c.type}] ${c.text} — from ${c.taskId} (${c.runId}${c.prUrl ? `, ${c.prUrl}` : ""})`,
      ),
    );
  }
  if (harvest.deduped.length > 0) {
    lines.push(
      "",
      `(${harvest.deduped.length} entr${harvest.deduped.length === 1 ? "y" : "ies"} matched an existing open ` +
        "title and was not re-minted: " +
        harvest.deduped.map((d) => `"${d.text}"`).join("; ") +
        ")",
    );
  }
  return lines.join("\n");
}

// ── Follow-up routing (W1-T2458) ───────────────────────────────────────────
//
// `mineFollowups` finds candidates; until this task nothing read them back, and no plan task had
// ever been filed from one. `routeFollowupsToRegistry` is the missing consumer: it files each
// still-open candidate through the SAME single writer the other lanes use.
//
// THE ROUTING CHOICE IS THIS LANE'S OWN, NOT A RULE'S. A routed follow-up is a proposal candidate
// for the inbox's tiering and an operator's `rmd approve`, not a task this lane commits directly.
// §12 rule 27 permits the fleet to file its own work; this is a deliberate narrower choice.
// Why, measured: docs/forensics/retro.md.

/** `FollowupEntry.type` semantics — defined HERE because nothing previously defined what the three
 *  worker-report prefixes MEAN. Any code branching on `.type` cites this rather than guessing.
 *  "research" (an open question) and "task" (work out of the worker's own one-concern scope) are
 *  ROUTABLE, because a proposal IS a candidate plan task. "action", an ask of a HUMAN, is NOT:
 *  minting it would hand `classifyProposal` something to tier as though it were buildable. A
 *  declined entry stays harvested, never promoted. */
export const FOLLOWUP_TYPE_ROUTES: Readonly<Record<FollowupCandidate["type"], "propose" | "not-plan-shaped">> = {
  research: "propose",
  task: "propose",
  action: "not-plan-shaped",
};

/** One candidate's routing outcome. A decline always NAMES the arm that declined it, never a bare
 *  boolean, so a reader can tell the five apart without re-deriving them from `harvest`. */
export type FollowupRouteOutcome =
  | { candidate: FollowupCandidate; routed: true; proposalId: string }
  | {
      candidate: FollowupCandidate;
      routed: false;
      arm: "title-dedup" | "type-not-plan-shaped" | "self-referential" | "dispatch-only" | "settled-question";
      reason: string;
    };

/** True when `text`'s own ask IS "implement `taskId`" — a follow-up whose text restates its own
 *  declaring task back at the plan, so routing it would duplicate an existing plan record.
 *  DELIBERATELY NARROW: only a LEADING, word-bounded "implement <taskId>" matches, because the
 *  dangerous direction is dropping a genuine discovery, not admitting a duplicate the registry
 *  tolerates. Shared verbatim by {@link isSelfReferentialFollowup} and
 *  {@link pruneSelfReferentialFollowups}. Why, measured: docs/forensics/retro.md. */
function textAsksToImplementItsOwnTask(text: string, taskId: string): boolean {
  const trimmed = taskId.trim();
  if (!trimmed || trimmed === "?") return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*implement\\s+${escaped}\\b`, "i").test(text);
}

/** Admission-time self-reference check: does `candidate.text` simply ask to implement the task
 *  that declared it? Both fields already ride on every candidate, so this needs no new read and no
 *  merged/queued distinction — which is why it reaches the still-queued majority (W1-T2563). */
export function isSelfReferentialFollowup(candidate: FollowupCandidate): boolean {
  return textAsksToImplementItsOwnTask(candidate.text, candidate.taskId);
}

// ── W1-T2613: the third refusal arm — "dispatch-only" ──────────────────────────
//
// Two routed proposals asked for NOTHING but "task X is ready, hand it off", and neither the
// title-dedup arm nor the type arm declines either. Why, measured: docs/forensics/retro.md.
//
// THE SIGNAL, deliberately narrow: the entry names its OWN originating task — always an
// already-filed id — AND carries a bare-dispatch marker phrase AND no other action-verb marker. A
// cross-task ask is NOT this arm's shape and stays routed.
//
// HEURISTIC OVER FREE PROSE, NOT A PARSER. A live entry pairing a dispatch marker with real work
// worded outside the action-verb list is WRONGLY DECLINED here, alongside every entry it declines
// correctly — named in each declined outcome's own `reason`, never hidden behind a "0 false
// declines" claim this predicate cannot back.

/** Marker phrases signalling a followup's text is a BARE DISPATCH ask. Free prose, so a heuristic
 *  — see the arm's doc for the false-decline risk it knowingly accepts. */
const DISPATCH_ONLY_MARKERS: RegExp[] = [/\bready to implement\b/i, /\bready to build\b/i, /\bhand(?: it)? off\b/i];

/** Verbs meaning the entry names REAL follow-up work, not only a dispatch ask. ANY match overrides
 *  {@link DISPATCH_ONLY_MARKERS}, which keeps the W1-T2470 control routed rather than declined. */
const NAMES_REAL_WORK_MARKERS: RegExp[] = [/\bre-?run\b/i, /\bverify\b/i, /\bclose[ds]?\b/i, /\bcheck\b/i, /\baudit\b/i];

/** `undefined` unless `candidate` is a BARE dispatch ask for its own already-filed originating
 *  task. Any id it returns is `candidate.taskId` itself, never a merely-mentioned one. */
function dispatchOnlyReferent(candidate: FollowupCandidate): string | undefined {
  if (candidate.taskId === "?" || candidate.taskId === "") return undefined;
  const escapedId = candidate.taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`\\b${escapedId}\\b`).test(candidate.text)) return undefined;
  if (!DISPATCH_ONLY_MARKERS.some((re) => re.test(candidate.text))) return undefined;
  if (NAMES_REAL_WORK_MARKERS.some((re) => re.test(candidate.text))) return undefined;
  return candidate.taskId;
}

// ── W1-T2645: the fifth refusal arm — "settled-question" ────────────────────────
//
// None of the four earlier arms asks whether a candidate's REMEDY contradicts a question the plan
// has already, on record, decided. The seed case is the FOURTH recorded instance of one
// misdiagnosis: that a task's yaml `status:` field drives dispatch. `followupMatchesTitle` cannot
// catch it (no open title matches) and `decorativeStatusFlipReason` cannot either (its regex needs
// the literal word "field", which the phrasing lacks).
//
// THE TABLE IS DATA, NOT BRANCHES: a second settled question later is a ROW in
// `SETTLED_QUESTIONS`, never a new `if` in `routeFollowupsToRegistry`. FAIL-OPEN IS THE CORRECT
// POLARITY here, the opposite of this repo's usual default: refusing a genuine follow-up loses
// work permanently, so each row's predicate matches the proposed-WRITE shape, never the bare word
// "status". THIS ARM DECLINES PROMOTION ONLY, NEVER THE HARVEST.
// Why, with the corpus entry verbatim: docs/forensics/retro.md.

/** One row of the settled-question table: a candidate whose remedy re-decides a question the plan
 *  has already, on record, answered. DATA, never a code branch — see the section doc above. */
export interface SettledQuestionRow {
  id: string;
  /** True when `text` proposes the exact write this row's question was decided against. Narrow by
   *  design — a proposed WRITE, never a word's appearance — so ambiguity routes. */
  matches: (text: string) => boolean;
  /** The record that already decided this question, cited so a reader can verify the decline
   *  instead of re-deriving it. */
  decidedIn: string;
  /** Reason text for the routing outcome — names `decidedIn` verbatim so a reader can tell this
   *  decline from every other arm's without re-deriving it. */
  reason: string;
}

/** Matches a candidate proposing to hand-write a task's yaml `status:` field to a new value.
 *  Deliberately narrower than `STATUS_FIELD_RE`, which needs the literal word "field": this is the
 *  routing gate and must catch the phrasing that guard does not. Never a bare "status" mention. */
export const TASK_STATUS_FIELD_WRITE_RE =
  /\bstatus:\s*(?:`?\s*field`?\s+)?from\s+[`'"]?[a-z][\w-]*[`'"]?\s+to\s+[`'"]?[a-z][\w-]*[`'"]?/i;

/** Seeded with EXACTLY the one row four independent recurrences of a single misdiagnosis justify.
 *  A second settled question later is another row, never a code change to the router. */
export const SETTLED_QUESTIONS: readonly SettledQuestionRow[] = [
  {
    id: "task-status-field-is-decorative",
    matches: (text) => TASK_STATUS_FIELD_WRITE_RE.test(text),
    decidedIn:
      "plan/tasks.yaml's own header (status: is decorative/initial-state only) and " +
      "src/lib/plan.ts's TASK_STATUSES enum (W1-T367; DECISIONS.md W1-T1/W1-T12a/W1-T99)",
    reason:
      "a task's yaml `status:` field is decorative, not a dispatch input — the dispatch " +
      "predicate (drain.ts) and dependency satisfaction both resolve through a GitHub-derived " +
      "projection, never through this field (W1-T367 measured 248 of 359 tasks, 69%, carrying " +
      "`status: queued` while merged), and DECISIONS.md has already answered this exact " +
      "question three times (W1-T1, W1-T12a, W1-T99) on the same ground — hand-syncing one " +
      "shard's field re-decides a question already on record rather than correcting the actual " +
      "residue (a missing Remudero-Task trailer, P46/P56/W1-T367's territory, never a field " +
      "sync). See plan/tasks.yaml's header and src/lib/plan.ts's TASK_STATUSES enum.",
  },
];

/** The first row of `rows` whose predicate fires on `text`, or `undefined`. `rows` is a plain
 *  parameter, not a closure, so a test proves the table is DATA by passing `[]` or an added row. */
export function findSettledQuestion(text: string, rows: readonly SettledQuestionRow[] = SETTLED_QUESTIONS): SettledQuestionRow | undefined {
  return rows.find((row) => row.matches(text));
}

export interface RouteFollowupsDeps {
  registryPath: string;
  /** Injectable, defaulting to {@link SETTLED_QUESTIONS}, so a test proves the arm is DATA: `[]`
   *  routes every candidate as before, and an added row declines one with no code change. */
  settledQuestions?: readonly SettledQuestionRow[];
  /** Injectable — production takes `updateProposalRegistry` (the W1-T240 single writer),
   *  mirroring board-review.ts's `updateRegistry` seam so a test never touches disk. */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
}

/** Stable, deterministic registry id for one followup candidate: `entryId` already carries
 *  `mineFollowups`'s uniqueness key, so the SAME entry always resolves to the SAME id, which is
 *  what lets the existing-id check refuse to re-add it. Never derived from `text`. */
export function followupProposalId(candidate: FollowupCandidate): string {
  return `followup:${candidate.entryId}`;
}

/** Route one `mineFollowups` harvest into the ACTIVE-proposal registry through the single writer
 *  (inbox.ts's `updateProposalRegistry`) the other lanes already use.
 *
 *  FIVE REFUSAL ARMS, each named on its own outcome and none re-implemented here:
 *    - `"title-dedup"`: `harvest.deduped`, `mineFollowups`'s own `followupMatchesTitle` arm.
 *    - `"type-not-plan-shaped"`: {@link FOLLOWUP_TYPE_ROUTES} says the type is not routable.
 *    - `"settled-question"` (W1-T2645): the text re-decides a question already on record. Checked
 *      FIRST — such a candidate should never reach a drafting slot.
 *    - `"self-referential"` (W1-T2617): the ask IS the task that declared it.
 *    - `"dispatch-only"` (W1-T2613): a bare ask to dispatch its own already-filed task.
 *
 *  EVERY MINTED PROPOSAL CARRIES `evidenceAnchors: []`, STATED, NEVER SYNTHESIZED: a followup is
 *  free prose with no `git grep`-able pattern, and inventing one would hand `classifyProposal` a
 *  fabricated claim. The candidate's own ids ride in the summary — enough for ATTRIBUTION, never
 *  for the evidence-anchor arm. IDEMPOTENT: the same {@link followupProposalId} is never
 *  re-added. */
export function routeFollowupsToRegistry(harvest: FollowupHarvest, deps: RouteFollowupsDeps): FollowupRouteOutcome[] {
  const updateRegistry = deps.updateRegistry ?? updateProposalRegistry;
  const settledQuestions = deps.settledQuestions ?? SETTLED_QUESTIONS;
  const outcomes: FollowupRouteOutcome[] = [];

  for (const candidate of harvest.deduped) {
    outcomes.push({
      candidate,
      routed: false,
      arm: "title-dedup",
      reason: "already declined by mineFollowups' own followupMatchesTitle dedup arm (harvest.deduped)",
    });
  }

  const routable: FollowupCandidate[] = [];
  for (const candidate of harvest.candidates) {
    if (FOLLOWUP_TYPE_ROUTES[candidate.type] !== "propose") {
      outcomes.push({
        candidate,
        routed: false,
        arm: "type-not-plan-shaped",
        reason: `"${candidate.type}" is an operator ask, not plan-shaped work (FOLLOWUP_TYPE_ROUTES)`,
      });
      continue;
    }
    const settledQuestion = findSettledQuestion(candidate.text, settledQuestions);
    if (settledQuestion !== undefined) {
      outcomes.push({
        candidate,
        routed: false,
        arm: "settled-question",
        reason: `${settledQuestion.reason} (decided in: ${settledQuestion.decidedIn})`,
      });
      continue;
    }
    const dispatchOnlyId = dispatchOnlyReferent(candidate);
    if (dispatchOnlyId !== undefined) {
      outcomes.push({
        candidate,
        routed: false,
        arm: "dispatch-only",
        reason:
          `text asks only to dispatch its own already-filed task (${dispatchOnlyId}) — a bare-` +
          `dispatch marker phrase with no other action-verb marker — so ratifying this as a ` +
          `proposal could only duplicate a task already in the plan (W1-T2613). HEURISTIC OVER ` +
          `FREE PROSE, NOT A PARSER: a live entry that pairs a dispatch marker with real ` +
          `follow-up work worded outside this arm's action-verb list (re-run/verify/close/` +
          `check/audit) is wrongly declined here, right alongside every entry it declines ` +
          `correctly.`,
      });
      continue;
    }
    if (isSelfReferentialFollowup(candidate)) {
      outcomes.push({
        candidate,
        routed: false,
        arm: "self-referential",
        reason:
          `this entry's own text asks to implement ${candidate.taskId} — the SAME task that ` +
          `declared it — so routing it would duplicate a plan record that already exists on ` +
          `whichever side of the merge ${candidate.taskId} falls (isSelfReferentialFollowup)`,
      });
      continue;
    }
    routable.push(candidate);
  }

  if (routable.length > 0) {
    updateRegistry(deps.registryPath, (current) => {
      const existingIds = new Set(current.map((p) => p.id));
      const additions: Proposal[] = routable
        .filter((c) => !existingIds.has(followupProposalId(c)))
        .map((c) => ({
          id: followupProposalId(c),
          summary:
            `follow-up harvest [${c.type}]: ${c.text} — from ${c.taskId} (run ${c.runId}` +
            `${c.prUrl ? `, ${c.prUrl}` : ""})`,
          // Stated, never synthesized — see this function's own doc for why a fabricated
          // git-grep pattern would be worse than an honest empty set.
          evidenceAnchors: [] as EvidenceAnchor[],
        }));
      return additions.length > 0 ? [...current, ...additions] : null;
    });
    for (const candidate of routable) {
      outcomes.push({ candidate, routed: true, proposalId: followupProposalId(candidate) });
    }
  }

  return outcomes;
}

// ── Follow-up retirement (W1-T2563) ────────────────────────────────────────
//
// `routeFollowupsToRegistry` appends every routable candidate and refuses to re-add one already
// present. THE GAP IS THAT NOTHING EVER REMOVES ONE: the registry only grows.
//
// A routed follow-up cannot be retired the way board-review findings are (W1-T2451): their
// referent is a `BoardItem.id` a batched read resolves, while a followup's `evidenceAnchors: []`
// is permanent by design, so an anchor-drift check would read vacuously true and retire the whole
// population on its first pass. THE REFERENT THIS FAMILY DOES CARRY is the originating TASK,
// stated in the minted summary; {@link followupOriginatingTaskId} recovers it by PARSING THE
// SUMMARY AT READ TIME, so this needs no registry migration.
//
// THE SIGNAL: the originating task has MERGED. Chosen because it is the one candidate already
// available, NOT because it is reliable. IT IS NOT: a merged task can leave real follow-up work
// undone, so this retires some LIVE candidates alongside settled ones, and EVERY OUTCOME NAMES
// THAT RISK in its own `reason`. Why, measured: docs/forensics/retro.md.

/** The ONE batched read this pass needs: which task referents have merged, read ONCE per pass.
 *  `"unreadable"` leaves every proposal alone — cannot-observe means WAIT (W1-T130). */
export type FollowupReferentRead = { kind: "ok"; merged: ReadonlySet<string> } | { kind: "unreadable" };

/** Recover a routed follow-up's originating task id from its own minted summary, parsed at read
 *  time rather than stored as a structured field. Returns `undefined` for anything that is not a
 *  `followup:` proposal, or a foreign summary — left alone rather than given a guessed referent. */
export function followupOriginatingTaskId(proposal: Proposal): string | undefined {
  if (!proposal.id.startsWith("followup:")) return undefined;
  return /— from (\S+) \(run /.exec(proposal.summary)?.[1];
}

/** One proposal this pass actually retired, naming BOTH what settled it and the false-positive
 *  risk that decision carries, rather than claiming none. */
export interface FollowupRetireOutcome {
  proposalId: string;
  taskId: string;
  reason: string;
}

export interface RetireFollowupsDeps {
  registryPath: string;
  /** Injectable — production takes {@link updateProposalRegistry}, mirroring
   *  {@link RouteFollowupsDeps.updateRegistry}'s own test seam. */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
}

/** Retire every routed follow-up whose originating task has merged — the missing counterpart to
 *  the append-only write. Unlike board-review's retirement this ACTUALLY REMOVES the entry,
 *  because the measured growth is a registry-SIZE problem. `"unreadable"` retires nothing. */
export function retireSettledFollowups(read: FollowupReferentRead, deps: RetireFollowupsDeps): FollowupRetireOutcome[] {
  if (read.kind === "unreadable") return [];

  const updateRegistry = deps.updateRegistry ?? updateProposalRegistry;
  let outcomes: FollowupRetireOutcome[] = [];

  updateRegistry(deps.registryPath, (current) => {
    const settled: FollowupRetireOutcome[] = [];
    for (const p of current) {
      const taskId = followupOriginatingTaskId(p);
      if (taskId === undefined || !read.merged.has(taskId)) continue;
      settled.push({
        proposalId: p.id,
        taskId,
        reason:
          `${p.id}'s originating task (${taskId}) has merged, so this routed follow-up is retired ` +
          `and removed from the registry. KNOWN FALSE-POSITIVE RISK, NAMED RATHER THAN CLAIMED ` +
          `AWAY: a task can merge while leaving real follow-up work undone — this signal cannot ` +
          `tell that still-live candidate apart from a genuinely settled one, and wrongly retires ` +
          `it right alongside every proposal it retires correctly.`,
      });
    }
    outcomes = settled;
    if (settled.length === 0) return null;
    const retiredIds = new Set(settled.map((o) => o.proposalId));
    return current.filter((p) => !retiredIds.has(p.id));
  });

  return outcomes;
}

// ── Self-referential follow-up prune (W1-T2617) ─────────────────────────────
//
// `isSelfReferentialFollowup` stops FUTURE self-referential mints and does nothing for the rows
// already in the registry. THE W1-T190 DOCTRINE, verbatim: heal existing drift, not only future
// mints. This is that heal — a one-time pass, through the same single writer, in ONE write.

/** Parse a routed follow-up's own free text back out of its minted `summary` — the same string
 *  this family parses for its `taskId`. `undefined` for anything not matching the minted shape. */
function followupSummaryText(summary: string): string | undefined {
  return /^follow-up harvest \[[a-z]+\]: ([\s\S]*) — from \S+ \(run /.exec(summary)?.[1];
}

/** One proposal this pass actually removed, naming what it matched — mirrors
 *  {@link FollowupRetireOutcome}'s shape, so a reader of retirement outcomes reads this free. */
export interface FollowupPruneOutcome {
  proposalId: string;
  taskId: string;
  reason: string;
}

export interface PruneFollowupsDeps {
  registryPath: string;
  /** Injectable — production takes {@link updateProposalRegistry}, mirroring the same test seam
   *  {@link RouteFollowupsDeps} and {@link RetireFollowupsDeps} use. */
  updateRegistry?: (
    registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
    opts?: UpdateProposalRegistryOpts,
  ) => Proposal[] | null;
}

/** Apply {@link isSelfReferentialFollowup}'s predicate — parsed back off each already-minted
 *  proposal's `summary`, since this population predates the admission arm — and remove every match
 *  in ONE write, as {@link retireSettledFollowups} does. NEEDS NO BATCHED READ: the predicate is
 *  local to each summary, so a second pass finds nothing left to remove. A foreign summary is left
 *  alone and never guessed at. */
export function pruneSelfReferentialFollowups(deps: PruneFollowupsDeps): FollowupPruneOutcome[] {
  const updateRegistry = deps.updateRegistry ?? updateProposalRegistry;
  let outcomes: FollowupPruneOutcome[] = [];

  updateRegistry(deps.registryPath, (current) => {
    const matched: FollowupPruneOutcome[] = [];
    for (const p of current) {
      const taskId = followupOriginatingTaskId(p);
      if (taskId === undefined) continue;
      const text = followupSummaryText(p.summary);
      if (text === undefined) continue;
      if (!textAsksToImplementItsOwnTask(text, taskId)) continue;
      matched.push({
        proposalId: p.id,
        taskId,
        reason:
          `${p.id}'s own text asks to implement ${taskId} — the SAME task that declared it — so ` +
          `it duplicates a plan record that already exists on whichever side of the merge ` +
          `${taskId} falls. Pruned by the SAME predicate (isSelfReferentialFollowup /` +
          `textAsksToImplementItsOwnTask) routeFollowupsToRegistry now refuses at admission time.`,
      });
    }
    outcomes = matched;
    if (matched.length === 0) return null;
    const prunedIds = new Set(matched.map((o) => o.proposalId));
    return current.filter((p) => !prunedIds.has(p.id));
  });

  return outcomes;
}

// ── Phrasing — the ONLY step where an LLM enters (W1-T87/P13) ────────────

/** Injected phrasing dependency — receives ONLY the already-mined {@link ProceduralCandidate},
 *  never raw records or other candidates: evidence is deterministic, the model only phrases. */
export interface ProceduralPhraseDeps {
  phrase: (candidate: ProceduralCandidate) => string | Promise<string>;
}

/** ONE draft, shaped to become a `LearningEntry` once the Architect ratifies it — same fields, NO
 *  parallel store. `subsystem: "procedural"` is the only tag distinguishing it. */
export interface ProceduralLearningDraft {
  id: string;
  subsystem: "procedural";
  fact: string;
  src: string;
  files: string[];
}

/** Deterministic id for a candidate's draft — stable across calls for the same shape. */
function proceduralDraftId(candidate: ProceduralCandidate): string {
  return `procedural-${candidate.shapeKey.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
}

/** PHRASE one mined candidate into a {@link ProceduralLearningDraft} — the ONLY step here that
 *  touches an LLM. `deps.phrase` receives NOTHING but the already-mined candidate. */
export async function phraseProceduralCandidate(
  candidate: ProceduralCandidate,
  deps: ProceduralPhraseDeps,
): Promise<ProceduralLearningDraft> {
  const fact = await deps.phrase(candidate);
  return {
    id: proceduralDraftId(candidate),
    subsystem: "procedural",
    fact,
    src: `retro#procedural (${candidate.taskIds.join(", ")})`,
    files: [],
  };
}

// ── PROMOTION PROPOSALS (W1-T1059) ─────────────────────────────────────────
//
// `runPromotionPass` (learnings.ts) shipped under P32/W1-T146 with NO production caller, so its
// ledger steps could never fire. This section is the caller's PURE half: it renders one pass's
// results as a PROPOSAL for the Architect to ratify, and writes nothing anywhere.
//
// WHY THIS CLASSIFIER DOES NOT REUSE `PromotionStage`: that field answers `"judge"` for TWO
// DISTINCT OUTCOMES — a considered `project-specific` NO, and a `broadly-applicable` call below
// the confidence threshold, which must never promote. The conflation is REPORTED, NOT FIXED here
// (learnings.ts is out of scope), so this module reads `applicability` and `confidence` directly.

/** What one {@link PromotionResult} means for the Architect, with the two `stage: "judge"` outcomes kept apart. */
export type PromotionDisposition =
  | "proposed"
  | "declined-scrub"
  | "declined-top-layer"
  | "declined-project-specific"
  | "declined-low-confidence";

/** The pure decision on ONE promotion result (Standing rule 12). One arm per outcome and never a
 *  shared arm for two: the four are different things to a reader deciding what to ratify. */
export function classifyPromotionResult(
  result: PromotionResult,
  confidenceThreshold: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
): PromotionDisposition {
  if (result.stage === "scrub") return "declined-scrub";
  if (result.stage === "top-layer") return "declined-top-layer";
  if (result.promoted) return "proposed";
  const verdict = result.verdict;
  if (verdict && verdict.applicability === "broadly-applicable" && verdict.confidence < confidenceThreshold) {
    return "declined-low-confidence";
  }
  return "declined-project-specific";
}

/** What {@link renderPromotionProposals} needs, so an empty corpus and an all-declined pass never render the same line. */
export interface PromotionProposalInput {
  /** Entries handed to the pass — NOT the number that reached the judge. */
  corpusSize: number;
  /** False when no judge was configured, in which case `results` is empty because the pass never ran. */
  ranPass: boolean;
  results: PromotionResult[];
  confidenceThreshold?: number;
}

/** Render one pass as a retro-report section. THREE ZERO-LOOKING STATES ARE KEPT APART: the pass
 *  did not run, ran over an EMPTY corpus, or proposed nothing. Only the third is a finding. */
export function renderPromotionProposals(input: PromotionProposalInput): string {
  const head = "## Learnings promotion (P32/W1-T146) — proposals for the Architect to ratify";
  if (!input.ranPass) {
    return [
      head,
      "",
      "The pass did NOT run: no promotion judge was supplied to this retro. Nothing was scrubbed,",
      "judged or proposed. Supplying a judge makes the pass run over the active corpus and renders",
      "its proposals here; it still writes nothing — ratification stays an Architect PR.",
    ].join("\n");
  }
  if (input.corpusSize === 0) {
    return [
      head,
      "",
      "The pass ran over an EMPTY corpus — no entries were handed to it. This is not a statement",
      "about what is promotable; it is a statement that nothing was read.",
    ].join("\n");
  }
  const threshold = input.confidenceThreshold;
  const rows = input.results.map((r) => ({ result: r, disposition: classifyPromotionResult(r, threshold) }));
  const proposed = rows.filter((r) => r.disposition === "proposed");
  const lines = [head, ""];
  if (proposed.length === 0) {
    lines.push("The pass ran over the active corpus and proposed nothing to promote.");
  } else {
    lines.push("PROPOSED — ratify by landing each entry at the named layer in a reviewed PR:");
    for (const { result } of proposed) {
      const to = result.promotedEntry?.layer ?? "?";
      const confidence = result.verdict?.confidence ?? 0;
      lines.push(`- ${result.entryId} -> ${to} (confidence ${confidence}) — ${result.verdict?.rationale ?? ""}`);
    }
  }
  const declined = rows.filter((r) => r.disposition !== "proposed");
  if (declined.length > 0) {
    lines.push("", "DECLINED, by reason — each arm is a different decision, not one bucket:");
    for (const { result, disposition } of declined) {
      lines.push(`- ${result.entryId}: ${disposition} — ${result.reason}`);
    }
  }
  lines.push("", "NOTHING ABOVE HAS BEEN WRITTEN. A promotion is a proposal; the Architect ratifies it in a PR.");
  return lines.join("\n");
}

// ── Consolidation contradiction detection (W1-T88, ratifies P14, extends W1-T33) ──
//
// W1-T33 gave supersession a lifecycle, but marking an entry superseded is MANUAL and nothing
// DETECTED when a newly-distilled learning CONTRADICTS an existing one. Recency silently won,
// which is right for a REFINEMENT and wrong for a CONTRADICTION. The missing detection runs in
// three stages: {@link keyContradictionCandidates} finds pairs deterministically and never touches
// an LLM; {@link flagContradictions} asks an advisory judge, per pair, whether the two facts
// OPPOSE; and {@link applyContestedLifecycle} flips BOTH to `contested`, which `selectLearnings`
// already excludes. Resolution is a separate, Architect-authored step that ledgers the decision;
// no code path here picks a winner, and a non-opposing pair is never flagged.

/** ONE deterministically-keyed candidate pair: two `active` entries sharing a `subsystem` and at
 *  least one `files` glob (exact overlap, auditable). `key` is stable whatever the scan order. */
export interface ContradictionCandidatePair {
  key: string;
  a: LearningEntry;
  b: LearningEntry;
}

/** The `files` globs two entries share, sorted (empty ⇒ no overlap, no pair). */
function sharedFileGlobs(a: string[], b: string[]): string[] {
  return a.filter((g) => b.includes(g)).sort();
}

/** MINE every candidate contradiction pair — pure, deterministic, no LLM and no I/O. Only `active`
 *  entries count, and iteration is SORTED BY ID so `key` never depends on array order. */
export function keyContradictionCandidates(entries: LearningEntry[]): ContradictionCandidatePair[] {
  const active = entries
    .filter((e) => e.lifecycle === "active")
    .slice()
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const out: ContradictionCandidatePair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.subsystem !== b.subsystem) continue;
      const shared = sharedFileGlobs(a.files, b.files);
      if (shared.length === 0) continue;
      out.push({ key: `${a.subsystem}:${shared.join("+")}`, a, b });
    }
  }
  return out;
}

/** The advisory judge's verdict on ONE candidate pair — phrasing/judgment only, never new evidence. */
export interface ContradictionVerdict {
  /** True iff the two facts give MUTUALLY-EXCLUSIVE guidance (never both true at once). */
  opposing: boolean;
  /** Why, for the retro report + question backlog. */
  reasoning?: string;
}

/** Dependencies {@link flagContradictions} needs injected: the candidate pair is deterministic
 *  evidence, and the model only JUDGES over it. */
export interface ContradictionJudgeDeps {
  /** The advisory opposition eval. Receives ONLY the candidate pair — never the whole corpus, never other pairs. */
  judge: (pair: ContradictionCandidatePair) => ContradictionVerdict | Promise<ContradictionVerdict>;
  /** Optional structured-event sink (same shape as flight-judge.ts's `deps.log`); no-op if omitted. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** ONE confirmed contradiction — a candidate pair the judge flagged `opposing: true`. */
export interface ContradictionFinding {
  key: string;
  aId: string;
  bId: string;
  aFact: string;
  bFact: string;
  reasoning?: string;
}

/** Judge every candidate pair and return ONLY the ones flagged opposing. A refining pair produces
 *  NO finding, so recency-overwrite for it is untouched; nothing here mutates a pair. */
export async function flagContradictions(
  pairs: ContradictionCandidatePair[],
  deps: ContradictionJudgeDeps,
): Promise<ContradictionFinding[]> {
  const log = deps.log ?? (() => {});
  const findings: ContradictionFinding[] = [];
  for (const pair of pairs) {
    const verdict = await deps.judge(pair);
    log("contradiction.verdict", { key: pair.key, a: pair.a.id, b: pair.b.id, opposing: verdict.opposing });
    if (!verdict.opposing) continue; // a refinement, not a contradiction — recency-overwrite unchanged
    findings.push({
      key: pair.key,
      aId: pair.a.id,
      bId: pair.b.id,
      aFact: pair.a.fact,
      bFact: pair.b.fact,
      reasoning: verdict.reasoning,
    });
  }
  return findings;
}

/** NEVER AUTO-RESOLVED: flip BOTH entries of every confirmed finding to `lifecycle: contested`,
 *  recording each partner. Pure, a NEW array; a finding can only come from an `active` pair, so
 *  this never overwrites a prior decision. `selectLearnings` then excludes both automatically. */
export function applyContestedLifecycle(entries: LearningEntry[], findings: ContradictionFinding[]): LearningEntry[] {
  const partnerOf = new Map<string, string>();
  for (const f of findings) {
    if (!partnerOf.has(f.aId)) partnerOf.set(f.aId, f.bId);
    if (!partnerOf.has(f.bId)) partnerOf.set(f.bId, f.aId);
  }
  return entries.map((e) => {
    const other = partnerOf.get(e.id);
    if (!other) return e;
    const contested: Lifecycle = "contested";
    return { ...e, lifecycle: contested, contestedWith: other };
  });
}

/** Render the confirmed contradictions (markdown) — printed alongside the retro report. */
export function renderContradictions(findings: ContradictionFinding[]): string {
  if (findings.length === 0) {
    return "## Consolidation contradiction detection (P14)\n\nNo contradicting pair found this cycle.";
  }
  return [
    "## Consolidation contradiction detection (P14) — CONTESTED, excluded from injection until an Architect resolves which governs",
    "",
    ...findings.flatMap((f) =>
      [
        `- CONTESTED (${f.key}): ${f.aId} vs ${f.bId}`,
        `    - ${f.aId}: ${f.aFact}`,
        `    - ${f.bId}: ${f.bFact}`,
        f.reasoning ? `    - why: ${f.reasoning}` : undefined,
      ].filter((line): line is string => line !== undefined),
    ),
  ].join("\n");
}

/** Render ONE finding into the §2 QUESTION contract's shape for the durable backlog.
 *  `current_assumption`: BOTH entries stay excluded, never one silently winning by recency. */
export function contradictionQuestion(finding: ContradictionFinding, ts: string): QuestionEntry {
  return {
    ts,
    task: "retro",
    question:
      `Consolidation found a CONTESTED learnings pair (${finding.key}) — which governs? ` +
      `${finding.aId}: "${finding.aFact}" vs ${finding.bId}: "${finding.bFact}"` +
      (finding.reasoning ? ` — judge: ${finding.reasoning}` : ""),
    current_assumption: `Both ${finding.aId} and ${finding.bId} stay lifecycle: contested — excluded from injection — until answered.`,
    impact_if_wrong: "med",
  };
}

/** An Architect-authored decision for ONE contested pair. There is deliberately NO code path
 *  deriving it from the judge's verdict or from recency — a human must name the winner. */
export interface ContradictionResolution {
  activeId: string;
  supersededId: string;
  by?: string;
  reason?: string;
}

/** Dependencies {@link applyContradictionResolution} needs injected — same shape as correct.ts's `writeLedger` override. */
export interface ContradictionResolutionDeps {
  /** Absolute path to state/ledger.ndjson. */
  ledgerPath: string;
  /** Defaults to the real {@link appendLedger}; tests inject a spy instead of touching disk. */
  writeLedger?: typeof appendLedger;
}

/** APPLY a resolution: `activeId` is re-admitted, `supersededId` marked `superseded`. Appends ONE
 *  `contradiction.resolved` ledger line naming both ids, `by` and `reason` — the durable record a
 *  learnings write requires. The ONLY function here that resolves a `contested` entry. */
export function applyContradictionResolution(
  entries: LearningEntry[],
  resolution: ContradictionResolution,
  deps: ContradictionResolutionDeps,
): LearningEntry[] {
  const writeLedger = deps.writeLedger ?? appendLedger;
  const updated = entries.map((e) => {
    if (e.id === resolution.activeId) {
      const active: Lifecycle = "active";
      return { ...e, lifecycle: active, contestedWith: undefined };
    }
    if (e.id === resolution.supersededId) {
      const superseded: Lifecycle = "superseded";
      return { ...e, lifecycle: superseded, supersededBy: resolution.activeId, contestedWith: undefined };
    }
    return e;
  });
  writeLedger(deps.ledgerPath, {
    run_id: `CONTRADICTION-${resolution.activeId}-${resolution.supersededId}`,
    task_id: "retro",
    step: "contradiction.resolved",
    active_id: resolution.activeId,
    superseded_id: resolution.supersededId,
    by: resolution.by ?? "architect",
    reason: resolution.reason ?? null,
  });
  return updated;
}

// ── Citation mining (W1-T419) ──────────────────────────────────────────────
//
// `selectLearnings` already tiebreaks on `cited`, so this corpus has the RANKING half of the
// Stack-Overflow-shaped loop. The signal feeding it was dead: hand-stamped dates, and effectively
// zero `learnings#<id>` citations in the commit history. This section mines the two real sources —
// `learnings.injected` rows' `matched_ids`, and `learnings#<id>` mentions in git-log — and stamps
// `cited` plus `cited_count` onto each ACTIVE entry. An id with no evidence is left untouched.
// Why, measured: docs/forensics/retro.md.

/** One evidence occurrence for a learning id — WHEN it was cited, regardless of source. */
export interface CitationEvidence {
  id: string;
  /** ISO date (or full timestamp); only lexicographic ("latest wins") order matters. */
  date: string;
}

/** Mine `learnings.injected` rows for per-id citation evidence. A PRE-TASK row logs `matched` as a
 *  bare count and contributes NOTHING, never a throw: old-format rows are the expected majority
 *  of history, and a malformed `matched_ids` is skipped the same way. */
export function mineLedgerCitations(records: LedgerRecord[]): CitationEvidence[] {
  const out: CitationEvidence[] = [];
  for (const r of records) {
    if (r.step !== "learnings.injected") continue;
    const ids = r.matched_ids;
    if (!Array.isArray(ids)) continue; // pre-task row (count-only) or malformed — no evidence
    const date = typeof r.ts === "string" ? r.ts : "";
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) out.push({ id, date });
    }
  }
  return out;
}

/** One git-log commit reduced to what {@link mineGitLogCitations} needs. This module stays a PURE
 *  reducer over already-read text, the discipline {@link parseLedger} keeps. */
export interface GitLogCommit {
  date: string;
  message: string;
}

/** Mine git-log messages for `learnings#<id>` citations — ONE evidence per (commit, id), deduped
 *  WITHIN a commit, so a subject-and-body mention counts once rather than inflating the count. */
export function mineGitLogCitations(commits: GitLogCommit[]): CitationEvidence[] {
  const out: CitationEvidence[] = [];
  // Ids here are alphanumeric plus hyphen only, verified at filing time, so the class stops short
  // of `.`: a sentence-ending period after an id must never be captured into the id.
  const pattern = /learnings#([A-Za-z0-9][A-Za-z0-9-]*)/g;
  for (const commit of commits) {
    const ids = new Set<string>();
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(commit.message))) ids.add(match[1]);
    for (const id of ids) out.push({ id, date: commit.date });
  }
  return out;
}

/** Per-entry mined evidence, reduced: total occurrences and the latest (max, lexicographic) date. */
export interface CitationStamp {
  citedCount: number;
  cited: string;
}

/** Reduce raw {@link CitationEvidence} into ONE {@link CitationStamp} per id: `citedCount` sums
 *  occurrences, `cited` is the latest date. An id with zero evidence has no key in the map. */
export function aggregateCitationEvidence(evidence: CitationEvidence[]): Map<string, CitationStamp> {
  const out = new Map<string, CitationStamp>();
  for (const e of evidence) {
    const prior = out.get(e.id);
    if (!prior) {
      out.set(e.id, { citedCount: 1, cited: e.date });
      continue;
    }
    prior.citedCount += 1;
    if (e.date > prior.cited) prior.cited = e.date;
  }
  return out;
}

/** Stamp mined citation evidence onto every ACTIVE entry — pure, a NEW array. An entry absent from
 *  `evidence` keeps what it carried, so a pass that found nothing never blanks one back to
 *  unevidenced. A non-active entry is never stamped: it is never injected. */
export function stampCitations(entries: LearningEntry[], evidence: Map<string, CitationStamp>): LearningEntry[] {
  return entries.map((e) => {
    if (e.lifecycle !== "active") return e;
    const stamp = evidence.get(e.id);
    if (!stamp) return e;
    return { ...e, cited: stamp.cited, citedCount: stamp.citedCount };
  });
}

/** W1-T1248: the write half of the four citation miners, which shipped with no production caller.
 *  Reports which ids' stamps actually MOVED — an unevidenced or non-active entry is byte-identical
 *  and never appears, so a pass that finds nothing new produces a NO-OP diff. */
export function changedCitationStamps(
  entries: LearningEntry[],
  evidence: Map<string, CitationStamp>,
): Map<string, CitationStamp> {
  const stamped = stampCitations(entries, evidence);
  const out = new Map<string, CitationStamp>();
  for (let i = 0; i < entries.length; i++) {
    const before = entries[i];
    const after = stamped[i];
    if (after.cited !== before.cited || after.citedCount !== before.citedCount) {
      out.set(after.id, { cited: after.cited as string, citedCount: after.citedCount as number });
    }
  }
  return out;
}

/** Text-surgery stamp of ONE entry's `cited`/`cited_count` within a shard's raw YAML: it touches
 *  only the lines that change and never round-trips the document through the `yaml` stringifier,
 *  which would reflow every other entry into a noisy whole-file diff each cycle. A no-op when
 *  `id`'s block is not in this shard, so callers loop every stamp over every file with no
 *  id-to-file index. Adds a `cited_count` line after `cited` when the entry has none yet. */
interface EntryBlockLocation {
  start: number;
  end: number;
  block: string;
}

/** Locate ONE entry's block, from its `- id: <id>` header to the next. Shared by the write and the
 *  baseline compare, so both agree byte for byte on where one entry ends. */
function locateEntryBlock(text: string, id: string): EntryBlockLocation | undefined {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(`^- id: ${escapedId}\\s*$`, "m");
  const startMatch = startRe.exec(text);
  if (!startMatch) return undefined; // id not in this shard
  const start = startMatch.index;
  const afterHeader = start + startMatch[0].length;
  const rest = text.slice(afterHeader);
  const nextMatch = /^- id: /m.exec(rest);
  const end = nextMatch ? afterHeader + nextMatch.index : text.length;
  return { start, end, block: text.slice(start, end) };
}

/** W1-T1267: read-only counterpart to {@link locateEntryBlock}. Used to CAPTURE a baseline and to
 *  read the FRESH block it is compared to; never to write. */
export function extractEntryBlock(text: string, id: string): string | undefined {
  return locateEntryBlock(text, id)?.block;
}

export function stampCitationInShardText(text: string, id: string, stamp: CitationStamp): string {
  const loc = locateEntryBlock(text, id);
  if (!loc) return text; // id not in this shard — no-op
  const { start, end } = loc;
  let block = loc.block;
  const citedLine = `  cited: "${stamp.cited}"`;
  const countLine = `  cited_count: ${stamp.citedCount}`;
  if (/^  cited:.*$/m.test(block)) {
    block = block.replace(/^  cited:.*$/m, citedLine);
  } else {
    // No prior `cited:` line — append before the block's trailing whitespace, the same "no anchor
    // to replace" fallback learnings-assert-check.mjs's quarantineEntryInText uses.
    const trailingWs = /\s*$/.exec(block)?.[0] ?? "";
    block = `${block.slice(0, block.length - trailingWs.length)}\n${citedLine}${trailingWs}`;
  }
  if (/^  cited_count:.*$/m.test(block)) {
    block = block.replace(/^  cited_count:.*$/m, countLine);
  } else {
    block = block.replace(citedLine, `${citedLine}\n${countLine}`);
  }
  return text.slice(0, start) + block + text.slice(end);
}

const CITATION_STAMP_COMMIT_MESSAGE = "chore(learnings): stamp measured citation evidence (W1-T1248)";

/** W1-T1267: read, for each id, the RAW block as it stands RIGHT NOW — the block the decision was
 *  made against. Callers invoke this immediately after computing `changed`, so it is the plan-time
 *  baseline the write phase compares a FRESH read against. */
export function captureCitationBaselines(learningsDir: string, ids: Iterable<string>): Map<string, string> {
  const remaining = new Set(ids);
  const out = new Map<string, string>();
  if (remaining.size === 0) return out;
  let filenames: string[];
  try {
    filenames = fsMarker
      .readdirSync(learningsDir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return out; // no corpus directory — no baselines to capture
  }
  for (const filename of filenames) {
    if (remaining.size === 0) break;
    let text: string;
    try {
      text = fsMarker.readFileSync(join(learningsDir, filename), "utf8");
    } catch {
      continue;
    }
    for (const id of remaining) {
      const block = extractEntryBlock(text, id);
      if (block !== undefined) {
        out.set(id, block);
        remaining.delete(id);
      }
    }
  }
  return out;
}

/** One entry's baseline-vs-fresh mismatch (design iii): named so an operator reading the ledger
 *  row can tell a lifecycle flip from a hand-edited fact without opening the shard. */
export interface CitationBaselineRefusal {
  id: string;
  /** The YAML key of the first line that differs (e.g. `"lifecycle"`), or `"block"` when the
   *  block's line count itself changed rather than any one line's content. */
  field: string;
  before: string;
  after: string;
}

const CITATION_STAMP_LINE_RE = /^ {2}(cited|cited_count):.*$/;

/** Strip the two lines {@link stampCitationInShardText} owns: a baseline-vs-fresh compare must
 *  judge everything ELSE about the entry, never the fields this pass is about to write. */
function withoutCitationStampLines(block: string): string[] {
  return block.split("\n").filter((line) => !CITATION_STAMP_LINE_RE.test(line));
}

/** W1-T1267: compare the block the decision was made against with a FRESH read of the same id.
 *  `undefined` when nothing outside `cited`/`cited_count` moved; otherwise it names the id, the
 *  first differing field and both values, never merely "entry changed". */
export function compareCitationBaseline(id: string, baseline: string, fresh: string | undefined): CitationBaselineRefusal | undefined {
  const beforeLines = withoutCitationStampLines(baseline);
  const afterLines = fresh === undefined ? [] : withoutCitationStampLines(fresh);
  if (beforeLines.join("\n") === afterLines.join("\n")) return undefined;
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i] ?? "";
    const a = afterLines[i] ?? "";
    if (b !== a) {
      const field = (b.match(/^\s*([\w-]+):/) ?? a.match(/^\s*([\w-]+):/))?.[1] ?? "block";
      return { id, field, before: b.trim() || "(absent)", after: a.trim() || "(absent)" };
    }
  }
  // Every compared line matched, though the loop above would already have returned on the first
  // length divergence — a defined fallback, never treating a real mismatch as "no change".
  return { id, field: "block", before: "(present)", after: "(missing)" };
}

/** W1-T1267: default `readFreshShardText` — one memoized `git fetch`, then
 *  `git show origin/main:<relPath>`: the "read the blob, never the working tree" idiom. This closes
 *  the window the task names: the worktree's own `learnings/` copy is origin/main AS OF THE CUT
 *  and is never refreshed. Best-effort — no remote, no network, or a path not yet on `origin/main`
 *  resolve to `undefined`, no signal, rather than a false refusal. */
function defaultFreshShardTextReader(worktreePath: string): (relPath: string) => string | undefined {
  let fetchAttempted = false;
  let fetchOk = false;
  return (relPath: string): string | undefined => {
    if (!fetchAttempted) {
      fetchAttempted = true;
      try {
        execFileSync("git", ["-C", worktreePath, "fetch", "--quiet", "origin", "main"], { stdio: "pipe" });
        fetchOk = true;
      } catch {
        fetchOk = false;
      }
    }
    if (!fetchOk) return undefined;
    try {
      return execFileSync("git", ["-C", worktreePath, "show", `origin/main:${relPath}`], { encoding: "utf8" });
    } catch {
      return undefined; // e.g. a brand-new shard not yet on origin/main
    }
  };
}

export interface StampCitationsAndCommitResult {
  committed: boolean;
  /** Ids actually written to a shard this pass. An id absent from every shard — a stale or
   *  renamed one — is silently skipped: the corpus on disk is the truth, not the evidence map. */
  stampedIds: string[];
  /** W1-T1267: ids whose baseline (design ii) no longer matches a fresh read of `origin/main` —
   *  refused this pass, never retried (design iv). Always present, empty when nothing refused. */
  refused: CitationBaselineRefusal[];
  /** `git show` of the new commit (patch + stat) — omitted when `committed` is false. */
  diff?: string;
}

/** Apply every {@link changedCitationStamps} entry onto its shard's raw text, `git add` the
 *  touched shards, and commit ONLY if something actually staged. `regeneratePlanIndexAndCommit`
 *  is not imported, to avoid a retro.ts -> plan-pr-emitter.ts dependency neither needs.
 *
 *  PASS ONE, STAMP ONLY: never adds an entry, drops one, or touches `lifecycle`. An empty
 *  `changed` map short-circuits before disk or git, so a quiet cycle produces an empty diff rather
 *  than an empty commit. W1-T1267: with a baseline for an id, this re-reads that id's CURRENT
 *  block before writing and REFUSES — drops for this cycle, never retries, never blocks another id
 *  — when anything outside the two stamped lines moved. */
export function stampCitationsAndCommit(opts: {
  worktreePath: string;
  /** Absolute path, typically `join(worktreePath, "learnings")`. */
  learningsDir: string;
  changed: Map<string, CitationStamp>;
  commitMessage?: string;
  /** Per-id baseline block (design ii), from {@link captureCitationBaselines}. */
  baselines?: Map<string, string>;
  /** Injectable so a test can simulate a mid-pass mutation with no real `origin` remote.
   *  Default: {@link defaultFreshShardTextReader}. */
  readFreshShardText?: (relPath: string) => string | undefined;
}): StampCitationsAndCommitResult {
  if (opts.changed.size === 0) return { committed: false, stampedIds: [], refused: [] };
  let filenames: string[];
  try {
    filenames = fsMarker
      .readdirSync(opts.learningsDir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return { committed: false, stampedIds: [], refused: [] }; // no corpus directory — nothing to stamp
  }
  const readFresh = opts.readFreshShardText ?? defaultFreshShardTextReader(opts.worktreePath);
  const stampedIds = new Set<string>();
  const refused: CitationBaselineRefusal[] = [];
  const touchedRelPaths: string[] = [];
  for (const filename of filenames) {
    const path = join(opts.learningsDir, filename);
    const relPath = relative(opts.worktreePath, path);
    const before = fsMarker.readFileSync(path, "utf8");
    let after = before;
    let fresh: string | undefined;
    let freshLoaded = false;
    for (const [id, stamp] of opts.changed) {
      if (extractEntryBlock(before, id) === undefined) continue; // id not in this shard
      const baseline = opts.baselines?.get(id);
      if (baseline !== undefined) {
        if (!freshLoaded) {
          fresh = readFresh(relPath);
          freshLoaded = true;
        }
        if (fresh !== undefined) {
          // A real fresh read is a genuine signal either way. `fresh === undefined` — no remote,
          // offline, shard not yet on origin/main — is no signal, so stamp as if no baseline.
          const mismatch = compareCitationBaseline(id, baseline, extractEntryBlock(fresh, id));
          if (mismatch) {
            refused.push(mismatch);
            continue;
          }
        }
      }
      const next = stampCitationInShardText(after, id, stamp);
      if (next !== after) {
        after = next;
        stampedIds.add(id);
      }
    }
    if (after !== before) {
      fsMarker.writeFileSync(path, after, "utf8");
      touchedRelPaths.push(relPath);
    }
  }
  if (touchedRelPaths.length === 0) return { committed: false, stampedIds: [...stampedIds], refused };
  execFileSync("git", ["-C", opts.worktreePath, "add", ...touchedRelPaths]);
  try {
    execFileSync("git", ["-C", opts.worktreePath, "diff", "--cached", "--quiet"]);
    // exit 0 ⇒ nothing staged ⇒ content is unchanged from HEAD; nothing to commit.
    return { committed: false, stampedIds: [...stampedIds], refused };
  } catch {
    // non-zero ⇒ staged changes exist ⇒ commit them as their own, clearly-labeled commit.
    execFileSync("git", ["-C", opts.worktreePath, "commit", "-m", opts.commitMessage ?? CITATION_STAMP_COMMIT_MESSAGE]);
    const diff = execFileSync("git", ["-C", opts.worktreePath, "show", "--stat=200", "-p", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { committed: true, stampedIds: [...stampedIds], refused, diff };
  }
}

// ── The retro marker (state/last-retro.json) ──────────────────────────────

export interface RetroMarker {
  ts: string;
  learnings_count: number;
  runs_seen: number;
  /** W1-T89/P18: this cycle's `mast.byCategory`, carried forward so the NEXT retro shows a trend.
   *  Backward-compatible: a marker written before this field yields no trend, never a failure. */
  mast_category_counts?: Record<string, number>;
}

/** Thrown by {@link loadMarker} when state/last-retro.json EXISTS but fails to parse. DISTINCT
 *  from genuinely absent, the only legitimate first-ever-retro signal: a corrupt marker collapsed
 *  into "no marker" replays the consumed run window and double-counts SHIPPED and learnings. */
export class MarkerCorruptError extends Error {
  readonly markerPath: string;
  constructor(path: string, cause: unknown) {
    super(
      `retro marker at ${path} exists but is not parseable JSON (${String((cause as Error)?.message ?? cause)})` +
        " -- refusing to treat a corrupt marker as first-ever-retro (that would reprocess the whole" +
        " already-consumed run window and double-count SHIPPED/learnings); fix or remove it manually",
    );
    this.name = "MarkerCorruptError";
    this.markerPath = path;
  }
}

/** Load the last-retro marker.
 *   - Absent (ENOENT)      -> undefined, the ONLY legitimate first-ever-retro signal.
 *   - Present, unparseable -> throws {@link MarkerCorruptError}. NEVER undefined.
 *   - Present, parseable   -> the RetroMarker. */
export function loadMarker(path: string): RetroMarker | undefined {
  let raw: string;
  try {
    raw = fsMarker.readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw) as RetroMarker;
  } catch (e) {
    throw new MarkerCorruptError(path, e);
  }
}

/** The three states `resolveMarkerForGather` distinguishes for a retro caller. */
export type MarkerResolution =
  | { kind: "absent" }
  | { kind: "corrupt"; error: MarkerCorruptError }
  | { kind: "ok"; marker: RetroMarker };

/** Resolve the last-retro marker for the gather step. A caller MUST branch on `.kind` rather than
 *  reduce this to `marker | undefined`: "absent" is the only state that legitimately widens the
 *  gather to full history, while "corrupt" MUST fail closed and abort, because falling through to
 *  a full-history gather would reprocess a consumed window and double-count. "ok" scopes the
 *  gather to `sinceTs = marker.ts`. */
export function resolveMarkerForGather(path: string): MarkerResolution {
  try {
    const marker = loadMarker(path);
    return marker === undefined ? { kind: "absent" } : { kind: "ok", marker };
  } catch (e) {
    if (e instanceof MarkerCorruptError) return { kind: "corrupt", error: e };
    throw e;
  }
}

/** Save the marker as ONE atomic unit: staged into a same-directory temp file, then swapped in
 *  with a single `renameSync`. A plain `writeFileSync` would let {@link loadMarker} observe a torn
 *  file mid-write, and that torn read was once misread as first-ever-retro. */
export function saveMarker(path: string, marker: RetroMarker): void {
  fsMarker.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.from(JSON.stringify(marker, null, 2) + "\n", "utf8");
  const fd = fsMarker.openSync(tmpPath, "w");
  try {
    const written = fsMarker.writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) {
      throw new Error(`short write staging ${tmpPath} for ${path} (${written}/${buf.length} bytes)`);
    }
  } finally {
    fsMarker.closeSync(fd);
  }
  fsMarker.renameSync(tmpPath, path);
}

// ── W1-T160: retro cadence trigger + integrity gate ────────────────────────
//
// The retro runs on an OPERATOR today. This makes it a LOOP: a pure TRIGGER predicate the daemon's
// poll evaluates against the marker, plus an INTEGRITY GATE the unattended path enforces before it
// writes — the gather must credit the window's merges, or the retro refuses to write. The
// thresholds are POLICY DATA (Rule 2): a caller passes a different policy, never a source edit.

/** Policy-data default: fire once this many merges have landed since the marker. Overridable
 *  via {@link RetroTriggerPolicy} — never hardcode a literal at a call site. */
export const DEFAULT_RETRO_MERGES_THRESHOLD = 25;

/** Policy-data default: fire once this many days have elapsed since the marker, even with few
 *  merges — a staleness floor so the retro still runs on a quiet week. */
export const DEFAULT_RETRO_DAYS_THRESHOLD = 7;

/** Policy-as-data (Rule 2) for the retro cadence trigger — the same `?? DEFAULT` override shape
 *  daemon.ts's own headroom and backoff policy uses, not a bespoke pattern. */
export interface RetroTriggerPolicy {
  mergesThreshold: number;
  daysThreshold: number;
  /** W1-T2289 — OPTIONAL. Fire once this many unharvested candidates are pending: the retro's OWN
   *  input depth, unlike the two thresholds above, which describe the FLEET's shipped activity.
   *  Undefined reuses `mergesThreshold`; a distinct measured number belongs in policy.yaml. */
  followupsThreshold?: number;
}

export function defaultRetroTriggerPolicy(): RetroTriggerPolicy {
  return { mergesThreshold: DEFAULT_RETRO_MERGES_THRESHOLD, daysThreshold: DEFAULT_RETRO_DAYS_THRESHOLD };
}

export type RetroTriggerDecision =
  | { fire: false; mergesSinceMarker: number; daysSinceMarker: number; followupsPending?: number }
  | {
      fire: true;
      reason: "merges" | "days" | "followups";
      mergesSinceMarker: number;
      daysSinceMarker: number;
      followupsPending?: number;
    };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** PURE trigger predicate (W1-T160): fires on `mergesSinceMarker >= policy.mergesThreshold` OR
 *  `daysSinceMarker >= policy.daysThreshold`, whichever crosses first. `markerTs` undefined makes
 *  `daysSinceMarker` `Infinity`, so a repo with no retro history is always eligible.
 *
 *  A THIRD, INDEPENDENT SIGNAL (W1-T2289): `followupsPending` past its own threshold fires with
 *  `reason: "followups"`. The two existing thresholds describe the FLEET's shipped activity, never
 *  the retro's own queue; `followupsPending` defaults to 0, so this is a WIDENING, not a
 *  replacement. TIE-BREAK: `reason` prefers "merges", then "days" — the more informative signals,
 *  never masked by a staleness or backlog floor. */
export function evaluateRetroTrigger(
  mergesSinceMarker: number,
  markerTs: string | undefined,
  now: Date,
  policy: RetroTriggerPolicy = defaultRetroTriggerPolicy(),
  followupsPending = 0,
): RetroTriggerDecision {
  const daysSinceMarker = markerTs === undefined ? Infinity : (now.getTime() - Date.parse(markerTs)) / MS_PER_DAY;
  if (mergesSinceMarker >= policy.mergesThreshold) {
    return { fire: true, reason: "merges", mergesSinceMarker, daysSinceMarker, followupsPending };
  }
  if (daysSinceMarker >= policy.daysThreshold) {
    return { fire: true, reason: "days", mergesSinceMarker, daysSinceMarker, followupsPending };
  }
  const followupsThreshold = policy.followupsThreshold ?? policy.mergesThreshold;
  if (followupsPending >= followupsThreshold) {
    return { fire: true, reason: "followups", mergesSinceMarker, daysSinceMarker, followupsPending };
  }
  return { fire: false, mergesSinceMarker, daysSinceMarker, followupsPending };
}

export interface RetroIntegrityResult {
  ok: boolean;
  /** Present iff `!ok` — the loud, human-readable reason the automated retro refused to write. */
  reason?: string;
}

/** The INTEGRITY GATE (W1-T160): a HARD precondition inside the AUTOMATED path only, since an
 *  operator-run `rmd retro` is watched by a human. A mismatch — the trigger saw real merge
 *  activity and the gather credits NONE — means the credit union degraded in between (a throttle,
 *  an ownership assert rejecting everything, an outage), so the retro ABORTS rather than write on
 *  a zero-credit gather. Fail-closed, because no human is watching an unattended run. */
export function checkRetroIntegrity(priorMergesSinceMarker: number, gatherShippedCount: number): RetroIntegrityResult {
  if (priorMergesSinceMarker > 0 && gatherShippedCount === 0) {
    return {
      ok: false,
      reason:
        `retro integrity gate: the trigger observed ${priorMergesSinceMarker} merge(s) since the marker, ` +
        `but the gather credited 0 -- refusing to write (R8-class silent under-count, no human watching to catch it)`,
    };
  }
  return { ok: true };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── docs/ORIENTATION.md — the Architect handoff doc (W1-T39) ──────────────
//
// A fresh Architect session should orient from ONE small doc, not re-derive state from a 900-line
// plan and a ledger. ORIENTATION.md states current state, the next runnable task and the never-do
// invariants. It is MAINTAINED BY `rmd retro`, never hand-edited, so it cannot go stale.

/** Normalise ONE physical line of a rule: drop the `**TITLE**` emphasis and squeeze whitespace.
 *  DELIBERATELY per-line — it never joins a line to its neighbour. */
function cleanRuleLine(s: string): string {
  return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** Join a rule's physical lines back into ONE rule string while KEEPING those lines.
 *
 *  W1-T2483 — WHY THIS NO LONGER COLLAPSES. Folding continuations onto one line is not what
 *  "verbatim" means, and it broke a real gate: `test/rule-15-16-filing-misattribution.test.ts`
 *  judges a citation inside a THREE-LINE window, a proximity proxy, and proximity is a property of
 *  line breaks a renderer owns. The gate is correct and is not touched. Blank lines are kept for
 *  the same reason; trailing blanks are trimmed. Why, measured: docs/forensics/retro.md. */
function joinRuleLines(lines: string[]): string {
  const cleaned = lines.map(cleanRuleLine);
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "") cleaned.pop();
  return cleaned.join("\n");
}

/** Extract the numbered "never-do" invariants from MASTER-PLAN.md's `## 12. Standing rules` — a
 *  pure text extraction, so ORIENTATION.md's list cannot drift from the source by hand-copy.
 *  Returns `[]` when the heading is not found: generation must not abort a retro over a rename. */
export function extractStandingRules(masterPlanMd: string): string[] {
  const lines = masterPlanMd.split("\n");
  const startIdx = lines.findIndex((l) => /^## 12\. Standing rules\s*$/.test(l));
  if (startIdx === -1) return [];
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## /.test(l));
  if (endIdx === -1) endIdx = lines.length;
  const section = lines.slice(startIdx + 1, endIdx);

  const rules: string[] = [];
  let current: string[] = [];
  const isRuleStart = (l: string) => /^\d+[A-Z]?\.\s+\S/.test(l);
  const isBullet = (l: string) => /^[-*]\s+\S/.test(l);
  const flush = (): void => {
    if (current.length > 0) rules.push(joinRuleLines(current));
    current = [];
  };
  for (const raw of section) {
    const line = raw.trim();
    if (isRuleStart(line)) {
      flush();
      current = [line];
    } else if (isBullet(line)) {
      // A markdown bullet is NOT a rule's wrapped continuation — it marks trailing prose after
      // the numbered list, and nothing past that list is a Standing rule.
      flush();
      break;
    } else if (current.length > 0) {
      // A continuation line — INCLUDING a blank one. Blanks before the first rule are still
      // ignored (nothing is open yet); inside a rule they are the paragraph breaks §12 writes.
      current.push(line);
    }
  }
  flush();
  return rules;
}

/** Everything {@link renderOrientation} needs to render docs/ORIENTATION.md. */
export interface OrientationInput {
  /** ISO timestamp of this retro run — injected by the caller (retro.ts is pure; it never calls Date itself). */
  generatedAt: string;
  /** The same deterministic gather the retro's plan-sync PR is built from. */
  gather: RetroGather;
  /** The next runnable task per the SAME DAG and GitHub-derived status `rmd drain` dispatches
   *  from; `undefined` when nothing is currently runnable. */
  nextTask?: Task;
  /** MASTER-PLAN §12 Standing rules, extracted via {@link extractStandingRules}. */
  standingRules: string[];
}

/** Render ONE standing rule as a markdown item that KEEPS its line breaks (W1-T2483): the first
 *  line carries the bullet, continuations are indented two spaces, and a blank line stays blank. */
function orientationBullet(rule: string): string[] {
  const [first, ...rest] = rule.split("\n");
  return [`- ${first}`, ...rest.map((l) => (l === "" ? "" : `  ${l}`))];
}

/** Render docs/ORIENTATION.md: current state, the next runnable task (matching `rmd drain`'s own
 *  pick) and the never-do invariants. Pure — the caller writes it to disk. */
export function renderOrientation(input: OrientationInput): string {
  const { gather, nextTask, standingRules } = input;
  const shippedLines = gather.shipped.length
    ? gather.shipped.map(
        (s) => `- ${s.taskId} → ${s.prUrl}${s.annotation ? ` (${s.annotation})` : ""}`,
      )
    : ["- (none since the last retro marker)"];
  const nextTaskBlock = nextTask
    ? [
        `**${nextTask.id}** — ${nextTask.title}`,
        "",
        `- risk: ${nextTask.risk ?? "medium"} · depends_on: ${nextTask.depends_on?.length ? nextTask.depends_on.join(", ") : "(none)"}`,
      ].join("\n")
    : "(none runnable right now — the DAG is exhausted, every remaining task is blocked/unmet, or awaits `verify: human`)";
  const invariantLines = standingRules.length
    ? standingRules.flatMap(orientationBullet)
    : ["- (none extracted — see MASTER-PLAN.md §12 Standing rules directly)"];

  return [
    "# ORIENTATION",
    "",
    `_MAINTAINED BY \`rmd retro\` — regenerated ${input.generatedAt}. Hand edits are overwritten on the` +
      " next retro; change MASTER-PLAN.md or plan/tasks.yaml instead, never this file directly._",
    "",
    "A fresh Architect session should be able to orient from THIS doc alone plus the plan index —",
    "not by re-deriving state from the full plan and ledger.",
    "",
    "## Current state",
    "",
    `${gather.totalRuns} run(s) since the last retro marker. Verdicts: ${JSON.stringify(gather.verdicts)}.`,
    "",
    "### Shipped since marker",
    ...shippedLines,
    "",
    "## Next runnable task",
    "",
    nextTaskBlock,
    "",
    "## Never-do invariants (MASTER-PLAN §12 Standing rules — extracted verbatim; §12 is authoritative)",
    "",
    ...invariantLines,
  ].join("\n");
}

// ── SHIPS-UNWIRED advisory floor — RETRO-TIME CONSUMER (W1-T322, design (iii)) ────────────

/** A backtick-quoted, function-shaped identifier a NET STATE sentence names — the retro-time
 *  mirror of review-time's `unwired_export`. DELIBERATELY NARROW, requiring an internal case
 *  transition or underscore, and silent about anything it cannot tell apart from prose. */
const BACKTICK_SYMBOL_RE = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;

function looksLikeSymbolName(name: string): boolean {
  return /[a-z][A-Z]|_/.test(name);
}

/** A short, human-legible window of `text` around `index` — whitespace collapsed and trimmed to
 *  roughly a sentence either side, never the whole paragraph-length NET STATE bullet. */
function snippetAround(text: string, index: number, radius = 140): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** One NET STATE capability sentence naming a symbol {@link "./reachability.js".isExportReachable}
 *  reports as unreached — the retro-time `net_state_claim` reason code. */
export interface NetStateCapabilityAdvisory {
  symbol: string;
  file: string;
  snippet: string;
}

/** THE RETRO-TIME CONSUMER (W1-T322 design (iii)): the SAME reachability scan review-time uses,
 *  run over MASTER-PLAN's NET STATE prose instead of a diff. REPORTS, never REWRITES — editing
 *  MASTER-PLAN.md is out of scope. `checkoutDir` is the live tree, never a PR diff. */
export function netStateCapabilityAdvisories(netStateText: string, checkoutDir: string): NetStateCapabilityAdvisory[] {
  const out: NetStateCapabilityAdvisory[] = [];
  const seen = new Set<string>();
  for (const m of netStateText.matchAll(BACKTICK_SYMBOL_RE)) {
    const symbol = m[1];
    if (!looksLikeSymbolName(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    const file = findExportDefinition(symbol, checkoutDir);
    if (!file) continue; // not a real export — silence, not a verdict
    if (isExportReachable(symbol, file, checkoutDir)) continue;
    out.push({ symbol, file, snippet: snippetAround(netStateText, m.index ?? 0) });
  }
  return out;
}

/** Render {@link netStateCapabilityAdvisories}'s findings — printed alongside the plan-health
 *  sweep and never blocking anything: this whole floor is advisory-only by design. */
export function renderNetStateUnwiredAdvisories(advisories: NetStateCapabilityAdvisory[]): string {
  if (advisories.length === 0) {
    return "## SHIPS-UNWIRED — NET STATE capability claims\n\nNo NET STATE claim names a symbol this scan finds unreached.";
  }
  return [
    "## SHIPS-UNWIRED — NET STATE capability claims (ADVISORY ONLY, W1-T322)",
    "",
    "Each line below names a MASTER-PLAN NET STATE capability sentence whose named symbol has no",
    "caller this scan can find — never a verdict on the claim's truth, only a pointer to re-check it:",
    "",
    ...advisories.map((a) => `- \`${a.symbol}\` (${a.file}) — "${a.snippet}"`),
  ].join("\n");
}

// ── PLAN-STATE TRUTH RUNG (W1-T410, split from W1-T392) ────────────────────
//
// Re-derives every task id MASTER-PLAN.md asserts UNBUILT against the merge resolver the retro
// gather already holds. No new network call, no new gateway.
//
// THE EXTRACTOR MUST BIND THE ASSERTION TO ITS SUBJECT (design (i)). A LINE-scoped extractor is
// refuted by measurement: one measured line carries five task ids that are sibling REJECTION
// COUNTS, not the unbuilt subject, which sits past an em-dash. A CLAUSE-scoped extractor reads it
// correctly and yields zero. Why, with the line verbatim: docs/forensics/retro.md.

/** One `not-shipped` phrase this rung recognises. No `g` flag: every use is a single-shot
 *  `.test()`, so global-flag `lastIndex` state can never leak between calls. */
const NOT_SHIPPED_PHRASE_RE = /not shipped|unbuilt|did not ship/i;

/** A task id in full (`W1-T149`) or bare (`T342`) form. `g`-flagged but consumed only via
 *  `String.prototype.match`, which resets `lastIndex` on every call, so reuse is safe. */
const TASK_ID_RE = /\b(?:W\d+-T\d+|T\d+)\b/g;

/** A proposal id (`P29`, `P29(i)`) — deliberately NOT `g`-flagged, because a `g`-flagged regex
 *  under repeated `.test()` carries `lastIndex` and silently alternates match and no-match.
 *  Presence only: this rung reports the SKIPPED COUNT rather than resolving the proposal. */
const PROPOSAL_ID_RE = /\bP\d+[A-Za-z]?(?:\([ivxlc]+\))?/i;

/** Strong clause delimiters this prose actually uses to separate an unbuilt phrase's subject from
 *  unrelated data. Narrow by design: splitting on an en-dash or comma would sever an assertion. */
const CLAUSE_SPLIT_RE = /[—;]/;

/** A bare `T\d+` is shorthand for `W1-T\d+` throughout this corpus (every measured occurrence
 *  — see the module doc above); a full `W\d+-T…` id is returned unchanged. */
function normalizeAssertedTaskId(raw: string): string {
  return /^W\d+-/.test(raw) ? raw : `W1-${raw}`;
}

/** {@link extractAssertedUnbuiltTaskIds}'s result: the bound task ids; how many phrase-bearing
 *  lines were examined (the size of the set examined); and how many bound a proposal id. */
export interface AssertedUnbuiltExtraction {
  ids: string[];
  examinedLines: number;
  proposalOnlyLines: number;
}

/** Extract every task id MASTER-PLAN.md prose ASSERTS unbuilt, bound to its subject by clause
 *  scoping — see the section doc for why a line-scoped extractor is measurably wrong. A clause
 *  carrying a PROPOSAL id but no task id is counted, never dropped and never resolved. */
export function extractAssertedUnbuiltTaskIds(masterPlanMd: string): AssertedUnbuiltExtraction {
  const ids = new Set<string>();
  let examinedLines = 0;
  let proposalOnlyLines = 0;
  for (const line of masterPlanMd.split("\n")) {
    if (!NOT_SHIPPED_PHRASE_RE.test(line)) continue;
    examinedLines++;
    let boundTaskId = false;
    let boundProposalOnly = false;
    for (const clause of line.split(CLAUSE_SPLIT_RE)) {
      if (!NOT_SHIPPED_PHRASE_RE.test(clause)) continue;
      const taskMatches = clause.match(TASK_ID_RE) ?? [];
      if (taskMatches.length > 0) {
        for (const m of taskMatches) ids.add(normalizeAssertedTaskId(m));
        boundTaskId = true;
        continue;
      }
      if (PROPOSAL_ID_RE.test(clause)) boundProposalOnly = true;
    }
    if (!boundTaskId && boundProposalOnly) proposalOnlyLines++;
  }
  return { ids: [...ids], examinedLines, proposalOnlyLines };
}

/** What the merge resolver the gather already holds reports for one task id, as a plain function
 *  so this rung stays keyed by raw STRING id: a prose-extracted id may resolve to no plan task.
 *  `undefined` means "the resolver has no opinion", never "unmerged". */
export type PlanStateTruthResolver = (taskId: string) => { merged: boolean; prUrl?: string } | undefined;

/** One task id the plan asserts unbuilt while the resolver reports it merged — design (v):
 *  "name the false claim, not the count". */
export interface PlanStateTruthFinding {
  taskId: string;
  prUrl?: string;
}

/** {@link planStateTruthRung}'s result — THREE STATES, THREE RENDERINGS (design (vii)), plus the
 *  fourth "unexamined" mode designs (iii) and (vi) require:
 *   - `unavailable`: no resolver in hand. The rung did not scan and vouches for nothing.
 *   - `unexamined`: the positive control failed. An empty scan must never render as `clean`.
 *   - `clean`: every extracted id that resolved is UNMERGED; the plan agrees with truth.
 *   - `findings`: an asserted-unbuilt id is MERGED. BLOCKING, and it outranks the plan-health
 *     sweep beside it, because it decides the KICK ORDER. */
export type PlanStateTruthReport =
  | { kind: "unavailable" }
  | { kind: "unexamined"; reason: string; examinedLines: number; proposalOnlyLines: number }
  | { kind: "clean"; examinedLines: number; proposalOnlyLines: number; idsChecked: number }
  | {
      kind: "findings";
      findings: PlanStateTruthFinding[];
      examinedLines: number;
      proposalOnlyLines: number;
      idsChecked: number;
    };

/** THE RUNG (W1-T410). Re-derives every task id MASTER-PLAN.md asserts unbuilt against `resolve`,
 *  the SAME merge resolver the retro gather already computed. `resolve` omitted means the caller
 *  has no projection in hand: `unavailable`, never a silent skip.
 *
 *  BOTH CONTROLS ARE BLOCKING (design (iii)), not merely test-time assertions. Empty extraction, or
 *  ids the resolver has no opinion on at all, reports `unexamined` — loud, never a clean pass. A
 *  run whose only bound subjects are proposals is the `proposalOnlyLines` count on an
 *  otherwise-clean report, never folded into `unexamined`. */
export function planStateTruthRung(masterPlanMd: string, resolve?: PlanStateTruthResolver): PlanStateTruthReport {
  if (!resolve) return { kind: "unavailable" };
  const { ids, examinedLines, proposalOnlyLines } = extractAssertedUnbuiltTaskIds(masterPlanMd);
  if (ids.length === 0) {
    return {
      kind: "unexamined",
      reason: `extraction yielded zero task ids across ${examinedLines} not-shipped-phrase-bearing line(s)`,
      examinedLines,
      proposalOnlyLines,
    };
  }
  const findings: PlanStateTruthFinding[] = [];
  let idsChecked = 0;
  for (const id of ids) {
    const resolution = resolve(id);
    if (!resolution) continue; // the resolver has no opinion on this id — not "unmerged"
    idsChecked++;
    if (resolution.merged) findings.push({ taskId: id, prUrl: resolution.prUrl });
  }
  if (idsChecked === 0) {
    return {
      kind: "unexamined",
      reason: `extracted ${ids.length} asserted-unbuilt id(s) but none resolved through the merge resolver at all`,
      examinedLines,
      proposalOnlyLines,
    };
  }
  if (findings.length > 0) return { kind: "findings", findings, examinedLines, proposalOnlyLines, idsChecked };
  return { kind: "clean", examinedLines, proposalOnlyLines, idsChecked };
}

/** Render {@link planStateTruthRung}'s report — four states, rendered distinctly. Printed ahead of
 *  the plan-health sweep: a contradiction here outranks that advisory floor. */
export function renderPlanStateTruth(report: PlanStateTruthReport): string {
  const header = "## Plan-state truth rung — MASTER-PLAN unbuilt assertions vs. merge state (W1-T410)";
  if (report.kind === "unavailable") {
    return `${header}\n\nUNAVAILABLE — no merge resolver in hand this run; the rung did not scan. Distinct from a clean result: this run is not vouching for MASTER-PLAN's unbuilt assertions at all.`;
  }
  const scanned = `(examined ${report.examinedLines} not-shipped-phrase-bearing line(s); ${report.proposalOnlyLines} proposal-subject line(s) skipped — proposal-subject assertions are outside this rung's reach, reported here rather than silently dropped)`;
  if (report.kind === "unexamined") {
    return `${header}\n\nUNEXAMINED — ${report.reason} ${scanned}. Treat as a scan failure, never as a clean result.`;
  }
  if (report.kind === "clean") {
    return `${header}\n\nNo contradiction: ${report.idsChecked} asserted-unbuilt id(s) resolved through the merge resolver, all still unmerged, agreeing with the plan's assertion ${scanned}.`;
  }
  return [
    header,
    "",
    `BLOCKING — the plan asserts ${report.findings.length} id(s) unbuilt that the merge resolver reports MERGED (this outranks the plan-health sweep below for KICK ORDER purposes — design (iv)):`,
    "",
    ...report.findings.map(
      (f) =>
        `- ${f.taskId}: MASTER-PLAN asserts UNBUILT, the merge resolver reports MERGED${f.prUrl ? ` via ${f.prUrl}` : " (no PR url on record)"}`,
    ),
    "",
    scanned,
  ].join("\n");
}

/** {@link planCoherenceRung}'s result — MIRRORS {@link PlanStateTruthReport}'s shape rather than
 *  inventing a second vocabulary. DELIBERATELY NO `unavailable` state: this rung reads no gateway.
 *  The one way it can fail to scan is an unlistable `plan/tasks.d/`, which is `unexamined`. */
/** What the caller found trying to ASSEMBLE the corpus. A discriminated union rather than
 *  `T[] | { reason }`, because `Array.isArray` does not narrow a `readonly T[] | object`. */
export type PlanCoherenceShardListing =
  | { ok: true; entries: readonly PlanCoherenceShardEntry[] }
  | { ok: false; reason: string };

export type PlanCoherenceReport =
  | { kind: "unexamined"; reason: string }
  | { kind: "clean"; shardsExamined: number; monolithRecordsExamined: number }
  | {
      kind: "findings";
      findings: PlanCoherenceFinding[];
      shardsExamined: number;
      monolithRecordsExamined: number;
    };

/** THE RUNG (W1-T2642, mirroring W1-T410's shape). Re-derives, every cycle, the question "do
 *  plan/tasks.yaml and plan/tasks.d/*.yaml disagree about which tasks EXIST" that NET STATE carried
 *  as unmeasured prose for fourteen cycles. `shards` carries `{ ok: false, reason }` exactly when
 *  the caller could not ASSEMBLE the corpus — not the back-compat "directory does not exist yet"
 *  case, which reads as zero shards. Either failure renders `unexamined`, never a `clean` over a
 *  scan that never ran (P48). */
export function planCoherenceRung(
  monolith: { path: string; text: string },
  shards: PlanCoherenceShardListing,
): PlanCoherenceReport {
  if (!shards.ok) {
    return { kind: "unexamined", reason: `the plan corpus could not be assembled: ${shards.reason}` };
  }
  let scan;
  try {
    scan = scanPlanCoherence(monolith, shards.entries);
  } catch (e) {
    // A blob that is not a parseable task list throws `PlanError`. THE MODULE STAYS STRICT AND THE
    // RUNG DEGRADES: report `unexamined` with the parser's message, never a `clean` (P48).
    return { kind: "unexamined", reason: `the plan corpus could not be parsed: ${String((e as Error)?.message ?? e)}` };
  }
  const counts = { shardsExamined: scan.shardsExamined, monolithRecordsExamined: scan.monolithRecordsExamined };
  if (scan.findings.length === 0) return { kind: "clean", ...counts };
  return { kind: "findings", findings: scan.findings, ...counts };
}

/** One {@link PlanCoherenceFinding} rendered as a single markdown bullet — one clause per
 *  finding kind, naming both disagreeing values and the path(s) involved. */
function renderPlanCoherenceFinding(f: PlanCoherenceFinding): string {
  switch (f.kind) {
    case "filename-id-mismatch":
      return `- ${f.path}: filename id "${f.filenameId}" disagrees with the record id inside it, "${f.recordId}"`;
    case "filing-count":
      return `- ${f.path}: holds ${f.recordCount} task record(s) (${f.recordIds.join(", ") || "none"}), expected exactly 1`;
    case "unparseable-path":
      return `- ${f.path}: does not match the plan/tasks.d/<id>-<slug>.yaml convention shardSlugFromPath expects — invisible to the duplicate-title corpus and every git log --grep recipe`;
    case "cross-file-duplicate":
      return `- ${f.id}: held by BOTH ${f.firstPath} and ${f.secondPath}`;
  }
}

/** Render {@link planCoherenceRung}'s report — three states, rendered distinctly. NEVER A BARE
 *  ZERO (P48): a clean corpus states the counts it examined. */
export function renderPlanCoherence(report: PlanCoherenceReport): string {
  const header = "## Plan-coherence rung — filename id vs. record id, one-task-per-file (W1-T2642)";
  if (report.kind === "unexamined") {
    return `${header}\n\nUNEXAMINED — ${report.reason}. Treat as a scan failure, never as a clean result.`;
  }
  const scanned = `${report.shardsExamined} shard(s) and ${report.monolithRecordsExamined} monolith record(s) examined`;
  if (report.kind === "clean") {
    return `${header}\n\nNo disagreements: ${scanned}, zero filename/record-id or one-task-per-file disagreements.`;
  }
  return [
    header,
    "",
    `${report.findings.length} disagreement(s) found (${scanned}):`,
    "",
    ...report.findings.map(renderPlanCoherenceFinding),
  ].join("\n");
}
