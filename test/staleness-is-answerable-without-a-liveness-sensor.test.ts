import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, type ServiceName, type StatusBoardDeps } from "../src/lib/status-board.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T3241: `head vs origin/main` was gated on `daemonRow.running`, and `running` reads false
// whenever `livenessState` cannot even ASK the question — `sensed === false`, the state EVERY read
// on a host with no launchd sensor produces (MEASURED 2026-09-09: a boot sha and an origin/main sha
// both in hand, row still `unknown`). This suite proves the fix in exactly the shape the falsifier
// demands: an UNSENSED daemon now compares; a POSITIVELY STOPPED one still reads `unknown` (the
// POSITIVE CONTROL that distinguishes this fix from deleting the gate); and a genuinely unresolvable
// sha still reads `unknown` (the SECOND CONTROL against fabricating a verdict from missing data).

const NOW_ISO = "2026-08-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}status-board-`));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function writeBootRecord(headSha: string): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}status-board-ledger-`)), "ledger.ndjson");
  writeFileSync(
    ledgerPath,
    JSON.stringify({ run_id: "R1", task_id: "daemon", ts: NOW_ISO, step: "daemon.boot", head_sha: headSha }) + "\n",
  );
  return ledgerPath;
}

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

const HEAD_SHA = "d".repeat(40);
const ORIGIN_SHA = "e".repeat(40);

/** `queryService` for a daemon the sensor could not even ask about — `sensed: false`, `running: false`
 *  (the only value an unasked sensor can honestly report), exactly W1-T2450's "unasked" shape. */
function unsensedDaemon(): StatusBoardDeps["queryService"] {
  return (service: ServiceName) => (service === "daemon" ? { running: false, pid: null, sensed: false } : { running: false, pid: null });
}

/** `queryService` for a daemon the sensor DID ask about and reported down — `sensed: true` (or
 *  omitted, which defaults to `true`), `running: false`. */
function positivelyStoppedDaemon(): StatusBoardDeps["queryService"] {
  return (service: ServiceName) => (service === "daemon" ? { running: false, pid: null, sensed: true } : { running: false, pid: null });
}

// ── ACCEPTANCE 1: unsensed daemon, both shas resolvable ⇒ a real verdict, not `unknown` ────────

test("buildStatusBoard: head vs origin/main — an UNSENSED daemon (no launchd sensor on this host) still compares boot sha vs origin/main, reading STALE when they differ", () => {
  const ledgerPath = writeBootRecord(HEAD_SHA);
  const model = buildStatusBoard(
    tmpRoot(),
    ledgerPath,
    baseDeps({ queryService: unsensedDaemon(), resolveOriginMainSha: () => ORIGIN_SHA }),
  );

  assert.deepEqual(model.liveness.headVsOriginMain, { status: "stale", headSha: HEAD_SHA, originSha: ORIGIN_SHA });
});

test("buildStatusBoard: head vs origin/main — an UNSENSED daemon reads FRESH when its boot sha matches origin/main", () => {
  const ledgerPath = writeBootRecord(HEAD_SHA);
  const model = buildStatusBoard(
    tmpRoot(),
    ledgerPath,
    baseDeps({ queryService: unsensedDaemon(), resolveOriginMainSha: () => HEAD_SHA }),
  );

  assert.deepEqual(model.liveness.headVsOriginMain, { status: "fresh" });
});

// ── ACCEPTANCE 2 (POSITIVE CONTROL): a daemon POSITIVELY OBSERVED stopped still reads unknown —
// this is what distinguishes the fix from simply deleting the gate ─────────────────────────────

test("buildStatusBoard: head vs origin/main — a daemon POSITIVELY OBSERVED stopped (sensor answered, running: false) still reads unknown, never a verdict from a dead process's boot sha", () => {
  const ledgerPath = writeBootRecord(HEAD_SHA);
  const model = buildStatusBoard(
    tmpRoot(),
    ledgerPath,
    baseDeps({ queryService: positivelyStoppedDaemon(), resolveOriginMainSha: () => ORIGIN_SHA }),
  );

  assert.deepEqual(model.liveness.headVsOriginMain, { status: "unknown" });
});

test("buildStatusBoard: head vs origin/main — the default (no sensed override, matching pre-W1-T2450 callers) still means 'sensor answered, not running' ⇒ unknown", () => {
  const ledgerPath = writeBootRecord(HEAD_SHA);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ resolveOriginMainSha: () => ORIGIN_SHA }));

  assert.deepEqual(model.liveness.headVsOriginMain, { status: "unknown" });
});

// ── ACCEPTANCE 3 (SECOND CONTROL): either sha unresolvable ⇒ still unknown, even when unsensed —
// the fix must never fabricate a verdict from missing data ─────────────────────────────────────

test("buildStatusBoard: head vs origin/main — an UNSENSED daemon with an unresolvable origin/main sha still reads unknown", () => {
  const ledgerPath = writeBootRecord(HEAD_SHA);
  const model = buildStatusBoard(
    tmpRoot(),
    ledgerPath,
    baseDeps({ queryService: unsensedDaemon(), resolveOriginMainSha: () => undefined }),
  );

  assert.deepEqual(model.liveness.headVsOriginMain, { status: "unknown" });
});

test("buildStatusBoard: head vs origin/main — an UNSENSED daemon with no daemon.boot line ever recorded (no headSha) still reads unknown", () => {
  const model = buildStatusBoard(
    tmpRoot(),
    join(tmpdir(), "does-not-exist.ndjson"),
    baseDeps({ queryService: unsensedDaemon(), resolveOriginMainSha: () => ORIGIN_SHA }),
  );

  assert.deepEqual(model.liveness.headVsOriginMain, { status: "unknown" });
});
