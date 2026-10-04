import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  deployStateRows, mainWorkflowStateRows, reconcileFleetState,
  type DeployStateReader, type FleetStateRow, type MainWorkflowStateReader,
} from "../src/lib/state-reconciler.js";
import { parseWorkflowPushTrigger } from "../src/lib/main-run-gaps.js";
import { deployMarkerPath } from "../src/lib/deployer.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects, runSweep, type BuildSweepEffectsDeps } from "../src/lib/sweep.js";

test("W1-T4840: a gap between desired and observed state is repaired once and recorded", async () => {
  const ledger: Record<string, unknown>[] = [];
  let observed = false;
  let repairs = 0;
  const row: FleetStateRow = {
    pipeline: "image", target: "baked-sha", desired: "published image containing baked-sha",
    observe: () => observed,
    repair: () => { repairs++; observed = true; },
  };
  const pass = () => reconcileFleetState([row], ledger, (record) => ledger.push(record), () => assert.fail("closed gaps do not escalate"));
  await pass();
  await pass();
  assert.equal(observed, true, "removing the repair leaves the gap open");
  assert.equal(repairs, 1);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.step, "reconcile.repaired");
  assert.equal(ledger[0]?.pipeline, "image");
  assert.equal(ledger[0]?.target, "baked-sha");
  assert.equal(ledger[0]?.desired, row.desired);
  assert.equal(ledger[0]?.observed, false);
});

test("W1-T4840: a gap its repair did not close escalates once", async () => {
  const ledger: Record<string, unknown>[] = [];
  const escalations: Record<string, unknown>[] = [];
  let repairs = 0;
  const row: FleetStateRow = {
    pipeline: "ci", target: "main-sha", desired: "workflow run",
    observe: () => false,
    repair: () => { repairs++; },
  };
  for (let cycle = 0; cycle < 4; cycle++) {
    await reconcileFleetState([row], [...ledger], (record) => ledger.push(record), (gap) => {
      assert.equal(ledger.at(-1)?.step, "reconcile.escalated", "the decision is recorded before notifying its owner");
      escalations.push(gap);
    });
  }
  assert.equal(repairs, 1);
  assert.deepEqual(ledger.map((r) => r.step), ["reconcile.repaired", "reconcile.escalated"]);
  assert.equal(ledger[1]?.target, "main-sha");
  assert.match(String(ledger[1]?.reason), /persist/);
  assert.deepEqual(escalations, [ledger[1]], "the owner receives exactly the newly recorded escalation");
});

test("W1-T4840: healthy, unknown and active states authorize no repair or escalation", async () => {
  for (const observed of [true, undefined, false]) {
    const ledger: Record<string, unknown>[] = [];
    const row: FleetStateRow = {
      pipeline: "image", target: "baked", desired: "image", observe: () => observed,
      inFlight: () => true, repair: () => assert.fail("no authorized repair"),
    };
    await reconcileFleetState([row], ledger, (e) => ledger.push(e));
    assert.equal(ledger.length, 0);
    row.inFlight = () => undefined;
    await reconcileFleetState([row], ledger, (e) => ledger.push(e));
    assert.equal(ledger.length, 0);
  }
});

test("W1-T4840: unreadable observations and refused repairs preserve the reason", async () => {
  const ledger: Record<string, unknown>[] = [];
  let readsFail = true;
  let attempts = 0;
  const row: FleetStateRow = {
    pipeline: "ci", target: "sha", desired: "ci run",
    observe: () => { if (readsFail) throw new Error("read refused"); return false; },
    repair: () => { attempts++; throw new Error("dispatch refused"); },
  };
  await reconcileFleetState([row], ledger, (e) => ledger.push(e));
  assert.equal(ledger[0]?.step, "reconcile.unreadable");
  assert.equal(ledger[0]?.reason, "read refused");
  assert.equal(attempts, 0);
  readsFail = false;
  await reconcileFleetState([row], ledger, (e) => ledger.push(e));
  assert.equal(ledger[1]?.step, "reconcile.repair_failed");
  assert.equal(ledger[1]?.reason, "dispatch refused");
  await reconcileFleetState([row], ledger, (e) => ledger.push(e));
  assert.equal(attempts, 1);
  assert.equal(ledger[2]?.step, "reconcile.escalated");
});

