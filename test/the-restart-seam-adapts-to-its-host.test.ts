// W1-T3200 — THE RESTART MECHANISM IS macOS-ONLY, SO THE FLEET'S ONLY HOST HAS NO AUTOMATIC
// RESTART AT ALL.
//
// `deployer.ts` used to kickstart the daemon by calling `launchctl` directly, which is ABSENT on
// this task's Linux fleet host — while `deploy/recycle-container.sh` does exactly the same job
// there, and nothing in TypeScript could invoke it (see this task's own falsifier: MEASURED
// 2026-09-08, `grep -rn "recycle-container|serve-container" src/ --include=*.ts` returned only
// comments, and `grep -cE "launchctl" src/lib/deployer.ts` returned 6).
//
// THE FIX: `runDeployCycle` no longer calls a single hard-wired `kickstart()`. It asks
// `selectRestartBackend` to pick the first of its INJECTED `RestartBackend`s that PROBES usable —
// never `process.platform` (design (i)) — and the deterministic gates around it (idle gate,
// health-check, rollback) are unchanged (design (iv)): they run identically no matter which
// backend actually performed the restart.
//
// This suite drives BOTH ends of the seam through the same `runDeployCycle` orchestration used in
// production (never a standalone helper), so a passing run proves the seam is LOAD-BEARING, not
// merely present — see the task's falsifier note on this exact point.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectRestartBackend,
  runDeployCycle,
  type DeployDeps,
  type DeployResult,
  type RestartBackend,
} from "../src/lib/deployer.js";

// ── A minimal, self-contained fake DeployDeps — deliberately NOT reusing test/deployer.test.ts's
// `makeDeps` (which predates this seam and always wires the single-backend fallback): this suite
// exists specifically to drive `restartBackends`, so its fixture wires that field explicitly on
// every call, and everything else defaults to "no-op, healthy, idle" so each test needs to state
// only what it is actually exercising. ────────────────────────────────────────────────────────
function makeSeamDeps(o: {
  restartBackends: readonly RestartBackend[];
  dryRun?: boolean;
  health?: { bootObserved: boolean; crashCount: number };
}): {
  deps: DeployDeps;
  calls: string[];
  alerts: Array<{ message: string; failedHead: string; kind: string }>;
  logs: Array<{ step: string; data?: Record<string, unknown> }>;
} {
  const calls: string[] = [];
  const alerts: Array<{ message: string; failedHead: string; kind: string }> = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const deps: DeployDeps = {
    log: (step, data) => {
      calls.push(`log:${step}`);
      logs.push({ step, data });
    },
    now: () => 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => "old-head",
    originMain: () => "new-head",
    runningHead: () => "old-head",
    markerPresent: () => true, // operator-requested — the trigger this suite exercises throughout
    autoMode: () => false,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => calls.push("pullFf"),
    resetHard: (ref) => calls.push(`resetHard:${ref}`),
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    // NEVER called directly by this suite's assertions — every test wires `restartBackends`
    // instead, which is what the seam actually consults. Present only because the field is
    // required and a stray fallback path (a bug this suite would otherwise miss) must be loud.
    kickstart: () => {
      throw new Error("kickstart() called directly — the seam must go through restartBackends");
    },
    restartBackends: () => o.restartBackends,
    waitBootHealth: () => {
      calls.push("waitBootHealth");
      return o.health ?? { bootObserved: true, crashCount: 0 };
    },
    alert: (message, failedHead, kind) => {
      calls.push(`alert:${kind}`);
      alerts.push({ message, failedHead, kind });
    },
    clearMarker: () => calls.push("clearMarker"),
    kickstartConsole: () => calls.push("kickstartConsole"),
    consolePid: () => 4242,
    waitConsoleUp: () => true,
    alertConsoleOnly: (m) => calls.push(`alertConsoleOnly:${m}`),
  };
  return { deps, calls, alerts, logs };
}

