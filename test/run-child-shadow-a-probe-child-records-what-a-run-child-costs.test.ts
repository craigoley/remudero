// test/run-child-shadow-a-probe-child-records-what-a-run-child-costs.test.ts — W1-T9082.
//
// Decision record: docs/adr/0007-build-runs-outlive-the-daemon.md (A.9, C). Under `sweep.runChild.mode: shadow` a dispatched run
// also starts one PROBE child that loads what a run child loads and records what it cost, while the run stays in-process.
// The first test really shells out: it cuts an engine tree, builds the `run-child` bundle into it, and runs the probe from there.
import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EngineChildLaunch } from "../src/lib/child-entry-argv.js";
import { readPeakSamples, resetLearnedEstimateCacheForTests, type TreePeakSampler } from "../src/lib/host-memory-learning.js";
import { DEFAULT_ESTIMATE_MIB, WORKER_CLASSES } from "../src/lib/host-memory-ledger.js";
import {
  RUN_CHILD_ENTRY, createAdmittedPlanSlot, planSha, prunePlanSnapshots, pruneProbeRunDirs, startRunChildProbe, writePlanSnapshot,
  type RunChildProbeInput, type RunChildProbeSeams,
} from "../src/lib/run-child.js";
import {
  RUN_CHILD_SCHEMA, readStatus, runDir, writeSpec, writeStatus, type RunChildSpec, type RunChildStatus,
} from "../src/lib/run-child-contract.js";
import { PolicyError, RUN_CHILD_MODES, loadRunChildMode, parseRunChildMode, runChildEffectiveMode } from "../src/lib/policy.js";
import { runChildMain } from "../src/run-child-main.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Required, as src/lib/child-entry-argv.ts requires it, so this process holds ONE instance of the script.
const BUILD = createRequire(import.meta.url)(join(REPO_ROOT, "scripts", "build-child-entries.mjs")) as {
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[]; workers: string[] }): Promise<unknown>;
  CHILD_ENTRIES: readonly { name: string; source: string }[];
};

const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}run-child-shadow-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

interface Fixture {
  root: string;
  state: string;
  engine: string;
  ledger: NonNullable<RunChildProbeSeams["ledger"]>;
  store: NonNullable<RunChildProbeSeams["store"]>;
}

/** A state root holding one engine tree record at HASH. `real` cuts a tree that can run the entry: a COPY of src/ (a bundle's
 *  module URLs must be real paths inside its tree), everything else linked to this checkout. */
function fixture(label: string, real: boolean): Fixture {
  const root = tmp(label);
  const state = join(root, "state");
  const engine = join(state, "engines", HASH);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  if (real) {
    cpSync(join(REPO_ROOT, "src"), join(engine, "src"), { recursive: true });
    for (const name of readdirSync(REPO_ROOT)) {
      if ([".git", "src", "dist", "state", "test"].includes(name) || existsSync(join(engine, name))) continue;
      symlinkSync(join(REPO_ROOT, name), join(engine, name));
    }
  }
  return {
    root, state, engine,
    ledger: { location: () => ({ dir: join(root, "host-memory"), scope: "local" }), instance: () => ({ name: "test", hostUnique: false }), root },
    store: { location: () => ({ dir: join(root, "host-memory") }), root },
  };
}

let bundled: Promise<Fixture> | undefined;
/** The engine tree with a current `run-child` bundle, built once and shared. */
function bundledFixture(): Promise<Fixture> {
  bundled ??= (async () => {
    const fx = fixture("bundled", true);
    const entry = BUILD.CHILD_ENTRIES.find((e) => e.name === RUN_CHILD_ENTRY.name);
    assert.ok(entry, "the child-entry build declares the run-child entry");
    await BUILD.buildChildEntries({ root: fx.engine, entries: [entry], workers: [] });
    return fx;
  })();
  return bundled;
}

const TASKS = [{ id: "W1-T1" }, { id: "W1-T2" }, { id: "W1-T3" }];
type Row = { step: string } & Record<string, unknown>;

function inputFor(fx: Fixture, rows: Row[], overrides: Partial<RunChildProbeInput> = {}): RunChildProbeInput {
  const slot = createAdmittedPlanSlot();
  slot.offer({ plan: { tasks: TASKS } });
  return {
    taskId: "W1-T9082", stateRoot: fx.state, repoDir: fx.root, root: fx.root, plan: slot.promise, options: { owner: "o" },
    log: (step, extra) => { rows.push({ step, ...extra }); }, ...overrides,
  };
}

