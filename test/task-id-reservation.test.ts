import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  firstUnreservedAtOrAbove,
  liveReservedIds,
  readTaskIdReservation,
  reserveTaskIdFrom,
  taskIdReservationPath,
  taskIdReservationsDir,
  TaskIdReservationError,
} from "../src/lib/task-id-reservation.js";

/**
 * The property this module exists for: a minted id is unusable by anyone else from the moment it
 * is minted. Every test here drives the REAL filesystem — the atomicity being asserted is
 * `openSync(path, "wx")`'s, so a faked fs would assert nothing.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rmd-idres-"));
}

const ALIVE = () => true;
const DEAD = () => false;

test("two concurrent mints of the SAME id get DIFFERENT ids — the core property", () => {
  const dir = join(scratch(), "task-id-reservations");
  // Both callers minted W1-T300 from the same snapshot, exactly the defect: neither source saw
  // the other because neither had pushed.
  const first = reserveTaskIdFrom(300, dir, { isPidAlive: ALIVE });
  const second = reserveTaskIdFrom(300, dir, { isPidAlive: ALIVE });

  assert.equal(first.id, 300, "the first minter keeps the id it derived");
  assert.equal(second.id, 301, "the second ADVANCES rather than colliding");
  assert.notEqual(first.id, second.id);
  // Both hold a real, separate file — not one overwriting the other.
  assert.ok(existsSync(first.path));
  assert.ok(existsSync(second.path));
  assert.notEqual(first.path, second.path);

  // A third caller minting the same stale number advances past BOTH.
  const third = reserveTaskIdFrom(300, dir, { isPidAlive: ALIVE });
  assert.equal(third.id, 302);
});

test("a reservation whose holder is DEAD is reclaimed, not burned", () => {
  const dir = join(scratch(), "task-id-reservations");
  mkdirSync(dir, { recursive: true });
  // A crashed minter's leftover: the file exists, its pid does not.
  writeFileSync(
    taskIdReservationPath(dir, 400),
    JSON.stringify({ id: 400, pid: 999999, host: "gone", startedAt: "2026-01-01T00:00:00Z", purpose: "crashed" }),
  );

  const handle = reserveTaskIdFrom(400, dir, { isPidAlive: DEAD });

  assert.equal(handle.id, 400, "the dead holder's id is REUSED, never skipped — no phantom id");
  assert.equal(readTaskIdReservation(handle.path)?.pid, process.pid, "the file now names the live claimant");
  assert.deepEqual(liveReservedIds(dir, { isPidAlive: DEAD }), [], "a dead holder is never reported as live");
});

test("a GARBAGE reservation file is reclaimed exactly like a dead pid — an unparseable holder is no holder", () => {
  const dir = join(scratch(), "task-id-reservations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(taskIdReservationPath(dir, 500), "{ this is not json");

  assert.equal(readTaskIdReservation(taskIdReservationPath(dir, 500)), null);
  const handle = reserveTaskIdFrom(500, dir, { isPidAlive: ALIVE });
  assert.equal(handle.id, 500, "a torn write must not wedge an id shut forever");
});

test("a minter that CANNOT reserve throws TaskIdReservationError rather than proceeding", () => {
  // A path that cannot be a directory: its parent is a FILE. mkdirSync fails with ENOTDIR, which
  // is not contention and must never be swallowed into "carry on with the unreserved id" — the
  // caller spawns a paid worker immediately after this returns.
  const root = scratch();
  const blocker = join(root, "state");
  writeFileSync(blocker, "i am a file, not a directory");
  assert.throws(
    () => reserveTaskIdFrom(600, taskIdReservationsDir(root), { isPidAlive: ALIVE }),
    (e: unknown) => e instanceof TaskIdReservationError && /cannot create the task-id reservation directory/.test((e as Error).message),
    "an unwritable reservation store must be LOUD, never a silent fallback",
  );
});

test("the single-minter common case is unchanged — one reserve returns the minted id verbatim", () => {
  const dir = join(scratch(), "task-id-reservations");
  const handle = reserveTaskIdFrom(279, dir, { isPidAlive: ALIVE });
  assert.equal(handle.id, 279, "no contention ⇒ the mint's answer is used as-is");
  assert.deepEqual(liveReservedIds(dir, { isPidAlive: ALIVE }), [279]);

  handle.release();
  assert.equal(existsSync(handle.path), false, "release removes the file");
  assert.deepEqual(liveReservedIds(dir, { isPidAlive: ALIVE }), [], "and the id returns to the pool");

  handle.release(); // idempotent — a finally AND a signal handler may both call it
  assert.equal(existsSync(handle.path), false);
});

test("firstUnreservedAtOrAbove READS reservations without taking one — the advisory reader never burns an id", () => {
  const dir = join(scratch(), "task-id-reservations");
  const held = reserveTaskIdFrom(700, dir, { isPidAlive: ALIVE });

  const before = readdirSync(dir).length;
  assert.equal(firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }), 701, "it skips the live reservation");
  assert.equal(firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }), 701, "and is stable across calls");
  assert.equal(readdirSync(dir).length, before, "READING must create no file — otherwise every query burns an id");

  held.release();
  assert.equal(firstUnreservedAtOrAbove(700, dir, { isPidAlive: ALIVE }), 700, "released ⇒ reported free again");
});

test("an exhausted scan window throws rather than looping forever", () => {
  const dir = join(scratch(), "task-id-reservations");
  // Fill the whole window with LIVE reservations, then ask for one more.
  reserveTaskIdFrom(800, dir, { isPidAlive: ALIVE, maxScan: 2 });
  reserveTaskIdFrom(800, dir, { isPidAlive: ALIVE, maxScan: 2 });
  assert.throws(
    () => reserveTaskIdFrom(800, dir, { isPidAlive: ALIVE, maxScan: 2 }),
    (e: unknown) => e instanceof TaskIdReservationError && /no free task id in W1-T800\.\.W1-T801/.test((e as Error).message),
    "the bound must fail loud — an unbounded loop inside a paid caller is worse than a refusal",
  );
});

test("a missing reservation directory reads as nothing reserved rather than throwing", () => {
  const dir = join(scratch(), "never-created");
  assert.deepEqual(liveReservedIds(dir), []);
  assert.equal(firstUnreservedAtOrAbove(42, dir), 42);
});

test("nextTaskIdCommand still exits 0 when the config — and so the reservation store — is unreadable", async (t) => {
  // THE CI REGRESSION (caught by `ci` on the first push of this change, missed by every scoped
  // local run because THIS host has a valid config): `loadConfig()` JSON.parses a file that a
  // fresh HOME leaves EMPTY, throwing "Unexpected end of JSON input". The reservation READ must
  // degrade to silence — an advisory verb that spawns nothing must never crash an operator's
  // query because the state directory is unreachable. The LOUD rule is for the caller about to
  // SPEND, and that path is deliberately not softened.
  const home = scratch();
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), ""); // exactly CI's shape
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
  });

  const planDir = scratch();
  mkdirSync(join(planDir, "plan"), { recursive: true });
  const planPath = join(planDir, "plan", "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T5\n");
  t.mock.method(console, "log", () => {});

  const { nextTaskIdCommand } = await import("../src/run-task.js");
  assert.equal(await nextTaskIdCommand(["--plan", planPath, "--offline"]), 0);
});

test("the reservation record is human-readable and names its purpose for the operator", () => {
  const dir = join(scratch(), "task-id-reservations");
  const handle = reserveTaskIdFrom(281, dir, { isPidAlive: ALIVE, info: { purpose: "rmd triage fb-abc (run R1)" } });
  const raw = readFileSync(handle.path, "utf8");
  assert.match(raw, /"purpose": "rmd triage fb-abc \(run R1\)"/, "an operator running `cat` must see WHO holds it and WHY");
  assert.match(raw, /"pid"/);
  assert.match(handle.path, /W1-T00281\.json$/, "zero-padded so `ls` sorts numerically");
});
