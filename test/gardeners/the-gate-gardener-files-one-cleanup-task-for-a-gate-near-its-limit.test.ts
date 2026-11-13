import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { applyGateActions, baselineRaises, gateGardenSpec, headroomOrigin, loadGateProbes, renderHeadroomShard, type GateGardenAction, type GateProbes } from "#src/lib/gate-gardener.js";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { machineShardFilingRefusal } from "#src/lib/machine-filing.js";
import type { GardenCheckout, GardenerDeps } from "#src/lib/gardener.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const probes: GateProbes = await loadGateProbes(REPO_ROOT);
const DAY_MS = 86_400_000;
const duplicated = Array.from({ length: 40 }, (_, i) => `export function f${i}(a: number, b: number): number { const c = a * ${i} + b; return c - ${i}; }`).join("\n") + "\n";
const unique = Array.from({ length: 10 }, (_, i) => `export const unique${i} = ${i} * 3;`).join("\n") + "\n";
const LEARNINGS = "- id: alpha\n  fact: The first fact in this fixture corpus.\n  lifecycle: active\n- id: beta\n  fact: A second, longer fact that weighs more in the fixture corpus.\n  lifecycle: active\n";

/** A repo with every input the gate inventory reads. The jscpd fixture measures 44.44% duplication. */
function gateInputs(t: TestContext, { jscpdThreshold = 100, hardCapShare = 2 } = {}): { repo: GitRepo; deps: GardenerDeps; events: Array<{ step: string; extra?: Record<string, unknown> }> } {
  const repo = gitRepo({ scope: t });
  for (const dir of ["src", "scripts", "learnings", "plan/tasks.d", ".github/workflows", "test"]) mkdirSync(join(repo.dir, dir), { recursive: true });
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), "[]\n");
  writeFileSync(join(repo.dir, ".github/workflows/ci-gate.yml"), "jobs:\n  ci-gate:\n    env:\n      REQUIRED: '[]'\n      ADVISORY: '[]'\n");
  writeFileSync(join(repo.dir, "src/a.ts"), duplicated);
  writeFileSync(join(repo.dir, "src/b.ts"), duplicated);
  writeFileSync(join(repo.dir, "src/c.ts"), unique);
  writeFileSync(join(repo.dir, ".jscpd.json"), JSON.stringify({ threshold: jscpdThreshold, minTokens: 50, minLines: 5, format: ["typescript", "javascript"], reporters: ["console"] }, null, 2) + "\n");
  writeFileSync(join(repo.dir, "learnings/platform.yaml"), LEARNINGS);
  const chars = probes.lb.computeActiveChars(probes.lb.loadCorpus(join(repo.dir, "learnings"))).chars;
  // A source-size row the file sits right at: source-size is a signal and refuses nothing, so it is never read.
  writeFileSync(join(repo.dir, "scripts/source-size-baseline.json"), JSON.stringify({ "src/a.ts": 40 }, null, 2) + "\n");
  writeFileSync(join(repo.dir, "scripts/learnings-budget-baseline.json"), JSON.stringify({ measuredChars: chars, measuredActiveEntries: 2, capChars: 1, hardCapChars: Math.ceil(chars * hardCapShare) }, null, 2) + "\n");
  repo.git("add", "."); repo.git("commit", "-qm", "gate inputs");
  const stateDir = join(repo.dir, ".state");
  mkdirSync(stateDir);
  for (const off of ["defuse", "compress", "false-positive"]) writeFileSync(join(stateDir, `GATE_OFF-${off}`), "");
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps = { repoRoot: repo.dir, stateDir, log: (step: string, extra?: Record<string, unknown>) => { events.push({ step, extra }); },
    openWorkspace: () => { throw new Error("unused workspace port"); } } satisfies GardenerDeps;
  return { repo, deps, events };
}

/** The production pass's inventory: the awaited one the daemon runs. */
async function headroomActions(deps: GardenerDeps): Promise<GateGardenAction[]> {
  const spec = gateGardenSpec(deps, probes, { mintTaskId: () => "W1-T999950" });
  return (await spec.inventoryAsync!()).candidates.filter((a) => a.class === "headroom");
}

