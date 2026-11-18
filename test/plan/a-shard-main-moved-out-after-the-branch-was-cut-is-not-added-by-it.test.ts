// A catalog move deletes a task's public shard on main. A branch cut before that move still carries
// the shard unchanged, and task-id-existence must not read that carried copy as an id the branch adds
// (#19506 refused W1-T12249 and then W1-T12223 this way; #19520 refused W1-T12223 after #19512).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const gate = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

/** main declares W1-T1 and W1-T2; the branch, cut there, adds W1-T3; main then deletes W1-T1's shard. */
function movedAfterCut(t: TestContext, { branchEditsMovedShard = false } = {}) {
  const repo = gitRepo({ scope: t, kind: "moved-after-cut", seedCommit: false });
  const root = repo.dir;
  const git = (...a: string[]) => repo.git(...a);
  const shard = (id: string, title = id) => writeFileSync(join(root, "plan", "tasks.d", `${id}.yaml`), `- id: ${id}\n  title: ${title}\n`);
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  shard("W1-T1");
  shard("W1-T2");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "branch");
  shard("W1-T3");
  if (branchEditsMovedShard) shard("W1-T1", "edited on the branch");
  git("add", ".");
  git("commit", "-qm", "the branch adds W1-T3");
  git("checkout", "-q", "main");
  git("rm", "-q", "plan/tasks.d/W1-T1.yaml");
  git("commit", "-qm", "catalog move removes W1-T1");
  git("checkout", "-q", "branch");
  return root;
}

/** The added-id set exactly as the gate's main() composes it, against base `main`. */
function addedIds(root: string): string[] {
  const occurrences = new Map<string, Array<{ file: string }>>([
    ...["W1-T1", "W1-T2", "W1-T3"].map((id) => [id, [{ file: `plan/tasks.d/${id}.yaml` }]] as [string, Array<{ file: string }>]),
  ]);
  const base = gate.resolveBaseDeclaredIds("main", root);
  const deleted = gate.resolveDeletedPlanFiles("main", root);
  assert.equal(base.readable, true);
  assert.equal(deleted.readable, true);
  const result = gate.addedIdsAtHead(occurrences, base, deleted.files, gate.resolveBranchChangedPlanFiles("main", root));
  assert.equal(result.readable, true);
  return result.ids;
}

test("W1-T13739 criterion 1: a shard main deleted after the branch was cut is carried along by the branch, not added by it", (t) => {
  const root = movedAfterCut(t);
  assert.deepEqual(gate.resolveBaseDeclaredIds("main", root).byId.has("W1-T1"), false, "positive control: main no longer declares W1-T1");
  assert.deepEqual(addedIds(root), ["W1-T3"]);
});

test("W1-T13739 criterion 2: a shard the branch itself edited after main deleted it still counts as added", (t) => {
  assert.deepEqual(addedIds(movedAfterCut(t, { branchEditsMovedShard: true })), ["W1-T1", "W1-T3"]);
});

test("W1-T13739 criterion 3: an unreadable merge base leaves every shard main lacks counted as added", (t) => {
  const root = movedAfterCut(t);
  const changed = gate.resolveBranchChangedPlanFiles("no-such-ref", root);
  assert.deepEqual(changed, { readable: false, files: new Set() });
  const occurrences = new Map([["W1-T1", [{ file: "plan/tasks.d/W1-T1.yaml" }]]]);
  assert.deepEqual(gate.addedIdsAtHead(occurrences, gate.resolveBaseDeclaredIds("main", root), new Set(), changed).ids, ["W1-T1"]);
});

test("a shard the working tree adds before any commit still counts as added", (t) => {
  const root = movedAfterCut(t);
  writeFileSync(join(root, "plan", "tasks.d", "W1-T4.yaml"), "- id: W1-T4\n  title: uncommitted\n");
  const occurrences = new Map([["W1-T4", [{ file: "plan/tasks.d/W1-T4.yaml" }]]]);
  const changed = gate.resolveBranchChangedPlanFiles("main", root);
  assert.equal(changed.readable, true);
  assert.deepEqual(gate.addedIdsAtHead(occurrences, gate.resolveBaseDeclaredIds("main", root), new Set(), changed).ids, ["W1-T4"]);
});
