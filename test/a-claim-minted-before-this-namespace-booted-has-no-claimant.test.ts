/**
 * test/a-claim-minted-before-this-namespace-booted-has-no-claimant.test.ts — W1-T2784.
 *
 * THE DEFECT. `decideDispatchClaimRelease`'s operator arm refuses on the ground that "cross-host
 * liveness is not decidable". True in general; FALSE in exactly one shape, and that shape was
 * producing permanent claims. MEASURED 2026-09-03: `refs/rmd-dispatch/W1-T2631` was minted
 * `490780@5670f73af4f4` at 03:52:05.691Z; its run reached recon, spawned an implement worker
 * (worker.state rows to 04:02:47Z), then stopped with no verdict row and no release. The container
 * kept the SAME id across its restart, so every later lane read a live-looking holder and refused.
 * Four refusals burned $2.3421 of preflight (the probes run BEFORE the claim check); W1-T2631 and
 * W1-T2636 together burned $37.6891 across 122 blocked verdicts and zero completions, and an
 * operator cleared four refs by hand.
 *
 * THE NARROW DECIDABLE CASE. A process cannot outlive the PID namespace that contains it. So a
 * claim whose anchor names THIS host and whose minted-at PREDATES this namespace's own init start
 * has a claimant that provably cannot exist — no liveness guess, no timer, no elapsed-time
 * threshold, and no pid-reuse ambiguity (the entire pid space was replaced).
 *
 * THE TWO NEGATIVES MATTER MORE THAN THE POSITIVE, and are why this file is mostly negatives: a
 * release path that is too eager reintroduces the duplicate dispatch W1-T1265 measured at 53.776
 * seconds apart. Every clause of the predicate therefore gets its own falsifier below, each
 * flipping ONE input away from the releasing case and asserting the operator arm holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideDispatchClaimRelease,
  dispatchClaimRef,
  parseClaimAnchorMessage,
  pidIsPresent,
  readNamespaceBootMs,
  releaseDispatchClaim,
  type ClaimAnchorIdentity,
  type ClaimantLivenessProbe,
  type DispatchClaimReserver,
} from "../src/lib/dispatch-claim.js";

const HOST = "5670f73af4f4";
const BOOT_MS = Date.parse("2026-09-03T11:37:56.000Z");

/** The live incident's own anchor, verbatim. */
const DEAD_ANCHOR: ClaimAnchorIdentity = {
  pid: 490780,
  host: HOST,
  mintedAtMs: Date.parse("2026-09-03T03:52:05.691Z"),
  mintedAtIso: "2026-09-03T03:52:05.691Z",
};

const SAME_HOST_BOOTED_AFTER: ClaimantLivenessProbe = {
  localHost: HOST,
  namespaceBootMs: BOOT_MS,
  namespaceBootIso: "2026-09-03T11:37:56.000Z",
  pidPresent: false,
};

const BASE = { heldByThisRun: false, evidenceObserved: false, taskId: "W1-T2631" } as const;

// ── THE POSITIVE: the exact shape that was stuck ─────────────────────────────────────────────

test("W1-T2784 (+): same host, claim PREDATES this namespace's boot, pid absent -> RELEASED", () => {
  const d = decideDispatchClaimRelease({ ...BASE, anchorIdentity: DEAD_ANCHOR, liveness: SAME_HOST_BOOTED_AFTER });
  assert.equal(d.arm, "dead-claimant");
  assert.equal(d.release, true);
});

test("W1-T2784 (+): the release reason names the ref, the anchor, and BOTH deciding signals", () => {
  // A silent automatic release of a lock someone might be holding is worse than the stuck claim
  // it fixes, so the row must let a reader re-derive the decision without re-running anything.
  const { reason } = decideDispatchClaimRelease({ ...BASE, anchorIdentity: DEAD_ANCHOR, liveness: SAME_HOST_BOOTED_AFTER });
  assert.ok(reason.includes(dispatchClaimRef("W1-T2631")), "names the ref");
  assert.ok(reason.includes("490780"), "names the claiming pid");
  assert.ok(reason.includes(HOST), "names the claiming host");
  assert.ok(reason.includes("2026-09-03T03:52:05.691Z"), "names WHEN the claim was minted");
  assert.ok(reason.includes("2026-09-03T11:37:56.000Z"), "names the namespace boot it lost to");
  assert.ok(/absent/.test(reason), "names the pid-absence confirmation");
});

