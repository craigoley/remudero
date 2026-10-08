import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { EMPTY_TASK_FINGERPRINTS, foldTaskFingerprints, sameTaskProjectionStamp, taskProjectionStamp } from "../src/lib/board.js";
import { fixedClock } from "../src/lib/clock.js";
import { openReadModel } from "../src/lib/read-model-db.js";
import { projectPlan, readLedgerLines, SERVE_KEEPS_CREDITS_IN_MEMORY, type StatusProjection } from "../src/lib/status.js";
import { threadPlan } from "../src/lib/thread-plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { canonicalJson, replay, replayCli, type ReplayFactory, type ReplayOptions, type ReplayStep } from "../scripts/view-replay.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const PLAN = "- id: W1-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  status: queued\n  depends_on: []\n";

function fixture(t: { after(fn: () => void): void }): ReplayOptions {
  const root = makeTempDir("view-replay");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copies = join(root, "copies");
  mkdirSync(join(copies, "plan"), { recursive: true });
  mkdirSync(join(copies, "state"));
  writeFileSync(join(copies, "plan/tasks.yaml"), PLAN);
  writeFileSync(join(copies, "state/ledger.ndjson"), "");
  writeFileSync(join(copies, "snapshot.json"), "[]");
  const db = openReadModel({ stateDir: copies, instance: "fixture", schemaVersion: 1, clock: fixedClock(NOW) });
  db.close();
  return {
    copies, directory: root, store: "read-model/fixture.v1.sqlite", ledger: "state/ledger.ndjson",
    snapshot: "snapshot.json", plan: "plan/tasks.yaml", now: NOW,
    base: { name: "unmodified", create: arm() }, arms: [{ name: "A/A", create: arm() }], steps: [],
  };
}

function arm(stale = false, changed?: "body" | "sources" | "rows"): ReplayFactory {
  return (ctx) => {
    const github = fakeGitHub();
    let fingerprints = EMPTY_TASK_FINGERPRINTS;
    let held = new Map<string, StatusProjection>();
    return {
      build() {
        const plan = threadPlan(ctx.plan);
        const live = readLedgerLines(ctx.ledger);
        const next = foldTaskFingerprints(live, fingerprints);
        const deps = {
          ledgerPath: ctx.ledger, github, readLedger: () => live, now: ctx.clock.now,
          writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY, skipUncreditedBuildWarning: true,
          reuseProjection: stale ? (task: { id: string }) =>
            sameTaskProjectionStamp(taskProjectionStamp(next, task.id), taskProjectionStamp(fingerprints, task.id))
              ? held.get(task.id) : undefined : undefined,
        };
        const projection = projectPlan(plan, deps);
        fingerprints = next;
        held = projection;
        // This surface never shows merge credit: a visible-body comparison misses the stale reuse.
        return {
          body: { tasks: plan.tasks.map((task) => task.id), ...(changed === "body" ? { changed: true } : {}) },
          sources: [{ name: "ledger:fixture", state: changed === "sources" ? "stale" : "fresh" }],
          rows: [{ step: changed === "rows" ? "different" : "built" }], projection, oracle: { plan, deps },
        };
      },
    };
  };
}

