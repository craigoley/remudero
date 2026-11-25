/**
 * W1-T14827: the catalog mover leaves every moved id in both catalogs until its public removal lands; the ops copy
 * carries `moved_from: remudero@<public commit>` under the public record's shard file name. Status sync reads that
 * id once, as the ops record, instead of refusing the whole ops catalog as duplicate_task_id. Any other shared id is
 * still a duplicate. Separately, the cadence's plan reconcile lands any drift instead of waiting for ten records.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parseTasksFromYaml, type Plan } from "#src/lib/plan.js";
import { readCatalogStatusContext } from "#src/lib/status.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { buildPlanReconcileCadenceInput, planReconcileCadence } from "#src/lib/measurement-cadence.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const OPS = "fixture-private/ops";
const PUBLIC_COMMIT = "f".repeat(40);
const MOVED = `  moved_from: remudero@${PUBLIC_COMMIT}\n`;

const record = (id: string, extra = "", dependsOn = "[]") =>
  `- id: ${id}\n${extra}  title: in-flight move fixture ${id}\n  repo: remudero\n  type: implement\n  priority: 1\n  depends_on: ${dependsOn}\n`;

/** The public plan as loadPlan reads it: one record per shard, each labelled with its shard path. */
function publicPlan(shards: Record<string, string>): Plan {
  const tasks = Object.entries(shards).flatMap(([file, text]) => parseTasksFromYaml(text, `/checkout/plan/tasks.d/${file}`));
  return { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
}

const gitSha = (kind: string, bytes: Buffer) => createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");

/** An in-memory GitHub contents API for one ops repository. With `moving`, every ref read names a new commit whose
 *  every blob differs, so no pass can reuse its predecessor's objects. */
function opsApi(shards: Record<string, string>, opts: { moving?: boolean; unreachable?: boolean } = {}): OpsCatalogApi {
  const trees = new Map<string, Array<{ path: string; mode: string; type: string; sha: string }>>();
  const blobs = new Map<string, Buffer>();
  const commits = new Map<string, string>();
  const blob = (text: string) => { const bytes = Buffer.from(text, "utf8"), sha = gitSha("blob", bytes); blobs.set(sha, bytes); return sha; };
  const tree = (entries: Array<{ path: string; mode: string; type: string; sha: string }>) => {
    const sha = gitSha("tree", Buffer.from(JSON.stringify(entries))); trees.set(sha, entries); return sha;
  };
  const commitAt = (revision: number) => {
    const suffix = opts.moving ? `# revision ${revision}\n` : "";
    const shardTree = tree(Object.entries(shards).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, text]) => ({ path: file, mode: "100644", type: "blob", sha: blob(text + suffix) })));
    const planTree = tree([{ path: "tasks.d", mode: "040000", type: "tree", sha: shardTree },
      { path: "tasks.yaml", mode: "100644", type: "blob", sha: blob(`[]\n${suffix}`) }]);
    const root = tree([{ path: "plan", mode: "040000", type: "tree", sha: planTree }]);
    const sha = gitSha("commit", Buffer.from(`${root}:${revision}`)); commits.set(sha, root); return sha;
  };
  let revision = 0;
  const fixed = commitAt(0);
  return async path => {
    if (opts.unreachable) throw new Error("fixture ops source unavailable");
    const prefix = `repos/${OPS}`;
    assert.ok(path === prefix || path.startsWith(`${prefix}/`), `GET only the named repository: ${path}`);
    const tail = path.slice(prefix.length);
    if (tail === "") return { id: 4242, full_name: OPS, default_branch: "main" };
    if (tail === "/git/ref/heads/main") return { object: { type: "commit", sha: opts.moving ? commitAt(++revision) : fixed } };
    if (tail.startsWith("/git/commits/")) {
      const sha = tail.slice("/git/commits/".length);
      return { sha, tree: { sha: commits.get(sha) } };
    }
    if (tail.startsWith("/git/trees/")) {
      const sha = tail.slice("/git/trees/".length);
      return { sha, truncated: false, tree: trees.get(sha) };
    }
    if (tail.startsWith("/git/blobs/")) {
      const sha = tail.slice("/git/blobs/".length), bytes = blobs.get(sha)!;
      return { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
    }
    return assert.fail(`unexpected ops source path ${path}`);
  };
}

function stateDir(t: TestContext, destination: string = JSON.stringify({ repository: OPS, kinds: [] })): string {
  const dir = ownedFixtureDir(t, "w1-t14827-state").dir;
  writeFileSync(join(dir, "plan-destination.json"), destination);
  return dir;
}

const PUBLIC = { "W1-T900001.yaml": record("W1-T900001"), "W1-T900002.yaml": record("W1-T900002") };

test("W1-T14827 criterion 1: an id both catalogs hold only because its move is in flight resolves once, to the ops record", async t => {
  const ops = { "W1-T900001.yaml": record("W1-T900001", MOVED), "W1-T900003.yaml": record("W1-T900003") };
  const context = await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t), opsApi(ops));
  assert.equal(context.outcome, "ok", `an in-flight move must not refuse the ops catalog: ${context.outcome}`);
  assert.deepEqual(context.plan.tasks.map(task => task.id).sort(), ["W1-T900001", "W1-T900002", "W1-T900003"]);
  assert.equal(context.plan.tasks.filter(task => task.id === "W1-T900001").length, 1, "the moved id is read once");
  const moved = context.plan.byId.get("W1-T900001") as { moved_from?: string; catalog?: string } | undefined;
  assert.equal(moved?.moved_from, `remudero@${PUBLIC_COMMIT}`, "the moved id resolves to the ops copy");
  assert.equal(moved?.catalog, "ops");
  assert.deepEqual(context.opsPlan?.tasks.map(task => task.id), ["W1-T900003"],
    "the records an ops landing may write exclude the moved id, whose status still lands on its public shard");
  assert.equal(context.plan.byId.get("W1-T900002")?.moved_from, undefined, "a public-only record stays public");
  assert.match(context.commit ?? "", /^[0-9a-f]{40}$/);
});

