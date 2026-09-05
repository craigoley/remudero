#!/usr/bin/env node
// scripts/mount-headroom-sweep.mjs
//
// MOUNT HEADROOM SWEEP (W1-T2560, extended W1-T2574).
//
// W1-T2574 — A MOUNT COMPARISON ACROSS UNMATCHED POPULATIONS IS NOT A MEASUREMENT. The per-class
// census below (W1-T2560) reports turn/cost distributions per `task_class`, and that is correct
// for what it answers, but every run of a class rode the SAME mount for as long as
// `.remudero/mounts.yaml` was static — a corpus with no variation on the variable of interest
// supports no counterfactual about a DIFFERENT mount, however large it grows. A second provider
// (W1-T2572/W1-T2573) supplies that variation for free: `selectWorkerProvider` picks the
// subscription with the most headroom in its tightest window, a function of WINDOW STATE rather
// than task difficulty, so provider assignment is plausibly exogenous — but ONLY WITHIN a
// (type, risk, class) cell. High-risk work rides a higher mount BY POLICY, so aggregating across
// cells reports "expensive mounts fail more" when difficulty, not model, is talking.
//
// `computeArmSweep`/`compareArms` below are the fix: runs are grouped into CELLS
// (type x risk x class) and, WITHIN each cell only, into ARMS (provider x served_model x effort —
// `served_model` is `workerLedgerFields`'s own field, W1-T2572; `provider`/`effort` ride the same
// line). Every arm reports its own `n`. `compareArms` REFUSES — throwing `MountHeadroomSweepError`
// and naming BOTH cells — the moment it is asked to compare two arms that do not share a cell; the
// per-cell `comparisons` array below never attempts one (comparisons are built pairwise WITHIN one
// cell's own arm list), so the refusal is structural, not merely a check someone could skip.
// Every comparison also carries the corpus's own `newestTs` (see below), and reports whether the
// cheaper-looking arm's advantage HOLDS or DISAPPEARS once a re-dispatch's cost is charged to the
// one completed task it belongs to (`costPerCompletedTaskUsd`, not the naive per-run `costP50`).
//
// NOTHING MEASURES WHICH TASK CLASSES COULD TAKE A CHEAPER MOUNT. Every row in
// `.remudero/mounts.yaml` was chosen BY ARGUMENT, never by an observed distribution, so a model or
// effort change today is a guess in either direction. The ledger already carries turn counts,
// costs and outcomes for every retained run (`implement.done`/`recon.done`'s `num_turns`, the
// terminal `verdict` line's `cost_usd`/`verdict`) — this script is the ONE verb that reads them
// together, per `task_class`, so "sonnet would do here" becomes a measurement instead of an
// opinion. It REPORTS; it changes no mount, dispatches no worker, and recommends no model — that
// ruling belongs to a human (or W1-T2559, which owns any mount edit and depends on this task).
//
// PERCENTILES, NEVER A MEAN (see src/lib/cost-anomaly.ts's own identical rule): the mean is
// dragged by exactly the outlier a headroom sweep exists to find. Every distribution below is
// p50/p90/max.
//
// OUTCOME BEFORE COST. A class that is cheap because it fails early is not a cheaper-mount
// candidate — the cost column alone argues the opposite of the truth. Every class row below
// carries how many of its settled runs reached a passing verdict, how many ended `blocked_ci`,
// and how many were themselves a RE-DISPATCH (a later attempt at a task that already had one) —
// visible as such rather than folded into a bare average.
//
// COST PER COMPLETED TASK, NEVER PER REQUEST. `costPerCompletedTaskUsd` divides a class's total
// settled cost by its DISTINCT settled task_id count — not its run count — so a task needing two
// attempts (a fix strike, a re-dispatch) shows its real price instead of hiding it behind a
// per-run average that a second attempt would otherwise dilute.
//
// THIS SCRIPT CARRIES ITS OWN CONTROLS, because every prior census in this repo that did not has
// been wrong (this session alone produced a $1,279 figure and an $80,118 figure for the SAME
// corpus, both wrong, from queries that looked fine):
//   - ALL THREE ROTATION FORMS are read (`ledger.*.ndjson.gz`, plain `ledger.*.ndjson`, and the
//     live `ledger.ndjson`) via `ledgerRotationEntries` (src/lib/ledger-grep.ts) — the ONE shared
//     definition of "which files are ledger rotations", not a second glob that silently answers
//     from a subset. `corpus.formsOpened` NAMES which of the three this run actually saw.
//   - ROWS ARE DEDUPED BY run_id (via `gatherRuns`, src/lib/retro.ts, over exact-line-deduped
//     records — rotations duplicate heavily, so a raw row is not a run), and `corpus.rowToRunRatio`
//     prints how much a raw count would have overstated by, so archive duplication cannot inflate
//     a figure silently.
//   - `corpus.newestTs` is the corpus's own newest row, printed beside every number — a sweep
//     answering about a stale window is visible as such rather than looking current.
//   - A CORPUS THAT RESOLVES ZERO DISTINCT RUNS REFUSES (`MountHeadroomSweepError`) rather than
//     printing a report whose every class reads zero — a zero is not a measurement until a
//     positive control (the forms/archives/rows above) proves the query could see its corpus at
//     all; see this repo's own $1,279/$80,118 near-misses for why that distinction is load-bearing.
//
// NOT IN SCOPE, DELIBERATELY: changing `.remudero/mounts.yaml` (W1-T2559), spawning any worker,
// and recommending a model — this script makes no `child_process` call and writes nothing.
//
// Usage: node --import tsx scripts/mount-headroom-sweep.mjs [--root <repo-root>]
//          [--state-dir <dir>] [--json]
//   Defaults: --root process.cwd(), --state-dir <root>/state (the same "state/ledger.ndjson,
//   siblings rotate beside it" layout src/lib/log-rotation.ts's own header documents).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARCHITECT_LANE_STEPS, gatherRuns } from "../src/lib/retro.ts";
import { SYNTHESIS_ROLES } from "../src/lib/mounts.ts";
import { ledgerRotationEntries } from "../src/lib/ledger-grep.ts";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export class MountHeadroomSweepError extends Error {
  constructor(message) {
    super(message);
    this.name = "MountHeadroomSweepError";
  }
}

