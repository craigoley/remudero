/**
 * W1-T6598 — A SUCCESSFUL STALL RECYCLE IS NOT RECYCLED AGAIN BEFORE THE NEW DAEMON'S FIRST PASS.
 *
 * OBSERVED 2026-10-08: a STALLED tick stamped watchdog-recycle-at at 20:45:44Z; its drain wait ran
 * ~31 min and the recycle finished ok at ~21:16:59Z (daemon.boot 21:17:10Z). The next tick read
 * STALLED again off the DEAD generation's 18:26:11Z sweep.pass, found the 1800 s gap expired (it ran
 * from the attempt's START), and recycled the 30-s-old daemon before its first pass.
 *
 * Two halves, each replayed here: the verdict ages a generation from its OWN boot (pure), and the
 * launcher's gap runs from the attempt's END (the REAL launcher rendered from
 * deploy/install-host-units.sh, run against a fake clock, `rmd`, `docker` and recycle-container.sh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STALL_RECYCLE_AFTER_MS,
  decideProgressWatchdog,
  openPrCountFromRows,
} from "../src/lib/progress-watchdog.js";

type Row = Record<string, unknown>;
const at = (iso: string): number => Date.parse(iso);

/** The 2026-10-08 ledger: the dead generation's last progress row, its boot, and the recycled boot. */
const DEAD_GENERATION: Row[] = [
  { ts: "2026-10-08T16:02:00.000Z", step: "daemon.paths", run_id: "d-old" },
  { ts: "2026-10-08T16:02:30.000Z", step: "daemon.boot", run_id: "d-old" },
  { ts: "2026-10-08T18:26:11.000Z", step: "sweep.pass", run_id: "d-old", enumerated: 6 },
];
const NEW_BOOT: Row[] = [
  { ts: "2026-10-08T21:17:00.000Z", step: "daemon.paths", run_id: "d-4bdd" },
  { ts: "2026-10-08T21:17:10.000Z", step: "daemon.boot", run_id: "d-4bdd" },
];

function decide(rows: Row[], nowMs: number) {
  return decideProgressWatchdog({ rows, nowMs, openPrCount: openPrCountFromRows(rows) });
}

test("replaying 2026-10-08: a tick 9 s after the recycled daemon's boot, newest progress hours old, does NOT recycle", () => {
  const rows = [...DEAD_GENERATION, ...NEW_BOOT];
  const verdict = decide(rows, at("2026-10-08T21:17:19.000Z"));
  assert.notEqual(verdict.action, "recycle", verdict.reason);
  assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"], verdict.reason);
  assert.equal(verdict.generationBootMs, at("2026-10-08T21:17:10.000Z"), "the stall is aged from this generation's own boot");
  // The dead generation's evidence is still reported for what it is -- just not charged to the new one.
  assert.ok((verdict.progressAgeMs ?? 0) > 2 * 3_600_000);
});

test("a tick while the recycled daemon is mid-boot (daemon.paths, no daemon.boot yet) does NOT recycle either", () => {
  const rows = [...DEAD_GENERATION, NEW_BOOT[0]];
  const verdict = decide(rows, at("2026-10-08T21:17:08.000Z"));
  assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"], verdict.reason);
  assert.equal(verdict.generationBootMs, at("2026-10-08T21:17:00.000Z"));
});

test("the same new generation with no progress row past STALL_RECYCLE_AFTER_MS after its own boot reads STALLED/recycle", () => {
  const rows = [...DEAD_GENERATION, ...NEW_BOOT];
  const bootMs = at("2026-10-08T21:17:10.000Z");
  const due = decide(rows, bootMs + STALL_RECYCLE_AFTER_MS + 1_000);
  assert.deepEqual([due.state, due.action], ["STALLED", "recycle"], due.reason);
  assert.equal(due.generationBootMs, bootMs);
  assert.match(due.reason, /this generation booted 30 min ago and has written no progress row/);
  // Inside the bound, past the diagnose bound: diagnostics only, measured from the boot too.
  const diagnose = decide(rows, bootMs + 16 * 60_000);
  assert.deepEqual([diagnose.state, diagnose.action], ["STALLED", "capture-diagnostics"], diagnose.reason);
});

test("a generation that has made progress is aged from that progress row again", () => {
  const rows = [...DEAD_GENERATION, ...NEW_BOOT, { ts: "2026-10-08T21:18:44.000Z", step: "sweep.pass", run_id: "d-4bdd", enumerated: 6 }];
  const verdict = decide(rows, at("2026-10-08T21:20:00.000Z"));
  assert.equal(verdict.generationBootMs, null);
  assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"]);
  assert.deepEqual([decide(rows, at("2026-10-08T21:50:00.000Z")).action], ["recycle"]);
});

test("a crash-looping generation after the recycle still reads CRASH_LOOP", () => {
  const rows = [
    ...DEAD_GENERATION,
    ...NEW_BOOT,
    { ts: "2026-10-08T21:20:00.000Z", step: "daemon.paths", run_id: "c1" },
    { ts: "2026-10-08T21:24:00.000Z", step: "daemon.paths", run_id: "c2" },
    { ts: "2026-10-08T21:28:00.000Z", step: "daemon.paths", run_id: "c3" },
  ];
  const verdict = decide(rows, at("2026-10-08T21:30:00.000Z"));
  assert.deepEqual([verdict.state, verdict.action], ["CRASH_LOOP", "hold-revive"], verdict.reason);
  assert.equal(verdict.failedBoots15m, 3);
});