const seamsFor = (fx: Fixture, overrides: RunChildProbeSeams = {}): RunChildProbeSeams => ({
  readMode: () => "shadow", mainSha: async () => SHA, ledger: fx.ledger, store: fx.store, ...overrides,
});

/** A launch that runs `script` under plain node in place of the real entry. */
const scriptLaunch = (script: string, fx: Fixture): NonNullable<RunChildProbeSeams["launch"]> =>
  (_engine, args): EngineChildLaunch => ({ argv: ["-e", script, "--", ...args], kind: "tsx", reason: "test-script", cwd: fx.root, engineRoot: fx.engine });

const only = (rows: Row[], step: string): Row => {
  const found = rows.filter((r) => r.step === step);
  assert.equal(found.length, 1, `exactly one ${step} row, saw ${rows.map((r) => r.step).join(", ")}`);
  return found[0]!;
};

test("W1-T9082: a shadow probe writes its status and its shadow row", { timeout: 240_000 }, async () => {
  resetLearnedEstimateCacheForTests();
  const fx = await bundledFixture();
  const rows: Row[] = [];
  const outcome = await startRunChildProbe(inputFor(fx, rows), seamsFor(fx));
  assert.ok(outcome.started, "a probe started");
  const row = only(rows, "run_child.shadow");
  assert.equal(row.contract, "ok", JSON.stringify(row));
  assert.equal(row.entry_kind, "bundle", "the engine tree holds a current bundle, so the probe ran it under plain node");
  assert.equal(row.entry_reason, "source-hash-match");
  assert.equal(row.engine_sha, SHA);
  assert.equal(row.task_id, "W1-T9082");
  assert.equal(row.plan_tasks, TASKS.length, "the probe read the plan snapshot the daemon wrote");
  assert.equal(typeof row.load_ms, "number");
  assert.ok((row.load_ms as number) >= 0);
  assert.ok(typeof row.tree_peak_bytes === "number" && row.tree_peak_bytes > 0, `a tree peak from the reservation release: ${row.tree_peak_bytes}`);
  assert.ok(typeof row.child_max_rss_bytes === "number" && row.child_max_rss_bytes > 0, "the child's own peak resident size rides the row");
  const dir = runDir(fx.state, String(row.run_id));
  const status = readStatus(dir);
  assert.ok(status.ok, JSON.stringify(status));
  assert.equal(status.value.state, "done");
  assert.equal(status.value.entryKind, "bundle");
  assert.equal(status.value.engineSha, SHA);
  const raw = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as Record<string, unknown>;
  assert.equal(raw.probe, true, "the status says it is a probe");
  assert.equal(raw.loadMs, row.load_ms);
  const snapshot = JSON.parse(readFileSync(join(fx.state, "plan-snapshots", `${planSha(TASKS)}.json`), "utf8")) as { tasks: unknown[] };
  assert.equal(snapshot.tasks.length, TASKS.length);
  assert.equal(only(rows, "child_entry.spawned").verb, "--probe");
  const learned = readPeakSamples("run-child-probe", fx.store);
  assert.equal(learned.length, 1, "the probe's tree peak is learned like the other classes'");
});

test("W1-T9082: a failing probe never touches the in-process run", async () => {
  const fx = fixture("failing", false);
  const failures: Array<[string, RunChildProbeSeams]> = [
    ["a child that exits without a status", seamsFor(fx, { engine: { isCurrent: () => true }, launch: scriptLaunch("console.error('boom'); process.exit(3)", fx) })],
    ["a spawn that throws", seamsFor(fx, { engine: { isCurrent: () => true }, launch: scriptLaunch("", fx), spawn: () => { throw new Error("no fork for you"); } })],
    ["a child that fails the contract", seamsFor(fx, { engine: { isCurrent: () => true }, launch: scriptLaunch(`
      const { writeFileSync } = require("node:fs"); const { join } = require("node:path");
      const dir = process.argv.at(-2);
      writeFileSync(join(dir, "status.json"), JSON.stringify({ schema: { major: 1, minor: 0 }, runId: "x", state: "failed", phase: "spec", heartbeatAt: 1,
        engineSha: "e", entryKind: "tsx", identity: { pid: 1, startTicks: "1", containerGeneration: { containerId: "c", initStart: "i" } },
        failure: { class: "contract_mismatch", reasonClass: "contract_mismatch", message: "schema major 9" } }));
      process.exit(1);`, fx) })],
  ];
  const expected = ["unknown", "unknown", "contract_mismatch"];
  for (const [index, [label, seams]] of failures.entries()) {
    const rows: Row[] = [];
    // The in-process run the probe shadows: it must finish exactly as it would have without one.
    const run = (async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return "ran to completion"; })();
    const probe = startRunChildProbe(inputFor(fx, rows), seams);
    assert.equal(await run, "ran to completion", label);
    const outcome = await probe; // resolves: a probe failure is a ledger row, never a rejection
    assert.ok(outcome.started, label);
    const row = only(rows, "run_child.shadow");
    assert.equal(row.contract, expected[index], `${label}: ${JSON.stringify(row)}`);
    assert.equal(typeof row.error, "string", `${label}: the failure says why`);
  }
});

