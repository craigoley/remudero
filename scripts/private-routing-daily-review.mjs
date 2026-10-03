/** Private daily operational review. No paid model calls, GitHub reads or routing writes. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fixedClock, systemClock } from "../src/lib/clock.ts";
import { ledgerRotationEntries, openLedgerUnion } from "../src/lib/ledger-union.ts";
import { evaluateRoutingExperiment, ROUTING_EXPERIMENTS } from "../src/lib/routing-experiments.ts";

const DAY = 86_400_000;
const since = ROUTING_EXPERIMENTS.map((item) => item.startedOn).sort()[0];

async function readSource(source, asOf) {
  let names;
  try { names = readdirSync(source.stateDir); }
  catch { return { ...source, state: "unavailable", reasons: ["ledger-source-unreadable"], rowsRead: 0, rows: [] }; }
  const rotations = ledgerRotationEntries(names, source.stateDir);
  const forms = { gzip: rotations.filter((entry) => entry.form === "gzip").length,
    plain: rotations.filter((entry) => entry.form === "plain").length, live: names.includes("ledger.ndjson") ? 1 : 0 };
  if (rotations.length + forms.live === 0)
    return { ...source, state: "unavailable", reasons: ["ledger-source-missing"], forms, rowsRead: 0, rows: [] };
  const rows = [];
  const findings = [];
  let findingsOmitted = 0;
  const finding = (value) => { if (findings.length < 200) findings.push(value); else findingsOmitted++; };
  let rowsRead = 0, malformedRows = 0, unreadSources = 0, futureRows = 0, invalidTimestampRows = 0, newestTs = null;
  for await (const row of openLedgerUnion(source.stateDir, {
    since: `${since}T00:00:00Z`,
    onUnreadArchive: () => { unreadSources++; }, onUnreadLive: () => { unreadSources++; },
    onMalformedRow: (item) => { malformedRows++; finding({ kind: item.kind, form: item.form, path: item.path, rowOrdinal: item.rowOrdinal, timestamp: item.timestamp }); },
    onAcceptedRecord: (row, raw) => {
      const timestamp = Date.parse(row.ts);
      if (!Number.isFinite(timestamp) || timestamp > Date.parse(asOf) + 5 * 60_000) finding({
        kind: Number.isFinite(timestamp) ? "future-timestamp" : "invalid-timestamp", rowHash: createHash("sha256").update(raw).digest("hex"),
        timestamp: typeof row.ts === "string" ? row.ts.slice(0, 80) : null, step: typeof row.step === "string" ? row.step.slice(0, 80) : null,
      });
    },
  })) {
    const time = Date.parse(row.ts);
    if (!Number.isFinite(time)) { invalidTimestampRows++; continue; }
    if (time > Date.parse(asOf) + 5 * 60_000) { futureRows++; continue; }
    // Normal writes arriving during the scan belong to the next snapshot, not a clock warning.
    if (time > Date.parse(asOf)) continue;
    rowsRead++;
    if (newestTs === null || row.ts > newestTs) newestTs = row.ts;
    if (["worker.assignment", "verdict.merged", "fix.dispatch"].includes(row.step)
      || row.selection_assignment_id) rows.push(row);
  }
  const reasons = [];
  if (unreadSources) reasons.push("ledger-source-unreadable");
  if (malformedRows) reasons.push("ledger-source-malformed");
  if (invalidTimestampRows) reasons.push("ledger-source-invalid-timestamp");
  if (futureRows) reasons.push("ledger-source-future-dated");
  return { ...source, state: reasons.length ? "observed-partial" : "observed", reasons, forms,
    rowsRead, malformedRows, unreadSources, futureRows, invalidTimestampRows, newestTs, findings, findingsOmitted, rows };
}

function privateWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, path);
}

export async function dailyRoutingReview({ sources, outDir, asOf = systemClock.iso() }) {
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
  for (const source of sources) {
    const { rows, ...quality } = await readSource(source, asOf);
    const reports = ROUTING_EXPERIMENTS.map((experiment) => {
      const report = evaluateRoutingExperiment(rows, experiment, today);
      const prior = previous?.sources.find((item) => item.label === source.label)?.reports?.find((item) => item.id === report.id);
      return { ...report, minTasksPerArm: experiment.minTasksPerArm,
        reviewState: quality.state !== "observed" ? "source-incomplete" : report.sufficient ? "sample-minimum-met" : "provisional",
        nextAction: quality.state !== "observed" ? "repair-source-evidence" : report.sufficient ? "review-matched-cohorts" : "collect-more-tasks",
        changesSincePriorDay: prior ? { assignments: report.assignments - prior.assignments,
          tasks: report.arms.map((arm) => ({ arm: arm.arm, added: arm.tasks - (prior.arms.find((item) => item.arm === arm.arm)?.tasks ?? 0) })) } : null };
    });
    results.push({ ...quality, reports });
  }
  let sourceRevision = null;
  try { sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* A source archive has no Git revision; retain the unknown. */ }
  const snapshot = { version: "routing-daily-review-v1", asOf, cadence: "daily", nextScheduledReviewAt,
    sourceRevision, previousReview, state: results.every((source) => source.state === "observed") ? "observed" : "observed-partial",
    comparativeClaims: "none", routingChanged: false, sources: results };
  const lines = [`Daily routing review ${asOf}: ${snapshot.state}`, `Next scheduled review: ${nextScheduledReviewAt}`,
    "Operational observations; sample minimum alone does not establish a model winner."];
  for (const source of results) {
    lines.push(`${source.label}: ${source.state}; ${source.rowsRead} rows; ${source.reasons.join(", ") || "no source warnings"}`);
    for (const report of source.reports) {
      lines.push(`  ${report.id}: ${report.reviewState}; ${report.arms.map((arm) => `${arm.arm} ${arm.tasks}/${report.minTasksPerArm} tasks, ${arm.merged} merged, ${arm.nonStarterAssignments} no attempt, ${arm.costMissingAssignments} cost missing`).join("; ")}; ${report.crossoverTasks} crossovers; assignment growth since prior day: ${report.changesSincePriorDay?.assignments ?? "unavailable"}; next action: ${report.nextAction}`);
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
  const { values } = parseArgs({ options: { source: { type: "string", multiple: true }, "out-dir": { type: "string" } } });
  const sources = (values.source ?? []).map((value) => {
    const at = value.indexOf("=");
    const label = value.slice(0, at), stateDir = value.slice(at + 1);
    if (at < 1 || !/^[a-z][a-z0-9_-]{0,39}$/.test(label) || !isAbsolute(stateDir)) throw new Error("source must be label=/absolute/state/path");
    return { label, stateDir };
  });
  if (!values["out-dir"] || !isAbsolute(values["out-dir"]) || sources.length < 1 || sources.length > 3
    || new Set(sources.map((source) => source.label)).size !== sources.length)
    throw new Error("usage: private-routing-daily-review.mjs --source label=/state (1..3 unique) --out-dir /private/output");
  const result = await dailyRoutingReview({ sources, outDir: values["out-dir"] });
  console.log(result.text.trimEnd());
}