function backend(name: string, opts: Partial<RestartBackend> = {}): RestartBackend & {
  probeCalls: number;
  describeCalls: number;
  restartCalls: number;
} {
  const b = {
    name,
    probeCalls: 0,
    describeCalls: 0,
    restartCalls: 0,
    probe: () => {
      b.probeCalls++;
      return opts.probe ? opts.probe() : true;
    },
    describe: () => {
      b.describeCalls++;
      return opts.describe ? opts.describe() : `${name}: describe`;
    },
    restart: () => {
      b.restartCalls++;
      if (opts.restart) opts.restart();
    },
  };
  return b;
}

// ── acceptance (i): PROBING selects the backend — never a platform string ──────────────────────

test("selectRestartBackend: given two injected backends where only one probes available, that one is selected", () => {
  const unavailable = backend("unavailable", { probe: () => false });
  const available = backend("available", { probe: () => true });
  const r = selectRestartBackend([unavailable, available]);
  assert.equal(r.backend, available);
  assert.match(r.reason, /available probed available/);

  // Swap which one probes true — selection follows the PROBE RESULT, not declaration position or
  // name; this is the same two backends, same process.platform, opposite answer.
  const flippedA = backend("A", { probe: () => true });
  const flippedB = backend("B", { probe: () => false });
  assert.equal(selectRestartBackend([flippedA, flippedB]).backend, flippedA);
  const flippedC = backend("C", { probe: () => false });
  const flippedD = backend("D", { probe: () => true });
  assert.equal(selectRestartBackend([flippedC, flippedD]).backend, flippedD);
});

test("selectRestartBackend: selection is driven by probe() results alone — process.platform is never consulted", () => {
  // The identical process this test runs in (one real `process.platform`, whatever the CI host
  // is) selects a DIFFERENT backend purely because the injected probes disagree — proving the
  // decision cannot be reading the platform string underneath.
  const macLike = backend("launchctl", { probe: () => true });
  const linuxLike = backend("recycle-container", { probe: () => false });
  assert.equal(selectRestartBackend([macLike, linuxLike]).backend!.name, "launchctl");

  const macLike2 = backend("launchctl", { probe: () => false });
  const linuxLike2 = backend("recycle-container", { probe: () => true });
  assert.equal(selectRestartBackend([macLike2, linuxLike2]).backend!.name, "recycle-container");
});

test("selectRestartBackend: probes in declaration order and stops at the first that is available", () => {
  const first = backend("first", { probe: () => false });
  const second = backend("second", { probe: () => true });
  const third = backend("third", { probe: () => true });
  const r = selectRestartBackend([first, second, third]);
  assert.equal(r.backend, second);
  assert.equal(first.probeCalls, 1);
  assert.equal(second.probeCalls, 1);
  assert.equal(third.probeCalls, 0, "never probes past the first usable backend");
});

// ── acceptance (ii): NO usable backend refuses LOUDLY, never silently ──────────────────────────

test("selectRestartBackend: no backend probes available ⇒ undefined, with a reason naming every one tried", () => {
  const a = backend("launchctl", { probe: () => false });
  const b = backend("recycle-container", { probe: () => false });
  const r = selectRestartBackend([a, b]);
  assert.equal(r.backend, undefined);
  assert.match(r.reason, /launchctl/);
  assert.match(r.reason, /recycle-container/);
});

