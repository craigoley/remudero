#!/usr/bin/env node
// scripts/clock-sweep-deliver.mjs (W1-T5033) -- one needs-human issue per NEW drifting suite.
//
// The aggregate delivery keys ONE thread per source, so a suite that starts drifting is a comment
// on an old issue: nobody is paged about a new suite because nothing new opens. This reads the
// sweep's report, finds the NEW DRIFT section and delivers each suite as its own issue, keyed
// `clock-sweep:<suite>` and looked up WITHOUT the label filter, so a thread a human relabelled is
// commented on and never duplicated weekly. Per-suite issues are closed by the fixing PR.
//
// Usage: node scripts/clock-sweep-deliver.mjs --report sweep-report.txt   (env: RUN_URL, RUN_WHEN)
// Exit 0 when nothing is new or every delivery succeeded; 1 when any delivery or the read failed.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { buildBody, deliver, markerFor } from "./needs-human-issue.mjs";

const SUITE_LINE_RE = /^ {2}test\/([A-Za-z0-9._-]+)\.test\.ts\s*$/;

/** Pure. The NEW DRIFT suites of a sweep report: `{suite, fuse, detail}`, fuse and detail null/empty when the block is absent. */
export function parseNewDrift(reportText) {
  const lines = String(reportText ?? "").split("\n");
  const header = lines.findIndex((l) => /^NEW DRIFT\b[^\d\n]*\d+ suite\(s\)/.test(l));
  if (header === -1) return [];
  const names = [];
  for (let i = header + 1; i < lines.length; i++) {
    const m = SUITE_LINE_RE.exec(lines[i]);
    if (!m) break;
    names.push(m[1]);
  }
  return names.map((suite) => {
    const at = lines.findIndex((l, i) => SUITE_LINE_RE.exec(l)?.[1] === suite && /^ {4}fails by/.test(lines[i + 1] ?? ""));
    if (at === -1) return { suite, fuse: null, detail: "" };
    const block = [];
    for (let i = at; i < lines.length && (i === at || lines[i].startsWith("    ")); i++) block.push(lines[i]);
    const fuse = /\+(\d+) days/.exec(block[1]);
    return { suite, fuse: fuse ? Number(fuse[1]) : null, detail: block.join("\n") };
  });
}

/** Pure. The delivery for one suite, built with needs-human-issue's own envelope. */
export function issueFor(entry, { runUrl, when } = {}) {
  const source = `clock-sweep:${entry.suite}`;
  const title =
    entry.fuse === 0
      ? `clock-sweep: ${entry.suite} fails with NO clock shift (a runner or environment defect, NOT clock drift)`
      : `clock-sweep: ${entry.suite} drifts on the wall clock${entry.fuse === null ? "" : ` (fails by +${entry.fuse} days)`}`;
  const preamble = [
    `Repair it one of two ways: derive the fixture at run time, or record the suite in driftingSuitesAtCapture in scripts/clock-sweep-baseline.json with a reason.`,
    `This issue is CLOSED BY THE FIXING PR; nothing closes it when a later sweep stops naming the suite.`,
  ].join("\n");
  return { source, title, body: buildBody({ source, marker: markerFor(source), runUrl, log: entry.detail, when, preamble }) };
}

/** Delivers every NEW drifting suite, continuing past a failed one so it cannot hide the rest. Returns the exit code. */
export function deliverNewDrift({ reportText, deliverFn = deliver, env = process.env, log = console.log, error = console.error }) {
  let code = 0;
  for (const entry of parseNewDrift(reportText)) {
    const issue = issueFor(entry, { runUrl: env.RUN_URL, when: env.RUN_WHEN });
    try {
      const result = deliverFn({ ...issue, anyLabel: true });
      log(`clock-sweep-deliver: ${entry.suite} -> ${result.action === "comment" ? `commented on #${result.number}` : `opened ${result.url}`}`);
    } catch (err) {
      error(`clock-sweep-deliver: DELIVERY FAILED for ${entry.suite} -- ${err.message}`);
      code = 1;
    }
  }
  return code;
}

export function main({
  argv = process.argv.slice(2),
  env = process.env,
  readFile = (p) => readFileSync(p, "utf8"),
  deliverFn = deliver,
  log = console.log,
  error = console.error,
} = {}) {
  const { values } = parseArgs({ args: argv, options: { report: { type: "string" } } });
  if (!values.report) {
    error("clock-sweep-deliver: --report is required");
    return 1;
  }
  let reportText;
  try {
    reportText = readFile(values.report);
  } catch (err) {
    error(`clock-sweep-deliver: cannot read the report ${values.report} -- ${err.message}`);
    return 1;
  }
  return deliverNewDrift({ reportText, deliverFn, env, log, error });
}

if (isMainModule(import.meta.url)) process.exitCode = main();