test("W1-T14827 criterion 2: an unexplained duplicate is still refused, and every other refusal is unchanged", async t => {
  const duplicates: Array<[string, Record<string, string>]> = [
    ["no moved_from", { "W1-T900001.yaml": record("W1-T900001"), "W1-T900003.yaml": record("W1-T900003") }],
    ["another repository's moved_from", { "W1-T900001.yaml": record("W1-T900001", `  moved_from: elsewhere@${PUBLIC_COMMIT}\n`) }],
    ["a moved_from naming no full commit", { "W1-T900001.yaml": record("W1-T900001", "  moved_from: remudero@abc123\n") }],
    ["a renamed shard", { "W1-T900001-renamed.yaml": record("W1-T900001", MOVED), "W1-T900003.yaml": record("W1-T900003") }],
  ];
  for (const [why, ops] of duplicates) {
    const context = await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t), opsApi(ops));
    assert.equal(context.outcome, "duplicate_task_id", `${why}: a shared id the mover did not explain is a duplicate`);
    assert.deepEqual(context.plan.tasks.map(task => task.id), ["W1-T900001", "W1-T900002"], `${why}: the public plan alone`);
    assert.equal(context.opsPlan, undefined, why);
  }
  // A public record read from the monolith is no shard: a same-named ops copy is not its move.
  const monolith: Plan = (() => {
    const tasks = parseTasksFromYaml(record("W1-T900001") + record("W1-T900002"), "/checkout/plan/tasks.yaml");
    return { tasks, byId: new Map(tasks.map(task => [task.id, task])) };
  })();
  const fromMonolith = await readCatalogStatusContext(monolith, stateDir(t), opsApi({ "tasks.yaml": record("W1-T900001", MOVED) }));
  assert.equal(fromMonolith.outcome, "duplicate_task_id", "a monolith record is never a shard move");

  // One unexplained duplicate beside a genuine in-flight move still refuses.
  const mixed = { "W1-T900001.yaml": record("W1-T900001", MOVED), "W1-T900002.yaml": record("W1-T900002") };
  assert.equal((await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t), opsApi(mixed))).outcome, "duplicate_task_id");

  // Every other refusal is unchanged, with an in-flight move present.
  const orphan = { "W1-T900001.yaml": record("W1-T900001", MOVED), "W1-T900004.yaml": record("W1-T900004", "", "[W1-T999999]") };
  assert.equal((await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t), opsApi(orphan))).outcome,
    "invalid_cross_catalog_dependency", "an ops record naming an id neither catalog holds");
  const reaching = { ...PUBLIC, "W1-T900005.yaml": record("W1-T900005", "", "[W1-T900003]") };
  const opsOnly = { "W1-T900001.yaml": record("W1-T900001", MOVED), "W1-T900003.yaml": record("W1-T900003") };
  assert.equal((await readCatalogStatusContext(publicPlan(reaching), stateDir(t), opsApi(opsOnly))).outcome,
    "invalid_cross_catalog_dependency", "a public record naming an ops id");
  const unreadable = await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t), opsApi(opsOnly, { unreachable: true }));
  assert.equal(unreadable.outcome, "unreadable");
  assert.equal((await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t, "not json"), opsApi(opsOnly))).outcome, "unreadable");
  const moved = await readCatalogStatusContext(publicPlan(PUBLIC), stateDir(t), opsApi(opsOnly, { moving: true }));
  assert.equal(moved.outcome, "ref_moved");
  for (const refused of [unreadable, moved]) {
    assert.deepEqual(refused.plan.tasks.map(task => task.id), ["W1-T900001", "W1-T900002"]);
    assert.equal(refused.opsPlan, undefined);
  }
});

test("W1-T14827 criterion 3: the plan reconcile lands one drifted record, and reports zero drift as before", () => {
  const shard = (taskId: string) => ({ taskId, path: `/fixture/plan/tasks.d/${taskId}.yaml`,
    text: `- id: ${taskId}\n  title: reconcile fixture\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n` });
  const run = (drifted: number, total = 3) => {
    const records = Array.from({ length: total }, (_, i) => shard(`W1-T90010${i}`));
    const landed: string[][] = [];
    const input = buildPlanReconcileCadenceInput({
      checkoutRoot: "/fixture",
      readShards: () => records,
      creditedMergedIds: () => new Set(records.slice(0, drifted).map(record => record.taskId)),
      lint: () => new Map(),
      land: inputs => { landed.push(inputs.map(each => each.relPath)); },
    });
    return { result: planReconcileCadence(input), landed };
  };
  const one = run(1);
  assert.equal(one.result.status, "landed", `one drifted record lands: ${JSON.stringify(one.result)}`);
  assert.deepEqual(one.landed, [["plan/tasks.d/W1-T900100.yaml"]]);
  assert.deepEqual(one.result.taskIds, ["W1-T900100"]);
  const nine = run(9, 9);
  assert.equal(nine.result.status, "landed", "nine drifted records land without waiting for a tenth");
  assert.equal(nine.landed.flat().length, 9);

  const none = run(0);
  assert.deepEqual(none.landed, [], "zero drift lands nothing");
  assert.equal(none.result.status, "clear");
  assert.equal(none.result.drift, 0);
  assert.deepEqual(none.result.taskIds, []);
  assert.equal(none.result.held, undefined);
  assert.equal(none.result.requeued, undefined);
});
