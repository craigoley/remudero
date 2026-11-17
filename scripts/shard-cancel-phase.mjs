#!/usr/bin/env node
// scripts/shard-cancel-phase.mjs — name the step a cancelled shard was killed in.
//
// WHY: ci.yml's coverage gate sees only the matrix result `cancelled`. With the PR head unchanged it
// said "SHARD HANG ... THE COVERAGE TESTS DID NOT RUN". Measured 2026-11-16: on #18947, coverage-shard
// (4/8) spent 20m45s in `actions/checkout`, then passed its tests, then hit the 49m ceiling in "Upload
// coverage shard". On #18949, coverage-shard (3/8) spent 20m36s in checkout. The tests ran in both,
// so the old text was wrong. The jobs API already records each step's conclusion and times. This
// script reads them and says which phase the ceiling hit: setup, tests, or after the tests passed.
//
// Input: the run attempt's jobs as JSON, from
//   gh api "repos/<o>/<r>/actions/runs/<id>/attempts/<n>/jobs?per_page=100" --paginate --jq '.jobs[]'
// (one job object per line), or one `{ "jobs": [...] }` document.
// Output: lines for the gate's log, and one machine line per cancelled job:
//   SHARD-CANCEL-PHASE: <job name>: setup|tests|after-tests|unknown
// It never fails the gate. An unreadable input prints one `unreadable` line and exits 0.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

/** A step that ran at least this long, other than the test step, is named as slow. */
export const SLOW_STEP_SECONDS = 300;

/** Parse NDJSON job objects or one `{ jobs: [...] }` document. Returns undefined when unreadable. */
export function parseJobs(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return undefined;
  try {
    const doc = JSON.parse(trimmed);
    if (Array.isArray(doc?.jobs)) return doc.jobs;
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === "object" && Array.isArray(doc.steps)) return [doc];
  } catch {
    // Not one document: read it as one job object per line.
  }
  const jobs = [];
  for (const line of trimmed.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const job = JSON.parse(line);
      if (!job || typeof job !== "object" || typeof job.name !== "string") return undefined;
      jobs.push(job);
    } catch {
      return undefined;
    }
  }
  return jobs.length > 0 ? jobs : undefined;
}

function seconds(step) {
  const a = Date.parse(step?.started_at ?? "");
  const b = Date.parse(step?.completed_at ?? "");
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : undefined;
}

export function formatDuration(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Classify one cancelled job by its steps. `testStepPrefix` names the step that runs the tests. */
export function classifyCancelledJob(job, testStepPrefix) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const testIndex = steps.findIndex((s) => typeof s?.name === "string" && s.name.startsWith(testStepPrefix));
  const killedIndex = steps.findIndex((s) => s?.conclusion === "cancelled");
  const slow = steps
    .filter((s, i) => i !== testIndex && (seconds(s) ?? 0) >= SLOW_STEP_SECONDS)
    .map((s) => ({ name: s.name, seconds: seconds(s) }));
  const testStep = testIndex === -1 ? undefined : steps[testIndex];
  const killed = killedIndex === -1 ? undefined : steps[killedIndex];
  let phase = "unknown";
  if (testStep?.conclusion === "success") phase = "after-tests";
  else if (killed && testIndex !== -1 && killedIndex < testIndex) phase = "setup";
  else if (killed && killedIndex === testIndex) phase = "tests";
  return {
    name: job?.name ?? "(unnamed job)",
    phase,
    killedStep: killed?.name,
    testSeconds: seconds(testStep),
    slow,
  };
}

/** The gate's lines for every cancelled job whose name starts with `jobPrefix`. */
export function describeCancelledShards(jobs, jobPrefix, testStepPrefix) {
  const cancelled = jobs.filter((j) => typeof j?.name === "string" && j.name.startsWith(jobPrefix) && j.conclusion === "cancelled");
  const lines = [];
  for (const job of cancelled) {
    const c = classifyCancelledJob(job, testStepPrefix);
    const slow = c.slow.map((s) => `'${s.name}' took ${formatDuration(s.seconds)}`).join("; ");
    const slowNote = slow ? ` Slow steps: ${slow}.` : "";
    if (c.phase === "after-tests") {
      lines.push(`  ${c.name}: the tests PASSED ('${testStepPrefix}' succeeded after ${formatDuration(c.testSeconds ?? 0)}); ` +
        `the ceiling was reached later, in '${c.killedStep ?? "a later step"}'. This is not a hang and not a test failure.${slowNote}`);
    } else if (c.phase === "setup") {
      lines.push(`  ${c.name}: killed in '${c.killedStep}', before '${testStepPrefix}' started, so its tests never ran. ` +
        `A setup or runner stall is not caused by this diff; a re-run of the shard is expected to pass.${slowNote}`);
    } else if (c.phase === "tests") {
      lines.push(`  ${c.name}: killed in '${testStepPrefix}' after ${formatDuration(c.testSeconds ?? 0)}. A test hung, or the ` +
        `shard ran past its budget; the last unfinished test below names the candidate.${slowNote}`);
    } else {
      lines.push(`  ${c.name}: the step it was killed in could not be read from its steps.${slowNote}`);
    }
    lines.push(`SHARD-CANCEL-PHASE: ${c.name}: ${c.phase}`);
  }
  return lines;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      jobs: { type: "string" },
      "job-prefix": { type: "string" },
      "test-step": { type: "string" },
    },
  });
  if (!values.jobs || !values["job-prefix"] || !values["test-step"]) {
    console.error("usage: shard-cancel-phase.mjs --jobs <file> --job-prefix <name prefix> --test-step <step name prefix>");
    return 2;
  }
  let text;
  try {
    text = readFileSync(values.jobs, "utf8");
  } catch {
    text = undefined;
  }
  const jobs = parseJobs(text);
  if (!jobs) {
    console.log("  The run's job steps were unreadable, so the step each shard was killed in is unknown.");
    console.log("SHARD-CANCEL-PHASE: unreadable");
    return 0;
  }
  const lines = describeCancelledShards(jobs, values["job-prefix"], values["test-step"]);
  if (lines.length === 0) {
    console.log(`  No job named '${values["job-prefix"]}...' is recorded as cancelled in this run attempt.`);
    console.log("SHARD-CANCEL-PHASE: none");
    return 0;
  }
  for (const line of lines) console.log(line);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
