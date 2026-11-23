// W1-T11976: the heavy-lane views declare what they read (W1-T11975's inputsFingerprint), so the worker skips each one
// while only other rows move. Every view here is the production lane's own (readModelLaneViews), run by the real
// ticker; the tests wrap only `materialize`, to count and keep what it built, never a declaration.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ACTIONS_VIEW_NAME } from "#src/lib/actions-view.js";
import { boardOpenSnapshotPath } from "#src/lib/board-snapshot-cache.js";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { HOST_VIEW_NAME } from "#src/lib/host-view.js";
import { incidentLifecycleStorePath } from "#src/lib/incident-lifecycle.js";
import { INCIDENTS_VIEW_NAME, type IncidentsViewData } from "#src/lib/incidents-view.js";
import { EMERGENCY_STOP_ISSUED_LEDGER_STEP, EXTERNAL_EFFECT_RECONCILED_STEP } from "#src/lib/ledger.js";
import { NOW_VIEW_NAME } from "#src/lib/now-view.js";
import { createRepositoriesSourcePublisher } from "#src/lib/repositories-view.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import { WORKSTREAMS_VIEW_NAME } from "#src/lib/workstreams-view.js";
import {
  createReadModelTicker, readModelLaneViews, readModelSwitchesPath,
  type ReadModelView, type ReadModelViewContext, type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { closeReadModelFixture, readModelFixtureDir } from "#test/helpers/read-model-fixture.js";

/** The heavy-lane views that declare their inputs. */
const DECLARED = [WORKSTREAMS_VIEW_NAME, "repositories", ACTIONS_VIEW_NAME, INCIDENTS_VIEW_NAME];

/** The heavy-lane views that cannot fingerprint an input cheaply, each with that input. */
const UNDECLARED: Record<string, string> = {
  [NOW_VIEW_NAME]: "its board stage's host probe: `gh api rate_limit` and statfs, a process's output with no identity",
  [HOST_VIEW_NAME]: "its host probe, stamped as of the clock with statfs and `gh api rate_limit`: every sample is a new measurement",
};

const SHA = "a".repeat(40);
const PLAN = "- id: W1-T1\n  title: t\n  repo: owner/core\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: queued\n  acceptance:\n    - claim: c\n      proof: \"grep: x in y\"\n";
const REGISTRY = "instances:\n  core:\n    repo: core\n    github_repo: owner/core\n    project: example\n";

function stopRow(ts: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts, step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, task_id: id, stop: { schema: "emergency-stop-v1", id, scope: "fleet", reason: `drill ${id}`,
    issuedBy: "operator", issuedAt: ts, clearPolicy: "explicit-clear-required", affectedCapabilities: "*", affectedDelegationClasses: "*",
    incidentReceiptId: `incident-${id}`, ...extra } };
}

function reconciledRow(ts: string, n: number): Record<string, unknown> {
  return { ts, step: EXTERNAL_EFFECT_RECONCILED_STEP, task_id: `task-${n}`, external_effect: {
    version: "external-effect-v1", originatingActionId: `action-${n}`, originatingReceiptId: `receipt-${n}`, capabilityGrantId: `grant-${n}`,
    connector: "provider", targetIdentity: `provider:account-${n}`, requestedOperation: "observe", preconditionSnapshot: {}, expectedPostconditions: [],
    observation: { status: "fresh", observedAt: ts, ageMs: 0, maxAgeMs: 5_000 }, idempotencyKey: `key-${n}`, reconciliationState: "pending",
    retryPath: { kind: "none", allowed: false, reason: "test" },
    evidenceReference: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", safeToComplete: false,
  } };
}