/** The live ledger's own filename — NEVER a rotation (see log-rotation.ts's
 *  `NEVER_ROTATE_FILENAME`, the same constant `ledgerRotationEntries` excludes by). Named as a
 *  literal here (not imported) so this script's ONLY dependency on log-rotation.ts stays inside
 *  `ledgerRotationEntries` itself — one shared corpus definition, not two. */
export const LIVE_LEDGER_FILENAME = "ledger.ndjson";

/** The minimal fs surface this script needs — injectable so a test drives a synthetic state dir
 *  rather than this host's real one (same discipline as ledger-grep.ts's `LedgerGrepFsDeps`). */
export const realMountHeadroomFs = {
  readdirSync: (dir) => readdirSync(dir),
  existsSync: (path) => existsSync(path),
  readFileSync: (path) => readFileSync(path),
  gunzipSync: (buf) => gunzipSync(buf),
};

/**
 * Read every ledger rotation under `stateDir` (both forms, via `ledgerRotationEntries`) plus the
 * live file, and return every non-blank raw line seen, IN READ ORDER, alongside which forms were
 * actually opened and which rotations (found on disk) could not be. Never throws: an unreadable
 * `stateDir` reads as "zero archives", the same discipline `resolveLedgerUnion` already uses.
 */
export function readLedgerCorpus(stateDir, fsDeps = realMountHeadroomFs) {
  let names = [];
  try {
    names = fsDeps.readdirSync(stateDir);
  } catch {
    names = [];
  }
  const rotations = ledgerRotationEntries(names, stateDir);
  const formsOpened = new Set();
  const unread = [];
  const rawLines = [];

  for (const entry of rotations) {
    try {
      const buf = fsDeps.readFileSync(entry.path);
      const text = (entry.form === "gzip" ? fsDeps.gunzipSync(buf) : buf).toString("utf8");
      formsOpened.add(entry.form);
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line) rawLines.push(line);
      }
    } catch {
      // Found on disk, could not be opened — named in `unread`, never silently skipped.
      unread.push(entry.path);
    }
  }

  const livePath = join(stateDir, LIVE_LEDGER_FILENAME);
  const liveFileRead = fsDeps.existsSync(livePath);
  if (liveFileRead) {
    try {
      const text = fsDeps.readFileSync(livePath).toString("utf8");
      formsOpened.add("live");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line) rawLines.push(line);
      }
    } catch {
      // Best-effort on the live half — same discipline resolveLedgerUnion applies to it.
    }
  }

  return {
    stateDir,
    archiveCount: rotations.length,
    liveFileRead,
    unread,
    formsOpened: [...formsOpened].sort(),
    rawLines,
  };
}

/**
 * Parse every raw line as JSON, DEDUPED BY EXACT LINE TEXT before a single record is retained —
 * the same mechanism src/lib/digest.ts's `readDigestWindow` uses, because rotations duplicate
 * whole overlapping windows verbatim: feeding a duplicate `implement.done` line to `gatherRuns`
 * twice would double-count that run's own turns, not merely inflate a display count. A torn line
 * is skipped, never thrown on. `rawRowsWithRunId` counts every PRE-DEDUP line carrying a string
 * `run_id` — the numerator {@link buildMountHeadroomSweep}'s `rowToRunRatio` needs to show how
 * much a raw count would have overstated by.
 */
export function parseAndDedupeLedgerLines(rawLines) {
  const seen = new Set();
  const records = [];
  let rawRowsWithRunId = 0;
  for (const line of rawLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.run_id === "string") rawRowsWithRunId++;
    if (seen.has(line)) continue;
    seen.add(line);
    records.push(parsed);
  }
  return { records, rawRowsWithRunId };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The p-th percentile of `values` (nearest-rank), NEVER a mean — see this script's own header.
 * `null` for an empty input (never a fabricated 0).
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const PASSING_VERDICT = "merged";
const BLOCKED_CI_VERDICT = "blocked_ci";

/** SETTLED, in the exact sense src/lib/cost-anomaly.ts already defines it: `verdict !==
 *  "incomplete"`. An in-flight run's partial turns/cost neither anchor a class's distribution nor
 *  are themselves part of an outcome split — the same reasoning that module states for its own
 *  median, applied here to every figure this script reports. */
function isSettled(run) {
  return run.verdict !== "incomplete";
}

/**
 * Every run_id that is NOT the earliest (by `startTs`, then `runId`) run of its own `taskId` — a
 * RE-DISPATCH: this task already had at least one prior attempt. Computed over the WHOLE retained
 * corpus, never scoped to one class first, because a task's later attempt can resolve to a
 * different `task_class` than its first one did.
 */
export function redispatchedRunIds(allRuns) {
  const byTask = new Map();
  for (const r of allRuns) {
    const arr = byTask.get(r.taskId) ?? [];
    arr.push(r);
    byTask.set(r.taskId, arr);
  }
  const out = new Set();
  for (const rs of byTask.values()) {
    if (rs.length <= 1) continue;
    const sorted = [...rs].sort((a, b) =>
      a.startTs < b.startTs ? -1 : a.startTs > b.startTs ? 1 : a.runId < b.runId ? -1 : 1,
    );
    for (let i = 1; i < sorted.length; i++) out.add(sorted[i].runId);
  }
  return out;
}

/**
 * Group SETTLED runs by `task_class` (`"unknown"` for a run with none, mirroring
 * src/lib/retro.ts's `aggregateByClass`) and compute, per class: the turn and cost p50/p90/max
 * (never a mean), the outcome split (passing / blocked_ci / re-dispatched), and the
 * cost-per-completed-task figure (total settled cost divided by DISTINCT settled task_id count,
 * never by run count — see this script's own header for why per-run hides a re-dispatch's real
 * price).
 */
