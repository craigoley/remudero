import assert from "node:assert/strict";
import { test } from "node:test";
import { runDeployCycle, type DeployDeps, type IdleProbe } from "../src/lib/deployer.js";

/**
 * W1-T1239 — the `up-to-date` skip is the ONE deploy outcome no later tick ever revisits, and
 * until this it was also the one outcome that never touched `state/DEPLOY_REQUESTED`: an operator
 * request satisfied by an already-current fleet was never consumed, and the stranded marker then
 * silently pre-authorised the NEXT deploy (`decideDeployTrigger`'s `markerPresent` check sits
 * ABOVE the auto-mode arms). This file pins BOTH directions of the fix — consume when satisfied
 * and observed, retain (legibly) when not — and locks that every OTHER skip still leaves the
 * marker exactly where it found it, per the design's own falsifier: consuming on every skip would
 * be strictly worse than the defect being fixed (it would throw away a request the moment a task
 * is merely in flight).
 */

interface FakeDeploy {
  deps: DeployDeps;
  markerRef: { present: boolean };
  calls: string[];
  logs: Array<{ step: string; data?: Record<string, unknown> }>;
}

function makeDeps(o: {
  markerPresent: boolean;
  installHead?: string;
  originMain?: string;
  runningHead?: string;
  daemonAlive?: boolean;
  stopPresent?: boolean;
  autoMode?: boolean;
  dirtyFiles?: string[];
  incomingFiles?: string[];
  idle?: IdleProbe;
}): FakeDeploy {
  const markerRef = { present: o.markerPresent };
  const calls: string[] = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const installHead = o.installHead ?? "same-head";
  const deps: DeployDeps = {
    log: (step, data) => {
      calls.push(`log:${step}`);
      logs.push({ step, data });
    },
    now: () => 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => installHead,
    originMain: () => o.originMain ?? installHead,
    markerPresent: () => markerRef.present,
    autoMode: () => o.autoMode ?? false,
    lastFailedHead: () => undefined,
    daemonAlive: () => o.daemonAlive,
    stopPresent: () => o.stopPresent ?? false,
    runningHead: () => o.runningHead ?? installHead,
    dirtyFiles: () => o.dirtyFiles ?? [],
    incomingFiles: () => o.incomingFiles ?? [],
    pullFf: () => {
      calls.push("pullFf");
    },
    resetHard: (ref) => calls.push(`resetHard:${ref}`),
    probeIdle: () => {
      calls.push("probeIdle");
      return o.idle ?? { workers: 0, inflightLocks: 0, worktreeLocks: 0 };
    },
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => {
      calls.push("waitBootHealth");
      return { bootObserved: true, crashCount: 0 };
    },
    alert: (m, failed, kind) => {
      calls.push(`alert:${failed}:${kind}`);
    },
    clearMarker: () => {
      calls.push("clearMarker");
      markerRef.present = false;
    },
    kickstartConsole: () => calls.push("kickstartConsole"),
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => calls.push("alertConsoleOnly"),
  };
  return { deps, markerRef, calls, logs };
}

test("up-to-date skip with the daemon OBSERVED ALIVE consumes the deploy request", () => {
  const f = makeDeps({ markerPresent: true, installHead: "abc", originMain: "abc", runningHead: "abc", daemonAlive: true });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /up-to-date/);
  assert.equal(f.markerRef.present, false, "the request must actually be consumed on disk");
  assert.ok(f.calls.includes("clearMarker"), "via the existing clearMarker() — no new writer");
  const row = f.logs.find((l) => l.step === "deploy.skip");
  assert.ok(row, "the skip must still be ledgered");
  assert.equal(row!.data?.request, "consumed", "the ledger row states what became of the request");
});

test("up-to-date skip whose daemon liveness was NOT observed retains the request and names why", () => {
  // daemonAlive omitted ⇒ undefined ⇒ "not observed" — a dead-or-unknown daemon (e.g. under a
  // STOP marker) must not have an operator's request silently discarded out from under it.
  const f = makeDeps({ markerPresent: true, installHead: "abc", originMain: "abc", runningHead: "abc" });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /liveness not observed/, "the reason itself names why it cannot consume");
  assert.equal(f.markerRef.present, true, "the request survives for a later tick");
  assert.ok(!f.calls.includes("clearMarker"));
  const row = f.logs.find((l) => l.step === "deploy.skip");
  assert.equal(row!.data?.request, "retained");
  assert.match(String(row!.data?.reason), /liveness not observed/, "the ledger row itself names the reason");
});

test("up-to-date skip with daemonAlive EXPLICITLY false (observed dead) also retains — only true consumes", () => {
  const f = makeDeps({ markerPresent: true, installHead: "abc", originMain: "abc", runningHead: "abc", daemonAlive: false, stopPresent: true });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.equal(f.markerRef.present, true);
  const row = f.logs.find((l) => l.step === "deploy.skip");
  assert.equal(row!.data?.request, "retained");
});

test("a dirty-tree abort still leaves the request in place for a later tick", () => {
  const f = makeDeps({
    markerPresent: true,
    installHead: "old",
    originMain: "new",
    runningHead: "old",
    dirtyFiles: ["src/x.ts"],
    incomingFiles: ["src/x.ts"],
  });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.equal(out.reason, "dirty-tree-conflict");
  assert.equal(f.markerRef.present, true, "not the satisfied up-to-date case — must not be touched");
  assert.ok(!f.calls.includes("clearMarker"));
});

test("a not-idle deferral still leaves the request in place for a later tick", () => {
  const f = makeDeps({
    markerPresent: true,
    installHead: "old",
    originMain: "new",
    runningHead: "old",
    idle: { workers: 1, inflightLocks: 0, worktreeLocks: 0 },
  });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /not-idle/);
  assert.equal(f.markerRef.present, true);
  assert.ok(!f.calls.includes("clearMarker"));
});

test("a dry-run still leaves the request in place for a later tick", () => {
  const f = makeDeps({
    markerPresent: true,
    installHead: "old",
    originMain: "new",
    runningHead: "old",
  });
  const out = runDeployCycle(f.deps, { dryRun: true });
  assert.equal(out.deployed, false);
  assert.match(out.reason, /dry-run/);
  assert.equal(f.markerRef.present, true);
  assert.ok(!f.calls.includes("clearMarker"));
});

test("a skip that finds NO request on disk consumes nothing and claims nothing", () => {
  const f = makeDeps({ markerPresent: false, installHead: "abc", originMain: "abc", runningHead: "abc", daemonAlive: true });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.equal(f.markerRef.present, false);
  assert.ok(!f.calls.includes("clearMarker"), "nothing was there to consume");
  const row = f.logs.find((l) => l.step === "deploy.skip");
  assert.equal(row!.data?.request, "none", "must not claim 'consumed' for a request that never existed");
});

test("the human-gated skip (no marker, behind, not auto) also claims 'none' — never touches a marker it never saw", () => {
  const f = makeDeps({ markerPresent: false, installHead: "old", originMain: "new", runningHead: "old" });
  const out = runDeployCycle(f.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /no operator marker/);
  const row = f.logs.find((l) => l.step === "deploy.skip");
  assert.equal(row!.data?.request, "none");
  assert.ok(!f.calls.includes("clearMarker"));
});
