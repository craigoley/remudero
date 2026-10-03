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
    assert.equal(source.futureRows, 2); assert.equal(source.newestTs, "2026-10-02T10:00:00.000Z");
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