/** One instance's checkout and state dir, as serve lays them out, with the production lane's heavy views run by the real ticker. */
function heavyLane(t: TestContext, names: readonly string[] = DECLARED) {
  const root = readModelFixtureDir(t, "heavy-declared");
  const stateDir = join(root, "state");
  // The projector and the GitHub snapshot judge rows on the real clock, so the fixture's clock starts at it.
  let now = Date.now();
  const start = now;
  const iso = (ms = now) => new Date(ms).toISOString();
  const clock = { now: () => now, date: () => new Date(now), iso: () => iso() };
  for (const dir of [join(stateDir, "read-model"), join(root, "plan"), join(root, ".remudero"), join(root, ".git", "refs", "remotes", "origin")]) {
    mkdirSync(dir, { recursive: true });
  }
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, PLAN);
  // The plan's checkout is as new as its origin/main, read from the ref files (no git spawn).
  writeFileSync(join(root, ".git", "HEAD"), `${SHA}\n`);
  writeFileSync(join(root, ".git", "refs", "remotes", "origin", "main"), `${SHA}\n`);
  writeFileSync(daemonInstanceRegistryPath(root), REGISTRY);
  const openSnapshot = boardOpenSnapshotPath(root, "owner", "core");
  mkdirSync(dirname(openSnapshot), { recursive: true });
  writeFileSync(openSnapshot, JSON.stringify({ type: "board-open-snapshot", schema: 1, repository: "owner/core", savedAt: iso(), rows: [] }));
  const ledger = join(stateDir, "ledger.ndjson");
  const rows = [
    { ts: iso(start - 2_000), step: "daemon.tick" },
    { ts: iso(start - 1_500), step: "run.start", task_id: "W1-T1", run_id: "r1", repo: "owner/core" },
    reconciledRow(iso(start - 1_200), 1),
    // Active until 30 s after the fixture starts: a clock-derived field of the incidents body.
    stopRow(iso(start - 1_000), "estop-expiring", { clearPolicy: "expires", expiresAt: iso(start + 30_000) }),
  ];
  writeFileSync(ledger, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  createRepositoriesSourcePublisher({ stateDir, instances: () => [{ instanceId: "core", options: {
    root, repoRegistryPath: daemonInstanceRegistryPath(root), ownInstance: "core", controlRoot: root, incidentsDir: stateDir, ledgerPath: ledger, planPath,
  } }] })();
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: Object.fromEntries(names.map((name) => [name, "serve"])) }));
  const instances = [{ name: "core", repo: "owner/core", ledgerDir: stateDir, planPath }];
  const messages: ReadModelWorkerMessage[] = [];
  const counts = new Map<string, number>();
  const contexts = new Map<string, ReadModelViewContext>();
  const output = new Map<string, ReturnType<ReadModelView["materialize"]>>();
  const originals = new Map<string, ReadModelView>();
  const lane = readModelLaneViews({ stateDir, instances, registry: {} }, clock, () => {}, createDemandBook({ clock }))
    .filter((spec) => names.includes(spec.name));
  assert.deepEqual(lane.map((spec) => spec.name).sort(), [...names].sort(), "positive control: the lane registers every view under test");
  const views = lane.map((spec) => {
    const view = "create" in spec ? spec.create() : spec;
    const materialize = view.materialize;
    view.materialize = (ctx) => {
      contexts.set(view.name, ctx);
      counts.set(view.name, (counts.get(view.name) ?? 0) + 1);
      const built = materialize(ctx);
      output.set(view.name, built);
      return built;
    };
    originals.set(view.name, view);
    return view;
  });
  const ticker = createReadModelTicker({ stateDir, instances, views, clock, oracle: "off", holder: "heavy-declared-test",
    post: (message) => { messages.push(message); },
  });
  closeReadModelFixture(t, () => ticker.release());
  ticker.start();
  ticker.tick();
  const build = (name: string) => ticker.buildNow(name);
  const count = (name: string) => counts.get(name) ?? 0;
  // Each view's first build, its first would-be skip (an audit, which builds) and one skip; a staged build takes passes.
  for (const name of names) for (let i = 0; i < 12; i++) build(name);
  const append = (row: Record<string, unknown>) => appendFileSync(ledger, `${JSON.stringify(row)}\n`);
  const tick = (ms = 0) => { now += ms; ticker.tick(); };
  const fingerprint = (name: string): string | undefined => {
    const view = originals.get(name)!;
    assert.equal(typeof view.inputsFingerprint, "function", `${name} declares its inputs`);
    return view.inputsFingerprint!({ ...contexts.get(name)!, now });
  };
  /** The body the next build published, against a build at the same instant with the skip disabled. */
  const equalFullBuild = (name: string, before: number) => {
    build(name);
    assert.ok(count(name) > before, `${name} was built after its input moved`);
    const built = output.get(name);
    const view = originals.get(name)!;
    const declaration = view.inputsFingerprint;
    view.inputsFingerprint = () => undefined;
    const skipDisabled = count(name);
    build(name);
    view.inputsFingerprint = declaration;
    assert.equal(count(name), skipDisabled + 1, `${name}'s skip-disabled build called materialize`);
    assert.deepEqual(output.get(name), built, `${name}'s body equals the skip-disabled build`);
  };
  const mismatches = () => messages.filter((m) => m.type === "log" && m.step === "read_model.view_skip_mismatch");
  const generation = () => contexts.get(ACTIONS_VIEW_NAME)?.instances[0]?.db?.meta("generation");
  return { root, stateDir, start, iso, messages, counts, contexts, output, originals, build, count, append, tick,
    fingerprint, equalFullBuild, mismatches, generation, now: () => now };
}

