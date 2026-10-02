import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import * as reservation from "../src/lib/task-id-reservation.js";
import {
  formatReservationHolderLine,
  gitRemoteRefReserver,
  parseReservationHolderLine,
  reservationHolderDrift,
} from "../src/lib/task-id-reservation.js";

// W1-T5279: refs/rmd-id/W1-T5209 was reserved by the ci-friction gardener at 07:44:15Z and taken
// over by a triage run at 07:44:36Z -- 21 seconds later, before the gardener had pushed its branch.
const NOW = Date.parse("2026-10-02T07:44:36.000Z");
const clock = fixedClock(NOW);
const holderBranch = "ci-friction-garden-1790927008162";
const filingBranch = "run-W1-T5279-1790953000002";
// Read off the namespace so the file still LOADS where the constant does not exist yet, and its
// subtests fail on behaviour there rather than the whole file failing to import.
const RESERVATION_PUSH_GRACE_MS = reservation.RESERVATION_PUSH_GRACE_MS;

function holderStartedAgo(ms: number | null): string {
  const startedAt = ms === null ? undefined : new Date(NOW - ms).toISOString();
  return formatReservationHolderLine({ branch: holderBranch, pid: 7, host: "gardener", startedAt, source: "automatic" });
}

test("W1-T5279: a holder started 21 seconds ago naming an absent branch is held, not reclaimable", () => {
  assert.equal(reservationHolderDrift(parseReservationHolderLine(holderStartedAgo(21_000)), "absent", clock), "held");
});

test("W1-T5279: the same holder past the grace period with its branch still absent is reclaimable", () => {
  const stale = parseReservationHolderLine(holderStartedAgo(RESERVATION_PUSH_GRACE_MS + 1_000));
  assert.equal(reservationHolderDrift(stale, "absent", clock), "reclaimable");
});

test("W1-T5279: a holder with no parseable started_at and an absent branch keeps today's reclaimable reading", () => {
  assert.equal(reservationHolderDrift(parseReservationHolderLine(holderStartedAgo(null)), "absent", clock), "reclaimable");
  const garbled = parseReservationHolderLine(`rmd-id holder branch=${holderBranch} started_at=not-a-time`);
  assert.equal(reservationHolderDrift(garbled, "absent", clock), "reclaimable");
});

test("W1-T5279: a present holder branch is held whether the reservation is fresh or old", () => {
  assert.equal(reservationHolderDrift(parseReservationHolderLine(holderStartedAgo(21_000)), "present", clock), "held");
  const old = parseReservationHolderLine(holderStartedAgo(RESERVATION_PUSH_GRACE_MS * 10));
  assert.equal(reservationHolderDrift(old, "present", clock), "held");
});

test("W1-T5279: a grace period is bounded, so an unreadable branch read stays unreadable inside it", () => {
  assert.equal(reservationHolderDrift(parseReservationHolderLine(holderStartedAgo(21_000)), "unreadable", clock), "unreadable");
});

type GitResult = { status: number; stdout: string; stderr: string };

function remoteHoldingReservationStartedAgo(ms: number): { run: (args: string[]) => GitResult; pushes: string[] } {
  const pushes: string[] = [];
  const message = `rmd-id reservation 7@gardener ${new Date(NOW - ms).toISOString()}\n\n${holderStartedAgo(ms)}\n`;
  return {
    pushes,
    run(args) {
      const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "remote") return ok("/tmp/local-origin.git\n");
      if (args[0] === "hash-object") return ok("TREE\n");
      if (args[0] === "commit-tree") return ok("RECLAIMED\n");
      if (args[0] === "fetch") return ok();
      if (args[0] === "log") return ok(message);
      if (args[0] === "ls-remote") return { status: 2, stdout: "", stderr: "" };
      if (args[0] === "push") pushes.push(args[2] ?? "");
      return ok();
    },
  };
}

test("W1-T5279 criterion 1: reclaim inside the grace period reports the id taken and pushes no takeover", () => {
  const remote = remoteHoldingReservationStartedAgo(21_000);
  const reserver = gitRemoteRefReserver({ run: remote.run, filingBranch, clock, say: () => {} });
  assert.equal(reserver.reclaim?.("W1-T5209"), "taken");
  assert.deepEqual(remote.pushes, [], "a live reservation whose branch is not yet pushed must not be taken over");
});

test("W1-T5279 criterion 1: reclaim past the grace period still takes over an abandoned reservation", () => {
  const remote = remoteHoldingReservationStartedAgo(RESERVATION_PUSH_GRACE_MS + 1_000);
  const reserver = gitRemoteRefReserver({ run: remote.run, filingBranch, clock, say: () => {} });
  assert.equal(reserver.reclaim?.("W1-T5209"), "created");
  assert.deepEqual(remote.pushes, ["RECLAIMED:refs/rmd-id/W1-T5209"]);
});