test("W1-T9082: the run-child verb starts no self-URL worker", { timeout: 240_000 }, async () => {
  const fx = await bundledFixture();
  const dir = tmp("no-worker");
  const preload = join(dir, "no-worker.mjs");
  const attempts = join(dir, "attempts.log");
  writeFileSync(preload, [
    'import { createRequire, syncBuiltinESMExports } from "node:module";',
    'import { appendFileSync } from "node:fs";',
    'const workerThreads = createRequire(import.meta.url)("node:worker_threads");',
    'workerThreads.Worker = class { constructor() { appendFileSync(process.env.RMD_WORKER_ATTEMPTS, "attempt\\n"); throw new Error("a Worker was started"); } };',
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const env = { ...process.env, RMD_WORKER_ATTEMPTS: attempts };
  // The control: the preload really turns an ESM `import { Worker }` into a thrower.
  const control = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-e",
    'import { Worker } from "node:worker_threads"; try { new Worker("x.js"); console.log("started"); } catch (e) { console.log("threw: " + e.message); }'],
  { encoding: "utf8", env, cwd: dir });
  assert.match(control.stdout, /threw: a Worker was started/, control.stderr);
  assert.equal(readFileSync(attempts, "utf8"), "attempt\n");
  rmSync(attempts);

  const runId = "probe-no-worker";
  const runDirectory = runDir(fx.state, runId);
  const snapshot = writePlanSnapshot(fx.state, TASKS);
  const spec: RunChildSpec = {
    schema: RUN_CHILD_SCHEMA, taskId: "W1-T9082", runId, instance: "test", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: snapshot.path, reservationId: "", options: {},
  };
  mkdirSync(runDirectory, { recursive: true });
  writeSpec(runDirectory, spec);
  const bundle = join(fx.engine, "dist", "child-entries", `${RUN_CHILD_ENTRY.name}.mjs`);
  const probe = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, bundle, "--run-dir", runDirectory, "--probe"],
    { encoding: "utf8", env, cwd: fx.engine, timeout: 200_000 });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  const status = readStatus(runDirectory);
  assert.ok(status.ok && status.value.state === "done", JSON.stringify(status));
  assert.equal(status.value.entryKind, "bundle", "the verb ran bundled, the case where a self-URL worker could not load");
  assert.equal(existsSync(attempts), false, "no Worker was constructed while the verb loaded and ran");
});

test("W1-T9082: the run-child mode parses and an absent block is off", () => {
  for (const mode of ["off", "shadow", "on", "auto"] as const) {
    assert.equal(parseRunChildMode({ runChild: { mode: { value: mode, origin: "proposal" } } }), mode);
  }
  assert.deepEqual([...RUN_CHILD_MODES], ["off", "shadow", "on", "auto"]);
  assert.equal(parseRunChildMode({}), "off", "a sweep block without runChild reads as off");
  assert.equal(parseRunChildMode(undefined), "off", "a policy without a sweep block reads as off");
  assert.throws(() => parseRunChildMode({ runChild: { mode: { value: "enforce", origin: "proposal" } } }), PolicyError);
  assert.throws(() => parseRunChildMode({ runChild: { mode: { value: "shadow", origin: "net-new" } } }), /origin/);
  assert.throws(() => parseRunChildMode({ runChild: { mode: "shadow" } }), /mapping/);
  assert.throws(() => parseRunChildMode({ runChild: "shadow" }), /mapping/);
  assert.deepEqual(runChildEffectiveMode("off"), { mode: "off", fellBack: false });
  assert.deepEqual(runChildEffectiveMode("shadow"), { mode: "shadow", fellBack: false });
  for (const later of ["on", "auto"] as const) assert.deepEqual(runChildEffectiveMode(later), { mode: "shadow", fellBack: true });

  const dir = tmp("policy");
  const file = join(dir, "policy.yaml");
  writeFileSync(file, "sweep:\n  runChild:\n    mode:\n      value: auto\n      origin: proposal\n");
  assert.equal(loadRunChildMode(file), "auto");
  writeFileSync(file, "sweep:\n  staleDays: 1\n");
  assert.equal(loadRunChildMode(file), "off");
  writeFileSync(file, "sweep: [unclosed\n");
  assert.throws(() => loadRunChildMode(file), PolicyError);
  assert.equal(loadRunChildMode(), "shadow", "this installation's policy.yaml ships the shadow mode");
});