export function computeClassSweep(runs) {
  const redispatched = redispatchedRunIds(runs);
  const byClass = new Map();
  for (const r of runs) {
    const key = r.taskClass ?? "unknown";
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  const out = [];
  for (const [taskClass, rs] of byClass) {
    const settled = rs.filter(isSettled);
    const turns = settled.map((r) => r.numTurns);
    const costs = settled.map((r) => r.costUsd);
    const passing = settled.filter((r) => r.verdict === PASSING_VERDICT).length;
    const blockedCi = settled.filter((r) => r.verdict === BLOCKED_CI_VERDICT).length;
    const redispatchedCount = settled.filter((r) => redispatched.has(r.runId)).length;
    const totalSettledCostUsd = round2(costs.reduce((s, c) => s + c, 0));
    const distinctSettledTasks = new Set(settled.map((r) => r.taskId)).size;
    out.push({
      taskClass,
      totalRuns: rs.length,
      settledRuns: settled.length,
      turnsP50: percentile(turns, 50),
      turnsP90: percentile(turns, 90),
      turnsMax: turns.length ? Math.max(...turns) : null,
      costP50: costs.length ? round2(percentile(costs, 50)) : null,
      costP90: costs.length ? round2(percentile(costs, 90)) : null,
      costMax: costs.length ? round2(Math.max(...costs)) : null,
      outcomes: { passing, blockedCi, redispatched: redispatchedCount },
      totalSettledCostUsd,
      distinctSettledTasks,
      costPerCompletedTaskUsd: distinctSettledTasks === 0 ? null : round2(totalSettledCostUsd / distinctSettledTasks),
    });
  }
  out.sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0));
  return out;
}

// ── W1-T2668: THE THREE ROWS THIS INSTRUMENT WAS BLIND TO ────────────────────────────────────
//
// `computeClassSweep` above groups by `task_class` over `gatherRuns`, which requires a `run.start`
// and sums turns from implement/recon done-steps. retro, triage and inbox_draft are not task runs:
// they carry no `task_class`, so they landed in "unknown" or nowhere at all. The one verb built to
// turn "sonnet would do here" into a measurement could not see the three rows an operator would
// act on — and `.remudero/mounts.yaml`'s own "$827 across 219 invocations" came from a hand query
// that nothing re-derives.
//
// NEITHER THE POPULATION NOR THE STEP NAMES ARE A NEW LIST. The rungs come from `SYNTHESIS_ROLES`
// (src/lib/mounts.ts) — the same constant `loadMounts` validates the `synthesis:` block against —
// so a fourth synthesis row added tomorrow is priced tomorrow. The step each writes comes from
// `ARCHITECT_LANE_STEPS` (src/lib/retro.ts), the ONE map that already identifies these lanes by
// "the ONE ledger `step` name each writes". A second copy of either would drift; the export is
// this task's only edit outside its own two files, and it is one line.
//
// THE DIVISOR IS NAMED, NOT REUSED. `computeClassSweep` divides by DISTINCT settled `task_id` —
// cost per completed TASK. A synthesis rung has no `task_id` and completes no task, so dividing by
// anything and calling it the same thing would be a category error. These rows report cost per
// INVOCATION and say so in the field name (`costPerInvocationUsd`), which is what the shard
// requires: "a stated equivalent (per invocation, named as such) rather than a silent reuse".

/**
 * One row per synthesis rung, from that rung's own terminal ledger step. Deduped by `run_id` the
 * same way `parseAndDedupeLedgerLines` dedupes the corpus — a rung that ledgers its terminal line
 * twice (a resumed retro, a rotation overlap) must count as ONE invocation, or the percentiles
 * describe the ledger's shape rather than the rung's.
 *
 * Percentiles, never means — the same discipline `computeClassSweep` carries, for the same reason:
 * one $40 outlier moves a mean and moves no percentile.
 */
export function computeSynthesisSweep(records) {
  const out = [];
  for (const rung of SYNTHESIS_ROLES) {
    const step = ARCHITECT_LANE_STEPS[rung];
    const byRunId = new Map();
    let rowsWithoutRunId = 0;
    for (const r of records) {
      if (r.step !== step) continue;
      if (typeof r.run_id !== "string" || r.run_id.length === 0) {
        rowsWithoutRunId += 1;
        continue;
      }
      if (!byRunId.has(r.run_id)) byRunId.set(r.run_id, r);
    }
    const rows = [...byRunId.values()];
    const turns = rows.map((r) => (typeof r.num_turns === "number" ? r.num_turns : 0));
    const costs = rows.map((r) => costOf(r));
    const totalCostUsd = round2(costs.reduce((s, c) => s + c, 0));
    out.push({
      rung,
      step,
      invocations: rows.length,
      rowsWithoutRunId,
      turnsP50: percentile(turns, 50),
      turnsP90: percentile(turns, 90),
      turnsMax: turns.length ? Math.max(...turns) : null,
      costP50: costs.length ? round2(percentile(costs, 50)) : null,
      costP90: costs.length ? round2(percentile(costs, 90)) : null,
      costMax: costs.length ? round2(Math.max(...costs)) : null,
      totalCostUsd,
      // NAMED per INVOCATION — see the block comment above. `null` rather than 0 when nothing was
      // seen: an unmeasured rung must never render as a free one.
      costPerInvocationUsd: rows.length === 0 ? null : round2(totalCostUsd / rows.length),
    });
  }
  return out;
}

/** `cost_usd`, falling back to `total_cost_usd` — the SAME precedence `gatherRuns`'s `costLine`
 *  and retro.ts's own lane-spend reader use, so a synthesis row is priced by the identical rule as
 *  every other row in this report. */
function costOf(r) {
  if (typeof r.cost_usd === "number") return r.cost_usd;
  if (typeof r.total_cost_usd === "number") return r.total_cost_usd;
  return 0;
}

// ── W1-T2574: CELLS (type x risk x class) and, WITHIN each, ARMS (provider x served_model x
// effort) — never the reverse, and never compared across cells. ────────────────────────────────

/** The SAME three worker-call steps src/lib/retro.ts's own (unexported) `DONE_STEPS` sums turns
 *  from. Duplicated here, deliberately, rather than imported: this task's own file scope is
 *  [this script, its test] — retro.ts's `RunSummary` carries no provider/served_model/effort
 *  field (nothing in this task adds one), so this script reads those three fields itself, off
 *  the same lines, rather than widening retro.ts to carry them. */
const ARM_DONE_STEPS = new Set(["recon.done", "implement.done", "implement.resumed"]);
const IMPLEMENTATION_DONE_STEPS = new Set(["implement.done", "implement.resumed"]);
const WINDOW_REASON_CAP = 8;
const WINDOW_REASON_LENGTH_CAP = 96;

