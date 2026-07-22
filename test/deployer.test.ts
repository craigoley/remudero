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

// ── realDeployDeps + marker helpers (adapter coverage; injected exec + real temp fs) ──

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployAutoPath,
  deployFailedAlertPath,
  deployLastFailedPath,
  deployMarkerPath,
  realDeployDeps,
  requestDeploy,
} from "../src/lib/deployer.js";

function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-deployer-real-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("marker helpers: requestDeploy writes DEPLOY_REQUESTED; the path helpers resolve under state/", () => {
  withTemp((root) => {
    assert.equal(deployMarkerPath(root), join(root, "state", "DEPLOY_REQUESTED"));
    assert.equal(deployAutoPath(root), join(root, "state", "DEPLOY_AUTO"));
    assert.equal(deployLastFailedPath(root), join(root, "state", "DEPLOY_LAST_FAILED"));
    assert.equal(deployFailedAlertPath(root), join(root, "state", "DEPLOY_FAILED"));
    requestDeploy(root, "ship it");
    assert.ok(existsSync(deployMarkerPath(root)));
    assert.match(readFileSync(deployMarkerPath(root), "utf8"), /ship it/);
  });
});

test("realDeployDeps: git/pgrep/launchctl route through the injected exec with the right argv", () => {
  withTemp((root) => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse") && args.includes("HEAD")) return "aaa111\n";
      if (args.includes("rev-parse") && args.includes("origin/main")) return "bbb222\n";
      if (args.includes("status")) return " M DECISIONS.md\n?? new.ts\n";
      if (args.includes("diff")) return "src/x.ts\nsrc/y.ts\n";
      if (cmd === "pgrep") throw new Error("exit 1: no matches"); // no live workers
      return "";
    };
    const deps = realDeployDeps({
      installPath: "/inst",
      stateRoot: root,
      daemonLabel: "com.remudero.daemon",
      uid: 502,
      ledgerPath: join(root, "ledger.ndjson"),
      log: () => {},
      execFile: exec,
      sleep: () => {},
      healthWindowMs: 6,
      healthPollMs: 3,
    });

    assert.equal(deps.installHead(), "aaa111");
    assert.equal(deps.originMain(), "bbb222");
    assert.deepEqual(deps.dirtyFiles(), ["DECISIONS.md", "new.ts"]);
    assert.deepEqual(deps.incomingFiles("aaa111", "bbb222"), ["src/x.ts", "src/y.ts"]);
    deps.fetch();
    deps.pullFf();
    deps.resetHard("aaa111");
    deps.kickstart();
    assert.ok(calls.some((c) => c.join(" ") === "git -C /inst fetch origin --quiet"));
    assert.ok(calls.some((c) => c.join(" ") === "git -C /inst merge --ff-only origin/main"));
    assert.ok(calls.some((c) => c.join(" ") === "git -C /inst reset --hard aaa111"));
    assert.ok(calls.some((c) => c.join(" ") === "launchctl kickstart -k gui/502/com.remudero.daemon"), "kickstarts the daemon job");

    // probeIdle: pgrep threw ⇒ 0 workers; lock counts come from the real temp fs.
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    writeFileSync(join(root, "state", "inflight", "W1-T1.lock"), "{}");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    writeFileSync(join(root, "worktrees", "run-x.lock"), "{}");
    assert.deepEqual(deps.probeIdle(), { workers: 0, inflightLocks: 1, worktreeLocks: 1 });
  });
});

test("realDeployDeps: waitBootHealth reads daemon.boot heartbeats after the kickstart instant", () => {
  withTemp((root) => {
    const ledger = join(root, "ledger.ndjson");
    const since = Date.parse("2026-07-22T20:00:00.000Z");
    // one boot BEFORE the kickstart (ignored) + one AFTER (a clean single boot)
    writeFileSync(
      ledger,
      [
        '{"ts":"2026-07-22T19:59:59.000Z","step":"daemon.boot"}',
        '{"ts":"2026-07-22T20:00:05.000Z","step":"daemon.boot"}',
        "",
      ].join("\n"),
    );
    const deps = realDeployDeps({
      installPath: "/inst",
      stateRoot: root,
      daemonLabel: "d",
      uid: 1,
      ledgerPath: ledger,
      log: () => {},
      execFile: () => "",
      sleep: () => {},
      healthWindowMs: 6,
      healthPollMs: 3,
    });
    const h = deps.waitBootHealth(since);
    assert.deepEqual(h, { bootObserved: true, crashCount: 0 });
  });
});

test("realDeployDeps: alert writes DEPLOY_FAILED + DEPLOY_LAST_FAILED; clearMarker removes the request; lastFailedHead round-trips", () => {
  withTemp((root) => {
    const deps = realDeployDeps({
      installPath: "/inst",
      stateRoot: root,
      daemonLabel: "d",
      uid: 1,
      ledgerPath: join(root, "l"),
      log: () => {},
      execFile: () => "",
      sleep: () => {},
    });
    assert.equal(deps.lastFailedHead(), undefined);
    deps.alert("boom", "badsha");
    assert.match(readFileSync(deployFailedAlertPath(root), "utf8"), /boom/);
    assert.equal(deps.lastFailedHead(), "badsha");
    // marker present/auto reflect the fs
    assert.equal(deps.markerPresent(), false);
    requestDeploy(root, undefined);
    assert.equal(deps.markerPresent(), true);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(deployAutoPath(root), "");
    assert.equal(deps.autoMode(), true);
    deps.clearMarker();
    assert.equal(deps.markerPresent(), false);
    deps.clearMarker(); // idempotent when already gone
  });
});
