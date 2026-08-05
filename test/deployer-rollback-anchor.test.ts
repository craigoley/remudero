// test/deployer-rollback-anchor.test.ts
//
// THE DEFECT (observed live 2026-08-05, not hypothesised). `runDeployCycle`'s rollback reset the
// checkout to `deps.installHead()` — read at the top of the same cycle — and called that the
// "known-good HEAD". It is not known-good; it is whatever the checkout currently points at, and the
// checkout has a SECOND WRITER that logs nothing: `checkCliFreshness` (lib/self-sync.ts)
// fast-forwards the install to origin/main at the entry of nearly every `rmd` subcommand. When a
// head that cannot boot merges, any unrelated `rmd` invocation pulls it into the install before the
// deploy cycle runs — so `fromHead` IS the broken head and the rollback restores the failure.
//
// Measured cost: seven consecutive `deploy.unhealthy_rollback` rows, every one recording
// `rolling_back_to == failed == a8e11cb`, the daemon logging no `daemon.boot` for 53 minutes, and
// recovery only when an unrelated fix commit merged. Across 130 successful deploys in that
// supervisor's life the rollback path had never run once — it went 0-for-7 the first time it was
// needed. Wired and never exercised reads exactly like health.
//
// WHAT IS REAL HERE AND WHAT IS NOT — stated plainly, because a test that only drives a seam proves
// nothing about a path production has never taken:
//   REAL: `readLastGoodBootSha` parsing an on-disk ledger file written in the ledger's own NDJSON
//         shape, and `runDeployCycle`'s real rollback-target selection. Test 1 wires
//         `lastGoodBootSha` to the REAL reader closed over a REAL temp file — not a stub returning
//         a canned sha — so the parse, the `excludeSha` guard and the decision all execute.
//   FAKED: only the side-effect layer (`resetHard`/`kickstart`/`alert`/`log`) and the health verdict.
//         Those are the things being ASSERTED ON, and running real launchctl/git in a unit test is
//         not available to us.
//   UNPROVEN BY THIS FILE: `realDeployDeps`'s one-line wiring of `lastGoodBootSha` (it constructs
//         real git/launchctl closures and cannot run under `node --test`). Its body is the same
//         `readLastGoodBootSha(o.ledgerPath, …)` call this file drives directly.
//
// The shas below are the REAL ones from the incident, so the fixture is the incident.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLastGoodBootSha, runDeployCycle } from "../src/lib/deployer.js";
import type { DeployDeps, HealthInputs } from "../src/lib/deployer.js";

/** #1315 — merged, could not boot (a duplicate task id made the plan unreadable). */
const BROKEN = "a8e11cb6694e5250b592e57ca9bbf1a93b0d72c4";
/** #1314 — the last head the daemon actually booted on, at 01:02:07Z. */
const GOOD = "fb7b3d5c084157556f8f7aff15d1b1b77e1fc568";

/** One ledger file in a temp dir, written in the real NDJSON shape `log()` emits. Returns its path
 *  plus a `cleanup`; `boots` are written oldest-first, exactly as an append-only ledger holds them. */
