#!/usr/bin/env node
// scripts/mount-headroom-sweep.mjs
//
// Mount headroom sweep (W1-T2560, extended W1-T2574/W1-T2668/W1-T2708): reads the ledger and
// reports turn/cost distributions per task_class, per synthesis rung, and per (type, risk, class)
// cell, so a mount change is a measurement instead of a guess. It writes nothing, spawns nothing,
// and recommends no model — see docs/forensics/mount-headroom-sweep.md for the incident record and
// CLAUDE.md's "Ledger and evidence discipline" for the corpus controls shared with every other
// ledger reader (rotation forms, dedup, a zero-runs refusal).
//
// INVARIANT: a comparison across (type, risk, class) cells is not a measurement — provider
// assignment is only quasi-random WITHIN a cell, so `compareArms` refuses
// (`MountHeadroomSweepError`, naming both cells) instead. FALSIFIER:
// test/a-mount-comparison-across-unmatched-populations-is-not-a-measurement.test.ts.
//
// INVARIANT: every distribution is a percentile, never a mean, and cost is charged PER COMPLETED
// TASK so a re-dispatch cannot hide behind a per-run average; any mount edit is a human ruling (or
// W1-T2559). FALSIFIER: test/mount-headroom-sweep.test.ts,
// test/a-routing-recommendation-is-a-proposal-never-a-live-mutation.test.ts.
//
// Usage: node --import tsx scripts/mount-headroom-sweep.mjs [--root <repo-root>] [--state-dir <dir>] [--json]
//   Defaults: --root process.cwd(), --state-dir <root>/state.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { ARCHITECT_LANE_STEPS, gatherRuns } from "../src/lib/retro.ts";
import { SYNTHESIS_ROLES } from "../src/lib/mounts.ts";
import { ledgerRotationEntries } from "../src/lib/ledger-grep.ts";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export { REPO_ROOT };

export class MountHeadroomSweepError extends Error {
  constructor(message) {
    super(message);
    this.name = "MountHeadroomSweepError";
  }
}

/** The live ledger's own filename — NEVER a rotation (log-rotation.ts's `NEVER_ROTATE_FILENAME`).
 *  Named as a literal so this script's only dependency on log-rotation.ts stays inside `ledgerRotationEntries`. */
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
 * Read every ledger rotation under `stateDir` (both forms) plus the live file, IN READ ORDER, with
 * which forms were opened and which rotations could not be read. Never throws.
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
 * Parse every raw line as JSON, DEDUPED BY EXACT LINE TEXT before a record is retained — rotations
 * duplicate whole windows verbatim. A torn line is skipped, never thrown on. `rawRowsWithRunId`
 * counts every pre-dedup line carrying a string `run_id`, the numerator `rowToRunRatio` needs.
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

/** The p-th percentile of `values` (nearest-rank), NEVER a mean — see this script's own header.
 *  `null` for an empty input (never a fabricated 0). */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const PASSING_VERDICT = "merged";
const BLOCKED_CI_VERDICT = "blocked_ci";

/** SETTLED, in the sense src/lib/cost-anomaly.ts defines it: `verdict !== "incomplete"`. An
 *  in-flight run's partial turns/cost anchor no distribution here. */
function isSettled(run) {
  return run.verdict !== "incomplete";
}