test("W1-T9082: off starts nothing, on and auto say they run as shadow", async () => {
  const fx = fixture("modes", false);
  const rows: Row[] = [];
  const off = await startRunChildProbe(inputFor(fx, rows), seamsFor(fx, { readMode: () => "off", spawn: () => { throw new Error("off must not spawn"); } }));
  assert.deepEqual(off, { started: false, reason: "mode off" });
  assert.deepEqual(rows, [], "off writes no ledger row either");
  for (const mode of ["on", "auto"] as const) {
    const modeRows: Row[] = [];
    await startRunChildProbe(inputFor(fx, modeRows), seamsFor(fx, { readMode: () => mode, engine: { isCurrent: () => true }, launch: scriptLaunch("process.exit(0)", fx) }));
    const row = only(modeRows, "run_child.shadow");
    assert.equal(row.mode, mode);
    assert.equal(row.behaves_as, "shadow");
    assert.match(String(row.mode_note), /not implemented yet/);
  }
});

test("W1-T9082: a probe with nothing to run on is skipped with its reason", async () => {
  const bare = tmp("bare");
  let rows: Row[] = [];
  const noEngines = fixture("none", false);
  let out = await startRunChildProbe(inputFor(noEngines, rows, { stateRoot: join(bare, "state") }), seamsFor(noEngines));
  assert.deepEqual(out, { started: false, reason: "no engine tree has been built yet" });
  assert.equal(only(rows, "run_child.shadow_skipped").reason, "no engine tree has been built yet");

  const fx = fixture("stale", false);
  rows = [];
  out = await startRunChildProbe(inputFor(fx, rows), seamsFor(fx, { engine: { isCurrent: () => false } }));
  assert.equal(out.started, false);
  assert.equal(only(rows, "run_child.shadow_skipped").reason, "no current engine tree for main");

  rows = [];
  out = await startRunChildProbe(inputFor(fx, rows, { plan: new Promise(() => {}) }), seamsFor(fx, { engine: { isCurrent: () => true }, planWaitMs: 20 }));
  assert.equal(out.started, false);
  assert.equal(only(rows, "run_child.shadow_skipped").reason, "the run never read its plan");

  rows = [];
  out = await startRunChildProbe(inputFor(fx, rows), seamsFor(fx, { readMode: () => { throw new Error("policy gone"); } }));
  assert.equal(out.started, false);
  assert.match(String(only(rows, "run_child.shadow_skipped").reason), /unreadable: policy gone/);
});

test("W1-T9082: a probe that hangs is killed and a spawn error is ledgered", async () => {
  const fx = fixture("hang", false);
  let rows: Row[] = [];
  await startRunChildProbe(inputFor(fx, rows), seamsFor(fx, {
    engine: { isCurrent: () => true }, launch: scriptLaunch("setInterval(() => {}, 1000)", fx), timeoutMs: 300,
  }));
  let row = only(rows, "run_child.shadow");
  assert.equal(row.contract, "unknown");
  assert.match(String(row.error), /timed out/);

  rows = [];
  await startRunChildProbe(inputFor(fx, rows), seamsFor(fx, {
    engine: { isCurrent: () => true }, launch: scriptLaunch("", fx),
    spawn: (_command, _args, options) => nodeSpawn(join(fx.root, "no-such-binary"), [], { cwd: options.cwd, stdio: ["ignore", "ignore", "pipe"] }),
  }));
  row = only(rows, "run_child.shadow");
  assert.match(String(row.error), /spawn failed/);

  // A tree that was never observed records no peak, not a zero one.
  rows = [];
  const unobserved: TreePeakSampler = { track: () => {}, finish: () => undefined, sampleNow: () => {}, size: () => 0 };
  await startRunChildProbe(inputFor(fx, rows), seamsFor(fx, { engine: { isCurrent: () => true }, launch: scriptLaunch("process.exit(0)", fx), sampler: unobserved }));
  assert.equal(only(rows, "run_child.shadow").tree_peak_bytes, null);
});

