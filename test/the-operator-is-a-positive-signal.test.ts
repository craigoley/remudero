import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger, deriveLedgerActor, ledgerRowActor } from "../src/lib/ledger.js";
import { configPath, loadConfig, type Config } from "../src/lib/config.js";
import { ledgerPathFor } from "../src/lib/ledger-path.js";
import { censusHandRuns, handRunCensus, parseOperatorLedgerRows } from "../src/lib/hand-run-census.js";
import { runMeasurementCadenceReport, type MeasurementCadenceReportOpts } from "../src/lib/measurement-cadence.js";
import { buildMeasurementCadenceDaemonHooks, main, serveCommand } from "../src/run-task.js";
import type { LedgerUnionResult } from "../src/lib/ledger-grep.js";

type CadenceDeps = NonNullable<Parameters<typeof buildMeasurementCadenceDaemonHooks>[0]>;

async function invoke(t: TestContext, argv: string[]): Promise<void> {
  const saved = process.argv;
  process.argv = [process.execPath, "fixture", ...argv];
  const exit = new Error("fixture exit");
  const exitMock = t.mock.method(process, "exit", () => { throw exit; });
  const output = t.mock.method(console, "log", () => {});
  try {
    await assert.rejects(main(), (error) => error === exit);
  } finally {
    exitMock.mock.restore();
    output.mock.restore();
    process.argv = saved;
  }
}

test("W1-T4068: serve and deploy-run stamp service and host_automation never operator", async (t) => {
  const saved = process.env.REMUDERO_PROCESS_ACTOR;
  const savedDaemon = process.env.REMUDERO_DAEMON_PROCESS;
  try {
    for (const [verb, actor] of [["serve", "service"], ["deploy-run", "host_automation"], ["daemon", "daemon"]]) {
      await invoke(t, [verb, "--help"]);
      assert.equal(deriveLedgerActor({ REMUDERO_PROCESS_ACTOR: process.env.REMUDERO_PROCESS_ACTOR }), actor);
    }
    delete process.env.REMUDERO_PROCESS_ACTOR;
    const output = t.mock.method(console, "error", () => {});
    assert.equal(await serveCommand(["--no-such-option"]), 2);
    output.mock.restore();
    assert.equal(deriveLedgerActor({ REMUDERO_PROCESS_ACTOR: process.env.REMUDERO_PROCESS_ACTOR }), "service");
  } finally {
    if (saved === undefined) delete process.env.REMUDERO_PROCESS_ACTOR;
    else process.env.REMUDERO_PROCESS_ACTOR = saved;
    if (savedDaemon === undefined) delete process.env.REMUDERO_DAEMON_PROCESS;
    else process.env.REMUDERO_DAEMON_PROCESS = savedDaemon;
  }
});

test("W1-T4068: test attribution refuses a live-root symlink and cannot spoof the row actor", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ledger-deny-control-"));
  const live = join(root, "live");
  mkdirSync(live);
  const path = join(live, "ledger.ndjson");
  writeFileSync(path, "sentinel\n");
  symlinkSync(live, join(root, "alias"));
  const saved = process.env.RMD_TEST_LIVE_DENY_ROOT;
  const override = process.env.RMD_ALLOW_LIVE_WRITES;
  process.env.RMD_TEST_LIVE_DENY_ROOT = live;
  process.env.RMD_ALLOW_LIVE_WRITES = "1";
  try {
    assert.throws(() => appendLedger(join(root, "alias", "ledger.ndjson"), { run_id: "r", task_id: "t", step: "probe" }), /REFUSED/);
    assert.equal(readFileSync(path, "utf8"), "sentinel\n");
    const scratch = join(root, "scratch", "ledger.ndjson");
    appendLedger(scratch, { run_id: "r", task_id: "t", step: "probe", actor: "operator_human" });
    assert.equal(JSON.parse(readFileSync(scratch, "utf8")).actor, "test");
  } finally {
    if (saved === undefined) delete process.env.RMD_TEST_LIVE_DENY_ROOT;
    else process.env.RMD_TEST_LIVE_DENY_ROOT = saved;
    if (override === undefined) delete process.env.RMD_ALLOW_LIVE_WRITES;
    else process.env.RMD_ALLOW_LIVE_WRITES = override;
  }
});