test("test/a-view-replay-finds-a-stale-reuse.test.ts: projection catches stale board reuse while unmodified, A/A and no-reuse bodies agree", async (t) => {
  const opts = fixture(t);
  const credit = JSON.stringify({ "W1-T1": { trailer: {
    source: "trailer", prUrl: "https://github.com/o/r/pull/1", prNumber: 1, prState: "MERGED",
  } } });
  opts.arms.push({ name: "board-stale", create: arm(true) }, { name: "no-reuse", create: arm() });
  opts.steps = [
    { name: "unchanged", now: NOW },
    { name: "credit changes", now: NOW + 1_000, changes: [{ path: "state/merge-credit.json", kind: "write", data: credit }] },
    { name: "credit unreadable", now: NOW + 2_000, changes: [{ path: "state/merge-credit.json", kind: "write", data: "{broken" }] },
    { name: "credit recovers", now: NOW + 3_000, changes: [{ path: "state/merge-credit.json", kind: "write", data: credit }] },
    { name: "credit missing", now: NOW + 4_000, changes: [{ path: "state/merge-credit.json", kind: "remove" }] },
  ];
  const result = await replay(opts);
  assert.equal(result.ok, false);
  assert.deepEqual(result.divergences.map((d) => [d.step, d.arm, d.surface]), [
    ["credit changes", "board-stale", "projection"], ["credit recovers", "board-stale", "projection"],
  ]);
  assert.equal(result.noArgDates, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(result.root, "report.json"), "utf8")), result);
  const changed = result.divergences[0]!;
  assert.equal(JSON.parse(changed.expected)["W1-T1"].merged, true, "positive control: the oracle read the changed credit");
  assert.equal(JSON.parse(changed.actual)["W1-T1"].merged, false);
  assert.equal(readFileSync(join(opts.copies, "state/ledger.ndjson"), "utf8"), "", "the seed stays untouched");
});

test("each body, sources and logged-row divergence is reported against the unmodified arm", async (t) => {
  const opts = fixture(t);
  opts.arms = ["body", "sources", "rows"].map((surface) => ({ name: surface, create: arm(false, surface as "body" | "sources" | "rows") }));
  const result = await replay(opts);
  assert.deepEqual(result.divergences.map((d) => [d.arm, d.surface]), [["body", "body"], ["sources", "sources"], ["rows", "rows"]]);
});

test("the unmodified arm is also checked against the no-reuse oracle", async (t) => {
  const opts = fixture(t);
  opts.base.create = arm(true);
  opts.arms = [];
  opts.steps = [{ name: "credit", now: NOW + 1, changes: [{ path: "state/merge-credit.json", kind: "write", data:
    JSON.stringify({ "W1-T1": { trailer: { source: "trailer", prUrl: "https://github.com/o/r/pull/1", prNumber: 1, prState: "MERGED" } } }) }] }];
  const result = await replay(opts);
  assert.deepEqual(result.divergences.map((d) => [d.arm, d.surface]), [["unmodified", "projection"]]);
});

test("simulated Date.now and no-argument Date agree and implicit dates are counted as clock leaks", async (t) => {
  const opts = fixture(t);
  const original = Date;
  const seen: number[] = [];
  const clean = arm();
  opts.arms = [{ name: "implicit-clock", create: async (ctx) => {
    const delegate = await clean(ctx);
    return { build: async () => {
      await Promise.resolve();
      seen.push(Date.now(), new Date().getTime(), Date.parse(Date()), new Date(0).getTime());
      return delegate.build();
    } };
  } }];
  opts.steps = [{ name: "later", now: NOW + 60_000 }];
  const result = await replay(opts);
  assert.deepEqual(seen, [NOW, NOW, NOW, 0, NOW + 60_000, NOW + 60_000, NOW + 60_000, 0]);
  assert.equal(result.noArgDates, 4);
  assert.deepEqual(result.steps.map((step) => step.noArgDates), [
    { unmodified: 0, "implicit-clock": 2, setup: 0 }, { unmodified: 0, "implicit-clock": 2 },
  ]);
  assert.equal(result.ok, false, "clock leaks fail even when every comparison agrees");
  assert.equal(result.divergences.length, 0);
  assert.equal(Date, original, "global Date is restored");
});

