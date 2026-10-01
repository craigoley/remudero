// Arch Phase 4 (design D5 row 3): GET /v1/inbox wrote the classification snapshot the daemon's fleet
// lane files from (W1-T4089), so with no viewer the lane decided on readiness as old as the last human
// read (6 h in the Phase 0 measurement). The slow lane now refreshes it on a cadence, and a read
// writes nothing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { readClassificationSnapshot, triageFleetLane } from "../src/lib/fleet-lane.js";
import { INBOX_CLASSIFICATION_RESTAMP_MS, refreshInboxClassification } from "../src/lib/inbox-view.js";
import { buildInboxRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { runSlowLaneWorker, threadSlowLane, type SlowLaneMessage } from "../src/lib/read-model-slow-lane.js";
import { runReadModelWorker } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { ghShim, type GhShim } from "./helpers/gh-shim.js";
import { allowGhRefusals } from "./setup/tmp-hygiene.js";

allowGhRefusals("the real slow lane thread re-runs test setup, which puts the refusal stub ahead of this file's shim on that thread's PATH; an empty plan classifies the same with its board read refused");

/** The lane's own board gateway lists PRs even for an empty plan: answer it with no PRs, offline. */
function offlineGh(t: TestCtx): GhShim {
  const shim = ghShim([{ when: "pulls?state=", stdout: "[]" }, { when: "issues?", stdout: "[]" }]);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  t.after(() => void (process.env.PATH = path));
  return shim;
}

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-01T02:00:00.000Z");

function world(t: TestCtx, proposals: string[], ratified: string[] = []): { root: string; stateDir: string; registry: string; deps: PanelGraphDeps } {
  const root = makeTempDir("rmd-inbox-slow-lane");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, ratified.map((id) => `${JSON.stringify({ ts: "2026-10-01T01:00:00.000Z", step: "ratify.approved", task_id: id })}\n`).join(""));
  const registry = join(stateDir, "inbox-proposals.json");
  writeProposals(registry, proposals);
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true,
  };
  return { root, stateDir, registry, deps };
}

function writeProposals(registry: string, ids: string[]): void {
  writeFileSync(registry, JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [] })) }));
}

/** A port the lane's body runs against in this thread, with a hand-driven timer. */
function lanePort(): { port: Parameters<typeof runSlowLaneWorker>[0]; send: (msg: { type: string; held?: boolean }) => void; posted: SlowLaneMessage[]; units: () => number } {
  let onMessage: ((msg: { type?: string; held?: unknown }) => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  return {
    port: { on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) },
    send: (msg) => onMessage?.(msg),
    posted,
    units: () => posted.filter((m) => m.type === "unit" && m.unit === "inbox").length,
  };
}

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), "the awaited condition held in time");
}

test("with zero gets the inbox classification refreshes on schedule", async (t) => {
  const { stateDir, registry, deps } = world(t, ["ruling:a", "adoption:symbol-no-caller:src/lib/a.ts:x"]);
  let nowMs = T0;
  const clock: Clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const fire = (): void => {
    const timer = timers.filter((x) => !x.cancelled).at(-1);
    assert.ok(timer, "a pass is scheduled");
    timer.cancelled = true;
    timer.run();
  };
  const { port, send, posted, units } = lanePort();
  const lane = runSlowLaneWorker(port, { inbox: { root: deps.root, planPath: deps.planPath, ledgerPath: deps.ledgerPath, inboxRoot: deps.inboxRoot, repository: "o/r" }, intervalMs: 60_000 }, {
    clock,
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    inbox: deps,
  });
  t.after(() => lane.stop());

  fire();
  await sleep(20);
  assert.equal(units(), 0, "without the lease the lane runs nothing");
  assert.equal(readClassificationSnapshot(stateDir), undefined);

  send({ type: "lease", held: true });
  await until(() => units() === 1);
  const first = readClassificationSnapshot(stateDir);
  assert.deepEqual(Object.keys(first?.states ?? {}).sort(), ["adoption:symbol-no-caller:src/lib/a.ts:x", "ruling:a"], "a held lease classifies at once, with no reader");
  assert.equal(first?.generatedAt, new Date(T0).toISOString());
  assert.ok(posted.some((m) => m.type === "log" && m.step === "inbox.classification_written"), "a changed classification is ledgered");

  writeProposals(registry, ["ruling:a", "adoption:symbol-no-caller:src/lib/a.ts:x", "ruling:b"]);
  nowMs += 60_000;
  fire();
  await until(() => units() === 2);
  const second = readClassificationSnapshot(stateDir);
  assert.ok(second?.states["ruling:b"], "a new proposal reaches the snapshot on the next scheduled pass");
  assert.equal(second?.generatedAt, new Date(T0 + 60_000).toISOString());
  assert.equal(timers.filter((x) => !x.cancelled).at(-1)?.ms, 60_000, "the next pass waits one interval");

  nowMs += 60_000;
  fire();
  await until(() => units() === 3);
  assert.equal(readClassificationSnapshot(stateDir)?.generatedAt, new Date(T0 + 60_000).toISOString(), "an unchanged classification is not rewritten before its re-stamp");

  nowMs += INBOX_CLASSIFICATION_RESTAMP_MS;
  fire();
  await until(() => units() === 4);
  assert.equal(readClassificationSnapshot(stateDir)?.generatedAt, new Date(nowMs).toISOString(), "an unchanged classification is re-stamped, so its age says when it was last checked");

  send({ type: "lease", held: false });
  nowMs += INBOX_CLASSIFICATION_RESTAMP_MS;
  fire();
  await sleep(20);
  assert.equal(units(), 4, "a serve that lost the lease stops writing");
});