function queueTask(repo: GitRepo, origin: string, status = "queued"): void {
  writeFileSync(join(repo.dir, "plan/tasks.d/W1-T999940-held.yaml"), [
    "- id: W1-T999940", "  title: \"An open cleanup task\"", "  repo: remudero", "  depends_on: []", "  type: implement",
    `  status: ${status}`, `  origin: ${JSON.stringify(origin)}`, "  files:", "    - src/a.ts", "  acceptance:",
    "    - claim: \"x\"", "      proof: \"unit test: x\"", ""].join("\n"));
  repo.git("add", "."); repo.git("commit", "-qm", `hold ${origin}`);
}

function raiseFixtureCopy(repo: GitRepo): string {
  writeFileSync(join(repo.dir, "scripts/fixture-copy-baseline.json"), JSON.stringify({ gitInitSites: 10, ledgerHelperNames: 51 }, null, 2) + "\n");
  writeFileSync(join(repo.dir, "scripts/console-parity-baseline.json"), JSON.stringify({ _comment: "fixture", uncoveredVerbs: ["audit", "board"] }, null, 2) + "\n");
  writeFileSync(join(repo.dir, "scripts/deps-interface-baseline.json"), JSON.stringify({ depsInterfaceCount: 160 }, null, 2) + "\n");
  repo.git("add", "."); repo.git("commit", "-qm", "record the exact-count baselines");
  writeFileSync(join(repo.dir, "test/copies.test.ts"), "// a hand-built fixture\n");
  writeFileSync(join(repo.dir, "scripts/fixture-copy-baseline.json"), JSON.stringify({ gitInitSites: 10, ledgerHelperNames: 52 }, null, 2) + "\n");
  writeFileSync(join(repo.dir, "scripts/deps-interface-baseline.json"), JSON.stringify({ depsInterfaceCount: 159 }, null, 2) + "\n");
  repo.git("add", "."); repo.git("commit", "-qm", "a test copies a ledger helper");
  return repo.git("rev-parse", "HEAD");
}

test("W1-T12512 criterion 1: a pass proposes HEADROOM for a refusing ratchet within 10% of its limit, and never reads a source-size row", async (t) => {
  const far = gateInputs(t);
  assert.equal((await headroomActions(far.deps)).length, 0, "44.44% under a threshold of 100 and a corpus at half its hard cap have headroom; the source-size row at its limit is not read");

  const jscpd = gateInputs(t, { jscpdThreshold: 48 });
  const [dup] = await headroomActions(jscpd.deps);
  assert.equal(dup?.target, "headroom:jscpd:threshold:48");
  assert.equal(dup?.edit.kind === "headroom" && dup.edit.finding.measured, 44.44);
  assert.deepEqual(dup?.edit.kind === "headroom" && dup.edit.finding.files, ["src/a.ts"]);

  const over = gateInputs(t, { jscpdThreshold: 40 });
  assert.equal((await headroomActions(over.deps))[0]?.target, "headroom:jscpd:threshold:40", "a ratchet already over its limit is near it too");

  const learnings = gateInputs(t, { hardCapShare: 1.05 });
  const [cap] = await headroomActions(learnings.deps);
  assert.equal(cap?.edit.kind === "headroom" && cap.edit.finding.gate, "learnings-budget");
  assert.equal(cap?.edit.kind === "headroom" && cap.edit.finding.field, "hardCapChars", "capChars is a curation target; the cap that refuses is hardCapChars");
  assert.deepEqual(cap?.edit.kind === "headroom" && cap.edit.finding.files, ["learnings/platform.yaml"]);

  writeFileSync(join(learnings.deps.stateDir, "GATE_OFF-headroom"), "");
  assert.equal((await headroomActions(learnings.deps)).length, 0, "the class has an off switch");
});

