// test/the-gateway-reads-current-code.test.ts — W1-T4229.
//
// MEASURED 2026-09-23: remudero-serve's own clone (~/rmd-serve-repo) sat 6 commits behind
// origin/main, so GET /v1/repos answered [] after managed-repos.json changed on main. The daemons
// stay current through their freshness exit and deploy/entrypoint.sh's boot sync; nothing moved
// the gateway's clone. These tests drive the gateway's equivalent: serve reads its checkout
// against origin/main at the stale-code gate's existing cadence, exits for a clean tree that is
// behind, and deploy/entrypoint.sh — run for real below, as docker's unless-stopped restart would
// — fast-forwards it before serve loads again. A dirty tree is reported and never touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Agent, createServer, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessGatewayCheckout,
  buildServeServer,
  gateStaleCodeExit,
  resolveConsoleSha,
  serveRepoDir,
  type GatewayCheckoutAssessment,
  type ServeDeps,
} from "../src/lib/serve.js";
import { buildDaemonHealthRoute, GATEWAY_CHECKOUT_UNCHECKED, type GatewayCheckoutState } from "../src/lib/daemon-health.js";
import { createService } from "../src/lib/service.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import type { Plan } from "../src/lib/plan.js";

import { REPO_ROOT } from "#test/helpers/repo-root.js";
const ENTRYPOINT = join(REPO_ROOT, "deploy", "entrypoint.sh");
const CLOCK = fixedClock(Date.parse("2026-09-23T12:00:00Z"));
const READ_TOKEN = "gateway-checkout-read";

interface Gateway {
  origin: GitRepo;
  home: string;
  tree: string;
  /** Local git in the gateway's clone. */
  git: (...args: string[]) => string;
}

/** An origin with the files a real boot needs, and the gateway's clone of it placed where
 *  deploy/entrypoint.sh looks for it: `$HOME/Remudero/remudero`. */