/**
 * provider / served_model / effort per run_id, read directly off the raw (pre-`gatherRuns`)
 * ledger records. `workerLedgerFields` (src/lib/worker.ts, W1-T2572) writes `served_model` and
 * `effort` UNCONDITIONALLY on every {@link ARM_DONE_STEPS} line (`served_model` defaults to the
 * literal `null`, never an omitted key) and `provider` only when `WorkerResult.provider` was set.
 * So:
 *   - `servedModel` reads `"unreported"` for an explicit `served_model: null` (checked — the
 *     provider named nothing, W1-T2572's own honest-unknown) and `"unknown"` only when the key is
 *     absent altogether (a ledger line predating W1-T2572).
 *   - `provider` reads `"unknown"` when absent (a line predating provider ledgering).
 * The FIRST IMPLEMENTATION line for a run_id wins, regardless of where any `recon.done` row
 * appears in the ledger. `recon.done` is only a fallback for a recon-only run. The mount being
 * measured routes the implementation worker, so allowing a recon row to win would label the
 * implementation outcome with the recon model. Within implementation resumes, first still wins:
 * the retained production corpus has no run whose implementation resumes disagree on
 * provider/model/effort, and silently switching attribution on a later resume would be no more
 * honest than silently taking a recon row.
 */
export function armFieldsByRunId(records) {
  const out = new Map();
  const implementationRuns = new Set();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.run_id !== "string" || typeof r.step !== "string" || !ARM_DONE_STEPS.has(r.step)) continue;
    if (IMPLEMENTATION_DONE_STEPS.has(r.step)) {
      if (implementationRuns.has(r.run_id)) continue;
      out.set(r.run_id, fieldsFromDoneRow(r));
      implementationRuns.add(r.run_id);
      continue;
    }
    if (!out.has(r.run_id)) out.set(r.run_id, fieldsFromDoneRow(r));
  }
  return out;
}

function fieldsFromDoneRow(r) {
  return {
    provider: typeof r.provider === "string" ? r.provider : "unknown",
    servedModel:
      typeof r.served_model === "string" ? r.served_model : r.served_model === null ? "unreported" : "unknown",
    effort: typeof r.effort === "string" ? r.effort : "unknown",
  };
}

function boundedWindowReason(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const safe = value.replace(/[^A-Za-z0-9 ._:@/-]/g, "_").slice(0, WINDOW_REASON_LENGTH_CAP);
  return safe || fallback;
}

/**
 * Reduce the material per-call `window_consumption` sensor into one record per run, but only for
 * implementation calls — the worker a mounts-table change controls. Each call stays attached to
 * the provider/model/effort on its OWN done row and must match the run's selected implementation
 * arm. A mixed resume or cross-provider window is unreadable, never silently charged to the
 * first row. Subtotals remain visible, but a caller may use them only when `unreadableCalls == 0`.
 */
export function windowEvidenceByRunId(records, armFields) {
  const out = new Map();
  for (const r of records) {
    if (!r || typeof r !== "object" || typeof r.run_id !== "string" || !IMPLEMENTATION_DONE_STEPS.has(r.step)) continue;
    const evidence = out.get(r.run_id) ?? {
      eligibleCalls: 0,
      measuredCalls: 0,
      unreadableCalls: 0,
      totalPercentConsumed: 0,
      reasons: [],
    };
    evidence.eligibleCalls++;
    const reason = (value, fallback) => {
      evidence.unreadableCalls++;
      const bounded = boundedWindowReason(value, fallback);
      if (!evidence.reasons.includes(bounded) && evidence.reasons.length < WINDOW_REASON_CAP) evidence.reasons.push(bounded);
    };
    const selected = armFields.get(r.run_id);
    const rowFields = fieldsFromDoneRow(r);
    if (!selected || armKeyOf(selected) !== armKeyOf(rowFields)) {
      reason(undefined, "mixed-implementation-arm");
      out.set(r.run_id, evidence);
      continue;
    }
    const window = r.window_consumption;
    if (!window || typeof window !== "object") {
      reason(undefined, "missing-window-consumption");
      out.set(r.run_id, evidence);
      continue;
    }
    if (typeof r.ts === "string" &&
      (evidence.newestMeasurementTs === undefined || r.ts > evidence.newestMeasurementTs)) {
      evidence.newestMeasurementTs = r.ts;
    }
    if (window.provider !== selected.provider) {
      reason(undefined, "window-provider-mismatch");
      out.set(r.run_id, evidence);
      continue;
    }
    const percent = window.percent_consumed;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) {
      reason(window.reason, "invalid-percent-consumed");
      out.set(r.run_id, evidence);
      continue;
    }
    evidence.measuredCalls++;
    evidence.totalPercentConsumed += percent;
    out.set(r.run_id, evidence);
  }
  return out;
}

/** The (type, risk, class) CELL key — the SAME three axes `.remudero/mounts.yaml` routes on. */
export function cellKeyOf(run) {
  return `${run.type ?? "unknown"}::${run.risk ?? "unknown"}::${run.taskClass ?? "unknown"}`;
}

/** The (provider, served_model, effort) ARM key, WITHIN one cell. */
export function armKeyOf(fields) {
  return `${fields.provider}::${fields.servedModel}::${fields.effort}`;
}

/** The cheaper of two numeric figures' owning arm key, or `null` on a tie or missing data —
 *  never a guess when either side has nothing to compare. */
function cheaperArmKey(keyA, valA, keyB, valB) {
  if (typeof valA !== "number" || typeof valB !== "number") return null;
  if (valA === valB) return null;
  return valA < valB ? keyA : keyB;
}

/**
 * Compare TWO ARMS and REFUSE — loudly, naming BOTH cells — when they do not share the SAME
 * (type, risk, class) cell: provider assignment is only quasi-random WITHIN a cell
 * (`selectWorkerProvider` picks off window headroom, not task difficulty); across cells it tracks
 * POLICY (high-risk work rides a higher mount on purpose), so a cross-cell comparison reports
 * difficulty talking, not model — see this script's own header. This is the ONE function that
 * compares two arms, so it is the ONE place the refusal has to hold.
 *
 * OUTCOME BEFORE COST, restated for a pair: `cheaperByCostP50` is the NAIVE per-settled-run
 * figure (a re-dispatch's second run reads as just another row, same as any other run's).
 * `cheaperByCostPerCompletedTask` is the CHARGED figure ({@link computeArmSweep}'s
 * `costPerCompletedTaskUsd`, which already sums BOTH of a re-dispatched task's attempts over its
 * ONE completion). When the two disagree, the arm that looked cheaper per run is NOT actually
 * cheaper once its re-dispatches are charged to it: `advantageHoldsUnderRedispatch: false`, and
 * `note` names which arm's advantage disappeared.
 */
