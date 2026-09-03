import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildStatusBoard,
  deriveQueueHead,
  pickQueueHeadNextAction,
  renderQueueHeadBlock,
  renderStatusBoardText,
  type QueueHeadRefusedRow,
  type QueueHeadSection,
  type ServiceName,
  type StatusBoardDeps,
} from "../src/lib/status-board.js";
import type { DispatchFilterReason } from "../src/lib/drain.js";
import { requestDrainNow, requestKick, requestPause, requestStop, setQuietHours } from "../src/lib/fleet-control.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import { deployAutoPath, deployFailedAlertPath } from "../src/lib/deployer.js";
import { statusCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import { DEFAULT_MAX_TASK_DISPATCHES, type GitHub, type PrRef, type StatusProjection } from "../src/lib/status.js";
import type { DraftCache, Proposal } from "../src/lib/inbox.js";

// ── W1-T279: rmd status, half 1 of 2 — ONE read model over LOCAL truth (LIVENESS / LATCHES /
// LAST CYCLE), rendered as text or --json from the SAME buildStatusBoard() result. Every test
// below is a plain object in, a plain object out (Rule 18): no real launchd, no real git fetch,
// no real wall clock — every seam status-board.ts exposes is injected.

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "status-board-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

const NOW_ISO = "2026-08-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/** A never-running, never-fetchable, offline-safe default deps bundle — every test overrides
 *  only the seams it actually exercises. */
function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

function ledgerLine(overrides: Record<string, unknown>): Record<string, unknown> {
  return { run_id: "R1", task_id: "daemon", ts: NOW_ISO, ...overrides };
}

// ── ACCEPTANCE 1: LIVENESS per-service running/pid/boot-time + STALE flag; every unresolved
// fact is an explicit "unknown", never a zero/healthy-looking default ─────────────────────────

test("buildStatusBoard: LIVENESS — nothing running, no boots ever recorded ⇒ every unresolved fact reads unknown, never a fabricated zero", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps());

  for (const row of model.liveness.services) {
    assert.equal(row.running, false);
    assert.equal(row.pid, null);
    assert.equal(row.bootedAt, undefined);
    assert.equal(row.bootedAgeMs, undefined);
    assert.equal(row.headSha, undefined);
  }
  assert.deepEqual(model.liveness.headVsOriginMain, { status: "unknown" });
  assert.equal(model.liveness.crashLoop.breached, false);

  const text = renderStatusBoardText(model);
  assert.match(text, /head vs origin\/main\s*:\s*unknown/);
  assert.doesNotMatch(text, /0 boots|pid 0|boot 0/); // never a zero standing in for "we don't know"
});

test("buildStatusBoard: LIVENESS — daemon running with a real daemon.boot line reports pid/boot-time/headSha; serve/deploy-supervisor never fabricate a boot time they have no ledger source for", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  writeFileSync(
    ledgerPath,
    [ledgerLine({ step: "daemon.boot", head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ts: "2026-08-01T11:00:00.000Z" })]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const queryService = (service: ServiceName) => (service === "daemon" ? { running: true, pid: 4242 } : { running: false, pid: null });

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ queryService }));

  const daemonRow = model.liveness.services.find((s) => s.service === "daemon")!;
  assert.equal(daemonRow.running, true);
  assert.equal(daemonRow.pid, 4242);
  assert.equal(daemonRow.bootedAt, "2026-08-01T11:00:00.000Z");
  assert.equal(daemonRow.bootedAgeMs, NOW_MS - Date.parse("2026-08-01T11:00:00.000Z"));
  assert.equal(daemonRow.headSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const serveRow = model.liveness.services.find((s) => s.service === "serve")!;
  assert.equal(serveRow.bootedAt, undefined); // serve logs no daemon.boot line — unknown, not 0
  assert.equal(serveRow.headSha, undefined);
});

test("buildStatusBoard: LIVENESS — running HEAD vs origin/main STALE flag, reusing deployer.ts's own sameCommit equality", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  writeFileSync(ledgerPath, JSON.stringify(ledgerLine({ step: "daemon.boot", head_sha: headSha })) + "\n");
  // "the sha the LIVE process booted at" presupposes a running daemon — inject that here.
  const daemonRunning: StatusBoardDeps["queryService"] = (service) =>
    service === "daemon" ? { running: true, pid: 1 } : { running: false, pid: null };

  const stale = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ queryService: daemonRunning, resolveOriginMainSha: () => "c".repeat(40) }));
  assert.deepEqual(stale.liveness.headVsOriginMain, { status: "stale", headSha, originSha: "c".repeat(40) });
  assert.match(stale.liveness.nextAction ?? "", /stale code/);
  assert.match(renderStatusBoardText(stale), /STALE/);

  const fresh = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ queryService: daemonRunning, resolveOriginMainSha: () => headSha }));
  assert.deepEqual(fresh.liveness.headVsOriginMain, { status: "fresh" });

  // origin/main genuinely unresolvable (offline, no such ref) ⇒ unknown, never guessed stale/fresh.
  const unknown = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ queryService: daemonRunning, resolveOriginMainSha: () => undefined }));
  assert.deepEqual(unknown.liveness.headVsOriginMain, { status: "unknown" });

  // and a daemon that ISN'T running reports unknown regardless of what its last boot said —
  // there is no live process to compare, no matter how confident the stale prior boot looks.
  const notRunning = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ resolveOriginMainSha: () => "c".repeat(40) }));
  assert.deepEqual(notRunning.liveness.headVsOriginMain, { status: "unknown" });
});

// ── ACCEPTANCE 2 (incident-a falsifier): a seeded DEPLOY_FAILED marker renders in LATCHES with
// its age + stated consequence + the section's single next action ─────────────────────────────

test("buildStatusBoard: LATCHES — a seeded state/DEPLOY_FAILED marker is impossible to miss (age + consequence + next action)", () => {
  const root = tmpRoot();
  const seededAt = new Date(NOW_MS - 17 * 3_600_000).toISOString(); // 17h ago, matching the real incident
  writeFileSync(
    deployFailedAlertPath(root),
    // `kind` matches what `realDeployDeps.alert` actually writes — this fixture predated the field
    // and so exercised the "kind not recorded" arm while asserting the rollback wording. The
    // message it carries is a health-check failure, so that is the kind it should have carried.
    JSON.stringify({
      message: "health-check failed: crash-loop",
      failedHead: "d".repeat(40),
      kind: "health-check-rollback",
      at: seededAt,
    }),
  );

  const model = buildStatusBoard(root, join(tmpdir(), "does-not-exist.ndjson"), baseDeps());

  const row = model.latches.rows.find((r) => r.name === "DEPLOY_FAILED");
  assert.ok(row, "DEPLOY_FAILED must render as a LATCHES row");
  assert.equal(row!.ageMs, NOW_MS - Date.parse(seededAt));
  assert.match(row!.consequence, /rolled back/);
  assert.match(row!.consequence, /PRIOR head/);
  assert.match(row!.consequence, /crash-loop/); // the real message, not a generic placeholder
  assert.match(model.latches.nextAction ?? "", /DEPLOY_FAILED/);

  const text = renderStatusBoardText(model);
  assert.match(text, /DEPLOY_FAILED, 17h/);
  assert.match(text, /rolled back/);
});

test("buildStatusBoard: LATCHES — nothing active renders 'no active latches', never an empty-but-silent table", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps());
  assert.deepEqual(model.latches.rows, []);
  assert.equal(model.latches.nextAction, undefined);
  assert.match(renderStatusBoardText(model), /no active latches/);
});

test("buildStatusBoard: LATCHES — every marker class in the table renders with age + consequence when present (STOP, PAUSE, QUIET_HOURS, DEPLOY_AUTO, inflight lock, pending kick, drain-now)", () => {
  const root = tmpRoot();
  requestStop(root, "operator pulled the plug");
  requestPause(root, "maintenance window");
  setQuietHours(root, true);
  writeFileSync(deployAutoPath(root), "");
  requestKick(root, "W1-T99", "console");
  requestDrainNow(root, "console");
  acquireInflightLock(join(root, "state", "inflight"), "W1-T5", { run_id: "RUN-1", info: { pid: 999, startedAt: NOW_ISO } });

  const model = buildStatusBoard(root, join(tmpdir(), "does-not-exist.ndjson"), baseDeps({ isPidAlive: (pid) => pid === 999 }));
  const names = model.latches.rows.map((r) => r.name).sort();
  assert.deepEqual(names, ["PAUSE", "QUIET_HOURS", "STOP", "drain-now", "inflight:W1-T5", "kick:W1-T99", "DEPLOY_AUTO"].sort());

  for (const row of model.latches.rows) {
    assert.ok(row.consequence.length > 0, `${row.name} must carry a stated consequence`);
  }
  // STOP outranks PAUSE for the LATCHES next action, but DEPLOY_FAILED (absent here) would win
  // over both — see the DEPLOY_FAILED test above for that ordering.
  assert.match(model.latches.nextAction ?? "", /STOP is set/);
});

