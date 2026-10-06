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
import { assessGatewayCheckout, buildServeServer, gateStaleCodeExit, resolveConsoleSha, serveGeneration, SERVE_HANDOFF_COALESCE_MS, type GatewayCheckoutAssessment, type ServeDeps } from "../src/lib/serve.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Plan } from "../src/lib/plan.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { gitRepo } from "./helpers/git-repo.js";

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
  let now = CLOCK.now();
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    resolveCommitsBehind: () => 0,
    exit: (code) => exits.push(code),
    clock: clockFromMillisFn(() => now),
    // A generation that has already served a full coalescing window.
    bootedAt: CLOCK.now() - SERVE_HANDOFF_COALESCE_MS,
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
  now += SERVE_HANDOFF_COALESCE_MS;
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

test("a supervised serve reads its real checkout past the boot-sync guard the supervisor sets, so it can ask for a handoff", async (t) => {
  const upstream = gitRepo({ kind: "handoff-upstream" });
  const served = gitRepo({ kind: "handoff-served", cloneFrom: upstream.dir });
  t.after(() => {
    upstream.cleanup();
    served.cleanup();
  });
  mkdirSync(join(upstream.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(upstream.dir, "src", "lib", "serve.ts"), "export {};\n");
  upstream.git("add", "src/lib/serve.ts");
  upstream.git("commit", "--quiet", "-m", "a serve change");
  const saved = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  t.after(() => {
    if (saved === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = saved;
  });
  const env = { [SELF_SYNC_GUARD_ENV]: "1" };

  const unsupervised = await assessGatewayCheckout({ repoDir: served.dir, env, clock: CLOCK });
  assert.equal(unsupervised.restartDue, false);
  assert.match(unsupervised.state.detail ?? "", /guarded/, "a self-synced CLI child still never assesses");

  const supervised = await assessGatewayCheckout({ repoDir: served.dir, env, clock: CLOCK, supervised: true });
  assert.equal(supervised.state.behindBy, 1);
  assert.equal(supervised.restartDue, true, "the generation sees main moved a path it loads");
});

// OPERATOR RULING 2026-10-06: code handoffs are coalesced into one per SERVE_HANDOFF_COALESCE_MS;
// plan-only advances keep reloading in place at once.
const MIN = 60_000;
const T0 = Date.parse("2026-10-06T12:00:00Z");
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

function behindAt(targetSha: string, behindBy: number, reloadPlanAt?: string): GatewayCheckoutAssessment {
  return {
    state: { head: "a".repeat(40), behindBy, dirty: false, checkedAt: CLOCK.iso() },
    restartDue: true,
    targetSha,
    ...(reloadPlanAt === undefined ? {} : { reloadPlanAt }),
  };
}

function coalescingGate(assess: () => Promise<GatewayCheckoutAssessment>, extra: Partial<Parameters<typeof gateStaleCodeExit>[0]> = {}) {
  const clock = { at: T0 };
  const asked: Array<Record<string, unknown>> = [];
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const exits: number[] = [];
  const reloads: string[] = [];
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    resolveCommitsBehind: () => 0,
    exit: (code) => exits.push(code),
    clock: clockFromMillisFn(() => clock.at),
    bootedAt: T0,
    scheduleRecheck: () => () => {},
    log: (step, detail) => rows.push([step, detail]),
    assessCheckout: assess,
    reloadPlan: async (ref) => (reloads.push(ref), true),
    requestHandoff: (detail) => asked.push(detail),
    ...extra,
  });
  const coalesced = () => rows.filter(([step]) => step === "serve.handoff_coalesced").map(([, detail]) => detail);
  return { gate, clock, asked, rows, exits, reloads, coalesced };
}

const settleLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("two relevant merges three minutes apart ride one handoff after the window, to the newer sha", async () => {
  let assessment = behindAt(SHA1, 1);
  const g = coalescingGate(async () => assessment);
  g.clock.at = T0 + 5 * MIN;
  await g.gate.recheck();
  assert.equal(g.asked.length, 0, "the first relevant merge waits for the window");
  assessment = behindAt(SHA2, 2);
  g.clock.at = T0 + 8 * MIN;
  await g.gate.recheck();
  g.clock.at = T0 + SERVE_HANDOFF_COALESCE_MS - 1;
  await g.gate.recheck();
  assert.equal(g.asked.length, 0, "and so does the second, until the window closes");
  g.clock.at = T0 + SERVE_HANDOFF_COALESCE_MS;
  await g.gate.recheck();
  assert.equal(g.asked.length, 1, "both merges ride ONE handoff");
  assert.equal(g.asked[0].targetSha, SHA2, "aimed at the newest origin/main");
  assert.deepEqual(g.coalesced(), [{ firstSeenSha: SHA1, targetSha: SHA2, waitedMs: 10 * MIN, mergesAbsorbed: 2, windowMs: SERVE_HANDOFF_COALESCE_MS }]);
});