export function compareArms(armA, armB) {
  if (armA.cellKey !== armB.cellKey) {
    throw new MountHeadroomSweepError(
      `mount-headroom-sweep: REFUSED — arm "${armA.armKey}" (cell ${armA.cellKey}) and arm ` +
        `"${armB.armKey}" (cell ${armB.cellKey}) do not share a (type, risk, class) cell. Comparing ` +
        `arms that were never matched on (type, risk, class) measures task difficulty, not model — ` +
        `see this script's own header. Compare arms only WITHIN a shared cell.`,
    );
  }

  const cheaperByCostP50 = cheaperArmKey(armA.armKey, armA.costP50, armB.armKey, armB.costP50);
  const cheaperByCostPerCompletedTask = cheaperArmKey(
    armA.armKey,
    armA.costPerCompletedTaskUsd,
    armB.armKey,
    armB.costPerCompletedTaskUsd,
  );
  const advantageHoldsUnderRedispatch =
    cheaperByCostP50 && cheaperByCostPerCompletedTask ? cheaperByCostP50 === cheaperByCostPerCompletedTask : null;

  let note;
  if (cheaperByCostP50 && cheaperByCostPerCompletedTask && cheaperByCostP50 !== cheaperByCostPerCompletedTask) {
    note =
      `${cheaperByCostP50} looked cheaper per settled run, but ${cheaperByCostPerCompletedTask} is cheaper per ` +
      `COMPLETED task once re-dispatch cost is charged to it — ${cheaperByCostP50}'s cost advantage disappears ` +
      `under the charged metric.`;
  } else if (cheaperByCostP50 && cheaperByCostP50 === cheaperByCostPerCompletedTask) {
    note =
      `${cheaperByCostP50} is cheaper both per settled run and per completed task — its cost advantage holds ` +
      `once re-dispatch cost is charged.`;
  } else {
    note = "insufficient settled cost data in one or both arms to compare";
  }

  return {
    cellKey: armA.cellKey,
    armKeyA: armA.armKey,
    armKeyB: armB.armKey,
    nA: armA.n,
    nB: armB.n,
    cheaperByCostP50,
    cheaperByCostPerCompletedTask,
    advantageHoldsUnderRedispatch,
    note,
    newestTs: armA.newestTs ?? armB.newestTs,
  };
}

/**
 * Group runs into (type, risk, class) CELLS and, WITHIN each cell, into (provider, served_model,
 * effort) ARMS. `redispatchedRunIds` runs over the WHOLE corpus first (a re-dispatch can resolve
 * to a different class than its first attempt — see that function's own doc), so an arm's
 * re-dispatch count is correct even though the grouping below is scoped per cell/arm. Every arm
 * carries its own `n` (settled run count) beside every figure — a comparison resting on a handful
 * of runs is visible as such. Every cell with two or more arms gets EVERY pairwise
 * {@link compareArms} comparison, scoped structurally to that one cell's own arm list, so a
 * cross-cell comparison is never even attempted.
 */
export function computeArmSweep(runs, armFields, newestTs, windowEvidence = new Map()) {
  const redispatched = redispatchedRunIds(runs);
  const cellsByKey = new Map();
  for (const r of runs) {
    const cellKey = cellKeyOf(r);
    const fields = armFields.get(r.runId) ?? { provider: "unknown", servedModel: "unknown", effort: "unknown" };
    const armKey = armKeyOf(fields);
    let cell = cellsByKey.get(cellKey);
    if (!cell) {
      cell = {
        cellKey,
        type: r.type ?? "unknown",
        risk: r.risk ?? "unknown",
        taskClass: r.taskClass ?? "unknown",
        armsByKey: new Map(),
      };
      cellsByKey.set(cellKey, cell);
    }
    let arm = cell.armsByKey.get(armKey);
    if (!arm) {
      arm = { cellKey, armKey, provider: fields.provider, servedModel: fields.servedModel, effort: fields.effort, runs: [] };
      cell.armsByKey.set(armKey, arm);
    }
    arm.runs.push(r);
  }

  const cells = [];
  for (const cell of cellsByKey.values()) {
    const arms = [];
    for (const arm of cell.armsByKey.values()) {
      const settled = arm.runs.filter(isSettled);
      const turns = settled.map((r) => r.numTurns);
      const costs = settled.map((r) => r.costUsd);
      const passing = settled.filter((r) => r.verdict === PASSING_VERDICT).length;
      const blockedCi = settled.filter((r) => r.verdict === BLOCKED_CI_VERDICT).length;
      const redispatchedCount = settled.filter((r) => redispatched.has(r.runId)).length;
      const totalSettledCostUsd = round2(costs.reduce((s, c) => s + c, 0));
      const distinctSettledTasks = new Set(settled.map((r) => r.taskId)).size;
      let eligibleCalls = 0;
      let measuredCalls = 0;
      let unreadableCalls = 0;
      let totalPercentConsumed = 0;
      let newestMeasurementTs;
      const windowReasons = [];
      for (const run of settled) {
        const evidence = windowEvidence.get(run.runId);
        if (!evidence) continue;
        eligibleCalls += evidence.eligibleCalls;
        measuredCalls += evidence.measuredCalls;
        unreadableCalls += evidence.unreadableCalls;
        totalPercentConsumed += evidence.totalPercentConsumed;
        if (evidence.newestMeasurementTs &&
          (newestMeasurementTs === undefined || evidence.newestMeasurementTs > newestMeasurementTs)) {
          newestMeasurementTs = evidence.newestMeasurementTs;
        }
        for (const reason of evidence.reasons) {
          if (!windowReasons.includes(reason) && windowReasons.length < WINDOW_REASON_CAP) windowReasons.push(reason);
        }
      }
      if (eligibleCalls === 0) windowReasons.push("no-implementation-window-calls");
      const completeWindowEvidence = eligibleCalls > 0 && measuredCalls === eligibleCalls && unreadableCalls === 0;
      arms.push({
        cellKey: cell.cellKey,
        armKey: arm.armKey,
        provider: arm.provider,
        servedModel: arm.servedModel,
        effort: arm.effort,
        n: settled.length,
        totalRuns: arm.runs.length,
        settledRuns: settled.length,
        turnsP50: percentile(turns, 50),
        turnsP90: percentile(turns, 90),
        turnsMax: turns.length ? Math.max(...turns) : null,
        costP50: costs.length ? round2(percentile(costs, 50)) : null,
        costP90: costs.length ? round2(percentile(costs, 90)) : null,
        costMax: costs.length ? round2(Math.max(...costs)) : null,
        outcomes: { passing, blockedCi, redispatched: redispatchedCount },
        totalSettledCostUsd,
        distinctSettledTasks,
        costPerCompletedTaskUsd:
          distinctSettledTasks === 0 ? null : round2(totalSettledCostUsd / distinctSettledTasks),
        windowShare: {
          provider: arm.provider,
          percentConsumedPerCompletedTask:
            completeWindowEvidence && distinctSettledTasks > 0 ? round2(totalPercentConsumed / distinctSettledTasks) : null,
        },
        windowEvidence: {
          eligibleCalls,
          measuredCalls,
          unreadableCalls,
          reasons: windowReasons,
          ...(newestMeasurementTs ? { newestMeasurementTs } : {}),
        },
        newestTs,
      });
    }
    arms.sort((a, b) => (a.armKey < b.armKey ? -1 : a.armKey > b.armKey ? 1 : 0));

    const comparisons = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) comparisons.push(compareArms(arms[i], arms[j]));
    }
    cells.push({ cellKey: cell.cellKey, type: cell.type, risk: cell.risk, taskClass: cell.taskClass, arms, comparisons });
  }
  cells.sort((a, b) => (a.cellKey < b.cellKey ? -1 : a.cellKey > b.cellKey ? 1 : 0));
  return cells;
}

