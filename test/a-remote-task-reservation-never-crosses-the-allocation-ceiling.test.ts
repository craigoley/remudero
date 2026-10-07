import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ALLOCATABLE_TASK_ID } from "../src/lib/task-id.js";
import {
  nextPrefixedTaskIdStart,
  gitRemoteRefReserver,
  reserveTaskIdBlockRemote,
  reserveTaskIdRemote,
  TaskIdReservationError,
  type RemoteRefReserver,
} from "../src/lib/task-id-reservation.js";
import { gitRepo } from "./helpers/git-repo.js";

function exhausted(error: unknown): boolean {
  assert.ok(error instanceof TaskIdReservationError);
  assert.equal(error.outcome, "exhausted");
  assert.equal(error.ref, undefined, "range exhaustion does not invent a failed ref write");
  return true;
}

function forbidden(): never {
  assert.fail("an invalid allocation touched the reservation transport");
}

test("a prefixed mint refuses exhaustion instead of returning a sentinel", () => {
  for (const prefix of ["W1", "CONSOLE", "PORTAL"]) {
    assert.throws(() => nextPrefixedTaskIdStart([`${prefix}-T${MAX_ALLOCATABLE_TASK_ID}`], prefix), exhausted);
    assert.equal(nextPrefixedTaskIdStart([`${prefix}-T${MAX_ALLOCATABLE_TASK_ID - 1}`], prefix), MAX_ALLOCATABLE_TASK_ID);
    assert.equal(nextPrefixedTaskIdStart([`${prefix}-T${MAX_ALLOCATABLE_TASK_ID + 1}`], prefix), 1);
  }
});

test("an invalid reservation start refuses before any transport or anchor work", () => {
  const reserver: RemoteRefReserver = { mintAnchor: forbidden, attempt: forbidden, reservedFloor: forbidden };
  for (const start of [MAX_ALLOCATABLE_TASK_ID + 1, 0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => reserveTaskIdRemote(start, reserver), exhausted);
    assert.throws(() => reserveTaskIdRemote(start, reserver, { idFor: n => `CONSOLE-T${n}` }), exhausted);
  }
});

test("a remote floor beyond the allocation ceiling refuses before minting or pushing", () => {
  assert.throws(() => reserveTaskIdRemote(1, {
    reservedFloor: () => MAX_ALLOCATABLE_TASK_ID + 1,
    mintAnchor: forbidden,
    attempt: forbidden,
  }), exhausted);
});

test("a reservation scan stops at the allocation ceiling without pushing a sentinel", () => {
  for (const idFor of [undefined, (n: number) => `CONSOLE-T${n}`]) {
    const attempted: string[] = [];
    const reclaimed: string[] = [];
    const reserver: RemoteRefReserver = {
      mintAnchor: () => "anchor",
      attempt: id => { attempted.push(id); return "taken"; },
      reclaim: id => { reclaimed.push(id); return "taken"; },
    };
    assert.throws(() => reserveTaskIdRemote(MAX_ALLOCATABLE_TASK_ID - 1, reserver, { maxScan: 50, idFor }), exhausted);
    assert.deepEqual(attempted, [MAX_ALLOCATABLE_TASK_ID - 1, MAX_ALLOCATABLE_TASK_ID].map(n => (idFor ?? (n => `W1-T${n}`))(n)));
    assert.deepEqual(reclaimed, attempted);
  }
});

test("the final allocatable id can be reserved but a block never continues beyond it", () => {
  const attempted: string[] = [];
  const reserver: RemoteRefReserver = {
    mintAnchor: () => "anchor",
    attempt: id => { attempted.push(id); return "created"; },
  };
  const final = reserveTaskIdRemote(MAX_ALLOCATABLE_TASK_ID, reserver);
  assert.equal(final.id, MAX_ALLOCATABLE_TASK_ID);
  assert.throws(() => reserveTaskIdBlockRemote(MAX_ALLOCATABLE_TASK_ID, 2, reserver), exhausted);
  assert.deepEqual(attempted, [final.taskId, final.taskId], "a partial block keeps its valid claim and never writes another ref");
});

test("an invalid reservation scan budget refuses before an anchor or transport work", () => {
  for (const maxScan of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => reserveTaskIdRemote(1, { mintAnchor: forbidden, attempt: forbidden }, { maxScan }), /maxScan must be a positive safe integer/);
  }
});

test("a real local origin receives its final valid claim and no out-of-range reservation", () => {
  const origin = gitRepo({ bare: true });
  const work = gitRepo({ branch: "operator-allocation-fixture" });
  work.addRemote("origin", origin.dir);
  const reserver = gitRemoteRefReserver({
    run: args => ({ status: 0, stdout: work.git(...args), stderr: "" }),
  });
  const final = reserveTaskIdRemote(MAX_ALLOCATABLE_TASK_ID, reserver);
  assert.ok(origin.git("rev-parse", final.ref));
  assert.throws(() => reserveTaskIdRemote(MAX_ALLOCATABLE_TASK_ID + 1, reserver), exhausted);
  assert.deepEqual(origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/").split("\n"), [final.ref]);
});
