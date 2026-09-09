import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "deploy/install-host-units.sh";

/** Run the installer against a throwaway tree so no test can touch real systemd. */
function run(args: string[], env: Record<string, string>, root: string) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "bin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      ...env,
    },
  });
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      try {
        if (readdirSync(p).length >= 0) walk(p);
      } catch { n += 1; }
    }
  };
  walk(dir);
  return n;
}

test("W1-T2877: check mode reports missing units and changes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-"));
  try {
    const check = run([], {}, root);
    // CHECK IS THE DEFAULT AND IT MUST BE READ-ONLY. An installer whose reporting mode mutates the
    // host cannot be run to find out whether it needs running.
    assert.equal(check.status, 1, "check on an empty tree must exit 1");
    assert.match(check.stdout, /MISSING/, "it must name what is missing");
    assert.equal(countFiles(root), 0, "check mode must create nothing");

    const install = run(["--install"], {}, root);
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);
    // W1-T3245 added rmd-deploy.service + .timer — the deliberate deploy path, which no unit on
    // this host provided. The count is asserted rather than ranged so a unit lost in a refactor is
    // a red test, which is the whole reason it was written as a count.
    assert.equal(countFiles(root), 9, "install must render all nine units");

    const after = run([], {}, root);
    assert.equal(after.status, 0, "check after install must be clean");
    assert.match(after.stdout, /all units match this repo/);

    // DRIFT IS A FINDING, NOT ONLY ABSENCE: a unit edited by hand on the host diverges from what
    // this repo would provision, which is precisely the state W1-T2877 exists to end.
    writeFileSync(join(root, "systemd", "rmd-fleet.service"), "tampered\n");
    const drifted = run([], {}, root);
    assert.equal(drifted.status, 1, "a hand-edited unit must be reported");
    assert.match(drifted.stdout, /DRIFTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2877: the rendered launcher refuses on STOP and on an unmounted state root", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-"));
  try {
    assert.equal(run(["--install"], {}, root).status, 0);
    const launcher = readFileSync(join(root, "rmd-relaunch.sh"), "utf8");

    // These four guards were each learned from a real failure; a port that drops any of them is
    // worse than no port, so they are asserted on the RENDERED text rather than trusted.
    assert.match(launcher, /state\/STOP present/, "the STOP refusal must survive rendering");
    assert.match(launcher, /is not mounted/, "the unmounted-state refusal must survive rendering");
    assert.match(launcher, /already running -- nothing to do/, "idempotence must survive rendering");
    assert.match(launcher, /revive boot=/, "the revival record must survive rendering");

    // The heap ceiling is the difference between the retro rung completing and aborting at ~2046 MB.
    assert.match(launcher, /max-old-space-size=4096/);
    // on-failure:5 is deliberate: exit 0 is a STOP and must not be undone by docker.
    assert.match(launcher, /--restart=on-failure:5/);

    // A second instance must be able to differ: the state root has to come from the input, not a
    // constant baked into the rendered file.
    const other = mkdtempSync(join(tmpdir(), "rmd-hostunits-alt-"));
    try {
      assert.equal(run(["--install"], { RMD_STATE_DIR: "/srv/other-fleet" }, other).status, 0);
      const alt = readFileSync(join(other, "rmd-relaunch.sh"), "utf8");
      assert.match(alt, /STATE_DIR=\/srv\/other-fleet/, "the state root must follow its input");
      assert.doesNotMatch(alt, /rmd-state2/, "no host-specific path may survive an override");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2877: an unresolvable host value is refused rather than guessed", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-"));
  try {
    // `${VAR-default}` not `${VAR:-default}`: the colon form would substitute this host's path for
    // an EMPTY override, silently provisioning a second machine against a volume it does not have.
    // Guessing a state root is how PAUSE and STOP end up written where nothing reads them.
    const emptyEnvCases: Array<Record<string, string>> = [
      { RMD_STATE_DIR: "" },
      { RMD_IMAGE: "" },
      { RMD_SERVICE_USER: "" },
    ];
    for (const env of emptyEnvCases) {
      const r = run([], env, root);
      assert.equal(r.status, 2, `an empty ${Object.keys(env)[0]} must be refused, not defaulted`);
      assert.match(r.stderr, /FATAL/);
    }
    // A relative state root is refused for the same reason: it resolves against whatever cwd the
    // installer happened to run from.
    assert.equal(run([], { RMD_STATE_DIR: "relative/path" }, root).status, 2);
    // A non-numeric heap ceiling would render an invalid NODE_OPTIONS and the daemon would not boot.
    assert.equal(run([], { RMD_NODE_MAX_OLD_SPACE_MB: "lots" }, root).status, 2);
    assert.equal(countFiles(root), 0, "a refused run must leave nothing behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T3233: the revival log's reader ───────────────────────────────────────────────────────
//
// `render_launcher` has appended prev_status/prev_exit/prev_restarts since W1-T2877, and nothing
// read it back. MEASURED 2026-09-09: a core.bare flag in the state checkout made entrypoint.sh
// exit 1, and the five-minute watchdog revived the container into the identical death ~90 times
// across 7h32m of total fleet downtime. docker's --restart=on-failure:5 could not bound it,
// because recreating the container RESETS RestartCount — the very fact the record exists to make
// visible.
//
// These cases drive the RENDERED launcher's `--check-crash-loop` mode against fixture logs, so the
// awk that reads the format runs for real — a source-text assertion would pass on an awk that
// matches nothing. The threshold and the revive-anyway guarantee are asserted on the rendered text
// beside them, because those two are what make this a notice rather than a bound that gives up.

/** Install into `root` and return the rendered launcher's path. */
function installedLauncher(root: string): string {
  assert.equal(run(["--install"], {}, root).status, 0);
  return join(root, "rmd-relaunch.sh");
}

/** Run the rendered launcher's read-only crash-loop probe over a fixture log. */
function checkCrashLoop(launcher: string, logLines: readonly string[], root: string): string {
  const logPath = join(root, "fixture-revivals.log");
  writeFileSync(logPath, logLines.join("\n") + (logLines.length > 0 ? "\n" : ""));
  const r = spawnSync("bash", [launcher, "--check-crash-loop", logPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  return r.stdout.trim();
}

const revive = (exit: string) => `2026-09-09T02:00:00Z revive boot=0 prev_status=exited prev_exit=${exit} prev_restarts=0`;

test("W1-T3233: a repeated identical exit is reported with its code and count", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-loop-"));
  try {
    const launcher = installedLauncher(root);

    // Five in a row is the shipped threshold — ~25 minutes at the five-minute timer cadence.
    assert.equal(checkCrashLoop(launcher, Array(5).fill(revive("1")), root), "5 1");
    // The count is the TRAILING run, not the total: an earlier, different death does not dilute it.
    assert.equal(checkCrashLoop(launcher, [revive("75"), ...Array(6).fill(revive("1"))], root), "6 1");
    // And the exit code is carried through verbatim, not normalised to a boolean.
    assert.equal(checkCrashLoop(launcher, Array(7).fill(revive("75")), root), "7 75");

    // The threshold and the announce-don't-refuse guarantee survive rendering. The second is the
    // one that matters: a watchdog that gives up on a fleet that would have recovered is strictly
    // worse than ~90 wasted revivals.
    const text = readFileSync(launcher, "utf8");
    assert.match(text, /CRASH_LOOP_RUN=5/, "the threshold must survive rendering");
    assert.match(text, /Reviving anyway; this needs a human/, "the notice must say it did not stop");
    assert.match(text, /never refuses to revive/, "the design constraint must survive rendering");
    // The count is taken AFTER the guards that outrank it, so none of their precedence changes.
    assert.ok(
      text.indexOf("state/STOP present") < text.indexOf("CRASH_LOOP_SIG="),
      "the STOP refusal must still outrank this",
    );
    assert.ok(
      text.indexOf("already running -- nothing to do") < text.indexOf("CRASH_LOOP_SIG="),
      "idempotence must still outrank this",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3233: a zero exit and a varied history report nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-quiet-"));
  try {
    const launcher = installedLauncher(root);

    // A run of ZEROS is an operator stopping and starting a healthy fleet. --restart=on-failure:5
    // is documented as deliberate precisely so exit 0 is never undone; counting it would fire the
    // notice on the one condition that is definitely fine.
    assert.equal(checkCrashLoop(launcher, Array(20).fill(revive("0")), root), "");

    // A VARIED history is a host having different problems, not one problem repeating.
    assert.equal(checkCrashLoop(launcher, [revive("1"), revive("75"), revive("1"), revive("76")], root), "1 76");

    // An empty log, and a log whose newest entries are zeros after a real loop, both report a
    // trailing run only — the signal is "dying the same way RIGHT NOW", not "ever did".
    assert.equal(checkCrashLoop(launcher, [], root), "");
    assert.equal(checkCrashLoop(launcher, [...Array(9).fill(revive("1")), revive("0")], root), "");

    // `none` is what docker inspect prints for a container that does not exist — a first boot, not
    // a crash. It must not be counted as a repeating exit code.
    assert.equal(checkCrashLoop(launcher, Array(8).fill(revive("none")), root), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T3245: the deploy supervisor, which this host never had ───────────────────────────────
//
// MEASURED 2026-09-09. `acr-build.yml` fired on #4785's merge and published a new image at 11:14Z.
// The running container was created at 10:15:01.930Z by a watchdog revival (the revival log
// carries `revive ... prev_exit=1` at 10:15:01Z), and its own /etc/rmd-build-sha still read
// c6baa842 — the 09-06 build. The commit it was missing was the repair for that morning's 7h32m
// outage.
//
// NOTHING ON THIS HOST EVER PULLED. `rmd-relaunch.sh` reaches `docker run` with no `docker pull`,
// so every revival recreates from the cached image — and that is RIGHT: adopting a freshly built,
// untested image mid-crash-loop is the wrong instinct. `deploy/recycle-container.sh` does pull and
// refuses on a failed pull, but its only executing caller is deployer.ts's recycle backend, via
// `rmd deploy-run`, and nothing under /etc/systemd/system, /etc/cron* or root's crontab invoked it.
// The gap was the trigger, not the tool.

test("W1-T3245: the renderer emits a deploy supervisor unit and timer", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-deploy-"));
  try {
    assert.equal(run(["--install"], {}, root).status, 0);

    const service = readFileSync(join(root, "systemd", "rmd-deploy.service"), "utf8");
    const timer = readFileSync(join(root, "systemd", "rmd-deploy.timer"), "utf8");

    assert.match(service, /\[Service\]/, "the service must render");
    assert.match(timer, /\[Timer\]/, "the timer must render");
    assert.match(timer, /Unit=rmd-deploy\.service/, "the timer must drive THIS service");
    assert.match(timer, /WantedBy=timers\.target/, "it must be installable as a timer");

    // Slower than the watchdog's five minutes, deliberately: reviving a dead fleet is urgent,
    // adopting a new image is not, and each fire costs a pull plus an idle-gate wait.
    assert.match(timer, /OnUnitActiveSec=30min/);

    // A second state root must produce a different unit — the path comes from the input, never a
    // constant baked into the rendered file (the same property the launcher is asserted for).
    const other = mkdtempSync(join(tmpdir(), "rmd-hostunits-deploy-alt-"));
    try {
      assert.equal(run(["--install"], { RMD_STATE_DIR: "/srv/other-fleet" }, other).status, 0);
      assert.match(readFileSync(join(other, "systemd", "rmd-deploy.service"), "utf8"), /\/srv\/other-fleet/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3245: the deploy unit runs the supervisor, never a bare restart", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-deploy-verb-"));
  try {
    assert.equal(run(["--install"], {}, root).status, 0);
    const service = readFileSync(join(root, "systemd", "rmd-deploy.service"), "utf8");

    // `rmd deploy-run` owns the idle gate, the health check and the rollback, and reaches
    // recycle-container.sh — which PULLS and refuses on a failed pull. A unit that shortcut to
    // docker or to the launcher would skip every one of those and re-run from the cached image,
    // which is precisely the state this task exists to end.
    assert.match(service, /ExecStart=.*\/bin\/rmd deploy-run$/m);
    assert.doesNotMatch(service, /ExecStart=.*docker /, "never a bare docker call");
    assert.doesNotMatch(service, /ExecStart=.*rmd-relaunch\.sh/, "never the watchdog's launcher");
    assert.doesNotMatch(service, /ExecStart=.*recycle-container\.sh/, "the supervisor reaches it, not this unit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3245: a STOP marker refuses the scheduled deploy", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-deploy-stop-"));
  try {
    assert.equal(run(["--install"], { RMD_STATE_DIR: "/srv/fleet" }, root).status, 0);
    const service = readFileSync(join(root, "systemd", "rmd-deploy.service"), "utf8");

    // The launcher's first guard is "refuses when state/STOP exists", and a scheduled deploy must
    // not become the back door around it. ExecCondition SKIPS the unit rather than failing it, so a
    // held-down fleet does not accumulate unit failures for as long as an operator holds it.
    assert.match(service, /^ExecCondition=/m, "the STOP guard must be an ExecCondition, not a failure");
    assert.match(service, /state\/STOP/, "it must test the STOP marker under the state root");
    assert.match(service, /!\s*\[ -e \/srv\/fleet\/state\/STOP \]/, "the path comes from the state root, not a constant");
    // And the guard must run BEFORE the supervisor, or it guards nothing.
    assert.ok(
      service.indexOf("ExecCondition=") < service.indexOf("ExecStart="),
      "ExecCondition must precede ExecStart",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