test("explicit time follows run liveness boundaries without a real-clock read", async (t) => {
  const opts = fixture(t);
  writeFileSync(join(opts.copies, opts.ledger), `${JSON.stringify({ step: "run.start", task_id: "W1-T1", run_id: "r1", ts: new Date(NOW - 1_000).toISOString() })}\n`);
  opts.steps = [{ name: "run goes quiet", now: NOW + 3_600_000 }];
  const statuses: string[] = [];
  const clean = arm();
  opts.base.create = async (ctx) => {
    const delegate = await clean(ctx);
    return { build: async () => {
      const build = await delegate.build();
      statuses.push(build.projection.get("W1-T1")!.status);
      return build;
    } };
  };
  const result = await replay(opts);
  assert.equal(result.ok, true);
  assert.equal(result.noArgDates, 0);
  assert.equal(statuses[0], "running");
  assert.notEqual(statuses[1], "running");
});

test("implicit dates during factory setup and cleanup also fail the replay", async (t) => {
  const opts = fixture(t);
  const original = Date;
  opts.base.create = async (ctx) => {
    assert.equal(new Date().getTime(), NOW);
    const delegate = await arm()(ctx);
    return { ...delegate, close: () => { assert.equal(new Date().getTime(), NOW); } };
  };
  const result = await replay(opts);
  assert.equal(result.ok, false);
  assert.equal(result.noArgDates, 2);
  assert.equal(result.steps[0]!.noArgDates.setup, 1);
  assert.deepEqual(result.divergences, []);
  assert.equal(Date, original);
});

test("canonical JSON sorts objects and Maps, preserves arrays and compares elapsed fields", () => {
  assert.equal(canonicalJson(new Map<string, unknown>([["b", { z: 2, a: 1 }], ["a", 0]])), '{"a":0,"b":{"a":1,"z":2}}');
  assert.equal(canonicalJson({ b: 2, a: [2, 1] }), '{"a":[2,1],"b":2}');
  assert.notEqual(canonicalJson({ elapsedMs: 1 }), canonicalJson({ elapsedMs: 2 }));
  assert.equal(canonicalJson({ at: new Date(NOW) }), '{"at":"2026-10-07T12:00:00.000Z"}');
  assert.throws(() => canonicalJson(new Map([[1, "value"]])), /string keys/);
});

test("serving paths, hardlinks, symlinks and unfinished WAL copies are refused before loading arms", async (t) => {
  const opts = fixture(t);
  const realStore = join(opts.copies, opts.store);
  const serving = join(opts.directory, "state");
  mkdirSync(serving);
  await assert.rejects(replay({ ...opts, copies: serving }), /serving/);
  symlinkSync(realStore, join(opts.copies, "linked.sqlite"));
  await assert.rejects(replay({ ...opts, store: "linked.sqlite" }), /symlink/);
  rmSync(join(opts.copies, "linked.sqlite"));
  linkSync(realStore, join(opts.copies, "hardlink.sqlite"));
  await assert.rejects(replay(opts), /hardlink/);
  rmSync(join(opts.copies, "hardlink.sqlite"));
  writeFileSync(`${realStore}-wal`, "not a checkpointed copy");
  await assert.rejects(replay(opts), /WAL/);
});

test("changes cannot escape the work root and Date is restored after an arm throws", async (t) => {
  const opts = fixture(t);
  const original = Date;
  const badSteps = [{ name: "escape", now: NOW, changes: [{ path: "../escape", kind: "write", data: "bad" }] }] as ReplayStep[];
  await assert.rejects(replay({ ...opts, steps: badSteps }), /escape/);
  await assert.rejects(replay({ ...opts, arms: [{ name: "throws", create: () => ({ build: () => { throw new Error("arm failed"); } }) }] }), /arm failed/);
  assert.equal(Date, original);
  await assert.rejects(replay({ ...opts, steps: [{ name: "invalid clock", now: Number.NaN }] }), /clock/);
  await assert.rejects(replay({ ...opts, arms: [{ name: "unmodified", create: arm() }] }), /unique/);
  await assert.rejects(replay({ ...opts, directory: opts.copies }), /outside the seed/);
});

