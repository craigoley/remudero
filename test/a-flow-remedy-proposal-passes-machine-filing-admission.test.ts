/**
 * W1-T5995: the flow-remedy gardener (W1-T5538) files a verify:human machine shard naming its owning source
 * file and the regression test its build writes. Machine-filing admission parked only the ci-friction
 * origin's version of that shape, and the gardener checked its draft without admission, so #9505 opened
 * red on 2026-10-06 and stayed red. Admission now parks the flow-blocker shape, and the gardener runs it
 * before writing, so a draft admission refuses is a failed garden pass, never a red PR.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { flowGardenSpec, type FlowGardenSources } from "../src/lib/flow-remedy-gardener.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import { loadPlanFromYaml, machineFilingAdmissionViolations } from "../src/lib/plan.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { lintTask } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.UTC(2026, 9, 6, 12);
const HOUR = 3_600_000;

/** The shard #9505 filed, verbatim but for its rationale. */
const PR_9505_SHARD = [
  "- id: W1-T5984",
  '  title: "THE FLOW GARDENER\'S COSTLIEST UNOWNED BLOCKER — own-red:required checks red cost 12.19 PR-hours"',
  "  repo: remudero",
  "  depends_on: []",
  "  type: implement",
  "  verify: human",
  "  risk: low",
  "  priority: 1",
  "  status: queued",
  "  attempts: 0",
  "  author_class: machine",
  '  origin: "flow-blocker:own-red:required checks red"',
  "  files:",
  "    - src/lib/sweep.ts",
  "    - test/flow-own-red-required-checks-red.test.ts",
  "  acceptance:",
  '    - claim: "own-red:required checks red is cleared by its owner without manual intervention"',
  '      proof: "grep: test(\\"W1-T5984: flow-own-red-required-checks-red clears without a person\\" in test/flow-own-red-required-checks-red.test.ts"',
  '  note: "Filed by flow at rung 1; measure the cause\'s share of PR-hours after the build merges."',
  "  rationale: |",
  "    own-red:required checks red cost 12.19 PR-hours; owner fix-lane",
  "",
].join("\n");

function admit(yaml: string, pathExists = (p: string) => existsSync(join(REPO_ROOT, p))): string[] {
  const plan = loadPlanFromYaml(yaml, "flow-remedy-fixture");
  return machineFilingAdmissionViolations(plan.tasks[0]!, { plan, releasedIds: new Set(), pathExists });
}

function row(pr: number, hours: number): LedgerRecord {
  return { step: "sweep.disposed", pr_number: pr, ts: fixedClock(NOW + hours * HOUR).iso(), blocker: "escalated", reason: "metadata-only body red", blocker_owner: "NONE" };
}

function gardener(root: string, fileExists: (path: string) => boolean) {
  const deps: GardenerDeps = {
    repoRoot: root, stateDir: root, clock: fixedClock(NOW), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); },
  };
  const sources: FlowGardenSources = {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T9001",
    ledgerRecords: () => [row(1, -4), row(1, 0), row(2, -3), row(2, 0)], planState: () => ({ tasks: [] }), prOutcomes: () => new Map(),
    ownerSearch: { filesContaining: () => [{ file: "src/lib/sweep.ts", hits: 3 }], fileExists },
  };
  const spec = flowGardenSpec(deps, sources);
  const inv = spec.inventory();
  const plan = { actions: spec.candidates(inv, () => 0), acting: ["draft" as const] };
  const workspace = { root, branch: "flow-remedy-garden-123", land: () => { throw new Error("unexpected landing"); }, dispose: () => {} };
  return { apply: () => spec.apply(workspace, plan, {}) };
}

test("the shard #9505 filed is admitted as a parked flow-remedy proposal", () => {
  assert.equal(existsSync(join(REPO_ROOT, "test/flow-own-red-required-checks-red.test.ts")), false, "its regression test is written by the build");
  assert.deepEqual(admit(PR_9505_SHARD), []);
});

test("a flow-blocker shard is admitted only in the remedy shape: owning source plus new tests", () => {
  const docsOnly = PR_9505_SHARD.replace("    - src/lib/sweep.ts\n", "    - docs/flow.md\n");
  assert.match(admit(docsOnly).join("; "), /verify:human — not auto-runnable/);
  const inventedSource = PR_9505_SHARD.replace("src/lib/sweep.ts", "src/lib/no-such-module.ts");
  assert.match(admit(inventedSource).join("; "), /exist in neither the checkout nor the base tree: src\/lib\/no-such-module\.ts$/);
  const otherOrigin = PR_9505_SHARD.replace('"flow-blocker:', '"flowish:');
  assert.match(admit(otherOrigin).join("; "), /verify:human — not auto-runnable/);
});

test("the gardener's draft passes the same lint CI runs, admission included", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-admit-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const landing = gardener(root, (path) => path === "src/lib/sweep.ts").apply()!;
  const text = readFileSync(join(root, landing.paths[0]!), "utf8");
  const plan = loadPlanFromYaml(text, "flow draft");
  const lint = lintTask(plan.tasks[0]!, {
    machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(REPO_ROOT, p)) },
  });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block").map((v) => `${v.check}: ${v.message}`), []);
});

test("the gardener refuses, before writing, a draft that admission refuses", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-admit-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => gardener(root, () => false).apply(), /machine-filing-admission: .*src\/lib\/sweep\.ts/);
  assert.equal(existsSync(join(root, "plan", "tasks.d")) ? readdirSync(join(root, "plan", "tasks.d")).length : 0, 0, "a refused draft writes nothing");
});
