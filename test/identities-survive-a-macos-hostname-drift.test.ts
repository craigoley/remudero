import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hostIdentity, sameHost } from "../src/lib/host-identity.js";
import { isHolderStale } from "../src/lib/fs-race-safe.js";
import { isRotationLockHolderStale } from "../src/lib/ledger.js";
import { assessTriageClaimLiveness } from "../src/lib/auto-triage.js";
import { claimDropRefusal, decideDispatchClaimRelease, dispatchClaimRef, parseClaimAnchorMessage, staleDispatchClaimEscalations } from "../src/lib/dispatch-claim.js";
import { sweepStaleInflightLocks } from "../src/lib/inflight-lock.js";
import { judgeInflightLocks } from "../src/lib/report-commands.js";
import { makeTempDir } from "../src/lib/tmp.js";

// W1-T9541: os.hostname() on the operator Mac flips between `Host` and `Host.local` with network
// state. A PID@HOST identity recorded under one form must still read as this host from the other.
// `rmd claim --drop` asks claimDropRefusal (src/lib/dispatch-claim.ts) whether the anchor is this
// host's; the suite drives that gate directly so it does not join src/run-task.ts's importers.

const BARE_ANCHOR = "rmd-dispatch claim 21407@Host 2026-10-14T19:18:21Z";
const REF = dispatchClaimRef("W1-T8171");

test("W1-T9541: a claim anchored on the bare host is dropped from its mDNS form", () => {
  assert.equal(claimDropRefusal(REF, BARE_ANCHOR, "Host.local"), undefined);
  assert.equal(claimDropRefusal(REF, BARE_ANCHOR, "host"), undefined, "control: case alone is not a different host");
  assert.equal(claimDropRefusal(REF, "rmd-dispatch claim 21407@Host.local 2026-10-14T19:18:21Z", "Host"), undefined,
    "the flip runs both ways");
});

test("W1-T9541: another host claim is still refused", () => {
  assert.equal(claimDropRefusal(REF, BARE_ANCHOR, "other-host.invalid"),
    "refs/rmd-dispatch/W1-T8171 is held by 21407@Host, not by this host (other-host.invalid) — refusing to drop another host's claim");
  assert.equal(claimDropRefusal(REF, "rmd-dispatch claim 21407@Host.a.example 2026-10-14T19:18:21Z", "Host.b.example") !== undefined, true,
    "two FQDNs sharing a first label are two hosts");
  assert.equal(claimDropRefusal(REF, "not an anchor", "Host"),
    "refs/rmd-dispatch/W1-T8171 is held by an unreadable anchor, not by this host (Host) — refusing to drop another host's claim");
  assert.equal(claimDropRefusal(REF, undefined, "Host") !== undefined, true, "no anchor is never this host's");
});

test("W1-T9541: a dead lock from the bare host is stale from its mDNS form", () => {
  const held = { pid: 999_999, host: "Host", startedAt: "2026-10-14T19:18:21.000Z" };
  const probes = { isPidAlive: () => false, inContainer: () => false, getProcessStartTime: () => null };
  assert.equal(isHolderStale(held, { ...probes, hostname: () => "Host.local" }), true);
  assert.equal(isHolderStale(held, { ...probes, hostname: () => "Host" }), true, "control: the identical form");
  assert.equal(isHolderStale(held, { ...probes, hostname: () => "other-host.invalid" }), false,
    "a foreign host's pid is never probed, so its lock is never stale");
});

test("W1-T9541: a live inflight lock from the bare host reads live, never foreign, from its mDNS form", (t) => {
  const dir = makeTempDir("host-drift");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inflight = join(dir, "inflight");
  mkdirSync(inflight);
  writeFileSync(join(inflight, "W1-T8171.lock"),
    JSON.stringify({ pid: process.pid, run_id: "run-1", host: "Host", startedAt: new Date().toISOString() }));
  const sweep = (host: string) => sweepStaleInflightLocks(inflight, { hostname: () => host, isPidAlive: () => true, getProcessStartTime: () => null });
  const local = sweep("Host.local");
  assert.deepEqual([local.live, local.unverifiableForeignHost, local.reaped], [["W1-T8171"], [], []]);
  const foreign = sweep("other-host.invalid");
  assert.deepEqual([foreign.live, foreign.unverifiableForeignHost], [[], ["W1-T8171"]], "control: a foreign host is unverifiable");

  const doctor = (host: string) => judgeInflightLocks(inflight, { hostname: () => host, isPidAlive: () => true, listContainers: () => [] });
  assert.deepEqual(doctor("Host.local"), { live: [{ taskId: "W1-T8171", runId: "run-1", pid: process.pid }], unverifiable: [] });
  assert.deepEqual(doctor("other-host.invalid"), { live: [], unverifiable: [{ taskId: "W1-T8171", host: "Host" }] },
    "control: a foreign host with no container is unverifiable");
});