test("a work-directory alias into the seed is refused before creating a replay root", async (t) => {
  const opts = fixture(t);
  const alias = join(opts.directory, "seed-alias");
  symlinkSync(opts.copies, alias);
  await assert.rejects(replay({ ...opts, directory: alias }), /outside the seed/);
  await assert.rejects(replay({ ...opts, directory: join(alias, "new-directory") }), /outside the seed/);
  await assert.rejects(replay({ ...opts, directory: join(opts.copies, "another-directory") }), /outside the seed/);
  assert.deepEqual(readdirSync(opts.copies).sort(), ["plan", "read-model", "snapshot.json", "state"]);
});

test("an arm cannot redirect a scripted change through a symlink", async (t) => {
  const opts = fixture(t);
  opts.base.create = async (ctx) => {
    symlinkSync(opts.copies, join(ctx.root, "escape"));
    return arm()(ctx);
  };
  opts.steps = [{ name: "redirect", now: NOW, changes: [{ path: "escape/snapshot.json", kind: "write", data: "bad" }] }];
  await assert.rejects(replay(opts), /change targets a symlink/);
  assert.equal(readFileSync(join(opts.copies, opts.snapshot), "utf8"), "[]");
});

test("invalid arm outputs and malformed mutations fail with their reason and restore Date", async (t) => {
  const opts = fixture(t);
  const original = Date;
  for (const [create, reason] of [
    [() => ({}), /must return build/],
    [() => ({ build: () => ({}) }), /must expose body, sources and rows/],
    [() => ({ build: () => ({ body: {}, sources: [], rows: [] }) }), /must expose projection and oracle inputs/],
  ] as const) {
    await assert.rejects(replay({ ...opts, base: { name: "invalid", create: create as unknown as ReplayFactory } }), reason);
    assert.equal(Date, original);
  }
  await assert.rejects(replay({ ...opts, steps: [{ name: "bad write", now: NOW, changes: [{ path: opts.snapshot, kind: "write" }] }] }), /invalid change/);
  assert.equal(Date, original);
});

test("each arm owns a writable store copy and sees the same scripted inputs", async (t) => {
  const opts = fixture(t);
  opts.directory = join(opts.directory, "runs", "nested");
  const seedStore = readFileSync(join(opts.copies, opts.store));
  const builds: Array<{ arm: string; rows: unknown[]; snapshot: unknown; tasks: string[] }> = [];
  const roots: string[] = [];
  const create = (name: string): ReplayFactory => async (ctx) => {
    roots.push(ctx.root);
    const db = openReadModel({ stateDir: ctx.root, instance: "fixture", schemaVersion: 1, clock: ctx.clock });
    db.exec("CREATE TABLE replay_builds(instant INTEGER)");
    const delegate = await arm()(ctx);
    return {
      build: async () => {
        db.prepare("INSERT INTO replay_builds VALUES (?)").run(ctx.clock.now());
        const build = await delegate.build();
        const snapshot = JSON.parse(readFileSync(ctx.snapshot, "utf8"));
        const rows = db.prepare("SELECT instant FROM replay_builds ORDER BY instant").all().map((row) => ({ instant: row.instant }));
        builds.push({ arm: name, rows, snapshot, tasks: build.oracle.plan.tasks.map((task) => task.id) });
        return { ...build, body: { snapshot, tasks: build.oracle.plan.tasks.map((task) => task.id) }, rows };
      },
      close: () => db.close(),
    };
  };
  opts.base.create = create("unmodified");
  opts.arms = [{ name: "A/A", create: create("A/A") }, { name: "no-reuse", create: create("no-reuse") }];
  opts.steps = [{ name: "inputs move", now: NOW + 1_000, changes: [
    { path: "extra", kind: "mkdir" },
    { path: opts.snapshot, kind: "write", data: '[{"head":"run-W1-T1-1"}]' },
    { path: opts.plan, kind: "append", data: PLAN.replace("W1-T1", "W1-T2") },
    { path: opts.ledger, kind: "append", data: JSON.stringify({ step: "run.start", task_id: "W1-T1", ts: new Date(NOW).toISOString() }) + "\n" },
  ] }];
  const result = await replay(opts);
  assert.equal(result.ok, true);
  assert.equal(result.noArgDates, 0);
  assert.deepEqual(result.divergences, []);
  assert.equal(join(result.root, ".."), opts.directory);
  assert.equal(new Set(roots).size, 3);
  assert.deepEqual(builds.slice(3).map(({ arm: name, ...build }) => build), Array(3).fill({
    rows: [{ instant: NOW }, { instant: NOW + 1_000 }], snapshot: [{ head: "run-W1-T1-1" }], tasks: ["W1-T1", "W1-T2"],
  }));
  assert.deepEqual(readFileSync(join(opts.copies, opts.store)), seedStore);
  assert.equal(readFileSync(join(opts.copies, opts.snapshot), "utf8"), "[]");
  assert.equal(readFileSync(join(opts.copies, opts.plan), "utf8"), PLAN);
  assert.equal(readFileSync(join(opts.copies, opts.ledger), "utf8"), "");
});

