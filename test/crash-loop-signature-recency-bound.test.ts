import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W1-T3268 — A CRASH-LOOP RUN MUST BE CONTIGUOUS IN TIME, NOT ONLY IN THE FILE.
//
// MEASURED ON THE LIVE AZURE HOST 2026-09-09T19:18Z, minutes after `--install` first commissioned
// W1-T3233's reader against real data:
//
//     $ rmd-relaunch.sh --check-crash-loop /home/craigoleyagent/rmd-revivals.log
//     88 1
//
// while `docker inspect remudero-daemon` read `running`, `RestartCount=0`, started 25 minutes
// earlier. The 88 records were that morning's RESOLVED incident — trailing record 10:15:01Z, nine
// hours before the read. The reader counted a trailing run of identical non-zero exits with no time
// bound, and the revival log is append-only for the life of the host, so a resolved incident stayed
// armed forever: the next ordinary exit-1 revival would have made it 89 and raised
// DAEMON_CRASH_LOOP on a single transient.
//
// These cases drive the RENDERED launcher's `--check-crash-loop` probe against fixture logs, so the
// awk that reads the format runs for real. A source-text assertion would pass on an awk that
// matches nothing — and `mktime` is a gawk extension that is silently absent on other awks, which
// is precisely the shape of zero this task exists to end.

const SCRIPT = "deploy/install-host-units.sh";
const TICK_S = 300; // the watchdog timer's cadence — revivals inside a live loop are ~5min apart
const CEILING_S = 1800; // CRASH_LOOP_GAP_S: six ticks

function installedLauncher(root: string): string {
  const r = spawnSync("bash", [SCRIPT, "--install"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "bin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    },
  });
  assert.equal(r.status, 0, `install failed: ${r.stderr}`);
  // The renderer must not execute anything while rendering — an unescaped backtick inside the
  // unquoted heredoc would run as a command substitution and silently ship its empty output.
  assert.doesNotMatch(r.stderr, /syntax error|command not found/, `renderer stderr: ${r.stderr}`);
  return join(root, "rmd-relaunch.sh");
}

/** An ISO stamp `secondsAgo` in the past, in the launcher's own second-resolution format. */
function stamp(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `count` revivals of `exit`, one tick apart, the newest `endingSecondsAgo` in the past. */
function run(count: number, exit: string, endingSecondsAgo: number): string[] {
  const lines: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    lines.push(`${stamp(endingSecondsAgo + i * TICK_S)} revive boot=0 prev_status=exited prev_exit=${exit} prev_restarts=5`);
  }
  return lines;
}

function probe(launcher: string, lines: readonly string[], root: string): { out: string; status: number | null } {
  const logPath = join(root, "fixture-revivals.log");
  writeFileSync(logPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  const r = spawnSync("bash", [launcher, "--check-crash-loop", logPath], { encoding: "utf8" });
  return { out: r.stdout.trim(), status: r.status };
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-crashloop-recency-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T3268: a dense run whose newest record is older than the ceiling reports NO crash loop — the 88-record case measured on the live host", () => {
  withRoot((root) => {
    const launcher = installedLauncher(root);

    // The production shape, faithfully: 88 consecutive exit-1 revivals at the timer's own cadence,
    // the newest of them NINE HOURS old. Before this change the reader answered "88 1" here.
    const resolvedIncident = run(88, "1", 9 * 60 * 60);
    assert.equal(probe(launcher, resolvedIncident, root).out, "", "a resolved incident must report nothing at all");

    // The boundary itself, from both sides, so the ceiling is pinned rather than merely cleared by
    // a nine-hour margin.
    assert.equal(probe(launcher, run(6, "1", CEILING_S + 120), root).out, "", "past the ceiling is resolved");
    assert.notEqual(probe(launcher, run(6, "1", CEILING_S - 120), root).out, "", "inside the ceiling is still live");
  });
});

