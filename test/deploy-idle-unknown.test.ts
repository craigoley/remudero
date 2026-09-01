import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  daemonIsIdle,
  lockReadFailureMeansZero,
  pgrepFailureMeansZero,
  realDeployDeps,
  type IdleProbe,
} from "../src/lib/deployer.js";

/**
 * `probeIdle` DEGRADED A READ FAILURE TO ZERO — THREE TIMES IN ONE FUNCTION. The `pgrep` catch and
 * BOTH `countLocks` catches, every one failing toward zero, and zero on all three is exactly what
 * `daemonIsIdle` calls quiet. Quiet is the gate that lets a deploy kickstart the daemon. So a probe
 * that could not SEE the daemon could report that the daemon was not busy.
 *
 * THIS REPO'S OWN LAW, from `buildShellRoute`: "A read failure degrades to UNKNOWN, never to zero."
 * Three recons named this and none closed it, because each found it while looking at something
 * else.
 *
 * THE EXPOSURE WAS BOUNDED, AND THAT IS WHY THE FIX IS SMALL. `daemonIsIdle` ANDs its three
 * signals, so no single failed read could produce an idle verdict on its own — a broken `pgrep`
 * removed ONE OF THREE guards rather than opening the gate. That matters most for a worker with no
 * inflight lock (a review or probe spawn), where `workers` is the only signal that sees it.
 *
 * WHAT A TRUE ZERO LOOKS LIKE, since the fix turns on telling it from a failure:
 *   - `pgrep` exit 1 is DOCUMENTED as no-processes-matched. A true zero.
 *   - `readdirSync` ENOENT means the lock directory has never been created. A true zero.
 *   - Everything else — pgrep absent (127/ENOENT, the state this image shipped in until ps/pgrep
 *     were added), pgrep fatal (2/3), EACCES/ENOTDIR/EIO on a lock dir — is a read that produced
 *     no answer.
 */

// ── THE DISCRIMINATORS, both directions each ─────────────────────────────────────────────────

test("pgrepFailureMeansZero: ONLY a documented exit 1 is a true zero", () => {
  assert.equal(pgrepFailureMeansZero(Object.assign(new Error("no match"), { status: 1 })), true);
  // The states the old bare `catch` swallowed into zero workers.
  assert.equal(pgrepFailureMeansZero(Object.assign(new Error("not found"), { status: 127 })), false, "pgrep absent");
  assert.equal(pgrepFailureMeansZero(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })), false, "no binary");
  assert.equal(pgrepFailureMeansZero(Object.assign(new Error("syntax"), { status: 2 })), false, "pgrep usage error");
  assert.equal(pgrepFailureMeansZero(Object.assign(new Error("fatal"), { status: 3 })), false, "pgrep fatal");
  assert.equal(pgrepFailureMeansZero(new Error("exit 1: no matches")), false, "a MESSAGE saying exit 1 is not a status");
  assert.equal(pgrepFailureMeansZero(undefined), false);
});

test("lockReadFailureMeansZero: ONLY an absent directory is a true zero", () => {
  assert.equal(lockReadFailureMeansZero(Object.assign(new Error("no dir"), { code: "ENOENT" })), true);
  for (const code of ["EACCES", "ENOTDIR", "EIO", "EMFILE"]) {
    assert.equal(
      lockReadFailureMeansZero(Object.assign(new Error(code), { code })),
      false,
      `${code}: the directory may be full of locks nobody could count`,
    );
  }
  assert.equal(lockReadFailureMeansZero(new Error("boom")), false);
});

// ── THE GATE: unknown is not idle, and idle is still idle ────────────────────────────────────

test("daemonIsIdle: a genuinely quiet fleet still reads IDLE, byte-identically to before", () => {
  // THE HALF A ONE-SIDED FIX WOULD BREAK. Making every unreadable probe read busy is easy; making
  // it read busy WITHOUT blocking every deploy is the actual requirement.
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }), true, "no `unreadable` key at all");
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 0, worktreeLocks: 0, unreadable: [] }), true, "empty list");
});

test("daemonIsIdle: ANY unreadable signal refuses to call the fleet quiet, one signal at a time", () => {
  for (const signal of ["workers", "inflightLocks", "worktreeLocks"]) {
    const probe: IdleProbe = { workers: 0, inflightLocks: 0, worktreeLocks: 0, unreadable: [signal] };
    assert.equal(daemonIsIdle(probe), false, `${signal} unread must not read as quiet`);
  }
});