function writeLedger(boots: Array<{ ts: string; head_sha?: string }>, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rollback-anchor-"));
  const path = join(dir, "ledger.ndjson");
  const lines = boots.map((b) =>
    JSON.stringify({ ts: b.ts, run_id: "DAEMON-1", task_id: "DAEMON", step: "daemon.boot", ...(b.head_sha ? { head_sha: b.head_sha } : {}) }),
  );
  writeFileSync(path, [...lines, ...extra].join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Recorded {
  calls: string[];
  resetTo: string[];
  logged: Array<Record<string, unknown>>;
  deps: DeployDeps;
}

/** Deps for ONE cycle. `lastGoodBootSha` is passed through verbatim so a caller can wire the REAL
 *  reader (test 1) or omit it entirely to reproduce pre-fix/unwired behaviour (test 3). */
function makeDeps(o: {
  installHead: string;
  originMain: string;
  runningHead?: string;
  health?: HealthInputs;
  lastGoodBootSha?: (excludeSha: string) => string | undefined;
}): Recorded {
  const calls: string[] = [];
  const resetTo: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const headRef = { value: o.installHead };
  const deps: DeployDeps = {
    log: (step, data) => {
      calls.push(`log:${step}`);
      logged.push({ step, ...(data ?? {}) });
    },
    now: () => 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => headRef.value,
    runningHead: () => o.runningHead ?? headRef.value,
    originMain: () => o.originMain,
    markerPresent: () => false,
    autoMode: () => true,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {
      calls.push("pullFf");
      headRef.value = o.originMain;
    },
    resetHard: (ref) => {
      calls.push(`resetHard:${ref}`);
      resetTo.push(ref);
      headRef.value = ref;
    },
    lastGoodBootSha: o.lastGoodBootSha,
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => o.health ?? { bootObserved: true, crashCount: 0 },
    alert: (m, failed) => calls.push(`alert:${failed}`),
    clearMarker: () => calls.push("clearMarker"),
    kickstartConsole: () => calls.push("kickstartConsole"),
    consolePid: () => 4242,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => calls.push("alertConsoleOnly"),
  };
  return { calls, resetTo, logged, deps };
}

// ── 1. THE FALSIFIER ────────────────────────────────────────────────────────────────────────────
// The incident state, exactly: the install has ALREADY been fast-forwarded onto the broken head by
// an unlogged `checkCliFreshness` pull, so installHead == originMain == BROKEN and the cycle
// triggers on `runningStale` (the running daemon still reports the GOOD sha it booted on) rather
// than on `behind`. That is why the real `deploy.pulled` row read `from=a8e11cb to=a8e11cb`.
// Pre-fix this reset to BROKEN — a no-op that relaunched the daemon onto the same unbootable tree.
test("rollback targets the last BOOTED sha, not the install head that was already advanced to the broken one", () => {
  const led = writeLedger([
    { ts: "2026-08-05T00:59:16.414Z", head_sha: "a2626853f8223cbfec3821ad1ffd397ad4bddf3e" },
    { ts: "2026-08-05T01:02:07.204Z", head_sha: GOOD },
  ]);
  try {
    const r = makeDeps({
      installHead: BROKEN,
      originMain: BROKEN,
      runningHead: GOOD,
      health: { bootObserved: false, crashCount: 0 },
      // THE REAL READER, over the REAL file — not a stub.
      lastGoodBootSha: (excludeSha) => readLastGoodBootSha(led.path, excludeSha),
    });

    const out = runDeployCycle(r.deps);

    assert.equal(out.deployed, false);
    assert.equal(r.resetTo.length, 1, "exactly one resetHard");
    assert.equal(r.resetTo[0], GOOD, "must restore the sha the daemon actually booted on");
    assert.notEqual(r.resetTo[0], BROKEN, "must NOT restore the head that just failed to boot");
    assert.equal(out.rolledBackTo, GOOD);

    const row = r.logged.find((l) => l.step === "deploy.unhealthy_rollback");
    assert.ok(row, "a rollback row is still written");
    assert.notEqual(row.rolling_back_to, row.failed, "the row must no longer say it rolled back to what failed");
    assert.equal(row.anchor, "booted", "the row states the target came from observed evidence");
  } finally {
    led.cleanup();
  }
});

// ── 2. THE ROLLBACK STILL FIRES (second trap: one that never fires is not a fix) ─────────────────
test("an ordinary behind-origin deploy that fails health still rolls back, and to the booted sha", () => {
  const led = writeLedger([{ ts: "2026-08-05T01:02:07.204Z", head_sha: GOOD }]);
  try {
    const r = makeDeps({
      installHead: GOOD,
      originMain: BROKEN,
      runningHead: GOOD,
      health: { bootObserved: false, crashCount: 0 },
      lastGoodBootSha: (excludeSha) => readLastGoodBootSha(led.path, excludeSha),
    });

    const out = runDeployCycle(r.deps);

    assert.ok(r.calls.includes("pullFf"), "it really deployed first");
    assert.equal(out.deployed, false, "unhealthy ⇒ not deployed");
    assert.equal(r.resetTo[0], GOOD, "rolled back to the booted sha");
    assert.ok(r.calls.filter((c) => c === "kickstart").length >= 2, "kickstarted for the deploy and again for the rollback");
  } finally {
    led.cleanup();
  }
});

// ── 3. FALLBACK — never worse than the old behaviour ─────────────────────────────────────────────
test("with no booted sha available the rollback falls back to the install head, exactly as before", () => {
  // No `lastGoodBootSha` wired at all — the unwired/absent-ledger case.
  const r = makeDeps({
    installHead: GOOD,
    originMain: BROKEN,
    runningHead: GOOD,
    health: { bootObserved: false, crashCount: 0 },
  });

  const out = runDeployCycle(r.deps);

  assert.equal(r.resetTo[0], GOOD, "falls back to fromHead — the pre-fix behaviour");
  assert.equal(out.rolledBackTo, GOOD);
  const row = r.logged.find((l) => l.step === "deploy.unhealthy_rollback");
  assert.equal(row?.anchor, "install-head", "the row admits the target was NOT evidence-backed");
});

test("a ledger whose only boot line IS the failed head falls back rather than restoring it", () => {
  // The daemon started on the bad sha, logged its boot, then died. The naive "latest boot" answer
  // would be the failed head itself; `excludeSha` must reject it.
  const led = writeLedger([{ ts: "2026-08-05T01:09:00.000Z", head_sha: BROKEN }]);
  try {
    const r = makeDeps({
      installHead: BROKEN,
      originMain: BROKEN,
      runningHead: GOOD,
      health: { bootObserved: false, crashCount: 0 },
      lastGoodBootSha: (excludeSha) => readLastGoodBootSha(led.path, excludeSha),
    });

    runDeployCycle(r.deps);

    assert.equal(r.resetTo[0], BROKEN, "degrades to fromHead — no better target exists");
    const row = r.logged.find((l) => l.step === "deploy.unhealthy_rollback");
    assert.equal(row?.anchor, "install-head");
  } finally {
    led.cleanup();
  }
});

// ── 4. THE HEALTHY PATH IS UNTOUCHED (the capped/normal set) ─────────────────────────────────────
test("a healthy deploy still deploys and never resets — the rollback path is not widened", () => {
  const led = writeLedger([{ ts: "2026-08-05T01:02:07.204Z", head_sha: GOOD }]);
  try {
    const r = makeDeps({
      installHead: GOOD,
      originMain: BROKEN,
      runningHead: GOOD,
      health: { bootObserved: true, crashCount: 0 },
      lastGoodBootSha: (excludeSha) => readLastGoodBootSha(led.path, excludeSha),
    });

    const out = runDeployCycle(r.deps);

    assert.equal(out.deployed, true);
    assert.equal(r.resetTo.length, 0, "a healthy deploy must never roll back");
    assert.ok(!r.calls.some((c) => c.startsWith("resetHard")));
    assert.ok(r.calls.includes("log:deploy.ok"));
  } finally {
    led.cleanup();
  }
});

// ── 5. THE READER ITSELF, against a real file ────────────────────────────────────────────────────
test("readLastGoodBootSha picks the newest qualifying boot sha and honours excludeSha", () => {
  const led = writeLedger(
    [
      { ts: "2026-08-05T00:59:16.414Z", head_sha: "a2626853f8223cbfec3821ad1ffd397ad4bddf3e" },
      { ts: "2026-08-05T01:02:07.204Z", head_sha: GOOD },
      { ts: "2026-08-05T01:09:00.000Z", head_sha: BROKEN },
    ],
    // Noise the scan must ignore: a different step that also carries a head_sha.
    [JSON.stringify({ ts: "2026-08-05T01:10:00.000Z", step: "deploy.pulled", head_sha: "ffffffffffffffffffffffffffffffffffffffff" })],
  );
  try {
    assert.equal(readLastGoodBootSha(led.path), BROKEN, "newest boot sha when nothing is excluded");
    assert.equal(readLastGoodBootSha(led.path, BROKEN), GOOD, "excluding the failed head yields the one before it");
    // Prefix-tolerant, because the ledger's own rows and `short()` both truncate.
    assert.equal(readLastGoodBootSha(led.path, BROKEN.slice(0, 9)), GOOD, "a short excludeSha still matches");
  } finally {
    led.cleanup();
  }
});

test("readLastGoodBootSha returns undefined for a missing ledger and for boot lines with no head_sha", () => {
  assert.equal(readLastGoodBootSha(join(tmpdir(), "rmd-no-such-ledger-xyzzy", "ledger.ndjson")), undefined);
  const led = writeLedger([{ ts: "2026-08-05T01:02:07.204Z" }]); // pre-`head_sha` boot line
  try {
    assert.equal(readLastGoodBootSha(led.path), undefined, "a boot line without head_sha yields nothing");
  } finally {
    led.cleanup();
  }
});
