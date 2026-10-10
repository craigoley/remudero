/**
 * Every gardener that files plan shards lands only what lint-plan would admit. lint-plan --base runs
 * the machine-filing admission (W1-T3843) on every filing PR, but each filer's own pre-landing check
 * called `lintTask(task)` without it, so it passed while checking nothing. #10446 (a workflow-owned
 * ci-friction draft) and #10457 (a two-file selector edge) each filed shards that went red on
 * lint-plan. Now one guard (machine-filing.ts) sits on every filer's landing path, and a draft it
 * refuses is a recorded filing failure, never a red PR.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ciFrictionGardenSpec, type CiFrictionGardenSources } from "../src/lib/ci-friction-gardener.js";
import { flowGardenSpec, type FlowGardenSources } from "../src/lib/flow-remedy-gardener.js";
import { gateGardenSpec, type GateProbes } from "../src/lib/gate-gardener.js";
import { runGarden, type GardenCheckout, type GardenerDeps, type GardenSpec } from "../src/lib/gardener.js";
import { fileConsumerVia, type ConsumerFiling } from "../src/lib/host-resource-gardener.js";
import { hotFileGardenSpec, hotFileRemedy, hotFileShardStem, hotFileShardYaml, type HotFileGardenSources, type HotFilePrice } from "../src/lib/hot-file-gardener.js";
import { flowFollowUpStem, renderFlowFollowUp, type FlowStageStat } from "../src/lib/flow-gardener.js";
import { machineShardFilingRefusal, machineShardLandingGuard, machineShardLandingRefusal } from "../src/lib/machine-filing.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "../src/lib/plan.js";
import { scoutGardenSpec } from "../src/lib/scout-gardener.js";
import { runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  SELECTOR_SHADOW_MISS_TEST_PATH,
  runSelectorShadowGardener,
  selectorShadowMissTask,
  selectorShadowStructuralTask,
  selectorShadowStructuralTestPath,
} from "../src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MISS = { runId: 1, headSha: "abc", selection: "narrow" as const, file: "test/prompt-render.test.ts" };

test("the real narrow selector edge shard passes lint-plan's machine-filing admission", () => {
  const yaml = selectorShadowMissTask(MISS, "W1-T9041", ["src/run-task.ts"]);
  const plan = loadPlanFromYaml(yaml, "plan/tasks.d/w1-t9041-selector-shadow-miss.yaml");
  const task = plan.tasks[0]!;
  assert.deepEqual(task.files, ["src/lib/affected-suites.ts", SELECTOR_SHADOW_MISS_TEST_PATH]);
  const onMain = (path: string) => task.files!.includes(path);
  assert.deepEqual(machineFilingAdmissionViolations(task, { plan, releasedIds: new Set(), pathExists: onMain }), []);
  assert.equal(machineShardFilingRefusal(yaml, "plan/tasks.d/w1-t9041-selector-shadow-miss.yaml", { pathExists: onMain }), undefined);
});

test("the real structural selector shard passes admission with the new test it must add", () => {
  const yaml = selectorShadowStructuralTask(MISS.file, "W1-T9042", ["src/run-task.ts -> test/prompt-render.test.ts"], "W1-T9041");
  const plan = loadPlanFromYaml(yaml, "plan/tasks.d/w1-t9042-selector-shadow-miss.yaml");
  const task = plan.tasks[0]!;
  assert.deepEqual(task.files, ["src/lib/affected-suites.ts", selectorShadowStructuralTestPath(MISS.file)]);
  const onMain = (path: string) => path === "src/lib/affected-suites.ts";
  assert.deepEqual(machineFilingAdmissionViolations(task, { plan, releasedIds: new Set(), pathExists: onMain }), []);
});

test("a selector edge shard outside the filer's shape is still refused", () => {
  const yaml = selectorShadowMissTask(MISS, "W1-T9043", []).replace(
    `files: [src/lib/affected-suites.ts, ${SELECTOR_SHADOW_MISS_TEST_PATH}]`,
    `files: [src/lib/affected-suites.ts, ${SELECTOR_SHADOW_MISS_TEST_PATH}, src/lib/plan.ts]`,
  );
  const refused = machineShardFilingRefusal(yaml, "plan/tasks.d/w1-t9043-selector-shadow-miss.yaml", { pathExists: () => true });
  assert.match(refused ?? "", /machine-filing-admission: .*verify:human/);
});

/** A tree holding one machine shard lint-plan refuses: a selector edge that declares a third file. */
function refusedLanding(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filer-guard-`));
  for (const file of ["src/lib/affected-suites.ts", SELECTOR_SHADOW_MISS_TEST_PATH, "src/lib/plan.ts"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "// fixture\n");
  }
  const path = join("plan", "tasks.d", "w1-t9044-selector-shadow-miss.yaml");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, path), selectorShadowMissTask(MISS, "W1-T9044", []).replace(
    `files: [src/lib/affected-suites.ts, ${SELECTOR_SHADOW_MISS_TEST_PATH}]`,
    `files: [src/lib/affected-suites.ts, ${SELECTOR_SHADOW_MISS_TEST_PATH}, src/lib/plan.ts]`,
  ));
  return { root, path };
}

function depsAt(root: string): GardenerDeps {
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({ root, branch: "guard-1", land: () => "https://github.com/acme/remudero/pull/1", dispose: () => {} }),
    log: () => {},
  };
}

test("every registered spec gardener that files shards carries the landing guard, and it refuses a draft admission would", () => {
  const { root, path } = refusedLanding();
  const deps = depsAt(root);
  const never = () => { throw new Error("not read"); };
  const specs: Array<{ name: string; landingRefusal?: (root: string, paths: readonly string[]) => string | undefined }> = [
    ciFrictionGardenSpec(deps, { ownerSearch: { filesContaining: () => [], fileExists: () => false } } as unknown as CiFrictionGardenSources),
    flowGardenSpec(deps, {} as FlowGardenSources),
    gateGardenSpec(deps, {} as GateProbes),
    hotFileGardenSpec(deps, {} as HotFileGardenSources),
    scoutGardenSpec(deps, { mintTaskId: never }),
  ];
  assert.deepEqual(specs.map((s) => s.name).sort(), ["ci-friction", "flow-remedy", "gate", "hot-file", "scout"]);
  for (const spec of specs) {
    assert.ok(spec.landingRefusal, `${spec.name} lands shards with no landing guard`);
    assert.match(spec.landingRefusal(root, [path]) ?? "", /machine-filing-admission/, `${spec.name}'s guard admitted a refused draft`);
  }
});

