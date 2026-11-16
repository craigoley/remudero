// @source-text-subject: the call sites of the shared machine-shard writer, counted across src/.
// @census-reads: src/ — every module that calls renderMachineShard or machineShardHeaderLines.
/**
 * W1-T12833. Since W1-T11746 the plan PR preflight (`rmd lint-plan --base`) asks every new implementation task
 * for a design-invariant declaration. The shared machine-shard writer linted its own record without that option,
 * so each gardener read its draft as clean and the preflight then refused it: 568 refusals in 60 hours, across
 * the scout, selector-shadow, gate, flow and fix-lane gardens.
 *
 * This census renders one representative record from every machine generator through its real exported function
 * and lints it with the options the writer now exports. It names its members and counts the writer's call sites,
 * so a generator added without a census entry fails here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";

import { ciFrictionShardYaml, type CiFrictionDraft } from "#src/lib/ci-friction-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import { FIX_LANE_LADDER } from "#src/lib/fix-lane-gardener.js";
import { runFlakeIncidentGardener } from "#src/lib/flake-incident-gardener.js";
import {
  openQueueWindow, renderFlowFollowUp, runFlowGardener,
  type FlowGardenSources as FlowStageSources, type FlowOpenQueuePr, type FlowOpenQueueRead, type FlowStageStat,
} from "#src/lib/flow-gardener.js";
import { draftShard, FLOW_LADDER, flowGardenSpec, type FlowAction, type FlowGardenSources } from "#src/lib/flow-remedy-gardener.js";
import { runGarden, type GardenerDeps } from "#src/lib/gardener.js";
import {
  renderCommentCompressionShard, renderDefuseShard, renderFalsePositiveShard, renderHeadroomShard, type GateGardenAction,
} from "#src/lib/gate-gardener.js";
import { consumerShardYaml, type ConsumerFiling } from "#src/lib/host-resource-gardener.js";
import { hotFileRemedy, hotFileShardYaml, type HotFilePrice } from "#src/lib/hot-file-gardener.js";
import {
  MACHINE_SHARD_LINT_OPTIONS, machineShardLintRefusal, renderMachineShard, type MachineShardSpec,
} from "#src/lib/machine-filing.js";
import {
  ciLearningRecordVerdict, ciLearningShardYaml, fileCiLearningShards, type CiLearningShardDraft,
} from "#src/lib/measurement-cadence.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { scoutShard } from "#src/lib/scout-gardener.js";
import { runSelectorShadowGardener, selectorShadowMissTask, selectorShadowStructuralTask } from "#src/lib/selector-shadow-gardener.js";
import { lintTask } from "#src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CHECK = "design-invariant-proof";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** The blocking violations the plan PR preflight's checkout-free options find in one rendered record. */
function blocking(text: string, source: string): string[] {
  return lintTask(loadPlanFromYaml(text, source).tasks[0]!, MACHINE_SHARD_LINT_OPTIONS).violations
    .filter((v) => v.severity === "block").map((v) => `${v.check}: ${v.message}`);
}

