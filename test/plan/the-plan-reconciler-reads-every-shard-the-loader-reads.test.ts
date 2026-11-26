import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadPlan } from "#src/lib/plan.js";
import { readPlanShards, reconcilePlan, reconcileShardStatus, requeueRevertedShard } from "#src/lib/plan-reconcile.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T11183. The reconciler's shard reader took a shard's id only from a line starting `- id:`, so a record that opens
 * with another key (W1-T10558..W1-T10562 open with `- repo:`), a `.yml` shard, and the second and later records of a
 * shard holding several (W1-T9958's file holds W1-T9959 and W1-T9960) were never reconciled.
 */

const PROOF = "test/plan/the-plan-reconciler-reads-every-shard-the-loader-reads.test.ts";

const record = (id: string, status: string, lead: "id" | "repo" = "id") => lead === "id"
  ? `- id: ${id}\n  title: "fixture ${id}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`
  : `- repo: remudero\n  title: "fixture ${id}"\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  id: ${id}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`;

function fixtureShards(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t11183-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test(`${PROOF}: W1-T11183 criterion 1: every record is read with the loader's id, and the credited queued ones flip`, (t) => {
  const multi = record("W1-T4", "merged") + record("W1-T5", "queued") + record("W1-T6", "queued");
  const dir = fixtureShards(t, {
    "W1-T1-opens-with-id.yaml": record("W1-T1", "queued"),
    "W1-T2-opens-with-repo.yaml": record("W1-T2", "queued", "repo"),
    "W1-T3-a-yml-shard.yml": record("W1-T3", "queued"),
    "W1-T4-holds-three.yaml": multi,
    "not-a-shard.txt": record("W1-T9", "queued"),
    "W1-T8-does-not-parse.yaml": "- id: W1-T8\n  title: [unclosed\n",
  });
  const shards = readPlanShards(dir);
  assert.deepEqual(shards.map((s) => [s.taskId, s.path.slice(dir.length + 1)]), [
    ["W1-T1", "W1-T1-opens-with-id.yaml"], ["W1-T2", "W1-T2-opens-with-repo.yaml"], ["W1-T3", "W1-T3-a-yml-shard.yml"],
    ["W1-T4", "W1-T4-holds-three.yaml"], ["W1-T5", "W1-T4-holds-three.yaml"], ["W1-T6", "W1-T4-holds-three.yaml"],
  ], "THE CLAIM: each record is read, whichever key opens it, and a .yml shard too");
  const credited = new Set(["W1-T1", "W1-T2", "W1-T3", "W1-T5", "W1-T6"]);
  const { writes, summary } = reconcilePlan(shards, (id) => credited.has(id));
  assert.deepEqual(summary.rewritten, ["W1-T1", "W1-T2", "W1-T3", "W1-T5", "W1-T6"], "THE CLAIM: the credited queued records flip");
  for (const w of writes.filter((w) => w.taskId !== "W1-T5" && w.taskId !== "W1-T6")) {
    assert.match(w.text, /^  status: merged$/m, `${w.taskId} reads merged`);
    assert.doesNotMatch(w.text, /^  status: queued$/m, `${w.taskId} has no queued line left`);
  }
  // The last write to the shared file carries both flips, and only those: W1-T4's own line is untouched.
  const last = writes.findLast((w) => w.taskId === "W1-T6")!.text;
  assert.equal(last, record("W1-T4", "merged") + record("W1-T5", "merged") + record("W1-T6", "merged"));
  const firstOfFile = writes.find((w) => w.taskId === "W1-T5")!.text;
  assert.equal(firstOfFile, record("W1-T4", "merged") + record("W1-T5", "merged") + record("W1-T6", "queued"));
});

test(`${PROOF}: a shard holding several records is edited on the named record alone`, () => {
  const text = record("W1-T4", "queued") + record("W1-T5", "queued");
  assert.equal(reconcileShardStatus(text, "W1-T5", () => true).text, record("W1-T4", "queued") + record("W1-T5", "merged"));
  assert.equal(reconcileShardStatus(text, "W1-T7", () => true).skipped, "no-status-field", "an id the shard does not hold edits nothing");
  // A single-record shard stays keyed by anything, as the landing's carried-blob check keys it by path.
  assert.equal(reconcileShardStatus(record("W1-T1", "queued"), "plan/tasks.d/W1-T1.yaml", () => true).text, record("W1-T1", "merged"));
  const lost = { merged: false, revertedCredit: { pr: 1, revertSha: "a".repeat(40) } };
  const merged = record("W1-T4", "merged") + record("W1-T5", "merged");
  assert.equal(requeueRevertedShard(merged, "W1-T5", lost).text, record("W1-T4", "merged") + record("W1-T5", "queued"),
    "a re-queue edits the named record alone");
  assert.equal(requeueRevertedShard(merged, "W1-T7", lost).skipped, "no-status-field");
});

test(`${PROOF}: W1-T11183 criterion 2: over main's tasks.d the reader returns every task loadPlan loads, each from its file`, () => {
  const shardDir = join(REPO_ROOT, "plan", "tasks.d");
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  const loaded = plan.tasks.filter((task) => task.sourcePath !== undefined && resolve(REPO_ROOT, task.sourcePath).startsWith(`${shardDir}/`))
    .map((task) => `${task.id} ${resolve(REPO_ROOT, task.sourcePath!)}`).sort();
  const read = readPlanShards(shardDir).map((shard) => `${shard.taskId} ${resolve(shard.path)}`).sort();
  assert.ok(loaded.length > 1000, `positive control: loadPlan read ${loaded.length} shard tasks`);
  assert.deepEqual(read, loaded, "THE CLAIM: the reader and the loader agree on every shard task and its file");
});