test("W1-T4068: a process with no TTY and no session marker stamps unknown", () => {
  assert.equal(deriveLedgerActor({}), "unknown");
  assert.equal(deriveLedgerActor({ CLAUDECODE: "1" }), "operator_ai");
  assert.equal(deriveLedgerActor({ CLAUDECODE: "0" }), "unknown");
  assert.equal(deriveLedgerActor({}, true), "operator_human");
  assert.equal(deriveLedgerActor({ CLAUDE_CODE_SESSION_ID: "session" }, true), "operator_ai");
  assert.equal(deriveLedgerActor({ REMUDERO_PROCESS_ACTOR: "operator_human" }), "unknown");
  assert.equal(deriveLedgerActor({ NODE_TEST_CONTEXT: "child-v8", REMUDERO_WORKER_SCOPE: "worker" }), "test");
  assert.equal(deriveLedgerActor({ REMUDERO_WORKER_SCOPE: "worker", REMUDERO_DAEMON_PROCESS: "1" }), "worker");
  assert.equal(deriveLedgerActor({ REMUDERO_DAEMON_PROCESS: "1" }), "daemon");
  for (const actor of ["service", "host_automation", "operator_human", "operator_ai", "test", "unknown"]) {
    assert.equal(ledgerRowActor({ actor }), actor);
  }
  assert.equal(ledgerRowActor({ actor: "invalid" }), "unknown");
});

test("W1-T4068: main under the test setup writes nothing to the production ledger", async (t) => {
  const config = loadConfig();
  assert.ok(config.root.startsWith(tmpdir() + "/"));
  assert.ok(configPath().startsWith(tmpdir() + "/"));
  const path = ledgerPathFor(config);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  await invoke(t, ["--help"]);
  const added = readFileSync(path, "utf8").slice(before.length).trim().split("\n").map((raw) => JSON.parse(raw));
  assert.equal(added.length, 1);
  assert.equal(added[0].step, "cli.invoked");
  assert.equal(added[0].actor, "test");
  const production = join(process.env.RMD_TEST_LIVE_DENY_ROOT!, "state", "ledger.ndjson");
  assert.throws(() => appendLedger(production, { run_id: "test", task_id: "test", step: "cli.invoked" }), /REFUSED/);
  assert.throws(() => appendLedger(production, { run_id: "test", task_id: "test", step: "cli.invoked", actor: "operator_human" }, { actor: () => "worker" }), /REFUSED/);
  const saved = process.env.RMD_ALLOW_LIVE_WRITES;
  process.env.RMD_ALLOW_LIVE_WRITES = "1";
  try {
    assert.throws(() => appendLedger(production, { run_id: "test", task_id: "test", step: "cli.invoked" }), /REFUSED/);
  } finally {
    if (saved === undefined) delete process.env.RMD_ALLOW_LIVE_WRITES;
    else process.env.RMD_ALLOW_LIVE_WRITES = saved;
  }
});

function rows(actor: string, verb: string, pid: number): string[] {
  return [1, 2].flatMap((day) => ["cli.invoked", "deploy.skip"].map((step, index) => JSON.stringify({
    actor, actor_pid: pid + day, ts: `2026-09-0${day}T09:0${index}:00Z`, step, verb,
  })));
}