function setUpGateway(): Gateway {
  const origin = gitRepo({ kind: "gateway-origin" });
  writeFileSync(join(origin.dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(join(origin.dir, "bin"), { recursive: true });
  writeFileSync(join(origin.dir, "bin", "rmd"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(origin.dir, "bin", "rmd"), 0o755);
  origin.git("add", "-A");
  origin.git("commit", "--quiet", "-m", "boot files");
  const clone = gitRepo({ kind: "gateway-clone", cloneFrom: origin.dir });
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gateway-home-`));
  mkdirSync(join(home, "Remudero"), { recursive: true });
  const tree = join(home, "Remudero", "remudero");
  symlinkSync(clone.dir, tree);
  // Present so the entrypoint skips its bootstrap `npm ci`; untracked, so never "dirty" (-uno).
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(tree, "node_modules", ".bin", "tsx"), "#!/bin/sh\n");
  chmodSync(join(tree, "node_modules", ".bin", "tsx"), 0o755);
  return { origin, home, tree, git: clone.git };
}

/** A merge lands on main: the managed-repos file the measured outage was missing. */
function advanceMain(origin: GitRepo): string {
  mkdirSync(join(origin.dir, ".remudero"), { recursive: true });
  writeFileSync(join(origin.dir, ".remudero", "managed-repos.json"), '{"repos":["craigoley/remudero"]}\n');
  origin.git("add", "-A");
  origin.git("commit", "--quiet", "-m", "own the repo");
  return origin.git("rev-parse", "HEAD");
}

/** The real container boot, as docker's unless-stopped restart runs it after serve exits. */
function bootEntrypoint(gw: Gateway): { status: number | null; out: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("RMD_")));
  const r = spawnSync("bash", [ENTRYPOINT, "true"], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: REPO_ROOT,
    env: { ...env, HOME: gw.home, RMD_REPO_URL: gw.origin.dir, RMD_REF: "main", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function recordingGate(bootSha: string, assess: () => Promise<GatewayCheckoutAssessment>) {
  const exits: number[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const gate = gateStaleCodeExit({
    bootSha,
    // The on-disk sha never moves by itself — that is the defect. Only the checkout read can see it.
    resolveCurrentSha: () => bootSha,
    resolveCommitsBehind: () => 0,
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    log: (step, extra) => logs.push({ step, extra }),
    assessCheckout: assess,
  });
  return { gate, exits, logs };
}

// ── claim 1 ────────────────────────────────────────────────────────────────────────────────────

test("a gateway checkout behind main is fast-forwarded when clean and reloaded", async () => {
  const gw = setUpGateway();
  const bootSha = gw.git("rev-parse", "HEAD");
  const mainSha = advanceMain(gw.origin);
  // Real git and the real async fetch; only the environment is pinned, so a CI runner's own
  // CI=true guard does not decide this test.
  const assess = () => assessGatewayCheckout({ repoDir: gw.tree, env: {}, clock: CLOCK });

  const before = await assess();
  assert.deepEqual(before.state, { head: bootSha, behindBy: 1, dirty: false, checkedAt: CLOCK.iso() });
  assert.equal(before.restartDue, true, "clean and behind is the state a restart fixes");

  const { gate, exits, logs } = recordingGate(bootSha, assess);
  await gate.recheck();
  assert.deepEqual(exits, [0], "nobody watching, nothing writing: the gate exits for the restart");
  const exitLog = logs.find((l) => l.step === "serve.stale_code_exit");
  assert.equal(exitLog?.extra?.reason, "checkout_behind", JSON.stringify(logs));
  assert.equal(exitLog?.extra?.commitsBehind, 1);
  assert.equal(gw.git("rev-parse", "HEAD"), bootSha, "serve itself never moves the checkout — the entrypoint does");

  const boot = bootEntrypoint(gw);
  assert.equal(boot.status, 0, boot.out);
  assert.equal(gw.git("rev-parse", "HEAD"), mainSha, `the boot sync fast-forwarded the clean clone:\n${boot.out}`);
  assert.ok(readFileSync(join(gw.tree, ".remudero", "managed-repos.json"), "utf8").includes("craigoley/remudero"));

  // Reloaded: the new process boots on main's sha, reads current, and stays up.
  const after = await assess();
  assert.deepEqual(after.state, { head: mainSha, behindBy: 0, dirty: false, checkedAt: CLOCK.iso() });
  const reloaded = recordingGate(mainSha, assess);
  await reloaded.gate.recheck();
  assert.deepEqual(reloaded.exits, [], "a current checkout never restarts, so the restart cannot loop");
});

// ── claim 2 ────────────────────────────────────────────────────────────────────────────────────

test("a dirty gateway checkout is reported, never overwritten", async () => {
  const gw = setUpGateway();
  const bootSha = gw.git("rev-parse", "HEAD");
  advanceMain(gw.origin);
  const local = '{"name":"fixture","version":"1.0.0","local":"edit"}\n';
  writeFileSync(join(gw.tree, "package.json"), local);
  const assess = () => assessGatewayCheckout({ repoDir: gw.tree, env: {}, clock: CLOCK });

  const reading = await assess();
  assert.deepEqual(reading.state, {
    head: bootSha,
    behindBy: 1,
    dirty: true,
    dirtyPaths: ["package.json"],
    checkedAt: CLOCK.iso(),
  });
  assert.equal(reading.restartDue, false, "a dirty tree is never a restart: the entrypoint would refuse it and loop");

  const { gate, exits, logs } = recordingGate(bootSha, assess);
  await gate.recheck();
  await gate.recheck();
  assert.deepEqual(exits, [], "the gate never exits for a dirty checkout");
  const dirty = logs.filter((l) => l.step === "serve.gateway_checkout_dirty");
  assert.equal(dirty.length, 1, `reported once, not once per re-check: ${JSON.stringify(logs)}`);
  assert.deepEqual(dirty[0]?.extra, { head: bootSha, behindBy: 1, dirtyPaths: ["package.json"] });
  assert.deepEqual(gate.checkout()?.dirtyPaths, ["package.json"], "and the paths are on the reading health serves");
  assert.equal(readFileSync(join(gw.tree, "package.json"), "utf8"), local, "the local edit is untouched");
  assert.equal(gw.git("rev-parse", "HEAD"), bootSha, "and HEAD never moved");
});

// ── claim 3 ────────────────────────────────────────────────────────────────────────────────────

async function getHealth(state: (() => GatewayCheckoutState | undefined) | undefined): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gateway-health-`));
  const server = createService({
    tokens: { read: READ_TOKEN, write: "gateway-checkout-write" },
    routes: [
      buildDaemonHealthRoute({
        ledgerPath: join(dir, "ledger.ndjson"),
        readLedger: () => [],
        diskPath: dir,
        statfs: () => ({ bavail: 1, bsize: 1 }),
        exec: () => "{}",
        now: () => CLOCK.now(),
        eventLoopLag: () => undefined,
        hostPressure: () => ({ cpu: "unknown", io: "unknown", memory: "unknown" }),
        gatewayCheckout: state,
      }),
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/daemon-health`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

test("daemon health reports how far behind the gateway checkout is", async () => {
  const gw = setUpGateway();
  const bootSha = gw.git("rev-parse", "HEAD");
  advanceMain(gw.origin);
  const { gate } = recordingGate(bootSha, () =>
    assessGatewayCheckout({ repoDir: gw.tree, env: {}, clock: CLOCK }).then((a) => ({ ...a, restartDue: false })),
  );

  assert.deepEqual((await getHealth(gate.checkout)).gatewayCheckout, GATEWAY_CHECKOUT_UNCHECKED, "before the first read, every piece is unknown");
  await gate.recheck();
  assert.deepEqual((await getHealth(gate.checkout)).gatewayCheckout, {
    head: bootSha,
    behindBy: 1,
    dirty: false,
    checkedAt: CLOCK.iso(),
  });
  // No reader wired at all is not a zero either.
  const absent = (await getHealth(undefined)).gatewayCheckout as GatewayCheckoutState;
  assert.equal(absent.behindBy, "unknown");
  assert.equal(absent.dirty, "unknown");
  assert.equal(absent.head, "unknown");
});

// ── unreadable pieces are unknown, never zero ─────────────────────────────────────────────────

test("W1-T4229: a failed fetch leaves behindBy unknown and names why, while HEAD stays readable", async () => {
  const gw = setUpGateway();
  gw.git("remote", "set-url", "origin", join(gw.home, "no-such-origin"));
  const reading = await assessGatewayCheckout({ repoDir: gw.tree, env: {}, clock: CLOCK });
  assert.equal(reading.state.behindBy, "unknown");
  assert.equal(reading.state.head, gw.git("rev-parse", "HEAD"));
  assert.equal(reading.state.dirty, false);
  assert.match(reading.state.detail ?? "", /git fetch origin failed/);
  assert.equal(reading.restartDue, false, "can't tell is never a restart");
});

test("W1-T4229: a guarded environment spends no fetch and reports behindBy unknown", async () => {
  let fetched = 0;
  const reading = await assessGatewayCheckout({
    repoDir: "/nonexistent",
    env: { CI: "true" },
    clock: CLOCK,
    fetch: async () => {
      fetched += 1;
    },
    git: () => {
      throw new Error("no repository here");
    },
  });
  assert.equal(fetched, 0);
  assert.deepEqual(reading.state, {
    head: "unknown",
    behindBy: "unknown",
    dirty: "unknown",
    checkedAt: CLOCK.iso(),
    detail: "guarded environment: freshness is not assessed here",
  });
});

test("W1-T4229: an unreadable behind-count is unknown, and still restarts a clean tree toward the cheap side", async () => {
  const gw = setUpGateway();
  advanceMain(gw.origin);
  const reading = await assessGatewayCheckout({
    repoDir: gw.tree,
    env: {},
    clock: CLOCK,
    git: (args) => {
      if (args[0] === "rev-list") return "not-a-number";
      return gw.git(...args);
    },
  });
  assert.equal(reading.state.behindBy, "unknown");
  assert.equal(reading.restartDue, true);
});

test("W1-T4229: the real default read, under the self-sync guard, answers from this checkout without a fetch", async () => {
  const prior = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    const reading = await assessGatewayCheckout({ repoDir: serveRepoDir() });
    assert.match(String(reading.state.head), /^[0-9a-f]{40}$/);
    assert.equal(reading.state.behindBy, "unknown");
    assert.equal(reading.restartDue, false);
  } finally {
    if (prior === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = prior;
  }
});

// ── the gate: in-flight work, drains, failures ────────────────────────────────────────────────

const BEHIND: GatewayCheckoutAssessment = {
  state: { head: "a".repeat(40), behindBy: 2, dirty: false, checkedAt: CLOCK.iso() },
  restartDue: true,
};

test("W1-T4229: a due restart waits for the drain to finish before it exits", async () => {
  const exits: number[] = [];
  let release: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    assessCheckout: async () => BEHIND,
    drain: () => drained,
  });
  await gate.recheck();
  assert.deepEqual(exits, [], "not while the drain is still open");
  await gate.recheck();
  release();
  await drained;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [0], "exactly once, after the drain");
});

test("W1-T4229: a failed drain still exits, and a failed read keeps its reason", async () => {
  const exits: number[] = [];
  const logs: string[] = [];
  let reads = 0;
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    log: (step, extra) => logs.push(`${step} ${JSON.stringify(extra)}`),
    assessCheckout: async () => {
      reads += 1;
      if (reads === 1) throw new Error("fetch exploded");
      return BEHIND;
    },
    drain: () => Promise.reject(new Error("socket refused to close")),
  });
  await gate.recheck();
  assert.equal(gate.checkout(), undefined);
  assert.ok(logs.some((l) => l.includes("serve.gateway_checkout_unreadable") && l.includes("fetch exploded")), logs.join("\n"));
  await gate.recheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((l) => l.includes("serve.drain_failed") && l.includes("socket refused to close")), logs.join("\n"));
  assert.deepEqual(exits, [0]);
});

test("W1-T4229: a due restart never exits over an in-flight write", async () => {
  const exits: number[] = [];
  const gate = gateStaleCodeExit({
    bootSha: "a".repeat(40),
    resolveCurrentSha: () => "a".repeat(40),
    exit: (code) => exits.push(code),
    clock: CLOCK,
    scheduleRecheck: () => () => {},
    assessCheckout: async () => BEHIND,
  });
  const res = new EventEmitter();
  const write = gate.wrapWrite({ method: "POST", path: "/w", scope: "write", tier: "high", handler: () => {} });
  void write.handler({} as never, res as unknown as ServerResponse, {} as never);
  await gate.recheck();
  assert.deepEqual(exits, [], "the write is still open");
  res.emit("finish");
  assert.deepEqual(exits, [0], "and the restart happens the moment it finishes");
});

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// ── the real server wiring ────────────────────────────────────────────────────────────────────

function serveDeps(assessment: GatewayCheckoutAssessment, seams: ServeDeps["staleExitSeams"]): ServeDeps {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gateway-serve-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const plan: Plan = { tasks: [], byId: new Map() };
  return {
    board: { plan, ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root,
      planPath: join(root, "plan", "tasks.yaml"),
      ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "gateway-checkout-write" },
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
    // The gate's own on-disk comparison stays real, so the boot sha must be this checkout's.
    consoleSha: resolveConsoleSha(),
    daemonHealth: { exec: () => "{}", statfs: () => ({ bavail: 1, bsize: 1 }) },
    gatewayCheckout: async () => assessment,
    staleExitSeams: seams,
  };
}

test("W1-T4229: rmd serve reports its checkout on /v1/daemon-health and drains its own server on the restart", async () => {
  let recheck: () => void = () => {};
  const exits: number[] = [];
  const reported = { ...BEHIND, restartDue: false, state: { ...BEHIND.state, behindBy: 6 } };
  const server = buildServeServer(serveDeps(reported, { scheduleRecheck: (run) => ((recheck = run), () => {}), exit: (c) => exits.push(c) }));
  const port = await listening(server);
  try {
    recheck();
    await new Promise((resolve) => setImmediate(resolve));
    const res = await fetch(`http://127.0.0.1:${port}/v1/daemon-health`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    const body = (await res.json()) as { gatewayCheckout: GatewayCheckoutState };
    assert.equal(body.gatewayCheckout.behindBy, 6, "the served reading is the gate's own");
    assert.deepEqual(exits, []);
  } finally {
    server.close();
  }

  let recheckDue: () => void = () => {};
  const dueExits: number[] = [];
  const dueServer = buildServeServer(serveDeps(BEHIND, { scheduleRecheck: (run) => ((recheckDue = run), () => {}), exit: (c) => dueExits.push(c) }));
  await listening(dueServer);
  const closed = new Promise<void>((resolve) => dueServer.once("close", () => resolve()));
  recheckDue();
  await closed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dueExits, [0], "unwatched and behind: the server drains and the process exits for the restart");
  assert.equal(dueServer.listening, false);
});

test("rmd serve's stale-code gate compares the boot sha against the caller's resolveCurrentSha, not a fresh git read", async () => {
  // ServeDeps.resolveCurrentSha was declared, documented and set by a dozen suites, yet never handed
  // to the gate: the gate re-read this checkout's real HEAD, so a caller's "current sha" did nothing.
  // Here the boot sha IS this checkout's HEAD; only the caller says the code moved. The gate must act
  // on the caller's answer: stale, an unreadable diff to an unknown sha reads as relevant, nobody is
  // watching, so the server drains and exits for the restart.
  const moved = "d".repeat(40);
  let recheck: () => void = () => {};
  const exits: number[] = [];
  const quiet = { ...BEHIND, restartDue: false, state: { ...BEHIND.state, behindBy: 0 } };
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const server = buildServeServer({
    ...serveDeps(quiet, { scheduleRecheck: (run) => ((recheck = run), () => {}), exit: (c) => exits.push(c) }),
    resolveCurrentSha: () => moved,
    log: (step, extra) => void rows.push({ step, extra }),
  });
  await listening(server);
  const closed = new Promise<"closed">((resolve) => server.once("close", () => resolve("closed")));
  // A BOUND, NOT A SLEEP: the exit waits on one async `git diff`; without the wiring it never comes.
  let bound: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<"gave-up">((resolve) => { bound = setTimeout(() => resolve("gave-up"), 15_000); });
  try {
    recheck();
    const outcome = await Promise.race([closed, gaveUp]);
    assert.equal(outcome, "closed", `the gate never acted on the caller's current sha; rows: ${JSON.stringify(rows.map((r) => r.step))}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [0]);
    const decision = rows.find((r) => r.step === "serve.stale_code_exit");
    assert.equal(decision?.extra?.currentSha, moved, "the exit decision names the caller's sha as current");
  } finally {
    clearTimeout(bound);
    server.close();
  }
});

// W1-T10898: the observer is a separate process, so it can release even a synchronously blocked worker.
interface GatewayChildProbeEvent {
  kind: string;
  port?: number;
  assessment?: GatewayCheckoutAssessment;
  error?: string;
}

async function probeDefaultGatewayChild(synchronousControl = false) {
  const gateway = setUpGateway();
  const directory = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gateway-child-`));
  const entered = join(directory, "entered"), released = join(directory, "released"), armed = join(directory, "armed");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const wrapper = String.raw`
const fs = require("node:fs"), {spawnSync} = require("node:child_process");
const args = process.argv.slice(2), command = args[0] === "-C" ? args.slice(2) : args;
const dir = process.env.W10898_PROBE_DIR;
const target = args[0] === "-C" && args[1] === process.env.W10898_GIT_DIR;
const armed = fs.existsSync(dir + "/armed");
if (command[0] === "rev-parse" && command[1] === "HEAD") fs.appendFileSync(dir + "/head-reads.ndjson", JSON.stringify({target,armed}) + "\n");
if (target && armed && command[0] === "rev-parse" && command[1] === "HEAD" && !fs.existsSync(dir + "/entered")) {
  fs.writeFileSync(dir + "/entered", "entered\n");
  const until = Date.now() + 20_000, waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(dir + "/released") && Date.now() < until) Atomics.wait(waiter, 0, 0, 10);
  if (!fs.existsSync(dir + "/released")) { process.stderr.write("fixture release missing"); process.exit(70); }
}
const result = spawnSync("git", args, {encoding:"utf8", env:{...process.env, PATH:process.env.W10898_ORIGINAL_PATH}});
process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
process.exit(result.status === null ? 71 : result.status);
`;
  writeFileSync(join(bin, "git"), `#!${process.execPath}\n${wrapper}`, {mode: 0o755});
  const program = String.raw`
import {createServer} from "node:http";
import {execFileSync} from "node:child_process";
import {assessGatewayCheckout} from "#src/lib/serve.js";
const server = createServer((_request,response)=>response.end("ordinary"));
const stop = () => { server.closeAllConnections(); server.close(()=>{if(process.connected)process.disconnect();}); };
process.on("disconnect", stop);
process.on("message", async message => {
  if(message.kind === "stop") { stop(); return; }
  if(message.kind === "probe") { setImmediate(()=>process.send?.({kind:"callback"})); return; }
  if(message.kind !== "start") return;
  try {
    const deps = {repoDir:process.env.W10898_GIT_DIR, env:{CI:"true"}};
    if(process.env.W10898_SYNC_CONTROL === "1") deps.git = args => execFileSync("git",["-C",deps.repoDir,...args],{encoding:"utf8"});
    const assessment = await assessGatewayCheckout(deps);
    process.send?.({kind:"assessment",assessment});
  } catch(error) { process.send?.({kind:"assessment",error:String(error)}); }
});
server.listen(0,"127.0.0.1",()=>process.send?.({kind:"ready",port:server.address().port}));
`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
    cwd: REPO_ROOT,
    env: {...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, W10898_ORIGINAL_PATH: process.env.PATH,
      W10898_PROBE_DIR: directory, W10898_GIT_DIR: gateway.tree, W10898_SYNC_CONTROL: synchronousControl ? "1" : "0",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null"},
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const childClosed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const seen = new Map<string, GatewayChildProbeEvent>();
  let stderr = "";
  child.stderr?.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4096); });
  child.on("message", value => {
    if (value && typeof value === "object" && "kind" in value) {
      const event = value as GatewayChildProbeEvent;
      seen.set(event.kind, event);
    }
  });
  const event = (kind: string): Promise<GatewayChildProbeEvent> => {
    const cached = seen.get(kind);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error); };
      const message = (value: unknown) => {
        if (value && typeof value === "object" && "kind" in value && value.kind === kind) { finish(); resolve(value as GatewayChildProbeEvent); }
      };
      const exit = () => { finish(); reject(new Error(`fixture exited before ${kind}: ${stderr}`)); };
      const error = (value: Error) => { finish(); reject(value); };
      const timer = setTimeout(() => { finish(); reject(new Error(`fixture did not report ${kind}: ${stderr}`)); }, 15_000);
      child.on("message", message); child.once("exit", exit); child.once("error", error);
    });
  };
  const ordinary = (port: number): Promise<void> => new Promise((resolve, reject) => {
    const req = request({hostname: "127.0.0.1", port, path: "/ordinary", agent: false}, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
      response.on("end", () => response.statusCode === 200 && body === "ordinary" ? resolve() : reject(new Error("ordinary response changed")));
      response.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
  try {
    const ready = await event("ready");
    assert.equal(typeof ready.port, "number");
    await ordinary(ready.port!); // Positive control: the same server answers before the held child starts.
    const enteredPromise = new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); watcher.close(); };
      const check = () => { if (existsSync(entered)) { finish(); resolve(); } };
      const watcher = watch(directory, check);
      const timer = setTimeout(() => { finish(); reject(new Error(`default Git child never entered: ${stderr}`)); }, 15_000);
      watcher.once("error", error => { finish(); reject(error); }); check();
    });
    writeFileSync(armed, "armed after ordinary-server readiness\n");
    child.send!({kind: "start"});
    await enteredPromise;
    let httpBeforeRelease = false, callbackBeforeRelease = false;
    const http = ordinary(ready.port!).then(() => { httpBeforeRelease = true; });
    const callback = event("callback").then(() => { callbackBeforeRelease = true; });
    child.send!({kind: "probe"});
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([http, callback]), new Promise<void>(resolve => { bound = setTimeout(resolve, 5_000); })]);
      const result = {httpBeforeRelease, callbackBeforeRelease, assessmentBeforeRelease: seen.has("assessment")};
      writeFileSync(released, "release\n");
      await Promise.all([http, callback]);
      const completed = await event("assessment");
      assert.equal(completed.error, undefined, stderr);
      assert.match(String(completed.assessment?.state.head), /^[a-f0-9]{40}$/);
      const reads = readFileSync(join(directory, "head-reads.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {target: boolean; armed: boolean});
      return {...result, assessment: completed.assessment!, preArmHeadReads: reads.filter(row => !row.armed).length, heldTargetReadSeen: reads.some(row => row.target && row.armed)};
    } finally { clearTimeout(bound); }
  } finally {
    if (!existsSync(released)) writeFileSync(released, "release\n");
    let closeBound: ReturnType<typeof setTimeout> | undefined;
    try {
      if (child.connected) child.send!({kind: "stop"}, error => { if (error) stderr += `; stop: ${error.message}`; });
      await Promise.race([childClosed, new Promise<never>((_resolve, reject) => {
        closeBound = setTimeout(() => reject(new Error(`fixture did not close; preserved ${directory}: ${stderr}`)), 15_000);
      })]);
    } finally { clearTimeout(closeBound); }
    rmSync(directory, {recursive: true});
  }
}

