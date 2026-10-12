import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { evaluateRoutingExperiment, ROUTING_EXPERIMENTS, routingAbCommand } from "../src/lib/routing-experiments.js";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/private-routing-daily-review.mjs");
const { dailyRoutingReview } = await import(pathToFileURL(script).href);
const epoch = ROUTING_EXPERIMENTS.find((item) => item.id === "sol61-vs-sonnet55")!;
const asOf = "2026-10-02T14:00:00.000Z";
const ndjson = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function assignment(id: string, arm = "sol61") {
  return { ts: "2026-10-02T10:00:00.000Z", step: "worker.assignment", task_id: `W1-T${id}`,
    worker_assignment: { id: `a-${id}`, selected: { provider: arm === "sol61" ? "codex" : "claude" }, routing: {
      decision: { ab: epoch.id, considered: [{ provider: "claude", model: "claude-sonnet-5-5" }, { provider: "codex", model: "gpt-6.1-sol" }] },
      experiment: { assignedArm: arm, crossover: false },
    } } };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-daily-review-"));
  const sources = ["core", "site", "console"].map((label) => ({ label, stateDir: join(dir, label) }));
  for (const source of sources) { mkdirSync(source.stateDir); writeFileSync(join(source.stateDir, "ledger.ndjson"), ndjson([assignment("1")])); }
  return { dir, sources, outDir: join(dir, "out"), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Sol 6.1 review is due every day before October 16 without lowering the sample minimum", async () => {
  for (const experiment of ROUTING_EXPERIMENTS.filter((item) => item.id.startsWith("sol61-"))) {
    for (const day of ["2026-10-02", "2026-10-03", "2026-10-04"]) {
      const report = evaluateRoutingExperiment([], experiment, day);
      assert.equal(report.reviewCadence, "daily"); assert.equal(report.revisitDue, true);
      assert.equal(report.nextReviewOn, `2026-10-0${Number(day.slice(-1)) + 1}`);
      assert.equal(report.sufficient, false); assert.equal(experiment.minTasksPerArm, 20);
    }
    const early = evaluateRoutingExperiment([], experiment, "2026-10-01");
    assert.equal(early.revisitDue, false); assert.equal(early.nextReviewOn, "2026-10-02");
  }
  const lines: string[] = [];
  await routingAbCommand([], { stateDir: "/unused/state", readRows: async () => [], today: "2026-10-02", print: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes("daily provisional review; next 2026-10-03")));
});

test("daily trial receipt coverage never substitutes selected models or merges for provider evidence", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson([
      assignment("1"), assignment("2"), assignment("3"),
      { ts: "2026-10-02T10:01:00Z", step: "worker.attempt", selection_assignment_id: "a-1", served_model: "gpt-6.1-sol-2026-09-29", success: false, total_cost_usd: 0, billing_mode: "api" },
      { ts: "2026-10-02T10:01:01Z", step: "verdict", selection_assignment_id: "a-1", success: false },
      { ts: "2026-10-02T10:02:00Z", step: "worker.attempt", selection_assignment_id: "a-2", served_model: " ", total_cost_usd: 0.2 },
      { ts: "2026-10-02T10:03:00Z", step: "verdict.merged", task_id: "W1-T3" },
    ]));
    const report = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0].reports.find((item: { id: string }) => item.id === epoch.id);
    const arm = report.arms.find((item: { arm: string }) => item.arm === "sol61");
    assert.deepEqual(arm.receiptCoverage, { assignments: 3, terminalAssignments: 2, costKnownAssignments: 1,
      servedModelKnownAssignments: 1, outcomeKnownAssignments: 1 });
    assert.equal(arm.nonStarterAssignments, 1);
    assert.equal(arm.costMissingAssignments, 2);
    assert.equal(arm.merged, 1);
    const persisted = JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8"));
    assert.deepEqual(persisted.sources[0].reports.find((item: { id: string }) => item.id === epoch.id).arms[1].receiptCoverage, arm.receiptCoverage);
  } finally { f.close(); }
});