test("runGarden records a refused draft as a filing failure and never opens its PR", () => {
  const { root, path } = refusedLanding();
  const events: string[] = [];
  const landed: string[][] = [];
  const deps: GardenerDeps = {
    ...depsAt(root),
    openWorkspace: () => ({ root, branch: "guard-1", land: (o) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
    log: (step) => { events.push(step); },
    seed: 1,
  };
  const spec: GardenSpec<"draft", number, { class: "draft"; target: string; reason: string }, GardenCheckout> = {
    name: "guarded",
    classes: ["draft"],
    review: { draft: "fixture" },
    landingRefusal: machineShardLandingGuard(deps),
    cheapFingerprint: () => "f",
    inventory: () => 1,
    fingerprint: () => "f",
    candidates: () => [{ class: "draft", target: "t", reason: "r" }],
    scorecard: () => ({}),
    apply: () => ({ paths: [path], title: "chore(plan): fixture", body: "fixture" }),
  };
  runGarden(spec, deps);
  assert.deepEqual(landed, [], "a draft lint-plan would refuse never opens a PR");
  assert.ok(events.includes("guarded.garden_filing_failed"), `the refusal is a recorded filing failure (events: ${events.join(", ")})`);
});

test("every module that renders a machine shard lands it through the guard", () => {
  const lib = join(process.cwd(), "src", "lib");
  // The CI-learning rung renders its shards here but lands them through feedback-landing.ts, which
  // cannot import machine-filing.ts (its import chain reaches the linter). Its one shape, learnings/ci.yaml,
  // is a parked machine proposal that admission already accepts.
  const exempt = new Set(["measurement-cadence.ts"]);
  const filers = readdirSync(lib)
    .filter((f) => f.endsWith(".ts") && f !== "machine-filing.ts")
    .filter((f) => /\b(renderMachineShard|machineShardHeaderLines)\b/.test(readFileSync(join(lib, f), "utf8")));
  assert.ok(filers.length >= 10, `found only ${filers.length} machine shard filers: ${filers.join(", ")}`);
  const unguarded = filers.filter((f) => !exempt.has(f) && !/\bmachineShardLanding(Guard|Refusal)\(/.test(readFileSync(join(lib, f), "utf8")));
  assert.deepEqual(unguarded, [], "a filer that renders machine shards must land them through machine-filing.ts's guard");
});

test("the guard reads only machine shards: an unparseable draft throws, other paths and operator records pass", () => {
  assert.throws(() => machineShardFilingRefusal("- id: [", "plan/tasks.d/x.yaml", { pathExists: () => true }));
  const operator = selectorShadowMissTask(MISS, "W1-T9045", []).replace("  author_class: machine\n", "");
  assert.equal(machineShardFilingRefusal(operator, "plan/tasks.d/w1-t9045-x.yaml", { pathExists: () => false }), undefined);
  const { root } = refusedLanding();
  assert.equal(machineShardLandingRefusal(root, ["README.md", "plan/tasks.d/absent.yaml"]), undefined);
});

test("the guard reads the filer's own tree as the base, so a declared file absent from the checkout is still found", () => {
  const checkout = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filer-guard-head-`));
  const path = join("plan", "tasks.d", "w1-t9046-selector-shadow-miss.yaml");
  mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(checkout, path), selectorShadowMissTask(MISS, "W1-T9046", []));
  const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filer-guard-base-`));
  assert.match(machineShardLandingGuard({ repoRoot: empty })(checkout, [path]) ?? "", /exist in neither the checkout nor the base tree/);
  assert.equal(machineShardLandingGuard({ repoRoot: empty }, () => true)(checkout, [path]), undefined);
});

test("the host-resource filer refuses a shard lint-plan would, before its PR opens", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filer-guard-host-`));
  const filing: ConsumerFiling = {
    host: "azure", device: "root", consumer: "worktrees", origin: "host-resource:azure:worktrees",
    attribution: { consumer: "worktrees", growthKbPerHour: 1024 ** 2, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 },
  };
  const landed: string[][] = [];
  const file = fileConsumerVia(() => ({ root, branch: "host-1", land: (o) => (landed.push(o.paths), "https://github.com/x/y/pull/1"), dispose: () => {} }), () => "W1-T9047");
  assert.throws(() => file(filing), /machine-filing admission/);
  assert.deepEqual(landed, []);
});

test("the flake-incident filer records a shard lint-plan would refuse as a filing failure", async () => {
  const NOW = Date.parse("2026-10-09T09:00:00Z");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filer-guard-flake-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const rows = [10271, 10279, 10287].map((pr) => ({
    ts: new Date(NOW).toISOString(), step: "test.flake_retry", file: "test/absent-flake.test.ts", headline: "recovered on retry",
    ci_run_id: pr * 10, shard: 2, source: "selector-shadow", retry_outcome: "recovered", head_sha: `head-${pr}`,
    base_sha: `base-${pr}`, pr_numbers: [pr], titles: ["a title"],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const landed: string[][] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await runFlakeIncidentGardener(
    {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log: (step, extra) => { events.push({ step, extra }); },
      openWorkspace: () => ({ root, branch: "flake-1", land: (o: { paths: string[] }) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
    },
    { mintTaskId: () => "W1-T9048", readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "" },
  );
  assert.deepEqual(landed, [], "the declared test is absent from the checkout and the base, so the shard never opens");
  assert.match(String(events.find((e) => e.step === "flake_incident.filing_failed")?.extra?.error), /machine-filing admission/);
});

test("the selector-shadow filer refuses a shard lint-plan would, before its PR opens", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filer-guard-selector-`));
  for (const dir of ["test", "state", join("plan", "tasks.d")]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const landed: string[][] = [];
  const log = Array.from({ length: 8 }, (_, i) =>
    `coverage-shard (${i + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify({
      fullRun: false, floorSize: 1, narrowSize: 0,
      failures: i === 0 ? [{ file: "test/cold.test.ts", floor: "selected", narrow: "missed" }] : [],
    })}\ncoverage-shard (${i + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${i === 0 ? "failure" : "success"}`,
  ).join("\n");
  const deps = {
    stateDir: join(root, "state"), repoRoot: root, log: () => {},
    openWorkspace: () => ({ root, branch: "selector-1", land: (o: { paths: string[] }) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
  };
  // The checkout and base hold neither src/lib/affected-suites.ts nor its test, so lint-plan would refuse the edge.
  await assert.rejects(
    runSelectorShadowGardener(deps, () => [{ id: 1, headSha: "head-1", prNumber: 1, log }], () => ["src/lib/status.ts"], () => "W1-T9049", () => []),
    /machine-filing admission/,
  );
  assert.deepEqual(landed, []);
});

/** lint-plan's verdict on one real shard at its real path, with only `onMain` present in the tree. */
function admitted(yaml: string, path: string, onMain: readonly string[]): { admission: string[]; refusal: string | undefined } {
  const plan = loadPlanFromYaml(yaml, path);
  const pathExists = (p: string) => onMain.includes(p);
  return {
    admission: machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists }),
    refusal: machineShardFilingRefusal(yaml, path, { pathExists }),
  };
}

