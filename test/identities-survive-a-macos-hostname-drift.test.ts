import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { basename, join } from "node:path";
import { describe, mock, test, type TestContext } from "node:test";
import { approveCommand, claimCommand, classifyReservationAnchor } from "../src/run-task.js";
import {
  decideDispatchClaimRelease, findClaimMintRow, parseClaimAnchorMessage,
  releaseLandedDispatchClaims, staleDispatchClaimEscalations,
  type DispatchClaimReserver, type DispatchClaimReserverAsync,
} from "../src/lib/dispatch-claim.js";
import { isHolderStale } from "../src/lib/fs-race-safe.js";
import { sweepStaleInflightLocks } from "../src/lib/inflight-lock.js";
import { isRotationLockHolderStale, LEDGER_ROTATION_SMOOTHING_WINDOW_MS } from "../src/lib/ledger.js";
import { judgeInflightLocks } from "../src/lib/report-commands.js";
import { acquireTestSlot, TEST_SLOT_PARENT_ENV, testSlotProcessFacts } from "../src/lib/test-slot.js";
import { assessTriageClaimLiveness, TRIAGE_CLAIM_LIVENESS_WINDOW_MS } from "../src/lib/auto-triage.js";
import { reserveHeavyNewBuilds, releaseHeavyNewBuilds } from "../src/lib/heavy-build-reservation.js";
import { fixedClock } from "../src/lib/clock.js";
import { makeTempDir } from "../src/lib/tmp.js";

const TASK = "W1-T9541";
const MINTED = "2026-10-14T19:18:21.000Z";
const anchor = parseClaimAnchorMessage(`rmd-dispatch claim 21407@Host ${MINTED}`)!;