test("negative trial costs remain missing while a measured zero cash cost is retained", () => {
  const report = evaluateRoutingExperiment([
    assignment("1"), assignment("2"), assignment("3"),
    { step: "worker.attempt", selection_assignment_id: "a-1", total_cost_usd: -1, cost_usd: -2, billing_mode: "api" },
    { step: "worker.attempt", selection_assignment_id: "a-2", total_cost_usd: 0, billing_mode: "api" },
    { step: "worker.attempt", selection_assignment_id: "a-3", total_cost_usd: -1, cost_usd: 0.2, billing_mode: "subscription" },
  ], epoch, "2026-10-02");
  const arm = report.arms.find(item => item.arm === "sol61")!;
  assert.equal(arm.meanCashCostUsd, 0);
  assert.equal(arm.meanNotionalCostUsd, 0.2);
  assert.equal(arm.costMissingAssignments, 1);
  assert.equal(arm.receiptCoverage.costKnownAssignments, 2);
});

test("daily routing review reads all three ledger forms once and keeps repositories separate", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.2026-10-02T10-00-00-000Z.ndjson"), ndjson([assignment("1"), assignment("2", "sonnet")]));
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), gzipSync(ndjson([assignment("3")])));
    const result = await dailyRoutingReview({ ...f, asOf });
    const core = result.snapshot.sources[0];
    assert.deepEqual(core.forms, { gzip: 1, plain: 1, live: 1 }); assert.equal(core.rowsRead, 3);
    assert.equal(core.reports.find((item: { id: string }) => item.id === epoch.id).assignments, 3);
    assert.equal(result.snapshot.sources[1].reports.find((item: { id: string }) => item.id === epoch.id).assignments, 1);
    assert.equal(result.snapshot.previousReview.reason, "no-prior-day-review");
    assert.equal(result.snapshot.nextScheduledReviewAt, "2026-10-03T04:17:00.000Z");
    assert.equal(result.snapshot.routingChanged, false); assert.equal(result.snapshot.comparativeClaims, "none");
    assert.equal(statSync(f.outDir).mode & 0o777, 0o700);
    for (const file of ["2026-10-02.json", "2026-10-02.txt", "latest.json", "latest.txt", "2026-10-02.quarantine.json"]) assert.equal(statSync(join(f.outDir, file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8")), result.snapshot);
    assert.match(result.text, /sol61-vs-sonnet55: provisional/);
  } finally { f.close(); }
});

test("daily routing review preserves missing and malformed sources instead of claiming an empty healthy trial", async () => {
  const f = fixture();
  try {
    rmSync(f.sources[0]!.stateDir, { recursive: true });
    rmSync(join(f.sources[1]!.stateDir, "ledger.ndjson"));
    writeFileSync(join(f.sources[2]!.stateDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), "corrupt gzip");
    writeFileSync(join(f.sources[2]!.stateDir, "ledger.ndjson"), ndjson([assignment("1"), 12]) + "bad-json\n");
    const result = await dailyRoutingReview({ ...f, asOf });
    assert.equal(result.snapshot.state, "observed-partial");
    assert.deepEqual(result.snapshot.sources[0].reasons, ["ledger-source-unreadable"]);
    assert.deepEqual(result.snapshot.sources[1].reasons, ["ledger-source-missing"]);
    assert.deepEqual(result.snapshot.sources[2].reasons, ["ledger-source-unreadable", "ledger-source-malformed"]);
    const report = result.snapshot.sources[2].reports.find((item: { id: string }) => item.id === epoch.id);
    assert.equal(report.assignments, 1); assert.equal(report.reviewState, "source-incomplete");
    assert.equal(report.nextAction, "repair-source-evidence");
  } finally { f.close(); }
});

