// test/daemon-liveness-taxonomy.test.ts — recon-blackout rec-2.
//
// THE DEFECT: THREE STATES RENDERED IDENTICALLY. `daemonLive` was computed as
// `lastPollAgeMs !== undefined && lastPollAgeMs <= livenessBoundMs ? true : undefined` — true or
// undefined, NEVER false — and `readLedgerLines` returns an empty array for a missing file rather
// than throwing. So a DEAD daemon (ledger present, heartbeat stale), an ABSENT ledger, and a
// ledger whose read THREW all reached the console as the same non-answer. The console could
// decline to say the fleet was alive; it could never say it was dead, and never say why.
//
// WHAT IS REAL HERE. `deriveDaemonLiveness` is the production function, called directly. The
// route half stands up a REAL http server through `buildServeServer` — the production assembler —
// against REAL ledger files on disk, and deliberately supplies NO `controlStatus` dep, so the
// reader under test is the production `readLedgerLines` default and not an injected seam. That
// distinction is the whole point: the `present` flag this fix reads is attached by the real
// reader, and a test driving a fake would prove nothing about it.
//
// THE UNREADABLE FIXTURE IS A DIRECTORY, NOT A CHMOD. `chmod 000` does not make a file unreadable
// to uid 0, so a permissions-based fixture silently degrades to the readable case under root (a
// container, a CI image, a root shell) — three suites in this repo already fail that way. A path
// that exists and is a directory throws EISDIR on `readFileSync` for every uid on both macOS and
// Linux, so the arrange is real wherever this runs.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { deriveDaemonLiveness, type IssueCloser } from "../src/lib/panel-actions.js";
import { readLedgerLines, DEFAULT_LIVENESS_BOUND_MS, type GitHub } from "../src/lib/status.js";
import type { Plan } from "../src/lib/plan.js";
import type { TraceGithub } from "../src/lib/trace.js";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const READ_TOKEN = "liveness-read-token";
const WRITE_TOKEN = "liveness-write-token";

/** A `daemon.*` line `agoMs` before {@link NOW}. `daemon.idle` is one of the several steps
 *  `deriveLastPoll` folds in via the prefix — no single step fires every tick. */
function daemonLine(agoMs: number, step = "daemon.idle"): Record<string, unknown> {
  return { ts: new Date(NOW - agoMs).toISOString(), step, tick: 1 };
}

/** A line that is NOT a heartbeat — real ledger traffic that proves the ledger is being written
 *  while the daemon itself is silent, which is what separates `no-daemon-activity` from
 *  `ledger-empty`. */
function otherLine(agoMs: number): Record<string, unknown> {
  return { ts: new Date(NOW - agoMs).toISOString(), step: "sweep.pass", enumerated: 0 };
}

// ── the taxonomy, over the production function ────────────────────────────────────────────────

