// 2026-10-10: the backlog gardener's #10740 proposed withdrawing W1-T5161 and W1-T6007 because merged #10699 touched
// both of their declared files. Every selector-edge task declares the same two files (src/lib/affected-suites.ts and
// the selector shadow test), so any selector fix "covered the declared surface" of all of them, while neither task's
// own grep proof (its edge named in both files) held on main. File overlap alone is now never an overtaking: the
// task's own acceptance proofs must hold on main as well.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { backlogInventory, type BacklogSources } from "#src/lib/backlog-gardener.js";
import { fixedClock } from "#src/lib/clock.js";
import type { MainCommit } from "#src/lib/hot-file-gardener.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import type { Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = new Date("2026-10-10T20:00:00.000Z");
const SELECTOR = "src/lib/affected-suites.ts";
const SHADOW = "test/the-affected-suite-selector-runs-in-shadow.test.ts";
const MERGED: MainCommit = { sha: "b".repeat(40), at: NOW.toISOString(), subject: "fix(selector): include one edge (#4242)", files: [SELECTOR, SHADOW] };

function edgeTask(id: string, suite: string): Task {
  const escaped = suite.replace(/\./g, "\\.");
  return {
    id, title: `REPAIR THE SELECTOR EDGE INTO ${suite}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto",
    risk: "low", status: "queued", attempts: 0, files: [SELECTOR, SHADOW],
    acceptance: [
      { claim: `the narrow selector includes ${suite}`, proof: `grep: ${escaped} in ${SELECTOR}` },
      { claim: `a regression test selects ${suite}`, proof: `grep: ${escaped} in ${SHADOW}` },
    ],
  };
}

function fixture(t: { after: (fn: () => void) => void }, tasks: Task[], files: Record<string, string>, history: MainCommit[]): BacklogSources {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}backlog-overtaken-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shards = new Map<string, string>();
  for (const item of tasks) {
    const rel = `plan/tasks.d/${item.id}.yaml`;
    shards.set(item.id, rel);
    writeFileSync(join(root, rel), `- id: ${item.id}\n  title: ${item.title}\n  status: queued\n`);
  }
  const plan: PlanInventory = { open: tasks, all: tasks, shards };
  return {
    repoRoot: root, plan: () => plan, ledger: () => [], history: () => history, mergedLastDay: () => 5,
    clock: fixedClock(NOW.getTime()), fileExists: () => true, proofsHolding: () => new Set(),
  };
}

test("of two selector-edge tasks sharing both declared files, the merged one is withdrawn and the unbuilt one is not", (t) => {
  const built = edgeTask("W1-T9101", "test/alpha-suite.test.ts");
  const unbuilt = edgeTask("W1-T9102", "test/beta-suite.test.ts");
  // The merged selector fix added alpha's edge to both files and nothing for beta.
  const sources = fixture(t, [built, unbuilt], {
    [SELECTOR]: `export const EDGES = ["test/alpha-suite.test.ts"];\n`,
    [SHADOW]: `test("selects test/alpha-suite.test.ts", () => {});\n`,
  }, [MERGED]);
  const byTarget = new Map(backlogInventory(sources).candidates.map((a) => [a.target, a]));

  assert.deepEqual(byTarget.get(built.id)?.disposition, { kind: "retire", retirement: "withdrawn" }, "its own proofs hold on main");
  assert.match(byTarget.get(built.id)!.reason, /every acceptance proof it filed holds on main/);
  assert.equal(byTarget.get(unbuilt.id)?.disposition.kind, "band", "a shared surface does not withdraw a task whose proofs fail on main");
  assert.equal(byTarget.get(unbuilt.id)?.evidence.overtaken, undefined);
});

test("a task with no readable proof is never withdrawn on file overlap alone", (t) => {
  const bare: Task = { ...edgeTask("W1-T9103", "test/gamma-suite.test.ts"), acceptance: [] };
  const unitOnly: Task = { ...edgeTask("W1-T9104", "test/delta-suite.test.ts"), acceptance: [{ claim: "the edge is selected", proof: "unit test: selects test/delta-suite.test.ts" }] };
  const sources = fixture(t, [bare, unitOnly], { [SELECTOR]: "test/delta-suite.test.ts\n", [SHADOW]: "selects test/delta-suite.test.ts\n" }, [MERGED]);
  for (const action of backlogInventory(sources).candidates) {
    assert.equal(action.disposition.kind, "band", `${action.target}: overlap alone is not evidence the work happened`);
    assert.equal(action.evidence.overtaken, undefined);
  }
});
