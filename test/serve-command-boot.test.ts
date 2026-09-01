/**
 * test/serve-command-boot.test.ts — W1-T152: `rmd serve`'s REAL boot path, in-process.
 *
 * serveCommand has only ever been asserted against as SOURCE TEXT (test/run-task.test.ts's
 * extractFunctionBody checks) because it binds a port and blocks until a signal. That is
 * exactly why the service posture this task adds — logs forced 0600 before the token-bearing
 * banner prints, an off-main notice that WARNS instead of refusing, a bind that waits out a
 * dying process's port — has to be exercised here rather than described: a spawned child
 * proves behaviour but reports no coverage, and an untested boot path is how a console that is
 * supposed to be always-on acquires a startup crash nobody sees until the operator is 3000
 * miles away.
 *
 * Its own file (the run-task.test.ts file-level coverage-crash lesson). One host, so
 * `server.close()` on shutdown really does release everything this test opened.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveCommand } from "../src/run-task.js";
import { serveLogPaths } from "../src/lib/launchd.js";
import type { Mounts } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A throwaway instance: its own HOME, its own config.json, its own state root. */
function instance(serve?: { host?: string; port?: number }): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-servecmd-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, serve }));
  return { home, root };
}

test("serve boots on main, secures its logs 0600, and answers on the config-resolved interface", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  process.env.HOME = home;
  delete process.env.RMD_SERVE_HOST; // config.serve.* is the source under test

  const stdout: string[] = [];
  const stderr: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));

  // No flags at all: port AND host must come from config alone, which is what the generated
  // launchd unit relies on (it bakes the port into argv and the hosts into RMD_SERVE_HOST —
  // both resolved by the SAME two functions this exercises).
  // `branch` injected as main: CI checks out a detached merge SHA, so neither the quiet path
  // nor the warning path would ever be DETERMINISTIC here without it (see the sibling test).
  const running = serveCommand([], { branch: () => "main" });
  t.after(() => {
    console.log = realLog;
    console.error = realErr;
    process.env.HOME = oldHome;
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);
  const banner = stdout.join("\n");
  assert.match(banner, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`), "config-resolved host:port, no flags");

  // R-5: the banner above carries the READ token, and under launchd stdout IS a file. The log
  // files must already be 0600 by the time anything is printed.
  const logs = serveLogPaths(root);
  assert.equal(statSync(logs.stdout).mode & 0o777, 0o600);
  assert.equal(statSync(logs.stderr).mode & 0o777, 0o600);

  // The console really answers — an authed request over the interface it just claimed.
  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string };
  const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${tokens.read}` } });
  assert.equal(res.status, 200, "an authed GET answers 200 on the bound interface");
  const unauthed = await fetch(`http://127.0.0.1:${port}/v1/status`);
  assert.equal(unauthed.status, 401, "…and an unauthed one does not");

  assert.doesNotMatch(stderr.join("\n"), /WARNING: this checkout is on branch/, "on main: no branch noise");

  // SIGTERM is the shutdown launchd sends. It must return 0 — under KeepAlive:true the console
  // comes back from a clean exit too, which is why the unit does not use SuccessfulExit:false.
  process.emit("SIGTERM");
  assert.equal(await running, 0, "a clean signal shutdown returns 0");
});

test("a held port is WAITED OUT and, if it never frees, fails loudly instead of dying silently", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  // Somebody else already owns the port — the old process being reaped, in the real incident.
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));

  const stderr: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));
  t.after(() => {
    console.error = realErr;
    process.env.HOME = oldHome;
    squatter.close();
  });

  const rc = await serveCommand([], { branch: () => "main", bindRetry: { attempts: 3, delayMs: 5 } });

  const said = stderr.join("\n");
  assert.match(said, /still held \(EADDRINUSE\), waiting for release \(attempt 1\)/, "it WAITS rather than dying on the first miss");
  assert.match(said, /attempt 2/);
  assert.match(said, /failed to listen on 127\.0\.0\.1:/, "and a port that never frees is a LOUD failure");
  assert.equal(rc, 1, "…with a non-zero exit, so launchd's ThrottleInterval paces the retry");

  // Silence is what made the original outage expensive: the ledger carries both the waiting
  // and the give-up, so `rmd ops` can see a bind fight that stderr scrolled away.
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"serve\.bind_retry"/);
  assert.match(ledger, /"step":"serve\.bind_failed"/);
});