test("buildStatusBoard: LATCHES — a dead-pid inflight lock is stale debris, not an active latch", () => {
  const root = tmpRoot();
  acquireInflightLock(join(root, "state", "inflight"), "W1-T5", { run_id: "RUN-1", info: { pid: 999, startedAt: NOW_ISO } });
  const model = buildStatusBoard(root, join(tmpdir(), "does-not-exist.ndjson"), baseDeps({ isPidAlive: () => false }));
  assert.equal(model.latches.rows.find((r) => r.name === "inflight:W1-T5"), undefined);
});

// ── ACCEPTANCE 3 (incident-b falsifier): a seeded daemon.boot burst that trips the EXISTING
// detectCrashLoop renders as a NAMED liveness condition ────────────────────────────────────────

test("buildStatusBoard: LIVENESS — a daemon.boot burst that trips detectDaemonCrashLoop renders as a named crash-loop condition, not silence", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  const start = Date.parse("2026-08-01T11:50:00.000Z");
  const lines = Array.from({ length: 7 }, (_, i) =>
    ledgerLine({ step: "daemon.boot", ts: new Date(start + i * 60_000).toISOString() }),
  );
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.equal(model.liveness.crashLoop.breached, true);
  assert.equal(model.liveness.crashLoop.windowBoots.length, 7);
  assert.match(model.liveness.nextAction ?? "", /crash-loop/);
  assert.match(renderStatusBoardText(model), /crash-loop.*BREACHED/i);
});

test("buildStatusBoard: LIVENESS — a normal, sparse boot history never reads as a crash-loop", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  const lines = ["2026-07-29T09:00:00.000Z", "2026-07-30T09:00:00.000Z", "2026-08-01T09:00:00.000Z"].map((ts) =>
    ledgerLine({ step: "daemon.boot", ts }),
  );
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  assert.equal(model.liveness.crashLoop.breached, false);
});

// ── ACCEPTANCE 4: LAST CYCLE renders the newest daemon.summary with its age; an empty ledger
// renders "no cycle recorded", never zeros ──────────────────────────────────────────────────────

test("buildStatusBoard: LAST CYCLE — an empty ledger renders 'no cycle recorded', never a zeroed-out summary", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps());
  assert.equal(model.lastCycle.found, false);
  assert.equal(model.lastCycle.summary, undefined);
  const text = renderStatusBoardText(model);
  assert.match(text, /no cycle recorded/);
  assert.doesNotMatch(text, /attempted : \(none\)/); // the summary block itself must not render at all
});

test("buildStatusBoard: LAST CYCLE — the NEWEST daemon.summary line wins, with its own age; a blocked stop names its own next action", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  const older = ledgerLine({
    step: "daemon.summary",
    ts: "2026-08-01T09:00:00.000Z",
    attempted: ["W1-T1"],
    merged: [],
    stopReason: "max_reached",
    costUsd: 1.23,
    ticks: 4,
  });
  const newer = ledgerLine({
    step: "daemon.summary",
    ts: "2026-08-01T11:30:00.000Z",
    attempted: ["W1-T2"],
    merged: ["W1-T2"],
    stopReason: "blocked",
    stopDetail: "W1-T2 verdict blocked_review",
    costUsd: 5.5,
    ticks: 9,
  });
  writeFileSync(ledgerPath, [older, newer].map((l) => JSON.stringify(l)).join("\n") + "\n");

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  assert.equal(model.lastCycle.found, true);
  assert.deepEqual(model.lastCycle.summary, {
    attempted: ["W1-T2"],
    merged: ["W1-T2"],
    stopReason: "blocked",
    stopDetail: "W1-T2 verdict blocked_review",
    costUsd: 5.5,
    ticks: 9,
  });
  assert.equal(model.lastCycle.ts, "2026-08-01T11:30:00.000Z");
  assert.equal(model.lastCycle.ageMs, NOW_MS - Date.parse("2026-08-01T11:30:00.000Z"));
  assert.match(model.lastCycle.nextAction ?? "", /BLOCKED/);
  assert.match(model.lastCycle.nextAction ?? "", /W1-T2 verdict blocked_review/);

  const text = renderStatusBoardText(model);
  assert.match(text, /merged {4}: W1-T2/);
  assert.match(text, /stopped {3}: blocked — W1-T2 verdict blocked_review/);
});

// ── ACCEPTANCE 5: --json emits the SAME model the text renderer projects; the whole build
// never throws with nothing running and nothing reachable (the offline/exit-0 falsifier) ────────

test("buildStatusBoard: never throws with no daemon/serve/supervisor running, no ledger file, and origin/main unresolvable — the offline-safe, daemon-down falsifier", () => {
  assert.doesNotThrow(() => {
    const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "definitely-does-not-exist-ever.ndjson"), baseDeps());
    renderStatusBoardText(model);
    JSON.stringify(model);
  });
});

test("renderStatusBoardText: projects ONLY fields already on the model — text and --json can never disagree because both come from ONE buildStatusBoard() call", () => {
  const root = tmpRoot();
  requestPause(root, "nightly maintenance");
  const model = buildStatusBoard(root, join(tmpdir(), "does-not-exist.ndjson"), baseDeps());
  const json = JSON.parse(JSON.stringify(model));
  const text = renderStatusBoardText(model);

  // Every latch row's name+consequence in the JSON model appears verbatim in the text render —
  // proof the renderer is a pure projection of the model, not a second derivation.
  for (const row of json.latches.rows) {
    assert.ok(text.includes(row.name), `text output missing latch row ${row.name}`);
    assert.ok(text.includes(row.consequence), `text output missing consequence for ${row.name}`);
  }
  assert.equal(json.generatedAt, model.generatedAt);
});

test("buildStatusBoard: is a pure function of its deps — the SAME inputs produce byte-identical output on repeat calls", () => {
  const root = tmpRoot();
  requestStop(root, "same reason");
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify(ledgerLine({ step: "daemon.summary", attempted: [], merged: [], stopReason: "max_reached", costUsd: 0, ticks: 1 })) + "\n");

  const deps = baseDeps();
  const a = buildStatusBoard(root, ledgerPath, deps);
  const b = buildStatusBoard(root, ledgerPath, deps);
  assert.deepEqual(a, b);
});

// ── ACCEPTANCE 6: `statusCommand` (run-task.ts's CLI call site) — thin glue over the SAME
// buildStatusBoard()/renderStatusBoardText() this file already proves; every seam is injected so
// `loadConfig()` (shells `which claude`) and `queryLaunchdService` (real launchctl) never run.

function fakeConfig(root: string): Config {
  return { claudeBin: "/nonexistent/claude", root } as Config;
}

test("statusCommand: an unknown flag returns 2 and reports the bad-arg message, without touching config/ledger/launchd", async () => {
  const lines: string[] = [];
  const rc = await statusCommand(["--bogus"], {
    loadConfig: () => {
      throw new Error("loadConfig must not run for a bad-arg exit");
    },
    err: (l) => lines.push(l),
  });
  assert.equal(rc, 2);
  assert.ok(lines.some((l) => l.includes("--bogus")), `expected a --bogus mention, got: ${lines.join("\n")}`);
});

