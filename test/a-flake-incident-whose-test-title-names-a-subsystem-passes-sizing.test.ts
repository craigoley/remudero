// 2026-10-10 18:08:21Z on the fleet host: `flake_incident.filing_failed` with "flake-incident: task failed lint: sizing" for
// test/new-work-is-ordered-by-cost-of-delay.test.ts / "W1-T4064: the daemon reads filing dates from the plan path it was
// given". The filer put the failing test's TITLE in its first acceptance claim, and Rule 19 sizing reads claim text against
// its subsystem lexicon, so the word "daemon" counted as a second concern at `risk: low` and the record was refused. The
// claim now names the incident by its task id and file; the title stays in the rationale, which sizing does not read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { machineShardFilingRefusal } from "../src/lib/machine-filing.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations, parseTasksFromYaml } from "../src/lib/plan.js";
import { lintTask, sizingViolation } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TEST_FILE = "test/new-work-is-ordered-by-cost-of-delay.test.ts";
const TITLE = "W1-T4064: the daemon reads filing dates from the plan path it was given";
const NOW = Date.parse("2026-10-10T18:08:00Z");
const ID = "W1-T9887";

test("the real flake-incident filing for a test whose title names the daemon passes sizing, lintTask and machine-filing admission", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-sizing-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state", "plan/tasks.d", "test"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const rows = [10690, 10695, 10701].map((pr) => ({
    ts: new Date(NOW).toISOString(), step: "test.flake_retry", file: TEST_FILE, headline: "recovered on retry", ci_run_id: pr * 10,
    shard: 3, source: "selector-shadow", retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`,
    pr_numbers: [pr], titles: [TITLE],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const landed: Array<{ paths: string[] }> = [];
  await runFlakeIncidentGardener(
    {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log: (step, extra) => log.push({ step, extra }),
      openWorkspace: () => ({ root, branch: "selector-shadow-garden-3", land: (o: { paths: string[] }) => (landed.push(o), "https://github.com/acme/remudero/pull/3"), dispose: () => {} }),
    },
    { mintTaskId: () => ID, readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "" },
  );

  assert.deepEqual(log.filter((r) => r.step === "flake_incident.filing_failed"), [], "the filing is not refused");
  assert.equal(landed.length, 1, "the gardener files the incident");
  const rel = landed[0]!.paths[0]!;
  const text = readFileSync(join(root, rel), "utf8");
  const filed = parseTasksFromYaml(text, rel)[0]!;

  assert.equal(filed.risk, "low");
  assert.equal(sizingViolation(filed), undefined, "Rule 19 sees one concern: the flaky test file");
  assert.deepEqual(lintTask(filed).violations.filter((v) => v.severity === "block"), []);
  const exists = (p: string) => p === TEST_FILE;
  assert.deepEqual(machineFilingAdmissionViolations(filed, { plan: loadPlanFromYaml(text, rel), releasedIds: new Set(), pathExists: exists }), []);
  assert.equal(machineShardFilingRefusal(text, rel, { pathExists: exists }), undefined, "#10474's shared guard admits the landed text");

  // The title is still on the record, where a worker reads it, just not in the criteria sizing reads.
  assert.ok((filed.rationale ?? "").includes(TITLE), "the rationale quotes the failing test's title");
  assert.ok((filed.acceptance ?? []).every((c) => !c.claim.includes(TITLE)), "no claim carries the title");
  assert.ok((filed.acceptance ?? [])[0]!.claim.includes(ID), "the first claim names the incident by its id");
});