/**
 * THE ONE ENTRY POINT: read the union corpus, dedup, reduce into per-run summaries
 * (`gatherRuns`), and build the per-class sweep. Throws {@link MountHeadroomSweepError} when the
 * corpus resolves to ZERO distinct runs — never a report whose every class reads zero, which
 * would be indistinguishable from a real (if boring) finding. Spawns nothing, writes nothing,
 * mutates no mount — a pure read-and-reduce over the ledger, exactly like
 * src/lib/cost-anomaly.ts's own detector.
 */
export function buildMountHeadroomSweep(stateDir, fsDeps = realMountHeadroomFs) {
  const corpus = readLedgerCorpus(stateDir, fsDeps);
  const { records, rawRowsWithRunId } = parseAndDedupeLedgerLines(corpus.rawLines);
  const runs = gatherRuns(records);

  if (runs.length === 0) {
    throw new MountHeadroomSweepError(
      `mount-headroom-sweep: REFUSED — zero distinct runs resolved from ${stateDir} ` +
        `(forms opened: ${corpus.formsOpened.length ? corpus.formsOpened.join(", ") : "(none)"}, ` +
        `archives: ${corpus.archiveCount}, live file read: ${corpus.liveFileRead}, ` +
        `unread rotations: ${corpus.unread.length}) — a zero here is not a measurement until a ` +
        `positive control proves this query could see its corpus at all (see this script's own header).`,
    );
  }

  let newestTs;
  for (const r of records) {
    if (typeof r.ts === "string" && (newestTs === undefined || r.ts > newestTs)) newestTs = r.ts;
  }

  const armFields = armFieldsByRunId(records);
  const windowEvidence = windowEvidenceByRunId(records, armFields);

  return {
    corpus: {
      stateDir: corpus.stateDir,
      formsOpened: corpus.formsOpened,
      archiveCount: corpus.archiveCount,
      liveFileRead: corpus.liveFileRead,
      unread: corpus.unread,
      rawRowsWithRunId,
      distinctRunCount: runs.length,
      rowToRunRatio: round2(rawRowsWithRunId / runs.length),
      newestTs,
    },
    classes: computeClassSweep(runs),
    // W1-T2668: the three rows the per-task_class grouping above is structurally unable to see.
    synthesis: computeSynthesisSweep(records),
    // W1-T2574: (type x risk x class) cells, each carrying its own (provider x served_model x
    // effort) arms and every WITHIN-cell pairwise comparison — see this script's own header.
    cells: computeArmSweep(runs, armFields, newestTs, windowEvidence),
  };
}

/**
 * W1-T2708 — THE LANE-RESTORE BASELINE, RECORDED IN THIS INSTRUMENT'S OWN VOCABULARY.
 *
 * `dispatchLanes`' comment in plan/policy.yaml holds the fleet at 2 and states the release:
 * "Restore to 3 once burn per run is down, and record the measurement that justifies it rather
 * than restoring on optimism." That posture is right. What it lacked was a comparable left-hand
 * side: the only per-run figures in the table sat one block over, in `reviewLanes` prose — "a
 * review lane is cheap ($0.63/run measured, against implement at $5.28)", 2026-09-01 — naming no
 * STATISTIC, no CORPUS WINDOW and no COMMAND.
 *
 * THAT AMBIGUITY FLIPS THE ANSWER, WHICH IS WHY IT IS NOT PEDANTRY. Measured 2026-09-02 over 67
 * archives, all three rotation forms, 801,987 raw rows deduped to 749 distinct runs: class `src`
 * read cost p50 4.94 / p90 11.34 / max 38.46. If `$5.28` was a MEDIAN, today's p50 is a 6.4%
 * improvement and the condition is MET. If it was a MEAN, today's mean is necessarily ABOVE 4.94
 * (a p90 of 11.34 and a max of 38.46 guarantee it) and burn may be UP. The same two numbers
 * support opposite rulings, and nothing recorded decides between them — an operator session
 * already came within a step of comparing 5.28 against a p50 as though the statistics matched.
 *
 * SO THE 2026-09-01 FIGURE IS NOT RESTATED, IT IS SUPERSEDED. Its statistic is unrecoverable, and
 * a figure that can be read two ways is worse than none. The baseline below is the 2026-09-02
 * reading, which names all four fields BECAUSE IT CAME FROM THIS SCRIPT — the one instrument that
 * commits to "PERCENTILES, NEVER A MEAN" (see this file's header).
 *
 * A CONSTANT, NOT PROSE, BECAUSE THE DELIVERABLE IS A COMPUTED CONDITION. "A prose figure
 * re-copied into the right row is the same defect one row over" — so the comparison is READ OFF
 * THE TOOL rather than argued, and a test pins plan/policy.yaml's own comment to this object so
 * the two cannot drift.
 */