test("statusCommand: text mode (no --json) renders the SAME text renderStatusBoardText() produces for the injected model", async () => {
  const root = tmpRoot();
  requestPause(root, "text-mode check");
  const lines: string[] = [];
  const rc = await statusCommand([], {
    loadConfig: () => fakeConfig(root),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => join(tmpdir(), "definitely-does-not-exist-ever.ndjson"),
    repoRoot: "/nonexistent/repo/for/tests",
    out: (l) => lines.push(l),
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("PAUSE"), `expected the PAUSE latch in text output, got: ${lines[0]}`);
});

test("statusCommand: the real, uninjected queryService closure runs an actual launchctl query and fails closed to 'not running' off a label that was never bootstrapped, without throwing", async () => {
  const root = tmpRoot();
  const lines: string[] = [];
  const rc = await statusCommand([], {
    loadConfig: () => fakeConfig(root),
    ledgerPathFor: () => join(tmpdir(), "definitely-does-not-exist-ever.ndjson"),
    repoRoot: "/nonexistent/repo/for/tests",
    out: (l) => lines.push(l),
    // deliberately no `queryService` override — exercises the real launchctl-backed closure,
    // which fails closed (a label that was never bootstrapped, or no `launchctl` binary at all
    // on a non-macOS CI runner) to "not running", never a throw.
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length > 0);
});

// ── ACCEPTANCE 7: the UNINJECTED defaults — `defaultResolveOriginMainSha`'s real, offline-safe
// `git rev-parse origin/main` (no network: a local `refs/remotes/origin/main` ref, never a
// fetch), success and not-a-repo-failure both; and `markerAgeMs`'s statSync-throws TOCTOU catch
// (a marker present at the `existsSync` check but gone/unreadable by the time its age is read) —
// every one of these three is reachable ONLY by leaving the seam uninjected, so `baseDeps()`
// (which always overrides `resolveOriginMainSha`) never exercises them.

test("buildStatusBoard: LIVENESS — the real, uninjected origin/main resolver runs an actual local `git rev-parse` (fresh) and fails closed to 'unknown' off a non-repo dir (no network either way)", () => {
  const gitRoot = mkdtempSync(join(tmpdir(), "status-board-git-"));
  execFileSync("git", ["init", "-q"], { cwd: gitRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: gitRoot });
  writeFileSync(join(gitRoot, "f.txt"), "x");
  execFileSync("git", ["add", "."], { cwd: gitRoot });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitRoot });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitRoot }).toString().trim();
  // A LOCAL remote-tracking ref, never a real remote/fetch — offline-safe by construction.
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: gitRoot });

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify(ledgerLine({ step: "daemon.boot", head_sha: sha })) + "\n");

  const deps: StatusBoardDeps = {
    queryService: (service) => (service === "daemon" ? { running: true, pid: 111 } : { running: false, pid: null }),
    repoDir: gitRoot,
    now: () => NOW_MS,
    isPidAlive: () => true,
    // deliberately no `resolveOriginMainSha` override — exercises the real default.
  };
  const fresh = buildStatusBoard(tmpRoot(), ledgerPath, deps);
  assert.deepEqual(fresh.liveness.headVsOriginMain, { status: "fresh" });

  const notARepo = tmpRoot();
  const unresolvable = buildStatusBoard(tmpRoot(), ledgerPath, { ...deps, repoDir: notARepo });
  assert.deepEqual(unresolvable.liveness.headVsOriginMain, { status: "unknown" });
});

test("buildStatusBoard: LATCHES — a marker that vanishes between the existsSync check and its age read (TOCTOU) renders an unknown age, never a thrown error", (t) => {
  const root = tmpRoot();
  writeFileSync(deployAutoPath(root), ""); // bare touch file, no JSON body — normally an mtime read
  const target = deployAutoPath(root);
  const realStatSync = fsDefault.statSync;
  t.mock.method(fsDefault, "statSync", (p: unknown, ...rest: unknown[]) => {
    if (String(p) === target) throw new Error("ENOENT: raced away between existsSync and statSync");
    return (realStatSync as (...a: unknown[]) => unknown)(p, ...rest);
  });

  const model = buildStatusBoard(root, join(tmpdir(), "does-not-exist.ndjson"), baseDeps());
  const row = model.latches.rows.find((r) => r.name === "DEPLOY_AUTO");
  assert.ok(row, "DEPLOY_AUTO must still render as a row — existsSync already confirmed it present");
  assert.equal(row!.ageMs, undefined);
});