test("W1-T9082: the probe class is reserved like the others", () => {
  assert.ok(WORKER_CLASSES.includes("run-child-probe"));
  assert.ok(DEFAULT_ESTIMATE_MIB["run-child-probe"] > 0);
});

test("W1-T9082: plan snapshots are written once per plan sha and pruned unless a live run names them", () => {
  const fx = fixture("snapshots", false);
  const first = writePlanSnapshot(fx.state, [{ id: "A" }]);
  assert.equal(first.reused, false);
  assert.equal(writePlanSnapshot(fx.state, [{ id: "A" }]).reused, true, "the same plan sha reuses its file");
  const named = writePlanSnapshot(fx.state, [{ id: "B" }]);
  const stale = writePlanSnapshot(fx.state, [{ id: "C" }]);
  const newest = writePlanSnapshot(fx.state, [{ id: "D" }]);
  const ago = (path: string, seconds: number): void => { const at = new Date(Date.now() - seconds * 1000); utimesSync(path, at, at); };
  ago(first.path, 400); ago(named.path, 300); ago(stale.path, 200); ago(newest.path, 0);
  // A non-terminal run directory names `named`; `first` is named by a terminal one, which keeps nothing.
  const identity = { pid: process.pid, startTicks: "1", containerGeneration: { containerId: "c", initStart: "i" } };
  const spec = (runId: string, planSnapshotPath: string): RunChildSpec => ({
    schema: RUN_CHILD_SCHEMA, taskId: "T", runId, instance: "i", engine: { sourceHash: HASH, sha: SHA }, planSnapshotPath, reservationId: "", options: {},
  });
  const status = (runId: string, state: RunChildStatus["state"]): RunChildStatus => ({
    schema: RUN_CHILD_SCHEMA, runId, identity, engineSha: SHA, entryKind: "tsx", phase: "p", heartbeatAt: 1, state,
  });
  for (const [runId, path, state] of [["live", named.path, "running"], ["finished", first.path, "done"]] as const) {
    const dir = runDir(fx.state, runId);
    mkdirSync(dir, { recursive: true });
    writeSpec(dir, spec(runId, path));
    writeStatus(dir, status(runId, state));
  }
  mkdirSync(join(fx.state, "runs", "a-file-is-not-a-run-dir.tail"), { recursive: true });
  assert.deepEqual(prunePlanSnapshots(fx.state).sort(), [first.path, stale.path].sort());
  assert.deepEqual(readdirSync(join(fx.state, "plan-snapshots")).sort(), [`${named.sha}.json`, `${newest.sha}.json`].sort());
  assert.deepEqual(prunePlanSnapshots(fx.state), [], "nothing more to remove");
  assert.deepEqual(prunePlanSnapshots(join(fx.root, "nowhere")), [], "no snapshot directory removes nothing");
});

test("W1-T9082: only terminal probe run directories beyond the newest few are removed", () => {
  const fx = fixture("probe-dirs", false);
  const identity = { pid: process.pid, startTicks: "1", containerGeneration: { containerId: "c", initStart: "i" } };
  const make = (runId: string, state: RunChildStatus["state"], ageSeconds: number): string => {
    const dir = runDir(fx.state, runId);
    mkdirSync(dir, { recursive: true });
    writeStatus(dir, { schema: RUN_CHILD_SCHEMA, runId, identity, engineSha: SHA, entryKind: "tsx", phase: "p", heartbeatAt: 1, state });
    const at = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(dir, at, at);
    return dir;
  };
  const newest = make("probe-new", "done", 1);
  const older = make("probe-older", "done", 100);
  const oldest = make("probe-oldest", "failed", 200);
  const running = make("probe-running", "running", 300);
  const notAProbe = make("run-real", "done", 400);
  assert.deepEqual(pruneProbeRunDirs(fx.state, 1).sort(), [older, oldest].sort());
  for (const kept of [newest, running, notAProbe]) assert.ok(existsSync(kept), `${kept} stays`);
  assert.deepEqual(pruneProbeRunDirs(join(fx.root, "no-state"), 1), []);
});