export const LANE_RESTORE_BASELINE = Object.freeze({
  /** The statistic, named. Both sides of the comparison must be this same percentile. */
  statistic: "p50",
  /** Which `task_class` row the figure is drawn from — a cross-class comparison is not one. */
  taskClass: "src",
  /** The figure itself, in USD per run. */
  costUsd: 4.94,
  /** The corpus window it was taken over — a sweep answering about a stale window must show it. */
  corpusNewestTs: "2026-09-02T14:00:27.894Z",
  corpusDistinctRuns: 749,
  /** The exact command that produced it, so the reading is reproducible rather than asserted. */
  command: "node --import tsx scripts/mount-headroom-sweep.mjs --state-dir <state-dir>",
});

/** The four fields a baseline MUST name before anything may be compared against it — the exact
 *  list W1-T2708's rationale says the 2026-09-01 figure was missing. */
export const REQUIRED_BASELINE_FIELDS = Object.freeze(["statistic", "taskClass", "costUsd", "command"]);

/** Percentile names this comparison will accept on EITHER side. A mean is refused by name: this
 *  script's own header states why ("the mean is dragged by exactly the outlier a headroom sweep
 *  exists to find"), and the whole defect being fixed is a figure whose statistic was unknown and
 *  might have been one. */
export const ACCEPTED_STATISTICS = Object.freeze(["p50", "p90"]);

/**
 * W1-T2708 — compare the current sweep's reading against {@link LANE_RESTORE_BASELINE}, in the
 * SAME statistic, and REFUSE loudly rather than compare anyway when that is not possible.
 *
 * REPORTS, RULES ON NOTHING. The returned object says whether the recorded condition reads met on
 * this corpus; it changes no lane count, edits no policy row and recommends no restore. Whether to
 * take the third lane is an operator ruling with its own evidence — the memory ceiling bears on it
 * too — and this task deliberately does not reopen it.
 *
 * Returns `null` when the corpus carries no row for the baseline's class: an absent class is not a
 * reading of zero, and reporting one would be the vacuous-pass shape this repo keeps paying for.
 */
export function compareToLaneRestoreBaseline(report, baseline = LANE_RESTORE_BASELINE) {
  for (const field of REQUIRED_BASELINE_FIELDS) {
    const value = baseline?.[field];
    if (value === undefined || value === null || value === "") {
      throw new MountHeadroomSweepError(
        `lane-restore baseline is missing \`${field}\` — a baseline that does not name its ` +
          `statistic, class, figure and command cannot be compared to this sweep's own output, ` +
          `which is the exact defect W1-T2708 was filed against. Refusing rather than comparing anyway.`,
      );
    }
  }
  if (!ACCEPTED_STATISTICS.includes(baseline.statistic)) {
    throw new MountHeadroomSweepError(
      `lane-restore baseline names statistic \`${baseline.statistic}\`, which is not one of ` +
        `${ACCEPTED_STATISTICS.join("/")}. This sweep reports PERCENTILES, NEVER A MEAN (see this ` +
        `file's header), so a mean on either side is not comparable and is refused.`,
    );
  }
  const row = (report.classes ?? []).find((r) => r.taskClass === baseline.taskClass);
  if (!row) return null; // no row for that class — an absent reading, never a zero
  const currentKey = baseline.statistic === "p50" ? "costP50" : "costP90";
  const current = row[currentKey];
  if (typeof current !== "number") return null; // the class settled no runs — again, absent, not zero
  return {
    statistic: baseline.statistic,
    taskClass: baseline.taskClass,
    baselineUsd: baseline.costUsd,
    currentUsd: current,
    /** Down means the recorded release condition READS met on this corpus. It is a reading, not a ruling. */
    down: current < baseline.costUsd,
    deltaUsd: Number((current - baseline.costUsd).toFixed(2)),
    baselineCorpusNewestTs: baseline.corpusNewestTs ?? null,
    currentCorpusNewestTs: report.corpus?.newestTs ?? null,
    command: baseline.command,
  };
}

/** One rendered block for {@link compareToLaneRestoreBaseline}'s result — named beside the table
 *  it is drawn from, never on a separate page a reader could skip past (this file's own rule). */
export function renderLaneRestoreComparison(comparison) {
  if (comparison === null) {
    return (
      `lane-restore condition: NOT ANSWERABLE on this corpus — no settled ${LANE_RESTORE_BASELINE.taskClass} ` +
      `row to read a ${LANE_RESTORE_BASELINE.statistic} from. An absent reading is not a reading of zero.`
    );
  }
  return (
    `lane-restore condition (reports only, rules on nothing): ${comparison.taskClass} cost ` +
    `${comparison.statistic} ${comparison.currentUsd} vs baseline ${comparison.baselineUsd} ` +
    `(${comparison.statistic}, taken over a corpus whose newest row was ${comparison.baselineCorpusNewestTs}; ` +
    `this corpus's newest row: ${comparison.currentCorpusNewestTs}) — burn per run reads ` +
    `${comparison.down ? "DOWN" : "NOT DOWN"} (${comparison.deltaUsd >= 0 ? "+" : ""}${comparison.deltaUsd}). ` +
    `Reproduce with: ${comparison.command}`
  );
}

/** Render {@link buildMountHeadroomSweep}'s report as plain text — every control this script
 *  carries (forms opened, row:run ratio, newest ts) printed BESIDE the per-class table, never on
 *  a separate page a reader could skip past. */