// ── NEGATIVE 1: a DIFFERENT host must stay refused ───────────────────────────────────────────

test("W1-T2784 (-): a DIFFERENT host is never released, even when every other clause would fire", () => {
  // THE LOAD-BEARING GUARD. Without host equality, a Mac-mini claim would be judged against the
  // Azure container's boot clock — two unrelated epochs — and a mini claim older than the
  // container's last restart would be released out from under a live lane.
  const foreign: ClaimAnchorIdentity = { ...DEAD_ANCHOR, host: "Craigs-Mac-mini" };
  const d = decideDispatchClaimRelease({ ...BASE, anchorIdentity: foreign, liveness: SAME_HOST_BOOTED_AFTER });
  assert.equal(d.arm, "operator", "a foreign host is exactly the case that is NOT decidable");
  assert.equal(d.release, false);
  assert.match(d.reason, /Cross-host liveness is not decidable/, "and it still says so, unchanged");
});

// ── NEGATIVE 2: a claim AFTER boot with a live pid must stay refused ──────────────────────────

test("W1-T2784 (-): same host, claim AFTER boot, pid ALIVE -> NOT released", () => {
  const afterBoot: ClaimAnchorIdentity = {
    ...DEAD_ANCHOR,
    mintedAtMs: Date.parse("2026-09-03T12:00:00.000Z"),
    mintedAtIso: "2026-09-03T12:00:00.000Z",
  };
  const d = decideDispatchClaimRelease({
    ...BASE,
    anchorIdentity: afterBoot,
    liveness: { ...SAME_HOST_BOOTED_AFTER, pidPresent: true },
  });
  assert.equal(d.arm, "operator", "a claimant that could still be running is the operator's call");
  assert.equal(d.release, false);
});

// ── NEGATIVE 3+: every remaining clause, flipped one at a time ────────────────────────────────

test("W1-T2784 (-): same host, claim AFTER boot, pid absent -> STILL not released", () => {
  // Boot time is PRIMARY and pid absence only CONFIRMS. Pid absence alone is not proof: a pid can
  // be absent because it exited AND its number could later be reused, so only a namespace restart
  // makes "absent" unambiguous. Declining here is a false negative (the stuck claim persists —
  // today's behaviour), which is the safe direction.
  const afterBoot: ClaimAnchorIdentity = {
    ...DEAD_ANCHOR,
    mintedAtMs: Date.parse("2026-09-03T12:00:00.000Z"),
    mintedAtIso: "2026-09-03T12:00:00.000Z",
  };
  const d = decideDispatchClaimRelease({ ...BASE, anchorIdentity: afterBoot, liveness: SAME_HOST_BOOTED_AFTER });
  assert.equal(d.arm, "operator");
  assert.equal(d.release, false);
});

test("W1-T2784 (-): same host, claim predates boot, but the pid IS present -> not released", () => {
  // A recycled pid reads ALIVE and blocks the release. Erring safe, per the arm's own doc.
  const d = decideDispatchClaimRelease({
    ...BASE,
    anchorIdentity: DEAD_ANCHOR,
    liveness: { ...SAME_HOST_BOOTED_AFTER, pidPresent: true },
  });
  assert.equal(d.arm, "operator");
  assert.equal(d.release, false);
});

test("W1-T2784 (-): an ABSENT anchor identity or ABSENT liveness declines to the operator arm", () => {
  // Unreadable inputs must never manufacture a release — the whole arm is fail-closed on absence.
  for (const shape of [
    { anchorIdentity: undefined, liveness: SAME_HOST_BOOTED_AFTER },
    { anchorIdentity: DEAD_ANCHOR, liveness: undefined },
    { anchorIdentity: undefined, liveness: undefined },
  ]) {
    const d = decideDispatchClaimRelease({ ...BASE, ...shape });
    assert.equal(d.arm, "operator", `absent input must decline: ${JSON.stringify(Object.keys(shape))}`);
    assert.equal(d.release, false);
  }
});