test("the real hot-file restructuring shard passes lint-plan's machine-filing admission for every remedy", () => {
  const files = ["scripts/test-tier-manifest.json", "scripts/comment-load-baseline.json", "docs/ci-friction-garden-log.md", ".gitignore", ".github/workflows/ci.yml"];
  assert.deepEqual(files.map((f) => hotFileRemedy(f)), ["generate-in-ci", "split-per-entry", "append-only", "merge-driver", "merge-driver"]);
  for (const file of files) {
    const price = { file, minutes: 40, rounds: 3, prs: 5, inferredMinutes: 0, recordedMinutes: 40 } as HotFilePrice;
    const yaml = hotFileShardYaml(price, "W1-T9061");
    const task = loadPlanFromYaml(yaml, "x.yaml").tasks[0]!;
    assert.equal(task.files?.[0], file, "the shard declares the hot file itself");
    assert.ok(!task.files?.includes("docs/hot-file-remedies.md"), "never a docs file that does not exist");
    const verdict = admitted(yaml, `plan/tasks.d/W1-T9061-${hotFileShardStem(file)}.yaml`, [file]);
    assert.deepEqual(verdict, { admission: [], refusal: undefined }, `${file}: ${JSON.stringify(verdict)}`);
  }
});

test("a hot-file shard that declares any file but its own hot file first is refused", () => {
  const yaml = hotFileShardYaml({ file: "scripts/test-tier-manifest.json", minutes: 40, rounds: 3, prs: 5, inferredMinutes: 0, recordedMinutes: 40 } as HotFilePrice, "W1-T9062")
    .replace("    - scripts/test-tier-manifest.json\n", "    - scripts/test-tier-manifest.json\n    - src/lib/plan.ts\n");
  const verdict = admitted(yaml, `plan/tasks.d/W1-T9062-${hotFileShardStem("scripts/test-tier-manifest.json")}.yaml`, ["scripts/test-tier-manifest.json", "src/lib/plan.ts"]);
  assert.match(verdict.admission.join(" "), /verify:human/);
});

test("the real flow follow-up shard passes lint-plan's machine-filing admission for a sweep and a CI stage", () => {
  for (const [stage, owner] of [["ready_to_merged", "src/lib/sweep.ts"], ["ci_wall_clock", ".github/workflows/ci.yml"]] as const) {
    const stat = {
      key: `plan:${stage}:all`, cls: "plan", stage, surface: "all", regressed: true,
      current: { n: 4, p50: 25, p90: 40 }, baseline: { n: 6, p50: 10, p90: 10, source: "rolling" }, slowest: [{ pr: 1, value: 40 }],
    } as unknown as FlowStageStat;
    const rendered = renderFlowFollowUp(stat, "W1-T9063", [15]);
    assert.equal(rendered.refused, undefined);
    assert.equal(loadPlanFromYaml(rendered.text, "x.yaml").tasks[0]!.files?.[0], owner);
    const verdict = admitted(rendered.text, `plan/tasks.d/W1-T9063-${flowFollowUpStem(stat)}.yaml`, [owner]);
    assert.deepEqual(verdict, { admission: [], refusal: undefined }, `${stage}: ${JSON.stringify(verdict)}`);
  }
});
