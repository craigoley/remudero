import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessBootHealth,
  daemonIsIdle,
  decideDeployTrigger,
  describeFailureKind,
  readLatestBootSha,
  sameCommit,
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
  // "up-to-date" now means the checkout is current AND the daemon is running it — supplying
  // runningHead is what makes this case up-to-date rather than merely checkout-current.
  assert.equal(decideDeployTrigger({ markerPresent: true, autoMode: false, installHead: "same", originMain: "same", runningHead: "same" }).deploy, false);
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
  assert.deepEqual(treeFfSafe({ dirtyFiles: ["DECISIONS.md"], incomingFiles: ["src/x.ts"] }), { ok: true, conflicting: [], discardable: [] });
  assert.deepEqual(treeFfSafe({ dirtyFiles: ["DECISIONS.md", "src/x.ts"], incomingFiles: ["src/x.ts"] }), { ok: false, conflicting: ["src/x.ts"], discardable: [] });
});

test("treeFfSafe: WITHOUT a byte-identity probe, nothing is discardable — the old behaviour exactly", () => {
  // The seam is optional so a caller that never supplies it cannot be regressed into discarding.
  const r = treeFfSafe({ dirtyFiles: ["a.yaml", "b.yaml"], incomingFiles: ["a.yaml", "b.yaml"] });
  assert.deepEqual(r, { ok: false, conflicting: ["a.yaml", "b.yaml"], discardable: [] });
});

test("treeFfSafe: a local file byte-identical to the incoming blob is discardable, not a conflict", () => {
  // THE DEADLOCK. The daemon wrote a.yaml itself; main now carries the identical bytes.
  const r = treeFfSafe({
    dirtyFiles: ["a.yaml"],
    incomingFiles: ["a.yaml"],
    sameAsIncoming: (p) => p === "a.yaml",
  });
  assert.deepEqual(r, { ok: true, conflicting: [], discardable: ["a.yaml"] });
});

test("treeFfSafe: one identical file does NOT excuse a differing one — the ff still aborts", () => {
  // The safety property: partial identity must never unblock a genuinely divergent tree.
  const r = treeFfSafe({
    dirtyFiles: ["same.yaml", "edited.ts"],
    incomingFiles: ["same.yaml", "edited.ts"],
    sameAsIncoming: (p) => p === "same.yaml",
  });
  assert.equal(r.ok, false, "a real conflict must still abort");
  assert.deepEqual(r.conflicting, ["edited.ts"]);
  assert.deepEqual(r.discardable, ["same.yaml"]);
});

test("treeFfSafe: a probe that throws or answers false keeps the file a conflict (fail-closed)", () => {
  const r = treeFfSafe({
    dirtyFiles: ["x.ts"],
    incomingFiles: ["x.ts"],
    sameAsIncoming: () => false,
  });
  assert.deepEqual(r, { ok: false, conflicting: ["x.ts"], discardable: [] });
});

test("describeFailureKind names the real cause, and never invents one it was not given", () => {
  assert.match(describeFailureKind("dirty-tree-conflict"), /dirty-tree conflict/);
  assert.match(describeFailureKind("health-check-rollback"), /health-check/);
  assert.equal(describeFailureKind(undefined), "reason not recorded");
});

test("the skip line states the recorded cause — a dirty-tree stall no longer claims a health-check", () => {
  // The defect: BOTH failures wrote lastFailedHead, and the skip line hardcoded the health-check
  // wording, so a dirty-tree stall reported a rollback that never happened.
  const base = { markerPresent: false, autoMode: true, installHead: "aaa", originMain: "bbb", lastFailedHead: "bbb" } as const;
  const dirty = decideDeployTrigger({ ...base, lastFailedKind: "dirty-tree-conflict" });
  assert.equal(dirty.deploy, false);
  assert.match(dirty.reason, /dirty-tree conflict/);
  assert.doesNotMatch(dirty.reason, /health-check/, "must not claim a health-check that never ran");
  assert.match(dirty.reason, /DEPLOY_FAILED/, "and must point at the record that has the detail");

  const health = decideDeployTrigger({ ...base, lastFailedKind: "health-check-rollback" });
  assert.match(health.reason, /health-check/);
  assert.doesNotMatch(health.reason, /dirty-tree/);

  // Legacy record with no kind: say so rather than guess.
  assert.match(decideDeployTrigger(base).reason, /reason not recorded/);
});