test("W1-T10898: local checkout reads leave unrelated HTTP work responsive", {timeout: 30_000}, async t => {
  const observed = await probeDefaultGatewayChild();
  t.diagnostic(JSON.stringify({preArmHeadReads: observed.preArmHeadReads, heldTargetReadSeen: observed.heldTargetReadSeen, httpBeforeRelease: observed.httpBeforeRelease, callbackBeforeRelease: observed.callbackBeforeRelease}));
  assert.equal(observed.heldTargetReadSeen, true, "the held command must be the assessed checkout read after readiness");
  assert.equal(observed.httpBeforeRelease, true, "ordinary HTTP must finish while the default local Git child is held");
  assert.equal(observed.callbackBeforeRelease, true, "the scheduled callback must finish while that child is held");
  assert.equal(observed.assessmentBeforeRelease, false, "the real child must remain held until its independent observer releases it");
  assert.equal(observed.assessment.state.behindBy, "unknown");
  assert.equal(observed.assessment.restartDue, false);
});

test("W1-T10898: asynchronous local reads preserve checkout decisions", async () => {
  const gateway = setUpGateway();
  const assess = () => assessGatewayCheckout({repoDir: gateway.tree, env: {}, supervised: true, clock: CLOCK});
  const head = gateway.git("rev-parse", "HEAD");
  const current = await assess();
  assert.deepEqual(current.state, {head, behindBy: 0, dirty: false, checkedAt: CLOCK.iso()});
  assert.equal(current.restartDue, false);

  const target = advanceMain(gateway.origin);
  const behind = await assess();
  assert.equal(behind.state.head, head);
  assert.equal(behind.state.behindBy, 1);
  assert.equal(behind.restartDue, true);
  assert.equal(behind.targetSha, target);

  writeFileSync(join(gateway.tree, "package.json"), '{"local":"keep this edit"}\n');
  const dirty = await assess();
  assert.equal(dirty.state.dirty, true);
  assert.deepEqual(dirty.state.dirtyPaths, ["package.json"]);
  assert.equal(dirty.state.behindBy, 1);
  assert.equal(dirty.restartDue, false);
  assert.equal(readFileSync(join(gateway.tree, "package.json"), "utf8"), '{"local":"keep this edit"}\n');
  gateway.git("checkout", "--", "package.json");

  let fetches = 0;
  const guarded = await assessGatewayCheckout({repoDir: gateway.tree, env: {CI: "true"}, clock: CLOCK,
    fetch: async () => { fetches += 1; }});
  assert.equal(fetches, 0);
  assert.equal(guarded.state.head, head);
  assert.equal(guarded.state.behindBy, "unknown");
  assert.equal(guarded.restartDue, false);
  const changingEnv: Record<string, string | undefined> = {};
  let guardRaised = false;
  const becameGuarded = await assessGatewayCheckout({repoDir: gateway.tree, env: changingEnv, clock: CLOCK,
    fetch: async () => { await Promise.resolve(); changingEnv.CI = "true"; guardRaised = true; }});
  assert.equal(guardRaised, true, "the existing guard changes after the initial probe, across an awaited fetch");
  assert.equal(becameGuarded.state.head, "unknown");
  assert.equal(becameGuarded.state.dirty, "unknown");
  assert.equal(becameGuarded.state.behindBy, "unknown");
  assert.equal(becameGuarded.state.detail, "guarded");
  assert.equal(becameGuarded.restartDue, false);
  assert.equal(becameGuarded.targetSha, undefined);
  assert.equal(becameGuarded.reloadPlanAt, undefined);

  const failedFetch = await assessGatewayCheckout({repoDir: gateway.tree, env: {}, supervised: true, clock: CLOCK,
    fetch: async () => { throw new Error("origin unavailable"); }});
  assert.equal(failedFetch.state.head, head);
  assert.equal(failedFetch.state.dirty, false);
  assert.equal(failedFetch.state.behindBy, "unknown");
  assert.match(failedFetch.state.detail ?? "", /git fetch origin failed/);
  assert.equal(failedFetch.restartDue, false);

  for (const raw of ["not-a-count", "", "-1", "1.5", "9007199254740992"]) {
    const malformedCount = await assessGatewayCheckout({repoDir: gateway.tree, env: {}, supervised: true, clock: CLOCK,
      git: async args => args[0] === "rev-list" ? raw : gateway.git(...args)});
    assert.equal(malformedCount.state.behindBy, "unknown", `malformed count ${JSON.stringify(raw)} cannot become zero`);
    assert.equal(malformedCount.restartDue, true, "retain the existing conservative unreadable-count decision");
  }
  const missing = await assessGatewayCheckout({repoDir: join(gateway.home, "absent"), env: {}, supervised: true, clock: CLOCK,
    fetch: async () => {}});
  assert.equal(missing.state.head, "unknown");
  assert.equal(missing.state.behindBy, "unknown");
  assert.equal(missing.state.dirty, "unknown");
  assert.equal(missing.restartDue, false, "real child failure cannot report a healthy checkout");
  assert.equal(missing.targetSha, undefined);
});