/**
 * Every run_id that is NOT the earliest (`startTs`, then `runId`) run of its own `taskId` — a
 * RE-DISPATCH. Computed over the WHOLE corpus, since a later attempt can resolve to a different
 * `task_class` than its first one did.
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
 * Group SETTLED runs by `task_class` (`"unknown"` for none) and compute per class: turn/cost
 * p50/p90/max, the outcome split, and cost PER COMPLETED TASK (never per run — see this file's header).
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

// W1-T2668: retro, triage and inbox_draft carry no `task_class`, so `computeClassSweep` above
// cannot see them. Rungs come from `SYNTHESIS_ROLES` (mounts.ts); rows price PER INVOCATION
// (`costPerInvocationUsd`), never per completed task, since a rung completes no task. FALSIFIER:
// test/the-headroom-sweep-cannot-see-the-synthesis-rungs.test.ts.
// Why: docs/forensics/mount-headroom-sweep.md#computesynthesissweep-the-three-rows-this-instrument-was-blind-to.

/**
 * One row per synthesis rung, from its own terminal ledger step, deduped by `run_id` — a rung that
 * ledgers its terminal line twice (a resumed retro, a rotation overlap) counts as ONE invocation.
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

/** `cost_usd`, falling back to `total_cost_usd` — the same precedence `gatherRuns`'s `costLine` uses. */
function costOf(r) {
  if (typeof r.cost_usd === "number") return r.cost_usd;
  if (typeof r.total_cost_usd === "number") return r.total_cost_usd;
  return 0;
}

// W1-T2574: CELLS (type x risk x class), and WITHIN each cell, ARMS (provider x served_model x effort).

/** The same three worker-call steps retro.ts's `DONE_STEPS` sums turns from, duplicated here since
 *  `RunSummary` carries no provider/served_model/effort field. */
const ARM_DONE_STEPS = new Set(["recon.done", "implement.done", "implement.resumed"]);
const IMPLEMENTATION_DONE_STEPS = new Set(["implement.done", "implement.resumed"]);
const WINDOW_REASON_CAP = 8;
const WINDOW_REASON_LENGTH_CAP = 96;
const ASSIGNMENT_EVENT_STEP = "worker.assignment";

function assignmentFieldsFromEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.version !== 1 || value.phase !== "pre-execution" || typeof value.id !== "string" || value.id === "") return undefined;
  const selected = value.selected;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return undefined;
  if ((selected.provider !== "claude" && selected.provider !== "codex") ||
    typeof selected.model !== "string" || selected.model === "" ||
    typeof selected.effort !== "string" || selected.effort === "") return undefined;
  return { provider: selected.provider, assignedModel: selected.model, assignedEffort: selected.effort };
}

function assignmentKeyOf(fields) {
  return `${fields.provider}::${fields.assignedModel}::${fields.assignedEffort}`;
}

export function assignmentFieldsByRunId(records) {
  const assignments = new Map();
  const doneRowsByRun = new Map();
  const integrity = {
    assignmentEvents: 0,
    validAssignmentEvents: 0,
    malformedAssignmentEvents: 0,
    duplicateAssignmentIds: 0,
    candidateRuns: 0,
    joinedRuns: 0,
    missingAssignmentIdRows: 0,
    missingAssignmentEventRows: 0,
    terminalProviderMismatches: 0,
    terminalRoutedModelMismatches: 0,
    mixedAssignedArms: 0,
    servedModelConfirmedRows: 0,
    servedModelUnreportedRows: 0,
  };

  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (r.step === ASSIGNMENT_EVENT_STEP) {
      integrity.assignmentEvents++;
      const fields = assignmentFieldsFromEvent(r.worker_assignment);
      const id = r.worker_assignment?.id;
      if (!fields || typeof id !== "string") {
        integrity.malformedAssignmentEvents++;
        continue;
      }
      if (assignments.has(id)) {
        integrity.duplicateAssignmentIds++;
        continue;
      }
      assignments.set(id, fields);
      integrity.validAssignmentEvents++;
      continue;
    }
    if (typeof r.run_id !== "string" || typeof r.step !== "string" || !ARM_DONE_STEPS.has(r.step)) continue;
    const rows = doneRowsByRun.get(r.run_id) ?? { implementation: [], recon: [] };
    (IMPLEMENTATION_DONE_STEPS.has(r.step) ? rows.implementation : rows.recon).push(r);
    doneRowsByRun.set(r.run_id, rows);
  }

  const fieldsByRunId = new Map();
  for (const [runId, grouped] of doneRowsByRun) {
    const rows = grouped.implementation.length > 0 ? grouped.implementation : grouped.recon;
    integrity.candidateRuns++;
    const fields = [];
    let rejected = false;
    for (const row of rows) {
      const id = row.selection_assignment_id;
      if (typeof id !== "string" || id === "") {
        integrity.missingAssignmentIdRows++;
        rejected = true;
        continue;
      }
      const assignment = assignments.get(id);
      if (!assignment) {
        integrity.missingAssignmentEventRows++;
        rejected = true;
        continue;
      }
      if (typeof row.provider === "string" && row.provider !== assignment.provider) {
        integrity.terminalProviderMismatches++;
        rejected = true;
        continue;
      }
      if (typeof row.routed_model === "string" && row.routed_model !== assignment.assignedModel) {
        integrity.terminalRoutedModelMismatches++;
        rejected = true;
        continue;
      }
      if (typeof row.served_model === "string") integrity.servedModelConfirmedRows++;
      else integrity.servedModelUnreportedRows++;
      fields.push(assignment);
    }
    if (rejected || fields.length === 0) continue;
    if (new Set(fields.map(assignmentKeyOf)).size !== 1) {
      integrity.mixedAssignedArms++;
      continue;
    }
    fieldsByRunId.set(runId, fields[0]);
    integrity.joinedRuns++;
  }
  return { fieldsByRunId, integrity };
}