test("an operator marker still overrides the not-retried latch, whatever the recorded kind", () => {
  const d = decideDeployTrigger({
    markerPresent: true, autoMode: true, installHead: "aaa", originMain: "bbb",
    lastFailedHead: "bbb", lastFailedKind: "dirty-tree-conflict",
  });
  assert.equal(d.deploy, true, "the operator asked explicitly — the latch is auto-mode only");
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
  installHead?: string; runningHead?: string;
  originMain?: string;
  dirtyFiles?: string[];
  incomingFiles?: string[];
  /** Paths whose local bytes already equal the incoming blob (impl: the byte-identity probe). */
  identical?: string[];
  idle?: IdleProbe | IdleProbe[]; // one value, or a sequence consumed per probeIdle() call
  health?: HealthInputs;
  consoleUp?: boolean;
}): Recorder {
  const calls: string[] = [];
  const alerts: string[] = [];
  const headRef = { value: o.installHead ?? "old-head" };
  const idleSeq = Array.isArray(o.idle) ? [...o.idle] : undefined;
  const idleOne = Array.isArray(o.idle) ? undefined : (o.idle ?? { workers: 0, inflightLocks: 0, worktreeLocks: 0 });
  const deps: DeployDeps = {
    // impl-BZ: the console-restart effects. Defaulted to a healthy console so every PRE-EXISTING
    // test keeps asserting exactly what it asserted before; the console-specific tests live in
    // test/deploy-cycle-console.test.ts and drive these explicitly.
    kickstartConsole: () => calls.push("kickstartConsole"),
    consolePid: () => 4242,
    waitConsoleUp: () => o.consoleUp ?? true,
    alertConsoleOnly: (m) => alerts.push(`console:${m}`),
    log: (step) => calls.push(`log:${step}`),
    now: () => 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => headRef.value,
    runningHead: () => o.runningHead ?? headRef.value,
    originMain: () => o.originMain ?? "new-head",
    markerPresent: () => o.markerPresent ?? false,
    autoMode: () => o.autoMode ?? false,
    lastFailedHead: () => o.lastFailedHead,
    dirtyFiles: () => o.dirtyFiles ?? [],
    incomingFiles: () => o.incomingFiles ?? [],
    sameAsIncoming: o.identical ? (p2) => (o.identical ?? []).includes(p2) : undefined,
    discardLocal: (p2) => {
      calls.push(`discard:${p2}`);
    },
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

import { execFileSync } from "node:child_process";
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
      serveLabel: "com.remudero.serve",
      servePort: 4317,
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
      serveLabel: "s",
      servePort: 4317,
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
      serveLabel: "s",
      servePort: 4317,
      uid: 1,
      ledgerPath: join(root, "l"),
      log: () => {},
      execFile: () => "",
      sleep: () => {},
    });
    assert.equal(deps.lastFailedHead(), undefined);
    deps.alert("boom", "badsha", "health-check-rollback");
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

// ── RUNNING-SHA TRIGGER (deploy supervisor consumed by anyone who pulls first) ──────────────
//
// decideDeployTrigger used to compare the CHECKOUT against origin only, so an operator `git
// pull`, an agent's pull, or rmd's own self-sync consumed the trigger and the restart never
// happened — the daemon then ran stale code against a current checkout, silently. Captured live
// 2026-08-01: checkout ff'd to a0d96a9 at 21:44:29, 12 consecutive "no-op: up-to-date" cycles,
// console still on 3f6a1d1. These lock the fix and, above all, lock it against FALSE POSITIVES:
// a trigger that reads "stale" for a current daemon restarts it every 120s under the supervisor.