test("W1-T10898: raced or unavailable local reads stay explicitly unknown", async t => {
  const oldSha = "a".repeat(40), targetSha = "b".repeat(40), racedSha = "c".repeat(40);
  for (const changed of ["head", "origin", "dirty", "head-failure", "status-failure"] as const) {
    await t.test(changed, async () => {
      const calls: string[] = [], counts = new Map<string, number>();
      const result = await assessGatewayCheckout({repoDir: "/unused-injected-checkout", env: {}, supervised: true, clock: CLOCK,
        fetch: async () => {}, git: async args => {
          await Promise.resolve();
          const key = args.join(" "); calls.push(key);
          const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
          if (key === "rev-parse HEAD") {
            if (count > 1 && changed === "head-failure") throw new Error("bounded child failed");
            return count > 1 && changed === "head" ? racedSha : oldSha;
          }
          if (key === "rev-parse origin/main") return count > 1 && changed === "origin" ? racedSha : targetSha;
          if (key === "status --porcelain -uno") {
            if (count > 1 && changed === "status-failure") throw new Error("status unavailable");
            return count > 1 && changed === "dirty" ? " M package.json\n" : "";
          }
          if (args[0] === "diff") return "src/lib/serve.ts\nplan/tasks.yaml\n";
          if (args[0] === "log") return "";
          if (args[0] === "rev-list") return "2";
          throw new Error(`unexpected child: ${key}`);
        }});
      assert.equal(result.state.head, "unknown");
      assert.equal(result.state.dirty, "unknown");
      assert.equal(result.state.behindBy, "unknown");
      assert.match(result.state.detail ?? "", /changed or became unreadable/);
      assert.equal(result.restartDue, false);
      assert.equal(result.reloadPlanAt, undefined);
      assert.equal(result.targetSha, undefined);
      assert.equal(counts.get("rev-parse HEAD"), 2, "one capture and one identity recheck, no repair loop");
      assert.equal(counts.get("rev-parse origin/main"), 2);
      assert.ok(calls.includes(`rev-list --count ${oldSha}..${targetSha}`), "count the captured revisions");
      assert.ok(calls.includes(`diff --name-only ${oldSha}..${targetSha}`));
    });
  }
});