test("runDeployCycle: a host with NO usable restart backend refuses LOUDLY and reports it — never a silent decline", () => {
  const a = backend("launchctl", { probe: () => false });
  const b = backend("recycle-container", { probe: () => false });
  const { deps, calls, alerts, logs } = makeSeamDeps({ restartBackends: [a, b] });
  const out = runDeployCycle(deps);

  assert.equal(out.deployed, false);
  assert.match(out.reason, /^restart-refused:/);
  assert.equal(out.pulledPendingRestart, true, "the pull already happened and is on disk, inert");
  assert.ok(calls.includes("pullFf"), "the pull is safe anytime and still runs");
  assert.ok(a.restartCalls === 0 && b.restartCalls === 0, "neither unusable backend is ever asked to restart");

  // LOUD: an operator-visible alert was written, naming the cause — not the pre-existing defect
  // of just... never restarting, indistinguishable from nothing needing it.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "restart-refused");
  assert.match(alerts[0].message, /launchctl/);
  assert.match(alerts[0].message, /recycle-container/);
  const refusalLog = logs.find((l) => l.step === "deploy.no_restart_backend");
  assert.ok(refusalLog, "the refusal is logged to the surface an operator reads");

  // The marker is NOT consumed — a human's request survives to retry once a backend is usable.
  assert.ok(!calls.includes("clearMarker"), "an unsatisfied request must not be discarded");
});

// ── acceptance (iii): a BACKEND's own refusal is authoritative — reported, never retried/replaced ──

test("runDeployCycle: a backend's own refusal (e.g. recycle-container.sh) is reported, never retried past or suppressed", () => {
  const refusalMessage =
    "recycle-container: REFUSING — 1 lane-holding worker(s) still in flight, waited 3000s/3000s";
  const recycle = backend("recycle-container", {
    probe: () => true,
    restart: () => {
      throw new Error(refusalMessage);
    },
  });
  const { deps, calls, alerts, logs } = makeSeamDeps({ restartBackends: [recycle] });
  const out = runDeployCycle(deps);

  assert.equal(out.deployed, false);
  assert.match(out.reason, /^restart-refused:/);
  assert.match(out.reason, /lane-holding worker/);
  assert.equal(out.pulledPendingRestart, true);
  assert.equal(recycle.restartCalls, 1, "attempted exactly once — never retried past the refusal");

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "restart-refused");
  assert.match(alerts[0].message, /lane-holding worker/, "the script's own words are reported verbatim");
  const refusalLog = logs.find((l) => l.step === "deploy.restart_refused");
  assert.equal(refusalLog?.data?.backend, "recycle-container");

  // NEVER falls through to the health-check/rollback path that follows a REAL restart — a refusal
  // is not a restart that merely went badly, it is no restart at all.
  assert.ok(!calls.includes("waitBootHealth"), "no health-check after a refused restart");
  assert.ok(!calls.some((c) => c.startsWith("resetHard")), "no rollback — nothing was ever restarted");
  assert.ok(!calls.includes("clearMarker"), "the request survives to retry, exactly like the no-backend case");
});

test("runDeployCycle: a refused backend is never replaced by a DIFFERENT backend or a bare fallback", () => {
  // Two backends probe available; the FIRST one (selected per design (i)'s declaration order)
  // refuses. The second must never be tried in its place — design (iii) forbids falling back past
  // a script's own refusal, and this is exactly the shape a bare `docker restart` fallback would
  // take if it existed.
  const first = backend("recycle-container", {
    probe: () => true,
    restart: () => {
      throw new Error("recycle-container: REFUSING — pull failed");
    },
  });
  const second = backend("bare-docker-restart-would-be-here", { probe: () => true });
  const { deps, calls } = makeSeamDeps({ restartBackends: [first, second] });
  const out = runDeployCycle(deps);

  assert.equal(out.deployed, false);
  assert.equal(first.restartCalls, 1);
  assert.equal(second.restartCalls, 0, "the second backend is never tried once the first refuses");
  assert.ok(!calls.includes("clearMarker"));
});

// ── acceptance (iv)/(v): dryRun describes EVERY backend, restarts NONE ─────────────────────────