test("running-sha trigger: a daemon on an OLDER sha than the checkout DEPLOYS even though the checkout is current", () => {
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682",
    originMain: "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682", // someone already pulled
    runningHead: "3f6a1d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // daemon still on the old code
  });
  assert.equal(d.deploy, true);
  assert.match(d.reason, /daemon running stale code/);
});

test("running-sha trigger: a daemon that has JUST restarted onto the CURRENT sha does NOT deploy — the false-positive lock", () => {
  const cur = "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682";
  const d = decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: cur, originMain: cur, runningHead: cur });
  assert.equal(d.deploy, false, "a current daemon must never be restarted — the supervisor runs every 120s");
  assert.match(d.reason, /up-to-date/);

  // SHORT-vs-FULL sha: a format mismatch would read as stale and loop forever.
  const shortSide = decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: cur, originMain: cur, runningHead: cur.slice(0, 12) });
  assert.equal(shortSide.deploy, false, "a short running sha that prefixes the full install head is the SAME commit");
  const otherSide = decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: cur.slice(0, 12), originMain: cur.slice(0, 12), runningHead: cur });
  assert.equal(otherSide.deploy, false, "and symmetrically, a full running sha against a short install head");

  // A genuinely different sha that happens to share a prefix shorter than 7 must NOT be equal.
  assert.equal(sameCommit("a0d9", "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682"), false, "under 7 chars is not a commit identity");
});

test("running-sha trigger: an UNKNOWN (unrecorded) running sha DEPLOYS — fail-EAGER, chosen deliberately", () => {
  const cur = "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682";
  const d = decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: cur, originMain: cur, runningHead: undefined });
  assert.equal(d.deploy, true, "a daemon that booted before this shipped records nothing; fail-safe would mean the fix can never take effect");
  assert.match(d.reason, /daemon running stale code/);
});

test("running-sha trigger: REPLAY of the live 2026-08-01 sequence — old logic said up-to-date, new logic deploys", () => {
  // The checkout was fast-forwarded to a0d96a9 by a manual `pull --ff-only` at 21:44:29; the
  // daemon had last booted on 3f6a1d1. Twelve cycles reported "no-op: up-to-date".
  const checkout = "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682";
  const daemonOn = "3f6a1d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  // OLD comparison, reproduced inline: checkout vs origin only.
  assert.equal(checkout !== checkout, false, "the old `behind` was false — which is why nothing happened");

  const now = decideDeployTrigger({ markerPresent: false, autoMode: true, installHead: checkout, originMain: checkout, runningHead: daemonOn });
  assert.equal(now.deploy, true, "the new trigger acts on the running code, so the same state now deploys");
});

test("readLatestBootSha: takes the LAST daemon.boot head_sha, and is undefined when none carries one", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bootsha-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, [
    '{"ts":"2026-08-01T00:00:00.000Z","step":"daemon.boot","head_sha":"1111111111111111111111111111111111111111"}',
    '{"ts":"2026-08-01T01:00:00.000Z","step":"run.start"}',
    '{"ts":"2026-08-01T02:00:00.000Z","step":"daemon.boot","head_sha":"2222222222222222222222222222222222222222"}',
  ].join("\n"));
  assert.equal(readLatestBootSha(p), "2222222222222222222222222222222222222222");

  const bare = join(dir, "bare.ndjson");
  writeFileSync(bare, '{"ts":"2026-08-01T00:00:00.000Z","step":"daemon.boot","env_clean":true}\n');
  assert.equal(readLatestBootSha(bare), undefined, "a pre-fix daemon recorded no sha");
  assert.equal(readLatestBootSha(join(dir, "nope.ndjson")), undefined, "no ledger at all");
});