// ── the launcher: WATCHDOG_RECYCLE_GAP_S runs from the attempt's END ────────────────────────────

const GAP_S = 1800;
const DRAIN_S = 31 * 60; // the observed drain wait, longer than the gap

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

interface Host {
  root: string;
  launcher: string;
  clock: string;
  marker: string;
  recycleLog: string;
  revivals: string;
  env: NodeJS.ProcessEnv;
}

/** A rendered launcher whose `date -u +%s` reads a clock file, and whose recycle advances it by DRAIN_S. */
function host(recycleExit: number): Host {
  const root = mkdtempSync(join(tmpdir(), "rmd-recovered-daemon-"));
  const stateDir = join(root, "state-root");
  const stub = join(root, "stubbin");
  const daemonTree = join(stateDir, "remudero");
  for (const dir of [join(stateDir, "state"), stub, join(stateDir, "daemon-install", "deploy"), join(daemonTree, "bin"), join(daemonTree, "src")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(daemonTree, "src", "run-task.ts"), "// fixture\n");
  const clock = join(root, "clock");
  const recycleLog = join(root, "recycle.log");
  const verdictFile = join(root, "verdict.json");
  writeFileSync(clock, `${at("2026-10-08T20:45:44.000Z") / 1000}\n`);
  writeFileSync(verdictFile, `${JSON.stringify({ state: "STALLED", action: "recycle", progressAgeMs: 8_973_000, failedBoots15m: 0, reason: "fixture" })}\n`);
  writeExecutable(join(daemonTree, "bin", "rmd"), `#!/usr/bin/env bash\nif [ "$1" = progress-watchdog ]; then cat "${verdictFile}"; fi\nexit 0\n`);
  writeExecutable(
    join(stateDir, "daemon-install", "deploy", "recycle-container.sh"),
    "#!/usr/bin/env bash\n" +
      `echo "recycle at $(cat "${clock}")" >> "${recycleLog}"\n` +
      // The drain wait: the attempt ends DRAIN_S after it started.
      `echo "$(( $(cat "${clock}") + ${DRAIN_S} ))" > "${clock}"\n` +
      (recycleExit ? `echo "recycle-container: REFUSING -- 2 worker(s) still running after the bounded wait" >&2\nexit ${recycleExit}\n` : "exit 0\n"),
  );
  const realDate = spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
  writeExecutable(join(stub, "date"), `#!/usr/bin/env bash\nif [ "$*" = "-u +%s" ]; then cat "${clock}"; else exec "${realDate}" "$@"; fi\n`);
  writeExecutable(
    join(stub, "docker"),
    ["#!/usr/bin/env bash", 'case "$1" in', "  ps) echo fake-container-id ;;", '  top) echo "PID COMMAND"; echo "1 node bin/rmd daemon" ;;', "  image) echo sha256:image-one ;;", "  inspect) echo 1 ;;", "esac", "exit 0", ""].join("\n"),
  );
  writeExecutable(join(stub, "findmnt"), "#!/usr/bin/env bash\nexit 0\n");
  const launcher = join(root, "rmd-relaunch.sh");
  const revivals = join(root, "revivals.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RMD_STATE_DIR: stateDir,
    RMD_UNIT_DIR: join(root, "systemd"),
    RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: revivals,
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
    PATH: `${stub}:${process.env.PATH ?? ""}`,
  };
  const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
  assert.equal(install.status, 0, `render failed: ${install.stderr}`);
  return { root, launcher, clock, marker: join(stateDir, "state", "watchdog-recycle-at"), recycleLog, revivals, env };
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const attempts = (h: Host): number => read(h.recycleLog).split("\n").filter((l) => l.startsWith("recycle at")).length;
const now = (h: Host): number => Number(read(h.clock).trim());
const setNow = (h: Host, s: number): void => writeFileSync(h.clock, `${s}\n`);
function tick(h: Host): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("bash", [h.launcher], { encoding: "utf8", env: h.env });
}

for (const [label, recycleExit, result] of [["ok", 0, "result=ok"], ["refused", 3, "result=refused"]] as const) {
  test(`an attempt's end stamp holds the next recycle for WATCHDOG_RECYCLE_GAP_S after the attempt ends (${label})`, () => {
    const h = host(recycleExit);
    try {
      const startS = now(h);
      const first = tick(h);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(attempts(h), 1, "the STALLED tick recycles once");
      assert.match(read(h.revivals), new RegExp(`watchdog-recycle ${result}`));
      const endS = startS + DRAIN_S;
      assert.equal(now(h), endS, "precondition: the attempt ended 31 min after it started");
      assert.equal(Number(read(h.marker).trim()), endS, "the marker carries the attempt's END, not its start");

      // 9 s after the attempt ended -- 31 min after it STARTED, past the gap counted from the start.
      setNow(h, endS + 9);
      const next = tick(h);
      assert.equal(next.status, 0, next.stderr);
      assert.equal(attempts(h), 1, "the tick 9 s after the attempt ended must not recycle again");
      assert.match(next.stdout, /a recycle ran 9s ago; at most one per 1800s/);

      // Still inside the gap one second before it closes, measured from the end.
      setNow(h, endS + GAP_S - 1);
      assert.equal(tick(h).status, 0);
      assert.equal(attempts(h), 1);
      // The gap is a bound, not a ban: once it has run from the end, the next attempt is due.
      setNow(h, endS + GAP_S);
      assert.equal(tick(h).status, 0);
      assert.equal(attempts(h), 2, "WATCHDOG_RECYCLE_GAP_S after the end, the recycle is due again");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
}