export function renderMountHeadroomReport(report) {
  const c = report.corpus;
  const lines = [];
  lines.push("mount-headroom-sweep — per-task_class turn/cost distributions from the retained ledger (spawns nothing)");
  lines.push(
    `corpus: ${c.stateDir} — forms opened: ${c.formsOpened.length ? c.formsOpened.join(", ") : "(none)"}; ` +
      `${c.archiveCount} archive(s) found, live file read: ${c.liveFileRead}` +
      `${c.unread.length ? `, UNREAD (found, could not open): ${c.unread.join(", ")}` : ""}`,
  );
  lines.push(
    `rows: ${c.rawRowsWithRunId} raw run-tagged row(s) -> ${c.distinctRunCount} distinct run(s) via run_id dedup ` +
      `(row:run ratio ${c.rowToRunRatio}x — archive duplication, never a real run count)`,
  );
  lines.push(
    `newest row seen: ${c.newestTs ?? "(none)"} — a sweep answering about a stale window would show it here`,
  );
  lines.push("");
  lines.push(
    "task_class | settled/total runs | turns p50/p90/max | cost p50/p90/max ($) | passing | blocked_ci | " +
      "re-dispatched | $/completed task",
  );
  for (const row of report.classes) {
    lines.push(
      `${row.taskClass} | ${row.settledRuns}/${row.totalRuns} | ` +
        `${row.turnsP50 ?? "-"}/${row.turnsP90 ?? "-"}/${row.turnsMax ?? "-"} | ` +
        `${row.costP50 ?? "-"}/${row.costP90 ?? "-"}/${row.costMax ?? "-"} | ` +
        `${row.outcomes.passing} | ${row.outcomes.blockedCi} | ${row.outcomes.redispatched} | ` +
        `${row.costPerCompletedTaskUsd ?? "-"}`,
    );
  }

  // W1-T2668: the synthesis rungs, in their OWN table immediately under the per-task_class one —
  // never appended as extra rows to it. They are priced on a DIFFERENT divisor (per invocation,
  // not per completed task) and carry no outcome split, so a shared table would put two different
  // units in one column, which is how a reader ends up comparing them.
  lines.push("");
  lines.push(
    "synthesis rung | invocations | turns p50/p90/max | cost p50/p90/max ($) | total $ | $/INVOCATION " +
      "(never $/completed task — these rungs complete no task and carry no task_id)",
  );
  for (const row of report.synthesis ?? []) {
    lines.push(
      `${row.rung} (${row.step}) | ${row.invocations} | ` +
        `${row.turnsP50 ?? "-"}/${row.turnsP90 ?? "-"}/${row.turnsMax ?? "-"} | ` +
        `${row.costP50 ?? "-"}/${row.costP90 ?? "-"}/${row.costMax ?? "-"} | ` +
        `${row.totalCostUsd} | ${row.costPerInvocationUsd ?? "-"}` +
        (row.rowsWithoutRunId > 0 ? ` | ${row.rowsWithoutRunId} row(s) dropped: no run_id to dedupe on` : ""),
    );
  }
  lines.push(
    "  (this table REPORTS; it recommends no model and changes no mount — the ruling on any row " +
      "belongs to a human, exactly as the per-task_class table above)",
  );

  // W1-T2708: the lane-restore condition, READ OFF THE TOOL, immediately under the table whose
  // row it is drawn from — so "is burn per run down" is a reading rather than an argument, and a
  // reader cannot see the figure without also seeing which statistic and which window it is.
  lines.push("");
  lines.push(renderLaneRestoreComparison(compareToLaneRestoreBaseline(report)));

  // W1-T2574: cells (type x risk x class), each carrying its own provider x served_model x
  // effort arms and every WITHIN-cell comparison — NEVER a cross-cell one (see this script's own
  // header, and compareArms's own refusal).
  lines.push("");
  lines.push(
    "cells (type x risk x class) — arms keyed by provider x served_model x effort, compared ONLY within their own cell",
  );
  for (const cell of report.cells) {
    lines.push(`cell ${cell.cellKey} (type=${cell.type}, risk=${cell.risk}, class=${cell.taskClass}):`);
    for (const arm of cell.arms) {
      lines.push(
        `  arm ${arm.armKey} (provider=${arm.provider}, served_model=${arm.servedModel}, effort=${arm.effort}) — ` +
          `n=${arm.n} (${arm.settledRuns}/${arm.totalRuns} settled/total) | cost p50/p90/max ($): ` +
          `${arm.costP50 ?? "-"}/${arm.costP90 ?? "-"}/${arm.costMax ?? "-"} | passing ${arm.outcomes.passing}, ` +
          `blocked_ci ${arm.outcomes.blockedCi}, re-dispatched ${arm.outcomes.redispatched} | ` +
          `$/completed task ${arm.costPerCompletedTaskUsd ?? "-"} | ` +
          `window=${arm.windowShare.percentConsumedPerCompletedTask === null
            ? "unreadable"
            : `${arm.windowShare.percentConsumedPerCompletedTask}%`}/completed-task; ` +
          `coverage=${arm.windowEvidence.measuredCalls}/${arm.windowEvidence.eligibleCalls}; ` +
          `unreadable=${arm.windowEvidence.unreadableCalls}; ` +
          `newest=${arm.windowEvidence.newestMeasurementTs ?? "(none)"}` +
          `${arm.windowEvidence.reasons.length ? `; reasons=${arm.windowEvidence.reasons.join(",")}` : ""} | ` +
          `newest row seen: ${arm.newestTs ?? "(none)"}`,
      );
    }
    if (cell.arms.length < 2) {
      lines.push(`  only ${cell.arms.length} arm(s) in this cell — no within-cell comparison is possible`);
    }
    for (const cmp of cell.comparisons) {
      lines.push(
        `  compare ${cmp.armKeyA} (n=${cmp.nA}) vs ${cmp.armKeyB} (n=${cmp.nB}): ${cmp.note} ` +
          `(newest row seen: ${cmp.newestTs ?? "(none)"})`,
      );
    }
  }
  return lines.join("\n");
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      "state-dir": { type: "string" },
      json: { type: "boolean" },
    },
  });

  const root = values.root ?? process.cwd();
  const stateDir = values["state-dir"] ?? join(root, "state");

  let report;
  try {
    report = buildMountHeadroomSweep(stateDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(values.json ? JSON.stringify(report, null, 2) : renderMountHeadroomReport(report));
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/mount-headroom-sweep.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
