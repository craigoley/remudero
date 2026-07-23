/**
 * `rmd retro` — the DETERMINISTIC GATHER (no LLM) that feeds the Architect retro.
 *
 * MASTER-PLAN §Self-improvement: the harness must SYNC ITS OWN PLAN. Nothing here
 * calls a model — it reduces the append-only ledger + LEARNINGS into a structured
 * gather (calibration by task type, verdict distribution, merged-since list) that
 * the higher-tier Architect worker then synthesizes into a plan-only PR. Separation
 * of GENERATION (this, deterministic) from PUBLICATION (the gate + the human) is the
 * governance that stops the harness shipping garbage at the speed of light [research].
 */

import { execFileSync } from "node:child_process";
// The DEFAULT export -- a plain, mutable object -- so a test's `t.mock.method` can
// actually intercept the marker's read/write calls: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) -- saveMarker/loadMarker below call `fsMarker.*` as live
// property lookups at call time for exactly this reason (test/retro-marker-atomic.test.ts).
import fsMarker from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./plan.js";
import { lintTask, type LintOpts, type LintViolation } from "./task-linter.js";

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
  /**
   * Present only when a `correction.provenance` ledger line overrode this run's
   * ledger-claimed PR url (W1-T51/P9-b — the false-attribution class, e.g. run
   * W1-T54b-1784151420811: `verdict.pr_url` claimed #80, the correction names #91).
   * Holds the ORIGINAL claimed url that was overridden; `prUrl` above is always
   * the truth (corrected when a correction exists, the ledger's own claim otherwise).
   */
  correctedFromPrUrl?: string;
  /** The task's risk band at `run.start` time (§9 mount axis), if logged. Used
   *  by {@link mineOverrunClasses} to group overruns by (type, risk) — the same
   *  axis mounts.yaml routes on — rather than by type alone. */
  risk?: string;
  /**
   * The task's routing CLASS (W1-T167 — docs / plan-lint / the `src` default)
   * at `run.start` time, if logged. The third mount-routing axis alongside
   * type/risk; {@link aggregateByClass} groups on this so the retro can read
   * per-class cost/merge-rate and evaluate whether the routing table's cheaper
   * docs/plan-lint mounts are actually cheaper AND still merging.
   */
  taskClass?: string;
  /** The worker-error `subtype` off the terminal `verdict` line (e.g.
   *  `error_max_turns`, `error_max_budget_usd`), if the run ended in one. A
   *  clean merge or a non-error verdict carries no subtype. */
  subtype?: string;
}

const DONE_STEPS = new Set(["recon.done", "implement.done", "implement.resumed"]);

/**
 * A `correction.provenance` line for this run, if any — a FIRST-CLASS ledger
 * EVENT (MASTER-PLAN P9-iv): the operator has already written the truth (an
 * `actual_pr_url`) over a run's false ledger claim, and every reducer must honor
 * it rather than re-deriving the false claim. Last one wins if several exist.
 */
function correctionFor(lines: LedgerRecord[]): string | undefined {
  let url: string | undefined;
  for (const l of lines) {
    if (l.step === "correction.provenance" && typeof l.actual_pr_url === "string") url = l.actual_pr_url;
  }
  return url;
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
      prUrl: correctedUrl ?? claimedPrUrl,
      ...(correctedUrl !== undefined ? { correctedFromPrUrl: claimedPrUrl } : {}),
      ...(typeof start.risk === "string" ? { risk: start.risk } : {}),
      ...(typeof start.task_class === "string" ? { taskClass: start.task_class } : {}),
      ...(typeof verdictLine?.subtype === "string" ? { subtype: verdictLine.subtype } : {}),
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

/**
 * Calibration aggregate for one task CLASS (W1-T167 — docs / plan-lint / src) —
 * the same shape as {@link TypeCalibration}, grouped on the routing table's
 * THIRD axis instead of the first, plus `mergeRate` (merged/runs) since a
 * per-class table exists specifically to answer "is this class's cheaper
 * mount still merging" — the retro needs the rate, not just the raw count, to
 * evaluate the routing hypothesis (design note: "routing is a hypothesis to
 * be measured, not asserted").
 */
export interface ClassCalibration {
  taskClass: string;
  runs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgTurns: number;
  merged: number;
  mergeRate: number;
}

/**
 * Aggregate runs BY TASK CLASS (W1-T167 calibration table) — mirrors {@link
 * aggregateByType} exactly, grouped by {@link RunSummary.taskClass} instead of
 * `type`. A run with no `taskClass` (a ledger line predating W1-T167, or any
 * step that never logged it) is grouped under `"unknown"` rather than dropped
 * — an omitted class is itself a fact the retro should see, not silently lose.
 */
export function aggregateByClass(runs: RunSummary[]): ClassCalibration[] {
  const byClass = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const key = r.taskClass ?? "unknown";
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  const out: ClassCalibration[] = [];
  for (const [taskClass, rs] of byClass) {
    const totalCost = rs.reduce((s, r) => s + r.costUsd, 0);
    const totalTurns = rs.reduce((s, r) => s + r.numTurns, 0);
    const merged = rs.filter((r) => r.verdict === "merged").length;
    out.push({
      taskClass,
      runs: rs.length,
      totalCostUsd: round(totalCost),
      avgCostUsd: round(totalCost / rs.length),
      avgTurns: round(totalTurns / rs.length),
      merged,
      mergeRate: round(merged / rs.length),
    });
  }
  out.sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0));
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
// `mergedSince` above keys ONLY on ledger verdict==='merged', so a PR that merges
// GATE-SIDE after its run ended some other terminal verdict (a Rule-16 Architect
// fix landing after a blocked_review run) is INVISIBLE to it — the gap this task
// closes. `mergedSince` itself is left untouched (no regression, MASTER-PLAN P11);
// `shippedSince` below is the sibling that unions both sources.