test("a relevant merge after a long-idle generation asks at once, and one inside the first window waits for its boundary", async () => {
  const idle = coalescingGate(async () => behindAt(SHA1, 1));
  idle.clock.at = T0 + 120 * MIN;
  await idle.gate.recheck();
  assert.equal(idle.asked.length, 1, "the window measured from boot closed long ago");
  assert.deepEqual(idle.coalesced(), [], "nothing waited, so nothing is coalesced");

  const fresh = coalescingGate(async () => behindAt(SHA1, 1));
  fresh.clock.at = T0 + 10 * MIN;
  await fresh.gate.recheck();
  fresh.clock.at = T0 + SERVE_HANDOFF_COALESCE_MS - 1;
  await fresh.gate.recheck();
  assert.equal(fresh.asked.length, 0, "a merge 10 min after boot waits out the window measured from boot");
  fresh.clock.at = T0 + SERVE_HANDOFF_COALESCE_MS;
  await fresh.gate.recheck();
  assert.equal(fresh.asked.length, 1, "and asks at its boundary");
});

/** assessGatewayCheckout over a hermetic git that diffs the boot sha against `diff()`'s paths. */
function hermeticAssess(diff: () => string, origin: () => string) {
  return () =>
    assessGatewayCheckout({
      repoDir: "/nonexistent",
      env: {},
      fetch: async () => {},
      clock: CLOCK,
      git: (args) => {
        if (args[0] === "rev-parse") return args[1] === "HEAD" ? `${"a".repeat(40)}\n` : `${origin()}\n`;
        if (args[0] === "diff") return diff();
        if (args[0] === "rev-list") return "1\n";
        return "";
      },
    });
}

test("a plan-only merge inside a coalescing window reloads the plan in place at once", async () => {
  let paths = "src/lib/serve.ts\n";
  let origin = SHA1;
  const g = coalescingGate(hermeticAssess(() => paths, () => origin));
  g.clock.at = T0 + 2 * MIN;
  await g.gate.recheck();
  await settleLoop();
  assert.equal(g.asked.length, 0, "the code merge is coalesced");
  // The diff from boot is cumulative, so the plan-only merge on top still reads code-relevant.
  paths = "src/lib/serve.ts\nplan/tasks.d/W1-T2-x.yaml\n";
  origin = SHA2;
  g.clock.at = T0 + 3 * MIN;
  await g.gate.recheck();
  await settleLoop();
  assert.deepEqual(g.reloads, [SHA2], "the plan-only merge is served now, not after the window");
  assert.equal(g.asked.length, 0);
});

test("a merge that changes code and a reloadable plan file reloads the plan now and hands off the code at the window", async () => {
  const g = coalescingGate(hermeticAssess(() => "src/lib/serve.ts\nplan/tasks.d/W1-T2-x.yaml\n", () => SHA1));
  g.clock.at = T0 + 1 * MIN;
  await g.gate.recheck();
  await settleLoop();
  assert.deepEqual(g.reloads, [SHA1], "the plan half reloads in place at once");
  assert.equal(g.asked.length, 0, "the code half waits");
  g.clock.at = T0 + SERVE_HANDOFF_COALESCE_MS;
  await g.gate.recheck();
  await settleLoop();
  assert.equal(g.asked.length, 1, "and is handed off at the window boundary");
  assert.equal(g.asked[0].targetSha, SHA1);
});

test("the supervisor's drain bypasses an open coalescing window", async () => {
  const g = coalescingGate(async () => behindAt(SHA1, 1), { drain: async () => {} });
  g.clock.at = T0 + 1 * MIN;
  await g.gate.recheck();
  assert.equal(g.asked.length, 0, "a handoff is being coalesced");
  await g.gate.handover("generation_crashed");
  assert.deepEqual(g.exits, [0], "a forced drain does not wait for the window");
  g.clock.at = T0 + SERVE_HANDOFF_COALESCE_MS;
  await g.gate.recheck();
  assert.equal(g.asked.length, 0, "and a drained generation never asks afterwards");
});

test("a coalescing window writes one serve.handoff_coalesced row however many polls it spans", async () => {
  let behindBy = 0;
  const g = coalescingGate(async () => ({ ...behindAt(behindBy === 1 ? SHA1 : SHA2, behindBy), restartDue: behindBy > 0 }));
  for (let minute = 1; minute <= 20; minute += 1) {
    if (minute === 2 || minute === 6 || minute === 11) behindBy += 1;
    g.clock.at = T0 + minute * MIN;
    await g.gate.recheck();
  }
  assert.equal(g.coalesced().length, 1, "one row for the window, not one per poll");
  assert.equal(g.coalesced()[0]?.mergesAbsorbed, 3);
  assert.equal(g.asked.length, 1);
  assert.equal(g.rows.filter(([step]) => step === "serve.handoff_requested").length, 1);
});
