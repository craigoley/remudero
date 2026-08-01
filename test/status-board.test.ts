import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, renderStatusBoardText, type ServiceName, type StatusBoardDeps } from "../src/lib/status-board.js";
import { requestDrainNow, requestKick, requestPause, requestStop, setQuietHours } from "../src/lib/fleet-control.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import { deployAutoPath, deployFailedAlertPath } from "../src/lib/deployer.js";
import { statusCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

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
    JSON.stringify({ message: "health-check failed: crash-loop", failedHead: "d".repeat(40), at: seededAt }),
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