/** A run's own worktree branch — deterministic, matches run-task.ts's `run-<runId>` naming. */
export function ownBranchOf(runId: string): string {
  return `run-${runId}`;
}

/**
 * ONE cheap `gh api rate_limit` probe (W1-T132 design ii) — meant to back a
 * real `ShippedGithub.unavailable()` for `retroCommand`'s production gateway.
 * Checked ONCE per retro, BEFORE any merge is credited, so a quota exhaustion
 * (or any other `gh` CLI failure — auth expiry, network outage) is NAMED
 * rather than silently read through `findMergedByTrailer`/`headRefName`
 * returning null/undefined for every query, which looks identical to "GitHub
 * genuinely has no evidence". Self-contained: does not touch lib/status.ts's
 * `ghGateway` or its fail-soft `tryJson`, and does not depend on (or wait for)
 * W1-T119's future three-valued `deriveStatus` read — but agrees with its
 * polarity, unavailable is never silently absent. Never throws; a probe that
 * itself crashes the retro over a transient CLI hiccup would be worse than the
 * silent-zero bug this task fixes.
 */
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

/**
 * The GitHub queries `shippedSince` needs: a trailer lookup for the GitHub-side
 * union half, and a PR's head branch for the P9 ownership assert — the exact
 * shape of run-task.ts's `PrHeadGateway` (W1-T62's write-side guard), applied
 * here at the READ side. A real implementation composes `status.ts`'s
 * `ghGateway` (for `findMergedByTrailer`) with a `gh pr view --json headRefName`
 * lookup (for `headRefName`), mirroring run-task.ts's `ghPrHeadGateway`.
 */
export interface ShippedGithub {
  /** Find a MERGED PR whose body contains `Remudero-Task: <taskId>`. null if none. */
  findMergedByTrailer(taskId: string): { number: number; url: string } | null;
  /** The PR's head branch name, or undefined if it cannot be resolved. */
  headRefName(prUrl: string): string | undefined;
  /**
   * W1-T132 DEGRADE LOUDLY (design ii): when the gateway itself is known to be
   * throttled, erroring, or otherwise unavailable (rate-limited, auth expired,
   * transport/network failure), return a human-readable reason NAMING it.
   * Returns undefined when the gateway is healthy — including for a caller that
   * never wires this optional method at all, so an untouched implementer sees
   * no behavior change. Checked ONCE per {@link buildGather} call, BEFORE any
   * credit is rendered: `RetroGather.githubUnavailable` carries the reason, and
   * `renderGather` surfaces it prominently instead of letting a zero-merge read
   * (every `findMergedByTrailer`/`headRefName` call failing silently under a
   * throttle) pass as a confirmed "nothing shipped" — the exact silent-zero
   * failure this task exists to close. Self-contained: does not depend on (or
   * wait for) W1-T119's future three-valued `deriveStatus` read, but agrees
   * with its polarity — unavailable is never silently read as absent.
   */
  unavailable?(): string | undefined;
}

/** The result of the SHIPPED union: what got credited, and every named discrepancy. */
export interface ShippedResult {
  shipped: ShippedRecord[];
  discrepancies: string[];
}