test("daily routing review retains raw receipts and writes hashed findings to a private quarantine manifest", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson([assignment("1"),
      { ...assignment("2"), ts: "2026-10-03T10:00:00.000Z" }, { ...assignment("3"), ts: "bad" }]));
    const result = await dailyRoutingReview({ ...f, asOf });
    const source = result.snapshot.sources[0];
    const quarantine = JSON.parse(readFileSync(join(f.outDir, "2026-10-02.quarantine.json"), "utf8"));
    assert.equal(quarantine.rawReceiptsRetained, true);
    assert.equal(quarantine.sources[0].findings.length, 2);
    assert.match(quarantine.sources[0].findings[0].rowHash, /^[a-f0-9]{64}$/);
    assert.equal(readFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean).length, 3);
    assert.equal(source.futureRows, 1); assert.equal(source.invalidTimestampRows, 1);
    assert.deepEqual(source.reasons, ["ledger-source-invalid-timestamp", "ledger-source-future-dated"]);
    assert.equal(source.newestTs, "2026-10-02T10:00:00.000Z");
    const arm = source.reports.find((item: { id: string }) => item.id === epoch.id).arms.find((item: { arm: string }) => item.arm === "sol61");
    assert.equal(arm.tasks, 1); assert.equal(arm.nonStarterAssignments, 1); assert.equal(arm.costMissingAssignments, 1);
    assert.equal(arm.meanCashCostUsd, null);
  } finally { f.close(); }
});

test("normal writes arriving during a daily scan do not become false source warnings", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson([assignment("1"),
      { ...assignment("2"), ts: "2026-10-02T14:00:01.000Z" }]));
    const result = await dailyRoutingReview({ ...f, asOf });
    assert.equal(result.snapshot.sources[0].state, "observed");
    assert.equal(result.snapshot.sources[0].futureRows, 0);
    assert.equal(result.snapshot.sources[0].rowsRead, 1);
  } finally { f.close(); }
});

test("daily routing review shows prior-day growth and sample readiness without promoting a winner", async () => {
  const f = fixture();
  try {
    await dailyRoutingReview({ ...f, asOf });
    const rows = Array.from({ length: 40 }, (_, index) => assignment(String(index + 1), index < 20 ? "sol61" : "sonnet"));
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson(rows));
    const result = await dailyRoutingReview({ ...f, asOf: "2026-10-03T03:00:00.000Z" });
    const report = result.snapshot.sources[0].reports.find((item: { id: string }) => item.id === epoch.id);
    assert.equal(report.sufficient, true); assert.equal(report.reviewState, "sample-minimum-met");
    assert.equal(report.nextAction, "review-matched-cohorts");
    assert.equal(report.changesSincePriorDay.assignments, 39);
    assert.match(result.text, /assignment growth since prior day: 39/);
    assert.deepEqual(report.changesSincePriorDay.tasks, [{ arm: "sonnet", added: 20 }, { arm: "sol61", added: 19 }]);
    assert.equal(result.snapshot.nextScheduledReviewAt, "2026-10-03T04:17:00.000Z");
    assert.equal(result.snapshot.routingChanged, false); assert.equal(result.snapshot.comparativeClaims, "none");
    writeFileSync(join(f.outDir, "2026-10-02.json"), "broken");
    const bad = await dailyRoutingReview({ ...f, asOf: "2026-10-03T03:00:00.000Z" });
    assert.equal(bad.snapshot.previousReview.reason, "prior-day-review-unreadable");
    writeFileSync(join(f.outDir, "2026-10-02.json"), "{}");
    assert.equal((await dailyRoutingReview({ ...f, asOf: "2026-10-03T03:00:00.000Z" })).snapshot.previousReview.state, "unavailable");
    writeFileSync(join(f.outDir, "2026-10-02.json"), JSON.stringify({ version: "routing-daily-review-v1", asOf, sources: [{ label: "core", reports: [{ id: epoch.id, assignments: 1 }] }] }));
    assert.equal((await dailyRoutingReview({ ...f, asOf: "2026-10-03T03:00:00.000Z" })).snapshot.previousReview.state, "unavailable");
  } finally { f.close(); }
});

test("daily routing review runs through its real CLI and refuses invalid fleet paths", () => {
  const f = fixture();
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", cwd: root });
    const result = run("--source", `core=${f.sources[0]!.stateDir}`, "--out-dir", f.outDir);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Daily routing review/);
    for (const args of [["--bad"], [], ["--source", "core=relative", "--out-dir", f.outDir],
      ["--source", `core=${f.sources[0]!.stateDir}`, "--source", `core=${f.sources[0]!.stateDir}`, "--out-dir", f.outDir]]) {
      assert.notEqual(run(...args).status, 0);
    }
  } finally { f.close(); }
});

