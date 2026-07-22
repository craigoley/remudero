import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessBootHealth,
  daemonIsIdle,
  decideDeployTrigger,
  runDeployCycle,
  treeFfSafe,
  type DeployDeps,
  type HealthInputs,
  type IdleProbe,
} from "../src/lib/deployer.js";

// ── pure decisions ──────────────────────────────────────────────────────────────

test("decideDeployTrigger: human-gated by default — no marker ⇒ no deploy even when behind", () => {
  const r = decideDeployTrigger({ markerPresent: false, autoMode: false, installHead: "old", originMain: "new" });
  assert.equal(r.deploy, false);
  assert.match(r.reason, /no operator marker/);
});

test("decideDeployTrigger: marker present + behind ⇒ deploy; up-to-date ⇒ never", () => {
  assert.equal(decideDeployTrigger({ markerPresent: true, autoMode: false, installHead: "old", originMain: "new" }).deploy, true);
  assert.equal(decideDeployTrigger({ markerPresent: true, autoMode: false, installHead: "same", originMain: "same" }).deploy, false);
});

test("decideDeployTrigger: auto mode deploys when behind, but NOT a HEAD that already failed + rolled back", () => {
  assert.equal(decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: "old", originMain: "new" }).deploy, true);
  const blocked = decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: "old", originMain: "bad", lastFailedHead: "bad" });
  assert.equal(blocked.deploy, false);
  assert.match(blocked.reason, /already failed/);
});

test("daemonIsIdle: idle IFF no worker AND no inflight AND no worktree lock", () => {
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }), true);
  assert.equal(daemonIsIdle({ workers: 1, inflightLocks: 0, worktreeLocks: 0 }), false);
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 1, worktreeLocks: 0 }), false);
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 0, worktreeLocks: 1 }), false);
});

test("treeFfSafe: a benign local mod NOT in the incoming diff is fine; one that IS conflicts", () => {
  assert.deepEqual(treeFfSafe({ dirtyFiles: ["DECISIONS.md"], incomingFiles: ["src/x.ts"] }), { ok: true, conflicting: [] });
  assert.deepEqual(treeFfSafe({ dirtyFiles: ["DECISIONS.md", "src/x.ts"], incomingFiles: ["src/x.ts"] }), { ok: false, conflicting: ["src/x.ts"] });
});

test("assessBootHealth: healthy needs a fresh boot AND no crash-loop", () => {
  assert.equal(assessBootHealth({ bootObserved: true, crashCount: 0 }).healthy, true);
  assert.equal(assessBootHealth({ bootObserved: false, crashCount: 0 }).healthy, false);
  assert.equal(assessBootHealth({ bootObserved: true, crashCount: 3 }).healthy, false);
});

// ── the orchestrated cycle (recording fake deps) ────────────────────────────────

interface Recorder {
  calls: string[];
  deps: DeployDeps;
  headRef: { value: string };
  alerts: string[];
}

function makeDeps(o: {
  markerPresent?: boolean;
  autoMode?: boolean;
  lastFailedHead?: string;
  installHead?: string;
  originMain?: string;
  dirtyFiles?: string[];
  incomingFiles?: string[];
  idle?: IdleProbe | IdleProbe[]; // one value, or a sequence consumed per probeIdle() call
  health?: HealthInputs;
}): Recorder {
  const calls: string[] = [];
  const alerts: string[] = [];
  const headRef = { value: o.installHead ?? "old-head" };
  const idleSeq = Array.isArray(o.idle) ? [...o.idle] : undefined;
  const idleOne = Array.isArray(o.idle) ? undefined : (o.idle ?? { workers: 0, inflightLocks: 0, worktreeLocks: 0 });
  const deps: DeployDeps = {
    log: (step) => calls.push(`log:${step}`),
    now: () => 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => headRef.value,
    originMain: () => o.originMain ?? "new-head",
    markerPresent: () => o.markerPresent ?? false,
    autoMode: () => o.autoMode ?? false,
    lastFailedHead: () => o.lastFailedHead,
    dirtyFiles: () => o.dirtyFiles ?? [],
    incomingFiles: () => o.incomingFiles ?? [],
    pullFf: () => {
      calls.push("pullFf");
      headRef.value = o.originMain ?? "new-head"; // ff advances HEAD to origin
    },
    resetHard: (ref) => {
      calls.push(`resetHard:${ref}`);
      headRef.value = ref;
    },
    probeIdle: () => {
      calls.push("probeIdle");
      return idleSeq ? (idleSeq.shift() ?? { workers: 0, inflightLocks: 0, worktreeLocks: 0 }) : idleOne!;
    },
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => {
      calls.push("waitBootHealth");
      return o.health ?? { bootObserved: true, crashCount: 0 };
    },
    alert: (m, failed) => {
      calls.push(`alert:${failed}`);
      alerts.push(m);
    },
    clearMarker: () => calls.push("clearMarker"),
  };
  return { calls, deps, headRef, alerts };
}

