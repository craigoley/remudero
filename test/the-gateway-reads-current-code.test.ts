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
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Agent, createServer, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessGatewayCheckout,
  buildServeServer,
  drainServer,
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

const REPO_ROOT = join(import.meta.dirname, "..");
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

// ── drainServer, on a real server ─────────────────────────────────────────────────────────────

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function get(port: number): Promise<{ status?: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", (e) => resolve({ body, error: e.message }));
    });
    req.on("error", (e) => resolve({ body: "", error: e.message }));
    req.end();
  });
}

test("W1-T4229: a drain lets an in-flight request finish before it resolves", async () => {
  let respond: () => void = () => {};
  let noteArrival: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    noteArrival = resolve;
  });
  const server = createServer((_req, res) => {
    respond = () => res.end("done");
    noteArrival();
  });
  const port = await listening(server);
  const pending = get(port);
  await arrived;
  let drained = false;
  const drain = drainServer(server, 5_000).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false, "the drain is still waiting on the open request");
  respond();
  const res = await pending;
  await drain;
  assert.equal(res.status, 200);
  assert.equal(res.body, "done", "the in-flight request completed, never cut");
  assert.equal(drained, true);
});

test("W1-T4229: a connection that never ends is closed at the drain bound", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
  });
  const port = await listening(server);
  const stream = get(port);
  await new Promise((resolve) => setTimeout(resolve, 20));
  let fire: () => void = () => {};
  const drain = drainServer(server, 1, (run) => {
    fire = run;
    return () => {};
  });
  fire();
  await drain;
  const res = await stream;
  assert.ok(res.error !== undefined || res.body.includes("open"), "the stream was ended by the bound");
});

test("W1-T4229: a keep-alive connection that goes idle after the drain began is closed promptly", async () => {
  let respond: () => void = () => {};
  let noteArrival: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    noteArrival = resolve;
  });
  const server = createServer((_req, res) => {
    respond = () => res.end("done");
    noteArrival();
  });
  server.keepAliveTimeout = 60_000;
  const port = await listening(server);
  const agent = new Agent({ keepAlive: true, timeout: 60_000 });
  const pending = new Promise<void>((resolve, reject) => {
    request({ port, host: "127.0.0.1", path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    }).on("error", reject).end();
  });
  await arrived;
  let drained = false;
  const drain = drainServer(server, 60_000).then(() => {
    drained = true;
  });
  respond();
  await pending;
  for (let i = 0; i < 100 && !drained; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  agent.destroy();
  assert.equal(drained, true, "the drain resolved within a second, not at the client keep-alive timeout");
  await drain;
});

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
