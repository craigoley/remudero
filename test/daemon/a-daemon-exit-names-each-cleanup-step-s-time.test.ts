// W1-T14762: a daemon's exit times each resource close and names them before the drain lock's release, because the
// successor waits on that lock (67 s on the 11-24 22:12Z hand-over) and no row said which close held it out.
import assert from "node:assert/strict";
import test from "node:test";
import { closeDaemonCleanup } from "#src/cli/commands/daemon.js";

type Row = { step: string } & Record<string, unknown>;

/** Three resources pushed in boot order, each close advancing a fake clock by its own amount. */
async function timedExit(): Promise<{ rows: Row[]; events: string[] }> {
  const rows: Row[] = [];
  const events: string[] = [];
  let nowMs = 0;
  const closing = (resource: string, ms: number) => ({ resource, close: async () => { events.push(resource); nowMs += ms; } });
  await closeDaemonCleanup(
    [closing("drain_lock", 1), closing("claim_sweep", 40), closing("read_plane", 2),
      { resource: "git_credential_socket", close: () => { events.push("git_credential_socket"); nowMs += 5; throw new Error("busy"); } }],
    (step, extra = {}) => { rows.push({ step, ...extra }); events.push(`row:${step}`); },
    { now: () => nowMs },
  );
  return { rows, events };
}

test("W1-T14762 an exit writes each cleanup step's duration before releasing the drain lock", async () => {
  const { rows, events } = await timedExit();
  const timed = rows.filter((row) => row.step === "daemon.exit_cleanup");
  assert.equal(timed.length, 1, "one timing row per exit");
  assert.deepEqual(timed[0], { step: "daemon.exit_cleanup", git_credential_socket_ms: 5, read_plane_ms: 2, claim_sweep_ms: 40,
    total_ms: 47, released_last: "drain_lock" });
  assert.ok(events.indexOf("row:daemon.exit_cleanup") < events.indexOf("drain_lock"), "the row is written before the lock is released");
});

test("W1-T14762 a timed exit still releases the drain lock last", async () => {
  const { events } = await timedExit();
  assert.deepEqual(events.filter((event) => !event.startsWith("row:")),
    ["git_credential_socket", "read_plane", "claim_sweep", "drain_lock"], "reverse order, a failed close skips no sibling");
  assert.ok(events.indexOf("row:daemon.cleanup_failed") > -1, "the failed close is still reported");
  assert.equal(events.at(-1), "drain_lock", "the lock is the last thing the exit does");
});