test("W1-T10898: the default local child boundary has a discriminating responsiveness control", {timeout: 60_000}, async () => {
  const asynchronous = await probeDefaultGatewayChild();
  assert.equal(asynchronous.heldTargetReadSeen, true);
  assert.equal(asynchronous.httpBeforeRelease, true);
  assert.equal(asynchronous.callbackBeforeRelease, true);
  assert.equal(asynchronous.assessmentBeforeRelease, false);
  const synchronous = await probeDefaultGatewayChild(true);
  assert.equal(synchronous.heldTargetReadSeen, true);
  assert.equal(synchronous.httpBeforeRelease, false, "the sync control must block the same HTTP server until release");
  assert.equal(synchronous.callbackBeforeRelease, false, "the control must also block that worker's callback");
  assert.equal(synchronous.assessmentBeforeRelease, false);
  for (const assessment of [synchronous.assessment, asynchronous.assessment]) {
    assert.match(String(assessment.state.head), /^[a-f0-9]{40}$/);
    assert.equal(assessment.state.dirty, false);
    assert.equal(assessment.state.behindBy, "unknown");
    assert.equal(assessment.restartDue, false);
    assert.equal(assessment.targetSha, undefined);
    assert.equal(assessment.reloadPlanAt, undefined);
  }
});