test("W1-T9082: the run-child entry writes starting then done, and refuses what it cannot read", async () => {
  const fx = fixture("main", false);
  const base = { schema: RUN_CHILD_SCHEMA, taskId: "T", instance: "i", engine: { sourceHash: HASH, sha: SHA }, reservationId: "", options: {} };
  const errors: string[] = [];
  const stderr = (text: string): void => { errors.push(text); };
  const states: string[] = [];
  const dirFor = (runId: string): string => { const dir = runDir(fx.state, runId); mkdirSync(dir, { recursive: true }); return dir; };
  const snapshot = writePlanSnapshot(fx.state, TASKS);

  assert.equal(await runChildMain([], { stderr }), 2);
  assert.match(errors.at(-1)!, /--run-dir/);
  assert.equal(await runChildMain(["--run-dir", dirFor("probe-usage")], { stderr }), 2);
  assert.match(errors.at(-1)!, /only --probe is implemented/);

  const done = dirFor("probe-done");
  writeSpec(done, { ...base, runId: "probe-done", planSnapshotPath: snapshot.path });
  const code = await runChildMain(["--run-dir", done, "--probe"], {
    stderr, clock: () => 1_000, maxRssBytes: () => 123,
    loadRunPath: async () => { states.push(JSON.parse(readFileSync(join(done, "status.json"), "utf8")).state as string); },
  });
  assert.equal(code, 0);
  assert.deepEqual(states, ["starting"], "the status read starting while the run path loaded");
  const finished = JSON.parse(readFileSync(join(done, "status.json"), "utf8")) as Record<string, unknown>;
  assert.equal(finished.state, "done");
  assert.equal(finished.probe, true);
  assert.equal(finished.planTasks, TASKS.length);
  assert.equal(finished.maxRssBytes, 123);

  const failedStatus = (runId: string): RunChildStatus => {
    const read = readStatus(runDir(fx.state, runId));
    assert.ok(read.ok, JSON.stringify(read));
    return read.value;
  };
  const missing = dirFor("probe-no-spec");
  assert.equal(await runChildMain(["--run-dir", missing, "--probe"], { stderr }), 1);
  assert.equal(failedStatus("probe-no-spec").failure?.class, "contract_mismatch");

  const major = dirFor("probe-major");
  writeFileSync(join(major, "spec.json"), JSON.stringify({ ...base, runId: "probe-major", planSnapshotPath: snapshot.path, schema: { major: 9, minor: 0 } }));
  assert.equal(await runChildMain(["--run-dir", major, "--probe"], { stderr }), 1);
  assert.match(failedStatus("probe-major").failure?.message ?? "", /schema major 9/);

  const wrong = dirFor("probe-wrong");
  writeSpec(wrong, { ...base, runId: "probe-someone-else", planSnapshotPath: snapshot.path });
  assert.equal(await runChildMain(["--run-dir", wrong, "--probe"], { stderr }), 1);
  assert.match(failedStatus("probe-wrong").failure?.message ?? "", /names run probe-someone-else/);

  const noPlan = dirFor("probe-no-plan");
  writeSpec(noPlan, { ...base, runId: "probe-no-plan", planSnapshotPath: join(fx.root, "absent.json") });
  assert.equal(await runChildMain(["--run-dir", noPlan, "--probe"], { stderr, loadRunPath: async () => {} }), 1);
  assert.equal(failedStatus("probe-no-plan").failure?.reasonClass, "plan_snapshot_unreadable");

  const empty = dirFor("probe-empty-plan");
  const emptyPlan = join(fx.root, "empty.json");
  writeFileSync(emptyPlan, "{}");
  writeSpec(empty, { ...base, runId: "probe-empty-plan", planSnapshotPath: emptyPlan });
  assert.equal(await runChildMain(["--run-dir", empty, "--probe"], { stderr, loadRunPath: async () => {} }), 1);
  assert.match(failedStatus("probe-empty-plan").failure?.message ?? "", /no tasks array/);

  const broken = dirFor("probe-broken-load");
  writeSpec(broken, { ...base, runId: "probe-broken-load", planSnapshotPath: snapshot.path });
  assert.equal(await runChildMain(["--run-dir", broken, "--probe"], {
    stderr, loadRunPath: async () => { throw new Error("module graph failed to load"); },
  }), 1);
  assert.match(failedStatus("probe-broken-load").failure?.message ?? "", /module graph failed to load/);
  assert.match(errors.at(-1)!, /probe failed/);

  // A directory the status cannot be written into: the failure is reported on stderr, not thrown.
  const unwritable = join(fx.root, "file-not-dir");
  writeFileSync(unwritable, "");
  assert.equal(await runChildMain(["--run-dir", unwritable, "--probe"], { stderr }), 1);
  assert.match(errors.join("\n"), /could not write the failed status/);
});