test("W1-T12512 criterion 2: a pass proposes HEADROOM for an exact-count row a commit on main raised in the last 7 days", async (t) => {
  const { repo, deps } = gateInputs(t);
  const raise = raiseFixtureCopy(repo);
  const [row] = await headroomActions(deps);
  assert.equal(row?.target, "headroom:fixture-copy:ledgerHelperNames:52");
  assert.deepEqual(row?.edit.kind === "headroom" && row.edit.finding.raised, { commit: raise.slice(0, 12), detail: "from 51 to 52" });
  assert.deepEqual(row?.edit.kind === "headroom" && row.edit.finding.files, ["test/copies.test.ts"], "one subject file, never another baseline");

  const later = { ...deps, clock: fixedClock(systemClock.now() + 8 * DAY_MS) };
  assert.equal((await headroomActions(later)).length, 0, "a raise older than the window proposes nothing");

  writeFileSync(join(repo.dir, "scripts/console-parity-baseline.json"), JSON.stringify({ _comment: "fixture", uncoveredVerbs: ["audit", "board", "zeta"] }, null, 2) + "\n");
  writeFileSync(join(repo.dir, "scripts/fixture-copy-baseline.json"), JSON.stringify({ gitInitSites: 10, ledgerHelperNames: 50 }, null, 2) + "\n");
  repo.git("add", "."); repo.git("commit", "-qm", "a verb with no console route; the ledger copy is removed");
  const [verb, ...rest] = await headroomActions(deps);
  assert.equal(verb?.target, "headroom:console-parity:uncoveredVerbs:3", "a listed set that grew is a raise; a raise undone since is not");
  assert.equal(rest.length, 0);

  const log = "commit abcdef1234567\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2 +2 @@\n-  \"depsInterfaceCount\": 160,\n+  \"depsInterfaceCount\": 159,\n";
  assert.equal(baselineRaises(log, { depsInterfaceCount: 159 }).length, 0, "a row that fell is no raise");
});

test("W1-T12512 criterion 3: HEADROOM files one plan task per gate and row, names the value, limit and commit, and files nothing while one is open", async (t) => {
  const { repo, deps, events } = gateInputs(t);
  const raise = raiseFixtureCopy(repo);
  const spec = gateGardenSpec(deps, probes, { mintTaskId: () => "W1-T999951" });
  const actions = (await spec.inventoryAsync!()).candidates.filter((a) => a.class === "headroom");
  assert.equal(actions.length, 1, "one finding per pass");
  const workspace = { root: repo.dir, branch: "run-unfiled-1794600000000", land: () => "https://github.com/fixture/gates/pull/9" } as unknown as GardenCheckout;
  const plan = { acting: ["headroom" as const], actions };
  const ids = await spec.prepare!(workspace, plan, true);
  const result = spec.apply(workspace, plan, {}, ids)!;
  assert.deepEqual(result.paths, ["plan/tasks.d/W1-T999951-headroom-fixture-copy-ledgerHelperNames.yaml"]);
  const text = readFileSync(join(repo.dir, result.paths[0]!), "utf8");
  const task = parse(text)[0];
  assert.equal(task.origin, "headroom:fixture-copy:ledgerHelperNames:52");
  assert.equal(task.priority, 1);
  assert.equal(task.author_class, "machine");
  assert.match(task.rationale, /Measured 52 against the limit 52/);
  assert.match(task.rationale, new RegExp(`Commit ${raise.slice(0, 12)} on main raised it from 51 to 52`));
  assert.equal(spec.landingRefusal!(repo.dir, result.paths), undefined, "the filed shard passes machine-filing admission");
  assert.equal(workspace.land(result), "https://github.com/fixture/gates/pull/9");
  assert.deepEqual(events.find((e) => e.step === "gate_garden.headroom_filed")?.extra, { origin: task.origin, measured: 52, limit: 52, commit: raise.slice(0, 12) });

  repo.git("add", "."); repo.git("commit", "-qm", "the filing lands");
  assert.equal((await headroomActions(deps)).length, 0, "an open task with the origin holds it: a second pass files nothing");
  assert.ok(events.some((e) => e.step === "gate_garden.headroom_held" && e.extra?.origin === task.origin));
  queueTask(repo, task.origin, "done");
  repo.git("rm", "-q", result.paths[0]!); repo.git("commit", "-qm", "the cleanup task is done");
  assert.equal((await headroomActions(deps))[0]?.target, task.origin, "a done task holds nothing");
  queueTask(repo, headroomOrigin({ gate: "fixture-copy", field: "ledgerHelperNames", limit: 52 }), "blocked");
  assert.equal((await headroomActions(deps)).length, 0, "a blocked task is still open");

  for (const finding of [
    { gate: "jscpd", field: "threshold", limitFile: ".jscpd.json", measured: 1.9, limit: 2, files: ["src/a.ts"] },
    { gate: "learnings-budget", field: "hardCapChars", limitFile: "scripts/learnings-budget-baseline.json", measured: 120000, limit: 126000, files: ["learnings/platform.yaml"] },
  ]) {
    const rendered = renderHeadroomShard(finding, "W1-T999952");
    assert.equal(rendered.refused, undefined);
    const source = `plan/tasks.d/W1-T999952-headroom-${finding.gate}-${finding.field}.yaml`;
    assert.equal(machineShardFilingRefusal(rendered.text, source, { pathExists: (p) => finding.files.includes(p) }), undefined, `${finding.gate} files through admission`);
  }
  const subjectTest = renderHeadroomShard({ gate: "fixture-copy", field: "gitInitSites", limitFile: "scripts/fixture-copy-baseline.json", measured: 11, limit: 11, files: ["test/copies.test.ts"] }, "W1-T999954");
  const shardPath = "plan/tasks.d/W1-T999954-headroom-fixture-copy-gitInitSites.yaml";
  assert.deepEqual(parse(subjectTest.text)[0].files, ["test/copies.test.ts"], "a test subject carries the regression itself");
  assert.equal(machineShardFilingRefusal(subjectTest.text, shardPath, { pathExists: (p) => p === "test/copies.test.ts" }), undefined);
  assert.match(machineShardFilingRefusal(subjectTest.text, shardPath, { pathExists: () => false }) ?? "", /exist in neither/, "the subject test must exist");
  assert.match(machineShardFilingRefusal(subjectTest.text.replace("    - test/copies.test.ts", "    - docs/notes.md\n    - test/copies.test.ts"), shardPath, { pathExists: () => true }) ?? "",
    /machine-filing-admission/, "a draft outside the headroom shape is refused");
});

