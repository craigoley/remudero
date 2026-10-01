/**
 * The serve side of a supervised handoff (arch-phase3-design.md §5, P3-06 and P3-08): a supervised
 * serve that finds its code stale ASKS for a handoff instead of exiting, drains on the supervisor's
 * word, and a standby starts no ledger writer before it is promoted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServeServer, gateStaleCodeExit, resolveConsoleSha, serveGeneration, type GatewayCheckoutAssessment, type ServeDeps } from "../src/lib/serve.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Plan } from "../src/lib/plan.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const CLOCK = fixedClock(Date.parse("2026-10-01T12:00:00Z"));
const BEHIND: GatewayCheckoutAssessment = {
  state: { head: "a".repeat(40), behindBy: 2, dirty: false, checkedAt: CLOCK.iso() },
  restartDue: true,
};

test("a supervised serve sends a handoff request instead of exiting", async () => {
  const exits: number[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const steps: string[] = [];
  let assessment = BEHIND;
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    resolveCommitsBehind: () => 0,
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    log: (step) => steps.push(step),
    assessCheckout: async () => assessment,
    // A watched console waits out its patience before an exit; a handoff costs no interruption, so it does not.
    lastReadAt: () => CLOCK.now(),
    requestHandoff: (detail) => asked.push(detail),
  });
  await gate.recheck();
  assert.deepEqual(exits, [], "it never exits on its own when supervised");
  assert.equal(asked.length, 1, "it asks the supervisor at once, with no recycle patience");
  assert.equal(asked[0].reason, "checkout_behind");
  assert.equal(asked[0].patienceMs, 0);
  await gate.recheck();
  assert.equal(asked.length, 1, "the same stale state is asked about once");
  assessment = { ...BEHIND, state: { ...BEHIND.state, behindBy: 3 } };
  await gate.recheck();
  assert.equal(asked.length, 2, "a newer origin asks again, so the supervisor can target the newest sha");
  assert.deepEqual(steps.filter((s) => s === "serve.handoff_requested").length, 2);
  assert.equal(steps.includes("serve.stale_code_exit"), false);
});

test("an unsupervised serve still exits 0 after patience", async () => {
  const exits: number[] = [];
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    resolveCommitsBehind: () => 0,
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    assessCheckout: async () => BEHIND,
  });
  await gate.recheck();
  assert.deepEqual(exits, [0]);
});

test("the supervisor's drain runs the drain once and then exits", async () => {
  const exits: number[] = [];
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    log: (step, extra) => order.push(`${step}:${String(extra?.reason)}`),
    beforeExit: () => order.push("beforeExit"),
    drain: () => new Promise<void>((resolve) => (release = () => (order.push("drained"), resolve()))),
  });
  const first = gate.handover("handoff");
  const second = gate.handover("again");
  assert.deepEqual(exits, [], "not before the drain finishes");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(exits, [0], "exactly one exit for two drain requests");
  assert.deepEqual(order, ["serve.handover_drain:handoff", "serve.handover_drain:again", "drained", "beforeExit"]);
});

function handoffServeDeps(extra: Partial<ServeDeps>): ServeDeps {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}handoff-serve-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const plan: Plan = { tasks: [], byId: new Map() };
  return {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "handoff-read", write: "handoff-write" },
    consoleSha: resolveConsoleSha(),
    daemonHealth: { exec: () => "{}", statfs: () => ({ bavail: 1, bsize: 1 }) },
    gatewayCheckout: async () => ({ ...BEHIND, restartDue: false }),
    staleExitSeams: { scheduleRecheck: () => () => {}, exit: () => {} },
    ...extra,
  };
}

test("a standby serve starts no background writer until it listens", async () => {
  const started: string[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const incidentInvariants = { setInterval: ((() => (started.push("incident"), 0)) as unknown) as typeof setInterval, clearInterval: () => {} };
  const standby = buildServeServer(handoffServeDeps({ incidentInvariants, generation: { requestHandoff: (d) => asked.push(d) } }));
  assert.deepEqual(started, [], "the incident evaluator waits for the promote, so two generations never double its rows");
  const generation = serveGeneration(standby);
  assert.ok(generation, "a built server exposes its generation hooks");
  assert.deepEqual(generation.probes.map((p) => p(new URLSearchParams()).name), ["plan_loaded", "github_auth_settled", "gateway_primed", "read_model_warm"]);
  await new Promise<void>((resolve) => standby.listen(0, "127.0.0.1", resolve));
  assert.deepEqual(started, ["incident"], "and starts once the generation is promoted and listening");
  const { port } = standby.address() as AddressInfo;
  const closed = new Promise<void>((resolve) => standby.once("close", () => resolve()));
  await generation.handover("handoff");
  await closed;
  assert.equal(standby.listening, false, "the supervisor's drain closed the listener");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/version`), "and nothing answers after it");

  const legacy: string[] = [];
  const unsupervised = buildServeServer(handoffServeDeps({ incidentInvariants: { ...incidentInvariants, setInterval: ((() => (legacy.push("incident"), 0)) as unknown) as typeof setInterval } }));
  assert.deepEqual(legacy, ["incident"], "unsupervised, the writers start at construction exactly as before");
  unsupervised.close();
});
