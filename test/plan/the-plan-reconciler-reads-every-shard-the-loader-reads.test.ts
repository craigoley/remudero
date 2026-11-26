import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadPlan, loadPlanQuarantiningDuplicates } from "#src/lib/plan.js";
import { readPlanShards, reconcilePlan, reconcileShardStatus, requeueRevertedShard } from "#src/lib/plan-reconcile.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T11183. The reconciler's shard reader took a shard's id only from a line starting `- id:`, so a record that opens
 * with another key (W1-T10558..W1-T10562 open with `- repo:`) and a `.yml` shard were never reconciled. The reader now
 * takes each id from the loader's own parse. A file holding several records is read, but none of its records is
 * rewritten: every edit and the landing's carry check read one record per file.
 */

const PROOF = "test/plan/the-plan-reconciler-reads-every-shard-the-loader-reads.test.ts";

const record = (id: string, status: string, lead: "id" | "repo" = "id") => lead === "id"
  ? `- id: ${id}\n  title: "fixture ${id}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`
  : `- repo: remudero\n  title: "fixture ${id}"\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: ${status}\n  id: ${id}\n  acceptance:\n    - claim: c\n      proof: "grep: x in src/x.ts"\n`;

/** A fixture plan: an empty monolith and a `tasks.d` holding `files`, so loadPlan reads the same files the reader does. */
function fixturePlan(t: { after: (fn: () => void) => void }, files: Record<string, string>): { planPath: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11183-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "tasks.d");
  mkdirSync(dir);
  writeFileSync(join(root, "tasks.yaml"), "[]\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { planPath: join(root, "tasks.yaml"), dir };
}

/** Each shard task loadPlan loads, as `<id> <file>`, quarantining what it quarantines. */
function loaderIds(planPath: string, dir: string): string[] {
  return loadPlanQuarantiningDuplicates(planPath).plan.tasks
    .filter((task) => task.sourcePath !== undefined && resolve(task.sourcePath).startsWith(`${dir}/`))
    .map((task) => `${task.id} ${resolve(task.sourcePath!)}`).sort();
}

test(`${PROOF}: W1-T11183 criterion 1: every record is read with the loader's id, and the credited queued ones flip`, (t) => {
  const { planPath, dir } = fixturePlan(t, {
    "W1-T1-opens-with-id.yaml": record("W1-T1", "queued"),
    "W1-T2-opens-with-repo.yaml": record("W1-T2", "queued", "repo"),
    "W1-T3-a-yml-shard.yml": record("W1-T3", "queued"),
    "not-a-shard.txt": record("W1-T9", "queued"),
  });
  const shards = readPlanShards(dir);
  const read = shards.map((s) => `${s.taskId} ${resolve(s.path)}`).sort();
  assert.deepEqual(read, loaderIds(planPath, dir), "THE CLAIM: each record is read with the id the plan loader gives it");
  assert.deepEqual(read.map((line) => line.split(" ")[0]), ["W1-T1", "W1-T2", "W1-T3"], "positive control: all three are read");
  const { writes, summary } = reconcilePlan(shards, () => true);
  assert.deepEqual(summary.rewritten, ["W1-T1", "W1-T2", "W1-T3"], "THE CLAIM: the credited queued records flip");
  for (const w of writes) {
    assert.match(w.text, /^  status: merged$/m, `${w.taskId} reads merged`);
    assert.doesNotMatch(w.text, /^  status: queued$/m, `${w.taskId} has no queued line left`);
  }
});

test(`${PROOF}: a shard the loader quarantines is skipped, and the rest are still reconciled`, (t) => {
  // An unresolved alias makes the yaml parser throw a ReferenceError, not a YAMLParseError.
  const { planPath, dir } = fixturePlan(t, {
    "W1-T1-opens-with-id.yaml": record("W1-T1", "queued"),
    "W1-T7-an-unresolved-alias.yaml": "- id: W1-T7\n  title: *missing\n",
    "W1-T8-does-not-parse.yaml": "- id: W1-T8\n  title: [unclosed\n",
    "W1-T6-an-invalid-record.yaml": record("W1-T6", "queued").replace("type: implement", "type: nonsense"),
  });
  const shards = readPlanShards(dir);
  assert.deepEqual(shards.map((s) => s.taskId), ["W1-T1"]);
  assert.deepEqual(shards.map((s) => `${s.taskId} ${resolve(s.path)}`), loaderIds(planPath, dir), "the reader skips what the loader quarantines");
  assert.deepEqual(reconcilePlan(shards, () => true).summary.rewritten, ["W1-T1"]);
});

test(`${PROOF}: a file holding several records is read but none of its records is rewritten`, (t) => {
  const multi = record("W1-T4", "merged") + record("W1-T5", "queued") + record("W1-T6", "queued");
  const { planPath, dir } = fixturePlan(t, { "W1-T1-opens-with-id.yaml": record("W1-T1", "queued"), "W1-T4-holds-three.yaml": multi });
  const shards = readPlanShards(dir);
  assert.deepEqual(shards.map((s) => s.taskId), ["W1-T1", "W1-T4", "W1-T5", "W1-T6"]);
  assert.deepEqual(shards.map((s) => `${s.taskId} ${resolve(s.path)}`).sort(), loaderIds(planPath, dir));
  const { writes, summary } = reconcilePlan(shards, () => true);
  // One write per file: the shared file yields none, so no landing input can overwrite another record's flip.
  assert.deepEqual(writes.map((w) => w.taskId), ["W1-T1"]);
  assert.equal(summary.skipped["shared-shard"], 3);
  const lost = { merged: false, revertedCredit: { pr: 1, revertSha: "a".repeat(40) } };
  assert.equal(requeueRevertedShard(multi, "W1-T4", lost).skipped, "shared-shard", "a re-queue never edits a shared file");
  // reconcileShardStatus is unchanged: a single-record shard is edited by any key, as the landing keys its carry by path.
  assert.equal(reconcileShardStatus(record("W1-T1", "queued"), "plan/tasks.d/W1-T1.yaml", () => true).text, record("W1-T1", "merged"));
  assert.equal(requeueRevertedShard(record("W1-T1", "merged"), "plan/tasks.d/W1-T1.yaml", lost).text, record("W1-T1", "queued"));
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