test("W1-T2784: the first two arms still win, and never spend a probe to do it", () => {
  // Ordering regression lock: holder and evidence are unchanged and must not be reachable-past.
  const holder = decideDispatchClaimRelease({ ...BASE, heldByThisRun: true, anchorIdentity: DEAD_ANCHOR, liveness: SAME_HOST_BOOTED_AFTER });
  assert.equal(holder.arm, "holder");
  const evidence = decideDispatchClaimRelease({ ...BASE, evidenceObserved: true, anchorIdentity: DEAD_ANCHOR, liveness: SAME_HOST_BOOTED_AFTER });
  assert.equal(evidence.arm, "evidence");
});

// ── the anchor parser: fail-closed on anything that is not the exact minted shape ─────────────

test("W1-T2784: parseClaimAnchorMessage round-trips a real anchor and refuses everything else", () => {
  const ok = parseClaimAnchorMessage("rmd-dispatch claim 490780@5670f73af4f4 2026-09-03T03:52:05.691Z");
  assert.deepEqual(ok, {
    pid: 490780,
    host: "5670f73af4f4",
    mintedAtMs: Date.parse("2026-09-03T03:52:05.691Z"),
    mintedAtIso: "2026-09-03T03:52:05.691Z",
  });
  for (const bad of [
    undefined,
    "",
    "not an anchor at all",
    "rmd-dispatch claim @host 2026-09-03T03:52:05.691Z", // no pid
    "rmd-dispatch claim 0@host 2026-09-03T03:52:05.691Z", // pid 0 is not a claimant
    "rmd-dispatch claim 12@host not-a-timestamp", // unparseable instant
    "rmd-triage claim 12@host 2026-09-03T03:52:05.691Z", // a DIFFERENT namespace's anchor
  ]) {
    assert.equal(parseClaimAnchorMessage(bad), undefined, `must refuse: ${String(bad)}`);
  }
});

// ── the I/O seams, against real /proc, so the default leaves are not left to fakes ────────────

test("W1-T2784: readNamespaceBootMs reads THIS namespace's init start from real /proc", () => {
  // The all-fakes trap: every decision test above injects its liveness, so without this the
  // production reader is never executed. Asserts falsifiable properties, not merely that it
  // returned — and deliberately NOT /proc/uptime, which is not namespaced (MEASURED: inside the
  // daemon container it reports the HOST's uptime, so a predicate built on it compares against
  // the wrong epoch entirely).
  const boot = readNamespaceBootMs();
  assert.equal(typeof boot, "number", "a Linux host must yield a number");
  assert.ok(boot! > Date.parse("2020-01-01T00:00:00Z"), "a plausible epoch, not 0 or a tick count");
  assert.ok(boot! <= Date.now(), "this namespace cannot have booted in the future");
});

test("W1-T2784: readNamespaceBootMs declines (undefined) on unreadable or malformed /proc", () => {
  assert.equal(readNamespaceBootMs({ readFile: () => { throw new Error("EACCES"); } }), undefined);
  assert.equal(readNamespaceBootMs({ readFile: () => "no btime here" }), undefined);
});

