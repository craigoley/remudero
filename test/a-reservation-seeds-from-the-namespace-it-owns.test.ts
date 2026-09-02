/**
 * The reservation walk re-probed ids the `refs/rmd-id/` namespace had already answered for.
 *
 * `mintNextTaskId` derives its number from plan/tasks.yaml, the shards, open PRs and plan history
 * — four surfaces, none of which is `refs/rmd-id/`. So `reserveTaskIdRemote` was handed a start
 * below every reservation the fleet already held and rediscovered them ONE FAILED PUSH AT A TIME.
 * MEASURED on this repo before the fix: `RESERVED W1-T2681 ... after 15 attempt(s)`, 13.50s for a
 * single id, and the attempt count grew by one with every id the fleet took.
 *
 * These tests drive the SHIPPED `reserveTaskIdRemote`/`gitRemoteRefReserver` through an injected
 * git runner, so what is asserted is the argv the real code emits, not a re-implementation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ALLOCATABLE_TASK_ID } from "../src/lib/task-id.js";
import { nextTaskIdCommand } from "../src/run-task.js";
import {
  RESERVATION_REF_RE,
  gitRemoteRefReserver,
  remoteReservedTaskIds,
  reservationFloorFrom,
  reserveTaskIdBlockRemote,
  reserveTaskIdRemote,
  type RemoteRefReserver,
} from "../src/lib/task-id-reservation.js";

/** A minimal plan whose highest declared id sits BELOW the floor under test. */
function planFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reservation-seed-"));
  const p = join(dir, "tasks.yaml");
  writeFileSync(p, "- id: W1-T1\n  title: fixture\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return p;
}

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
const refs = (...ids: string[]) => ids.map((i) => `0000000000000000000000000000000000000000\trefs/rmd-id/${i}`).join("\n") + "\n";

/** A reserver that records every id attempted and grants only ids at or above `freeAt`. */
function fakeReserver(freeAt: number, floor: number | "unknown", attempted: string[]): RemoteRefReserver {
  return {
    mintAnchor: () => "anchor",
    reservedFloor: () => floor,
    attempt(taskId) {
      attempted.push(taskId);
      return Number(taskId.replace("W1-T", "")) >= freeAt ? "created" : "taken";
    },
  };
}

test("an id above the allocatable bound never becomes the floor — the 1000002 ref that would burn the allocator", () => {
  // MEASURED on this repo's origin: 793 reservation refs whose two highest numbers are 1000002 and
  // 1000003. A raw maximum would seed every future mint at 1000004, permanently.
  const ids = remoteReservedTaskIds(() => ok(refs("W1-T2680", "W1-T1000002", "W1-T1000003")));
  assert.notEqual(ids, "unknown");
  assert.deepEqual(ids, [2680], "only the allocatable id survives the fold");
  assert.ok(MAX_ALLOCATABLE_TASK_ID < 1000002, "control: the dropped ids really are above the bound");
  assert.equal(reservationFloorFrom(ids), 2681, "so the floor is one above the highest ALLOCATABLE id");
});

test("a suffixed reservation ref does not fold onto the bare number it starts with", () => {
  // `taskIdReservationRef` keeps `W1-T1` and `W1-T1B` distinct; the parse must not read the latter
  // as 1, or one suffixed ref would silently vote in the floor for a different id.
  assert.deepEqual(remoteReservedTaskIds(() => ok(refs("W1-T7", "W1-T9B"))), [7]);
});

test("an unreadable namespace degrades to unknown rather than refusing — this is an optimisation, not a gate", () => {
  assert.equal(remoteReservedTaskIds(() => ({ status: 128, stdout: "", stderr: "fatal: could not read" })), "unknown");
  assert.equal(
    remoteReservedTaskIds(() => {
      throw new Error("spawn failed");
    }),
    "unknown",
  );
  assert.equal(reservationFloorFrom("unknown"), "unknown");
  assert.equal(reservationFloorFrom([]), "unknown", "an empty namespace offers no floor to raise to");
});

test("the walk starts at the floor instead of re-probing every id the namespace already holds", () => {
  const attempted: string[] = [];
  const h = reserveTaskIdRemote(2667, fakeReserver(2681, 2681, attempted));
  assert.equal(h.id, 2681);
  assert.equal(h.attempts, 1, "one attempt, not one per taken id");
  assert.deepEqual(attempted, ["W1-T2681"], "and nothing below the floor is ever pushed");
});

test("a floor BELOW the caller's own start never lowers it — a plan surface outranks the namespace", () => {
  // The plan surfaces can own an id the namespace does not; seeding downwards would hand back an
  // id plan/tasks.yaml already declares, which is the collision this allocator exists to prevent.
  const attempted: string[] = [];
  const h = reserveTaskIdRemote(3000, fakeReserver(3000, 2681, attempted));
  assert.equal(h.id, 3000);
  assert.deepEqual(attempted, ["W1-T3000"]);
});