test("a heartbeat inside the liveness bound is LIVE, and says which evidence made it so", () => {
  const v = deriveDaemonLiveness([daemonLine(60_000)], NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.deepEqual(v, { live: true, reason: "fresh-poll" });
});

test("a heartbeat aged past the liveness bound is FALSE, not merely unobserved", () => {
  const v = deriveDaemonLiveness([daemonLine(DEFAULT_LIVENESS_BOUND_MS + 60_000)], NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.equal(v.live, false, "a stale heartbeat is positive evidence the daemon stopped");
  assert.equal(v.reason, "last-poll-stale");
});

test("the boundary itself is inclusive, so the bound does not silently move", () => {
  const onBound = deriveDaemonLiveness([daemonLine(DEFAULT_LIVENESS_BOUND_MS)], NOW, DEFAULT_LIVENESS_BOUND_MS);
  const pastBound = deriveDaemonLiveness([daemonLine(DEFAULT_LIVENESS_BOUND_MS + 1)], NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.equal(onBound.live, true);
  assert.equal(pastBound.live, false);
});

test("a populated ledger carrying no heartbeat at all is FALSE — the silence is the evidence", () => {
  const v = deriveDaemonLiveness([otherLine(1000), otherLine(2000)], NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.deepEqual(v, { live: false, reason: "no-daemon-activity" });
});

test("an empty but present ledger is UNKNOWN — a fresh install is not evidence of a dead daemon", () => {
  const v = deriveDaemonLiveness([], NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.equal(v.live, undefined);
  assert.equal(v.reason, "ledger-empty");
});

test("an ABSENT ledger is UNKNOWN with its own reason, never the same answer as a dead daemon", () => {
  const absent = readLedgerLines(join(mkdtempSync(join(tmpdir(), "rmd-liveness-")), "nope.ndjson"));
  const v = deriveDaemonLiveness(absent, NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.equal(v.live, undefined);
  assert.equal(v.reason, "ledger-absent");
  const dead = deriveDaemonLiveness([daemonLine(DEFAULT_LIVENESS_BOUND_MS + 1)], NOW, DEFAULT_LIVENESS_BOUND_MS);
  assert.notEqual(v.reason, dead.reason, "the two states this task exists to separate must not share a reason");
  assert.notEqual(v.live, dead.live, "and they must not share a verdict either");
});

test("an injected reader that reports no presence is read as evidence-based, never as absent", () => {
  // `LedgerReader` is `(path) => Array<...>`, so a fake's result has `present === undefined`. Only
  // an EXPLICIT false may mean absent — otherwise every existing injected-fake test in this repo
  // would start reporting `ledger-absent` for fixtures that are deliberately about the lines.
  const plainArray: Array<Record<string, unknown>> = [daemonLine(60_000)];
  assert.equal((plainArray as { present?: boolean }).present, undefined);
  assert.deepEqual(deriveDaemonLiveness(plainArray, NOW, DEFAULT_LIVENESS_BOUND_MS), { live: true, reason: "fresh-poll" });
  assert.deepEqual(deriveDaemonLiveness([], NOW, DEFAULT_LIVENESS_BOUND_MS), { reason: "ledger-empty" });
});

// ── readLedgerLines' own contract ─────────────────────────────────────────────────────────────

test("readLedgerLines distinguishes an absent ledger from a present empty one, and stays an array", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-liveness-"));
  const missing = readLedgerLines(join(dir, "missing.ndjson"));
  const emptyPath = join(dir, "empty.ndjson");
  writeFileSync(emptyPath, "");
  const empty = readLedgerLines(emptyPath);

  assert.equal(missing.present, false);
  assert.equal(empty.present, true);
  // Both are still plain empty arrays to every one of the ~50 call sites that type them that way,
  // and `present` is non-enumerable for `torn`'s own reason — deepEqual against a literal must
  // keep working or this change would have churned the whole suite.
  assert.deepEqual([...missing], []);
  assert.deepEqual(missing, []);
  assert.deepEqual(empty, []);
  assert.equal(Object.keys(missing).length, 0);
  assert.equal(JSON.stringify(missing), "[]");
});

// ── the route, assembled the production way ───────────────────────────────────────────────────

function fixtureDeps(root: string, ledgerPath: string): ServeDeps {
  const plan: Plan = { tasks: [], byId: new Map() };
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  const trace: TraceGithub = { prView: () => null };
  const issues: IssueCloser = { close() {} };
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: trace, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues,
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    // NO `controlStatus` — that omission is the assertion. buildServeRoutes then resolves the real
    // `readLedgerLines`/`Date.now`/DEFAULT_LIVENESS_BOUND_MS, so this exercises the production
    // default rather than a seam, and `present` is set by the reader that actually ships.
  };
}

async function controlStatus(ledgerPath: string, root: string): Promise<Record<string, unknown>> {
  const server = buildServeServer(fixtureDeps(root, ledgerPath));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/control/status`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A fresh root plus the ledger path the fixture will (or deliberately will not) create. */
function root(): { dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-liveness-route-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  return { dir, ledgerPath: join(dir, "state", "ledger.ndjson") };
}

test("GET /v1/control/status reports LIVE, with the reason, off a real fresh ledger", async () => {
  const { dir, ledgerPath } = root();
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), step: "daemon.idle" })}\n`);
  const body = await controlStatus(ledgerPath, dir);
  assert.equal(body.daemonLive, true);
  assert.equal(body.daemonLiveReason, "fresh-poll");
});

test("GET /v1/control/status reports DOWN off a real ledger whose heartbeat has aged out", async () => {
  const { dir, ledgerPath } = root();
  const stale = new Date(Date.now() - DEFAULT_LIVENESS_BOUND_MS - 60_000).toISOString();
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: stale, step: "daemon.headroom" })}\n`);
  const body = await controlStatus(ledgerPath, dir);
  assert.equal(body.daemonLive, false, "the route must be able to say the daemon is dead");
  assert.equal(body.daemonLiveReason, "last-poll-stale");
});

test("GET /v1/control/status reports UNKNOWN-because-absent when there is no ledger file", async () => {
  const { dir, ledgerPath } = root();
  const body = await controlStatus(ledgerPath, dir);
  assert.equal(body.daemonLive, undefined);
  assert.equal(body.daemonLiveReason, "ledger-absent");
});

test("GET /v1/control/status reports UNKNOWN-because-unreadable instead of 500ing on a read that throws", async () => {
  const { dir, ledgerPath } = root();
  mkdirSync(ledgerPath); // exists, so existsSync passes; readFileSync throws EISDIR for every uid
  const body = await controlStatus(ledgerPath, dir);
  assert.equal(body.daemonLive, undefined);
  assert.equal(body.daemonLiveReason, "ledger-unreadable");
  assert.equal(body.paused, false, "the rest of the panel still renders — one bad read is not a dead route");
});

test("the three formerly-identical states now differ from each other at the route", async () => {
  const dead = root();
  appendFileSync(
    dead.ledgerPath,
    `${JSON.stringify({ ts: new Date(Date.now() - DEFAULT_LIVENESS_BOUND_MS - 60_000).toISOString(), step: "daemon.idle" })}\n`,
  );
  const absent = root();
  const unreadable = root();
  mkdirSync(unreadable.ledgerPath);

  const bodies = await Promise.all([
    controlStatus(dead.ledgerPath, dead.dir),
    controlStatus(absent.ledgerPath, absent.dir),
    controlStatus(unreadable.ledgerPath, unreadable.dir),
  ]);
  const reasons = bodies.map((b) => b.daemonLiveReason);
  assert.deepEqual(reasons, ["last-poll-stale", "ledger-absent", "ledger-unreadable"]);
  assert.equal(new Set(reasons).size, 3, "three states, three answers — the whole point of this task");
});

// ── falsifier ─────────────────────────────────────────────────────────────────────────────────

test("the pre-fix predicate is gone, its replacement is unique, and the two genuinely disagree", () => {
  const src = readFileSync(new URL("../src/lib/panel-actions.ts", import.meta.url), "utf8");

  // The exact expression this task removed, quoted from the merge base. Its RETURN is what made
  // the collapse: `undefined` for every non-fresh case, so dead and absent were one answer.
  const PRE_FIX = "lastPollAgeMs !== undefined && lastPollAgeMs <= livenessBoundMs ? true : undefined";
  assert.equal(
    src.split(PRE_FIX).length - 1,
    0,
    "the pre-fix true-or-undefined expression is back in panel-actions.ts — the collapse has returned",
  );

  // The substitution target, asserted UNIQUE so a falsifier can only mean one line.
  const TARGET = 'if ((lines as { present?: boolean }).present === false) return { reason: "ledger-absent" };';
  assert.equal(src.split(TARGET).length - 1, 1, "the absent-ledger guard must appear exactly once");

  // Reverting that guard is modelled directly rather than by rewriting a module: with the guard
  // removed, an absent ledger falls through to the empty-ledger arm and stops being reportable as
  // absent at all. Running both over the SAME input is what proves the guard carries the meaning.
  const reverted = (lines: ReadonlyArray<Record<string, unknown>>) =>
    lines.length === 0 ? { reason: "ledger-empty" } : { live: false, reason: "no-daemon-activity" };
  const absent = readLedgerLines(join(mkdtempSync(join(tmpdir(), "rmd-liveness-fals-")), "nope.ndjson"));
  assert.equal(deriveDaemonLiveness(absent, NOW, DEFAULT_LIVENESS_BOUND_MS).reason, "ledger-absent");
  assert.equal(reverted(absent).reason, "ledger-empty");
  assert.notEqual(
    deriveDaemonLiveness(absent, NOW, DEFAULT_LIVENESS_BOUND_MS).reason,
    reverted(absent).reason,
    "if these agreed, the guard would be decorative and this suite would pass without it",
  );
});
