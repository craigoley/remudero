import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { hostIdentity, sameHost } from "../src/lib/host-identity.js";
import { isHolderStale } from "../src/lib/fs-race-safe.js";
import { isRotationLockHolderStale } from "../src/lib/ledger.js";
import { assessTriageClaimLiveness } from "../src/lib/auto-triage.js";
import { decideDispatchClaimRelease, parseClaimAnchorMessage, staleDispatchClaimEscalations } from "../src/lib/dispatch-claim.js";
import { claimCommand, classifyReservationAnchor } from "../src/run-task.js";

// W1-T9541: os.hostname() on the operator Mac flips between `Host` and `Host.local` with network
// state. A PID@HOST identity recorded under one form must still read as this host from the other.

type ClaimDeps = NonNullable<Parameters<typeof claimCommand>[1]>;

function runClaim(args: string[], deps: ClaimDeps): { code: number; out: string; err: string } {
  const out = mock.method(console, "log", () => {});
  const err = mock.method(console, "error", () => {});
  try {
    const code = claimCommand(args, deps);
    const text = (m: typeof out) => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    return { code, out: text(out), err: text(err) };
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
}

function anchoredReserver(anchor: string): { reserver: ClaimDeps["reserver"]; drops: string[] } {
  const drops: string[] = [];
  const reserver = {
    holder: () => "abc123",
    anchorMessage: () => anchor,
    drop: (taskId: string, o: { expect: string }) => {
      drops.push(`${taskId}@${o.expect}`);
      return true;
    },
    attempt: () => assert.fail("--drop never attempts a claim"),
    mintAnchor: () => assert.fail("--drop never mints"),
  } as unknown as ClaimDeps["reserver"];
  return { reserver, drops };
}

const BARE_ANCHOR = "rmd-dispatch claim 21407@Host 2026-10-14T19:18:21Z";

test("W1-T9541: a claim anchored on the bare host is dropped from its mDNS form", () => {
  const { reserver, drops } = anchoredReserver(BARE_ANCHOR);
  const r = runClaim(["W1-T8171", "--drop"], { reserver, isPlanned: () => true, localHost: "Host.local" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "dropped refs/rmd-dispatch/W1-T8171");
  assert.deepEqual(drops, ["W1-T8171@abc123"]);
});

test("W1-T9541: another host claim is still refused", () => {
  const { reserver, drops } = anchoredReserver(BARE_ANCHOR);
  const r = runClaim(["W1-T8171", "--drop"], { reserver, isPlanned: () => true, localHost: "other-host.invalid" });
  assert.equal(r.code, 1);
  assert.match(r.err, /held by 21407@Host, not by this host \(other-host\.invalid\) — refusing to drop another host's claim/);
  assert.deepEqual(drops, [], "a genuinely different host's claim is never dropped");
});

test("W1-T9541: a dead lock from the bare host is stale from its mDNS form", () => {
  const held = { pid: 999_999, host: "Host", startedAt: "2026-10-14T19:18:21.000Z" };
  const probes = { isPidAlive: () => false, inContainer: () => false, getProcessStartTime: () => null };
  assert.equal(isHolderStale(held, { ...probes, hostname: () => "Host.local" }), true);
  assert.equal(isHolderStale(held, { ...probes, hostname: () => "Host" }), true, "control: the identical form");
  assert.equal(isHolderStale(held, { ...probes, hostname: () => "other-host.invalid" }), false,
    "a foreign host's pid is never probed, so its lock is never stale");
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

  // classifyReservationAnchor: the caller's own reservation reads as self across a flip.
  assert.equal(classifyReservationAnchor("rmd-id reservation 4242@Host 2026-10-14T19:18:21Z", { pid: 4242, host: "Host.local" }), "self");
  assert.equal(classifyReservationAnchor("rmd-id reservation 4242@Host 2026-10-14T19:18:21Z", { pid: 4242, host: "other-host.invalid" }), "fleet");

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