test("runDeployCycle: dryRun describes every registered backend and touches NO backend's restart", () => {
  const a = backend("launchctl", { probe: () => false, describe: () => "launchctl kickstart -k ..." });
  const b = backend("recycle-container", { probe: () => true, describe: () => "deploy/recycle-container.sh ..." });
  const { deps, calls, logs } = makeSeamDeps({ restartBackends: [a, b] });
  const out = runDeployCycle(deps, { dryRun: true });

  assert.equal(out.deployed, false);
  assert.match(out.reason, /dry-run/);
  assert.ok(calls.includes("pullFf"), "dry-run still pulls for real — only the restart is gated");

  // BOTH backends recorded a description...
  assert.equal(a.describeCalls, 1);
  assert.equal(b.describeCalls, 1);
  const dryRunLog = logs.find((l) => l.step === "deploy.dry_run");
  assert.ok(dryRunLog);
  const recorded = dryRunLog!.data!.restart_backends as Array<{ name: string; available: boolean; description: string }>;
  assert.deepEqual(
    recorded.map((r) => r.name),
    ["launchctl", "recycle-container"],
  );
  assert.equal(recorded[0].available, false);
  assert.equal(recorded[1].available, true);
  assert.equal(recorded[1].description, "deploy/recycle-container.sh ...");

  // ...and NEITHER backend's side-effect spy fired.
  assert.equal(a.restartCalls, 0, "describe, never restart — even the unavailable backend");
  assert.equal(b.restartCalls, 0, "describe, never restart — even the one that WOULD have run live");
});

// ── acceptance (v-continued)/(iv): idle gate, health-check and rollback behave IDENTICALLY
// whichever backend performed the restart ─────────────────────────────────────────────────────

function runHealthyWith(name: string): DeployResult {
  const b = backend(name, { probe: () => true });
  const { deps } = makeSeamDeps({ restartBackends: [b] });
  return runDeployCycle(deps);
}

test("runDeployCycle: a healthy boot deploys identically whichever backend performed the restart", () => {
  const viaLaunchctl = runHealthyWith("launchctl");
  const viaRecycle = runHealthyWith("recycle-container");
  // Same shape, same verdict — the backend identity is invisible to the outcome the gates decide.
  assert.deepEqual(
    { deployed: viaLaunchctl.deployed, toHead: viaLaunchctl.toHead, reason: viaLaunchctl.reason },
    { deployed: viaRecycle.deployed, toHead: viaRecycle.toHead, reason: viaRecycle.reason },
  );
  assert.equal(viaLaunchctl.deployed, true);
});

function runUnhealthyWith(name: string): { out: DeployResult; calls: string[]; alerts: Array<{ kind: string }> } {
  const b = backend(name, { probe: () => true });
  const { deps, calls, alerts } = makeSeamDeps({
    restartBackends: [b],
    health: { bootObserved: false, crashCount: 0 },
  });
  return { out: runDeployCycle(deps), calls, alerts };
}

test("runDeployCycle: an unhealthy boot rolls back identically whichever backend performed the restart — and the ROLLBACK restart itself uses that same backend", () => {
  for (const name of ["launchctl", "recycle-container"]) {
    const b = backend(name, { probe: () => true });
    const { deps, calls, alerts } = makeSeamDeps({
      restartBackends: [b],
      health: { bootObserved: false, crashCount: 0 },
    });
    const out = runDeployCycle(deps);
    assert.equal(out.deployed, false);
    assert.match(out.reason, /health-check-failed-rolled-back/);
    assert.equal(out.rolledBackTo, "old-head");
    assert.ok(calls.includes("resetHard:old-head"), `${name}: rollback resets the checkout`);
    // restart() was called TWICE: once for the (unhealthy) forward kickstart, once to bring the
    // daemon back up on the rolled-back sha — and BOTH went through the SAME injected backend,
    // never the raw `kickstart` field (which this fixture makes throw if ever touched directly).
    assert.equal(b.restartCalls, 2, `${name}: restarted for the deploy attempt AND the rollback`);
    assert.equal(alerts.at(-1)?.kind, "health-check-rollback");
    assert.ok(calls.includes("clearMarker"));
  }
});

// ── omitted restartBackends: falls back to the pre-existing single-backend behaviour ───────────

