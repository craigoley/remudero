// 2026-09-24: the measurement cadence blocked the core daemon's event loop for 862 s — one
// synchronous `git log -S` per adoption finding, 2,377 findings. These pin the async report:
// the loop turns while ship dates resolve, and the report it builds is the sync one exactly.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  runMeasurementCadenceReport,
  runMeasurementCadenceReportAsync,
  type AdoptionFinding,
  type MeasurementCadenceReportOpts,
  type MeasurementCadenceRunResult,
} from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const FILES: Record<string, string> = {
  "src/lib/lonely.ts": "export function lonelyHelper(): number {\n  return 1;\n}\nexport const LONELY_LIMIT = 3;\n",
  "scripts/orphan.mjs": "console.log('nobody runs me');\n",
};

function writeFiles(root: string): void {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
}

function findingsOf(result: MeasurementCadenceRunResult): AdoptionFinding[] {
  assert.ok(result.adoptionReport, "the cadence must attach an adoption report");
  return result.adoptionReport.findings;
}

function reportOpts(root: string): MeasurementCadenceReportOpts {
  return {
    stateDir: join(root, "state"),
    cwd: root,
    checkoutDir: root,
    escalate: false,
    gitLog: () => ({ dump: "", ref: "fixture" }),
  };
}

test("the measurement cadence lets a timer fire while its ship-date lookups are pending", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cadence-offloop-`));
  writeFiles(root);
  const order: string[] = [];
  let lookups = 0;
  setImmediate(() => order.push("timer"));
  const result = await runMeasurementCadenceReportAsync({
    ...reportOpts(root),
    shipDateForAsync: async () => {
      lookups += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return "2026-01-02T00:00:00Z";
    },
  }).then((r) => {
    order.push("report");
    return r;
  });
  assert.deepEqual(order, ["timer", "report"], "a timer scheduled before the run must fire before it resolves");
  const findings = findingsOf(result).filter((f) => f.shape !== "gate-no-subject");
  assert.ok(findings.length >= 3, `expected the fixture's three unadopted mechanisms, saw ${findings.length}`);
  assert.equal(lookups, findings.length, "one async lookup per finding, none left to the sync resolver");
  for (const f of findings) assert.equal(f.shippedAt, "2026-01-02T00:00:00Z", `${f.mechanism} kept the async date`);
});

test("the off-loop ship-date lookup reports exactly the dates the in-loop one does", async () => {
  const repo = gitRepo({ kind: "cadence-offloop" });
  writeFiles(repo.dir);
  repo.git("add", "src", "scripts");
  repo.git("commit", "--quiet", "-m", "ship the lonely mechanisms", "--date", "2026-03-04T05:06:07+00:00");
  const inLoop = findingsOf(runMeasurementCadenceReport(reportOpts(repo.dir)));
  const offLoop = findingsOf(await runMeasurementCadenceReportAsync(reportOpts(repo.dir)));
  assert.deepEqual(offLoop, inLoop);
  const dated = offLoop.filter((f) => Date.parse(f.shippedAt) === Date.parse("2026-03-04T05:06:07Z"));
  assert.ok(dated.length >= 3, `expected every fixture finding dated from git, saw ${dated.length}`);
});

test("the off-loop ship-date lookup reads unknown where git history is unreadable", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cadence-offloop-nogit-`));
  writeFiles(root);
  const findings = findingsOf(await runMeasurementCadenceReportAsync(reportOpts(root))).filter(
    (f) => f.shape !== "gate-no-subject",
  );
  assert.ok(findings.length >= 3, `expected the fixture's three unadopted mechanisms, saw ${findings.length}`);
  for (const f of findings) assert.equal(f.shippedAt, "unknown", `${f.mechanism} has no readable history`);
});
