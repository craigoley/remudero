import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { partitionByFileOverlap } from "../src/lib/dispatch-overlap.js";
import { flakeIncidentOrigin, runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { gateGardenSpec, loadGateProbes } from "../src/lib/gate-gardener.js";
import { mintProofDebtProposals } from "../src/lib/measurement-cadence.js";
import type { Task } from "../src/lib/plan.js";
import { proofQueueAudit } from "../src/lib/proof-queue-audit.js";
import { runSelectorShadowGardener, selectorShadowCauseOrigin, SELECTOR_SHADOW_SHARDS } from "../src/lib/selector-shadow-gardener.js";
import { mineSyntheticTasks } from "../src/lib/synthetic-tasks.js";
import * as resolver from "../src/lib/test-path-resolver.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const OLD = "test/relocated-reader.test.ts";
const MOVED = "test/readers/relocated-reader.test.ts";
const ABSENT = "test/absent-reader.test.ts";

function put(repo: GitRepo, path: string, text: string) {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), text);
}

function task(id: string, file: string, proof = `grep: marker in ${file}`): Task {
  return { id, title: "reader fixture", repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", status: "queued", risk: "low", attempts: 0, files: [file], acceptance: [{ claim: "marker", proof }] };
}

test("W1-T9862: a moved test path mints no proof debt and an absent one still does", (t) => {
  const repo = gitRepo({ scope: t, kind: "moved-proof-debt" });
  put(repo, MOVED, "marker\n");
  put(repo, "test/a/ambiguous.test.ts", "marker\n");
  put(repo, "test/b/ambiguous.test.ts", "marker\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed moved tests");
  const tasks = [task("W1-T1", OLD), task("W1-T2", ABSENT),
    task("W1-T3", OLD, `unit test: ${OLD}`), task("W1-T4", ABSENT, `unit test: ${ABSENT}`),
    task("W1-T5", "test/ambiguous.test.ts")];
  const checked: string[] = [];
  const report = proofQueueAudit(tasks, {
    root: repo.dir,
    pathExists: (path) => existsSync(join(repo.dir, path)),
    creditedIds: new Set(tasks.map((entry) => entry.id)),
    grepMatches: (_pattern, path) => { checked.push(path); return path === MOVED; },
  });
  assert.deepEqual(report.offenders.map((o) => [o.taskId, o.cause]), [
    ["W1-T2", "grep-path-absent"], ["W1-T4", "credited-test-path-absent"], ["W1-T5", "grep-path-absent"],
  ]);
  assert.deepEqual(report.resolvedFully, ["W1-T1", "W1-T3"]);
  assert.deepEqual(checked, [MOVED]);
  const minted = mintProofDebtProposals(report.offenders, (id) => `plan/tasks.d/${id}.yaml`, join(repo.dir, "proposals.yaml"));
  assert.equal(minted.mintedProposalIds.length, 3, "only absent or ambiguous paths mint debt");
  const noOpinion = proofQueueAudit([tasks[0]!], { root: repo.dir });
  assert.deepEqual(noOpinion.offenders, []);
  assert.deepEqual(noOpinion.resolvedFully, []);
});

test("W1-T9862: a synthetic item citing a moved test is kept", (t) => {
  const repo = gitRepo({ scope: t, kind: "moved-synthetic" });
  put(repo, "feature.txt", "broken\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed broken feature");
  put(repo, "feature.txt", "fixed\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "fix: feature", "-m", "Remudero-Task: W1-T1");
  put(repo, "package.json", '{"type":"module"}\n');
  put(repo, "test/setup/tmp-hygiene.ts", "export {};\n");
  put(repo, MOVED, [
    'import assert from "node:assert/strict";', 'import { readFileSync } from "node:fs";',
    'import { test } from "node:test";',
    'test("the feature works", () => assert.equal(readFileSync("feature.txt", "utf8"), "fixed\\n"));',
  ].join("\n"));
  repo.git("add", ".");
  repo.git("commit", "-qm", "move feature proof");
  symlinkSync(join(process.cwd(), "node_modules"), join(repo.dir, "node_modules"), "dir");
  const item = (path: string) => ({ taskId: "W1-T1", proofs: [
    { claim: "feature", proof: `unit test: ${path}`, holdout: true },
    { claim: "marker", proof: `grep: the feature works in ${path}`, holdout: false },
  ] });
  const report = mineSyntheticTasks([item(OLD), item(ABSENT)], { repoDir: repo.dir, mainRef: "HEAD" });
  assert.equal(report.kept.length, 1, JSON.stringify(report.excluded));
  assert.deepEqual(report.kept[0]!.grading, { main: "pass", candidate: "fail" });
  assert.equal(report.kept[0]!.proofs[0]!.proof, `unit test: ${OLD}`, "sealed historical proof stays intact");
  assert.equal(report.excluded.length, 1);
  assert.match(report.excluded[0]!.reason, /proof on main was/);
});

test("W1-T9862: a moved finding dedups against the open task", async (t) => {
  const repo = gitRepo({ scope: t, kind: "moved-gardeners" });
  const now = Date.now();
  put(repo, MOVED, "");
  mkdirSync(join(repo.dir, "state"));
  const events: Array<{ step: string; data: Record<string, unknown> }> = [];
  const deps = { repoRoot: repo.dir, stateDir: join(repo.dir, "state"), clock: fixedClock(now),
    log: (step: string, data: Record<string, unknown> = {}) => { events.push({ step, data }); },
    openWorkspace: () => { throw new Error("a covered finding must not open a workspace"); },
  };
  await t.test("flake incident", async () => {
    for (const pr of [1, 2, 3]) appendFileSync(join(deps.stateDir, "ledger.ndjson"), JSON.stringify({
      ts: new Date(now).toISOString(), step: "test.flake_retry", file: MOVED, titles: ["feature"],
      retry_outcome: "recovered", ci_run_id: pr, shard: 1, source: "selector-shadow",
      head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr],
    }) + "\n");
    await runFlakeIncidentGardener(deps, {
      mintTaskId: () => { throw new Error("covered"); }, readChangedPaths: () => ["src/unrelated.ts"], readSource: () => "",
      planTasks: () => [{ id: "W1-T10", origin: flakeIncidentOrigin(OLD, ""), status: "queued" }],
    });
    assert.deepEqual(events.filter((r) => r.step === "flake_incident.skipped").map((r) => r.data.reason), ["open-task W1-T10"]);
    assert.equal(flakeIncidentOrigin(MOVED, ""), `flake-incident:${MOVED}`);
  });
  await t.test("selector shadow", async () => {
    const record = { fullRun: false, floorSize: 1, narrowSize: 0,
      failures: [{ file: MOVED, floor: "selected", narrow: "missed" }] };
    const log = Array.from({ length: SELECTOR_SHADOW_SHARDS }, (_, i) =>
      `coverage-shard (${i + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify(i === 0 ? record : { ...record, failures: [] })}\n` +
      `coverage-shard (${i + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${i === 0 ? "failure" : "success"}`,
    ).join("\n");
    await runSelectorShadowGardener(deps, () => [{ id: 11, headSha: "head", log }], () => ["src/unrelated.ts"],
      () => { throw new Error("covered"); }, () => [{ id: "W1-T11", origin: selectorShadowCauseOrigin(OLD), status: "queued" }]);
    assert.deepEqual(events.filter((r) => r.step === "selector-shadow.miss_evidence").map((r) => r.data.task_id), ["W1-T11"]);
    assert.equal(selectorShadowCauseOrigin(MOVED), `selector-shadow-miss:${MOVED}`);
  });
  await t.test("expiring fixture", async () => {
    put(repo, "scripts/source-size-baseline.json", "{}\n");
    put(repo, "scripts/comment-load-baseline.json", "{}\n");
    put(repo, "scripts/learnings-budget-baseline.json", '{"measuredChars":0,"measuredActiveEntries":0}\n');
    put(repo, ".github/workflows/ci-gate.yml", 'jobs:\n  ci-gate:\n    env:\n      REQUIRED: \'["ci"]\'\n      ADVISORY: \'["dashboard"]\'\n');
    put(repo, "plan/tasks.yaml", "[]\n");
    repo.git("add", MOVED);
    repo.git("commit", "-qm", "track expiring fixture");
    const probes = await loadGateProbes(process.cwd());
    probes.ef = { MARGIN_DAYS: 1, censusExpiringFixtures: () => ({ reported: [{ file: MOVED, line: 1,
      stamp: new Date(now).toISOString(), field: "ts", threshold: "stale", expiresAt: now + 86400000, daysLeft: 1 }] }) };
    const sources = { thresholdDays: 7, openOrigins: () => [`expiring-fixture:${OLD}`],
      runSuite: (_file: string, days: number) => days < 1,
    };
    assert.deepEqual(gateGardenSpec(deps, probes, sources).inventory().candidates.filter((a) => a.class === "defuse"), []);
    assert.equal(events.filter((r) => r.step === "gate_garden.defuse_deferred").length, 1);
    const uncovered = gateGardenSpec(deps, probes, { ...sources, openOrigins: () => [`expiring-fixture:${ABSENT}`] })
      .inventory().candidates.filter((a) => a.class === "defuse");
    assert.deepEqual(uncovered.map((a) => a.target), [`expiring-fixture:${MOVED}`]);
  });
});

test("W1-T9862: two tasks naming the old and new path of one test overlap", () => {
  const result = partitionByFileOverlap([task("W1-T1", OLD), task("W1-T2", MOVED), task("W1-T3", ABSENT)]);
  assert.deepEqual(result.dispatch.map((t) => t.id), ["W1-T1", "W1-T3"]);
  assert.deepEqual(result.serialized, [{ task: "W1-T2", blockedBy: "W1-T1", paths: [OLD, MOVED] }]);
  const sources = partitionByFileOverlap([task("W1-T4", "src/a/shared.ts"), task("W1-T5", "src/b/shared.ts")]);
  assert.equal(sources.dispatch.length, 2);
});

test("W1-T9862: test identity keeps fixtures and non-test paths exact", () => {
  assert.equal(resolver.sameTestFile(OLD, MOVED), true);
  for (const [a, b] of [[OLD, ABSENT], ["src/a/x.test.ts", "src/b/x.test.ts"],
    ["test/fixtures/x.test.ts", "test/x.test.ts"], ["test/../x.test.ts", "test/x.test.ts"],
    ["test/a/helper.ts", "test/b/helper.ts"]]) assert.equal(resolver.sameTestFile(a!, b!), false);
  assert.equal(resolver.sameTestFile("src/a.ts", "src/a.ts"), true);
});
