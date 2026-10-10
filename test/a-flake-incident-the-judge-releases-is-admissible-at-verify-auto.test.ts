// 2026-10-10: #10685 made the machine-filing judge escalate a `proceed` that lint-plan would refuse. The flake-incident
// gardener filed every incident with its one test file as the only declared path and one `unit test:` proof as the only
// criterion. At verify: auto that is proof-test-only-discrimination, a WARN that lint-plan --base promotes to BLOCK on
// the judge's plan-only landing (W1-T3814), so after #10685 every flake incident the judge would release went to a
// person instead. The filer now adds a `grep:` criterion on the pinning test's own `test(` line, which misses at base.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { machineShardFilingRefusal } from "../src/lib/machine-filing.js";
import { renderRuledShard } from "../src/lib/machine-filing-judge.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations, parseTasksFromYaml } from "../src/lib/plan.js";
import type { FilingRiskRuling } from "../src/lib/risk-judge.js";
import { lintTask, promoteIntroducedPlanOnlyDiagnostics, taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TEST_FILE = "test/the-roster-is-named-not-numbered.test.ts";
const TITLE = "runPreflightFast over ONLY the roster's admitted projection passes on a clean HEAD";
const NOW = Date.parse("2026-10-10T18:00:00Z");
const ID = "W1-T9886";

/** The shard the real gardener lands for a three-PR flake on TEST_FILE. */
async function filedShard(t: { after: (fn: () => void) => void }): Promise<{ root: string; rel: string; text: string }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-auto-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const rows = [10311, 10319, 10327].map((pr) => ({
    ts: new Date(NOW).toISOString(), step: "test.flake_retry", file: TEST_FILE, headline: "recovered on retry", ci_run_id: pr * 10,
    shard: 2, source: "selector-shadow", retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`,
    pr_numbers: [pr], titles: [TITLE],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const landed: Array<{ paths: string[] }> = [];
  await runFlakeIncidentGardener(
    {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log: () => {},
      openWorkspace: () => ({ root, branch: "selector-shadow-garden-2", land: (o: { paths: string[] }) => (landed.push(o), "https://github.com/acme/remudero/pull/2"), dispose: () => {} }),
    },
    { mintTaskId: () => ID, readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "" },
  );
  assert.equal(landed.length, 1, "the gardener files the incident");
  const rel = landed[0]!.paths[0]!;
  return { root, rel, text: readFileSync(join(root, rel), "utf8") };
}

const proceed: FilingRiskRuling = { verdict: "low", action: "proceed", confidence: 0.95, reasons: ["a test-only repair of a measured flake"], judgedAt: new Date(NOW).toISOString() };

test("a filed flake incident the judge releases passes lintTask, machine-filing admission and lint-plan's plan-only promotion at verify auto", async (t) => {
  const { root, rel, text } = await filedShard(t);
  const filed = parseTasksFromYaml(text, rel)[0]!;
  assert.equal(filed.verify, "human", "it is filed parked, for the judge");

  // The judge's own rewrite of the real record: verify: auto, the ruling pinned.
  const ruled = renderRuledShard(text, rel, taskRulingPin({ ...filed, verify: "auto" }), proceed, new Set(), { plan: loadPlanFromYaml(text, rel), pathExists: () => true });
  assert.ok("contents" in ruled, `the judge releases it rather than escalating: ${"refused" in ruled ? ruled.refused : ""}`);
  const released = parseTasksFromYaml(ruled.contents, rel)[0]!;
  assert.equal(released.verify, "auto");

  // lintTask at verify: auto, and what lint-plan --base blocks on the judge's plan-only landing.
  const lint = lintTask(released).violations;
  assert.deepEqual(lint.filter((v) => v.check === "proof-test-only-discrimination"), [], "the released record discriminates");
  const promoted = promoteIntroducedPlanOnlyDiagnostics(lint, lintTask(filed).violations, false).filter((v) => v.severity === "block");
  assert.deepEqual(promoted.map((v) => v.check), [], "lint-plan --base blocks nothing the release introduces");

  // lint-plan's machine-filing admission on the released record, and #10474's shared guard on the landed text.
  const exists = (p: string) => p === TEST_FILE;
  assert.deepEqual(machineFilingAdmissionViolations(released, { plan: loadPlanFromYaml(ruled.contents, rel), releasedIds: new Set(), pathExists: exists }), []);
  assert.equal(machineShardFilingRefusal(ruled.contents, rel, { pathExists: exists }), undefined);
  assert.equal(machineShardFilingRefusal(text, rel, { pathExists: exists }), undefined, "and the filed text is admitted as filed");

  // The discriminating line is the pinning test's own `test(` line in the flaky file, never a comment-only id.
  const greps = (released.acceptance ?? []).map((c) => c.proof ?? "").filter((p) => p.startsWith("grep:"));
  assert.deepEqual(greps, [`grep: test("${ID} pins the cause of the intermittent failure" in ${TEST_FILE}`]);
  assert.ok(existsSync(join(root, TEST_FILE)) && !readFileSync(join(root, TEST_FILE), "utf8").includes(ID), "the grep misses on the tree it was filed against");
});