test("statusCommand: --json emits a JSON-parseable model with the SAME latch row --json would give buildStatusBoard directly", async () => {
  const root = tmpRoot();
  requestStop(root, "json-mode check");
  const lines: string[] = [];
  const rc = await statusCommand(["--json"], {
    loadConfig: () => fakeConfig(root),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => join(tmpdir(), "definitely-does-not-exist-ever.ndjson"),
    repoRoot: "/nonexistent/repo/for/tests",
    out: (l) => lines.push(l),
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.ok(
    parsed.latches.rows.some((r: { name: string }) => r.name === "STOP"),
    `expected a STOP latch row, got: ${lines[0]}`,
  );
});

/** A repoRoot whose `plan/tasks.yaml` is genuinely readable — so a statusCommand test can
 *  isolate the `github`-construction seam's own degrade message ("no GitHub gateway ...")
 *  from the unrelated "plan/tasks.yaml is unreadable" one `/nonexistent/repo/for/tests`
 *  (used by every other statusCommand test in this file) produces instead. */
function repoRootWithEmptyPlan(): string {
  const dir = mkdtempSync(join(tmpdir(), "status-command-repo-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  return dir;
}

test("statusCommand: an uninjected `github` construction that throws (no git remote) degrades to no gateway, never a thrown status read", async () => {
  const root = tmpRoot();
  const lines: string[] = [];
  const rc = await statusCommand(["--json"], {
    loadConfig: () => fakeConfig(root),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => join(tmpdir(), "definitely-does-not-exist-ever.ndjson"),
    repoRoot: repoRootWithEmptyPlan(),
    resolveOwnerRepo: () => {
      throw new Error("could not parse owner/repo from origin url");
    },
    out: (l) => lines.push(l),
    // deliberately no `github` override — exercises the try/catch construction path.
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  // A missing gateway degrades QUEUE HEAD/INBOX to a stated unknown — never a throw.
  assert.match(parsed.queueHead.unknownReason ?? "", /no GitHub gateway/);
});

test("statusCommand: `github: null` explicitly omits the gateway (the same degrade a real outage produces), without touching the resolveOwnerRepo/buildBatchedGithub construction path", async () => {
  const root = tmpRoot();
  const lines: string[] = [];
  const rc = await statusCommand(["--json"], {
    loadConfig: () => fakeConfig(root),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => join(tmpdir(), "definitely-does-not-exist-ever.ndjson"),
    repoRoot: repoRootWithEmptyPlan(),
    github: null,
    resolveOwnerRepo: () => {
      throw new Error("must not run when `github` is explicitly provided (even as null)");
    },
    out: (l) => lines.push(l),
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.match(parsed.queueHead.unknownReason ?? "", /no GitHub gateway/);
});

// ── W1-T280: rmd status, half 2 of 2 — the DERIVED sections (BLOCKERS BY CLASS, QUEUE HEAD,
// INBOX, HEADROOM) APPEND to the SAME model W1-T279 established above. Every test below is
// still a plain object in, a plain object out: no real `gh`, no real git remote, no real wall
// clock — every new seam status-board.ts exposes is injected exactly like the ones above.

const PLAN_YAML = (extra = "") => `
- id: W1-T910
  title: a queue-head candidate
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
${extra}`;

function plan(extra = ""): Plan {
  return loadPlanFromYaml(PLAN_YAML(extra), "fixture");
}

/** A GitHub gateway fixture carrying only the four REQUIRED {@link GitHub} methods, every one
 *  answering "no evidence" — the ordinary "not merged, nothing found" reachable-gateway shape.
 *  `readFailed`/`readFailureReason` default to a REACHABLE gateway; override to simulate an
 *  outage. */
function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

// ── W1-T2392: NEEDS ME renders the uncredited-build warning `deriveStatus` already writes ──────
//
// #3108 put `StatusProjection.uncreditedBuild` on the projection and NOTHING read it. These drive
// the REAL path end to end: a plan, a batched gateway, `projectPlan` building its own prose index,
// `deriveStatus` setting the field, and the board rendering it — never a hand-built projection.
//
// THE SURFACE IS `NEEDS ME`, and the quiet-case discipline is `mergeHeld`'s, verbatim: an EMPTY
// array (never undefined), so a board with nothing uncredited renders no row at all. Measured at
// head, 84 of 103 recent builds ARE credited, so quiet is the common case.

const UNCREDITED_PR: PrRef = {
  number: 3095,
  url: "https://github.com/craigoley/remudero/pull/3095",
  state: "MERGED",
  title: "fix(sweep): stop the light-pass tick waiting on the fix rung's CI wait",
  headRefName: "fix/light-pass-tick-not-bounded-by-ci",
  body: "Builds W1-T2379, option (a) of its design: the light pass dispatches and returns.",
};
const REPAIR_PR: PrRef = {
  number: 3019,
  url: "https://github.com/craigoley/remudero/pull/3019",
  state: "MERGED",
  title: "fix(cadence): create the marker directory instead of assuming it",
  headRefName: "fix/cadence-markers-create-their-directory",
  body: "The marker write assumed a directory that nothing created.",
};
const FILING_PR: PrRef = {
  number: 3105,
  url: "https://github.com/craigoley/remudero/pull/3105",
  state: "MERGED",
  title: "chore(plan): file the build that merges with no credit on any surface (W1-T2392)",
  headRefName: "chore/plan-file-w1-t2392",
  body: "One new plan shard under the reserved id W1-T2392.",
};

/** Minimal batched gateway, the same shape test/uncredited-build-detection.test.ts drives. */
function uncreditedGateway(merged: PrRef[], filesByUrl: Record<string, string[] | undefined>): GitHub {
  const g = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: (url: string) => merged.find((p) => p.url === url)?.headRefName,
    prBody: (url: string) => merged.find((p) => p.url === url)?.body,
    listMergedHeadBranches: () => merged,
    changedFiles: (u: string) => filesByUrl[u],
  } as unknown as GitHub;
  return g;
}

const planWith = (ids: string[]): Plan =>
  ({ tasks: ids.map((id) => ({ id, title: id, repo: "remudero", type: "implement", depends_on: [], status: "queued" })) }) as unknown as Plan;

const SRC_FILES = ["src/lib/sweep.ts", "test/x.test.ts"];

test("W1-T2392: NEEDS ME renders one row for a BODY-named uncredited build, naming the task, the PR and which surface carried the id", () => {
  const model = buildStatusBoard(
    tmpRoot(),
    writeLedger([ledgerLine({ step: "run.start" })]),
    baseDeps({ plan: planWith(["W1-T2379"]), github: uncreditedGateway([UNCREDITED_PR], { [UNCREDITED_PR.url]: SRC_FILES }) }),
  );
  assert.equal(model.needsMe.uncreditedBuilds.length, 1, "exactly one row");
  const row = model.needsMe.uncreditedBuilds[0];
  assert.equal(row.taskId, "W1-T2379");
  assert.equal(row.prNumber, 3095);
  assert.equal(row.namedIn, "body", "#3095 names the id in its BODY — a title-only line would send the reader to the wrong half");

  const text = renderStatusBoardText(model);
  assert.match(text, /── NEEDS ME/);
  assert.match(text, /uncredited build : W1-T2379/);
  assert.match(text, /3095/);
  assert.match(text, /names it in the body/);
  assert.doesNotMatch(text, /nothing needs you/, "a board with an uncredited build is not quiet");

  // --json projects the SAME model, never a second derivation.
  assert.equal(JSON.parse(JSON.stringify(model)).needsMe.uncreditedBuilds[0].prNumber, 3095);
});

test("W1-T2392: NEEDS ME renders nothing for a CREDITED build — the common case (84 of 103) stays quiet", () => {
  const credited = { ...UNCREDITED_PR, headRefName: "run-W1-T2379-1787844672229" };
  const model = buildStatusBoard(
    tmpRoot(),
    writeLedger([ledgerLine({ step: "run.start" })]),
    baseDeps({ plan: planWith(["W1-T2379"]), github: uncreditedGateway([credited], { [credited.url]: SRC_FILES }) }),
  );
  assert.deepEqual(model.needsMe.uncreditedBuilds, [], "credited by its run-* head — nothing to report");
  assert.doesNotMatch(renderStatusBoardText(model), /uncredited build/);
});

test("W1-T2392: NEEDS ME renders nothing for a repair naming NO task", () => {
  const model = buildStatusBoard(
    tmpRoot(),
    writeLedger([ledgerLine({ step: "run.start" })]),
    baseDeps({ plan: planWith(["W1-T2379"]), github: uncreditedGateway([REPAIR_PR], { [REPAIR_PR.url]: SRC_FILES }) }),
  );
  assert.deepEqual(model.needsMe.uncreditedBuilds, [], "a standalone repair names no id — never a missing credit");
  assert.doesNotMatch(renderStatusBoardText(model), /uncredited build/);
});

test("W1-T2392: NEEDS ME renders nothing for a PLAN-ONLY filing naming its own id", () => {
  const model = buildStatusBoard(
    tmpRoot(),
    writeLedger([ledgerLine({ step: "run.start" })]),
    baseDeps({ plan: planWith(["W1-T2392"]), github: uncreditedGateway([FILING_PR], { [FILING_PR.url]: ["plan/tasks.d/W1-T2392-a-build.yaml"] }) }),
  );
  assert.deepEqual(model.needsMe.uncreditedBuilds, [], "a filing is not a build — its diff touches no src/ file");
  assert.doesNotMatch(renderStatusBoardText(model), /uncredited build/);
});

test("W1-T2392: the warning MOVES NO DISPOSITION — every other board section is deepEqual with and without it", () => {
  const ledger = writeLedger([ledgerLine({ step: "run.start" })]);
  const root = tmpRoot();
  const withWarn = buildStatusBoard(root, ledger, baseDeps({ plan: planWith(["W1-T2379"]), github: uncreditedGateway([UNCREDITED_PR], { [UNCREDITED_PR.url]: SRC_FILES }) }));
  // The SAME PR with a crediting head — the only difference is whether the warning fires.
  const credited = { ...UNCREDITED_PR, headRefName: "run-W1-T2379-1787844672229" };
  const without = buildStatusBoard(root, ledger, baseDeps({ plan: planWith(["W1-T2379"]), github: uncreditedGateway([credited], { [credited.url]: SRC_FILES }) }));

  assert.equal(withWarn.needsMe.uncreditedBuilds.length, 1, "precondition: one side really does warn");
  assert.deepEqual(without.needsMe.uncreditedBuilds, [], "precondition: the other really does not");
  for (const k of ["liveness", "latches", "lastCycle", "inbox", "headroom", "cacheHit", "learningsInjection"] as const) {
    assert.deepEqual(withWarn[k], without[k], `${k} must be byte-identical — this reports, it never moves a disposition`);
  }
  const { uncreditedBuilds: _a, ...restWith } = withWarn.needsMe;
  const { uncreditedBuilds: _b, ...restWithout } = without.needsMe;
  assert.deepEqual(restWith, restWithout, "every OTHER NEEDS ME row is unchanged too");
});


// ── ACCEPTANCE 1: BLOCKERS BY CLASS — circuit-broken (+ reset ETA) and dispatch.indeterminate
// (+ gh-window note) render as DISTINCT classes off the EXISTING breaker/ledger signals, never
// one generic "blocked" bucket ─────────────────────────────────────────────────────────────────

test("buildStatusBoard: BLOCKERS BY CLASS — circuit-broken and dispatch.indeterminate render as DISTINCT classes, each reading off the existing ledger signal, never a generic 'blocked' bucket", () => {
  const runStarts = Array.from({ length: DEFAULT_MAX_TASK_DISPATCHES }, (_, i) =>
    ledgerLine({ step: "run.start", task_id: "W1-T900", run_id: `W1-T900-${i}` }),
  );
  const ledgerPath = writeLedger([...runStarts, ledgerLine({ step: "dispatch.indeterminate", task_id: "W1-T901" })]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  const circuitBroken = model.blockers.rows.find((r) => r.kind === "circuit_broken" && r.taskId === "W1-T900");
  assert.ok(circuitBroken, "W1-T900 must render as a circuit_broken row");
  assert.equal(circuitBroken!.kind, "circuit_broken");
  if (circuitBroken!.kind === "circuit_broken") {
    assert.equal(circuitBroken!.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES);
    assert.equal(circuitBroken!.maxDispatches, DEFAULT_MAX_TASK_DISPATCHES);
    assert.match(circuitBroken!.resetNote, /fresh owned PR/);
  }

  const indeterminate = model.blockers.rows.find((r) => r.kind === "indeterminate" && r.taskId === "W1-T901");
  assert.ok(indeterminate, "W1-T901 must render as an indeterminate row");
  if (indeterminate!.kind === "indeterminate") {
    assert.match(indeterminate!.ghWindowNote, /gateway.*window/i);
    assert.match(indeterminate!.ghWindowNote, /not a claim that the task itself is broken/);
  }

  // Never one generic bucket: the two rows are distinguishable by `kind`, and no row is tagged
  // with a bare "blocked" that erases which class it belongs to.
  assert.notEqual(circuitBroken!.kind, indeterminate!.kind);

  assert.match(model.blockers.nextAction ?? "", /W1-T900/);
  const text = renderStatusBoardText(model);
  assert.match(text, /circuit-broken : W1-T900/);
  assert.match(text, /indeterminate {2}: W1-T901/);
});

test("buildStatusBoard: BLOCKERS BY CLASS — an indeterminate-only board (no circuit-broken, no blocked PR) picks the indeterminate row's OWN next action, not a generic fallback", () => {
  const ledgerPath = writeLedger([ledgerLine({ step: "dispatch.indeterminate", task_id: "W1-T901" })]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  assert.equal(model.blockers.rows.length, 1);
  assert.equal(model.blockers.rows[0]!.kind, "indeterminate");
  assert.match(model.blockers.nextAction ?? "", /W1-T901's GitHub read is indeterminate/);
  const text = renderStatusBoardText(model);
  assert.match(text, /next action: W1-T901's GitHub read is indeterminate/);
});

test("buildStatusBoard: projectPlan throwing unexpectedly (not a stated readFailed) degrades QUEUE HEAD/INBOX to a stated unknown, never an uncaught throw", () => {
  const ledgerPath = writeLedger([]);
  const throwingGithub = fakeGithub({ listMergedHeadBranches: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => {
    const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: throwingGithub }));
    assert.match(model.queueHead.unknownReason ?? "", /GitHub projection failed unexpectedly/);
    assert.match(model.queueHead.unknownReason ?? "", /boom/);
    assert.match(model.inbox.unknownReason ?? "", /GitHub projection failed unexpectedly/);
  });
});

// ── ACCEPTANCE 2 (the four-re-dispatch falsifier): a task re-attempted every cycle appears in
// QUEUE HEAD flagged with its attempt count AND its observed per-cycle cost ───────────────────

test("buildStatusBoard: QUEUE HEAD — the four-re-dispatch falsifier: a perpetually-re-attempted task is flagged with its attempt count AND its observed per-cycle cost, so repeated spend cannot stay invisible", () => {
  const attempts = DEFAULT_MAX_TASK_DISPATCHES - 1; // one dispatch away from tripping the breaker
  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < attempts; i++) {
    lines.push(ledgerLine({ step: "run.start", task_id: "W1-T910", run_id: `W1-T910-${i}` }));
    lines.push(
      ledgerLine({ step: "verdict", task_id: "W1-T910", run_id: `W1-T910-${i}`, verdict: "blocked_review", cost_usd: 1 + i }),
    );
  }
  const ledgerPath = writeLedger(lines);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(model.queueHead.unknownReason, undefined);
  const row = model.queueHead.rows.find((r) => r.taskId === "W1-T910");
  assert.ok(row, "W1-T910 must appear in QUEUE HEAD");
  assert.equal(row!.attempts, attempts);
  assert.equal(row!.perpetual, true);
  assert.equal(row!.observedPerCycleCostUsd, attempts); // the LAST run's own cost_usd (1 + (attempts-1))

  assert.match(model.queueHead.nextAction ?? "", /W1-T910/);
  assert.match(model.queueHead.nextAction ?? "", new RegExp(`${attempts} times`));

  const text = renderStatusBoardText(model);
  assert.match(text, /W1-T910.*PERPETUAL.*attempts 4/);
});

test("buildStatusBoard: QUEUE HEAD — an empty plan (a reachable GitHub, nothing to dispatch) renders 'nothing dispatchable', never an empty-but-silent block", () => {
  const ledgerPath = writeLedger([]);
  const emptyPlan = loadPlanFromYaml("[]\n", "fixture");
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: emptyPlan, github: fakeGithub() }));
  assert.equal(model.queueHead.unknownReason, undefined);
  assert.deepEqual(model.queueHead.rows, []);
  const text = renderStatusBoardText(model);
  assert.match(text, /nothing dispatchable/);
});

test("buildStatusBoard: QUEUE HEAD — a task with only ONE dispatch is NOT flagged perpetual, and carries no fabricated cost", () => {
  const ledgerPath = writeLedger([ledgerLine({ step: "run.start", task_id: "W1-T910", run_id: "W1-T910-0" })]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));
  const row = model.queueHead.rows.find((r) => r.taskId === "W1-T910");
  assert.ok(row);
  assert.equal(row!.attempts, 1);
  assert.equal(row!.perpetual, false);
  assert.equal(row!.observedPerCycleCostUsd, undefined);
});

// ── W1-T450: QUEUE HEAD's candidate list renders identically whether it is about to dispatch or
// has been sitting untouched — the rung compares `rows` against the newest `run.start` seen
// ANYWHERE (task-id-agnostic, like `distinctDispatchedTaskIds`), against a bound derived from
// THIS HOST'S OWN observed dispatch cadence, never a guessed constant (design (iii)) ───────────

test("buildStatusBoard: QUEUE HEAD — a non-empty candidate list with no run.start newer than the observed-cadence bound renders a STALL, naming the candidate count and how long it has been quiet", () => {
  const ledgerPath = writeLedger([
    // Three dispatches of a DIFFERENT task, 5 minutes apart — "nothing dispatched" means no task
    // anywhere, not just today's own candidate, so this is deliberately task-id-agnostic.
    ledgerLine({ step: "run.start", task_id: "OTHER-TASK", run_id: "R1", ts: "2026-08-01T10:00:00.000Z" }),
    ledgerLine({ step: "run.start", task_id: "OTHER-TASK", run_id: "R2", ts: "2026-08-01T10:05:00.000Z" }),
    ledgerLine({ step: "run.start", task_id: "OTHER-TASK", run_id: "R3", ts: "2026-08-01T10:10:00.000Z" }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(model.queueHead.rows.length, 1, "the fixture plan's own W1-T910 must still be the sole candidate");
  const stall = model.queueHead.stall;
  assert.ok(stall, "1h50m of silence past a 15-minute bound (3x the 5-minute worst observed gap) must render a stall");
  assert.equal(stall!.candidateCount, 1);
  assert.equal(stall!.lastDispatchTs, "2026-08-01T10:10:00.000Z");
  assert.equal(stall!.sinceMs, NOW_MS - Date.parse("2026-08-01T10:10:00.000Z"));
  assert.equal(stall!.boundMs, 5 * 60_000 * 3); // 3x the 5-minute worst observed gap
  assert.match(stall!.boundDerivation, /3x/);
  assert.match(stall!.boundDerivation, /5m/);

  assert.match(model.queueHead.nextAction ?? "", /1 candidate/);
  assert.match(model.queueHead.nextAction ?? "", /nothing has dispatched/);

  const text = renderStatusBoardText(model);
  assert.match(text, /STALL: 1 candidate\(s\), nothing dispatched in 1h50m/);
});

test("buildStatusBoard: QUEUE HEAD — a non-empty candidate list with a run.start INSIDE the observed-cadence bound renders no stall — a fleet about to dispatch must not be misread as one that has stopped", () => {
  const ledgerPath = writeLedger([
    ledgerLine({ step: "run.start", task_id: "OTHER-TASK", run_id: "R1", ts: "2026-08-01T10:00:00.000Z" }),
    ledgerLine({ step: "run.start", task_id: "OTHER-TASK", run_id: "R2", ts: "2026-08-01T10:05:00.000Z" }),
    // Newest dispatch just 2 minutes ago — well inside the 15-minute bound the 5-minute worst
    // gap above licenses.
    ledgerLine({ step: "run.start", task_id: "OTHER-TASK", run_id: "R3", ts: new Date(NOW_MS - 2 * 60_000).toISOString() }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(model.queueHead.rows.length, 1);
  assert.equal(model.queueHead.stall, undefined);
  assert.doesNotMatch(renderStatusBoardText(model), /STALL/);
});

// ── ACCEPTANCE 3: a blocked item whose reason the system never named renders as "reason not
// named" rather than blank, and no blocker class is minted here that the named-reason
// vocabulary (sweep.ts's own `disposition`) does not already carry ────────────────────────────

test("buildStatusBoard: BLOCKERS BY CLASS — blocked PRs RENDER sweep.ts's own named reason; a line with no `reason` field renders 'reason not named', never a blank; an ordinary 'mergeable' PR never renders as blocked", () => {
  const ledgerPath = writeLedger([
    ledgerLine({ step: "sweep.disposed", task_id: "W1-T50", pr_number: 100, pr_url: "https://x/100", disposition: "blocked-fixable", reason: "required checks red — ci-log fix, strike 1/3", acted: true }),
    // No `reason` field at all, and no real owning task (sweep.ts's own `pr.taskId ?? "SWEEP"`
    // fallback) — the honest "nobody named this" case.
    ledgerLine({ step: "sweep.disposed", task_id: "SWEEP", pr_number: 101, pr_url: "https://x/101", disposition: "blocked-ambiguous", acted: false }),
    // An ordinary progressing PR must NEVER show up as a blocker.
    ledgerLine({ step: "sweep.disposed", task_id: "W1-T51", pr_number: 102, pr_url: "https://x/102", disposition: "mergeable", reason: "arming auto-merge", acted: true }),
  ]);

  // A reachable plan + GitHub gateway (W1-T306): `blocked_pr` rows are now re-derived against
  // LIVE merge state every render, so this "sweep.ts's own vocabulary" test needs a reachable
  // gateway to reach that live-check path at all — none of PRs #100/#101/#102 are ever resolved
  // MERGED/CLOSED by it (the plan's own task carries no `pr:` field), so they render exactly as
  // this test always expected.
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  const named = model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 100);
  assert.ok(named);
  if (named!.kind === "blocked_pr") {
    assert.equal(named!.taskId, "W1-T50");
    assert.equal(named!.disposition, "blocked-fixable"); // sweep.ts's OWN vocabulary, verbatim
    assert.equal(named!.reason, "required checks red — ci-log fix, strike 1/3");
  }

  const unnamed = model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 101);
  assert.ok(unnamed);
  if (unnamed!.kind === "blocked_pr") {
    assert.equal(unnamed!.reason, "reason not named"); // never a blank
  }

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 102),
    undefined,
    "an ordinary 'mergeable' disposition must never render as a blocker",
  );

  const text = renderStatusBoardText(model);
  assert.match(text, /blocked PR {5}: #100 \(W1-T50\) \[blocked-fixable\]/);
  assert.match(text, /blocked PR {5}: #101 \[blocked-ambiguous\] — reason not named/);
});

// ── ACCEPTANCE 4: HEADROOM renders the newest daemon.headroom telemetry WITH enforcement on/off
// from the SAME switch the daemon reads; absent telemetry renders "no telemetry yet", never 0% ─

test("buildStatusBoard: HEADROOM — no daemon.headroom line ever ledgered renders 'no headroom telemetry yet', never a fabricated 0%", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps());
  assert.equal(model.headroom.found, false);
  assert.equal(model.headroom.telemetry, undefined);
  assert.equal(model.headroom.enforced, true); // the product default (governor ON) when unspecified

  const text = renderStatusBoardText(model);
  assert.match(text, /no headroom telemetry yet/);
  assert.doesNotMatch(text, /0%/);
});

test("buildStatusBoard: HEADROOM — the newest daemon.headroom line renders its telemetry, and enforcement reads off the SAME switch the daemon itself reads (not off the telemetry line)", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "daemon.headroom",
      ts: "2026-08-01T09:00:00.000Z",
      window: "session (5h)",
      percent_used: 10,
      limit_pct: 90,
      resets_at: "2026-08-01T14:00:00.000Z",
      enforced: true,
    }),
    ledgerLine({
      step: "daemon.headroom",
      ts: "2026-08-01T11:45:00.000Z",
      window: "session (5h)",
      percent_used: 42,
      limit_pct: 90,
      resets_at: "2026-08-01T17:00:00.000Z",
      enforced: false,
      note: "headroom governor disabled (ruling a4153e) — telemetry only, dispatch not gated",
    }),
  ]);

  // The switch says OFF even though the newest ledgered line's own `enforced` field says true
  // for an OLDER line — the model must read the SWITCH, never trust a stale ledgered copy.
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ resolveHeadroomEnabled: () => false }));

  assert.equal(model.headroom.found, true);
  assert.equal(model.headroom.enforced, false);
  assert.deepEqual(model.headroom.telemetry, {
    window: "session (5h)",
    percentUsed: 42,
    limitPct: 90,
    resetsAt: "2026-08-01T17:00:00.000Z",
    note: "headroom governor disabled (ruling a4153e) — telemetry only, dispatch not gated",
  });
  assert.equal(model.headroom.ts, "2026-08-01T11:45:00.000Z");
  assert.equal(model.headroom.ageMs, NOW_MS - Date.parse("2026-08-01T11:45:00.000Z"));
  assert.match(model.headroom.nextAction ?? "", /OFF/);

  const text = renderStatusBoardText(model);
  assert.match(text, /enforcement : OFF/);
  assert.match(text, /used {8}: 42% \(limit 90%\)/);
});

