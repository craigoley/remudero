// W1-T9763: the daemon holds one parsed plan per plan revision, and its tick read never clones the plan. Before it,
// the boot sync, each lane's sync and the tick read's answer each kept their own parse (live daemon.memory
// 2026-10-16: 3 copies, 121 MiB, 6 copies during a dispatch phase) and every tick read posted a structured clone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessageChannel, type Worker } from "node:worker_threads";
import { setImmediate as nextTurn } from "node:timers/promises";
import { serialize, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { runnableCandidates } from "../src/lib/drain.js";
import { startReadPlane } from "../src/lib/read-plane.js";
import { runReadPlaneWorker } from "../src/lib/read-plane.worker.js";
import {
  GitFetchError, createPlanRevisionStore, createPlanSyncCoalescer, createTickReadProducer, daemonPlanReaders,
  planAtRevisionAsync, readPlanRevisionAsync, planSyncGitRunnerAsync, syncPlanFromOriginAsync, tickReadProducer,
} from "./helpers/run-task-daemon.js";

function task(id: string, dependsOn: string[] = []): string {
  return `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  files: [src/${id}.ts]\n` +
    `  depends_on: [${dependsOn.join(", ")}]\n  status: queued\n`;
}

/** A daemon checkout whose origin/main carries a monolith and shards; `push` lands more commits on origin/main. */
function planOrigin(shards: Record<string, string> = {}): { planPath: string; checkout: string; push: (files: Record<string, string>) => void } {
  const seed: GitRepo = gitRepo({ kind: "one-plan-seed", seedCommit: false });
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(seed.dir, path, ".."), { recursive: true });
      writeFileSync(join(seed.dir, path), text);
    }
  };
  write({ "plan/tasks.yaml": task("W1-T1") + task("W1-T2"), "plan/tasks.d/W1-T3.yaml": task("W1-T3"),
    "plan/tasks.d/W1-T4.yaml": task("W1-T4", ["W1-T3"]), ...shards });
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "plan");
  const origin = gitRepo({ kind: "one-plan-origin", bare: true });
  seed.git("push", "--quiet", origin.dir, "main");
  const checkout = gitRepo({ kind: "one-plan-checkout", cloneFrom: origin.dir }).dir;
  return {
    planPath: join(checkout, "plan", "tasks.yaml"), checkout,
    push: (files) => {
      write(files);
      seed.git("add", "-A");
      seed.git("commit", "--quiet", "-m", "more");
      seed.git("push", "--quiet", origin.dir, "main");
    },
  };
}

/** The tick-read producer's GitHub, answering an empty board. */
function emptyBoard(): { options: Parameters<typeof createTickReadProducer>[0]; io: Parameters<typeof createTickReadProducer>[1] } {
  const root = makeTempDir("one-plan-board");
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return {
    options: { owner: "o", repo: "r", config: { root, claudeBin: process.execPath } as never, ledgerPath, checkoutRoot: root },
    io: {
      fetch: (args) => {
        const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
        if (path.includes("/pulls?") || path.includes("/issues?")) return [];
        throw new Error(`unexpected read ${args.join(" ")}`);
      },
      changedFilesFetch: async () => [],
      commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
      issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [] },
      viewsDeps: { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], fetchCiFailureEvidence: () => [] },
    },
  };
}

