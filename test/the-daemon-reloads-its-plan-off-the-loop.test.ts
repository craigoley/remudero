import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { loadPlanAtRef, loadPlanAtRefAsync, mergePlanBlobs, type Plan } from "#src/lib/plan.js";
import { resolvePlanCriteriaAtHead, resolvePlanCriteriaAtHeadAsync } from "#src/lib/review.js";
import { dedicatedTargetPlanReloader, planReloader } from "#src/run-task.js";
import { runDaemon } from "#src/lib/daemon.js";

const SYNC_PRIMITIVES = ["execFileSync", "spawnSync", "execSync"] as const;

/** Run `body` while every synchronous child_process primitive THROWS, then restore them. Fixtures are built before
 *  and after the trap: only the code under test runs inside it. */
async function withSyncSpawnsTrapped<T>(body: () => Promise<T>): Promise<T> {
  const cp = childProcess as unknown as Record<string, unknown>;
  const originals = SYNC_PRIMITIVES.map((name) => [name, cp[name]] as const);
  for (const name of SYNC_PRIMITIVES) {
    cp[name] = () => {
      throw new Error(`synchronous ${name} reached while the event loop was being served`);
    };
  }
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    for (const [name, original] of originals) cp[name] = original;
    syncBuiltinESMExports();
  }
}

function taskYaml(id: string, acceptance = false): string {
  return [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    "  repo: r",
    "  type: implement",
    "  depends_on: []",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    ...(acceptance ? ["  acceptance:", `    - claim: "${id} holds"`, `      proof: "${id} holds, per the PR body"`] : []),
    "",
  ].join("\n");
}

/** A repo whose HEAD carries plan/tasks.yaml plus two shards under plan/tasks.d/, with origin/main pointing at HEAD. */
function planFixture() {
  const repo = gitRepo({ kind: "w1t7743" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), taskYaml("MONO-1"));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "SHARD-1.yaml"), taskYaml("SHARD-1", true));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "SHARD-2.yaml"), taskYaml("SHARD-2"));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "plan");
  const commitPlan = (): string => {
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "plan moves");
    const sha = repo.git("rev-parse", "HEAD").trim();
    repo.git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD").trim());
  return { repo, commitPlan };
}

const ids = (plan: Plan | null | undefined): string[] => (plan?.tasks ?? []).map((t) => t.id).sort();

test("W1-T7743: loadPlanAtRefAsync equals loadPlanAtRef on a real fixture with sync spawns trapped", async () => {
  const { repo } = planFixture();
  try {
    const expected = loadPlanAtRef(repo.dir, "plan/tasks.yaml", "HEAD");
    const actual = await withSyncSpawnsTrapped(() => loadPlanAtRefAsync(repo.dir, "plan/tasks.yaml", "HEAD"));
    assert.deepEqual(ids(actual), ["MONO-1", "SHARD-1", "SHARD-2"], "the monolith and both shards were merged");
    assert.deepEqual(actual, expected, "the awaited loader returns the sync loader's plan");
    await assert.rejects(
      () => withSyncSpawnsTrapped(() => loadPlanAtRefAsync(repo.dir, "plan/tasks.yaml", "no-such-ref")),
      /cannot read plan file at no-such-ref:plan\/tasks\.yaml/,
      "an unreadable ref is the same PlanError the sync loader raises",
    );
  } finally {
    repo.cleanup();
  }
});

test("W1-T7743: async plan loading tolerates a ref with no shard tree", async () => {
  const commands: string[] = [];
  const runGit = async (args: string[]): Promise<string> => {
    commands.push(args[0] ?? "");
    if (args[0] === "show") return taskYaml("MONO-ONLY");
    if (args[0] === "ls-tree") throw new Error("tasks.d is absent at this ref");
    throw new Error("unexpected git command " + args[0]);
  };

  const plan = await loadPlanAtRefAsync("fixture-root", "plan/tasks.yaml", "HEAD", runGit);
  assert.deepEqual(ids(plan), ["MONO-ONLY"]);
  assert.deepEqual(commands, ["show", "ls-tree"], "an absent shard tree is tolerated without a cat-file call");
});

test("W1-T7743: async plan loading wraps a listed-shard read failure as PlanError", async () => {
  const commands: string[] = [];
  const runGit = async (args: string[]): Promise<string> => {
    commands.push(args[0] ?? "");
    if (args[0] === "show") return taskYaml("MONO-1");
    if (args[0] === "ls-tree") return "plan/tasks.d/SHARD-1.yaml\n";
    if (args[0] === "cat-file") throw new Error("cat-file unavailable");
    throw new Error("unexpected git command " + args[0]);
  };

  await assert.rejects(
    () => loadPlanAtRefAsync("fixture-root", "plan/tasks.yaml", "HEAD", runGit),
    /cannot read plan shard at HEAD in fixture-root: Error: cat-file unavailable/,
  );
  assert.deepEqual(commands, ["show", "ls-tree", "cat-file"]);
});