// ── ACCEPTANCE 5: with the GitHub gateway unreachable the derived sections render a stated
// UNKNOWN and the LOCAL sections still render in full — the board never fails closed on a
// network outage, and never fetches per row ────────────────────────────────────────────────────

test("buildStatusBoard: GitHub gateway unreachable ⇒ QUEUE HEAD/INBOX render a stated unknown; LIVENESS/LATCHES/LAST CYCLE and BLOCKERS' ledger-only classes still render in FULL, never a throw", () => {
  const root = tmpRoot();
  requestPause(root, "operator break"); // proves LATCHES still renders in full
  const runStarts = Array.from({ length: DEFAULT_MAX_TASK_DISPATCHES }, (_, i) =>
    ledgerLine({ step: "run.start", task_id: "W1-T900", run_id: `W1-T900-${i}` }),
  );
  const ledgerPath = writeLedger([
    ...runStarts,
    ledgerLine({ step: "daemon.boot", head_sha: "a".repeat(40), ts: "2026-08-01T11:00:00.000Z" }),
    ledgerLine({ step: "daemon.summary", attempted: ["W1-T1"], merged: [], stopReason: "max_reached", costUsd: 1, ticks: 2 }),
  ]);
  const unreachable = fakeGithub({ readFailed: () => true, readFailureReason: () => "transport" });

  assert.doesNotThrow(() => {
    const model = buildStatusBoard(root, ledgerPath, baseDeps({ plan: plan(), github: unreachable }));

    // LOCAL sections (W1-T279) render in FULL, completely unaffected.
    assert.ok(model.latches.rows.some((r) => r.name === "PAUSE"));
    assert.equal(model.liveness.services.length, 3);
    assert.equal(model.lastCycle.found, true);

    // BLOCKERS' ledger-only classes are UNAFFECTED — GitHub is decoration, never a gate.
    assert.ok(model.blockers.rows.some((r) => r.kind === "circuit_broken" && r.taskId === "W1-T900"));

    // The two GitHub-dependent DERIVED sections degrade to a stated unknown — never empty-but-silent.
    assert.match(model.queueHead.unknownReason ?? "", /unreachable/);
    assert.match(model.queueHead.unknownReason ?? "", /transport/);
    assert.deepEqual(model.queueHead.rows, []);
    assert.match(model.inbox.unknownReason ?? "", /unreachable/);
    assert.equal(model.inbox.readyCount, 0);
    assert.equal(model.inbox.notReadyCount, 0);

    const text = renderStatusBoardText(model);
    assert.match(text, /PAUSE/); // LATCHES block still present
    assert.match(text, /unknown — .*unreachable/); // QUEUE HEAD / INBOX name the outage
    JSON.stringify(model);
  });
});

