// W1-T5023: fleet-liveness returned `held` the moment a STOP row followed the last heartbeat, BEFORE
// the boot-since-heartbeat crash-loop bound was read, so a daemon that kept booting after the operator's
// STOP without ever ticking stayed displayed as an intentional hold indefinitely.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeInstanceLiveness, MAX_BOOTS_WITHOUT_HEARTBEAT } from "../src/lib/fleet-liveness.js";

const CORE = { name: "console", repo: "craigoley/remudero", stateDir: "/unused" };
const T0 = Date.parse("2026-09-30T01:00:00.000Z");
const MIN = 60_000;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const sweep = (offsetMs: number) => ({ ts: at(offsetMs), step: "sweep.summary", poll_interval_ms: 60_000 });
const stop = (offsetMs: number) => ({ ts: at(offsetMs), step: "daemon.stop", detail: "operator" });
const boot = (offsetMs: number) => ({ ts: at(offsetMs), step: "cli.invoked", verb: "daemon", host: "h", actor_pid: 88 });

test("W1-T5023: boots after STOP outrank held liveness", () => {
  // A genuine quiet STOP, with no boot after it, stays held.
  const quiet = judgeInstanceLiveness(CORE, [sweep(0), stop(MIN)], T0 + 10 * MIN);
  assert.equal(quiet.state, "held");
  assert.match(quiet.reasons.join("; "), /stopped by the operator/);

  // Boots after the STOP, up to the bound, are still a hold: the bound itself is unchanged.
  const atBound = Array.from({ length: MAX_BOOTS_WITHOUT_HEARTBEAT }, (_, i) => boot(2 * MIN + i * 3 * MIN));
  assert.equal(judgeInstanceLiveness(CORE, [sweep(0), stop(MIN), ...atBound], T0 + 20 * MIN).state, "held");

  // Boots BEFORE the STOP do not count against it: only restarts after the hold are a crash loop.
  const before = Array.from({ length: MAX_BOOTS_WITHOUT_HEARTBEAT + 2 }, (_, i) => boot(i * MIN));
  assert.equal(judgeInstanceLiveness(CORE, [sweep(-MIN), ...before, stop(9 * MIN)], T0 + 12 * MIN).state, "held");

  // Past the bound, with no heartbeat since, the crash-loop state wins over the hold.
  const loop = Array.from({ length: MAX_BOOTS_WITHOUT_HEARTBEAT + 1 }, (_, i) => boot(2 * MIN + i * 3 * MIN));
  const looping = judgeInstanceLiveness(CORE, [sweep(0), stop(MIN), ...loop], T0 + 25 * MIN);
  assert.equal(looping.state, "down");
  assert.match(looping.reasons.join("; "), /booted \d+ times with no sweep between/);
  assert.doesNotMatch(looping.reasons.join("; "), /stopped by the operator/);
});