test("daemonIsIdle: the three counts are ANDed, so the pre-existing guards are untouched", () => {
  // Re-derived here rather than assumed: it is the reason a single failed read could not open the
  // gate on its own, and therefore the reason this fix is narrow.
  assert.equal(daemonIsIdle({ workers: 1, inflightLocks: 0, worktreeLocks: 0 }), false);
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 1, worktreeLocks: 0 }), false);
  assert.equal(daemonIsIdle({ workers: 0, inflightLocks: 0, worktreeLocks: 1 }), false);
});

// ── THE REAL probeIdle, driven into each catch arm ───────────────────────────────────────────

function deps(root: string, execFile: (cmd: string, args: string[]) => string) {
  return realDeployDeps({
    installPath: "/inst",
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 502,
    ledgerPath: join(root, "ledger.ndjson"),
    log: () => {},
    execFile,
    sleep: () => {},
  });
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "probe-idle-unknown-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  }
}

const throwing = (e: unknown) => (): string => {
  throw e;
};

test("REAL probeIdle: pgrep exit 1 with both lock dirs absent is a TRUE all-zero — nothing unreadable", () => {
  withRoot((root) => {
    // PRECONDITION: neither lock directory exists, so both `countLocks` reads take their ENOENT
    // arm. Without this the test would be grading the success path and prove nothing.
    const p = deps(root, throwing(Object.assign(new Error("no match"), { status: 1 }))).probeIdle();
    assert.deepEqual(p, { workers: 0, inflightLocks: 0, worktreeLocks: 0, unreadable: [] });
    assert.equal(daemonIsIdle(p), true, "an empty machine is still deployable — this is the direction a fix can break");
  });
});

test("REAL probeIdle: the worker process selector covers both Claude and Codex", () => {
  withRoot((root) => {
    let seen: { cmd: string; args: string[] } | undefined;
    const p = deps(root, (cmd, args) => {
      seen = { cmd, args };
      return "41\n42\n";
    }).probeIdle();

    assert.equal(p.workers, 2);
    assert.equal(seen?.cmd, "pgrep");
    assert.equal(seen?.args[0], "-f");
    assert.match(seen?.args[1] ?? "", /claude --output-format/);
    assert.match(seen?.args[1] ?? "", /codex exec/);
  });
});

test("REAL probeIdle: a pgrep that CANNOT RUN names `workers` unreadable instead of reporting zero", () => {
  withRoot((root) => {
    const p = deps(root, throwing(Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" }))).probeIdle();
    assert.equal(p.workers, 0, "the count is still zero — it has to be something");
    assert.deepEqual([...(p.unreadable ?? [])], ["workers"], "but the ledger now says the count was never obtained");
    assert.equal(daemonIsIdle(p), false, "and it cannot be mistaken for a quiet fleet");
  });
});

test("REAL probeIdle: an UNREADABLE lock path names itself, while an absent one stays a true zero", () => {
  withRoot((root) => {
    // ENOTDIR, NOT A CHMOD. Reaching the non-ENOENT arm needs a path that EXISTS and cannot be
    // listed; mode 000 does not achieve that as root (this container runs as uid 0), so the first
    // draft of this test SKIPPED here and proved nothing. A regular FILE where a directory is
    // expected throws ENOTDIR for every user, which reaches the same arm deterministically.
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "inflight"), "not a directory");

    // PRECONDITION, asserted rather than assumed: this really is the non-ENOENT arm.
    let code: unknown;
    try {
      readdirSync(join(root, "state", "inflight"));
    } catch (e) {
      code = (e as { code?: unknown }).code;
    }
    assert.equal(code, "ENOTDIR", "the fixture must reach the arm it claims — ENOENT would prove the opposite");
    assert.equal(lockReadFailureMeansZero({ code }), false, "and ENOTDIR must not be treated as a true zero");

    const p = deps(root, throwing(Object.assign(new Error("no match"), { status: 1 }))).probeIdle();
    assert.deepEqual([...(p.unreadable ?? [])], ["inflightLocks"], "the unreadable one names itself…");
    assert.equal(p.worktreeLocks, 0, "…and the ABSENT worktrees dir is still a true zero, not a second complaint");
    assert.equal(daemonIsIdle(p), false, "one unread signal is enough to refuse the quiet verdict");
  });
});
