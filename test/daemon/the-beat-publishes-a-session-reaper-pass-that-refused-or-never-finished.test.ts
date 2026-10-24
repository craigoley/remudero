/**
 * scripts/fleet-heartbeat.sh publishes `session_reaper_verdict` from the reaper's log and its unit
 * (deploy/rmd-session-reaper.sh), so a refused logind restart or a pass that never finished reaches
 * fleet-heartbeat-watch.yml off-host. Each state is driven through the real beat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBeat } from "#test/helpers/fleet-heartbeat-harness.js";

const PASS = "rmd-session-reaper: pass 2026-10-23T15:00:00Z uid=0 dry_run=0 pid=4242";
const SUMMARY = "rmd-session-reaper: sessions 3375 (closing 3371, orphans 3371); logind restarted (3375 -> 4); processes stopped 4, kept 14; last Removed session 3d 15h ago";

function beat(t: { after: (fn: () => void) => void }, log: string[] | null, unit: { active: string; result: string }, prevBeatTs?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-beat-reaper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "session-reaper.log");
  if (log) writeFileSync(logPath, log.map((l) => l + "\n").join(""));
  const systemctl = join(dir, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh\nprintf 'ActiveState=%s\\nResult=%s\\n' '${unit.active}' '${unit.result}'\n`, { mode: 0o755 });
  const b = runBeat({ env: { RMD_SESSION_REAPER_LOG: logPath, RMD_HEARTBEAT_SYSTEMCTL: systemctl }, ...(prevBeatTs ? { prevBeatTs } : {}) });
  const line = b.published.split("\n").find((l) => l.startsWith("session_reaper_verdict="));
  assert.ok(line, `the beat must publish the field: ${b.published}`);
  return line.slice("session_reaper_verdict=".length);
}

const idle = { active: "inactive", result: "success" };

test("the beat publishes a session reaper pass that refused its logind restart as REFUSED", (t) => {
  const v = beat(t, [PASS, "ORPHAN session 101: closing", "REFUSE systemd-logind.service: restarted for 1 proven orphan(s), but sessions 2 -> 2 did not drop", SUMMARY.replace("restarted (3375 -> 4)", "restarted, count did not drop (2 -> 2)")], { active: "failed", result: "exit-code" });
  assert.equal(v, "REFUSED — REFUSE systemd-logind.service: restarted for 1 proven orphan(s), but sessions 2 -> 2 did not drop");
});

test("the beat publishes a session reaper pass that ended before its summary as INCOMPLETE", (t) => {
  assert.equal(beat(t, [PASS, "KEEP pid=1: live"], idle), "INCOMPLETE — the pass started 2026-10-23T15:00:00Z ended before its summary line");
  // a pass in flight is not a finding, unless it was already running at the previous beat
  assert.equal(beat(t, [PASS], { active: "activating", result: "success" }, "2026-10-23T14:55:00Z"), "running — a pass started 2026-10-23T15:00:00Z");
  assert.equal(beat(t, [PASS], { active: "activating", result: "success" }, "2026-10-23T15:05:00Z"), "INCOMPLETE — the pass started 2026-10-23T15:00:00Z was already running at the previous beat");
});

test("the beat reads only the latest session reaper pass, and a clean one or no reaper at all is not an alarm", (t) => {
  const earlierRefusal = [PASS.replace("15:00", "14:00"), "REFUSE pass: another pass still holds the lock", "rmd-session-reaper: sessions unknown; logind not restarted"];
  assert.equal(beat(t, [...earlierRefusal, PASS, SUMMARY], idle), `ok — ${SUMMARY.slice("rmd-session-reaper: ".length)}`);
  assert.equal(beat(t, null, idle), "unknown", "a host without the reaper stays silent");
  assert.equal(beat(t, [PASS, SUMMARY], { active: "failed", result: "signal" }), "FAILED — rmd-session-reaper.service result=signal");
});