test("W1-T12512 criterion 4: a HEADROOM action edits no baseline or ceiling, and its task asks to lower the measured value", async (t) => {
  const { repo, deps } = gateInputs(t, { jscpdThreshold: 48 });
  raiseFixtureCopy(repo);
  const before = ["scripts/fixture-copy-baseline.json", ".jscpd.json", "scripts/learnings-budget-baseline.json"].map((p) => readFileSync(join(repo.dir, p), "utf8"));
  const spec = gateGardenSpec(deps, probes, { mintTaskId: () => "W1-T999953" });
  const actions = (await spec.inventoryAsync!()).candidates.filter((a) => a.class === "headroom");
  const workspace = { root: repo.dir, branch: "run-unfiled-1794600000001", land: () => "https://github.com/fixture/gates/pull/10" } as unknown as GardenCheckout;
  const result = spec.apply(workspace, { acting: ["headroom"], actions }, {}, await spec.prepare!(workspace, { acting: ["headroom"], actions }, true))!;
  assert.equal(result.paths.length, 1);
  assert.match(result.paths[0]!, /^plan\/tasks\.d\//, "the only path written is the plan task");
  assert.deepEqual(["scripts/fixture-copy-baseline.json", ".jscpd.json", "scripts/learnings-budget-baseline.json"].map((p) => readFileSync(join(repo.dir, p), "utf8")), before);
  const task = parse(readFileSync(join(repo.dir, result.paths[0]!), "utf8"))[0];
  assert.match(task.rationale, /Lower the measured value/);
  assert.match(task.rationale, /Do not raise the limit, the baseline or the ceiling/);
  assert.match(task.acceptance[0].claim, /measures below 52 and no limit, baseline or ceiling is raised/);
  assert.throws(() => applyGateActions(repo.dir, actions, "## Pass", probes), /follow-up actions require machine filing/);
});