/** A ledger row with no step: the projector applies it and moves its generation, and none of the four views reads it. */
const unread = (ts: string) => ({ ts, note: "an operator's free-text line" });

test("W1-T11976 criterion 1: each declared heavy view skips a ledger row none of them reads", (t) => {
  const f = heavyLane(t);
  for (const name of DECLARED) assert.equal(typeof f.fingerprint(name), "string", `${name} has a readable declaration`);
  const before = new Map(DECLARED.map((name) => [name, f.count(name)]));
  for (const name of DECLARED) {
    f.build(name);
    assert.equal(f.count(name), before.get(name), `positive control: ${name} skips when nothing moved`);
  }
  const fingerprints = new Map(DECLARED.map((name) => [name, f.fingerprint(name)]));
  const generation = f.generation();
  f.append(unread(f.iso()));
  f.tick();
  assert.notEqual(f.generation(), generation, "positive control: the projector applied the row and moved its generation");
  for (const name of DECLARED) {
    for (let i = 0; i < 3; i++) f.build(name);
    assert.equal(f.fingerprint(name), fingerprints.get(name), `${name}'s fingerprint ignores the row`);
    assert.equal(f.count(name), before.get(name), `${name} stays skipped`);
  }
});

test("W1-T11976 criterion 1: a step row only the activity feed reads leaves repositories, actions and incidents skipped, and moves workstreams", (t) => {
  const f = heavyLane(t);
  const before = new Map(DECLARED.map((name) => [name, f.count(name)]));
  f.append({ ts: f.iso(), step: "garden.pass", gardener: "unrelated" });
  f.tick();
  f.tick(1_001); // Past workstreams' debounce of the change the first pass saw.
  for (const name of DECLARED) for (let i = 0; i < 6; i++) f.build(name);
  for (const name of ["repositories", ACTIONS_VIEW_NAME, INCIDENTS_VIEW_NAME]) assert.equal(f.count(name), before.get(name), `${name} skips the row`);
  // The workstreams body shows the newest rows of ANY step, so this row is one of its inputs: it is rebuilt.
  assert.ok(f.count(WORKSTREAMS_VIEW_NAME) > before.get(WORKSTREAMS_VIEW_NAME)!, "workstreams reads every step row");
  const activity = JSON.stringify(f.output.get(WORKSTREAMS_VIEW_NAME)![0]!.data);
  assert.match(activity, /garden\.pass/, "the row is in the workstreams activity feed");
});