test("W1-T4840: duplicate rows, restarts and new targets preserve at-most-once repair", async () => {
  const ledger: Record<string, unknown>[] = [];
  let repairs = 0;
  const row: FleetStateRow = {
    pipeline: "image", target: "first", desired: "image", observe: () => false, repair: () => { repairs++; },
  };
  await reconcileFleetState([row, row], ledger, (e) => ledger.push(e));
  assert.equal(repairs, 1);
  assert.deepEqual(ledger.map((e) => e.step), ["reconcile.repaired"]);
  await reconcileFleetState([{ ...row }], JSON.parse(JSON.stringify(ledger)), (e) => ledger.push(e));
  assert.equal(repairs, 1);
  await reconcileFleetState([{ ...row, target: "second" }], ledger, (e) => ledger.push(e));
  assert.equal(repairs, 2);
});

const ciTrigger = parseWorkflowPushTrigger("ci.yml", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");

function mainReader(overrides: Partial<MainWorkflowStateReader> = {}): MainWorkflowStateReader {
  return {
    listMainCommits: async () => [
      { sha: "head", parents: ["gap"] }, { sha: "gap", parents: ["older"] }, { sha: "older", parents: [] },
    ],
    countRunsForSha: async (sha) => sha === "gap" ? 0 : 1,
    changedFiles: async () => ["src/lib/example.ts"],
    countWorkflowRuns: async (sha) => sha === "gap" ? 0 : 1,
    dispatch: () => {},
    ...overrides,
  };
}

test("W1-T4840: a covering dispatch closes a lost main workflow and is never repeated", async () => {
  const ledger: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let dispatchedRun = false;
  const reader = mainReader({
    countWorkflowRuns: async (sha) => sha === "older" || (sha === "head" && dispatchedRun) ? 1 : 0,
    dispatch: (workflow) => { calls.push(workflow); dispatchedRun = true; },
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    const rows = await mainWorkflowStateRows(reader, [ciTrigger], ledger, 15);
    await reconcileFleetState(rows, ledger, (e) => ledger.push(e));
  }
  assert.deepEqual(calls, ["ci.yml"]);
  assert.deepEqual(ledger.map((e) => e.step), ["reconcile.repaired"]);
  assert.equal(ledger[0]?.commit, "gap");
  assert.equal(ledger[0]?.head, "head");
});

test("W1-T4840: another workflow's run is not evidence CI ran", async () => {
  const ledger: Record<string, unknown>[] = [];
  const reader = mainReader({ countRunsForSha: async () => 1 });
  const rows = await mainWorkflowStateRows(reader, [ciTrigger], ledger, 15);
  await reconcileFleetState(rows, ledger, (e) => ledger.push(e));
  assert.equal(ledger[0]?.target, "gap:ci.yml");
  assert.equal(ledger[0]?.step, "reconcile.repaired");
});

test("W1-T4840: a covering dispatch that never creates a run escalates once", async () => {
  const ledger: Record<string, unknown>[] = [];
  let calls = 0;
  const reader = mainReader({
    dispatch: () => { calls++; }, countWorkflowRuns: async (sha) => sha === "older" ? 1 : 0,
  });
  for (let cycle = 0; cycle < 4; cycle++) {
    await reconcileFleetState(await mainWorkflowStateRows(reader, [ciTrigger], ledger, 15), ledger, (e) => ledger.push(e));
  }
  assert.equal(calls, 1);
  assert.deepEqual(ledger.map((e) => e.step), ["reconcile.repaired", "reconcile.escalated"]);
});

test("W1-T4840: main in flight, unknown counts and unknown paths are not gaps", async () => {
  const cases: Partial<MainWorkflowStateReader>[] = [
    { listMainCommits: async () => [] },
    { countRunsForSha: async () => 0 },
    { countRunsForSha: async () => undefined },
    { changedFiles: async () => undefined },
  ];
  for (const override of cases) assert.deepEqual(await mainWorkflowStateRows(mainReader(override), [ciTrigger], [], 15), []);
  const rows = await mainWorkflowStateRows(mainReader({ countWorkflowRuns: async () => undefined }), [ciTrigger], [], 15);
  const events: Record<string, unknown>[] = [];
  await reconcileFleetState(rows, [], (e) => events.push(e));
  assert.deepEqual(events, []);
});

test("W1-T4840: multiple lost commits share one dispatch, including a refused dispatch", async () => {
  for (const refuse of [false, true]) {
    let calls = 0;
    const ledger: Record<string, unknown>[] = [];
    const reader = mainReader({
      countWorkflowRuns: async () => 0,
      dispatch: () => { calls++; if (refuse) throw new Error("rate limited"); },
    });
    const rows = await mainWorkflowStateRows(reader, [ciTrigger], [], 15);
    await reconcileFleetState(rows, [], (e) => ledger.push(e));
    assert.equal(calls, 1);
    assert.equal(ledger.length, 2);
    assert.ok(ledger.every((e) => e.step === (refuse ? "reconcile.repair_failed" : "reconcile.repaired")));
  }
});

const healthy = [{ step: "deploy.ok", ts: "2026-09-30T12:00:00.000Z" }];

function deployReader(): DeployStateReader & { published: boolean | undefined; behind: number | undefined; failure: number | undefined; builds: number; requests: number; clears: number; active: boolean | undefined; requested: boolean } {
  const world = {
    published: false as boolean | undefined, behind: 1 as number | undefined,
    failure: Date.parse("2026-09-29T12:00:00.000Z") as number | undefined,
    builds: 0, requests: 0, clears: 0, active: false as boolean | undefined, requested: false,
  };
  return Object.assign(world, {
    deploy: {
      newestBakedSha: () => "baked", imagePublished: () => world.published,
      imageBuildInFlight: () => world.active, imageBakedCommitsBehind: () => world.behind,
      dispatchImageBuild: () => { world.builds++; },
    },
    requestDeploy: () => { world.requests++; world.requested = true; },
    deployRequested: () => world.requested,
    failedAt: () => world.failure,
    clearFailure: (at: number) => { if (world.failure === at) { world.clears++; world.failure = undefined; } },
  });
}

test("W1-T4840: image, deploy and stale failure latch converge through the same table", async () => {
  const reader = deployReader();
  const ledger: Record<string, unknown>[] = [...healthy];
  const pass = () => reconcileFleetState(deployStateRows(reader, ledger), ledger, (e) => ledger.push(e));
  await pass();
  assert.equal(reader.builds, 1);
  assert.equal(reader.clears, 1);
  assert.equal(reader.failure, undefined);
  assert.equal(reader.requests, 0, "deploy waits for a containing published image");
  reader.published = true;
  await pass();
  assert.equal(reader.requests, 1);
  reader.behind = 0;
  await pass();
  assert.equal(reader.builds, 1);
  assert.equal(reader.requests, 1);
  assert.deepEqual(ledger.filter((e) => e.step === "reconcile.repaired").map((e) => e.pipeline), ["image", "failure-latch", "deploy"]);
  assert.equal(ledger.filter((e) => e.step === "reconcile.escalated").length, 0);
});

test("W1-T4840: missing, equal, newer and malformed health evidence never clears a latch", () => {
  const reader = deployReader();
  for (const history of [[], [{ step: "deploy.ok", ts: "invalid" }], [{ step: "deploy.ok", ts: "2026-09-29T12:00:00.000Z" }]]) {
    assert.ok(deployStateRows(reader, history).every((r) => r.pipeline !== "failure-latch"));
  }
  reader.failure = Date.parse("2026-10-01T00:00:00.000Z");
  assert.ok(deployStateRows(reader, healthy).every((r) => r.pipeline !== "failure-latch"));
  reader.failure = undefined;
  assert.ok(deployStateRows(reader, healthy).every((r) => r.pipeline !== "failure-latch"));
});

test("W1-T4840: unknown deploy readings never become absence and a fresh latch is preserved", async () => {
  const reader = deployReader();
  const rows = deployStateRows(reader, healthy);
  reader.failure = Date.parse("2026-10-01T00:00:00.000Z");
  reader.published = undefined;
  reader.behind = undefined;
  const ledger: Record<string, unknown>[] = [];
  await reconcileFleetState(rows, [], (e) => ledger.push(e));
  assert.equal(ledger.length, 0);
  assert.equal(reader.clears, 0);
  reader.published = true;
  reader.behind = 1;
  reader.requested = true;
  await reconcileFleetState(deployStateRows(reader, healthy), [], (e) => ledger.push(e));
  assert.equal(reader.requests, 0, "an existing request is retained");
});

test("W1-T4840: a persistent deploy request becomes one incident, without another request", async () => {
  const reader = deployReader();
  reader.published = true;
  reader.failure = undefined;
  const ledger: Record<string, unknown>[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await reconcileFleetState(deployStateRows(reader, ledger), ledger, (e) => ledger.push(e));
  }
  assert.equal(reader.requests, 1);
  assert.deepEqual(ledger.map((e) => e.step), ["reconcile.repaired", "reconcile.escalated"]);
});

test("W1-T4840: a manual image recycle opt-out does not become an automatic deploy request", async () => {
  const reader = deployReader();
  reader.published = true;
  reader.failure = undefined;
  reader.deploy = { ...reader.deploy, imageRecycleManual: () => true };
  const events: Record<string, unknown>[] = [];
  await reconcileFleetState(deployStateRows(reader, []), [], (e) => events.push(e));
  assert.equal(reader.requests, 0);
  assert.equal(events.length, 0);
});

test("W1-T4840: sweep owns reconciliation, skips light and dry passes, and emits one incident", async () => {
  const ledger: Record<string, unknown>[] = [];
  let reads = 0;
  let repairs = 0;
  const pass = (dryRun = false, light = false) => runSweep([], {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/dev/null/ledger.ndjson", runId: "t4840", dryRun,
    repairAdmissionSurface: light ? "light" : undefined,
    readLedger: () => [...ledger], appendLine: (_p, e) => { ledger.push(e); },
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set<string>(), runningLong: new Set<string>() }),
    readFleetState: async () => {
      reads++;
      return { history: [...ledger], rows: [{ pipeline: "ci", target: "gap", desired: "run", observe: () => false, repair: () => { repairs++; } }] };
    },
    reconcileMainRunGaps: async () => assert.fail("the old loop must not run alongside the table"),
  }, DEFAULT_SWEEP_POLICY);
  await pass(true);
  await pass(false, true);
  assert.equal(reads, 0);
  for (let cycle = 0; cycle < 3; cycle++) await pass();
  assert.equal(repairs, 1);
  assert.equal(ledger.filter((e) => e.step === "reconcile.escalated").length, 1);
  assert.equal(ledger.filter((e) => e.step === "incident.event").length, 1);
  assert.equal(ledger.find((e) => e.step === "incident.event")?.kind, "invariant");
  const escalation = ledger.findIndex((e) => e.step === "reconcile.escalated");
  const incident = ledger.findIndex((e) => e.step === "incident.event");
  assert.ok(incident > escalation, "the incident follows its recorded escalation");
  assert.equal(ledger[incident]?.name, "reconcile.ci");
  assert.equal(ledger[incident]?.message, "run: gap persists after its repair attempt (gap)");
  assert.equal(ledger[incident]?.fingerprint, createHash("sha256").update(JSON.stringify(["ci", "gap"])).digest("hex"));
});