function fixture(t: TestContext): string {
  const dir = realpathSync(makeTempDir("host-drift"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function dropClaim(localHost: string) {
  const drops: unknown[] = [];
  const reserver: DispatchClaimReserver = {
    mintAnchor: () => assert.fail("drop must not mint"),
    attempt: () => assert.fail("drop must not claim"),
    holder: () => "held-sha",
    anchorMessage: () => `rmd-dispatch claim 21407@Host ${MINTED}`,
    drop: (id, options) => { drops.push({ id, options }); return true; },
  };
  const out = mock.method(console, "log", () => {});
  const err = mock.method(console, "error", () => {});
  try {
    const code = claimCommand([TASK, "--drop"], { reserver, isPlanned: () => true, localHost });
    return { code, drops, errors: err.mock.calls.map((c) => c.arguments.join(" ")).join("\n") };
  } finally { out.mock.restore(); err.mock.restore(); }
}

function withHostname(host: () => string, run: () => void): void {
  const hostname = mock.method(os, "hostname", host);
  syncBuiltinESMExports();
  try { run(); } finally { hostname.mock.restore(); syncBuiltinESMExports(); }
}

describe("test/identities-survive-a-macos-hostname-drift.test.ts", () => {
  test("W1-T9541: a claim anchored on the bare host is dropped from its mDNS form", () => {
    const result = dropClaim("Host.local");
    assert.equal(result.code, 0, result.errors);
    assert.deepEqual(result.drops, [{ id: TASK, options: { expect: "held-sha" } }]);
  });

  test("W1-T9541: a dead lock from the bare host is stale from its mDNS form", () => {
    assert.equal(isHolderStale({ pid: 21407, host: "Host" }, {
      hostname: () => "Host.local", inContainer: () => false, isPidAlive: () => false,
    }), true);
    assert.equal(isHolderStale({ pid: 21407, host: "other-host.invalid" }, {
      hostname: () => "Host.local", inContainer: () => false,
      isPidAlive: () => assert.fail("foreign pids must never be probed"),
    }), false);
    assert.equal(isHolderStale({ pid: 21407 }, {
      hostname: () => "Host.local", isPidAlive: () => false,
    }), true, "legacy absent-host locks still reach the pid rung");
  });

  test("W1-T9541: another host claim is still refused", () => {
    const result = dropClaim("other-host.invalid");
    assert.equal(result.code, 1);
    assert.deepEqual(result.drops, []);
    assert.equal(result.errors, `rmd claim: refs/rmd-dispatch/${TASK} is held by 21407@Host, not by this host (other-host.invalid) — refusing to drop another host's claim`);
  });

  test("W1-T9541: host comparison normalizes drift without merging distinct DNS or container hosts", async () => {
    const { hostIdentity, sameHost } = await import("../src/lib/host-identity.js");
    assert.equal(hostIdentity("  Craigs-Mac-mini.LOCAL.  "), "craigs-mac-mini");
    assert.equal(hostIdentity("foo.a.example."), "foo.a.example");
    const cases: Array<[string | undefined, string | undefined, boolean]> = [
      ["Host", "host", true], ["Host.", "host", true], ["Host", "Host.local.", true],
      ["Host", "host.lan", true], ["Host.home", "host", true],
      ["foo.a.example", "foo.b.example", false], ["foo.a.example", "FOO.A.EXAMPLE.", true],
      ["foo.locality", "foo.localdomain", false], ["Host", "other-host.local", false],
      ["abcdef123456", "abcdef123456", true], ["abcdef123456", "abcdef654321", false],
      ["a".repeat(64), "b".repeat(64), false], ["a".repeat(64), "a".repeat(12), false],
      ["abcdef123456", "abcdef123456.lan", false], ["a".repeat(64), `${"a".repeat(64)}.home`, false],
      ["", "", false], [" ", "Host", false], [".", ".local", false],
      [undefined, "Host", false], [undefined, undefined, false],
    ];
    for (const [a, b, expected] of cases) {
      assert.equal(sameHost(a, b), expected, `${a} vs ${b}`);
      assert.equal(sameHost(b, a), expected, `${b} vs ${a}`);
    }
  });

  test("W1-T9541: inflight sweep and doctor recognize a live local holder after drift", (t) => {
    const dir = fixture(t);
    writeFileSync(join(dir, `${TASK}.lock`), JSON.stringify({ pid: 21407, host: "Host", run_id: "run" }));
    assert.deepEqual(sweepStaleInflightLocks(dir, {
      hostname: () => "Host.local", isPidAlive: () => true, getProcessStartTime: () => null,
    }), { reaped: [], kept: [TASK], live: [TASK], unverifiableForeignHost: [] });
    assert.deepEqual(judgeInflightLocks(dir, {
      hostname: () => "Host.local", isPidAlive: () => true,
      listContainers: () => assert.fail("a local lock needs no docker lookup"),
    }), { live: [{ taskId: TASK, runId: "run", pid: 21407 }], unverifiable: [] });
  });

  test("W1-T9541: rotation preserves an old live holder across drift", () => {
    const startedAt = new Date().toISOString();
    const now = Date.parse(startedAt) + LEDGER_ROTATION_SMOOTHING_WINDOW_MS + 1;
    assert.equal(isRotationLockHolderStale({ pid: process.pid, host: "Host", startedAt }, {
      hostname: () => "Host.local", nowMs: now, isPidAlive: () => true,
    }), false);
  });

  test("W1-T9541: dispatch release distinguishes a dead local claimant from a replaced container", () => {
    const inputs = { taskId: TASK, heldByThisRun: false, evidenceObserved: false, anchorIdentity: anchor };
    assert.equal(decideDispatchClaimRelease({ ...inputs, liveness: {
      localHost: "Host.local", pidPresent: false, namespaceBootMs: anchor.mintedAtMs + 1,
      namespaceBootIso: "2026-10-14T20:00:00.000Z",
    } }).arm, "dead-claimant");
    const replaced = { localHost: "Host.local", lockHeldSinceMs: anchor.mintedAtMs + 1,
      lockHeldSinceIso: "2026-10-14T20:00:00.000Z",
      mintRow: { host: "Host", actor: "daemon", ts: MINTED, source: "ledger.ndjson" } };
    assert.equal(decideDispatchClaimRelease({ ...inputs, replaced }).release, false);
    assert.equal(decideDispatchClaimRelease({ ...inputs, replaced: {
      ...replaced, localHost: "different-host", mintRow: { ...replaced.mintRow, host: "Host.local" },
    } }).arm, "dead-claimant");
  });

  test("W1-T9541: dispatch mint rows and escalation use the same host identity", (t) => {
    const dir = fixture(t);
    writeFileSync(join(dir, "ledger.ndjson"), JSON.stringify({
      step: "dispatch.claim", ref: `refs/rmd-dispatch/${TASK}`, outcome: "created",
      host: "Host.local", ts: MINTED, actor: "daemon", run_id: "mint-run",
    }) + "\n");
    assert.equal(findClaimMintRow(dir, TASK, anchor)?.runId, "mint-run");
    const claims = [{ taskId: TASK, holder: "sha", identity: anchor }];
    const now = anchor.mintedAtMs + 2 * 24 * 3_600_000;
    assert.equal(staleDispatchClaimEscalations(claims, now, "other-host").length, 1);
    assert.deepEqual(staleDispatchClaimEscalations(claims, now, "Host.local"), []);
  });

  test("W1-T9541: a landed local rerun claim survives a hostname change", async () => {
    const drops: string[] = [];
    const reserver: DispatchClaimReserverAsync = {
      mintAnchor: () => "sha", attempt: () => "taken", holder: () => "sha",
      anchorMessage: () => `rmd-dispatch claim 21407@Host ${MINTED}`,
      listHeld: () => ({ ok: true, claims: [{ taskId: TASK, holder: "sha" }] }),
      drop: (id) => { drops.push(id); return true; },
    };
    const result = await releaseLandedDispatchClaims(reserver, {
      isMerged: () => true, isIndeterminate: () => false, isRerunClaim: () => true,
      localHost: "Host.local", log: () => {},
    });
    assert.equal(result[0]?.release, false);
    assert.deepEqual(drops, []);
  });

  test("W1-T9541: an id reservation remains self-owned after drift", () => {
    assert.equal(classifyReservationAnchor(`rmd-id reservation 21407@Host ${MINTED}`, {
      pid: 21407, host: "Host.local",
    }), "self");
  });

  test("W1-T9541: approve skips joining a live local approver after drift", async (t) => {
    const root = fixture(t), state = join(root, "state"), planPath = join(root, "tasks.yaml");
    mkdirSync(state);
    writeFileSync(planPath, "- id: W1-T1\n  title: seed task\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
    writeFileSync(join(state, "inbox-proposals.json"), JSON.stringify({
      proposals: [{ id: "P-LATER", summary: "later approval", evidenceAnchors: [] }],
    }));
    writeFileSync(join(state, "inbox-drafts.json"), JSON.stringify({ "P-LATER": {
      proposalId: "P-LATER", anchorFingerprint: "", stampLine: "- P-LATER — RATIFIED -> NEW-1.",
      fragmentYaml: "- id: NEW-1\n  title: later task\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/plan.ts]\n",
    } }));
    const ledger = join(state, "ledger.ndjson");
    writeFileSync(ledger, JSON.stringify({ step: "ratify.approved", task_id: "P-FIRST",
      branch: "run-APPROVE-P-FIRST-1791000000000", pr_url: "https://github.com/example/repo/pull/1",
      pr_number: 1, actor_pid: process.pid, host: "Host" }) + "\n");
    const stopped = new Error("fixture stops before external io");
    const exec = mock.method(childProcess, "execFileSync", (file: string, args: readonly string[]) => {
      if (file === "git" && args.includes("remote.origin.url")) return "https://github.com/example/repo.git\n";
      if (file === "git" && args.includes("ls-tree")) return "";
      throw stopped;
    });
    const host = mock.method(os, "hostname", () => "Host.local");
    syncBuiltinESMExports();
    try {
      await assert.rejects(approveCommand(["P-LATER"], {
        config: { root, claudeBin: "/usr/bin/true" }, planPath,
      }));
      const rows = readFileSync(ledger, "utf8").trim().split("\n").map((row) => JSON.parse(row));
      assert.ok(rows.some((row) => row.step === "approve.join_skipped" && row.reason === "approving_pid_alive"));
    } finally { exec.mock.restore(); host.mock.restore(); syncBuiltinESMExports(); }
  });

  test("W1-T9541: a triage heartbeat written after drift keeps the holder alive", () => {
    const now = new Date(anchor.mintedAtMs + TRIAGE_CLAIM_LIVENESS_WINDOW_MS + 1000);
    const result = assessTriageClaimLiveness({ now, holder: { pid: 21407, host: "Host", claimedAt: MINTED },
      rows: [{ host: "Host", ts: MINTED, actor_pid: 21407 },
        { host: "Host.local", ts: now.toISOString(), actor_pid: 21407 }],
    });
    assert.equal(result.verdict, "alive");
    assert.equal(result.releasable, false);
  });

  test("W1-T9541: a dead local test slot is reclaimed before its lease expires", (t) => {
    const dir = fixture(t);
    writeFileSync(join(dir, "slot-1.json"), JSON.stringify({
      pid: 21407, host: "Host", startedAt: MINTED, heartbeatAt: MINTED, label: "dead",
    }));
    const lease = acquireTestSlot("replacement", {
      dir, slots: 1, hostname: () => "Host.local", bootId: () => undefined, pidNamespace: () => undefined,
      isPidAlive: () => false, clock: fixedClock(anchor.mintedAtMs), waitBoundMs: 0,
      load: () => ({ cores: 4, load1: 0 }), log: () => {},
    });
    try { assert.equal(lease.outcome, "acquired"); } finally { lease.release(); }
  });

  test("W1-T9541: a test slot can refresh and release after its hostname changes", (t) => {
    const dir = fixture(t);
    let host = "Host";
    withHostname(() => "Host.local", () => {
      const lease = acquireTestSlot("owner", { dir, slots: 1, hostname: () => host,
        load: () => ({ cores: 4, load1: 0 }), log: () => {} });
      try {
        assert.ok(lease.childEnvironment, "the drifted local name still permits child inheritance");
        host = "Host.local";
        lease.refresh();
        assert.equal(JSON.parse(readFileSync(join(dir, "slot-1.json"), "utf8")).host, host);
      } finally { host = "Host"; lease.release(); }
      assert.equal(existsSync(join(dir, "slot-1.json")), false);
    });
  });

  test("W1-T9541: a descendant inherits its parent slot across hostname drift", (t) => {
    const dir = fixture(t), path = join(dir, "slot-1.json");
    const facts = testSlotProcessFacts(process.ppid);
    assert.ok(facts, "the real parent process has a measurable start identity");
    writeFileSync(path, JSON.stringify({ pid: process.ppid, host: "Host", processStart: facts.start,
      ownerNonce: "parent-nonce", concurrency: 2, startedAt: MINTED, heartbeatAt: MINTED }));
    const savedParent = process.env[TEST_SLOT_PARENT_ENV], savedContext = process.env.NODE_TEST_CONTEXT;
    process.env[TEST_SLOT_PARENT_ENV] = JSON.stringify({ path, pid: process.ppid, nonce: "parent-nonce", start: facts.start, concurrency: 2 });
    delete process.env.NODE_TEST_CONTEXT;
    try {
      withHostname(() => "Host.local", () => {
        const lease = acquireTestSlot("child", { dir, slots: 1, waitBoundMs: 0, log: () => {} });
        assert.equal(lease.outcome, "acquired");
        assert.match(lease.note, /inherited live parent/);
        lease.refresh(); lease.release();
        assert.equal(existsSync(path), true, "a borrower leaves the parent's slot intact");
      });
    } finally {
      if (savedParent === undefined) delete process.env[TEST_SLOT_PARENT_ENV]; else process.env[TEST_SLOT_PARENT_ENV] = savedParent;
      if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = savedContext;
    }
  });

  test("W1-T9541: heavy build reservations remain releasable by their minting process", (t) => {
    const temp = fixture(t);
    const dir = process.platform === "linux" && ![0xef53, 0x58465342].includes(statfsSync(temp).type)
      ? join(realpathSync(process.cwd()), basename(temp)) : temp;
    if (dir !== temp) {
      mkdirSync(dir, { mode: 0o700 });
      t.after(() => rmSync(dir, { recursive: true, force: true }));
    }
    let host = "Host";
    withHostname(() => host, () => {
      const handle = reserveHeavyNewBuilds(TASK, "drift", { dir, now: anchor.mintedAtMs });
      host = "Host.local";
      assert.equal(releaseHeavyNewBuilds(handle, { now: anchor.mintedAtMs + 1 }), true);
      assert.equal(handle.request.owner.host, "Host", "the writer preserves the raw hostname");
    });
  });
});