/**
 * provider / served_model / effort per run_id, off the raw ledger records. `servedModel` reads
 * `"unreported"` for an explicit `served_model: null`, `"unknown"` only when absent; `provider`
 * reads `"unknown"` when absent. FIRST IMPLEMENTATION line wins over `recon.done`. Why:
 * docs/forensics/mount-headroom-sweep.md#armfieldsbyrunid-resume-precedence.
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
 * Reduce the per-call `window_consumption` sensor into one record per run, for implementation
 * calls only. A mixed resume or cross-provider window is unreadable, never silently charged to the
 * first row; a caller may use the subtotals only when `unreadableCalls == 0`.
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
 * Compare TWO ARMS and REFUSE — naming BOTH cells — when they do not share the SAME (type, risk,
 * class) cell (see this file's header). `cheaperByCostP50` (naive per-run) can disagree with
 * `cheaperByCostPerCompletedTask` once re-dispatch cost is charged —
 * `advantageHoldsUnderRedispatch: false` then names which arm's advantage disappeared. Why:
 * docs/forensics/mount-headroom-sweep.md#comparearms-outcome-before-cost-restated-for-a-pair.
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
 * Group runs into (type, risk, class) CELLS and, WITHIN each, (provider, served_model, effort)
 * ARMS; every cell with two or more arms gets every pairwise {@link compareArms} comparison.
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

export function computeAssignmentSweep(runs, assignmentFields, newestTs) {
  const compatibleFields = new Map(
    [...assignmentFields].map(([runId, fields]) => [runId, {
      provider: fields.provider,
      servedModel: fields.assignedModel,
      effort: fields.assignedEffort,
    }]),
  );
  return computeArmSweep(runs, compatibleFields, newestTs).map((cell) => ({
    ...cell,
    arms: cell.arms.map((arm) => {
      const { servedModel, windowShare, windowEvidence, ...assignmentArm } = arm;
      return { ...assignmentArm, assignedModel: servedModel };
    }),
  }));
}

/**
 * THE ONE ENTRY POINT: read the union corpus, dedup, reduce into per-run summaries, and build the
 * per-class sweep. Throws on ZERO distinct runs; spawns and writes nothing.
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
  const assignments = assignmentFieldsByRunId(records);

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
    assignments: {
      integrity: assignments.integrity,
      cells: computeAssignmentSweep(runs, assignments.fieldsByRunId, newestTs),
    },
  };
}

/**
 * W1-T2708 — THE LANE-RESTORE BASELINE: `dispatchLanes` (plan/policy.yaml) holds the fleet at 2
 * until burn per run measures down; this constant is that measurement, read off this script, and
 * plan/policy.yaml's own comment is pinned to it. Why:
 * docs/forensics/mount-headroom-sweep.md#lane_restore_baseline-the-2026-09-01-vs-09-02-figure.
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

/** The four fields a baseline MUST name before anything may be compared against it. */
export const REQUIRED_BASELINE_FIELDS = Object.freeze(["statistic", "taskClass", "costUsd", "command"]);