test("cycle #1 — trigger gating: no marker + behind ⇒ NO deploy, NO pull, NO kickstart", () => {
  const r = makeDeps({ markerPresent: false, installHead: "old", originMain: "new" });
  const out = runDeployCycle(r.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /no operator marker/);
  assert.ok(!r.calls.includes("pullFf"), "never pulls without a trigger");
  assert.ok(!r.calls.includes("kickstart"), "never restarts without a trigger");
});

test("cycle #1 — trigger gating: marker present + behind + idle + healthy ⇒ deploys, clears marker", () => {
  const r = makeDeps({ markerPresent: true, installHead: "old", originMain: "new" });
  const out = runDeployCycle(r.deps);
  assert.equal(out.deployed, true);
  assert.equal(out.toHead, "new");
  assert.ok(r.calls.includes("pullFf") && r.calls.includes("kickstart") && r.calls.includes("clearMarker"));
});

test("cycle #2 — idle gate: a worker in flight ⇒ abort BEFORE pull, retry next tick", () => {
  const r = makeDeps({ markerPresent: true, installHead: "old", originMain: "new", idle: { workers: 1, inflightLocks: 0, worktreeLocks: 0 } });
  const out = runDeployCycle(r.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /not-idle/);
  assert.ok(!r.calls.includes("pullFf"), "does not pull while a task is in flight");
  assert.ok(!r.calls.includes("kickstart"));
});

test("cycle #2 — poll race: idle at pre-pull but a task appears before kickstart ⇒ pulled, restart DEFERRED", () => {
  // first probeIdle() = idle (pre-pull passes), second probeIdle() = busy (pre-kickstart re-check catches it)
  const r = makeDeps({
    markerPresent: true,
    installHead: "old",
    originMain: "new",
    idle: [{ workers: 0, inflightLocks: 0, worktreeLocks: 0 }, { workers: 1, inflightLocks: 0, worktreeLocks: 0 }],
  });
  const out = runDeployCycle(r.deps);
  assert.equal(out.deployed, false);
  assert.equal(out.pulledPendingRestart, true, "the pull happened but the restart is deferred to a later idle tick");
  assert.ok(r.calls.includes("pullFf"), "pull is on disk (inert until restart)");
  assert.ok(!r.calls.includes("kickstart"), "NEVER kickstarts under a task that appeared after the first check");
});

test("cycle #3 — health-check + rollback: unhealthy boot ⇒ reset to prior HEAD, restore daemon, alert", () => {
  const r = makeDeps({
    markerPresent: true,
    installHead: "good-old",
    originMain: "bad-new",
    health: { bootObserved: false, crashCount: 5 }, // crash-loop, no boot
  });
  const out = runDeployCycle(r.deps);
  assert.equal(out.deployed, false);
  assert.match(out.reason, /rolled-back/);
  assert.equal(out.rolledBackTo, "good-old");
  assert.equal(r.headRef.value, "good-old", "install HEAD is back at the known-good prior sha");
  assert.ok(r.calls.includes("resetHard:good-old"), "rolled back");
  assert.equal(r.calls.filter((c) => c === "kickstart").length, 2, "kickstart twice: the failed deploy, then restore the known-good daemon");
  assert.ok(r.calls.some((c) => c.startsWith("alert:bad-new")), "alerts the operator with the failed HEAD");
});

test("cycle #4 — clean-tree guard: a conflicting dirty file ⇒ abort, alert, HEAD untouched, no pull/kickstart", () => {
  const r = makeDeps({
    markerPresent: true,
    installHead: "old",
    originMain: "new",
    dirtyFiles: ["src/run-task.ts"],
    incomingFiles: ["src/run-task.ts"], // the ff would overwrite a locally-modified file
  });
  const out = runDeployCycle(r.deps);
  assert.equal(out.deployed, false);
  assert.equal(out.reason, "dirty-tree-conflict");
  assert.equal(r.headRef.value, "old", "never forces/resets the operator's checkout");
  assert.ok(!r.calls.includes("pullFf") && !r.calls.includes("kickstart"));
  assert.ok(r.alerts.length === 1 && /conflict/.test(r.alerts[0]));
});