test("the inbox get route writes nothing", async (t) => {
  const { stateDir, registry, deps } = world(t, ["ruling:a", "ruling:done"], ["ruling:done"]);
  const before = readFileSync(registry, "utf8");
  const route = buildInboxRoute(deps);
  const server = createServer((req, res) => void route.handler(req, res, { params: {} } as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { counts: Record<string, unknown> };
  assert.ok(body.counts, "the read answered");
  assert.equal(existsSync(join(stateDir, "inbox-classified.json")), false, "a read writes no classification snapshot");
  assert.equal(readFileSync(registry, "utf8"), before, "a read prunes nothing from the registry");
});

test("the slow lane prunes a ratified proposal with no reader", async (t) => {
  const { stateDir, registry, deps } = world(t, ["ruling:a", "ruling:done"], ["ruling:done"]);
  const refreshed = await refreshInboxClassification(deps, {}, fixedClock(T0));
  assert.equal(refreshed.pruned, 1);
  assert.deepEqual((JSON.parse(readFileSync(registry, "utf8")) as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id), ["ruling:a"]);
  assert.equal(readClassificationSnapshot(stateDir)?.states["ruling:done"], "ratified");
  const again = await refreshInboxClassification(deps, {}, fixedClock(T0 + 1_000));
  assert.deepEqual([again.pruned, again.changed, again.written], [0, true, true], "a fresh memo seeds from the snapshot on disk and sees the pruned row gone");
});

test("the fleet lane reports the age of the classification it acted on", (t) => {
  const { stateDir, deps } = world(t, []);
  writeFileSync(join(stateDir, "inbox-classified.json"), JSON.stringify({ generatedAt: new Date(T0).toISOString(), states: {} }));
  const pass = triageFleetLane({ stateDir, ledgerPath: deps.ledgerPath, mergedLastDay: () => 0, approve: () => undefined, clock: fixedClock(T0 + 90_000) });
  assert.equal(pass.classificationAgeMs, 90_000);
  writeFileSync(join(stateDir, "inbox-classified.json"), JSON.stringify({ states: {} }));
  assert.equal(triageFleetLane({ stateDir, ledgerPath: deps.ledgerPath, mergedLastDay: () => 0, approve: () => undefined, clock: fixedClock(T0) }).classificationAgeMs, undefined);
});

test("a slow lane unit that throws is reported and the lane keeps its cadence", async (t) => {
  const { deps } = world(t, ["ruling:a"]);
  const { port, send, posted, units } = lanePort();
  const lane = runSlowLaneWorker(port, { inbox: { root: deps.root, planPath: deps.planPath, ledgerPath: deps.ledgerPath, inboxRoot: deps.inboxRoot, repository: "o/r" } }, {
    inbox: { ...deps, inboxMainSha: () => { throw new Error("no git here"); } },
  });
  t.after(() => lane.stop());
  send({ type: "ping" });
  send({ type: "lease", held: true });
  await until(() => units() === 1);
  assert.deepEqual(posted.filter((m) => m.type === "unit").map((m) => m.type === "unit" && [m.unit, m.ok]), [["inbox", false], ["feedback", true]], "one unit failing leaves the other running");
  const failed = posted.find((m) => m.type === "log" && m.step === "read_model.slow_unit_failed");
  assert.match(String(failed?.type === "log" ? failed.extra.error : undefined), /no git here/);
});

test("the lane reads the owner's board snapshot when no gateway is injected", async (t) => {
  const shim = offlineGh(t);
  const { stateDir, deps } = world(t, ["ruling:a"]);
  const { port, send, posted, units } = lanePort();
  const { statusGithub: _injected, ...rest } = deps;
  const lane = runSlowLaneWorker(port, { inbox: { root: deps.root, planPath: deps.planPath, ledgerPath: deps.ledgerPath, inboxRoot: deps.inboxRoot, repository: "o/r" } }, { inbox: rest });
  t.after(() => lane.stop());
  send({ type: "lease", held: true });
  await until(() => units() === 1);
  assert.ok(readClassificationSnapshot(stateDir)?.states["ruling:a"], "classified over the snapshot's source");
  const inbox = posted.find((m) => m.type === "bodies" && m.view === "inbox");
  assert.equal(inbox?.type === "bodies" && inbox.bodies[0]?.sources.find((s) => s.name === "github:o/r")?.state, "unavailable", "no owner walk yet, and the body says so");
  assert.deepEqual(shim.calls(), [], "the lane spawned no gh of its own");
});

/** A module the lane's thread can load in place of the real one. */
function laneModule(t: TestCtx, body: string): URL {
  const dir = makeTempDir("rmd-slow-lane-module");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "lane.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";\n${body}\n`);
  return pathToFileURL(path);
}

test("a slow lane thread that dies is respawned and its unit retried", async (t) => {
  const marker = join(makeTempDir("rmd-slow-lane-marker"), "spawns");
  t.after(() => rmSync(join(marker, ".."), { recursive: true, force: true }));
  const workerUrl = laneModule(t, `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "x");
parentPort.on("message", (msg) => {
  if (msg.type !== "lease" || !msg.held) return;
  parentPort.postMessage({ type: "log", step: "lane.saw_lease", extra: {} });
  if (readFileSync(${JSON.stringify(marker)}, "utf8").length === 1) throw new Error("lane boom");
  parentPort.postMessage({ type: "unit", unit: "inbox", ok: true, ms: 1 });
});`);
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const lane = threadSlowLane({ config: { intervalMs: 50 }, workerUrl, log: (step, extra) => logs.push({ step, extra }) });
  t.after(() => lane.close());
  lane.lease(false);
  await sleep(100);
  assert.equal(existsSync(marker), false, "no thread is spawned before this serve holds the lease");
  lane.lease(true);
  lane.lease(true);
  await until(() => logs.filter((l) => l.step === "lane.saw_lease").length >= 2);
  assert.equal(readFileSync(marker, "utf8"), "xx", "the dead thread was respawned once");
  const exited = logs.find((l) => l.step === "read_model.slow_lane_exited");
  assert.equal(exited?.extra.respawnInMs, 100, "the first respawn waits twice the interval");
  assert.match(String(logs.find((l) => l.step === "read_model.slow_lane_failed")?.extra.error), /lane boom/);
});

test("a closed slow lane does not respawn", async (t) => {
  const workerUrl = laneModule(t, `parentPort.on("message", () => { throw new Error("die"); });`);
  const logs: string[] = [];
  const lane = threadSlowLane({ config: { intervalMs: 20 }, workerUrl, log: (step) => logs.push(step) });
  lane.lease(true);
  await until(() => logs.includes("read_model.slow_lane_exited"));
  lane.close();
  lane.lease(false);
  await sleep(150);
  assert.equal(logs.filter((s) => s === "read_model.slow_lane_exited").length, 1, "nothing respawns after close");
  const deadUrl = laneModule(t, `process.exit(3);`);
  const closing = threadSlowLane({ config: {}, workerUrl: deadUrl, log: (step) => logs.push(`closing:${step}`) });
  closing.lease(true);
  closing.close();
  await sleep(150);
  assert.ok(!logs.includes("closing:read_model.slow_lane_exited"), "a lane closed while its thread exits ignores the exit");
});

test("the read-model worker relays its home lease to a real slow lane thread that classifies with no reader", async (t) => {
  offlineGh(t);
  const { stateDir: inboxState, deps } = world(t, ["ruling:a"]);
  const stateDir = makeTempDir("rmd-slow-lane-relay");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const posted: Array<{ type?: string; step?: string }> = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  runReadModelWorker(
    { on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as { type?: string }), close: () => {} },
    {
      kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 20, signal: new SharedArrayBuffer(8),
      slowLane: { intervalMs: 60_000, inbox: { root: deps.root, planPath: deps.planPath, ledgerPath: deps.ledgerPath, inboxRoot: deps.inboxRoot, repository: "o/r" } },
    },
  );
  t.after(() => onMessage?.({ type: "stop" }));
  await until(() => readClassificationSnapshot(inboxState)?.states["ruling:a"] !== undefined, 60_000);
  onMessage?.({ type: "stop" });
  assert.ok(posted.some((m) => m.step === "read_model.stopped"), "stopping the worker closes the lane with it");
});
