import { observeCiRefreshDeferrals } from "../src/lib/ci-refresh-prevention.ts";
/** Private daily operational review. No paid model calls, GitHub reads or routing writes. */
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { observeReviewFlow, REVIEW_FLOW_STEPS } from "../src/lib/review-flow-observation.ts";
import { readCiLessonExposure } from "../src/lib/ci-lesson-recurrence.ts";
import { goalObservationFromRow } from "../src/lib/goals.ts";
import { fixedClock, systemClock } from "../src/lib/clock.ts";
import { ledgerRotationEntries, openLedgerUnion } from "../src/lib/ledger-union.ts";
import { createLedgerExactDedupe, LedgerExactDedupeLimitError } from "../src/lib/ledger-exact-dedupe.ts";
import { evaluateRoutingExperiment, ROUTING_EXPERIMENTS } from "../src/lib/routing-experiments.ts";
import { readRoutingQuarantineResolutions, resolveRoutingQuarantineRow } from "../src/lib/routing-quarantine-resolution.ts";

const DAY = 86_400_000;
const since = ROUTING_EXPERIMENTS.map((item) => item.startedOn).sort()[0];
const collectorSha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
function sourceRevisionAtRuntime() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (error) { return { unavailable: String(error.message) }; }
}
const loadedRevision = sourceRevisionAtRuntime();

function corpusIdentity(stateDir) {
  return readdirSync(stateDir).filter(name => name === "ledger.ndjson" || /^ledger\..*\.ndjson(?:\.gz)?$/.test(name)).sort()
    .map(name => { const st = statSync(join(stateDir, name)); return [name, st.ino, st.size, st.mtimeMs, st.ctimeMs]; });
}

function reportReads(row, time, windowStart) {
  const step = String(row.step);
  return ["worker.assignment", "verdict.merged", "fix.dispatch"].includes(step)
    || row.selection_assignment_id && (step === "worker.attempt" || step === "verdict" || step.endsWith(".done"))
    || time >= windowStart && (REVIEW_FLOW_STEPS.includes(step) || step === "ci_learning_cadence.ran"
      || step === "ci_learning_cadence.run_failed" || step === "sweep.update_branch.pending_guard"
      || step.endsWith(".gardener_judged") || step.endsWith(".gardener_failed") || step.startsWith("goal."));
}