test("running-sha trigger: the idle gate STILL blocks — a stale daemon with a worker in flight does NOT restart", () => {
  // THE REGRESSION LOCK ON THE THING THAT MUST NOT BREAK. A restart under a live worker SIGKILLs
  // it (it has already cost a run on this host). The new running-sha reason must reach the gate
  // by exactly the same path the old behind-origin reason did — never around it.
  const cur = "a0d96a958e6a162d8a4a800b4b5ccaa1664fa682";
  const r = makeDeps({
    markerPresent: true,
    installHead: cur,
    originMain: cur, // checkout already current — only the RUNNING sha is stale
    runningHead: "3f6a1d1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    idle: { workers: 1, inflightLocks: 0, worktreeLocks: 0 },
  });
  const result = runDeployCycle(r.deps);

  assert.equal(result.deployed, false, "a worker in flight must veto the restart, stale or not");
  assert.ok(!r.calls.includes("kickstart"), "no kickstart while a worker is live");
  assert.ok(!r.calls.includes("pullFf"), "and the gate is reached BEFORE any tree mutation");
});

// ── impl: the byte-identical discard, driven through the real cycle ──────────────────

test("the cycle PROCEEDS past exhaust it wrote itself, discarding only byte-identical paths", async () => {
  // The live deadlock, end to end: the daemon wrote plan/feedback/*.yaml, a filing PR committed
  // the identical bytes, and the ff then refused to clobber them — so the daemon could not pull
  // the commit containing its own output. It stuck for 5 commits until an operator intervened.
  const r = makeDeps({
    autoMode: true,
    installHead: "old-head",
    originMain: "new-head",
    dirtyFiles: ["plan/feedback/fb-alert-70.yaml", "plan/feedback/fb-alert-73.yaml"],
    incomingFiles: ["plan/feedback/fb-alert-70.yaml", "plan/feedback/fb-alert-73.yaml", "src/x.ts"],
    identical: ["plan/feedback/fb-alert-70.yaml", "plan/feedback/fb-alert-73.yaml"],
  });
  const out = await runDeployCycle(r.deps, { dryRun: false });
  assert.equal(out.deployed, true, "the deploy must no longer be blocked by its own exhaust");
  assert.ok(r.calls.includes("discard:plan/feedback/fb-alert-70.yaml"));
  assert.ok(r.calls.includes("discard:plan/feedback/fb-alert-73.yaml"));
  assert.ok(r.calls.includes("pullFf"), "and the fast-forward actually ran");
  assert.equal(r.alerts.length, 0, "no failure alert, so nothing arms the not-retried latch");
});

test("the cycle STILL aborts when any conflicting file genuinely differs", async () => {
  // The safety property under the real orchestrator: a hand-edit must not be discarded just
  // because some OTHER path happened to be identical.
  const r = makeDeps({
    autoMode: true,
    installHead: "old-head",
    originMain: "new-head",
    dirtyFiles: ["plan/feedback/fb-alert-70.yaml", "src/hand-edited.ts"],
    incomingFiles: ["plan/feedback/fb-alert-70.yaml", "src/hand-edited.ts"],
    identical: ["plan/feedback/fb-alert-70.yaml"], // the hand-edit is NOT identical
  });
  const out = await runDeployCycle(r.deps, { dryRun: false });
  assert.equal(out.deployed, false);
  assert.equal(out.reason, "dirty-tree-conflict");
  assert.ok(!r.calls.includes("pullFf"), "the operator's edit must never be fast-forwarded over");
  assert.ok(!r.calls.some((c) => c.startsWith("discard:")), "and nothing is discarded on the abort path");
  assert.match(r.alerts.join("\n"), /src\/hand-edited\.ts/, "the alert names the file that actually conflicts");
});