test("command-line modules load independent factories and emit a report with a failing exit for drift", async (t) => {
  const opts = fixture(t);
  const modulePath = join(opts.directory, "arm.mjs");
  const statusUrl = pathToFileURL(join(process.cwd(), "src/lib/status.ts")).href;
  const planUrl = pathToFileURL(join(process.cwd(), "src/lib/thread-plan.ts")).href;
  const githubUrl = pathToFileURL(join(process.cwd(), "test/helpers/fake-github.ts")).href;
  writeFileSync(modulePath, `import {projectPlan, SERVE_KEEPS_CREDITS_IN_MEMORY} from ${JSON.stringify(statusUrl)};
import {threadPlan} from ${JSON.stringify(planUrl)};
import {fakeGitHub} from ${JSON.stringify(githubUrl)};
export function createReplayArm(ctx) { let n = 0; return {build() {
const plan = threadPlan(ctx.plan);
const deps = {ledgerPath: ctx.ledger, github: fakeGitHub(), now: ctx.clock.now, writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY};
return {body: {n: ++n}, sources: [], rows: [], projection: projectPlan(plan, deps), oracle: {plan, deps}};
}}; }
`);
  const steps = join(opts.directory, "steps.json");
  writeFileSync(steps, JSON.stringify([{ name: "again", now: NOW + 1 }]));
  const output: string[] = [];
  const argv = ["--copies", opts.copies, "--directory", opts.directory, "--store", opts.store, "--ledger", opts.ledger,
    "--snapshot", opts.snapshot, "--plan", opts.plan, "--now", String(NOW), "--steps", steps, "--base", modulePath, "--arm", `A/A=${modulePath}`];
  assert.equal(await replayCli(argv, (line) => output.push(line)), 0);
  assert.equal(JSON.parse(output[0]!).ok, true);
  assert.equal(JSON.parse(output[0]!).steps.length, 2);
  const driftPath = join(opts.directory, "drift.mjs");
  writeFileSync(driftPath, `import {createReplayArm as clean} from ${JSON.stringify(pathToFileURL(modulePath).href)};
export function createReplayArm(ctx) { const arm = clean(ctx); return {build() { return {...arm.build(), body: {drift: true}}; }}; }
`);
  const driftOutput: string[] = [];
  assert.equal(await replayCli([...argv, "--arm", `drift=${driftPath}`], (line) => driftOutput.push(line)), 1);
  assert.deepEqual(JSON.parse(driftOutput[0]!).divergences.map((d: { surface: string }) => d.surface), ["body", "body"]);
  writeFileSync(modulePath + ".bad.mjs", "export function createReplayArm() { return {build() { throw new Error('bad module'); }}; }");
  const badOutput: string[] = [];
  assert.equal(await replayCli([...argv, "--arm", `bad=${modulePath}.bad.mjs`], (line) => badOutput.push(line)), 2);
  assert.match(badOutput[0]!, /bad module/);
});