test("W1-T3268: a dense RECENT run still reports its count and exit code — the signal is narrowed, not removed", () => {
  withRoot((root) => {
    const launcher = installedLauncher(root);

    // W1-T3233's contract, unchanged, for a loop that is happening NOW.
    assert.equal(probe(launcher, run(5, "1", 60), root).out, "5 1", "the shipped five-in-a-row threshold still fires");
    assert.equal(probe(launcher, run(7, "75", 60), root).out, "7 75", "and the exit code is carried verbatim, not normalised");

    // An earlier, DIFFERENT death still does not dilute the trailing run.
    assert.equal(probe(launcher, [...run(1, "75", 60 + 6 * TICK_S), ...run(6, "1", 60)], root).out, "6 1");
  });
});

test("W1-T3268: a gap wider than the ceiling ENDS the run, so two incidents sharing an exit code are never summed", () => {
  withRoot((root) => {
    const launcher = installedLauncher(root);

    // Four revivals from exit 1 six hours ago, then four more from exit 1 just now. Contiguous in
    // the FILE and identical in exit code, but two separate incidents — the answer is 4, never 8.
    const twoIncidents = [...run(4, "1", 6 * 60 * 60), ...run(4, "1", 60)];
    assert.equal(probe(launcher, twoIncidents, root).out, "4 1", "only the recent incident counts");
  });
});

test("W1-T3268: the launcher clears DAEMON_CRASH_LOOP on the idempotent healthy path, so a raised flag has a path back", () => {
  withRoot((root) => {
    const text = readFileSync(installedLauncher(root), "utf8");

    // THE DEFECT: the arm that cleared the flag sat on the REVIVAL path, after the idempotence
    // check that returns on a healthy daemon — so a host that recovered stopped reviving and never
    // reached the clear. The flag stood through full recovery.
    //
    // Asserted on the rendered text because reaching this branch for real needs a docker daemon and
    // a live container; what must be true is an ORDERING, and the ordering is what is checked.
    const healthyBranch = text.slice(
      text.indexOf("if [ -n \"$(docker ps -q -f name='^remudero-daemon$'"),
      text.indexOf("# REFUSE AGAINST AN UNMOUNTED STATE ROOT"),
    );
    assert.ok(healthyBranch.length > 0, "the idempotent healthy branch must be locatable in the rendered launcher");
    assert.match(healthyBranch, /rm -f "\$STATE_DIR\/state\/DAEMON_CRASH_LOOP"/, "the healthy path must retract the alarm");
    assert.ok(
      healthyBranch.indexOf("DAEMON_CRASH_LOOP") < healthyBranch.indexOf("exit 0"),
      "and it must clear BEFORE the early return, or the branch exits without ever reaching it",
    );
  });
});

test("W1-T3268: the reader still ANNOUNCES and never refuses — no input to the signature can stop a revival", () => {
  withRoot((root) => {
    const launcher = installedLauncher(root);

    // W1-T3233's own guarantee: "a bound that gives up is strictly worse than the problem." This
    // task narrows what counts as a loop; it must not turn the notice into a refusal.
    for (const lines of [[], run(1, "1", 60), run(500, "1", 60), run(88, "1", 9 * 60 * 60)]) {
      assert.equal(probe(launcher, lines, root).status, 0, "the probe exits 0 for every shape of log");
    }

    const text = readFileSync(installedLauncher(root), "utf8");
    const crashLoopArm = text.slice(text.indexOf("CRASH_LOOP_SIG="), text.indexOf("# --restart=on-failure:5 IS DELIBERATE"));
    assert.ok(crashLoopArm.length > 0, "the crash-loop arm must be locatable");
    assert.doesNotMatch(crashLoopArm, /^\s*exit\s/m, "nothing on the crash-loop path may exit — it announces, then the revive below happens regardless");

    // A malformed stamp must degrade to "no crash loop", never to a crash or a refusal.
    const malformed = ["not-a-timestamp revive boot=0 prev_status=exited prev_exit=1 prev_restarts=5"];
    assert.equal(probe(launcher, malformed, root).status, 0, "a malformed record must not break the probe");
  });
});