test("an OFF-MAIN checkout warns loudly and SERVES ANYWAY — a KeepAlive'd service never refuses to boot", async (t) => {
  const port = await freePort();
  const { home } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  process.env.HOME = home;
  delete process.env.RMD_SERVE_HOST;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));
  console.error = (...a: unknown[]) => void stderr.push(a.join(" "));

  const running = serveCommand([], { branch: () => "run-W1-T152" });
  t.after(() => {
    console.log = realLog;
    console.error = realErr;
    process.env.HOME = oldHome;
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);

  // THE FALSIFIER for W1-T152's original wording ("REFUSES to bind when not on main, exit
  // non-zero"): under this task's own launchd unit that refusal is a KeepAlive crash-loop —
  // the #726 daemon incident, re-created on the console. It binds, and it says so.
  assert.match(stdout.join("\n"), new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`), "it BOUND despite being off main");
  const warned = stderr.join("\n");
  assert.match(warned, /WARNING: this checkout is on branch 'run-W1-T152', not 'main'/);
  assert.match(warned, /Serving anyway/);

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

// ── W1-T2303: the feedback-expansion rung, wired at boot ────────────────────────────────────
//
// PanelGraphDeps.expandFeedback was assigned nowhere in production — this is the boot-path half
// of that fix (the route's own fail-open legs are already covered, against a stub, by
// test/panel-graph.test.ts). Both tests below drive the REAL `serveCommand` construction (never
// a synthetic ServeDeps object) so the proof is that `rmd serve` itself resolves and threads the
// rung through, not merely that `buildPreviewFeedbackRoute` can be handed one.

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-feedback-expander-boot",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

/** A `Mounts` table whose routing table defines no routes at all — the shape
 *  `resolveRiskJudgeMount`/`resolveFeedbackExpansionMount` throws `MountsError` against
 *  ("no worker mount found in mounts.yaml routes"), i.e. "an install that resolves no mount". */
function noRouteMounts(): Mounts {
  const mount = { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1000 };
  return {
    tiers: { haiku: 0 },
    efforts: { medium: 0 },
    architect: mount,
    judge: mount,
    synthesis: { retro: mount, triage: mount, inbox_draft: mount },
    routes: {},
  };
}

test("serve resolves a real feedback-expansion rung at boot: a preview backed by the stubbed spawn arms a real four-section expansion, not null", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const expansionPayload = {
    claim: "the drain retry banner overlaps the status pill",
    evidence: "",
    recon: ["establish whether this reproduces at other viewport widths"],
    falsifying_check: "if the overlap does not reproduce on a fresh reload, this is a one-off render glitch",
  };
  let spawnCalls = 0;
  const spawn = async (): Promise<WorkerResult> => {
    spawnCalls++;
    return fakeWorkerResult(JSON.stringify(expansionPayload));
  };

  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));

  const running = serveCommand([], { branch: () => "main", spawn });
  t.after(() => {
    console.log = realLog;
    process.env.HOME = oldHome;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);
  assert.match(stdout.join("\n"), /listening on/, "boots exactly as before this task");

  // "resolved ONCE and threaded through": construction alone must not have spawned anything —
  // the rung is a real cost only on an operator-initiated preview click (design (iv)).
  assert.equal(spawnCalls, 0, "resolving the rung at boot must not itself spawn a worker");

  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { write: string };
  const res = await fetch(`http://127.0.0.1:${port}/v1/feedback/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.write}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "the console doesn't show me when spend is blocked" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { expansion: unknown };
  assert.deepEqual(body.expansion, expansionPayload, "the real expander (stubbed spawn) armed a real expansion, not { expansion: null }");
  assert.equal(spawnCalls, 1, "exactly one spawn per preview click");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"serve\.feedback_expander_resolved"/);

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});

test("an install whose mounts table resolves no route boots UNCHANGED: preview still degrades to { expansion: null }, same fail-open as before this wiring", async (t) => {
  const port = await freePort();
  const { home, root } = instance({ host: "127.0.0.1", port });
  const oldHome = process.env.HOME;
  process.env.HOME = home;

  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void stdout.push(a.join(" "));

  const running = serveCommand([], { branch: () => "main", loadMounts: () => noRouteMounts() });
  t.after(() => {
    console.log = realLog;
    process.env.HOME = oldHome;
    process.emit("SIGTERM");
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stdout.some((l) => l.includes("listening on"))) await sleep(100);
  assert.match(stdout.join("\n"), /listening on/, "a mount that fails to resolve must not crash-loop the whole console");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"serve\.feedback_expander_unavailable"/);
  assert.match(ledger, /no worker mount found in mounts\.yaml routes/);

  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { write: string };
  const res = await fetch(`http://127.0.0.1:${port}/v1/feedback/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.write}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "x" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { expansion: null }, "unresolved mount degrades exactly like an unset dep — never a 5xx, never a crash");

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});