test("W1-T9763: every daemon reader of one plan revision holds the same instance", async () => {
  const f = planOrigin();
  const readers = daemonPlanReaders(f.planPath, () => {});
  const boot = await readers.boot({});
  const lanes = createPlanSyncCoalescer(f.planPath, readers.sync);
  const [laneA, laneB] = await Promise.all([lanes.sync({}), lanes.sync({})]);
  await nextTurn();
  const laterLane = await lanes.sync({});
  const reloaded = await readers.reload();
  for (const [reader, plan] of [["lane", laneA.plan], ["second lane", laneB.plan], ["a later tick's lane", laterLane.plan],
    ["reload (the active plan and the sweep hooks' accessor)", reloaded]] as const) {
    assert.equal(plan, boot.plan, `the ${reader} holds the boot instance`);
  }
  assert.deepEqual(readers.revisions.counts(), { parsed: 1, reused: 3, held: 1, retained: 0 });

  f.push({ "README.md": "a commit that leaves the plan alone\n" });
  assert.equal((await lanes.sync({})).plan, boot.plan, "a commit outside the plan names the same revision");

  f.push({ "plan/tasks.d/W1-T5.yaml": task("W1-T5") });
  await nextTurn();
  const next = await lanes.sync({});
  assert.notEqual(next.plan, boot.plan, "a new revision is a new instance");
  assert.deepEqual(next.plan.tasks.map((t) => t.id), ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5"]);
  assert.equal(await readers.reload(), next.plan, "the reload adopts the lanes' instance of the new revision");
  assert.equal(next.plan.byId.get("W1-T3"), boot.plan.byId.get("W1-T3"), "an unchanged shard's task is one object in both");
  assert.equal(readers.revisions.counts().parsed, 2);
});

test("W1-T9763: a tick read carries the plan revision, never a plan clone", async () => {
  const f = planOrigin();
  const readers = daemonPlanReaders(f.planPath, () => {});
  const { plan } = await readers.boot({});
  const board = emptyBoard();
  // The worker's side, as runReadPlaneWorker runs it, over a real MessagePort (a real structured clone each way).
  const { port1, port2 } = new MessageChannel();
  runReadPlaneWorker(tickReadProducer(board.options, board.io, createPlanRevisionStore({ retainLatest: true })), port2);
  const posted: Array<Record<string, unknown>> = [];
  const send = port1.postMessage.bind(port1);
  const worker = Object.assign(port1, {
    postMessage: (message: { input: Record<string, unknown> }) => { posted.push(message.input); send(message); },
    terminate: async () => { port1.close(); return 0; },
  }) as unknown as Worker;
  const plane = startReadPlane({ workerUrl: new URL(import.meta.url), workerInput: {}, spawn: () => worker,
    inline: readers.inlineTickRead(board.options, board.io), log: () => {} });
  try {
    const read = readers.tickRead(plane.read);
    const generation = await read({ plan });
    assert.equal(generation.source, "worker");
    assert.equal("plan" in posted[0]!, false, "the request carries no plan");
    assert.deepEqual(posted[0]!.planRevision, readers.revisions.revisionOf(plan));
    assert.ok(serialize(posted[0]).length * 4 < serialize({ plan }).length,
      `request ${serialize(posted[0]).length} bytes vs ${serialize({ plan }).length} for the plan`);
    assert.equal(generation.facts.plan, plan, "the facts hold the daemon's own instance, not a clone back");

    const direct = await createTickReadProducer(emptyBoard().options, board.io)({ plan });
    assert.deepEqual(generation.facts.projection, direct.projection, "the worker answers the same facts");
    assert.deepEqual(generation.facts.creditCandidates, direct.creditCandidates);

    const loose = { tasks: [...plan.tasks], byId: new Map(plan.byId) };
    const legacy = await read({ plan: loose });
    assert.equal(posted.length, 2);
    assert.equal((posted[1]!.plan as { tasks: unknown[] }).tasks.length, 4, "a plan the store did not answer is posted whole");
    assert.deepEqual(legacy.facts.projection, direct.projection);
  } finally {
    await plane.stop();
    port2.close();
  }
});

test("W1-T9763: the shared plan is frozen", async () => {
  const f = planOrigin();
  const { plan } = await daemonPlanReaders(f.planPath, () => {}).boot({});
  const t4 = plan.byId.get("W1-T4")!;
  assert.throws(() => plan.tasks.push(t4), TypeError);
  assert.throws(() => { (t4 as { title: string }).title = "renamed"; }, TypeError);
  assert.throws(() => t4.depends_on.push("W1-T1"), TypeError);
  assert.throws(() => plan.byId.set("W1-T9", t4), TypeError);
  assert.throws(() => plan.byId.delete("W1-T4"), TypeError);
  // The daemon's selection reads it without writing.
  assert.deepEqual(runnableCandidates(plan, () => false, 5).map((t) => t.id), ["W1-T1", "W1-T2", "W1-T3"]);
});

test("W1-T9763: a revision no reader holds is released, and the worker's store keeps its newest", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const f = planOrigin();
  const repoDir = f.checkout;
  const runGit = planSyncGitRunnerAsync(repoDir);
  const revision = await readPlanRevisionAsync(repoDir, "plan/tasks.yaml", runGit);
  const store = createPlanRevisionStore();
  const kept = createPlanRevisionStore({ retainLatest: true });
  await planAtRevisionAsync(store, revision);
  await planAtRevisionAsync(kept, revision);
  for (let i = 0; i < 5 && store.counts().held > 0; i++) {
    await nextTurn();
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.get(revision.key), undefined, "no holder, no instance");
  assert.equal(store.counts().held, 0, "the finalizer dropped its key");
  assert.ok(kept.get(revision.key), "the worker's newest survives between ticks");
  assert.deepEqual(kept.counts(), { parsed: 1, reused: 1, held: 1, retained: 1 });
});

test("W1-T9763: a strict reader still refuses a revision that quarantined a shard", async () => {
  const f = planOrigin({ "plan/tasks.d/W1-T6.yaml": "- id: W1-T6\n  title: t\n  repo: remudero\n  type: implement\n  priority: 1\n  priority: 2\n" });
  const quarantined: string[] = [];
  const readers = daemonPlanReaders(f.planPath, (q) => quarantined.push(...q.map((x) => x.id)));
  const boot = await readers.boot({});
  assert.deepEqual(quarantined, ["W1-T6"]);
  assert.equal(boot.plan.byId.has("W1-T6"), false);
  await assert.rejects(readers.reload(), /Map keys must be unique/, "the reload stays strict");
  await assert.rejects(syncPlanFromOriginAsync(f.checkout, "plan/tasks.yaml", { revisions: readers.revisions }),
    /Map keys must be unique/, "so does a sync without a quarantine");
  const clean = planOrigin();
  const strict = await syncPlanFromOriginAsync(clean.checkout, "plan/tasks.yaml", { revisions: readers.revisions });
  assert.equal(strict.plan.tasks.length, 4, "a strict sync of a clean revision is the shared plan");
});

test("W1-T9763: a revision git cannot name or read refuses as a git fetch error", async () => {
  const f = planOrigin();
  const runGit = planSyncGitRunnerAsync(f.checkout);
  await assert.rejects(readPlanRevisionAsync(f.checkout, "plan/tasks.yaml", runGit, "origin/no-such-branch"),
    (error: unknown) => error instanceof GitFetchError && /cannot name the plan revision/.test(error.message));
  await assert.rejects(readPlanRevisionAsync(f.checkout, "plan/missing.yaml", runGit),
    (error: unknown) => error instanceof GitFetchError && /no plan at that commit/.test(error.message));
  const revision = await readPlanRevisionAsync(f.checkout, "plan/tasks.yaml", runGit);
  await assert.rejects(planAtRevisionAsync(createPlanRevisionStore(), { ...revision, key: "other", commit: "0".repeat(40) }),
    (error: unknown) => error instanceof GitFetchError && /git show 0{40}:plan\/tasks.yaml failed/.test(error.message));
});