test("scheduled local routing review completes before a GitHub credential failure", () => {
  const f = fixture();
  try {
    const registry = join(f.dir, "instances.yaml");
    for (const source of f.sources) { mkdirSync(join(source.stateDir, "state")); writeFileSync(join(source.stateDir, "state", "ledger.ndjson"), ndjson([assignment("1")])); }
    writeFileSync(registry, f.sources.map((source) => `  ${source.label}:\n    state_dir: ${source.stateDir}`).join("\n") + "\n");
    const fakeBin = join(f.dir, "bin"); mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n"); chmodSync(join(fakeBin, "flock"), 0o700);
    writeFileSync(join(fakeBin, "docker"), `#!/bin/sh
if [ "$1" = inspect ]; then echo test-image; exit 0; fi
if [ "$1" = run ]; then
  echo "$*" > "$TEST_DOCKER_ARGS"
  exec "$TEST_NODE" --import tsx "$TEST_REVIEW_SCRIPT" --source "core=$TEST_CORE/state" --source "site=$TEST_SITE/state" --source "console=$TEST_CONSOLE/state" --out-dir "$TEST_CORE/state/field-trials/routing-daily"
fi
echo 'GitHub credentials unavailable' >&2
exit 1
`); chmodSync(join(fakeBin, "docker"), 0o700);
    const argsPath = join(f.dir, "docker-args");
    const result = spawnSync("bash", [join(root, "deploy/field-trials-refresh.sh")], { cwd: root, encoding: "utf8", env: { ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`, RMD_INSTANCE_REGISTRY: registry, TEST_DOCKER_ARGS: argsPath,
      TEST_NODE: process.execPath, TEST_REVIEW_SCRIPT: script, TEST_CORE: f.sources[0]!.stateDir,
      TEST_SITE: f.sources[1]!.stateDir, TEST_CONSOLE: f.sources[2]!.stateDir } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /GitHub credentials unavailable/);
    const snapshot = JSON.parse(readFileSync(join(f.sources[0]!.stateDir, "state/field-trials/routing-daily/latest.json"), "utf8"));
    assert.equal(snapshot.sources.length, 3); assert.equal(snapshot.cadence, "daily");
    const args = readFileSync(argsPath, "utf8");
    assert.match(args, /--network none/); assert.match(args, /--workdir \/home\/node\/Remudero\/daemon-install/);
    assert.match(args, /scripts\/private-routing-daily-review.mjs/);
    assert.match(args, /dst=\/field-trials\/site,readonly/);
  } finally { f.close(); }
});


test("scheduled field-trial collection uses current mounted source for every stage", () => {
  const f = fixture();
  try {
    const registry = join(f.dir, "instances.yaml"), bin = join(f.dir, "bin"), log = join(f.dir, "docker-calls");
    mkdirSync(bin);
    for (const source of f.sources) {
      mkdirSync(join(source.stateDir, "state"));
      writeFileSync(join(source.stateDir, "state/ledger.ndjson"), ndjson([assignment("1")]));
    }
    writeFileSync(registry, f.sources.map(source => `  ${source.label}:\n    state_dir: ${source.stateDir}`).join("\n") + "\n");
    writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "flock"), 0o700);
    writeFileSync(join(bin, "docker"), `#!/bin/sh
if [ "$1" = inspect ]; then echo test-image; exit 0; fi
if [ "$1" = exec ]; then echo test-credential; exit 0; fi
printf '%s\\n' "$*" >> "$TEST_DOCKER_CALLS"
exit 0
`); chmodSync(join(bin, "docker"), 0o700);
    const result = spawnSync("bash", [join(root, "deploy/field-trials-refresh.sh")], { cwd: root, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RMD_INSTANCE_REGISTRY: registry,
        RMD_FIELD_TRIALS_CASE_FILES: "", TEST_DOCKER_CALLS: log } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 3, JSON.stringify({ calls, stdout: result.stdout, stderr: result.stderr }));
    for (const call of calls) assert.match(call, /--workdir \/home\/node\/Remudero\/daemon-install/);
    assert.match(calls[1]!, /scripts\/private-field-trials-case-files.mjs/);
    assert.match(calls[1]!, /--env RMD_FIELD_TRIALS_REPO_ROOT=\/home\/node\/Remudero\/daemon-install(?: |$)/,
      "case-file plan lookup must use the mounted source, independently of the process workdir");
    assert.match(calls[2]!, /\/home\/node\/Remudero\/daemon-install\/bin\/rmd field-trials/);
    assert.doesNotMatch(calls.join("\n"), /--workdir \/app|\/app\/bin\/rmd/);
  } finally { f.close(); }
});

test("the installed daily path observes three-form review delivery and self-improvement without inventing efficacy", async () => {
  const f = fixture();
  try {
    const base = { pr_url: "https://github.com/a/b/pull/4", head_sha: "a".repeat(40), review_input_digest: "b".repeat(64) };
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.2026-10-02T09-00-00-000Z.ndjson.gz"), gzipSync(ndjson([
      { ...base, ts: "2026-10-02T09:00:00Z", step: "sweep.review_eligible" },
    ])));
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.2026-10-02T10-00-00-000Z.ndjson"), ndjson([
      { ...base, ts: "2026-10-02T09:01:00Z", step: "sweep.review_admitted" },
      { ...base, ts: "2026-10-02T09:02:00Z", step: "sweep.post_review.attempt" },
    ]));
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson([
      { ...base, ts: "2026-10-02T09:03:00Z", step: "review.posted", state: "success", reviewer_outcome: "not_attempted" },
      { ts: "2026-10-02T09:04:00Z", step: "ci_learning_cadence.ran", status: "backlog", filed: 2, refused: 1,
        lesson_recurrences: { status: "observed", recurrenceCount: 3 } },
      { ts: "2026-10-02T09:05:00Z", step: "ci_learning_cadence.run_failed" },
      { ts: "2026-10-02T09:06:00Z", step: "config.gardener_failed" },
      { ts: "2026-10-02T09:07:00Z", step: "config.gardener_judged", verdict: "credit" },
      { ts: "2026-10-02T09:08:00Z", step: "config.gardener_judged", verdict: "debit" },
      { ts: "2026-10-02T09:09:00Z", step: "goal.unmoved", goal_id: "G-flow", key: "c".repeat(64),
        baseline: 4, value: 5, tasks: ["W1-T4"], pricedUsd: 0, unpricedRows: 1, priorityAction: "governed-proposal",
        windowDays: 7, costBasis: "produced-ledger-receipts", costComplete: false, measurement: "pr-flow-minutes" },
    ]));
    const result = await dailyRoutingReview({ ...f, asOf });
    const source = result.snapshot.sources[0];
    assert.equal(source.reviewFlow.counts.delivered, 1);
    assert.equal(source.reviewFlow.completedOnly.p95Ms, 180000);
    assert.equal(source.reviewFlow.semantic.notAttempted, 1);
    assert.equal(source.reviewFlow.sourceComplete, false);
    assert.equal(source.selfImprovement.ciLearning.filed, 2);
    assert.equal(source.selfImprovement.ciLearning.recurredLessons, 3);
    assert.equal(source.selfImprovement.ciLearningFailures, 1);
    assert.equal(source.selfImprovement.gardenerFailures, 1);
    assert.equal(source.selfImprovement.gardenerCredits, 1);
    assert.equal(source.selfImprovement.gardenerDebits, 1);
    assert.equal(source.selfImprovement.goals[0].outcome, "goal.unmoved");
    assert.equal(source.selfImprovement.efficacyClaim, "none");
    assert.match(result.text, /uncertified retention/);
    assert.match(result.text, /served identity 0\/0/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8")).sources[0].reviewFlow, source.reviewFlow);
  } finally { f.close(); }
});

test("daily trial costing preserves explicit subscription notional across a zero-cost terminal restatement", () => {
  const report = evaluateRoutingExperiment([assignment("1"),
    { step: "worker.attempt", selection_assignment_id: "a-1", notional_cost_usd: 0.75, billing_mode: "subscription" },
    { step: "verdict", selection_assignment_id: "a-1", total_cost_usd: 0, success: true },
  ], epoch, "2026-10-02");
  const arm = report.arms.find(item => item.arm === "sol61")!;
  assert.equal(arm.meanNotionalCostUsd, 0.75);
  assert.equal(arm.meanCashCostUsd, null);
  assert.equal(arm.costMissingAssignments, 0);
  assert.equal(arm.receiptCoverage.costKnownAssignments, 1);
  const invalid = evaluateRoutingExperiment([assignment("1"),
    { step: "worker.attempt", selection_assignment_id: "a-1", notional_cost_usd: -1, total_cost_usd: 0, billing_mode: "subscription" },
  ], epoch, "2026-10-02").arms.find(item => item.arm === "sol61")!;
  assert.equal(invalid.meanNotionalCostUsd, null);
  assert.equal(invalid.costMissingAssignments, 1);
});

test("a daily row-budget breach remains partial evidence rather than a healthy zero", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson(Array.from({ length: 100001 }, (_, n) => ({
      ts: "2026-10-02T10:00:00Z", step: "worker.assignment", task_id: `W1-T${n}`,
    }))));
    const source = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0];
    assert.equal(source.rowsRead, 100001);
    assert.equal(source.retainedRowsOmitted, 1);
    assert.equal(source.state, "observed-partial");
    assert.ok(source.reasons.includes("ledger-retention-row-bound"));
    assert.equal(source.reports[0].nextAction, "repair-source-evidence");
  } finally { f.close(); }
});


test("the installed daily collector preserves lesson exposure identities from one latest firing over all ledger forms", async () => {
  const { judgeCiLessonEfficacy, summarizeCiLessonRecurrences } = await import("../src/lib/ci-lesson-recurrence.js");
  const f = fixture();
  try {
    const summary = summarizeCiLessonRecurrences(judgeCiLessonEfficacy({
      pairs: [{ pr: 9, gate: "ci-gate", redSha: "red", state: "open" }],
      fullyObservedGatePrs: [{ pr: 9, gate: "ci-gate" }, { pr: 11, gate: "ci-gate" }, { pr: 12, gate: "other" }],
    }, [{ findingId: "ci-learning:1:ci-gate", gate: "ci-gate", watermarkPr: 2 }]), 3, {
      windowStart: "2026-10-01T12:00:00Z", asOf: "2026-10-02T12:00:00Z", complete: true, prsScanned: 3,
    });
    const firing = { ts: "2026-10-02T12:01:00Z", step: "ci_learning_cadence.ran", run_id: "cadence1", lesson_recurrences: summary };
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson([firing]));
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.2026-10-02T10-00-00-000Z.ndjson"), ndjson([firing]));
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.2026-10-02T11-00-00-000Z.ndjson.gz"), gzipSync(ndjson([firing])));
    const first = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0].selfImprovement.ciLearning.lessonExposure;
    assert.equal(first.status, "observed");
    assert.deepEqual(first.lessons[0].exposedPrs, [9, 11]);
    assert.deepEqual(first.lessons[0].recurredPrs, [9]);
    assert.equal(first.exposureCount, 2); assert.equal(first.recurrenceCount, 1); assert.equal(first.observedRecurrenceRate, 0.5);
    assert.equal(first.retention, "uncertified");
    // Overlapping daily snapshots preserve this same firing; they never sum a prior day's rate/count.
    const next = (await dailyRoutingReview({ ...f, asOf: "2026-10-03T11:00:00Z" })).snapshot.sources[0].selfImprovement.ciLearning.lessonExposure;
    assert.deepEqual(next, first);
    const persisted = JSON.parse(readFileSync(join(f.outDir, "latest.json"), "utf8"));
    assert.deepEqual(persisted.sources[0].selfImprovement.ciLearning.lessonExposure, first);
    writeFileSync(join(f.sources[0]!.stateDir, "ledger.ndjson"), ndjson([firing]) + "invalid JSON\n");
    const partial = (await dailyRoutingReview({ ...f, asOf })).snapshot.sources[0].selfImprovement.ciLearning.lessonExposure;
    assert.equal(partial.status, "partial"); assert.equal(partial.observedRecurrenceRate, null);
    assert.equal(partial.exposureCount, 2);
  } finally { f.close(); }
});