test("buildStatusBoard: no plan/tasks.yaml available ⇒ QUEUE HEAD/INBOX render a stated unknown, never a throw (mirrors the offline/no-checkout case every prior test in this file already exercises via baseDeps())", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps());
  assert.match(model.queueHead.unknownReason ?? "", /plan\/tasks\.yaml/);
  assert.match(model.inbox.unknownReason ?? "", /plan\/tasks\.yaml/);
});

// ── W1-T2637: QUEUE HEAD's REFUSED renderer was a two-way ternary over the row's `reason` —
// the breaker got its own wording and EVERY OTHER reason inherited the hardcoded run-branch
// sentence. W1-T2415 already had to repair that ternary once, when it added the breaker arm;
// this closes the trap for good with a label table keyed by `Record<QueueHeadRefusedRow["reason"],
// ...>` so the type-checker — not a future author — names this site the next time either union
// widens. Deliberately NOT exercised through a live `refused` row for every reason: the
// derivation's own scope guard (`deriveQueueHead`'s `if (reason !== "run-branch-already-pushed")
// return;`) still only ever admits the two reasons it admitted before this task (criterion 3
// below), so most of these rows are hand-built — proving the RENDERER cannot mislabel them
// WHENEVER a future, separately-decided change admits them, not that they are admitted today.

function refusedRow(reason: QueueHeadRefusedRow["reason"], overrides: Partial<QueueHeadRefusedRow> = {}): QueueHeadRefusedRow {
  return { taskId: "W1-TX", title: "some task", reason, ...overrides };
}

function sectionOf(refused: QueueHeadRefusedRow[]): QueueHeadSection {
  return { rows: [], refused, refusedTruncated: 0 };
}

// The DispatchFilterReason union's own arms, read from source rather than retyped by hand — the
// SAME technique test/queue-head-names-a-circuit-broken-refusal.test.ts already uses to pin this
// union's membership, reused here so this file cannot drift from that one's count.
function dispatchFilterReasonArms(): string[] {
  const drain = readFileSync(new URL("../src/lib/drain.ts", import.meta.url), "utf8");
  const decl = drain.slice(drain.indexOf("export type DispatchFilterReason ="));
  const body = decl.slice(0, decl.indexOf(";"));
  return [...body.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]!);
}

// ── ACCEPTANCE 1: "a refused row carrying a reason other than the run-branch and breaker cases
// renders wording derived from that reason — never the hardcoded run-branch sentence it inherits
// today" ─────────────────────────────────────────────────────────────────────────────────────────