test("W1-T11976 criterion 2: a row or file each declared view reads moves its fingerprint, and the next body equals a skip-disabled build", (t) => {
  const f = heavyLane(t);
  const changed = (name: string, mutate: () => void) => {
    const fingerprint = f.fingerprint(name);
    const before = f.count(name);
    mutate();
    for (let i = 0; i < 6; i++) f.build(name);
    assert.notEqual(f.fingerprint(name), fingerprint, `${name}'s input is represented`);
    f.equalFullBuild(name, before);
  };
  changed(ACTIONS_VIEW_NAME, () => { f.append(reconciledRow(f.iso(), 2)); f.tick(); });
  assert.equal((f.output.get(ACTIONS_VIEW_NAME)![0]!.data as { instances: Array<{ results: { results: unknown[] } }> }).instances[0]!.results.results.length, 2,
    "positive control: the new reconciled fact is in the body");
  changed(INCIDENTS_VIEW_NAME, () => { f.append(stopRow(f.iso(), "estop-new")); f.tick(); });
  assert.deepEqual((f.output.get(INCIDENTS_VIEW_NAME)![0]!.data as IncidentsViewData).instances[0]!.emergency.active.map((stop) => stop.id).sort(),
    ["estop-expiring", "estop-new"]);
  changed(INCIDENTS_VIEW_NAME, () => { writeFileSync(incidentLifecycleStorePath(f.stateDir), "{}\n"); });
  // workstreams debounces a change: the pass that sees it dates it, and the one a second later builds it.
  changed(WORKSTREAMS_VIEW_NAME, () => { f.append({ ts: f.iso(), step: "run.start", task_id: "W1-T1", run_id: "r2" }); f.tick(); f.tick(1_001); });
  changed(WORKSTREAMS_VIEW_NAME, () => { writeFileSync(join(f.root, "plan", "tasks.yaml"), PLAN.replace("title: t", "title: renamed")); f.tick(); f.tick(1_001); });
  changed("repositories", () => { writeFileSync(daemonInstanceRegistryPath(f.root), REGISTRY.replace("example", "renamed")); });
  assert.equal(f.mismatches().length, 0, "no audit found a skipped body that differed from its build");
});

test("W1-T11976 criterion 2: a clock-derived field crossing its threshold with no row moving gets a build", (t) => {
  const f = heavyLane(t);
  const generation = f.generation();
  const crossed = (name: string, ms: number) => {
    const fingerprint = f.fingerprint(name);
    const before = f.count(name);
    f.tick(ms);
    for (let i = 0; i < 6; i++) f.build(name);
    assert.ok(f.count(name) > before, `${name} is rebuilt once its clock-derived field crosses`);
    return fingerprint;
  };
  // incidents: an emergency stop's expiry, 30 s after the fixture starts.
  const incidents = crossed(INCIDENTS_VIEW_NAME, 31_000);
  assert.notEqual(f.fingerprint(INCIDENTS_VIEW_NAME), incidents, "the expiry is in the incidents fingerprint");
  assert.deepEqual((f.output.get(INCIDENTS_VIEW_NAME)![0]!.data as IncidentsViewData).instances[0]!.emergency.active, [], "the stop has expired");
  f.equalFullBuild(INCIDENTS_VIEW_NAME, f.count(INCIDENTS_VIEW_NAME) - 1);
  // repositories: a summary is recomputed on its 60 s cadence.
  const repositories = crossed("repositories", 30_000);
  assert.notEqual(f.fingerprint("repositories"), repositories, "the recompute is in the repositories fingerprint");
  f.equalFullBuild("repositories", f.count("repositories") - 1);
  // workstreams: its `plan:<i>` source, stamped at the build, ages past its budget; the worker judges it every pass.
  crossed(WORKSTREAMS_VIEW_NAME, 60_000);
  f.equalFullBuild(WORKSTREAMS_VIEW_NAME, f.count(WORKSTREAMS_VIEW_NAME) - 1);
  // actions: its body holds no field that ages after its build (`generatedAt` is the build's clock), so the clock is not an input.
  const actions = f.fingerprint(ACTIONS_VIEW_NAME);
  const before = f.count(ACTIONS_VIEW_NAME);
  f.build(ACTIONS_VIEW_NAME);
  assert.equal(f.fingerprint(ACTIONS_VIEW_NAME), actions);
  assert.equal(f.count(ACTIONS_VIEW_NAME), before, "actions stays skipped across two minutes with no row");
  assert.equal(f.generation(), generation, "no row moved the projector in this test");
});

