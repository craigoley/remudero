/**
 * W1-T1067: `docker restart` STRANDS `state/drain.lock`, AND THE CONTAINER-AWARE RECLAMATION
 * (W1-T978) CANNOT REACH IT.
 *
 * MEASURED on the live container (2026-08-20): `docker restart` REUSES the container, so
 * `hostname()` and the recorded lock's `host` are UNCHANGED across the restart — the exact
 * `held.host !== myHost` mismatch W1-T978's rung 1 needs to fire never happens, and rung 1 falls
 * through to the ordinary same-host pid/start-time rungs instead. Separately, the restart throttle
 * (`RMD_RESTART_THROTTLE_S=120` in production) takes `deploy/entrypoint.sh` off its `exec "$@"`
 * path: bash stays alive as tini's own child, supervising node rather than being replaced by it,
 * and — with zero `trap`s in the script before this task — forwards nothing. tini SIGTERMs bash;
 * node never sees it; `run-task.ts`'s own SIGTERM handler (which already calls
 * `drainLock.release()` correctly) never runs; node is SIGKILLed once the grace period expires;
 * the lock survives, and the next boot refuses to start behind it.
 *
 * TWO INDEPENDENT FIXES, per the shard's own design (i)-(iii):
 *   1. `deploy/entrypoint.sh` now traps TERM/INT and forwards them to the backgrounded child,
 *      restoring the delivery `exec` gave for free — the COMMON path, tested here end to end
 *      against the real script (a real git origin, no mocked bash).
 *   2. `isHolderStale` (src/lib/fs-race-safe.ts) gained a BOOT-TIME rung: a lock whose
 *      `startedAt` predates this container's own boot (PID 1's start time) is dead by
 *      construction, whatever pid it names — the FLOOR under the signal fix, for SIGKILL, OOM,
 *      and host power loss, none of which a shutdown handler can ever see.
 *
 * A reclaim through either path must still be PRINTED before it is cleared (design (v)): the
 * lock file is the only record of what was judged, and removing it unrecorded is exactly the
 * "judged silently" this shard forbids.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isHolderStale, reclaimStaleLock } from "../src/lib/fs-race-safe.js";
import { acquireDrainLock, parseDrainLockInfo } from "../src/lib/drain-lock.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(REPO_ROOT, "deploy", "entrypoint.sh");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── acceptance 1/2/5: the BOOT-TIME rung, tested directly against isHolderStale ────────────
//
// `getProcessStartTime` is injected to distinguish `pid === 1` (the boot-time probe this rung
// reuses, per design (iii): "the SAME `ps` route `defaultGetProcessStartTime` already uses") from
// a probe of the RECORDED holder's own pid — several fixtures make the latter THROW, proving the
// boot rung decides before rungs 2/3 ever consult the pid table at all, exactly the FALSIFIER
// shape the sibling suites (stale-lock-host-ordering.test.ts, W1-T978) already use.

test("drain lock: a lock older than this boot is reclaimed whatever pid it names", () => {
  const bootTime = Date.parse("2026-08-20T12:00:00.000Z");
  // MEASURED shape: pid 52, a lock written well before this boot — the exact incident.
  const held = { pid: 52, host: "same-host", startedAt: "2026-08-20T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    hostname: () => "same-host",
    isPidAlive: () => {
      throw new Error("must not be called — a lock older than this boot is dead by construction, whatever pid it names");
    },
    getProcessStartTime: (pid) => {
      if (pid !== 1) {
        throw new Error("must not probe the recorded holder's own pid — the boot rung decides before rungs 2/3 run");
      }
      return bootTime;
    },
  });
  assert.equal(stale, true, "a lock that predates this container's own boot must be reclaimed without consulting the pid table");
});

test("drain lock: a lock newer than this boot is left alone", () => {
  const bootTime = Date.parse("2026-08-20T00:00:00.000Z"); // this boot started BEFORE the lock
  const held = { pid: 4242, host: "same-host", startedAt: "2026-08-20T12:00:00.000Z" };
  const stale = isHolderStale(held, {
    hostname: () => "same-host",
    isPidAlive: () => true,
    getProcessStartTime: (pid) =>
      // pid 1: this boot, well before the lock. held.pid: the genuine holder, started just before
      // it wrote its own lock — the ordinary "still live" reading rungs 2/3 already give it.
      pid === 1 ? bootTime : Date.parse(held.startedAt) - 1000,
  });
  assert.equal(stale, false, "a concurrent daemon that started AFTER this boot must never be swept by the boot rung");
});

test("drain lock: a same-container restart is not treated as a foreign host", () => {
  // MEASURED shape: `docker restart` reuses the container, so `hostname()` and the container id
  // W1-T978's rung 1 compares are UNCHANGED — never a mismatch. `inContainer` is wired to throw so
  // this test proves rung 1's mismatch branch (the only place that opt is ever read) is NOT what
  // reclaims this lock; the boot rung, reached only on the FALL-THROUGH from a host MATCH, is.
  const CONTAINER_ID = "83d9093a0c6c"; // MEASURED on the live container, 2026-08-20
  const bootTime = Date.parse("2026-08-20T01:00:00.000Z"); // this boot started AFTER the lock
  const held = { pid: 52, host: CONTAINER_ID, startedAt: "2026-08-20T00:00:00.000Z" };
  const stale = isHolderStale(held, {
    hostname: () => CONTAINER_ID, // SAME id as the lock — a restart, never a foreign container
    inContainer: () => {
      throw new Error("must not be called — a host MATCH never reaches rung 1's mismatch/container branch at all");
    },
    isPidAlive: () => true, // pid 52 coincidentally alive in the new boot's own namespace
    getProcessStartTime: (pid) => {
      if (pid !== 1) {
        throw new Error("must not probe the recorded holder's own pid — the boot rung decides first");
      }
      return bootTime;
    },
  });
  assert.equal(stale, true, "a same-container restart must be reclaimed via the boot rung, not folded into the foreign-host case");
});

// ── acceptance 4: PRINT BEFORE CLEAR (design (v)) ───────────────────────────────────────────

test("drain lock: a reclaimed lock is printed before it is removed", () => {
  const dir = tmp("rmd-drain-reclaim-print-");
  const lockPath = join(dir, "state", "drain.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  const raw = JSON.stringify({ pid: 999_990, host: "same-host", startedAt: "2026-08-01T00:00:00.000Z" });
  writeFileSync(lockPath, raw);

  const printedWhileStillOnDisk: string[] = [];
  const result = reclaimStaleLock(lockPath, {
    parseHolder: parseDrainLockInfo,
    isStale: () => true,
    onReclaim: ({ lockPath: p, raw: r }) => {
      // THE ORDERING PROOF: the file must still exist AT THE MOMENT this fires, never after.
      assert.equal(existsSync(p), true, "onReclaim must run BEFORE the unlink, while the lock is still on disk");
      printedWhileStillOnDisk.push(r);
    },
  });

  assert.equal(result.outcome, "reclaimed");
  assert.deepEqual(printedWhileStillOnDisk, [raw], "the FULL lock contents must be printed, never merely a notice that something happened");
  assert.equal(existsSync(lockPath), false, "and the lock is genuinely gone once the call returns");
});

test("acquireDrainLock: with no onReclaim override, a reclaim still prints (via the default console.error), never silently", () => {
  const dir = tmp("rmd-drain-reclaim-default-print-");
  const lockPath = join(dir, "state", "drain.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  const staleRaw = JSON.stringify({ pid: 999_991, host: hostname(), startedAt: "2026-08-01T00:00:00.000Z" });
  writeFileSync(lockPath, staleRaw);

  const realError = console.error;
  const logs: string[] = [];
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const handle = acquireDrainLock(lockPath, { isPidAlive: () => false });
    handle.release();
  } finally {
    console.error = realError;
  }
  assert.ok(
    logs.some((l) => l.includes(lockPath) && l.includes("999991")),
    `the default onReclaim must trace the lock's path and pid to console.error before clearing it; got ${JSON.stringify(logs)}`,
  );
});

// ── acceptance 3: the shutdown signal reaches the SUPERVISED daemon ────────────────────────
//
// REAL bash, REAL git — the same approach test/entrypoint-boot.test.ts already takes, so this
// runs deploy/entrypoint.sh exactly as production does, not a description of it. The daemon
// stand-in traps TERM itself and reports back through a marker file, so this proves DELIVERY —
// that the signal reaches the supervised child at all — not any particular node-side behaviour
// (run-task.ts's own SIGTERM handler is exercised elsewhere).

function makeOrigin(): string {
  const origin = tmp("rmd-signal-origin-");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
  writeFileSync(join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  spawnSync("git", ["add", "-A"], { cwd: origin });
  spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "c1"], {
    cwd: origin,
  });
  return origin;
}

function writeNpmStub(dir: string): void {
  writeFileSync(join(dir, "npm"), "#!/usr/bin/env bash\nif [ \"$1\" = \"ci\" ]; then mkdir -p node_modules/.bin; printf '#!/bin/sh\\n' > node_modules/.bin/tsx; chmod 0755 node_modules/.bin/tsx; fi\nexit 0\n", {
    mode: 0o755,
  });
  chmodSync(join(dir, "npm"), 0o755);
}

test("drain lock: the shutdown signal reaches the supervised daemon", async () => {
  const home = tmp("rmd-signal-home-");
  const origin = makeOrigin();
  const stubs = tmp("rmd-signal-stub-");
  const rec = tmp("rmd-signal-rec-");
  writeNpmStub(stubs);

  // A daemon stand-in that traps TERM itself, reports receipt through a marker file, and exits 0
  // — the shape a real `run-task.ts` SIGTERM handler takes after `drainLock.release()`. Backgrounds
  // its own `sleep` and `wait`s on it so ITS OWN trap fires immediately, the same reason the
  // entrypoint's own fix backgrounds "$@" rather than running it in the foreground.
  const fakeDaemon = join(stubs, "rmd-fake-daemon");
  writeFileSync(
    fakeDaemon,
    [
      "#!/usr/bin/env bash",
      `touch "${rec}/started"`,
      `trap 'touch "${rec}/got-sigterm"; exit 0' TERM`,
      "sleep 100 &",
      "wait $!",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  chmodSync(fakeDaemon, 0o755);

  const child = spawn("bash", [ENTRYPOINT, fakeDaemon, "daemon"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      HOME: home,
      RMD_REPO_URL: origin,
      RMD_REF: "main",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // Long enough that a naive re-pass (no forwarding at all) would still be asleep in the
      // crash throttle when this test's own timeout fires — so a regression FAILS instead of
      // merely running slow.
      RMD_RESTART_THROTTLE_S: "60",
    },
  });

  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });

  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.on("exit", (code) => resolve({ code }));
  });

  // Poll for the daemon stand-in to actually be running before signalling it — sending TERM
  // before it installed its own trap would prove nothing about forwarding.
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(rec, "started"))) {
    if (Date.now() > deadline) {
      throw new Error(`the daemon stand-in never started: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const sentAt = Date.now();
  child.kill("SIGTERM"); // exactly what tini sends the supervised bash on a docker stop/restart

  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`entrypoint.sh never exited after SIGTERM: ${stderr}`)), 20_000),
    ),
  ]);
  const elapsedMs = Date.now() - sentAt;

  assert.equal(
    existsSync(join(rec, "got-sigterm")),
    true,
    `the daemon stand-in must have received the forwarded TERM: ${stderr}`,
  );
  assert.equal(result.code, 0, `a clean shutdown must propagate as exit 0, not a crash code: ${stderr}`);
  // FAR under the 60s throttle: a regression to "no trap, bash dies, node orphaned" would either
  // hang (nothing left to wait on cleanly) or fall through to the crash-throttle sleep — either
  // way nowhere near this bound.
  assert.ok(elapsedMs < 10_000, `must exit promptly on a forwarded, handled signal, took ${elapsedMs}ms`);
});