async function readSource(source, asOf, resolutions, openUnion, retention) {
  let names;
  try { names = readdirSync(source.stateDir); }
  catch { return { ...source, state: "unavailable", reasons: ["ledger-source-unreadable"], rowsRead: 0, rows: [] }; }
  const rotations = ledgerRotationEntries(names, source.stateDir);
  const forms = { gzip: rotations.filter((entry) => entry.form === "gzip").length,
    plain: rotations.filter((entry) => entry.form === "plain").length, live: names.includes("ledger.ndjson") ? 1 : 0 };
  if (rotations.length + forms.live === 0)
    return { ...source, state: "unavailable", reasons: ["ledger-source-missing"], forms, rowsRead: 0, rows: [] };
  const rows = [];
  let corpusBefore;
  try { corpusBefore = JSON.stringify(corpusIdentity(source.stateDir)); }
  catch (error) { corpusBefore = { unreadable: String(error.message) }; }
  const resolvedRows = new WeakSet();
  let routingResolvedFutureRows = 0;
  const findings = [];
  let findingsOmitted = 0;
  const finding = (value) => { if (findings.length < 200) findings.push(value); else findingsOmitted++; };
  const windowStart = Date.parse(asOf) - DAY;
  let retainedRowsOmitted = 0, retainedBytes = 0, byteBound = false, rowBound = false, dedupe = null;
  const { maxRetainedBytes = 32 * 1024 * 1024, maxRetainedRows = 100_000, ...exactOptions } = retention;
  const exactDedupe = { ...exactOptions, createLedgerExactDedupe };
  const reportSeen = new Set();
  const reportSteps = new Set();
  let rowsRead = 0, malformedRows = 0, unreadSources = 0, futureRows = 0, invalidTimestampRows = 0, newestTs = null;
  const formsRead = { gzip: 0, plain: 0, live: 0 };
  const budgetReasons = [];
  try {
    for await (const row of openUnion(source.stateDir, {
      dedupe: false,
      exactDedupe,
      onExactDedupeStats: value => { dedupe = value; },
      onSourceRead: ({ form }) => { formsRead[form]++; },
      onUnreadDirectory: () => { unreadSources++; },
      onUnreadArchive: () => { unreadSources++; }, onUnreadLive: () => { unreadSources++; },
      onMalformedRow: (item) => { malformedRows++; finding({ kind: item.kind, form: item.form, path: item.path, rowOrdinal: item.rowOrdinal, timestamp: item.timestamp }); },
      onAcceptedRecord: (row, raw) => {
        const timestamp = Date.parse(row.ts);
        if (timestamp >= Date.parse(`${since}T00:00:00Z`) && reportReads(row, timestamp, windowStart) && timestamp <= Date.parse(asOf)) {
          const bytes = raw.length * 2;
          if (reportSeen.size < maxRetainedRows && retainedBytes + bytes <= maxRetainedBytes) {
            reportSeen.add(Buffer.from(raw, "utf16le").toString("utf16le"));
            retainedBytes += bytes;
            reportSteps.add(row.step);
          } else {
            retainedRowsOmitted++;
            if (reportSeen.size >= maxRetainedRows) rowBound = true;
            if (retainedBytes + bytes > maxRetainedBytes) byteBound = true;
          }
        }
        const resolution = resolveRoutingQuarantineRow(resolutions, source.label, row, raw, asOf);
        if (resolution) resolvedRows.add(row);
        if (!Number.isFinite(timestamp) || timestamp > Date.parse(asOf) + 5 * 60_000) finding({
          kind: Number.isFinite(timestamp) ? "future-timestamp" : "invalid-timestamp", rowHash: createHash("sha256").update(raw).digest("hex"),
          timestamp: typeof row.ts === "string" ? row.ts.slice(0, 80) : null, step: typeof row.step === "string" ? row.step.slice(0, 80) : null,
          ...(resolution ? { resolutionScope: resolution.scope, resolvedAt: resolution.resolvedAt } : {}),
        });
      },
    })) {
      const time = Date.parse(row.ts);
      if (!Number.isFinite(time)) { invalidTimestampRows++; continue; }
      if (time > Date.parse(asOf) + 5 * 60_000) { futureRows++; if (resolvedRows.has(row)) routingResolvedFutureRows++; continue; }
      // Normal writes arriving during the scan belong to the next snapshot, not a clock warning.
      if (time > Date.parse(asOf)) continue;
      rowsRead++;
      if (newestTs === null || time > Date.parse(newestTs)) newestTs = row.ts;
    }
  } catch (error) {
    if (!(error instanceof LedgerExactDedupeLimitError)) throw error;
    budgetReasons.push(error.reason);
  }
  const dedupeRows = reportSeen.size;
  let deliveredBytes = 0;
  if (reportSteps.size) {
    // Only audited report steps reach the union parser. Consume exact identities on delivery so
    // replays, concurrent appends and unrelated rows cannot enlarge the retained population.
    const admittedRows = new WeakSet();
    try {
    for await (const row of openUnion(source.stateDir, {
      since: `${since}T00:00:00Z`, step: [...reportSteps], exactDedupe,
      onUnreadDirectory: () => { unreadSources++; },
      onUnreadArchive: () => { unreadSources++; }, onUnreadLive: () => { unreadSources++; },
      onAcceptedRecord: (row, raw) => {
        if (reportSeen.delete(raw)) { admittedRows.add(row); deliveredBytes += raw.length * 2; }
      },
    })) {
      if (admittedRows.delete(row)) rows.push(row);
    }
    } catch (error) {
      if (!(error instanceof LedgerExactDedupeLimitError)) throw error;
      if (!budgetReasons.includes(error.reason)) budgetReasons.push(error.reason);
    }
  }
  const reasons = [...budgetReasons];
  let corpusAfter;
  try { corpusAfter = JSON.stringify(corpusIdentity(source.stateDir)); }
  catch (error) { corpusAfter = { unreadable: String(error.message) }; }
  if (reportSeen.size || typeof corpusBefore !== "string" || typeof corpusAfter !== "string" || corpusBefore !== corpusAfter) reasons.push("ledger-source-changed-during-review");
  if (rowBound) reasons.push("ledger-retention-row-bound");
  if (byteBound) reasons.push("ledger-retention-byte-bound");
  if (unreadSources) reasons.push("ledger-source-unreadable");
  if (malformedRows) reasons.push("ledger-source-malformed");
  if (invalidTimestampRows) reasons.push("ledger-source-invalid-timestamp");
  if (futureRows) reasons.push("ledger-source-future-dated");
  if (!rowsRead) reasons.push("ledger-positive-control-missing");
  const windowEvidencePresent = newestTs !== null && Date.parse(newestTs) >= windowStart;
  if (rowsRead && !windowEvidencePresent) reasons.push("ledger-window-evidence-missing");
  if (!unreadSources && !budgetReasons.length && Object.keys(forms).some(form => formsRead[form] !== forms[form])) reasons.push("ledger-corpus-form-coverage-incomplete");
  const completeness = { scope: "enumerated-rotated-plus-live-corpus", retention: "uncertified", positiveControl: rowsRead > 0,
    windowStart: new Date(windowStart).toISOString(), newestTs, windowEvidencePresent,
    complete: reasons.length === 0 };
  return { ...source, state: reasons.length ? "observed-partial" : "observed", reasons, forms,
    rowsRead, retainedRows: rows.length, retainedBytes: deliveredBytes, auditedRetainedBytes: retainedBytes,
    retainedRowsMissing: reportSeen.size, maxRetainedBytes, dedupe: dedupe && { rows: dedupe.rows, state: dedupe.state, reason: dedupe.reason },
    corpusControl: { formsExpected: forms, formsRead, index: dedupe },
    completeness, dedupeRows, retainedRowsOmitted, malformedRows, unreadSources, futureRows, routingResolvedFutureRows, invalidTimestampRows, newestTs, findings, findingsOmitted, rows };
}

function privateWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, path);
}

export async function dailyRoutingReview({ sources, outDir, asOf = systemClock.iso(), quarantineResolutions, openUnion = openLedgerUnion, retention = {} }) {
  for (const limit of [retention.maxRetainedBytes, retention.maxRetainedRows]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new TypeError("invalid ledger retention bound");
  }
  let latestOutput;
  try {
    const latest = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8"));
    const ageMs = Date.parse(asOf) - Date.parse(latest.asOf);
    if (!Number.isFinite(ageMs) || latest.version !== "routing-daily-review-v1") throw new Error("invalid latest output");
    latestOutput = { asOf: latest.asOf, ageMs, state: ageMs < 0 ? "future-dated" : ageMs > 36 * 3600000 ? "stale" : "fresh", sourceRevision: latest.sourceRevision ?? null };
  } catch (error) {
    latestOutput = { state: error.code === "ENOENT" ? "missing" : "unreadable", asOf: null, ageMs: null, reason: String(error.message) };
  }
  const resolutions = readRoutingQuarantineResolutions(quarantineResolutions, asOf, sources.map(source => source.label));
  const today = asOf.slice(0, 10);
  const yesterday = fixedClock(Date.parse(`${today}T00:00:00Z`) - DAY).iso().slice(0, 10);
  const scheduled = Date.parse(`${today}T04:17:00Z`);
  const nextScheduledReviewAt = fixedClock(scheduled > Date.parse(asOf) ? scheduled : scheduled + DAY).iso();
  let previous, previousReview;
  try {
    previous = JSON.parse(readFileSync(join(outDir, `${yesterday}.json`), "utf8"));
    if (previous.version !== "routing-daily-review-v1" || previous.asOf?.slice(0, 10) !== yesterday || !Array.isArray(previous.sources)
      || !previous.sources.every((source) => typeof source.label === "string" && Array.isArray(source.reports)
        && source.reports.every((report) => typeof report.id === "string" && Number.isSafeInteger(report.assignments)
          && report.assignments >= 0 && Array.isArray(report.arms) && report.arms.every((arm) => typeof arm.arm === "string"
            && Number.isSafeInteger(arm.tasks) && arm.tasks >= 0))))
      throw new Error("previous review schema invalid");
    previousReview = { state: "observed", asOf: previous.asOf };
  } catch (error) {
    previous = undefined;
    previousReview = { state: "unavailable", reason: error.code === "ENOENT" ? "no-prior-day-review" : "prior-day-review-unreadable" };
  }
  const results = [];
  const corpusControls = [];
  for (const source of sources) {
    const { rows, corpusControl, ...quality } = await readSource(source, asOf, resolutions, openUnion, retention);
    corpusControls.push({ label: source.label, ...(corpusControl ?? { formsExpected: quality.forms ?? null,
      formsRead: { gzip: 0, plain: 0, live: 0 }, index: null }) });
    const trialReasons = quality.reasons.filter(reason => reason !== "ledger-source-future-dated"
      || quality.futureRows !== quality.routingResolvedFutureRows);
    const trialSourceQuality = { scope: "routing-trials", rawSourceState: quality.state,
      state: quality.state === "unavailable" ? "unavailable" : trialReasons.length ? "observed-partial" : "observed",
      reasons: trialReasons, resolvedIrrelevantFutureRows: quality.routingResolvedFutureRows ?? 0 };
    const reports = ROUTING_EXPERIMENTS.map((experiment) => {
      const report = evaluateRoutingExperiment(rows, experiment, today);
      const prior = previous?.sources.find((item) => item.label === source.label)?.reports?.find((item) => item.id === report.id);
      return { ...report, minTasksPerArm: experiment.minTasksPerArm,
        sourceQuality: trialSourceQuality,
        reviewState: trialSourceQuality.state !== "observed" ? "source-incomplete" : report.sufficient ? "sample-minimum-met" : "provisional",
        nextAction: trialSourceQuality.state !== "observed" ? "repair-source-evidence" : report.sufficient ? "review-matched-cohorts" : "collect-more-tasks",
        changesSincePriorDay: prior ? { assignments: report.assignments - prior.assignments,
          tasks: report.arms.map((arm) => ({ arm: arm.arm, added: arm.tasks - (prior.arms.find((item) => item.arm === arm.arm)?.tasks ?? 0) })) } : null };
    });
    const windowStart = fixedClock(Date.parse(asOf) - DAY).iso();
    const reviewFlow = observeReviewFlow(rows, asOf, windowStart);
    const learningRows = rows.filter(row => Date.parse(row.ts) >= Date.parse(windowStart));
    const lastCiLearning = learningRows.filter(row => row.step === "ci_learning_cadence.ran")
      .sort((a, b) => a.ts.localeCompare(b.ts)).at(-1);
    const validCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const selfImprovement = { windowStart, sourceComplete: false, efficacyClaim: "none",
      ciRefreshDeferrals: observeCiRefreshDeferrals(learningRows, asOf, windowStart),
      ciLearning: lastCiLearning ? { at: lastCiLearning.ts, status: lastCiLearning.status ?? null,
        filed: validCount(lastCiLearning.filed), refused: validCount(lastCiLearning.refused),
        recurredLessons: validCount(lastCiLearning.lesson_recurrences?.recurrenceCount),
        lessonExposure: readCiLessonExposure(lastCiLearning.lesson_recurrences?.exposure, asOf, quality.state === "observed"),
        laterExposure: "not-certified-by-this-daily-window" } : null,
      ciLearningFailures: learningRows.filter(row => row.step === "ci_learning_cadence.run_failed").length,
      gardenerCredits: learningRows.filter(row => String(row.step).endsWith(".gardener_judged") && row.verdict === "credit").length,
      gardenerDebits: learningRows.filter(row => String(row.step).endsWith(".gardener_judged") && row.verdict === "debit").length,
      gardenerFailures: learningRows.filter(row => String(row.step).endsWith(".gardener_failed")).length,
      goals: learningRows.map(goalObservationFromRow).filter(Boolean).slice(-100).map(row => ({ id: row.goal_id,
        at: row.ts, outcome: row.step, baseline: row.baseline, measured: row.value, costComplete: row.costComplete })) };
    results.push({ ...quality, reports, reviewFlow, selfImprovement });
  }
  const installedRevision = sourceRevisionAtRuntime();
  const sourceRevision = typeof loadedRevision === "string" ? loadedRevision : null;
  const runtime = { sourceRevision, collectorSha256, nodeVersion: process.version, pid: process.pid,
    installedRevision: typeof installedRevision === "string" ? installedRevision : null,
    revisionError: typeof loadedRevision === "string" ? null : loadedRevision.unavailable,
    installedCollectorSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    sourceMerge: "not-observed", providerAdoption: "not-attested" };
  const snapshot = { version: "routing-daily-review-v1", asOf, cadence: "daily", nextScheduledReviewAt,
    sourceRevision, runtime, latestOutput, corpusControls, stages: { collection: { state: results.every(source => source.state === "observed") ? "ok" : "partial",
      sources: results.map(source => ({ label: source.label, state: source.state, reasons: source.reasons })) } },
    previousReview, state: results.every((source) => source.state === "observed") ? "observed" : "observed-partial",
    comparativeClaims: "none", routingChanged: false, sources: results };
  const lines = [`Daily routing review ${asOf}: ${snapshot.state}`, `Next scheduled review: ${nextScheduledReviewAt}`,
    `Collector revision: ${sourceRevision ?? "unavailable"}; runtime ${runtime.nodeVersion}; collection ${snapshot.stages.collection.state}; prior output ${latestOutput.state}, age ${latestOutput.ageMs ?? "unavailable"} ms`,
    "Operational observations; sample minimum alone does not establish a model winner."];
  for (const source of results) {
    lines.push(`${source.label}: ${source.state}; ${source.rowsRead} rows; ${source.reasons.join(", ") || "no source warnings"}`);
    lines.push(`  retained ${source.retainedRows ?? 0} rows, ${source.retainedBytes ?? 0} UTF-16 bytes; corpus control ${source.completeness?.positiveControl ?? false}; daily window evidence present ${source.completeness?.windowEvidencePresent ?? false}; retention uncertified`);
    lines.push(`  review flow (uncertified retention): ${source.reviewFlow.counts.delivered} delivered exact inputs; ${source.reviewFlow.counts.superseded} superseded; ${source.reviewFlow.counts.unresolvedSourceGap} source gaps; completed-only p95 ${source.reviewFlow.completedOnly.p95Ms ?? "unavailable"} ms; ${source.reviewFlow.semantic.notAttempted} semantic not attempted`);
    lines.push(`  self improvement: ${source.selfImprovement.gardenerFailures} observed gardener failures; ${source.selfImprovement.gardenerCredits} credits; ${source.selfImprovement.gardenerDebits} debits; ${source.selfImprovement.ciLearning?.recurredLessons ?? "unavailable"} recurring CI lessons; no efficacy claim`);
    for (const report of source.reports) {
      lines.push(`  ${report.id}: ${report.reviewState}; ${report.arms.map((arm) => `${arm.arm} ${arm.tasks}/${report.minTasksPerArm} tasks, ${arm.merged} merged, ${arm.nonStarterAssignments} no attempt, ${arm.costMissingAssignments} cost missing, served identity ${arm.receiptCoverage.servedModelKnownAssignments}/${arm.receiptCoverage.assignments}, worker outcome ${arm.receiptCoverage.outcomeKnownAssignments}/${arm.receiptCoverage.assignments}, cash mean ${arm.meanCashCostUsd ?? "unavailable"}, subscription notional mean ${arm.meanNotionalCostUsd ?? "unavailable"}`).join("; ")}; ${report.crossoverTasks} crossovers; assignment growth since prior day: ${report.changesSincePriorDay?.assignments ?? "unavailable"}; next action: ${report.nextAction}`);
    }
  }
  const text = lines.join("\n") + "\n";
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const json = JSON.stringify(snapshot, null, 2) + "\n";
  privateWrite(join(outDir, `${today}.json`), json);
  privateWrite(join(outDir, `${today}.txt`), text);
  privateWrite(join(outDir, "latest.json"), json);
  privateWrite(join(outDir, "latest.txt"), text);
  const quarantine = JSON.stringify({ version: "routing-source-quarantine-v1", asOf, rawReceiptsRetained: true,
    sources: results.map(source => ({ label: source.label, findings: source.findings ?? [], omitted: source.findingsOmitted ?? 0 })) }, null, 2) + "\n";
  privateWrite(join(outDir, `${today}.quarantine.json`), quarantine);
  return { snapshot, text };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: "string", multiple: true }, "out-dir": { type: "string" },
    "quarantine-resolutions": { type: "string" } } });
  const sources = (values.source ?? []).map((value) => {
    const at = value.indexOf("=");
    const label = value.slice(0, at), stateDir = value.slice(at + 1);
    if (at < 1 || !/^[a-z][a-z0-9_-]{0,39}$/.test(label) || !isAbsolute(stateDir)) throw new Error("source must be label=/absolute/state/path");
    return { label, stateDir };
  });
  if (!values["out-dir"] || !isAbsolute(values["out-dir"]) || sources.length < 1 || sources.length > 3
    || new Set(sources.map((source) => source.label)).size !== sources.length)
    throw new Error("usage: private-routing-daily-review.mjs --source label=/state (1..3 unique) --out-dir /private/output");
  const resolutionPath = values["quarantine-resolutions"] ?? join(values["out-dir"], "quarantine-resolutions.json");
  if (!isAbsolute(resolutionPath)) throw new Error("quarantine resolutions require an absolute private path");
  let quarantineResolutions;
  let resolutionFd;
  try {
    // Validate and read the same opened object; replacing the pathname cannot redirect the read.
    resolutionFd = openSync(resolutionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(resolutionFd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.size > 64 * 1024)
      throw new Error("quarantine resolutions require a bounded regular private file");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0, count;
    do {
      count = readSync(resolutionFd, bytes, length, bytes.length - length, null);
      length += count;
    } while (count > 0 && length < bytes.length);
    if (length > 64 * 1024) throw new Error("quarantine resolutions exceed the private input byte bound");
    quarantineResolutions = JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } catch (error) {
    if (values["quarantine-resolutions"] || error.code !== "ENOENT") throw error;
    // An absent optional manifest preserves the original unqualified source warnings.
  } finally {
    if (resolutionFd !== undefined) closeSync(resolutionFd);
  }
  const result = await dailyRoutingReview({ sources, outDir: values["out-dir"], quarantineResolutions });
  console.log(result.text.trimEnd());
}