/**
 * UNION ledger-merged runs with GitHub-derived merged Remudero-Task-trailered PRs,
 * scoped to runs started strictly after `sinceTs` (W1-T51). Each ledger-ABSENT
 * merge (a run that ended some OTHER terminal verdict, whose task nonetheless has
 * a merged trailered PR on GitHub) is credited with source "github" and annotated
 * `gate-side merge; run ended <verdict>` — the gap `mergedSince` alone cannot see.
 *
 * P9 OWNERSHIP ASSERT (retro#1784155126258, the false-attribution class): before
 * crediting ANY merge — ledger OR GitHub side — the credited PR's `headRefName`
 * must equal the claiming run's OWN branch ({@link ownBranchOf}). A stale/foreign
 * trailer (the #80/W1-T54b class: PR #80 is Dependabot's own PR, not the run's)
 * or an unresolved head ref is REJECTED — never credited — and named in
 * `discrepancies` rather than silently dropped or silently trusted.
 *
 * P9 CORRECTION-AWARE: `runs` is expected to already carry the correction
 * override (see {@link gatherRuns}'s `correctedFromPrUrl` handling) — a
 * `correction.provenance` line's `actual_pr_url` is what `RunSummary.prUrl`
 * holds, so the ownership assert checks (and credits) the TRUTH, never the
 * original false claim.
 *
 * Every rejection AND every GitHub-side addition is named in `discrepancies` —
 * the SHIPPED log can never silently miss (or wrongly gain) a merge.
 */
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

/** The ledger-only fallback for `RetroGather.shipped` when no GitHub gateway is
 * wired — IDENTICAL to today's `mergedSince` crediting (no ownership check, no
 * annotation): a caller that hasn't wired a gateway yet gets no regression and
 * no unverified claim, rather than a default that silently trusts everything. */
function ledgerOnlyShipped(merged: RunSummary[]): ShippedRecord[] {
  return merged
    .filter((r): r is RunSummary & { prUrl: string } => typeof r.prUrl === "string")
    .map((r) => ({ taskId: r.taskId, runId: r.runId, prUrl: r.prUrl, costUsd: r.costUsd, numTurns: r.numTurns, source: "ledger" as const }));
}

/** Count LEARNINGS entries (top-level `- ` bullets) — used for the added-since delta. */
export function learningsCount(learningsMd: string): number {
  return learningsMd.split("\n").filter((l) => /^- /.test(l)).length;
}

/**
 * Files under `src/` or `test/` touched by a unified diff. A retro is PLAN-ONLY —
 * it must touch NONE (one concern: the harness syncs its PLAN, never ships code in
 * the same PR). The retro command fails closed when this returns non-empty.
 */
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

/**
 * Enforce G-17: the retro Architect MUST ride a higher tier than the implement
 * workers it reviews. Throws (fail-closed) on violation — a same-or-lower-tier
 * synthesizer is not an Architect.
 */
export function assertArchitectAboveWorker(architectModel: string, workerModel: string): void {
  if (tierOf(architectModel) <= tierOf(workerModel)) {
    throw new Error(
      `G-17 Tier Invariant: retro Architect (${architectModel}, tier ${tierOf(architectModel)}) must ` +
        `ride a HIGHER tier than implement workers (${workerModel}, tier ${tierOf(workerModel)}).`,
    );
  }
}

// ── The full gather + its rendering ───────────────────────────────────────

export interface RetroGather {
  sinceTs?: string;
  totalRuns: number;
  byType: TypeCalibration[];
  /** W1-T167: per-class (docs / plan-lint / src) cost + merge-rate — the
   *  measurement half of the routing hypothesis (the table itself is in
   *  .remudero/mounts.yaml; this is what tells the retro if it's working). */
  byClass: ClassCalibration[];
  verdicts: Record<string, number>;
  mergedSince: RunSummary[];
  /** The SHIPPED union (W1-T51) — ledger ∪ GitHub-derived, ownership-asserted, correction-aware. */
  shipped: ShippedRecord[];
  /** Every named discrepancy the union found (gate-side additions AND rejected foreign trailers). */
  discrepancies: string[];
  /** W1-T73: every MERGED run whose `review.posted` matched a degraded-success
   *  signal (a claimed PASS that used a weaker path than its criteria named). */
  degradedSuccess: DegradedSuccessFinding[];
  /** W1-T87/P13: the other half of the flywheel — merged-run shapes shared by
   *  >=2 runs, mined as procedural-learning candidates for the Architect to
   *  phrase and ratify (never auto-filed). */
  proceduralCandidates: ProceduralCandidate[];
  learningsNow: number;
  learningsAtMarker: number;
  /**
   * W1-T132: present ONLY when `opts.github.unavailable()` named a reason (a
   * throttle, an error, or any other confirmed outage) — never set for a
   * healthy gateway or for the ledger-only fallback (which carries no opinion
   * on GitHub's health at all). `renderGather` refuses to present `shipped`
   * as a complete/confirmed count while this is set.
   */
  githubUnavailable?: string;
}