test("W1-T4840: an unreadable fleet snapshot does not fail the sweep", async () => {
  const logs: Record<string, unknown>[] = [];
  await runSweep([], {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/dev/null/ledger.ndjson", runId: "t4840", readLedger: () => [], appendLine: () => {},
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set<string>(), runningLong: new Set<string>() }),
    readFleetState: async () => { throw new Error("unreadable snapshot"); },
    log: (step, data) => { logs.push({ step, ...data }); },
  }, DEFAULT_SWEEP_POLICY);
  assert.ok(logs.some((e) => e.step === "reconcile.unreadable" && e.reason === "unreadable snapshot"));
});

test("W1-T4840: the production effect reads main state and ledger history before dispatching", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-state-"));
  try {
    mkdirSync(join(root, "state"));
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const posts: string[][] = [];
    const reads: string[] = [];
    const deploy = deployReader();
    deploy.published = true;
    deploy.behind = 0;
    deploy.failure = undefined;
    const effects = buildSweepEffects({
      owner: "acme", repo: "widgets", repoRoot: join(import.meta.dirname, ".."),
      config: { root } as never, ledgerPath, runId: "t4840", plan: { tasks: [], byId: new Map() } as never,
      policy: DEFAULT_SWEEP_POLICY, log: () => {}, fleetDeployStateImpl: deploy,
      readJsonImpl: async (args) => {
        const endpoint = args[1]!;
        reads.push(endpoint);
        if (endpoint.includes("commits?")) return [{ sha: "head", parents: [{ sha: "gap" }] }, { sha: "gap", parents: [] }];
        if (endpoint.includes("/commits/")) return { files: [{ filename: "src/lib/example.ts" }] };
        return { total_count: endpoint.includes("head_sha=gap") ? 0 : 1 };
      },
      ghRunImpl: (_file, args) => { posts.push([...args]); },
    });
    const state = await effects.readFleetState!([]);
    const events: Record<string, unknown>[] = [];
    await reconcileFleetState(state.rows, state.history, (e) => events.push(e));
    assert.ok(posts.some((args) => args.some((a) => a.endsWith("/ci.yml/dispatches"))));
    assert.ok(posts.every((args) => args.includes("ref=main")));
    assert.ok(reads.some((e) => e.includes("/workflows/ci.yml/runs?")));
    assert.ok(events.some((e) => e.step === "reconcile.repaired" && e.commit === "gap"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixtureEffects(root: string, overrides: Partial<BuildSweepEffectsDeps> = {}) {
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, "");
  return buildSweepEffects({
    owner: "acme", repo: "widgets", repoRoot: join(import.meta.dirname, ".."),
    config: { root } as never, ledgerPath, runId: "t4840", plan: { tasks: [], byId: new Map() } as never,
    policy: DEFAULT_SWEEP_POLICY, log: () => {}, readJsonImpl: async () => [], ghRunImpl: () => {},
    ...overrides,
  });
}

test("W1-T4840: repairs survive plain and gzip rotations and incomplete history refuses effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-rotations-"));
  try {
    const reader = deployReader();
    reader.failure = undefined;
    const events: Record<string, unknown>[] = [];
    await reconcileFleetState(deployStateRows(reader, []), [], (e) => events.push(e));
    const effects = fixtureEffects(root, { fleetDeployStateImpl: reader });
    const plain = join(root, "state", "ledger.1.ndjson");
    const gzip = join(root, "state", "ledger.2.ndjson.gz");
    writeFileSync(plain, JSON.stringify(events[0]) + "\n");
    writeFileSync(gzip, gzipSync(JSON.stringify({ step: "deploy.ok", ts: healthy[0]!.ts }) + "\n"));
    const snapshot = await effects.readFleetState!([]);
    assert.ok(snapshot.history.some((e) => e.step === "reconcile.repaired"), "plain archive was read");
    assert.ok(snapshot.history.some((e) => e.step === "deploy.ok"), "gzip archive was read");
    await reconcileFleetState(snapshot.rows, snapshot.history, (e) => events.push(e));
    assert.equal(reader.builds, 1);
    assert.equal(events[1]?.step, "reconcile.escalated");
    writeFileSync(plain, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const afterEscalation = await effects.readFleetState!([]);
    await reconcileFleetState(afterEscalation.rows, afterEscalation.history, (e) => events.push(e), () => assert.fail("archived escalation must not notify twice"));
    assert.equal(reader.builds, 1);
    assert.equal(events.length, 2, "archived escalation suppresses duplicate records");
    writeFileSync(gzip, "not gzip");
    await assert.rejects(effects.readFleetState!([]), /history unreadable/);
    rmSync(gzip);
    writeFileSync(join(root, "state", "ledger.unclassified"), "unknown form");
    await assert.rejects(effects.readFleetState!([]), /history unreadable/);
    assert.equal(reader.builds, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4840: the real default adapter clears an old latch and preserves a fresh failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-real-default-"));
  try {
    const effects = fixtureEffects(root);
    const failure = join(root, "state", "DEPLOY_FAILED");
    const failedHead = join(root, "state", "DEPLOY_LAST_FAILED");
    writeFileSync(failure, JSON.stringify({ at: "2026-09-29T12:00:00.000Z" }));
    writeFileSync(failedHead, "old-head");
    writeFileSync(join(root, "state", "ledger.ndjson"), JSON.stringify(healthy[0]) + "\n");
    const snapshot = await effects.readFleetState!([]);
    const events: Record<string, unknown>[] = [];
    await reconcileFleetState(snapshot.rows, snapshot.history, (e) => events.push(e));
    assert.equal(existsSync(failure), false);
    assert.equal(existsSync(failedHead), false);
    assert.equal(events[0]?.pipeline, "failure-latch");
    writeFileSync(failure, JSON.stringify({ at: "2026-09-29T12:00:00.000Z" }));
    writeFileSync(failedHead, "old-head");
    const staleSnapshot = await effects.readFleetState!([]);
    writeFileSync(failure, JSON.stringify({ at: "2026-10-01T12:00:00.000Z" }));
    writeFileSync(failedHead, "fresh-head");
    await staleSnapshot.rows.find((r) => r.pipeline === "failure-latch")!.repair();
    assert.equal(readFileSync(failedHead, "utf8"), "fresh-head");
    writeFileSync(failure, "not json");
    const logs: Record<string, unknown>[] = [];
    const unreadable = fixtureEffects(root, { log: (step, data) => { logs.push({ step, ...data }); } });
    const refused = await unreadable.readFleetState!([]);
    assert.equal(refused.rows.length, 0);
    assert.ok(logs.some((e) => e.step === "reconcile.unreadable" && e.pipeline === "failure-latch"));
    assert.equal(readFileSync(failedHead, "utf8"), "fresh-head");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4840: failed main reads leave the independent deploy and latch rows available", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-independent-"));
  try {
    const logs: Record<string, unknown>[] = [];
    const effects = fixtureEffects(root, {
      fleetDeployStateImpl: deployReader(), readJsonImpl: async () => { throw new Error("REST unavailable"); },
      log: (step, data) => { logs.push({ step, ...data }); },
    });
    const snapshot = await effects.readFleetState!([]);
    assert.deepEqual(snapshot.rows.map((r) => r.pipeline), ["image", "deploy"]);
    assert.ok(logs.some((e) => e.pipeline === "ci" && e.reason === "REST unavailable"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4840: an unreadable latch preserves the reason and does not block an image repair", async () => {
  const reader = deployReader();
  reader.failedAt = () => { throw new Error("latch unreadable"); };
  assert.throws(() => deployStateRows(reader, healthy), /latch unreadable/);
  const reasons: unknown[] = [];
  const rows = deployStateRows(reader, healthy, (error) => reasons.push(error));
  assert.deepEqual(rows.map((r) => r.pipeline), ["image", "deploy"]);
  assert.match(String(reasons[0]), /latch unreadable/);
  await reconcileFleetState(rows, [], () => {});
  assert.equal(reader.builds, 1);
  assert.equal(reader.clears, 0);
});

test("W1-T4840: the default deploy request uses the existing marker and retains a pending request", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-marker-"));
  try {
    const reader = deployReader();
    reader.published = true;
    const logs: Record<string, unknown>[] = [];
    const effects = fixtureEffects(root, {
      fleetDeploySensorsImpl: reader.deploy, readJsonImpl: async () => ({}),
      log: (step, data) => { logs.push({ step, ...data }); },
    });
    const snapshot = await effects.readFleetState!([]);
    assert.ok(logs.some((e) => e.pipeline === "ci" && String(e.reason).includes("not an array")));
    const events: Record<string, unknown>[] = [];
    await reconcileFleetState(snapshot.rows, snapshot.history, (e) => events.push(e));
    const marker = deployMarkerPath(root);
    assert.equal(readFileSync(marker, "utf8"), "W1-T4840: published image awaits deploy\n");
    assert.equal(events.find((e) => e.pipeline === "deploy")?.step, "reconcile.repaired");
    writeFileSync(marker, "operator request\n");
    const again = await effects.readFleetState!([]);
    await reconcileFleetState(again.rows, [], (e) => events.push(e));
    assert.equal(readFileSync(marker, "utf8"), "operator request\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T4840: the default latch adapter names malformed dates and removal failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-latch-errors-"));
  try {
    const logs: Record<string, unknown>[] = [];
    const reader = deployReader();
    reader.deploy.newestBakedSha = () => undefined;
    const effects = fixtureEffects(root, {
      fleetDeploySensorsImpl: reader.deploy, log: (step, data) => { logs.push({ step, ...data }); },
    });
    const failure = join(root, "state", "DEPLOY_FAILED");
    const failedHead = join(root, "state", "DEPLOY_LAST_FAILED");
    writeFileSync(failure, JSON.stringify({ at: "not a date" }));
    await effects.readFleetState!([]);
    assert.ok(logs.some((e) => e.reason === "failure latch has no valid timestamp"));
    writeFileSync(failure, JSON.stringify({ at: "2026-09-29T12:00:00.000Z" }));
    const snapshot = await effects.readFleetState!(healthy);
    const events: Record<string, unknown>[] = [];
    mkdirSync(failedHead);
    await reconcileFleetState(snapshot.rows, snapshot.history, (e) => events.push(e));
    assert.equal(events[0]?.step, "reconcile.repair_failed");
    assert.match(String(events[0]?.reason), /EISDIR/);
    assert.equal(existsSync(failure), true);
    rmSync(failedHead, { recursive: true });
    await reconcileFleetState(snapshot.rows, [], (e) => events.push(e));
    assert.equal(existsSync(failure), false, "a missing companion marker does not block the clear");
    const empty = await effects.readFleetState!([]);
    assert.deepEqual(empty.rows, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