test("W1-T2784: readNamespaceBootMs parses a comm containing spaces AND parentheses", () => {
  // `/proc/<pid>/stat` field 2 is free-form inside parens, so a whitespace split mis-indexes every
  // later field. Slicing after the LAST ')' is the only correct parse.
  //
  // The fixture is built POSITIONALLY rather than hand-spaced: fields 3..21 are placeholders and
  // field 22 (starttime) is placed by index, so the test cannot drift out of agreement with the
  // parser by a miscounted literal — which is exactly what a hand-written version of this row
  // got wrong on the first attempt.
  const START_TICKS = 269880;
  const fields3to21 = Array.from({ length: 19 }, (_, i) => String(i)); // fields 3..21 inclusive
  const statLine = `1 (my prog (v2)) ${fields3to21.join(" ")} ${START_TICKS} 0 0 0`;
  const boot = readNamespaceBootMs({
    readFile: (p) => (p === "/proc/stat" ? "btime 1788432777\n" : statLine),
    clockTicks: () => 100,
  });
  assert.equal(boot, (1788432777 + START_TICKS / 100) * 1000, "field 22 indexed from AFTER the comm");
});

test("W1-T2784: pidIsPresent reports PRESENT on any doubt — absence is half the release proof", () => {
  assert.equal(pidIsPresent(1, { exists: () => true }), true);
  assert.equal(pidIsPresent(999999, { exists: () => false }), false);
  assert.equal(pidIsPresent(1, { exists: () => { throw new Error("EPERM"); } }), true, "cannot tell => present => blocks release");
  assert.equal(pidIsPresent(1), true, "pid 1 really exists here — the default leaf runs");
});

// ── releaseDispatchClaim: the arm reaches the git seam, and pins its lease ────────────────────

function fakeReserver(over: Partial<DispatchClaimReserver> & { drops?: string[] } = {}): DispatchClaimReserver & { drops: { taskId: string; expect?: string }[] } {
  const drops: { taskId: string; expect?: string }[] = [];
  return {
    drops,
    mintAnchor: () => "anchor",
    attempt: () => "created",
    holder: () => "held-sha",
    drop: (taskId, opts = {}) => {
      drops.push({ taskId, expect: opts.expect });
      return true;
    },
    anchorMessage: () => "rmd-dispatch claim 490780@5670f73af4f4 2026-09-03T03:52:05.691Z",
    ...over,
  } as DispatchClaimReserver & { drops: { taskId: string; expect?: string }[] };
}

test("W1-T2784: releaseDispatchClaim drops on the dead-claimant arm, pinned to the sha it JUDGED", () => {
  const r = fakeReserver();
  const out = releaseDispatchClaim("W1-T2631", r, { livenessProbe: () => SAME_HOST_BOOTED_AFTER });
  assert.equal(out.arm, "dead-claimant");
  assert.equal(out.dropped, true);
  // --force-with-lease pinned to the judged sha: a claim re-minted between the read and the push
  // (a live lane legitimately taking it) fails the lease and survives — the one race a
  // proof-of-death cannot see, closed by git rather than by a guess.
  assert.deepEqual(r.drops, [{ taskId: "W1-T2631", expect: "held-sha" }]);
});

test("W1-T2784: with NO livenessProbe supplied, behaviour is today's three-arm shape byte-for-byte", () => {
  // The seam is optional and last, so every pre-existing caller and fake keeps its behaviour.
  const r = fakeReserver();
  const out = releaseDispatchClaim("W1-T2631", r, {});
  assert.equal(out.arm, "operator");
  assert.equal(out.dropped, false);
  assert.deepEqual(r.drops, [], "no probe, no drop, no git round trip");
});

test("W1-T2784: an unreadable anchor message declines to the operator arm and drops nothing", () => {
  const r = fakeReserver({ anchorMessage: () => undefined });
  const out = releaseDispatchClaim("W1-T2631", r, { livenessProbe: () => SAME_HOST_BOOTED_AFTER });
  assert.equal(out.arm, "operator");
  assert.equal(out.dropped, false);
  assert.deepEqual(r.drops, []);
});

test("W1-T2784: the liveness probe is not even consulted when an earlier arm already decided", () => {
  let probed = 0;
  const r = fakeReserver();
  releaseDispatchClaim("W1-T2631", r, {
    anchor: "my-own-anchor",
    livenessProbe: () => {
      probed += 1;
      return SAME_HOST_BOOTED_AFTER;
    },
  });
  assert.equal(probed, 0, "a run releasing its OWN claim must not spend a /proc read or a git round trip");
});