test("runDeployCycle: omitting restartBackends falls back to a single always-available backend wrapping kickstart()", () => {
  const calls: string[] = [];
  const deps: DeployDeps = {
    log: () => {},
    now: () => 1000,
    fetch: () => {},
    installHead: () => "old-head",
    originMain: () => "new-head",
    runningHead: () => "old-head",
    markerPresent: () => true,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => calls.push("kickstart"),
    // restartBackends deliberately omitted.
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => {},
    clearMarker: () => calls.push("clearMarker"),
    kickstartConsole: () => {},
    consolePid: () => undefined,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
  };
  const out = runDeployCycle(deps);
  assert.equal(out.deployed, true);
  assert.ok(calls.includes("kickstart"), "the injected kickstart() is still the restart path when no backend list is wired");
});

// ── THE REAL BACKENDS (W1-T3200) ────────────────────────────────────────────────────────────────
// Everything above injects `RestartBackend`s, which proves the ORCHESTRATION but leaves the two
// backends `realDeployDeps` actually ships — the ones a live host runs — with zero covering tests.
// That is the "every test injects a fake, so the default implementation is unreachable" trap this
// repo has paid for before (#977/#978), and it is exactly what the seam cannot afford: a probe
// that mis-reads its host silently picks the wrong restart mechanism, or none.
//
// So these drive the SHIPPED closures through `realDeployDeps(...).restartBackends!()`, with only
// `execFile` faked (the one boundary that would otherwise shell out for real) and a REAL temp
// directory standing in for the checkout, so `existsSync(deploy/recycle-container.sh)` is a real
// filesystem answer. Each catch arm gets its own case: for the launchctl probe the ENOENT/other
// distinction IS the contract, and conflating them would make every macOS host with a transient
// launchctl error fall through to a backend it does not have.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDeployDeps } from "../src/lib/deployer.js";

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("spawnSync launchctl ENOENT");
  err.code = "ENOENT";
  return err;
}

/** Build the SHIPPED backends over a real temp checkout, with only the subprocess boundary faked. */
function realBackends(o: {
  /** When true, `deploy/recycle-container.sh` really exists on the temp checkout. */
  recycleScript: boolean;
  /** Fake subprocess: throw to simulate a failing/absent binary. */
  execFile: (cmd: string, args: string[]) => string;
}): { backends: readonly RestartBackend[]; installPath: string; calls: string[][] } {
  const installPath = mkdtempSync(join(tmpdir(), "rmd-restart-seam-"));
  if (o.recycleScript) {
    mkdirSync(join(installPath, "deploy"), { recursive: true });
    writeFileSync(join(installPath, "deploy", "recycle-container.sh"), "#!/usr/bin/env bash\nexit 0\n");
  }
  const calls: string[][] = [];
  const deps = realDeployDeps({
    installPath,
    stateRoot: installPath,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: join(installPath, "ledger.ndjson"),
    log: () => {},
    execFile: (cmd, args) => {
      calls.push([cmd, ...args]);
      return o.execFile(cmd, args);
    },
  });
  return { backends: deps.restartBackends!(), installPath, calls };
}

const launchctlOf = (bs: readonly RestartBackend[]): RestartBackend =>
  bs.find((b) => b.name === "launchctl")!;
const recycleOf = (bs: readonly RestartBackend[]): RestartBackend =>
  bs.find((b) => b.name === "recycle-container")!;

test("realDeployDeps ships exactly the two shipped backends, launchctl first", () => {
  const { backends } = realBackends({ recycleScript: false, execFile: () => "" });
  assert.deepEqual(backends.map((b) => b.name), ["launchctl", "recycle-container"]);
});

test("the real launchctl probe: `launchctl list` returning cleanly reads AVAILABLE", () => {
  const { backends, calls } = realBackends({ recycleScript: false, execFile: () => "PID\tStatus\tLabel\n" });
  assert.equal(launchctlOf(backends).probe(), true);
  assert.deepEqual(calls[0], ["launchctl", "list"], "probes the BINARY with no label, not this particular job");
});