test("W1-T9541: sameHost judges two host names as one machine only when they are", () => {
  const rows: Array<[unknown, unknown, boolean, string]> = [
    ["Craigs-Mac-mini", "craigs-mac-mini", true, "case"],
    ["Craigs-Mac-mini.", "Craigs-Mac-mini", true, "trailing dot"],
    ["Craigs-Mac-mini", "Craigs-Mac-mini.local", true, "mDNS .local"],
    ["Craigs-Mac-mini.local.", "craigs-mac-mini", true, "mDNS .local with a trailing dot"],
    ["Craigs-Mac-mini", "craigs-mac-mini.lan", true, "a search-domain suffix against a bare label"],
    ["craigs-mac-mini.home", "Craigs-Mac-mini", true, "a search-domain suffix, either side"],
    ["foo.a.example", "foo.b.example", false, "two different FQDNs sharing a first label"],
    ["foo.a.example", "foo.a.example", true, "the same FQDN"],
    ["Craigs-Mac-mini", "Other-Mac", false, "two different bare labels"],
    ["0123456789ab", "0123456789ab", true, "a container id matches itself"],
    ["0123456789ab", "ba9876543210", false, "two container ids"],
    ["0123456789ab", "0123456789ab.example", false, "a container id never matches by first label"],
    ["", "", false, "empty"],
    ["Host", "", false, "one side empty"],
    [undefined, "Host", false, "undefined"],
    [undefined, undefined, false, "both undefined"],
    [".local", "local", false, "a name that normalizes to nothing"],
  ];
  for (const [a, b, want, why] of rows) {
    assert.equal(sameHost(a, b), want, `${why}: sameHost(${String(a)}, ${String(b)})`);
    assert.equal(sameHost(b, a), want, `${why}: symmetric`);
  }
  assert.equal(hostIdentity("  Craigs-Mac-mini.LOCAL. "), "craigs-mac-mini");
});

test("W1-T9541: every census site reads the bare and mDNS forms as one host", () => {
  const minted = Date.parse("2026-10-14T19:18:21Z");
  const anchorIdentity = parseClaimAnchorMessage(BARE_ANCHOR);
  assert.ok(anchorIdentity);

  // decideDispatchClaimRelease arm 3 (W1-T2784): a provably dead same-host claimant is released.
  const liveness = { localHost: "Host.local", namespaceBootMs: minted + 60_000, namespaceBootIso: "2026-10-14T19:19:21Z", pidPresent: false };
  assert.equal(decideDispatchClaimRelease({ heldByThisRun: false, evidenceObserved: false, taskId: "W1-T8171", anchorIdentity, liveness }).arm, "dead-claimant");

  // staleDispatchClaimEscalations: this host's own day-old claim is not escalated as cross-host.
  const claims = [{ taskId: "W1-T8171", holder: "abc123", identity: anchorIdentity }];
  const later = minted + 2 * 24 * 60 * 60 * 1000;
  assert.deepEqual(staleDispatchClaimEscalations(claims, later, "Host.local"), []);
  assert.equal(staleDispatchClaimEscalations(claims, later, "other-host.invalid").length, 1, "control: a foreign host's claim escalates");

  // isRotationLockHolderStale: a live same-host rotation holder is judged by pid, never by age alone.
  // startedAt is NOW so the real boot and pid-reuse rungs (no seam on this verb) read it as current.
  const rotation = { pid: process.pid, host: "Host", startedAt: new Date().toISOString() };
  const nowMs = Date.now() + 24 * 60 * 60 * 1000;
  assert.equal(isRotationLockHolderStale(rotation, { hostname: () => "Host.local", inContainer: () => false, nowMs, isPidAlive: () => true }), false);
  assert.equal(isRotationLockHolderStale(rotation, { hostname: () => "other-host.invalid", inContainer: () => false, nowMs, isPidAlive: () => true }), true,
    "control: a foreign holder is aged out");

  // assessTriageClaimLiveness: rows written after the flip are still the holder's heartbeat.
  const now = new Date(minted + 2 * 60 * 60 * 1000);
  const verdict = assessTriageClaimLiveness({
    holder: { pid: 4242, host: "Host", claimedAt: "2026-10-14T19:18:21Z" },
    rows: [{ ts: new Date(now.getTime() - 60_000).toISOString(), host: "Host.local", actor_pid: 4242 }],
    now,
  });
  assert.equal(verdict.verdict, "alive");
});