/**
 * Build the whole deterministic gather from raw inputs. Pure over its injected
 * `github` gateway (deps.github omitted ⇒ `shipped` degrades to the ledger-only
 * list, same as today's `mergedSince` — no GitHub union, no ownership assert,
 * no unverified annotation; see {@link ledgerOnlyShipped}).
 */
export function buildGather(opts: {
  ledgerNdjson: string;
  learningsMd: string;
  sinceTs?: string;
  learningsAtMarker?: number;
  /** GitHub gateway for the SHIPPED union (W1-T51/P9). Omit to fall back ledger-only. */
  github?: ShippedGithub;
}): RetroGather {
  const records = parseLedger(opts.ledgerNdjson);
  const runs = gatherRuns(records);
  const scoped = opts.sinceTs ? runs.filter((r) => r.startTs > opts.sinceTs!) : runs;
  const merged = mergedSince(runs, opts.sinceTs);
  const { shipped, discrepancies } = opts.github
    ? shippedSince(runs, opts.sinceTs, opts.github)
    : { shipped: ledgerOnlyShipped(merged), discrepancies: [] as string[] };
  // W1-T132 (design ii): checked ONCE, after the union runs (so a healthy union
  // still gets full credit) — a reason here means the read layer itself is not
  // trustworthy, regardless of what shippedSince managed to resolve anyway.
  const githubUnavailable = opts.github?.unavailable?.();
  return {
    sinceTs: opts.sinceTs,
    totalRuns: scoped.length,
    byType: aggregateByType(scoped),
    byClass: aggregateByClass(scoped),
    verdicts: verdictDistribution(scoped),
    mergedSince: merged,
    shipped,
    discrepancies,
    // W1-T73: mined over the SAME scoped-merged set the marker window already
    // bounds, so a degraded-success finding never re-surfaces for a run the
    // marker has already moved past (matches mergedSince's own scoping).
    degradedSuccess: mineDegradedSuccess(merged, records),
    // W1-T87/P13: same marker-scoped window as degradedSuccess above — a
    // shape never re-surfaces for a run the marker has already moved past.
    proceduralCandidates: mineProceduralCandidates(merged, records),
    learningsNow: learningsCount(opts.learningsMd),
    learningsAtMarker: opts.learningsAtMarker ?? 0,
    ...(githubUnavailable ? { githubUnavailable } : {}),
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

/** Render the per-class calibration table (markdown, W1-T167) — the routing
 *  table's effectiveness, measured. */
export function classCalibrationTable(byClass: ClassCalibration[]): string {
  const rows = byClass.map(
    (c) =>
      `| ${c.taskClass} | ${c.runs} | ${c.merged} | ${(c.mergeRate * 100).toFixed(0)}% | $${c.avgCostUsd.toFixed(3)} | ${c.avgTurns} | $${c.totalCostUsd.toFixed(3)} |`,
  );
  return [
    "| task_class | runs | merged | merge rate | avg $ | avg turns | total $ |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Render the full gather as a human/Architect-readable report. */
export function renderGather(g: RetroGather): string {
  // W1-T132 (design ii): a throttled/errored/absent gateway must SAY SO BY NAME
  // and must NEVER let the SHIPPED section read as a confirmed zero — an empty
  // list gets an explicit INDETERMINATE line instead of the ordinary "(none)".
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
    renderDegradedSuccess(g.degradedSuccess),
    "",
    renderProceduralCandidates(g.proceduralCandidates),
  ].join("\n");
}

// ── §5C plan-health sweep (W1-T20d, Standing rule 20) ─────────────────────
//
// Rules are enforced FORWARD-ONLY at authoring time (the CI half of §5C Layer
// A, task-linter.ts's `changedTaskIds` scoping). W1-T12 pre-existed Rules
// 18/19, violated both, and still reached a worker — burning 81 turns/$10.27
// (the FOURTH max_turns event) — because nothing ever re-checked an
// ALREADY-AUTHORED task against a rule added after it was written. The retro
// closes that gap: every run, it re-lints the WHOLE open queue (not just a
// PR's own edit) and turns every violation into a named corrective-task
// proposal for the Architect's plan-only PR to act on.

/** Statuses that mean a task has already shipped — everything else is OPEN
 *  and in scope for the plan-health sweep (mirrors plan.ts's own merged set,
 *  kept local since plan.ts does not export it). */
const CLOSED_TASK_STATUSES = new Set(["merged", "done"]);

/** One OPEN task the sweep found in violation, with its BLOCKING violations only
 *  (a WARN, e.g. budget-sanity, is visibility-only and never files a corrective task). */
export interface PlanHealthFlag {
  taskId: string;
  violations: LintViolation[];
}

/** A proposed corrective task, auto-filed per violating OPEN task — DATA for the
 *  Architect's plan-only PR to ratify, never written to plan/tasks.yaml directly
 *  (Standing rule 16: only the Architect authors tasks). */
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

/**
 * RE-GRADE every OPEN task against every standing rule the deterministic
 * linter encodes (sizing/Rule 19, headless-fitness/Rule 18, proof-shape,
 * provenance/Rules 16-17) — the forward-only gap Standing rule 20 names. A
 * MERGED/DONE task is out of scope (it already shipped; re-litigating it fixes
 * nothing). Pure: no I/O, no plan/tasks.yaml write — the corrective tasks are
 * PROPOSALS the retro's Architect stage files, same discipline as the
 * `learnings/` corpus shards never being hand-edited outside a reviewed PR.
 */
export function planHealthSweep(
  tasks: Task[],
  optsFor: (task: Task) => LintOpts = () => ({}),
): PlanHealthReport {
  const flags: PlanHealthFlag[] = [];
  const correctiveTasks: CorrectiveTaskProposal[] = [];
  for (const task of tasks) {
    if (CLOSED_TASK_STATUSES.has(task.status)) continue; // out of scope — already shipped
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
// "If a CLASS of task overruns... propose a CLASS-level fix... NOT another
// per-task patch" (MASTER-PLAN §5C). W1-T6, W1-T9, W1-T12 were three SEPARATE
// per-task rescues for the SAME class (implement × medium) before the pattern
// was named — the reactive-diagnosis anti-pattern this sweep exists to kill.

/** Terminal verdicts that represent an OVERRUN/blocked outcome worth mining for
 *  a class pattern — every non-merge terminal state a run can end in. DATA, not
 *  hardcoded logic, same pattern as task-linter.ts's lexicons. */
export const OVERRUN_VERDICTS: ReadonlySet<string> = new Set([
  "blocked",
  "blocked_ci",
  "blocked_review",
  "blocked_budget",
  "blocked_containment",
  "blocked_isolation",
  "blocked_inflight",
  "blocked_git_fetch",
  "blocked_illformed",
  "blocked_transient",
  "no_pr",
  "pr_attribution_failed",
  "failed",
]);

/** A run counts as an overrun for mining purposes: a listed verdict, OR a
 *  `failed` run whose subtype names the max-turns runaway class specifically. */
function isOverrunRun(r: RunSummary): boolean {
  return OVERRUN_VERDICTS.has(r.verdict);
}

/** The (task_type × risk) key — the SAME two axes mounts.yaml (§9) routes on —
 *  so a mined class maps directly onto a mount-table row, not an ad hoc bucket. */
function overrunClassKey(r: RunSummary): string {
  return `${r.type}:${r.risk ?? "unknown"}`;
}

/** ONE proposed class-level fix, covering every run in that (type, risk) class —
 *  never one proposal per task (the anti-pattern this mining exists to kill). */
export interface ClassOverrunProposal {
  taskType: string;
  risk: string;
  count: number;
  taskIds: string[];
  verdicts: string[];
  proposal: string;
}

/**
 * MINE the ledger's overrun/blocked verdicts for a task-CLASS pattern. Returns
 * ONE {@link ClassOverrunProposal} per (type, risk) class that meets
 * `opts.threshold` (default 2 — "repeated") overruns, never one per offending
 * task. Below threshold, a class is a single incident, not yet a pattern, and
 * is silently omitted (no proposal) rather than over-fitted to one data point.
 */
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
// The overrun mining above reads FAILURE verdicts. It is blind to a run that
// ended MERGED — a claimed PASS — yet took a WEAKER path than its own
// acceptance criteria named: `review.posted`'s `proof_exec` array already
// records, per criterion, whether a proof was OBSERVED (`executed_pass`/
// `executed_fail`) or fell back to the keyword floor (`not_executable`/
// `exec_error`) — the field is ALREADY on the ledger (W1-T65/P15) but nothing
// read it for the retro's own report, so RETRO-1784213948025 gathered the
// same 2-run ledger that showed `proof_exec 0/N` and logged the run as a
// closed win without ever surfacing it — the same "claimed work it did not
// do" class the retro already names for FAILURE, unapplied to the gate's own
// PASS. The signal set below is DATA (a list of predicates over one run's
// most-recent `review.posted` line), same discipline as `OVERRUN_VERDICTS`
// above: the next degraded-success class is a table row, never new mining
// code.

/** The reduced `review.posted` facts one signal predicate judges against —
 *  the run's MOST RECENT posting (a run may re-post across fix strikes;
 *  only its latest posting reflects what actually merged). */
export interface ReviewPostedSummary {
  runId: string;
  taskId: string;
  /** Count of criteria whose `proof_exec` is `executed_pass`/`executed_fail`. */
  executed: number;
  /** Total criteria judged (the ledgered `proof_exec` array's length). */
  total: number;
  /** W1-T72's legibility flag — true when EVERY criterion fell back to the
   *  keyword floor while >=1 proof was WRITTEN in the house dialect. */
  floorDegraded: boolean;
  /** W1-T63/P10-a — the advisory reviewer spawn's terminal subtype, when logged
   *  (e.g. `error_max_turns`, `spawn_error`). Absent if never logged. */
  reviewerOutcome?: string;
}

/**
 * Reduce every `review.posted` ledger line to the LATEST posting per run_id —
 * a run may post more than once across fix strikes, and only its latest
 * posting reflects what actually merged. A run that never posted a review
 * (pre-W1-T65 history, or a synthetic fixture) has no entry — nothing to mine.
 */
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

/**
 * One weaker-path-than-claimed signal — DATA, not a hardcoded branch (same
 * discipline as {@link OVERRUN_VERDICTS}): the next degraded-success class
 * (e.g. a future capped-but-merged shape) is a ROW added here, never new
 * executor code.
 */
export interface DegradedSuccessSignal {
  /** Stable identifier, named on every finding this signal produces. */
  key: string;
  matches: (r: ReviewPostedSummary) => boolean;
  /** Human-readable explanation, folded into the finding's rendered line. */
  describe: (r: ReviewPostedSummary) => string;
}

/** The shipped signal table. Row 1 is the canonical fixture (RETRO-1784213948025 /
 *  W1-T65): a merged run whose review posted `proof_exec` entirely unexecuted
 *  while >=1 proof was written to be runnable (house dialect). Row 2 is the
 *  W1-T73 design's named second class (a merged run whose advisory reviewer
 *  never completed a real pass) — proof the set generalizes as data. */
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

/**
 * Mine MERGED runs for degraded-success telemetry (W1-T73): a run that ended
 * `verdict: merged` — a claimed PASS — whose most recent `review.posted`
 * ledger line matches a {@link DegradedSuccessSignal}. Pure over the raw
 * ledger records + the already-reduced run summaries, so calling it twice
 * over the SAME fixture returns the SAME findings — never accumulating or
 * duplicating (each call re-derives from scratch). A run matching more than
 * one signal emits one finding PER matching signal, naming every weaker-path
 * class it hit rather than only the first.
 */
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
// Everything above mines FAILURE (overruns) or a weaker-than-claimed PASS
// (degraded success) — half the compounding loop MASTER-PLAN P13 names. The
// other half is blind: a run that merged CLEAN — first attempt, every
// acceptance criterion actually OBSERVED, not keyword-floored — is a
// POSITIVE signal whose shape is captured NOWHERE, so the prompt/recon/fix
// shape that produced it is never distilled into reusable procedural memory.
//
// This mines MERGED runs for that shape, DETERMINISTICALLY (rule 2 — the
// signal set is DATA, same discipline as OVERRUN_VERDICTS/
// DEGRADED_SUCCESS_SIGNALS above): every field a {@link ProceduralCandidate}
// carries is computed here, before any LLM ever sees it.
// {@link phraseProceduralCandidate} is the ONLY place an LLM enters this
// pipeline, and it receives nothing but the already-mined candidate — it
// PHRASES the fact, it never invents the evidence.
//
// BLOAT GUARD (design: "one success is an anecdote"): a shape needs
// `threshold` (default 2) SUPPORTING runs before it becomes a candidate —
// mirrors {@link mineOverrunClasses}'s identical guard on the failure side.
//
// NO PARALLEL STORE: a candidate, once phrased, is a {@link
// ProceduralLearningDraft} — the SAME shape (`fact`/`src`/`files`) a
// learnings.ts `LearningEntry` already carries, tagged only by `subsystem:
// "procedural"`. It rides the EXISTING lifecycle/injection/consolidation
// machinery (W1-T33/W1-T19) like any other entry; only the Architect writes
// it into a `learnings/*.yaml` shard (Standing rule 15 — never auto-filed).

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

/**
 * One deterministic success shape — DATA, not a hardcoded branch (mirrors
 * {@link DegradedSuccessSignal}): the next reusable-procedure class is a ROW
 * added here, never new mining code.
 */
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

/**
 * MINE merged runs for a procedure shape shared by >= `opts.threshold` runs
 * (default 2 — a single success is an anecdote, not yet a pattern). Only a
 * run matching >=1 {@link ProceduralSuccessSignal} is considered at all; a
 * run matching none has nothing to contribute. Pure over the already-reduced
 * run summaries plus the raw ledger records (needed only for the
 * `fix.dispatch` count and the `review.posted` reduction) — no LLM, no I/O;
 * calling it twice over the SAME fixture returns the SAME candidates.
 */
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

/** Render the mined procedural candidates (markdown) — printed by `--dry-run` and fed to the Architect, which drafts the actual learning (Standing rule 15: only the Architect authors learnings). */
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

// ── Phrasing — the ONLY step where an LLM enters (W1-T87/P13) ────────────

/**
 * Injected phrasing dependency — receives ONLY the already-mined {@link
 * ProceduralCandidate}, never raw ledger records or other candidates
 * (mirrors learnings.ts's `PromotionJudgeDeps.judge` shape: evidence is
 * deterministic, the model only phrases/judges over it).
 */
export interface ProceduralPhraseDeps {
  phrase: (candidate: ProceduralCandidate) => string | Promise<string>;
}

/**
 * ONE draft, shaped to become a `LearningEntry` (learnings.ts) once the
 * Architect ratifies it into a `learnings/*.yaml` shard — same fields, NO
 * parallel store. `subsystem: "procedural"` is the only tag distinguishing
 * it; once admitted it rides the EXACT SAME `active|superseded|quarantined`
 * lifecycle and `selectLearnings` matcher as any other entry.
 */
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

/**
 * PHRASE one mined candidate into a {@link ProceduralLearningDraft}. The
 * ONLY step in this whole pipeline that touches an LLM — `deps.phrase`
 * receives NOTHING but the candidate {@link mineProceduralCandidates}
 * already computed (never the ledger, never sibling candidates), so a
 * stubbed `deps` proves the evidence/phrasing split by construction: a test
 * asserting the stub's received argument deep-equals the input candidate is
 * the falsifier.
 */
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

// ── The retro marker (state/last-retro.json) ──────────────────────────────

export interface RetroMarker {
  ts: string;
  learnings_count: number;
  runs_seen: number;
}

/**
 * Thrown by loadMarker when state/last-retro.json EXISTS but fails to parse -- a torn
 * write, manual corruption, or a foreign format. This is DISTINCT from the marker
 * being genuinely absent (RetroMarker | undefined, the only legitimate
 * first-ever-retro signal): a corrupt-but-present marker must never be silently
 * collapsed into "no marker" the way the pre-fix reader did, because that replays the
 * whole already-consumed run window and double-counts SHIPPED/learnings. Every caller
 * MUST fail closed on this (abort the retro), never catch-and-treat-as-undefined.
 */
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

/**
 * Load the last-retro marker.
 *  - File absent (ENOENT)         -> undefined (the ONLY legitimate first-ever-retro signal).
 *  - File present, unparseable    -> throws MarkerCorruptError. NEVER undefined -- see the
 *                                     class doc for why collapsing this to undefined is the bug.
 *  - File present, parseable      -> the RetroMarker.
 */
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

/**
 * Resolve the last-retro marker for the gather step. A caller (retroCommand) MUST
 * branch on `.kind` rather than reduce this back to `marker | undefined`, because
 * "absent" and "corrupt" require OPPOSITE handling:
 *  - "absent"  — genuinely no marker has ever been written. The ONLY state that
 *                legitimately widens the gather to the full run history
 *                (sinceTs=undefined) — this is the real first-ever-retro case.
 *  - "corrupt" — the marker file exists but failed to parse (a torn write, manual
 *                edit, ...). MUST fail closed and abort — never fall through to
 *                "absent"'s full-history gather, which would reprocess the run
 *                window the corrupt marker already recorded as consumed and
 *                double-count SHIPPED/learnings.
 *  - "ok"      — a valid marker; gather scopes to sinceTs = marker.ts.
 */
export function resolveMarkerForGather(path: string): MarkerResolution {
  try {
    const marker = loadMarker(path);
    return marker === undefined ? { kind: "absent" } : { kind: "ok", marker };
  } catch (e) {
    if (e instanceof MarkerCorruptError) return { kind: "corrupt", error: e };
    throw e;
  }
}

/**
 * Save the last-retro marker as ONE atomic unit: staged into a same-directory temp
 * file with a single writeSync call, then swapped into place with a single
 * renameSync (atomic on any POSIX filesystem). A plain writeFileSync here would let
 * a reader (loadMarker) observe a torn/partial file mid-write and — pre-fix — that
 * torn read was misread as FIRST-EVER-RETRO, reprocessing the whole already-consumed
 * run window and double-counting SHIPPED/learnings. The rename swap makes that torn
 * state unreachable: a reader only ever sees the whole old file or the whole new one.
 */
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

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── docs/ORIENTATION.md — the Architect handoff doc (W1-T39) ──────────────
//
// "A fresh Architect session should orient from ONE small doc, not re-derive
// state from a 900-line plan + a ledger." ORIENTATION.md states: current
// state, the next runnable task, and the never-do invariants. It is
// MAINTAINED BY `rmd retro` (never hand-edited) so it can never go stale —
// the retro already computes the gather and derives the next task from the
// SAME GitHub-projected status drain uses; this only renders it.

/** Collapse a wrapped markdown fragment into one line, stripping bold markers
 *  (the Standing rules use `**TITLE**` emphasis that reads oddly mid-sentence
 *  once collapsed). Pure text transform — no interpretation of meaning. */
function collapseRuleText(s: string): string {
  return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Extract the numbered "never-do" invariants from MASTER-PLAN.md's own
 * `## 12. Standing rules` section — a pure text extraction (no LLM, no
 * interpretation) so ORIENTATION.md's invariant list can never drift from
 * the source of truth by hand-copy. Each rule (numbered `N.` or `NB.` at the
 * start of a line) is returned as one collapsed, re-wrapped line; a rule's
 * continuation lines (indented markdown wrap) are folded back in. Returns
 * `[]` if the section heading is not found (fail-soft — a missing section
 * yields an empty invariants list, never a thrown error, since ORIENTATION
 * generation must never abort a retro over a heading rename).
 */
export function extractStandingRules(masterPlanMd: string): string[] {
  const lines = masterPlanMd.split("\n");
  const startIdx = lines.findIndex((l) => /^## 12\. Standing rules\s*$/.test(l));
  if (startIdx === -1) return [];
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## /.test(l));
  if (endIdx === -1) endIdx = lines.length;
  const section = lines.slice(startIdx + 1, endIdx);

  const rules: string[] = [];
  let current = "";
  const isRuleStart = (l: string) => /^\d+[A-Z]?\.\s+\S/.test(l);
  const isBullet = (l: string) => /^[-*]\s+\S/.test(l);
  for (const raw of section) {
    const line = raw.trim();
    if (!line) continue;
    if (isRuleStart(line)) {
      if (current) rules.push(collapseRuleText(current));
      current = line;
    } else if (isBullet(line)) {
      // A markdown bullet (`- ...`) is NOT a numbered rule's wrapped continuation —
      // it marks trailing prose after the numbered list (e.g. this section's closing
      // notes on how MASTER-PLAN.md itself is maintained). Stop extracting: nothing
      // past the numbered list is a Standing rule, however this section is worded later.
      if (current) rules.push(collapseRuleText(current));
      current = "";
      break;
    } else if (current) {
      current += " " + line;
    }
  }
  if (current) rules.push(collapseRuleText(current));
  return rules;
}

/** Everything {@link renderOrientation} needs to render docs/ORIENTATION.md. */
export interface OrientationInput {
  /** ISO timestamp of this retro run — injected by the caller (retro.ts is pure; it never calls Date itself). */
  generatedAt: string;
  /** The same deterministic gather the retro's plan-sync PR is built from. */
  gather: RetroGather;
  /** The next runnable task per the SAME DAG + GitHub-derived-status logic
   *  `rmd drain` dispatches from ({@link import("./drain.js").nextRunnable}) —
   *  `undefined` when nothing is currently runnable. */
  nextTask?: Task;
  /** MASTER-PLAN §12 Standing rules, extracted via {@link extractStandingRules}. */
  standingRules: string[];
}

/**
 * Render docs/ORIENTATION.md: current state (the deterministic gather),
 * the next runnable task (DAG + GitHub-derived, matching `rmd drain`'s own
 * pick), and the never-do invariants (MASTER-PLAN §12, extracted verbatim).
 * Pure — no I/O; the caller writes the returned string to disk.
 */
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
    ? standingRules.map((r) => `- ${r}`)
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