test("W1-T2637: the QUEUE_HEAD_REFUSAL_WORDING table names every DispatchFilterReason arm plus 'circuit-broken' — exhaustive by construction, not by enumeration this test could fall behind", () => {
  const src = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  const decl = src.slice(src.indexOf("const QUEUE_HEAD_REFUSAL_WORDING"));
  const body = decl.slice(0, decl.indexOf("};") + 2);
  // Entries may be packed several-per-line (source-size-ratchet headroom), so a key is matched
  // wherever it follows the object literal's opening `{` or a `,` — not only at start of line.
  const keys = [...body.matchAll(/(?:^|[{,])\s*(?:"([a-z-]+)"|([a-z-]+))\s*:\s*\(/gm)].map((m) => m[1] ?? m[2]!);
  const wanted = [...dispatchFilterReasonArms(), "circuit-broken"];
  assert.deepEqual(keys.sort(), wanted.sort(), "the table has exactly one entry per union member — no arm missing, none stray");
});

test("W1-T2637: a refused row for any reason other than run-branch/breaker renders wording DERIVED FROM THAT REASON, never the hardcoded run-branch sentence it used to inherit", () => {
  const otherReasons = dispatchFilterReasonArms().filter((r) => r !== "run-branch-already-pushed");
  assert.ok(otherReasons.length > 0, "sanity: there is at least one non-run-branch reason to prove this against");
  const seen = new Set<string>();
  for (const reason of otherReasons) {
    const out = renderQueueHeadBlock(sectionOf([refusedRow(reason as DispatchFilterReason)]));
    const line = out.find((l) => l.startsWith("REFUSED:"))!;
    assert.ok(line, `reason '${reason}' must still render a REFUSED line`);
    assert.equal(line.includes("run branch already pushed"), false, `reason '${reason}' must NOT inherit the run-branch sentence`);
    seen.add(line);
  }
  assert.equal(seen.size, otherReasons.length, "each reason renders its OWN wording — not one shared fallback string for all of them");
});

// ── ACCEPTANCE 2: "the two reasons that reach this surface today render byte-identically, breaker
// reset-note fallback included" ─────────────────────────────────────────────────────────────────

test("W1-T2637: the run-branch-already-pushed row renders BYTE-IDENTICALLY to before this task", () => {
  const out = renderQueueHeadBlock(sectionOf([refusedRow("run-branch-already-pushed", { taskId: "W1-T903", title: "run branch already pushed" })]));
  assert.equal(out.find((l) => l.startsWith("REFUSED:")), "REFUSED: W1-T903 — run branch already pushed (run branch already pushed to origin)");
});

test("W1-T2637: the circuit-broken row renders BYTE-IDENTICALLY to before this task, resetNote present", () => {
  const out = renderQueueHeadBlock(
    sectionOf([
      refusedRow("circuit-broken", {
        taskId: "W1-T920",
        title: "dispatched past the breaker threshold",
        resetNote: "resets only on a fresh owned PR for W1-T920 — 5/5 dispatches since the last one",
      }),
    ]),
  );
  assert.equal(
    out.find((l) => l.startsWith("REFUSED:")),
    "REFUSED: W1-T920 — dispatched past the breaker threshold (dispatch circuit breaker tripped — " +
      "resets only on a fresh owned PR for W1-T920 — 5/5 dispatches since the last one)",
  );
});

test("W1-T2637: the circuit-broken row's reset-note FALLBACK (no resetNote given) also renders byte-identically to before this task", () => {
  const out = renderQueueHeadBlock(
    sectionOf([refusedRow("circuit-broken", { taskId: "W1-T921", title: "no reset note", dispatchCount: 4, maxDispatches: 5 })]),
  );
  assert.equal(
    out.find((l) => l.startsWith("REFUSED:")),
    "REFUSED: W1-T921 — no reset note (dispatch circuit breaker tripped — 4/5 dispatches with no new owned PR)",
  );
});

// ── ACCEPTANCE 3: "the refused list is NOT widened: a task refused for any other reason still
// produces no refused row at all, so the scope guard stands" ───────────────────────────────────

test("W1-T2637: deriveQueueHead's scope guard is UNCHANGED — it still only ever admits run-branch-already-pushed onto `refused`, never widening to the reasons this task adds wording for", () => {
  const src = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  assert.match(src, /if \(reason !== "run-branch-already-pushed"\) return;/, "the W1-T1205/W1-T2415 scope guard stands verbatim");
});

test("buildStatusBoard: QUEUE HEAD — a task refused for 'blocked', 'retired', 'unmet-deps', 'verify-not-auto', or 'already-merged' is excluded from `rows` but produces NO `refused` row at all — the label table this task adds does not widen what the board admits", () => {
  const yaml = `
- id: W1-TOK
  title: eligible
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: W1-TBLOCKED
  title: plan-blocked
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: blocked
- id: W1-TRETIRED
  title: retired
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: blocked
  retirement: closed
- id: W1-TDEPS
  title: unmet deps
  repo: remudero
  type: implement
  verify: auto
  depends_on: ["W1-TOK"]
  status: queued
- id: W1-TMANUAL
  title: verify not auto
  repo: remudero
  type: implement
  verify: manual
  depends_on: []
  status: queued
- id: W1-TMERGED
  title: already merged
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  const projections = new Map([
    ["W1-TOK", { merged: false } as StatusProjection],
    ["W1-TBLOCKED", { merged: false } as StatusProjection],
    ["W1-TRETIRED", { merged: false } as StatusProjection],
    ["W1-TDEPS", { merged: false } as StatusProjection],
    ["W1-TMANUAL", { merged: false } as StatusProjection],
    ["W1-TMERGED", { merged: true } as StatusProjection],
  ]);
  const head = deriveQueueHead(plan, [], projections, undefined, 10, NOW_MS);
  assert.deepEqual(head.rows.map((r) => r.taskId), ["W1-TOK"], "only the genuinely eligible task dispatches");
  assert.deepEqual(head.refused, [], "none of the five other-reason exclusions produce a refused row — the scope guard stands");
  assert.equal(head.refusedTruncated, 0);
  assert.doesNotMatch(renderStatusBoardText(buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist.ndjson"), baseDeps({ plan, github: fakeGithub() }))), /REFUSED/);
});

// ── ACCEPTANCE 4: "the next-action rules stay scoped to their own reasons — a refusal of any
// other kind draws no run-branch remedy and no breaker remedy" ─────────────────────────────────

test("W1-T2637: the queue-head next-action rules stay reason-scoped — a refusal for any reason other than run-branch/breaker draws NEITHER the run-branch remedy NOR the breaker remedy", () => {
  const otherReasons = dispatchFilterReasonArms().filter((r) => r !== "run-branch-already-pushed");
  for (const reason of otherReasons) {
    const action = pickQueueHeadNextAction(sectionOf([refusedRow(reason as DispatchFilterReason)]));
    assert.equal(action, undefined, `reason '${reason}' must draw no next action from either reason-scoped rule — got: ${action}`);
  }
});

test("W1-T2637: a mix of one exotic-reason row and one real run-branch row still picks ONLY the run-branch remedy, naming the run-branch task, never the exotic one", () => {
  const action = pickQueueHeadNextAction(
    sectionOf([refusedRow("blocked", { taskId: "W1-TBLOCKED" }), refusedRow("run-branch-already-pushed", { taskId: "W1-TBRANCH" })]),
  );
  assert.match(action ?? "", /W1-TBRANCH/);
  assert.match(action ?? "", /run branch already pushed to origin/);
  assert.equal(action?.includes("W1-TBLOCKED"), false);
});

// ── INBOX — ready/not-ready counts from inbox.ts's own InboxState, with the not-ready reason
// named for the head item only (not an acceptance bullet on its own, but the design's own
// falsifier: a proposal registry with a mix of ready/not-ready must summarize honestly) ────────

test("buildStatusBoard: INBOX — ready/not-ready counts from inbox.ts's own classifyProposal, with the not-ready reason named for the head item only", () => {
  const proposals: Proposal[] = [
    { id: "P1", summary: "first", evidenceAnchors: [] },
    { id: "P2", summary: "second", evidenceAnchors: [] },
  ];
  const model = buildStatusBoard(
    tmpRoot(),
    join(tmpdir(), "does-not-exist.ndjson"),
    baseDeps({
      plan: plan(),
      github: fakeGithub(),
      readProposalRegistry: () => proposals,
      readDraftCache: () => ({}) as DraftCache,
      grepAnchorTrue: () => true,
    }),
  );
  assert.equal(model.inbox.unknownReason, undefined);
  assert.equal(model.inbox.readyCount, 0);
  assert.equal(model.inbox.notReadyCount, 2);
  assert.match(model.inbox.headNotReadyReason ?? "", /not-drafted/); // P1 (registry order) — no draft cached
});

// ── LAST CLOSED CYCLE: a cycle nothing has superseded still demands attention; one the daemon
// has worked past does not. OBSERVED LIVE: the block reported the SAME errored cycle across four
// status calls over ~8h while the daemon dispatched and completed W1-T409/T411/T425/T426, and its
// `next action` told the operator to investigate it — competing with three real circuit-broken
// tasks in the same output. A cycle is only written when the loop STOPS (measured: of 524
// `daemon.summary` rows, 312 blocked / 131 error / 56 headroom_exhausted / 23 paused / 1 stopped
// / 1 max_reached — none says "completed normally"), so this block is ALWAYS an ending. ────────

function lastCycleLedger(extra: Array<Record<string, unknown>> = []): string {
  const p = join(mkdtempSync(join(tmpdir(), "status-board-superseded-")), "ledger.ndjson");
  const cycle = ledgerLine({
    step: "daemon.summary",
    ts: "2026-08-01T09:00:00.000Z",
    attempted: ["W1-T414"],
    merged: [],
    stopReason: "error",
    stopDetail: "W1-T414: spawnDetachedGroup: child process has no pid (spawn failed synchronously)",
    costUsd: 0,
    ticks: 0,
  });
  writeFileSync(p, [cycle, ...extra].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

test("LAST CLOSED CYCLE: an errored cycle with NOTHING after it still names its next action", () => {
  const model = buildStatusBoard(tmpRoot(), lastCycleLedger(), baseDeps());
  assert.equal(model.lastCycle.found, true);
  assert.equal(model.lastCycle.supersededByTs, undefined, "nothing ran after it");
  assert.match(model.lastCycle.nextAction ?? "", /unexpected ERROR/, "an unsuperseded error is still the operator's problem");
  assert.match(model.lastCycle.nextAction ?? "", /spawnDetachedGroup/);
  const text = renderStatusBoardText(model);
  assert.doesNotMatch(text, /superseded/, "nothing to supersede it");
});

test("LAST CLOSED CYCLE: daemon activity AFTER the cycle suppresses the next action and says so", () => {
  const ledgerPath = lastCycleLedger([
    ledgerLine({ step: "daemon.iteration", ts: "2026-08-01T09:05:00.000Z", task: "W1-T409" }),
    ledgerLine({ step: "daemon.alive", ts: "2026-08-01T09:40:00.000Z" }),
  ]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.equal(model.lastCycle.found, true, "the closed cycle is still REPORTED — this is not hiding it");
  assert.equal(model.lastCycle.supersededByTs, "2026-08-01T09:40:00.000Z", "the NEWEST later daemon.* row");
  assert.equal(model.lastCycle.supersededAgeMs, NOW_MS - Date.parse("2026-08-01T09:40:00.000Z"));
  assert.equal(
    model.lastCycle.nextAction,
    undefined,
    "a cycle the daemon has already worked past must not demand investigation",
  );

  const text = renderStatusBoardText(model);
  assert.match(text, /superseded: the daemon has run since/);
  assert.match(text, /stopped {3}: error/, "the ending itself is still on screen");
  assert.doesNotMatch(text, /check the ledger around this run/, "the misdirecting action is gone");
});

test("LAST CLOSED CYCLE: the header says CLOSED, and a non-daemon row after the cycle does not supersede it", () => {
  // Only `daemon.*` counts — a worker's own row is not evidence the LOOP resumed. Same prefix
  // rule `deriveLastPoll` uses, and the reason LIVENESS stayed correct while this block did not.
  const ledgerPath = lastCycleLedger([
    ledgerLine({ step: "verdict", ts: "2026-08-01T09:05:00.000Z", verdict: "merged" }),
  ]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  assert.equal(model.lastCycle.supersededByTs, undefined, "a verdict row is not the daemon loop");
  assert.match(model.lastCycle.nextAction ?? "", /unexpected ERROR/);
  assert.match(renderStatusBoardText(model), /── LAST CLOSED CYCLE/, "the header no longer implies currency");
});

test("LAST CLOSED CYCLE: a superseded BLOCKED cycle is suppressed too — both rules are gated, not just the error one", () => {
  // 312 of the 524 measured summaries stop BLOCKED — the commonest ending by far, so gating only
  // the error rule would leave the majority still demanding attention after the daemon moved on.
  const p = join(mkdtempSync(join(tmpdir(), "status-board-superseded-blocked-")), "ledger.ndjson");
  writeFileSync(
    p,
    [
      ledgerLine({
        step: "daemon.summary",
        ts: "2026-08-01T09:00:00.000Z",
        attempted: ["W1-T343"],
        merged: [],
        stopReason: "blocked",
        stopDetail: "W1-T343 → no_pr — blocks W1-T344",
        costUsd: 0,
        ticks: 0,
      }),
      ledgerLine({ step: "daemon.alive", ts: "2026-08-01T09:30:00.000Z" }),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const model = buildStatusBoard(tmpRoot(), p, baseDeps());
  assert.equal(model.lastCycle.summary?.stopReason, "blocked");
  assert.equal(model.lastCycle.supersededByTs, "2026-08-01T09:30:00.000Z");
  assert.equal(model.lastCycle.nextAction, undefined, "a blocked cycle the daemon worked past is history too");
  assert.doesNotMatch(renderStatusBoardText(model), /resolve the blocking task/);
});

// ── W1-T1000003: A HELD PULL REQUEST IS VISIBLE ON THE BOARD ───────────────────────────────────
//
// Before this task `deriveBlockers`/`deriveNeedsMe` read no `automerge.hold_*` ledger state at
// all, so an operator's merge hold (W1-T1000002's ledgered `automerge.hold_engaged` /
// `automerge.hold_released` rows, read back by review.ts's `automergeHoldFromLedger`) landed in
// no blocker class and no NEEDS ME row — a request deliberately not merging looked exactly like
// one still waiting on checks. `mergeHeld` renders it as its OWN row, keyed on that ledgered
// state alone, never a re-derivation of a reason from check or review fields (grep proof: this
// file consumes `automergeHoldFromLedger`, never reimplements its precedence).

test("buildStatusBoard/renderStatusBoardText: with a hold engaged the board renders exactly one row naming the held request, its author and its reason", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "automerge.hold_engaged",
      task_id: "W1-T800",
      pr_number: 800,
      by: "craig",
      reason: "freezing this PR pending a manual read",
    }),
  ]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.equal(model.needsMe.mergeHeld.length, 1, "exactly one row");
  const row = model.needsMe.mergeHeld[0];
  assert.equal(row.prNumber, 800, "names the held request");
  assert.equal(row.taskId, "W1-T800");
  assert.equal(row.by, "craig", "its author");
  assert.equal(row.reason, "freezing this PR pending a manual read", "its reason");

  const text = renderStatusBoardText(model);
  assert.match(text, /── NEEDS ME/);
  assert.match(text, /merge held.*#800/);
  assert.match(text, /craig/);
  assert.match(text, /freezing this PR pending a manual read/);

  // --json projects the SAME model, never a second derivation.
  const json = JSON.parse(JSON.stringify(model));
  assert.equal(json.needsMe.mergeHeld[0].prNumber, 800);
});

test("buildStatusBoard: with no hold engaged the board renders no hold row at all, so the quiet case stays quiet", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist-merge-hold.ndjson"), baseDeps());
  assert.deepEqual(model.needsMe.mergeHeld, []);
  assert.doesNotMatch(renderStatusBoardText(model), /merge held/);
  assert.match(renderStatusBoardText(model), /nothing needs you/);
});

test("buildStatusBoard: a released hold disappears from the next render with no acknowledgement step", () => {
  const ledgerPath = writeLedger([
    ledgerLine({ step: "automerge.hold_engaged", task_id: "W1-T800", pr_number: 800, by: "craig", reason: "freezing pending a manual read" }),
    ledgerLine({ step: "automerge.hold_released", task_id: "W1-T800", pr_number: 800, by: "craig", reason: "read done, releasing" }),
  ]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.deepEqual(model.needsMe.mergeHeld, [], "the release clears it with nothing else to do");
  assert.doesNotMatch(renderStatusBoardText(model), /merge held/);
});

test("buildStatusBoard: a FLEET-scoped hold (no pr_number) with no PR-scoped row ever recorded renders as one row naming no PR", () => {
  const ledgerPath = writeLedger([
    ledgerLine({ step: "automerge.hold_engaged", by: "craig", reason: "fleet freeze pending an incident review" }),
  ]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.equal(model.needsMe.mergeHeld.length, 1);
  assert.equal(model.needsMe.mergeHeld[0].prNumber, undefined, "fleet-scoped: no single PR to name");
  assert.equal(model.needsMe.mergeHeld[0].by, "craig");
  assert.match(renderStatusBoardText(model), /merge held.*the whole fleet/);
});
