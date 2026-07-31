import assert from "node:assert/strict";
import { test } from "node:test";

import { restartConsole, runDeployCycle, type DeployDeps, type HealthInputs } from "../src/lib/deployer.js";

// ── THE DEPLOY CYCLE MUST RESTART THE CONSOLE, NOT JUST THE DAEMON ───────────────────
//
// `rmd serve` loads its code ONCE via tsx, and the supervisor only ever kickstarted
// com.remudero.daemon. The console was commissioned 2026-07-29 and served that code through
// every merge for two days — including a GraphQL board fetch already fixed on main — until the
// operator restarted it by hand. "Merged" read as "live" when it was not.
//
// Every effect here is injected. NO test restarts a real launchd service.

interface Rec {
  deps: DeployDeps;
  calls: string[];
  ledger: Array<{ step: string; data?: Record<string, unknown> }>;
  alerts: string[];
  consoleAlerts: string[];
}

function makeDeps(o: { health?: HealthInputs; consoleUp?: boolean; pids?: Array<number | undefined> } = {}): Rec {
  const calls: string[] = [];
  const ledger: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const alerts: string[] = [];
  const consoleAlerts: string[] = [];
  const pids = [...(o.pids ?? [111, 222])];
  const headRef = { value: "old-head" };
  const deps: DeployDeps = {
    log: (step, data) => { ledger.push({ step, data }); calls.push(`log:${step}`); },
    now: () => 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => headRef.value,
    originMain: () => "new-head",
    markerPresent: () => true,
    autoMode: () => true,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => { calls.push("pullFf"); headRef.value = "new-head"; },
    resetHard: (ref) => calls.push(`resetHard:${ref}`),
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => calls.push("kickstart:daemon"),
    waitBootHealth: () => { calls.push("waitBootHealth"); return o.health ?? { bootObserved: true, crashCount: 0 }; },
    alert: (m) => alerts.push(m),
    clearMarker: () => calls.push("clearMarker"),
    kickstartConsole: () => calls.push("kickstart:console"),
    consolePid: () => { calls.push("consolePid"); return pids.shift(); },
    waitConsoleUp: () => { calls.push("waitConsoleUp"); return o.consoleUp ?? true; },
    alertConsoleOnly: (m) => { calls.push("alertConsoleOnly"); consoleAlerts.push(m); },
  };
  return { deps, calls, ledger, alerts, consoleAlerts };
}

const stepsOf = (r: Rec) => r.ledger.map((l) => l.step);

test("a successful deploy restarts the console and ledgers it with the old and new pid", () => {
  const r = makeDeps({ pids: [111, 222] });
  const result = runDeployCycle(r.deps);

  assert.equal(result.deployed, true);
  assert.equal(result.consoleRestarted, true, "the cycle must restart the console, not only the daemon");
  assert.equal(result.consoleHealthy, true);
  assert.ok(r.calls.includes("kickstart:console"), "the console kickstart must actually be invoked");

  const ok = r.ledger.find((l) => l.step === "deploy.console_ok");
  assert.ok(ok, `expected a deploy.console_ok ledger line, saw: ${stepsOf(r).join(", ")}`);
  assert.equal(ok!.data?.old_pid, 111, "the ledger carries the pid it replaced");
  assert.equal(ok!.data?.new_pid, 222, "and the pid it started — a fire-and-forget restart is invisible state (#968)");
  assert.equal(ok!.data?.listening, true, "and the port-listen confirmation");
});

test("a console that never comes back is LOUD, and does NOT roll the daemon back", () => {
  const r = makeDeps({ consoleUp: false });
  const result = runDeployCycle(r.deps);

  // LOUD
  assert.ok(stepsOf(r).includes("deploy.console_unhealthy"), "the failure must be ledgered, not swallowed");
  assert.equal(r.consoleAlerts.length, 1, "and must raise an operator alert");
  assert.match(r.consoleAlerts[0], /did not return to listening/);
  assert.equal(result.consoleHealthy, false);

  // …and the daemon's rollback semantics are UNCHANGED: the deploy still succeeded.
  assert.equal(result.deployed, true, "a console fault must not turn a healthy deploy into a failure");
  assert.equal(result.rolledBackTo, undefined, "reverting main because a display surface died would be wrong");
  assert.ok(!r.calls.includes("resetHard:old-head"), "no tree reset");
  assert.equal(r.calls.filter((c) => c === "kickstart:daemon").length, 1, "the daemon is not re-kickstarted");
  assert.equal(r.alerts.length, 0, "and the failed-HEAD marker is NOT written — that would freeze future deploys");
});

test("TRAP 1: the console is kickstarted only AFTER the daemon's boot health is observed", () => {
  // The shared-node_modules race. `rmd daemon` and `rmd serve` BOTH run serviceFreshnessGate,
  // whose last line is ensureInstallFresh -> `npm ci`, over ONE unlocked node_modules. The gate
  // runs at command dispatch, BEFORE the daemon emits daemon.boot; waitBootHealth blocks on that
  // heartbeat. So ordering the console restart after it makes an overlap impossible.
  // This asserts the SEQUENCE, not merely that both happened.
  const r = makeDeps();
  runDeployCycle(r.deps);

  const iDaemon = r.calls.indexOf("kickstart:daemon");
  const iHealth = r.calls.indexOf("waitBootHealth");
  const iConsole = r.calls.indexOf("kickstart:console");
  assert.ok(iDaemon >= 0 && iHealth >= 0 && iConsole >= 0, `all three steps must run: ${r.calls.join(" -> ")}`);
  assert.ok(iDaemon < iHealth, "daemon kickstart precedes its health wait");
  assert.ok(
    iHealth < iConsole,
    `the console must start AFTER the daemon's install-and-boot completed, got: ${r.calls.join(" -> ")}`,
  );
});

test("an UNHEALTHY daemon rolls back and never touches the console", () => {
  const r = makeDeps({ health: { bootObserved: false, crashCount: 0 } });
  const result = runDeployCycle(r.deps);

  assert.equal(result.deployed, false);
  assert.equal(result.rolledBackTo, "old-head", "the daemon's own rollback is unchanged");
  assert.ok(!r.calls.includes("kickstart:console"), "never start the console on code about to be reverted");
  assert.ok(!stepsOf(r).includes("deploy.console_kickstart"));
  assert.equal(r.alerts.length, 1, "the daemon's failed-HEAD alert still fires");
});

test("a no-op cycle restarts nothing — the console is not bounced every 120s", () => {
  // TRAP 3: the supervisor runs every 120s. The restart rides the DEPLOY, and a deploy only
  // happens when the install is actually behind origin/main, so an idle poll costs nothing.
  const r = makeDeps();
  r.deps.installHead = () => "same-head";
  r.deps.originMain = () => "same-head";
  const result = runDeployCycle(r.deps);

  assert.equal(result.deployed, false);
  assert.match(result.reason, /up-to-date/);
  assert.ok(!r.calls.includes("kickstart:console"), "no deploy, no console restart");
  assert.ok(!r.calls.includes("kickstart:daemon"), "and no daemon restart either");
});

test("restartConsole reports the pid it replaced even when launchctl cannot name it", () => {
  const r = makeDeps({ pids: [undefined, 999] });
  const out = restartConsole(r.deps, "abcdef1234");
  assert.equal(out.healthy, true);
  const ok = r.ledger.find((l) => l.step === "deploy.console_ok");
  assert.equal(ok!.data?.old_pid, null, "an unknown pid is ledgered as null, never omitted");
  assert.equal(ok!.data?.new_pid, 999);
});