/** Percentile names this comparison accepts on EITHER side — a mean is refused by name (this
 *  file's header: never a mean). */
export const ACCEPTED_STATISTICS = Object.freeze(["p50", "p90"]);

/**
 * W1-T2708 — compare the current reading against {@link LANE_RESTORE_BASELINE} in the SAME
 * statistic; REFUSE rather than compare when that is not possible. Returns `null` when the corpus
 * has no row for the baseline's class — absent, not zero.
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
 *  carries printed BESIDE the per-class table, never on a separate page a reader could skip past. */
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

  // W1-T2668: the synthesis rungs get their OWN table — a different divisor (per invocation, not per completed task).
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

  // W1-T2708: the lane-restore condition, read off the tool, under the table it is drawn from.
  lines.push("");
  lines.push(renderLaneRestoreComparison(compareToLaneRestoreBaseline(report)));

  // W1-T2574: cells, each with its own arms — compared only WITHIN a cell (see compareArms's refusal).
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

  const assignmentReport = report.assignments;
  if (assignmentReport) {
    const integrity = assignmentReport.integrity;
    lines.push("");
    lines.push(
      "router assignments (pre-execution, read-only) — assigned_model is NOT provider-confirmed served_model; this report changes no routing policy",
    );
    lines.push(
      `coverage: events ${integrity.validAssignmentEvents}/${integrity.assignmentEvents} valid; ` +
        `joined runs ${integrity.joinedRuns}/${integrity.candidateRuns}; missing ids ${integrity.missingAssignmentIdRows}; ` +
        `missing events ${integrity.missingAssignmentEventRows}; malformed events ${integrity.malformedAssignmentEvents}; ` +
        `duplicate ids ${integrity.duplicateAssignmentIds}; mixed assigned arms ${integrity.mixedAssignedArms}; ` +
        `terminal provider mismatches ${integrity.terminalProviderMismatches}; routed-model mismatches ${integrity.terminalRoutedModelMismatches}; ` +
        `served-model receipts confirmed/unreported ${integrity.servedModelConfirmedRows}/${integrity.servedModelUnreportedRows}`,
    );
    for (const cell of assignmentReport.cells) {
      lines.push(`assignment cell ${cell.cellKey} (type=${cell.type}, risk=${cell.risk}, class=${cell.taskClass}):`);
      for (const arm of cell.arms) {
        lines.push(
          `  assigned arm ${arm.armKey} (provider=${arm.provider}, assigned_model=${arm.assignedModel}, effort=${arm.effort}) — ` +
            `n=${arm.n} (${arm.settledRuns}/${arm.totalRuns} settled/total) | cost p50/p90/max ($): ` +
            `${arm.costP50 ?? "-"}/${arm.costP90 ?? "-"}/${arm.costMax ?? "-"} | passing ${arm.outcomes.passing}, ` +
            `blocked_ci ${arm.outcomes.blockedCi}, re-dispatched ${arm.outcomes.redispatched} | ` +
            `$/completed task ${arm.costPerCompletedTaskUsd ?? "-"} | newest row seen: ${arm.newestTs ?? "(none)"}`,
        );
      }
      if (cell.arms.length < 2) {
        lines.push(`  only ${cell.arms.length} assigned arm(s) in this cell — no within-cell comparison is possible`);
      }
      for (const cmp of cell.comparisons) {
        lines.push(
          `  compare assigned ${cmp.armKeyA} (n=${cmp.nA}) vs ${cmp.armKeyB} (n=${cmp.nB}): ${cmp.note} ` +
            `(newest row seen: ${cmp.newestTs ?? "(none)"})`,
        );
      }
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
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