test("W1-T7743: planReloader returns the fresh plan after origin/main moves with sync spawns trapped", async () => {
  const { repo, commitPlan } = planFixture();
  try {
    const logged: string[] = [];
    const reload = planReloader({ isSelf: true, planPath: join(repo.dir, "plan", "tasks.yaml") }, false, (step) => logged.push(step))!;
    assert.ok(reload, "a self target gets a reloader");
    const first = reload();
    assert.ok(first instanceof Promise, "the reloader returns a promise the tick awaits");
    assert.equal(await withSyncSpawnsTrapped(() => first), null, "the first tick records the boot sha");
    assert.equal(await withSyncSpawnsTrapped(async () => reload()), null, "an unchanged tree reloads nothing");

    writeFileSync(join(repo.dir, "plan", "tasks.d", "SHARD-3.yaml"), taskYaml("SHARD-3"));
    commitPlan();
    const fresh = await withSyncSpawnsTrapped(async () => reload());
    assert.deepEqual(ids(fresh), ["MONO-1", "SHARD-1", "SHARD-2", "SHARD-3"], "the moved origin/main:plan is parsed");
    assert.deepEqual(logged, ["daemon.plan_unchanged", "daemon.plan_changed"]);
  } finally {
    repo.cleanup();
  }
});

test("W1-T7743: dedicatedTargetPlanReloader fetches, resets and reloads with sync spawns trapped", async () => {
  const bare = gitRepo({ bare: true, kind: "w1t7743-bare" });
  const work = gitRepo({ kind: "w1t7743-work" });
  let clone: ReturnType<typeof gitRepo> | undefined;
  try {
    mkdirSync(join(work.dir, "plan"), { recursive: true });
    writeFileSync(join(work.dir, "plan", "tasks.yaml"), taskYaml("A"));
    work.git("add", "-A");
    work.git("commit", "-q", "-m", "seed");
    work.addRemote("origin", bare.dir);
    work.git("push", "-q", "origin", "main");
    clone = gitRepo({ cloneFrom: bare.dir, kind: "w1t7743-clone" });

    const reload = dedicatedTargetPlanReloader({ isSelf: false, planPath: join(clone.dir, "plan", "tasks.yaml") }, () => {})!;
    assert.ok(reload, "a non-self target gets a reloader");
    assert.equal(await withSyncSpawnsTrapped(async () => reload()), null, "the first tick records the boot sha");

    writeFileSync(join(work.dir, "plan", "tasks.yaml"), taskYaml("A") + taskYaml("B-NEW"));
    work.git("add", "-A");
    work.git("commit", "-q", "-m", "filed");
    work.git("push", "-q", "origin", "main");

    const fresh = await withSyncSpawnsTrapped(async () => reload());
    assert.deepEqual(ids(fresh), ["A", "B-NEW"], "the reloader's own fetch saw the push, its reset moved the checkout, its load parsed it");
  } finally {
    clone?.cleanup();
    work.cleanup();
    bare.cleanup();
  }
});

test("W1-T7743: the tick awaits an async reloadPlan and binds the resolved plan before the batch", async () => {
  const initial = mergePlanBlobs([{ label: "initial", text: taskYaml("OLD-TASK") }]);
  const updated = mergePlanBlobs([{ label: "updated", text: taskYaml("RELOADED-TASK") }]);
  const order: string[] = [];
  const reloaded: unknown[] = [];
  let reloads = 0;
  let ticks = 0;
  const merged = new Set<string>(["OLD-TASK"]);
  await runDaemon(
    initial,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      reloadPlan: async () => {
        reloads++;
        order.push("reload:start");
        await new Promise<void>((resolve) => setImmediate(resolve));
        order.push("reload:end");
        return reloads === 1 ? updated : null;
      },
      onPlanReload: (plan: unknown) => reloaded.push(plan),
      checkStop: () => (++ticks > 2 ? "done" : undefined),
      runOne: async (id: string) => {
        order.push(`batch:${id}`);
        merged.add(id);
        return { taskId: id, merged: true } as never;
      },
      sleep: async () => {},
    } as never,
    { max: 1 },
  );
  assert.deepEqual(reloaded, [updated], "onPlanReload received the resolved Plan, never the Promise");
  assert.deepEqual(order.slice(0, 3), ["reload:start", "reload:end", "batch:RELOADED-TASK"], "the reload settled before the batch ran, and the batch ran the reloaded plan's task");
});

test("W1-T7743: resolvePlanCriteriaAtHeadAsync resolves the head criteria with sync spawns trapped", async () => {
  const { repo } = planFixture();
  try {
    const head = repo.git("rev-parse", "HEAD").trim();
    const body = "report\n\nRemudero-Task: SHARD-1\n";
    const expected = resolvePlanCriteriaAtHead(body, repo.dir, "plan/tasks.yaml", head);
    assert.equal(expected.criteria.length, 1, "sanity: the sync form resolves the shard's criterion");
    const actual = await withSyncSpawnsTrapped(() => resolvePlanCriteriaAtHeadAsync(body, repo.dir, "plan/tasks.yaml", head));
    assert.deepEqual(actual, expected, "the awaited resolver returns the sync resolver's result, source line and read identity included");
    assert.match(actual.source ?? "", /read: plan\/tasks\.yaml@[0-9a-f]{12} \+ plan\/tasks\.d\/@[0-9a-f]{12}/);

    const absent = await withSyncSpawnsTrapped(() => resolvePlanCriteriaAtHeadAsync(body, repo.dir, "plan/tasks.yaml", "0".repeat(40)));
    assert.deepEqual(absent.criteria, []);
    assert.equal(absent.divergence?.cause, "absent-object", "an unfetched head is classified through the awaited probe");
    assert.deepEqual(await resolvePlanCriteriaAtHeadAsync("no trailer", repo.dir, "plan/tasks.yaml", head), { criteria: [] });
  } finally {
    repo.cleanup();
  }
});