test("realDeployDeps: byte-identity + discard work against REAL git, including the UNTRACKED case", () => {
  // The adapters are where the safety argument actually lives, so they are exercised against real
  // git rather than a fake. The untracked case is the one that matters: `git diff` ignores
  // untracked files entirely and would have answered "identical" for anything, which is why this
  // uses blob SHAs instead.
  const root = mkdtempSync(join(tmpdir(), "rmd-deployer-git-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(root, "seed"), "seed\n");
    g("add", "-A"); g("commit", "-q", "-m", "seed");
    const base = g("rev-parse", "HEAD").trim();

    // A future commit adds the exhaust file and edits a source file.
    writeFileSync(join(root, "feedback.yaml"), "id: fb-70\nstatus: new\n");
    writeFileSync(join(root, "src.ts"), "export const upstream = 1;\n");
    g("add", "-A"); g("commit", "-q", "-m", "incoming");
    const incoming = g("rev-parse", "HEAD").trim();

    // Rewind the working tree to base, then reproduce the live shape: an UNTRACKED file whose
    // bytes already equal the incoming blob, plus a divergent local edit.
    g("reset", "-q", "--hard", base);
    writeFileSync(join(root, "feedback.yaml"), "id: fb-70\nstatus: new\n"); // identical, untracked
    writeFileSync(join(root, "src.ts"), "export const MINE = 999;\n");     // differs, untracked

    const deps = realDeployDeps({
      installPath: root, stateRoot: root, daemonLabel: "d", serveLabel: "s",
      servePort: 1, uid: 1, ledgerPath: join(root, "l"), log: () => {},
    });

    assert.equal(deps.sameAsIncoming!("feedback.yaml", incoming), true, "identical untracked file must be recognised");
    assert.equal(deps.sameAsIncoming!("src.ts", incoming), false, "a divergent file must NOT be");
    assert.equal(deps.sameAsIncoming!("absent.txt", incoming), false, "a path absent from the ref fails closed");

    // Discard the identical one only; the divergent edit must survive untouched.
    deps.discardLocal!("feedback.yaml");
    assert.equal(existsSync(join(root, "feedback.yaml")), false, "the redundant copy is gone");
    assert.equal(readFileSync(join(root, "src.ts"), "utf8"), "export const MINE = 999;\n", "the real edit is untouched");

    // The ff is still correctly refused while the DIVERGENT file remains — discarding the
    // identical one does not license fast-forwarding over a real local edit, and `treeFfSafe`
    // reports ok=false for exactly this shape.
    assert.throws(() => g("merge", "--ff-only", incoming), /untracked working tree files would be overwritten/);

    // Once the operator resolves their own edit, the ff the exhaust was blocking succeeds.
    rmSync(join(root, "src.ts"));
    g("merge", "--ff-only", incoming);
    assert.equal(g("rev-parse", "HEAD").trim(), incoming, "the ff that previously aborted now lands");
    assert.equal(readFileSync(join(root, "feedback.yaml"), "utf8"), "id: fb-70\nstatus: new\n", "and restores identical content — the discard was lossless");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("realDeployDeps: the recorded failure kind round-trips, so the skip line can cite it", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-deployer-kind-"));
  try {
    const deps = realDeployDeps({
      installPath: root, stateRoot: root, daemonLabel: "d", serveLabel: "s",
      servePort: 1, uid: 1, ledgerPath: join(root, "l"), log: () => {}, execFile: () => "", sleep: () => {},
    });
    assert.equal(deps.lastFailedKind!(), undefined, "nothing recorded yet");
    deps.alert("tree blocked the ff", "deadbeef", "dirty-tree-conflict");
    assert.equal(deps.lastFailedKind!(), "dirty-tree-conflict", "the cause survives to the next poll");
    assert.equal(deps.lastFailedHead(), "deadbeef");
    // A legacy record with no kind must read as unknown, never as a guessed health-check.
    writeFileSync(deployFailedAlertPath(root), JSON.stringify({ message: "old", failedHead: "x" }));
    assert.equal(deps.lastFailedKind!(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