function tempRoot(t: TestContext, name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const SPEC = {
  taskId: "W1-T998330",
  title: "Read the widened row without dropping the rows already written",
  origin: "fix-lane:census-fixture",
  files: ["src/lib/machine-filing.ts", "test/gardeners/every-machine-shard-generator-passes-the-changed-task-plan-lint.test.ts"],
  acceptance: [{ claim: "the reader accepts the widened row", proof: "unit test: W1-T998330: the reader accepts the widened row" }],
};

test("W1-T12833 criterion 1: the shared writer lints with the changed-task options and refuses a spec that declares neither form", () => {
  assert.deepEqual({ ...MACHINE_SHARD_LINT_OPTIONS }, { requireDesignInvariantDeclaration: true });
  for (const invariants of [{ declared: [] }, { none: "" }, { none: "<reason>" }]) {
    const rendered = renderMachineShard({ ...SPEC, invariants });
    assert.match(rendered.refused ?? "", new RegExp(CHECK), `${JSON.stringify(invariants)} declares neither form`);
    // Control: the lint the writer ran before this task, with no options, admits the same record.
    const unscoped = lintTask(loadPlanFromYaml(rendered.text, "W1-T998330.yaml").tasks[0]!).violations.filter((v) => v.severity === "block");
    assert.deepEqual(unscoped, [], "only the changed-task option refuses it");
  }
  assert.equal(renderMachineShard({ ...SPEC, invariants: { none: "the fixture adds a reader and changes no existing one" } }).refused, undefined);
  // A slug the design declares and no claim maps is the same refusal, read from the rendered record.
  const orphan = renderMachineShard({ ...SPEC, design: "INVARIANT unmapped-slug: nothing proves this.", invariants: { declared: [] } });
  assert.match(orphan.refused ?? "", new RegExp(CHECK));
});

test("W1-T12833 criterion 2: a spec's required invariants field renders one design line and one mapped claim per slug, or the one reason", () => {
  const kept = { slug: "old-rows-still-read", statement: "a row written before the change is still read.",
    claim: "a row in the old shape reads to the same value as before", proof: "unit test: W1-T998330: an old row still reads" };
  const other = { slug: "unknown-rows-are-kept", statement: "a row of an unknown shape is kept, not dropped.",
    claim: "a row of an unknown shape is still returned", proof: "unit test: W1-T998330: an unknown row is kept" };
  const one = renderMachineShard({ ...SPEC, design: "Widen the reader.", invariants: { declared: [kept] } });
  const task = loadPlanFromYaml(one.text, "W1-T998330.yaml").tasks[0]!;
  assert.equal(task.design, "Widen the reader.\nINVARIANT old-rows-still-read: a row written before the change is still read.");
  assert.deepEqual(task.acceptance!.map((c) => [c.claim, c.proof]), [
    [SPEC.acceptance[0]!.claim, SPEC.acceptance[0]!.proof],
    ["invariant:old-rows-still-read — a row in the old shape reads to the same value as before", kept.proof],
  ]);
  assert.equal(one.refused, undefined);

  const two = renderMachineShard({ ...SPEC, invariants: { declared: [kept, other] } });
  const twoTask = loadPlanFromYaml(two.text, "W1-T998330.yaml").tasks[0]!;
  assert.equal(twoTask.design, `INVARIANT ${kept.slug}: ${kept.statement}\nINVARIANT ${other.slug}: ${other.statement}`);
  assert.deepEqual(twoTask.acceptance!.slice(1).map((c) => c.claim.split(" — ")[0]), ["invariant:old-rows-still-read", "invariant:unknown-rows-are-kept"]);
  assert.equal(two.refused, undefined);
  // Two slugs behind one proof is the lint's own refusal: each needs its own.
  assert.match(renderMachineShard({ ...SPEC, invariants: { declared: [kept, { ...other, proof: kept.proof }] } }).refused ?? "", new RegExp(CHECK));

  const none = renderMachineShard({ ...SPEC, design: "Add a reader.", invariants: { none: "the task adds a new reader and changes no existing one" } });
  const noneTask = loadPlanFromYaml(none.text, "W1-T998330.yaml").tasks[0]!;
  assert.equal(noneTask.design, "Add a reader.\nNO-INVARIANTS: the task adds a new reader and changes no existing one");
  assert.equal(noneTask.acceptance!.length, 1, "a reason maps no claim");
  assert.equal(none.refused, undefined);

  // @ts-expect-error W1-T12833: `invariants` is required, so a call site that omits it does not typecheck.
  const omitted: MachineShardSpec = { ...SPEC };
  assert.match(renderMachineShard(omitted).refused ?? "", new RegExp(CHECK), "and an untyped caller that omits it is refused, never written");
});

// ── The census ────────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

async function flakeIncidentShard(t: TestContext): Promise<string[]> {
  const file = "test/the-census-roster-is-named-not-numbered.test.ts";
  const root = tempRoot(t, "census-flake");
  for (const dir of ["state", join("plan", "tasks.d"), "test"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, file), "");
  const rows = [10271, 10279, 10287].map((pr) => ({
    ts: new Date(NOW).toISOString(), step: "test.flake_retry", file, headline: "recovered on retry", ci_run_id: pr * 10, shard: 2,
    source: "selector-shadow", retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr],
    titles: ["the roster's admitted projection passes on a clean HEAD"],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const landed: string[][] = [];
  const failures: string[] = [];
  await runFlakeIncidentGardener(
    {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW),
      log: (step, extra) => { if (step === "flake_incident.filing_failed") failures.push(String(extra?.error)); },
      openWorkspace: () => ({ root, branch: "flake-1", land: (o: { paths: string[] }) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
    },
    { mintTaskId: () => "W1-T998332", readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "" },
  );
  assert.deepEqual(failures, [], "the flake-incident filing failed");
  assert.equal(landed.length, 1, "the flake-incident gardener filed one record");
  return [readFileSync(join(root, landed[0]![0]!), "utf8")];
}

function flowStageShards(): string[] {
  return ([["ready_to_merged", "minutes"], ["ci_wall_clock", "minutes"], ["fix_rounds", "count"]] as const).map(([stage, unit]) => {
    const stat = {
      key: `plan:${stage}:all`, cls: "plan", stage, surface: "all", unit, regressed: true,
      current: { n: 4, p50: 25, p90: 40 }, baseline: { n: 6, p50: 10, p90: 10, source: "rolling" }, slowest: [{ pr: 1, value: 40 }],
    } as unknown as FlowStageStat;
    const rendered = renderFlowFollowUp(stat, "W1-T998333", [15]);
    assert.equal(rendered.refused, undefined, `flow stage ${stage}: ${rendered.refused}`);
    return rendered.text;
  });
}

/** The open-repair remedy has no exported renderer: the pass files it for two PRs waiting past the bound. */
async function flowFollowUpShard(t: TestContext): Promise<string[]> {
  const root = tempRoot(t, "census-flow");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "sweep.ts"), "// fixture\n");
  const pr = (number: number, ageMs: number, checksState: string, mergeable: string): FlowOpenQueuePr =>
    ({ number, createdAtMs: NOW - ageMs, updatedAtMs: NOW, headSha: `head-${number}`, headRefName: `run-W1-T${number}-1`, checksState, mergeable });
  const census: FlowOpenQueueRead = { ok: true, complete: true, observedAtMs: NOW, windowMs: openQueueWindow(NOW), window: [],
    open: [pr(501, 3 * HOUR, "FAILURE", "MERGEABLE"), pr(502, 2 * HOUR, "SUCCESS", "CONFLICTING")] };
  const landed: string[][] = [];
  const failures: string[] = [];
  const sources: FlowStageSources = {
    readLedger: () => ({ ok: true, rows: [], unread: [] }), readOpenQueue: async () => census, readCi: async () => undefined,
    planTasks: () => [], mintTaskId: () => "W1-T998334",
  };
  const pass = await runFlowGardener({
    stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW),
    log: (step: string, extra: Record<string, unknown> = {}) => { if (step === "flow.filing_failed") failures.push(String(extra.error)); },
    openWorkspace: () => ({ root, branch: "flow-garden-1", land: (o: { paths: string[] }) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/9901"), dispose: () => {} }),
  }, sources);
  assert.deepEqual(failures, [], "the open-repair filing failed");
  assert.deepEqual(pass.filed, ["open-repair-wait"]);
  return [readFileSync(join(root, landed[0]![0]!), "utf8")];
}

function flowRemedyShards(): string[] {
  const action = { class: "draft", target: "x", origin: "flow-blocker:own-red:required checks red", rung: 1, reason: "r", population: [3],
    charges: [{ pr: 7, key: "own-red:required checks red", start: 0, end: 1, hours: 3, reason: "required checks red", owner: "fix-lane" }],
    price: { key: "own-red:required checks red", hours: 3, prs: 2, owners: ["fix-lane"] } } as unknown as FlowAction;
  const search = { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 2 }], fileExists: () => true };
  return [draftShard(action, "W1-T998335", search, FLOW_LADDER), draftShard({ ...action, origin: "fix-lane:own-red:fix-lane:required checks red" }, "W1-T998336", search, FIX_LANE_LADDER)];
}

const gateRule = { gate: "census", recognizer: "src/lib/ci-parity.ts", symbol: "censusCandidateWalks",
  ownFiles: ["scripts/census-precheck-parity-baseline.json", "src/lib/rule-suites.ts"], gateRegex: /tree-walk/ };

function gateFalsePositiveShards(): string[] {
  const action = { class: "false-positive", target: "gate-false-positive:census", file: gateRule.recognizer, reason: "fixture",
    edit: { kind: "false-positive", rule: gateRule, classification: "token-dodge",
      observation: { pair: { pr: 10787, gate: "census", redSha: "red", greenSha: "green", state: "repaired", repairFiles: ["test/example.test.ts"] },
        repairDiff: '-const token = "tree-walk";\n+const token = ["tree", "walk"].join("-");' } } } as unknown as GateGardenAction;
  return [checked("gate false-positive", renderFalsePositiveShard(action, "W1-T998337"))];
}

function gateHeadroomShards(): string[] {
  return [
    { gate: "jscpd", field: "threshold", limitFile: ".jscpd.json", measured: 1.9, limit: 2, files: ["src/a.ts"] },
    { gate: "fixture-copy", field: "gitInitSites", limitFile: "scripts/fixture-copy-baseline.json", measured: 11, limit: 11,
      raised: { commit: "abcdef012345", detail: "from 10 to 11" }, files: ["test/copies.test.ts"] },
  ].map((finding) => checked(`gate headroom ${finding.gate}`, renderHeadroomShard(finding, "W1-T998338")));
}

function gateDefuseShards(): string[] {
  const file = "test/some-expiring.test.ts";
  const action = (controlFailed: boolean) => ({
    class: "defuse", target: `expiring-fixture:${file}`, file, reason: "expires soon",
    edit: { kind: "defuse", leadDays: 14, urgent: controlFailed, controlFailed,
      finding: { file, line: 3, stamp: "2026-11-01", field: "stamp", threshold: "30d", expiresAt: Date.parse("2026-12-01T00:00:00Z"), daysLeft: 10 } },
  } as unknown as GateGardenAction);
  return [false, true].map((controlFailed) => checked("gate defuse", renderDefuseShard(action(controlFailed), "W1-T998340")));
}

function checked(name: string, rendered: { text: string; refused?: string }): string {
  assert.equal(rendered.refused, undefined, `${name}: the generator's own lint refused it (${rendered.refused})`);
  return rendered.text;
}

function hostResourceShards(): string[] {
  const filing: ConsumerFiling = {
    host: "azure", device: "root", consumer: "worktrees", origin: "host-resource:azure:worktrees",
    attribution: { consumer: "worktrees", growthKbPerHour: 1024 ** 2, share: 0.8, spanHours: 72, points: 144, janitorPasses: 12 },
  };
  return [consumerShardYaml(filing, "W1-T998341")];
}

function hotFileShards(): string[] {
  const files = ["scripts/test-tier-manifest.json", "scripts/comment-load-baseline.json", "docs/ci-friction-garden-log.md", ".gitignore"];
  assert.deepEqual(files.map((f) => hotFileRemedy(f)), ["generate-in-ci", "split-per-entry", "append-only", "merge-driver"]);
  return files.map((file) => hotFileShardYaml({ file, minutes: 40, rounds: 3, prs: 5, inferredMinutes: 0, recordedMinutes: 40 } as HotFilePrice, "W1-T998342"));
}

function scoutShards(): string[] {
  const symptom = (files: string[]) => ({ step: "review.parse_failed", older: 2, newer: 3, total: 5, files });
  return [symptom(["src/lib/review.ts"]), symptom([])].map((s) => checked("scout", scoutShard(s, "W1-T998343", [1, 5])));
}

const MISS = { runId: 1, headSha: "abc", selection: "narrow" as const, file: "test/prompt-render.test.ts" };

function ciLearningDraft(over: Partial<CiLearningShardDraft> = {}): CiLearningShardDraft {
  return {
    findingId: "ci-learning:4283:coverage-ratchet",
    title: "THE coverage-ratchet GATE WENT RED ON #4283 AND WAS REPAIRED — carry the lesson to the lane that hit it",
    gate: "coverage-ratchet", prs: [4283], dominantRepairFiles: [], pr: 4283, repairFiles: ["src/lib/rule-efficacy.ts"],
    author_class: "machine", verify: "human", remedySurface: "learnings/*.yaml", ...over,
  } as CiLearningShardDraft;
}

interface CensusMember {
  /** The generator, as the task's acceptance names it. */
  name: string;
  /** The module that holds its call site, and the shared writer it calls there. */
  module: string;
  writer: "renderMachineShard" | "machineShardHeaderLines";
  render: (t: TestContext) => string[] | Promise<string[]>;
}

/** One member per call site of the shared writer. A new call site needs a member here, and a declaration there. */
const CENSUS: readonly CensusMember[] = [
  { name: "ci-friction", module: "src/lib/ci-friction-gardener.ts", writer: "renderMachineShard", render: () =>
    [["check", "ci-log:coverage-ratchet"], ["fix_refusal", "census-precheck"]].map(([kind, name]) => ciFrictionShardYaml({
      price: { cause: { kind, name }, minutes: 1441, rounds: 457, prs: 291 }, rung: 1, owner: { files: ["src/lib/ci-parity.ts"], why: ["a"] }, rounds: [],
    } as unknown as CiFrictionDraft, "W1-T998331")) },
  { name: "flake-incident", module: "src/lib/flake-incident-gardener.ts", writer: "renderMachineShard", render: flakeIncidentShard },
  { name: "flow stage", module: "src/lib/flow-gardener.ts", writer: "renderMachineShard", render: flowStageShards },
  { name: "flow follow-up", module: "src/lib/flow-gardener.ts", writer: "renderMachineShard", render: flowFollowUpShard },
  { name: "flow-remedy", module: "src/lib/flow-remedy-gardener.ts", writer: "renderMachineShard", render: flowRemedyShards },
  { name: "gate false-positive", module: "src/lib/gate-gardener.ts", writer: "renderMachineShard", render: gateFalsePositiveShards },
  { name: "gate headroom", module: "src/lib/gate-gardener.ts", writer: "renderMachineShard", render: gateHeadroomShards },
  { name: "gate comment-compression", module: "src/lib/gate-gardener.ts", writer: "renderMachineShard", render: () =>
    [checked("gate comment-compression", renderCommentCompressionShard({ file: "src/lib/sweep.ts", comments: 900 }, "W1-T998339"))] },
  { name: "gate defuse", module: "src/lib/gate-gardener.ts", writer: "renderMachineShard", render: gateDefuseShards },
  { name: "host-resource", module: "src/lib/host-resource-gardener.ts", writer: "renderMachineShard", render: hostResourceShards },
  { name: "hot-file", module: "src/lib/hot-file-gardener.ts", writer: "renderMachineShard", render: hotFileShards },
  { name: "scout", module: "src/lib/scout-gardener.ts", writer: "renderMachineShard", render: scoutShards },
  { name: "selector-shadow miss", module: "src/lib/selector-shadow-gardener.ts", writer: "machineShardHeaderLines", render: () =>
    [selectorShadowMissTask(MISS, "W1-T998344", ["src/run-task.ts"]), selectorShadowMissTask(MISS, "W1-T998344")] },
  { name: "selector-shadow structural", module: "src/lib/selector-shadow-gardener.ts", writer: "machineShardHeaderLines", render: () =>
    [selectorShadowStructuralTask(MISS.file, "W1-T998345", ["src/run-task.ts -> test/prompt-render.test.ts"], "W1-T998344")] },
  { name: "CI-learning draft", module: "src/lib/measurement-cadence.ts", writer: "machineShardHeaderLines", render: () =>
    [ciLearningShardYaml(ciLearningDraft(), "W1-T998346", [1])] },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** `<module>:<writer>` to the number of times the module calls that writer, the writer's own module left out. */
function writerCallSites(): Record<string, number> {
  const sites: Record<string, number> = {};
  const files = sourceFiles(join(REPO_ROOT, "src"));
  assert.ok(files.length > 100, `the scan read only ${files.length} source files`);
  for (const path of files) {
    const module = relative(REPO_ROOT, path).replaceAll("\\", "/");
    if (module === "src/lib/machine-filing.ts") continue;
    for (const call of readFileSync(path, "utf8").matchAll(/\b(renderMachineShard|machineShardHeaderLines)\(/g)) {
      sites[`${module}:${call[1]}`] = (sites[`${module}:${call[1]}`] ?? 0) + 1;
    }
  }
  return sites;
}

test("W1-T12833 criterion 3: one record from every machine generator passes the changed-task lint, and every writer call site is a named member", async (t) => {
  assert.deepEqual(CENSUS.map((m) => m.name), [
    "ci-friction", "flake-incident", "flow stage", "flow follow-up", "flow-remedy", "gate false-positive", "gate headroom",
    "gate comment-compression", "gate defuse", "host-resource", "hot-file", "scout", "selector-shadow miss",
    "selector-shadow structural", "CI-learning draft",
  ]);
  const refused: string[] = [];
  for (const member of CENSUS) {
    let records: string[];
    try {
      records = await member.render(t);
    } catch (error) {
      refused.push(`${member.name}: ${String((error as Error)?.message ?? error)}`);
      continue;
    }
    assert.ok(records.length > 0, `${member.name} rendered no record`);
    for (const [index, text] of records.entries()) {
      const task = loadPlanFromYaml(text, `${member.name}.yaml`).tasks[0]!;
      assert.equal(task.author_class, "machine", `${member.name} renders a machine record`);
      assert.equal(task.type, "implement", `${member.name} renders an implementation task, the type the rule reads`);
      assert.match(task.design ?? "", /^[ \t]*(?:INVARIANT [a-z0-9-]+|NO-INVARIANTS): \S/m, `${member.name} declares one form`);
      const blocks = blocking(text, `${task.id}.yaml`);
      if (blocks.length > 0) refused.push(`${member.name} #${index + 1}: ${blocks.join("; ")}`);
      assert.equal(machineShardLintRefusal(text, `${task.id}.yaml`) === undefined, blocks.length === 0, `${member.name}: the shared lint and the census agree`);
      // An invariant's grep proof names a new test's own line. A bare helper name already matches in a pin test an
      // earlier task wrote, and a proof that matches at base is refused once the record is released to verify: auto.
      for (const claim of (task.acceptance ?? []).filter((c) => /^invariant:/.test(c.claim ?? "") && /^grep:/.test(c.proof ?? ""))) {
        assert.match(claim.proof!, /^grep: test\("/, `${member.name}: an invariant's grep proof anchors on a test( line the build adds`);
      }
    }
  }
  assert.deepEqual(refused, [], "every generator's record passes the lint the plan PR preflight applies");

  const expected: Record<string, number> = {};
  for (const member of CENSUS) expected[`${member.module}:${member.writer}`] = (expected[`${member.module}:${member.writer}`] ?? 0) + 1;
  const found = writerCallSites();
  assert.equal(Object.values(found).reduce((a, b) => a + b, 0), 15, "positive control: the scan saw the fifteen call sites this census names");
  assert.deepEqual(found, expected, "a module that calls the shared writer has one census member per call site: add the member and its declaration together");
});

// ── A refused record is never written ─────────────────────────────────────────────────────────

/** A record the generator would write, with its declaration taken out again. */
function undeclared(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const design = /^ {2}design: (".*")$/.exec(line);
    if (design) {
      const rest = (JSON.parse(design[1]!) as string).split("\n").filter((l) => !/^[ \t]*(?:INVARIANT |NO-INVARIANTS:)/.test(l)).join("\n");
      if (rest !== "") kept.push(`  design: ${JSON.stringify(rest)}`);
      continue;
    }
    // An invariant claim's proof is the line after it.
    if (/^ {4}- claim: "invariant:/.test(line)) { i++; continue; }
    kept.push(line);
  }
  assert.notEqual(kept.join("\n"), text, "the fixture removed a declaration");
  return kept.join("\n");
}

test("W1-T12833 criterion 4: a record the shared lint refuses is not written or landed, and the filer logs the refused check", (t) => {
  const root = tempRoot(t, "census-refused");
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "sweep.ts"), "export {};\n");
  const now = Date.UTC(2026, 9, 6, 12);
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", pr_number: 1, ts: new Date(now - 2 * HOUR).toISOString(), blocker: "own-red", reason: "required checks red", blocker_owner: "fix-lane" },
    { step: "sweep.disposed", pr_number: 1, ts: new Date(now).toISOString(), blocker: "own-red", reason: "required checks red", blocker_owner: "fix-lane" },
  ];
  const search = { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 1 }], fileExists: (path: string) => path === "src/lib/sweep.ts" };
  const sources = (draft?: FlowGardenSources["draftShard"]): FlowGardenSources => ({
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T998347", ledgerRecords: () => records, planState: () => ({ tasks: [] }),
    prOutcomes: () => new Map([[1, { state: "closed" as const, at: new Date(now).toISOString() }]]), ownerSearch: search,
    ...(draft ? { draftShard: draft } : {}),
  });
  const landed: string[][] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: join(root, "state"), clock: fixedClock(now), seed: 1,
    log: (step, extra) => { events.push({ step, extra }); },
    openWorkspace: () => ({ root, branch: "flow-garden-1", land: (o) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
  };
  const shards = () => (existsSync(join(root, "plan", "tasks.d")) ? readdirSync(join(root, "plan", "tasks.d")) : []);

  // The generator's own draft, with its declaration removed: the default lint admits it, the shared lint does not.
  const refusedDraft: NonNullable<FlowGardenSources["draftShard"]> = (action, taskId) => undeclared(draftShard(action, taskId, search, FLOW_LADDER));
  runGarden(flowGardenSpec(deps, sources(refusedDraft)), deps);
  assert.deepEqual(shards(), [], "the refused record never reaches the plan");
  assert.deepEqual(landed, [], "and is never handed to the landing");
  const failure = events.find((e) => e.step === "flow-remedy.garden_filing_failed");
  assert.match(String(failure?.extra?.reason), new RegExp(`failed lint \\(block:${CHECK}`), `the filer logs the refused check (events: ${events.map((e) => e.step).join(", ")})`);

  // Control: the same pass with the generator's declared draft writes and lands it.
  const cleanRoot = tempRoot(t, "census-admitted");
  mkdirSync(join(cleanRoot, "src", "lib"), { recursive: true });
  mkdirSync(join(cleanRoot, "state"), { recursive: true });
  writeFileSync(join(cleanRoot, "src", "lib", "sweep.ts"), "export {};\n");
  const cleanLanded: string[][] = [];
  const cleanDeps: GardenerDeps = { ...deps, repoRoot: cleanRoot, stateDir: join(cleanRoot, "state"), log: () => {},
    openWorkspace: () => ({ root: cleanRoot, branch: "flow-garden-2", land: (o) => (cleanLanded.push(o.paths), "https://github.com/acme/remudero/pull/2"), dispose: () => {} }) };
  runGarden(flowGardenSpec(cleanDeps, sources()), cleanDeps);
  assert.equal(cleanLanded.length, 1, "the declared draft lands");
  assert.deepEqual(blocking(readFileSync(join(cleanRoot, cleanLanded[0]![0]!), "utf8"), "W1-T998347.yaml"), []);

  // The CI-learning filer refuses the same way: the reason is recorded and nothing is written.
  const written: string[] = [];
  const fs = { mkdirSync: () => undefined, writeFileSync: (path: string) => void written.push(path) };
  const out = fileCiLearningShards([ciLearningDraft({ gate: "invariant:unmapped-slug" })], "/wt", { mintTaskId: () => "W1-T998348", fs, join: (...p) => p.join("/"), planOrigins: [] });
  assert.deepEqual(written, [], "the refused CI-learning record never reaches the disk");
  assert.equal(out.filed.length, 0);
  assert.match(out.refused[0]?.reason ?? "", new RegExp(`block:${CHECK}`));
});

test("W1-T12833 criterion 5: the selector-shadow templates and the CI-learning draft pass the same shared lint before they are written", async (t) => {
  // Each hand-assembled template's own text passes the shared lint, and fails it once its declaration is removed.
  const templates: Array<[string, string]> = [
    ["selector-shadow miss", selectorShadowMissTask(MISS, "W1-T998349", ["src/run-task.ts"])],
    ["selector-shadow structural", selectorShadowStructuralTask(MISS.file, "W1-T998350", ["src/run-task.ts -> test/prompt-render.test.ts"], "W1-T998349")],
    ["CI-learning draft", ciLearningShardYaml(ciLearningDraft(), "W1-T998351", [1])],
  ];
  for (const [name, text] of templates) {
    assert.equal(machineShardLintRefusal(text, `${name}.yaml`), undefined, `${name} passes the shared lint`);
    assert.match(machineShardLintRefusal(undeclared(text), `${name}.yaml`) ?? "", new RegExp(CHECK), `${name} without its declaration is refused`);
  }

  // The CI-learning verdict is the shared lint: it refuses the draft the default lint admitted.
  const bare = undeclared(templates[2]![1]);
  assert.equal(lintTask(loadPlanFromYaml(bare, "bare.yaml").tasks[0]!).ok, true, "control: the default lint admits the undeclared draft");
  assert.match(ciLearningRecordVerdict(bare, "ci-learning:W1-T998351").reason, new RegExp(`block:${CHECK}`));
  assert.deepEqual(ciLearningRecordVerdict(templates[2]![1], "ci-learning:W1-T998351"), { ok: true, reason: "" });
  const written = new Map<string, string>();
  const fs = { mkdirSync: () => undefined, writeFileSync: (path: string, data: string) => void written.set(path, data) };
  const filed = fileCiLearningShards([ciLearningDraft()], "/wt", { mintTaskId: () => "W1-T998352", fs, join: (...p) => p.join("/"), planOrigins: [] });
  assert.deepEqual(filed.refused, []);
  assert.deepEqual([...written.values()].map((text) => blocking(text, "W1-T998352.yaml")), [[]], "the written CI-learning record passes the changed-task lint");

  // The selector-shadow pass lints the template's final text before it writes it into the filing checkout.
  const pass = async (changedPaths: string[], taskId: string) => {
    const root = tempRoot(t, "census-selector");
    for (const dir of ["test", "state", join("plan", "tasks.d"), join("src", "lib")]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
    writeFileSync(join(root, "src", "lib", "affected-suites.ts"), "// fixture\n");
    writeFileSync(join(root, "test", "the-affected-suite-selector-runs-in-shadow.test.ts"), "// fixture\n");
    const landed: string[][] = [];
    const log = Array.from({ length: 8 }, (_, i) =>
      `coverage-shard (${i + 1}/8)\tAFFECTED-SUITES-SHADOW: ${JSON.stringify({
        fullRun: false, floorSize: 1, narrowSize: 0, failures: i === 0 ? [{ file: "test/cold.test.ts", floor: "selected", narrow: "missed" }] : [],
      })}\ncoverage-shard (${i + 1}/8)\tSELECTOR-SHADOW-JOB: conclusion=${i === 0 ? "failure" : "success"}`).join("\n");
    const deps = {
      stateDir: join(root, "state"), repoRoot: root, log: () => {},
      // The landing guard stands aside, so only the pass's own lint can refuse the record.
      landingRefusal: () => undefined,
      openWorkspace: () => ({ root, branch: "selector-1", land: (o: { paths: string[] }) => (landed.push(o.paths), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
    };
    const run = runSelectorShadowGardener(deps, () => [{ id: 1, headSha: "head-1", prNumber: 1, log }], () => changedPaths, () => taskId, () => []);
    return { run, landed, shards: () => readdirSync(join(root, "plan", "tasks.d")), root };
  };
  const admitted = await pass(["src/lib/status.ts"], "W1-T998353");
  await admitted.run;
  assert.equal(admitted.landed.length, 1, "the declared selector edge is written and landed");
  assert.deepEqual(blocking(readFileSync(join(admitted.root, admitted.landed[0]![0]!), "utf8"), "W1-T998353.yaml"), []);

  // A recorded edge whose text adds an INVARIANT line no claim maps: the default lint admits it, the shared lint does not.
  const smuggled = await pass(["src/lib/status.ts\nINVARIANT unmapped-edge: no claim proves this"], "W1-T998354");
  await assert.rejects(smuggled.run, new RegExp(`refused by lint \\(${CHECK}`));
  assert.deepEqual(smuggled.shards(), [], "the refused record was never written into the filing checkout");
  assert.deepEqual(smuggled.landed, []);
});
