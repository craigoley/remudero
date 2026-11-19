/**
 * W1-T12206 follow-up — the plan destination read sizes its blob buffer from the catalog it reads.
 *
 * On 2026-11-18 the ops plan reached 201 blobs and 1,052,019 bytes. Its one `cat-file --batch` answer then passed
 * Node's 1 MiB default output bound, and every id reservation refused with "plan destination is unreadable at plan".
 * These tests read a destination checkout over 1 MiB through the production git leaf, with no git runner injected.
 *
 * @not-a-rule-suite: it tests one reader's git output bound on fixture repositories and walks no tracked population.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { taskIdDestinationSnapshot } from "#test/helpers/run-task-test.js";

const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;
const SHARDS = 40;
const PAD = "x".repeat(30_000);

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function task(id: number): string {
  return `- id: W1-T${id}\n  title: fixture task\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n`;
}
/** One task and a 30,000-byte comment: 40 shards put the plan's blobs past Node's 1 MiB default. */
function shard(id: number): string {
  return `# ${PAD}\n${task(id)}`;
}

function bigDestination(t: TestContext) {
  const root = ownedFixtureDir(t, "ops-id-big-catalog").dir;
  const origin = gitRepo({ bare: true, scope: t, kind: "ops-big-origin" });
  const writer = gitRepo({ cloneFrom: origin.dir, scope: t, kind: "ops-big-writer" });
  let bytes = 0;
  const write = (rel: string, text: string) => { put(join(writer.dir, rel), text); bytes += Buffer.byteLength(text); };
  write("plan/tasks.yaml", task(200));
  for (let i = 1; i <= SHARDS; i++) write(`plan/tasks.d/W1-T${200 + i}-fixture.yaml`, shard(200 + i));
  writer.git("add", "plan");
  writer.git("commit", "-qm", "a destination plan over 1 MiB");
  writer.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  assert.ok(bytes > NODE_DEFAULT_MAX_BUFFER, `the fixture plan is over 1 MiB (${bytes} bytes)`);
  // The reader takes its checkout from the state dir: <state>/../repos/<repo>.
  const state = join(root, "state");
  put(join(state, "plan-destination.json"), JSON.stringify({ repository: "fixture-owner/fixture-ops", kinds: [] }));
  const checkout = join(root, "repos", "fixture-ops");
  writer.git("clone", "--quiet", origin.dir, checkout);
  const checks = { destinationStateDir: () => state, destinationPrFetch: () => [] };
  const commit = (rel: string, text: string, message: string) => {
    put(join(writer.dir, rel), text);
    writer.git("add", rel);
    writer.git("commit", "-qm", message);
    writer.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  };
  return { checks, commit };
}

const expectedIds = [200, ...Array.from({ length: SHARDS }, (_, i) => 201 + i)].map((n) => `W1-T${n}`);

test("W1-T12206 follow-up criterion 1: a destination plan over 1 MiB is read through the production git leaf", async (t) => {
  const { checks } = bigDestination(t);
  const snapshot = await taskIdDestinationSnapshot(checks);
  assert.ok(snapshot, "a selected destination gives a snapshot");
  assert.deepEqual([...snapshot.ids].sort(), [...expectedIds].sort());
  assert.equal(snapshot.planTexts.length, SHARDS + 1);
  assert.ok(snapshot.planTexts.reduce((n, text) => n + Buffer.byteLength(text), 0) > NODE_DEFAULT_MAX_BUFFER);
});

test("W1-T12206 follow-up criterion 2: a duplicate id and a bad shard still refuse at plan", async (t) => {
  for (const [rel, text] of [
    ["plan/tasks.d/W1-T999-duplicate.yaml", shard(201)],
    ["plan/tasks.d/W1-T999-malformed.yaml", "malformed: [\n"],
  ] as const) {
    const { checks, commit } = bigDestination(t);
    // The same catalog reads cleanly first, so the refusal below comes from the defect, not the size.
    assert.ok(await taskIdDestinationSnapshot(checks));
    commit(rel, text, `defect: ${rel}`);
    await assert.rejects(taskIdDestinationSnapshot(checks), { message: "plan destination is unreadable at plan" });
  }
});