test("W1-T4068: the cadence passes handRunCensus and the census ignores non-human kinds", async () => {
  const humans = [...rows("operator_human", "status", 10), ...rows("operator_ai", "review", 20)];
  const machines = ["service", "host_automation", "daemon", "worker", "test", "unknown", "operator"].flatMap((actor, index) => rows(actor, "deploy-run", 100 + index * 10));
  assert.equal(parseOperatorLedgerRows([...humans, ...machines]).length, humans.length);
  const root = mkdtempSync(join(tmpdir(), "rmd-positive-actor-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "ledger.2026-09-01.ndjson"), humans.join("\n") + "\n");
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const census = censusHandRuns(stateDir);
  assert.equal(census.status, "measured");
  if (census.status === "measured") assert.deepEqual(census.recurrences.map((r) => r.sequence), [["review", "deploy.skip"], ["status", "deploy.skip"]]);
  writeFileSync(join(stateDir, "ledger.ndjson"), machines.join("\n") + "\n");
  const refused = censusHandRuns(stateDir);
  assert.equal(refused.status, "refused");
  if (refused.status === "refused") assert.match(refused.refusedReason, /mostly non-human/);
  let captured = 0;
  const union = (_state: string, pattern: RegExp): LedgerUnionResult => ({ ok: true, stateDir, archiveCount: 1, archiveFiles: ["fixture"], liveFileRead: true, unread: [], matches: humans.filter((raw) => pattern.test(raw)) });
  const boundary = censusHandRuns(stateDir, (_state, pattern) => ({
    ...union(_state, pattern), matches: [...humans, ...machines.slice(0, humans.length), '{"step":'],
  }));
  assert.equal(boundary.status, "measured", "a torn row must not create a non-human majority");
  assert.equal(censusHandRuns(stateDir, (_state, pattern) => ({ ...union(_state, pattern), ok: false })).status, "refused");
  assert.equal(censusHandRuns(stateDir, (_state, pattern) => ({ ...union(_state, pattern), matches: machines })).status, "refused");
  const opts = { root, stateDir, ledgerPath: join(stateDir, "proposals.ndjson"), runId: "fixture", ledgerUnion: union,
    capture: () => { captured++; return { id: `proposal-${captured}` } as ReturnType<NonNullable<Parameters<typeof handRunCensus>[0]["capture"]>>; },
  };
  let supplied: MeasurementCadenceReportOpts | undefined;
  const hooks = buildMeasurementCadenceDaemonHooks({
    config: { root } as Config,
    verifyHumanCadenceResult: async () => ({} as Awaited<ReturnType<NonNullable<CadenceDeps["verifyHumanCadenceResult"]>>>),
    successorWatch: async () => ({} as Awaited<ReturnType<NonNullable<CadenceDeps["successorWatch"]>>>),
    creditedMergedIds: () => new Set(),
    proofDebtInput: () => undefined,
    handRunCensus: opts,
    measurementReport: async (input: MeasurementCadenceReportOpts) => {
      supplied = input;
      return runMeasurementCadenceReport({ stateDir, cwd: root, checkoutDir: root, escalate: false, gitLog: () => ({ dump: "", ref: "fixture" }), handRunCensus: input.handRunCensus });
    },
  } as Parameters<typeof buildMeasurementCadenceDaemonHooks>[0]);
  const result = await hooks.runMeasurementCadence();
  assert.ok(supplied?.handRunCensus);
  assert.equal(supplied.handRunCensus.ledgerPath, join(stateDir, "ledger.ndjson"));
  assert.match(supplied.handRunCensus.runId, /^MEASUREMENT-CADENCE-/);
  assert.equal(result.handRunCensus?.status, "measured");
  assert.equal(captured, 2);
  const markers = readFileSync(supplied.handRunCensus.ledgerPath, "utf8").trim().split("\n").filter((raw) => JSON.parse(raw).step === "hand_run.census_proposed");
  const dedup = handRunCensus({ ...opts, ledgerUnion: (_state, pattern) => ({ ...union(_state, pattern), matches: [...humans, ...markers].filter((raw) => pattern.test(raw)) }) });
  assert.equal(dedup.status, "measured");
  if (dedup.status === "measured") assert.equal(dedup.skippedDuplicateSignatures.length, 2);
  assert.equal(captured, 2);
  const noFiles = handRunCensus({ ...opts, ledgerUnion: (_state, pattern) => ({ ...union(_state, pattern), matches: [...humans, ...machines] }) });
  assert.equal(noFiles.status, "refused");
  assert.equal(captured, 2);
  const productionDefaults = buildMeasurementCadenceDaemonHooks({
    config: { root } as Config,
    verifyHumanCadenceResult: async () => ({} as Awaited<ReturnType<NonNullable<CadenceDeps["verifyHumanCadenceResult"]>>>),
    successorWatch: async () => ({} as Awaited<ReturnType<NonNullable<CadenceDeps["successorWatch"]>>>),
    creditedMergedIds: () => new Set(),
    proofDebtInput: () => undefined,
    measurementReport: async (input) => {
      assert.ok(input.handRunCensus);
      assert.equal(input.handRunCensus.root, input.checkoutDir);
      return runMeasurementCadenceReport({ stateDir, cwd: root, checkoutDir: root, escalate: false, gitLog: () => ({ dump: "", ref: "fixture" }), handRunCensus: input.handRunCensus });
    },
  });
  assert.equal((await productionDefaults.runMeasurementCadence()).handRunCensus?.status, "refused");
});
