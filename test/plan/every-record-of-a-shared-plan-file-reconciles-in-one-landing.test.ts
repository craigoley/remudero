import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { buildPlanReconcileCadenceInput, planReconcileCadence, type PlanReconcileLint } from "#src/lib/measurement-cadence.js";
import { readPlanShards } from "#src/lib/plan-reconcile.js";

/**
 * W1-T15048. A file of plan/tasks.d can hold several records (W1-T9958's file holds W1-T9959 and W1-T9960). The
 * cadence landed one write per record keyed to the shared path, so the last flip of the file won, and the lint hold
 * mapped the path to its last record only. W1-T11183 (#21054) then skipped such files. Every flip of one file is now
 * composed into one replacement text, landed as one input, and that composed text is what the lint hold checks.
 */

const record = (id: string, status: string, lead: "id" | "repo" = "id") => lead === "id"
  ? `- id: ${id}\n  title: "fixture ${id}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`
  : `- repo: remudero\n  title: "fixture ${id}"\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  id: ${id}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`;

const SHARED = "W1-T4-holds-three.yaml";

function fixturePlanDir(t: { after: (fn: () => void) => void }): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15048-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "plan", "tasks.d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(dir, "W1-T1-alone.yaml"), record("W1-T1", "queued"));
  // W1-T4 already reads merged; W1-T5 opens with `- id:` and W1-T6 opens with another key.
  writeFileSync(join(dir, SHARED), "# a file holding three records\n" + record("W1-T4", "merged") + record("W1-T5", "queued") + record("W1-T6", "queued", "repo"));
  return { root, dir };
}

const statuses = (text: string) => Object.fromEntries((parseYaml(text) as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]));

test("W1-T15048 criterion 1: every record of a shared shard lands in one composed input", (t) => {
  const { root, dir } = fixturePlanDir(t);
  const before = readFileSync(join(dir, SHARED), "utf8");
  const linted: Array<{ only: string[]; status: Record<string, string | undefined> }> = [];
  const lint: PlanReconcileLint = (plan, only) => {
    linted.push({ only: [...only].sort(), status: Object.fromEntries(plan.tasks.filter((task) => only.has(task.id)).map((task) => [task.id, task.status])) });
    return new Map();
  };
  const landed: Array<Array<{ relPath: string; content: string; edit?: (current: string) => string | undefined }>> = [];
  const opts = buildPlanReconcileCadenceInput({
    checkoutRoot: root,
    readShards: () => readPlanShards(dir),
    creditedMergedIds: () => new Set(["W1-T1", "W1-T4", "W1-T5", "W1-T6"]),
    land: (inputs) => { landed.push([...inputs]); },
    lint,
  });
  const result = planReconcileCadence(opts);

  assert.equal(result.status, "landed", JSON.stringify(result));
  assert.deepEqual([...result.taskIds].sort(), ["W1-T1", "W1-T5", "W1-T6"], "THE CLAIM: both queued records of the shared file are flipped");
  assert.equal(landed.length, 1, "one landing");
  const inputs = landed[0];
  const shared = inputs.filter((input) => input.relPath === relative(root, join(dir, SHARED)));
  assert.equal(shared.length, 1, `THE CLAIM: the shared file lands as ONE input: ${inputs.map((i) => i.relPath).join(" ")}`);
  assert.equal(inputs.length, 2, "positive control: the lone record's file lands beside it");
  assert.deepEqual(statuses(shared[0].content), { "W1-T4": "merged", "W1-T5": "merged", "W1-T6": "merged" },
    "THE CLAIM: the composed text carries every flip of the file");
  assert.equal(shared[0].content, before.replace(/^ {2}status: queued$/gm, "  status: merged"), "no other byte of the file changes");
  assert.equal(shared[0].edit?.(before), shared[0].content, "the landing's edit composes the same flips onto main's current text");
  const edit = shared[0].edit!;
  const mainMoved = before.replace("- id: W1-T5\n  title: \"fixture W1-T5\"", "- id: W1-T5\n  title: \"main retitled W1-T5\"");
  assert.deepEqual(statuses(edit(mainMoved)!), { "W1-T4": "merged", "W1-T5": "merged", "W1-T6": "merged" },
    "the edit keeps what main changed and still flips every record");
  assert.match(edit(mainMoved) ?? "", /main retitled W1-T5/);

  assert.equal(linted.length, 2, "the lint hold reads the plan before and after the flips");
  assert.deepEqual(linted[1].only, ["W1-T1", "W1-T5", "W1-T6"], "THE CLAIM: the lint hold checks every record the composed text flips");
  assert.deepEqual(linted[1].status, { "W1-T1": "merged", "W1-T5": "merged", "W1-T6": "merged" }, "THE CLAIM: the lint hold reads the composed text in full");
  assert.deepEqual(linted[0].status, { "W1-T1": "queued", "W1-T5": "queued", "W1-T6": "queued" }, "positive control: before the flips they read queued");
});

test("W1-T15048: a blocking rule one record of a shared file gains holds the file's whole write", (t) => {
  const { root, dir } = fixturePlanDir(t);
  const lint: PlanReconcileLint = (plan, only) => new Map([...only].flatMap((id) => {
    const task = plan.tasks.find((x) => x.id === id);
    return id === "W1-T6" && task?.status === "merged"
      ? [[id, { violations: [{ check: "fixture-rule", severity: "block" }] }] as never] : [];
  }));
  const landed: string[][] = [];
  const result = planReconcileCadence(buildPlanReconcileCadenceInput({
    checkoutRoot: root,
    readShards: () => readPlanShards(dir),
    creditedMergedIds: () => new Set(["W1-T1", "W1-T5", "W1-T6"]),
    land: (inputs) => { landed.push(inputs.map((input) => input.relPath)); },
    lint,
  }));
  assert.deepEqual(result.held, [{ taskId: "W1-T6", rule: "fixture-rule" }], JSON.stringify(result));
  assert.deepEqual(landed, [[relative(root, join(dir, "W1-T1-alone.yaml"))]], "the shared file is held whole and the lone record still lands");
});