test("a reserver that offers no floor walks exactly as it did before this existed", () => {
  const attempted: string[] = [];
  const bare: RemoteRefReserver = {
    mintAnchor: () => "anchor",
    attempt(taskId) {
      attempted.push(taskId);
      return Number(taskId.replace("W1-T", "")) >= 2670 ? "created" : "taken";
    },
  };
  const h = reserveTaskIdRemote(2667, bare);
  assert.equal(h.id, 2670);
  assert.equal(h.attempts, 4, "the unchanged linear walk");
  assert.deepEqual(attempted, ["W1-T2667", "W1-T2668", "W1-T2669", "W1-T2670"]);
});

test("the namespace is enumerated ONCE per reserver, not once per id in a block", () => {
  const argvs: string[][] = [];
  const reserver = gitRemoteRefReserver({
    anchor: () => "anchor",
    run(args) {
      argvs.push(args);
      if (args[0] === "ls-remote") return ok(refs("W1-T2680"));
      return ok(""); // every push succeeds
    },
  });
  const block = reserveTaskIdBlockRemote(2667, 3, reserver);
  assert.deepEqual(block.ids, [2681, 2682, 2683], "the whole block sits above the namespace");
  const lsRemotes = argvs.filter((a) => a[0] === "ls-remote");
  assert.equal(lsRemotes.length, 1, "one round trip for the block, not one per id");
  assert.deepEqual(lsRemotes[0], ["ls-remote", "origin", "refs/rmd-id/*"], "and it asks for the namespace by its real glob");
});

test("the shipped reserver reads the namespace with ls-remote and still pushes the anchor to claim", () => {
  const argvs: string[][] = [];
  const reserver = gitRemoteRefReserver({
    anchor: () => "anchor",
    run(args) {
      argvs.push(args);
      if (args[0] === "ls-remote") return ok(refs("W1-T2680"));
      return ok("");
    },
  });
  const h = reserveTaskIdRemote(2667, reserver);
  assert.equal(h.taskId, "W1-T2681");
  const push = argvs.find((a) => a[0] === "push");
  assert.deepEqual(push, ["push", "origin", "anchor:refs/rmd-id/W1-T2681"], "the push IS the claim, unchanged");
});

test("the CLI's observing decorator forwards the floor — a re-listed decorator silently dropped it", () => {
  // THE DEFECT THIS PINS, found by running the shipped verb rather than by reading it: the
  // `--reserve` path wraps the reserver to report contested ids, and that wrapper used to name
  // `mintAnchor` and `attempt` explicitly. Adding `reservedFloor` to the interface left it type-
  // checking and silently un-forwarded, so the seeding was inert on the ONE path an operator uses.
  // Measured against the real origin: 2 attempts with the decorator dropping it, 1 with it kept.
  const attempted: string[] = [];
  const injected: RemoteRefReserver = {
    mintAnchor: () => "anchor",
    reservedFloor: () => 2681,
    attempt(taskId) {
      attempted.push(taskId);
      return "created";
    },
  };
  // Drive the SHIPPED command, not a re-implementation of its wrapper.
  const rc = nextTaskIdCommand(["--reserve", "--plan", planFixture()], {}, {
    reserver: injected,
    openPrTexts: () => [],
    runGit: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  return rc.then((code) => {
    assert.equal(code, 0, "the verb succeeded");
    assert.deepEqual(attempted, ["W1-T2681"], "it started AT the floor, so the decorator forwarded it");
  });
});

test("the reservation-ref pattern REFUSES what it must, and accepts only what it must", () => {
  // The unhealthy arm, named explicitly: each of these is a line the namespace really can produce,
  // and reading any of them as a reservation would move the floor to a number nothing holds.
  for (const line of [
    "0000000000000000000000000000000000000000\trefs/rmd-id/W1-T9B", // suffixed id — a DIFFERENT ref
    "0000000000000000000000000000000000000000\trefs/heads/W1-T9", // not the reservation namespace
    "0000000000000000000000000000000000000000\trefs/rmd-id/TRIAGE-7", // another id family
    "0000000000000000000000000000000000000000\trefs/rmd-id/W1-T9/extra", // deeper path, not an id
    "", // a blank trailing line, which `ls-remote` output always ends with
  ]) {
    assert.equal(RESERVATION_REF_RE.test(line), false, `must refuse: ${JSON.stringify(line)}`);
  }
  // The healthy arm, so the refusal above is provably DISTINCT from accepting nothing at all.
  const real = "0000000000000000000000000000000000000000\trefs/rmd-id/W1-T2680";
  assert.equal(RESERVATION_REF_RE.test(real), true, "must accept a real reservation ref");
  assert.equal(RESERVATION_REF_RE.exec(real)?.[1], "2680", "and capture the number it will compare");
});
