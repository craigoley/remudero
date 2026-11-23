import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runBeat } from "#test/helpers/fleet-heartbeat-harness.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const now = Math.floor(Date.now() / 1000);
const isoAgo = (seconds: number) => new Date((now - seconds) * 1000).toISOString();
const unitTimestamp = (seconds: number) => {
  const time = new Date((now - seconds) * 1000);
  return `${time.toUTCString().slice(0, 3)} ${time.toISOString().slice(0, 19).replace("T", " ")} UTC`;
};

function timer(lastTrigger: string, interval = "5min", active = "active"): string {
  return `ActiveState=${active}
TimersMonotonic={ OnBootUSec=5min ; next_elapse=5min }
TimersMonotonic={ OnUnitActiveUSec=${interval} ; next_elapse=2h 5min }
LastTriggerUSec=${lastTrigger}`;
}

function service(start: string, timeout = "1h 15min", active = "activating", substate = "start"): string {
  return `TimeoutStartUSec=${timeout}
ExecMainStartTimestamp=${start}
SubState=${substate}
ActiveState=${active}`;
}

function publish(t: TestContext, timerOutput = "", serviceOutput = "", deployAge: number | null = 7200) {
  const systemctl = join(ownedFixtureDir(t, "supervisor-systemctl").dir, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh
case "$1 $2" in
  'show rmd-fleet-watchdog.timer') properties=$WATCHDOG_TIMER ;;
  'show rmd-fleet-watchdog.service') properties=$WATCHDOG_SERVICE ;;
  *) exit 1 ;;
esac
[ -n "$properties" ] || exit 1
shift 2
while [ "$#" -ge 2 ] && [ "$1" = '-p' ]; do
  printf '%s\\n' "$properties" | sed -n "/^$2=/p"
  shift 2
done
`, { mode: 0o755 });
  const ledger = [JSON.stringify({ ts: isoAgo(1), step: "daemon.idle" })];
  if (deployAge !== null) ledger.push(JSON.stringify({ ts: isoAgo(deployAge), step: "deploy.skip" }));
  const beat = runBeat({
    ledger,
    dateStub: `#!/bin/sh
if [ "$1 $2" = '-u +%s' ]; then printf '%s\\n' '${now}'; exit 0; fi
exec /bin/date "$@"
`,
    env: {
      RMD_HEARTBEAT_SYSTEMCTL: systemctl,
      WATCHDOG_TIMER: timerOutput,
      WATCHDOG_SERVICE: serviceOutput,
    },
  });
  assert.equal(beat.status, 0, beat.stderr);
  return Object.fromEntries(beat.published.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
  }));
}

test("W1-T13388 criterion 1: a recent watchdog trigger keeps the supervisor live and names the timer evidence", (t) => {
  const trigger = unitTimestamp(240);
  const beat = publish(t, timer(trigger));
  assert.equal(beat.supervisor_verdict, "live");
  assert.equal(beat.supervisor_source, `rmd-fleet-watchdog.timer LastTriggerUSec=${trigger} within OnUnitActiveUSec=5min`);
  assert.equal(beat.supervisor_last_age_s, "7200");
});

test("W1-T13388 criterion 2: a running oneshot within its start timeout keeps the supervisor live", (t) => {
  const start = unitTimestamp(3600);
  const beat = publish(t, timer(unitTimestamp(3600)), service(start));
  assert.equal(beat.supervisor_verdict, "live");
  assert.equal(beat.supervisor_source, `rmd-fleet-watchdog.service ExecMainStartTimestamp=${start} within TimeoutStartUSec=1h 15min`);
});

test("W1-T13388 criterion 3: changing the published cadence or timeout alone changes the verdict", (t) => {
  const trigger = unitTimestamp(330);
  assert.equal(publish(t, timer(trigger, "5min")).supervisor_verdict, "STALE — last deploy cycle 2h0m ago");
  assert.equal(publish(t, timer(trigger, "5min 30s")).supervisor_verdict, "live");

  const start = unitTimestamp(3900);
  const oldTimer = timer(start);
  assert.equal(publish(t, oldTimer, service(start, "1h")).supervisor_verdict, "STALE — last deploy cycle 2h0m ago");
  assert.equal(publish(t, oldTimer, service(start, "1h 5min")).supervisor_verdict, "live");
});

test("W1-T13388 criterion 4: a stopped or unreadable watchdog preserves the ledger verdicts", (t) => {
  const stale = "STALE — last deploy cycle 2h0m ago";
  assert.equal(publish(t, timer(unitTimestamp(301)), service(unitTimestamp(100), "1h", "inactive", "dead")).supervisor_verdict, stale);
  assert.equal(publish(t, timer("n/a")).supervisor_verdict, stale);
  assert.equal(publish(t, timer(unitTimestamp(1), "5min", "inactive")).supervisor_verdict, stale);
  assert.equal(publish(t, timer(unitTimestamp(-1))).supervisor_verdict, stale);
  const duplicateInterval = "\nTimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=2h 5min }";
  assert.equal(publish(t, timer(unitTimestamp(301)) + duplicateInterval).supervisor_verdict, stale);
  assert.equal(publish(t, timer(unitTimestamp(301)), service(unitTimestamp(1), "infinity")).supervisor_verdict, stale);
  assert.equal(publish(t).supervisor_verdict, stale);
  assert.equal(publish(t, "", "", 1200).supervisor_verdict, "live");
  assert.equal(publish(t, "", "", null).supervisor_verdict, "unknown");
});