test("the real launchctl probe: ENOENT — the binary genuinely absent, as on the Linux fleet host — reads UNAVAILABLE", () => {
  const { backends } = realBackends({
    recycleScript: false,
    execFile: () => {
      throw enoent();
    },
  });
  assert.equal(launchctlOf(backends).probe(), false);
});

test("the real launchctl probe: a NON-ENOENT failure still means launchctl RAN, so it reads AVAILABLE", () => {
  // The distinction is load-bearing: a macOS host whose `launchctl list` errors for any other
  // reason must NOT fall through to a container backend it does not have.
  for (const thrown of [Object.assign(new Error("exit 1"), { status: 1 }), Object.assign(new Error("denied"), { code: "EPERM" })]) {
    const { backends } = realBackends({
      recycleScript: false,
      execFile: () => {
        throw thrown;
      },
    });
    assert.equal(launchctlOf(backends).probe(), true, `a ${String((thrown as NodeJS.ErrnoException).code ?? "non-ENOENT")} failure still means the binary is present`);
  }
});

test("the real launchctl backend describes and performs the kickstart it names", () => {
  const { backends, calls } = realBackends({ recycleScript: false, execFile: () => "" });
  const backend = launchctlOf(backends);
  assert.equal(backend.describe(), "launchctl kickstart -k gui/501/com.remudero.daemon");
  backend.restart();
  assert.deepEqual(calls.at(-1), ["launchctl", "kickstart", "-k", "gui/501/com.remudero.daemon"]);
});

test("the real recycle-container probe: no script on this checkout ⇒ UNAVAILABLE, and docker is never consulted", () => {
  const { backends, calls } = realBackends({
    recycleScript: false,
    execFile: () => {
      throw new Error("no subprocess should run once the script is known absent");
    },
  });
  assert.equal(recycleOf(backends).probe(), false);
  assert.deepEqual(calls, [], "the cheap filesystem check short-circuits before any docker probe");
});

test("the real recycle-container probe: script present AND a docker client answering ⇒ AVAILABLE", () => {
  const { backends, calls } = realBackends({ recycleScript: true, execFile: () => "27.3.1\n" });
  assert.equal(recycleOf(backends).probe(), true);
  assert.deepEqual(calls.at(-1), ["docker", "version", "--format", "{{.Client.Version}}"]);
});

test("the real recycle-container probe: script present but docker absent or unreachable ⇒ UNAVAILABLE", () => {
  const { backends } = realBackends({
    recycleScript: true,
    execFile: () => {
      throw enoent(); // the script needs a working docker to do anything at all
    },
  });
  assert.equal(recycleOf(backends).probe(), false);
});

test("the real recycle-container backend describes and runs the script it names", () => {
  const { backends, installPath, calls } = realBackends({ recycleScript: true, execFile: () => "" });
  const backend = recycleOf(backends);
  const script = join(installPath, "deploy", "recycle-container.sh");
  assert.ok(backend.describe().startsWith(script), "the description names the exact script that will run");
  backend.restart();
  assert.deepEqual(calls.at(-1), ["bash", script]);
});

test("the two real backends select correctly on each host shape, without reading process.platform", () => {
  // macOS-shaped: launchctl answers, no recycle script.
  const mac = realBackends({ recycleScript: false, execFile: () => "PID\tStatus\tLabel\n" });
  assert.equal(selectRestartBackend(mac.backends).backend?.name, "launchctl");
  // Fleet-shaped: no launchctl binary at all, script present, docker answering.
  const fleet = realBackends({
    recycleScript: true,
    execFile: (cmd) => {
      if (cmd === "launchctl") throw enoent();
      return "27.3.1\n";
    },
  });
  assert.equal(selectRestartBackend(fleet.backends).backend?.name, "recycle-container");
  // Neither: no launchctl, no script — refuses, rather than guessing.
  const bare = realBackends({
    recycleScript: false,
    execFile: () => {
      throw enoent();
    },
  });
  assert.equal(selectRestartBackend(bare.backends).backend, undefined);
});
