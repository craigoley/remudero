#!/usr/bin/env node
// scripts/mount-headroom-sweep.mjs
//
// MOUNT HEADROOM SWEEP (W1-T2560).
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
import { gatherRuns } from "../src/lib/retro.ts";
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
  };
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