test("W1-T11976 criterion 3: now and host cannot fingerprint an input cheaply, so they declare nothing and build as before", (t) => {
  const names = Object.keys(UNDECLARED);
  const clock = { now: () => Date.now(), date: () => new Date(), iso: () => new Date().toISOString() };
  const lane = readModelLaneViews({ instances: [{ name: "core", repo: "owner/core", ledgerDir: "/nonexistent/state" }], registry: {} }, clock, () => {}, createDemandBook({ clock }));
  for (const name of names) {
    const spec = lane.find((v) => v.name === name);
    assert.ok(spec, `positive control: the lane registers ${name}`);
    const view = "create" in spec ? spec.create() : spec;
    assert.equal(view.inputsFingerprint, undefined, `${name} declares nothing: ${UNDECLARED[name]}`);
  }
  for (const name of DECLARED) {
    const spec = lane.find((v) => v.name === name)!;
    assert.equal(typeof ("create" in spec ? spec.create() : spec).inputsFingerprint, "function", `positive control: ${name} declares`);
  }
  // host, run by the worker with the declared views: every pass builds it, and its tally names why.
  const f = heavyLane(t, [...DECLARED, HOST_VIEW_NAME]);
  const before = f.count(HOST_VIEW_NAME);
  assert.ok(before > 0, "positive control: host was built");
  f.append(unread(f.iso()));
  f.tick();
  for (let i = 0; i < 3; i++) f.build(HOST_VIEW_NAME);
  assert.ok(f.count(HOST_VIEW_NAME) >= before + 3, "host is built on every pass");
  f.tick(600_000);
  const tally = f.messages.find((m) => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === HOST_VIEW_NAME);
  assert.ok(tally?.type === "log", "the window's tally names host");
  assert.ok((tally.extra.not_skipped as Record<string, number>).no_declaration >= 3, "host is counted under no_declaration");
});

test("W1-T11976 criterion 4: the production lane skips each declared heavy view on an unrelated row, and its audits ledger no mismatch", (t) => {
  const f = heavyLane(t);
  const before = new Map(DECLARED.map((name) => [name, f.count(name)]));
  for (let i = 0; i < 5; i++) {
    f.append(unread(f.iso()));
    f.tick();
    for (const name of DECLARED) for (let j = 0; j < 5; j++) f.build(name);
  }
  // At least 25 more would-be skips per view (a pass's tick adds one for a due view): every twentieth is audited, a
  // build, so each view builds once or twice more, and never for the rows.
  for (const name of DECLARED) {
    const built = f.count(name) - before.get(name)!;
    assert.ok(built >= 1 && built <= 2, `${name} skipped every pass but its audits (${built} builds)`);
  }
  assert.equal(f.mismatches().length, 0, "no audit ledgered read_model.view_skip_mismatch");
  f.tick(600_000);
  for (const name of DECLARED) {
    const tally = f.messages.find((m) => m.type === "log" && m.step === "read_model.view_builds" && m.extra.view === name);
    assert.ok(tally?.type === "log", `${name}'s window has a tally`);
    assert.ok(Number(tally.extra.skipped) >= 20, `${name}'s tally counts the skips`);
    assert.ok((tally.extra.not_skipped as Record<string, number>).audit >= 2, `${name}'s tally counts its audits`);
  }
});
