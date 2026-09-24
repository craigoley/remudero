#!/usr/bin/env node
// scripts/select-affected-suites.mjs — W1-T4404: the affected-suite selector, in SHADOW.
//
// CI runs this beside the unchanged full test run: it prints what the selector WOULD have run and,
// for every file that really failed, whether each selection had it. It never changes what runs and
// never changes a job's verdict — it exits 0 whatever it finds, except on a usage error (2).
//
// Usage: node --import tsx scripts/select-affected-suites.mjs --changed-files <path>
//          [--diff <path>]          (a `git diff -U0` of the change: enables the symbol-level `narrow` selection)
//          [--failed-from <log>]    (the full run's test output: failures are read from its TAP `location:` fields)
//          [--recent-failures <path>] (one suite per line)
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgv, isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { parseFailingTestFiles } from "./test-with-retry.mjs";
import {
  changedSymbols,
  affectedSelectionOrFull,
  readAffectedSuitesInput,
  shadowRecord,
} from "../src/lib/affected-suites.ts";
import { callerReachableSuites } from "../src/lib/ci-parity.ts";
import { defaultPreflightSpawn } from "../src/lib/commit-message.ts";

const lines = (path) => readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);

export function main(argv, { root = REPO_ROOT, summaryPath = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const { values } = parseArgv(argv, {
    "changed-files": { type: "string" },
    diff: { type: "string" },
    "failed-from": { type: "string" },
    "recent-failures": { type: "string" },
  });
  if (!values["changed-files"]) {
    console.error("usage: select-affected-suites.mjs --changed-files <path> [--diff <path>] [--failed-from <log>] [--recent-failures <path>]");
    return 2;
  }
  const changed = lines(values["changed-files"]);
  const selection = affectedSelectionOrFull(changed, () => {
    const extra = {};
    if (values["recent-failures"]) extra.recentFailures = lines(values["recent-failures"]);
    if (values.diff) {
      const symbols = changedSymbols(readFileSync(values.diff, "utf8"), (p) => readFileSync(join(root, p), "utf8"));
      extra.symbolSuites = callerReachableSuites(symbols, root, defaultPreflightSpawn).suites;
    }
    return readAffectedSuitesInput(root, changed, extra);
  });
  const failed = values["failed-from"] ? parseFailingTestFiles(readFileSync(values["failed-from"], "utf8"), root) : [];
  const record = shadowRecord(selection, failed);

  const size = selection.fullRun ? "FULL" : `${record.floorSize} floor${record.narrowSize === undefined ? "" : `, ${record.narrowSize} narrow`}`;
  const missed = record.failures.filter((f) => f.floor === "missed" || f.narrow === "missed");
  const summary =
    `- W1-T4404 affected-suite selector (SHADOW — nothing skipped): would run ${size} of the suite for ${changed.length} changed file(s); ` +
    `${record.failures.length} real failure(s)` +
    (record.failures.length === 0 ? "" : `: ${record.failures.map((f) => `${f.file} floor=${f.floor}${f.narrow ? ` narrow=${f.narrow}` : ""}`).join("; ")}`);
  console.log(summary);
  if (selection.fullRun) console.log(`  ${selection.reasons[0]}`);
  if (missed.length > 0) console.log(`  MISSED: ${missed.map((f) => f.file).join(", ")} — the selection would not have run a file that really failed`);
  console.log(`AFFECTED-SUITES-SHADOW: ${JSON.stringify(record)}`);
  if (summaryPath) appendFileSync(summaryPath, summary + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
