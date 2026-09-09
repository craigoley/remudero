import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideDeployTrigger } from "../src/lib/deployer.js";

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
      // W1-T2953: the heap is a REQUIRED input now — it used to default to 4096 while the live
      // host ran 8192, so an install silently halved it. The harness states the host class it is
      // rendering for, exactly as an operator must; a case that wants the refusal overrides this
      // with "" below.
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
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
    assert.equal(countFiles(root), 7, "install must render all seven units");

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
    // W1-T2953: the heap comes from the INPUT, never a constant — it rendered 4096 by default while
    // the live host ran 8192, so an install silently halved it. This asserts the harness's declared
    // 8192 reaches the launcher; the required-input refusal is pinned separately below.
    assert.match(launcher, /max-old-space-size=8192/);
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

/** An ISO stamp `secondsAgo` in the past, in the launcher's own second-resolution format. */
function reviveStamp(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// W1-T3268 — STAMPED FROM THE CLOCK, NOT FROM A CALENDAR DATE. This read a fixed
// `"2026-09-09T02:00:00Z"`, which the recency bound added by W1-T3268 correctly reads as a
// RESOLVED incident: every case below would have reported no crash loop and passed for the wrong
// reason, or failed outright, purely because the calendar moved. A fixture the reader ages against
// the wall clock has to be written from the wall clock.
const revive = (exit: string) => `${reviveStamp(60)} revive boot=0 prev_status=exited prev_exit=${exit} prev_restarts=0`;

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

// ── W1-T2953: the renderer must not DOWNGRADE the host it claims to describe ─────────────────
//
// OBSERVED READ-ONLY ON AZURE 2026-09-06: running the tracked installer in check mode reported six
// of seven artifacts DRIFTED. The installed units carried guards the renderer did not — the
// containerd mount on the fleet and watchdog units, Docker ordering and the /mnt/rmd mount on the
// reaper, Persistent=true on its timer, and an 8192MiB heap against a rendered default of 4096. So
// `--install`, which looks like the remedy, would have DELETED all five.
//
// The fixtures below are the REAL units captured off the live host, so "check accepts the host" is
// a claim about the host and not about the renderer agreeing with itself.

// Relative, like SCRIPT above: this suite runs from the repo root.
const AZURE = join("test", "fixtures", "azure-host-units");
const AZURE_LAUNCHER_PATH = "/home/craigoleyagent/rmd-relaunch.sh";

/** The EFFECTIVE DIRECTIVES of a unit — what systemd acts on. Mirrors the installer's own
 *  `effective_directives`, which is why check no longer reports prose as drift. */
function directives(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

/** Render every unit against the live host's own inputs, into a throwaway tree. */
function renderAsAzure(root: string, extra: Record<string, string> = {}) {
  return run(["--install"], {
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_SERVICE_USER: "craigoleyagent",
    RMD_STATE_DIR: "/home/craigoleyagent/rmd-state2",
    RMD_REVIVAL_LOG: "/home/craigoleyagent/rmd-revivals.log",
    ...extra,
  }, root);
}

test("W1-T2953: check mode accepts the captured Azure host — every live guard is now rendered", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-azure-"));
  try {
    assert.equal(renderAsAzure(root).status, 0, "render must succeed with the host's own inputs");

    for (const unit of ["rmd-fleet.service", "rmd-fleet-watchdog.service", "rmd-fleet-watchdog.timer", "rmd-reap-stray.timer"]) {
      // The launcher PATH is the one legitimate difference — the fixture names the host's location
      // and the render names this throwaway tree — so it is normalised rather than ignored.
      const rendered = directives(
        readFileSync(join(root, "systemd", unit), "utf8").split(join(root, "rmd-relaunch.sh")).join(AZURE_LAUNCHER_PATH),
      );
      const live = directives(readFileSync(join(AZURE, unit), "utf8"));
      assert.deepEqual(rendered, live, `${unit}: rendered directives must equal the live host's`);
    }

    // The four guards this task exists to stop deleting, asserted by name so a future edit that
    // drops one names itself rather than showing up as an opaque diff.
    const fleet = readFileSync(join(root, "systemd", "rmd-fleet.service"), "utf8");
    const watchdog = readFileSync(join(root, "systemd", "rmd-fleet-watchdog.service"), "utf8");
    const reaperSvc = readFileSync(join(root, "systemd", "rmd-reap-stray.service"), "utf8");
    const reaperTimer = readFileSync(join(root, "systemd", "rmd-reap-stray.timer"), "utf8");
    assert.match(fleet, /RequiresMountsFor=.*\/var\/lib\/containerd/, "containerd mount on the fleet unit");
    assert.match(watchdog, /RequiresMountsFor=.*\/var\/lib\/containerd/, "containerd mount on the watchdog");
    assert.match(reaperSvc, /After=docker\.service/, "Docker ordering on the reaper");
    assert.match(reaperSvc, /RequiresMountsFor=\/mnt\/rmd/, "the reaper's own mount requirement");
    assert.match(reaperTimer, /Persistent=true/, "missed-run recovery on the reaper timer");
    assert.match(readFileSync(join(root, "rmd-relaunch.sh"), "utf8"), /max-old-space-size=8192/, "the host's heap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2953: removing any one load-bearing guard makes check report that artifact drifted", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-guard-"));
  try {
    assert.equal(renderAsAzure(root).status, 0);
    // A clean render must check CLEAN first, or every case below passes for the wrong reason.
    assert.equal(renderAsAzure(root).status, 0);
    const clean = run([], { RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_SERVICE_USER: "craigoleyagent", RMD_STATE_DIR: "/home/craigoleyagent/rmd-state2", RMD_REVIVAL_LOG: "/home/craigoleyagent/rmd-revivals.log" }, root);
    assert.equal(clean.status, 0, `a freshly rendered tree must check clean; got ${clean.stdout}${clean.stderr}`);

    const guards: [string, RegExp][] = [
      ["systemd/rmd-fleet.service", /^RequiresMountsFor=.*$/m],
      ["systemd/rmd-fleet-watchdog.service", /^RequiresMountsFor=.*$/m],
      ["systemd/rmd-reap-stray.service", /^After=docker\.service$/m],
      ["systemd/rmd-reap-stray.timer", /^Persistent=true$/m],
    ];
    for (const [rel, guard] of guards) {
      const p = join(root, rel);
      const original = readFileSync(p, "utf8");
      assert.match(original, guard, `${rel} must carry the guard before it is removed`);
      writeFileSync(p, original.replace(guard, ""), "utf8");
      const r = run([], { RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_SERVICE_USER: "craigoleyagent", RMD_STATE_DIR: "/home/craigoleyagent/rmd-state2", RMD_REVIVAL_LOG: "/home/craigoleyagent/rmd-revivals.log" }, root);
      assert.equal(r.status, 1, `${rel}: a deleted guard must fail check`);
      assert.match(r.stdout, new RegExp(`DRIFTED.*${rel.split("/").pop()!.replace(/\./g, "\\.")}`), `${rel} must be NAMED as the drifted artifact`);
      writeFileSync(p, original, "utf8");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2953: heap sizing is required and validated, never silently 4096", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-heap-"));
  try {
    // OMISSION IS A NAMED REFUSAL. It used to render 4096 while the live host ran 8192, so an
    // install would have HALVED the daemon's heap without a word — and an undersized heap is what
    // killed the retro rung for six days.
    const missing = run(["--install"], { RMD_NODE_MAX_OLD_SPACE_MB: "" }, root);
    assert.equal(missing.status, 2, "omission must refuse, not default");
    assert.match(missing.stderr, /RMD_NODE_MAX_OLD_SPACE_MB is required and has no default/);
    assert.doesNotMatch(missing.stderr + missing.stdout, /4096/, "the old silent default must not survive even as a suggestion");

    // A non-integer is still refused by name, as before.
    assert.equal(run(["--install"], { RMD_NODE_MAX_OLD_SPACE_MB: "8g" }, root).status, 2);

    // And an explicit value is what reaches the launcher — never a value read back from an already
    // installed one, which would make drift self-ratifying.
    assert.equal(renderAsAzure(root).status, 0);
    assert.match(readFileSync(join(root, "rmd-relaunch.sh"), "utf8"), /max-old-space-size=8192/);
    const other = mkdtempSync(join(tmpdir(), "rmd-hostunits-heap-alt-"));
    try {
      assert.equal(renderAsAzure(other, { RMD_NODE_MAX_OLD_SPACE_MB: "2048" }).status, 0);
      assert.match(readFileSync(join(other, "rmd-relaunch.sh"), "utf8"), /max-old-space-size=2048/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2953: the renderer emits no shell error, so its output can be trusted", () => {
  // W1-T3233 shipped a comment containing BACKTICKS inside an unquoted heredoc, so bash EXECUTED it
  // while rendering: a syntax error on stderr and the comment's text replaced by the empty output
  // of a failed command. A renderer that prints errors is not one an operator should --install.
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-clean-"));
  try {
    const r = renderAsAzure(root);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /syntax error|command not found/, `renderer stderr: ${r.stderr}`);
    assert.match(readFileSync(join(root, "rmd-relaunch.sh"), "utf8"), /--check-crash-loop <log>/, "the comment must survive rendering intact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2953: comment drift alone is NOT drift — the live reaper timer checks clean verbatim", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-prose-"));
  try {
    assert.equal(renderAsAzure(root).status, 0);
    const env = {
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
      RMD_SERVICE_USER: "craigoleyagent",
      RMD_STATE_DIR: "/home/craigoleyagent/rmd-state2",
      RMD_REVIVAL_LOG: "/home/craigoleyagent/rmd-revivals.log",
    };
    assert.equal(run([], env, root).status, 0, "a freshly rendered tree must check clean first");

    // THE REAL LIVE FILE, VERBATIM. rmd-reap-stray.timer embeds no host paths, so it can be
    // dropped in unmodified: same directives, hand-expanded comments. Under the old byte
    // comparison this read DRIFTED, and that is how four real guard deletions ended up sharing one
    // red check with two paragraphs of prose — a check nobody could act on, while `--install`
    // looked like the remedy and would have deleted the guards.
    const timerPath = join(root, "systemd", "rmd-reap-stray.timer");
    const rendered = readFileSync(timerPath, "utf8");
    const live = readFileSync(join(AZURE, "rmd-reap-stray.timer"), "utf8");
    assert.notEqual(rendered, live, "the fixture must differ from the render, or this proves nothing");
    assert.deepEqual(directives(live), directives(rendered), "...and differ ONLY in comments");

    writeFileSync(timerPath, live, "utf8");
    const r = run([], env, root);
    assert.equal(r.status, 0, `comment-only difference must check clean; got: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /ok      .*rmd-reap-stray\.timer/);

    // ...and a DIRECTIVE change in the same file is still caught, so this is narrowing to comments
    // rather than blinding the check.
    writeFileSync(timerPath, live.replace(/^Persistent=true$/m, "Persistent=false"), "utf8");
    const changed = run([], env, root);
    assert.equal(changed.status, 1, "a changed directive must still fail");
    assert.match(changed.stdout, /DRIFTED.*rmd-reap-stray\.timer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2953: every guard the LIVE launcher carries is reproduced by the renderer", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-launcher-"));
  try {
    assert.equal(renderAsAzure(root).status, 0);
    const rendered = readFileSync(join(root, "rmd-relaunch.sh"), "utf8");
    const live = readFileSync(join(AZURE, "rmd-relaunch.sh"), "utf8");

    // Captured off the host, so this asserts against what is ACTUALLY running rather than against
    // the renderer's opinion of it. Each guard was learned from a real failure and a port that
    // drops one is worse than no port — which is exactly what `--install` would have done.
    for (const [name, guard] of [
      ["STOP refusal", /state\/STOP present/],
      ["unmounted-state refusal", /is not mounted/],
      ["live-daemon idempotence", /already running -- nothing to do/],
      ["revival record", /revive boot=/],
      ["heap ceiling", /max-old-space-size=8192/],
    ] as [string, RegExp][]) {
      assert.match(live, guard, `the captured live launcher must carry the ${name} (else the fixture is wrong)`);
      assert.match(rendered, guard, `the renderer must reproduce the ${name}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T3245: the recycle folds into the watchdog's tick, and is NOT a second timer ──────────
//
// MEASURED 2026-09-09: acr-build published a new image at 11:14Z; the running container, created
// by a watchdog revival at 10:15Z, still ran the 09-06 build. The commit it was missing was the
// repair for that morning's 7h32m outage.
//
// NOTHING ON THIS HOST EVER PULLED. `rmd-relaunch.sh` reaches `docker run` with no `docker pull`,
// so a revival recreates from the CACHED image — and that is right: adopting a freshly built,
// untested image mid-crash-loop is the wrong instinct. `recycle-container.sh` does pull and refuses
// on a failed pull, but its only caller is `rmd deploy-run`, which nothing invoked.
//
// FOLDED RATHER THAN SCHEDULED SEPARATELY. Reconciliation is level-triggered: this loop already
// reads observed state and converges, so "is the image current" is the same loop asking a second
// question about the same desired state. A second timer would be a second reconciler over one
// subject.

test("W1-T3245: the watchdog tick evaluates a recycle and no second timer exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-fold-"));
  try {
    assert.equal(renderAsAzure(root).status, 0);
    const launcher = readFileSync(join(root, "rmd-relaunch.sh"), "utf8");

    // The tick asks the SUPERVISOR, which owns the idle gate, health check and rollback and reaches
    // recycle-container.sh. It must never shortcut to docker or to a bare restart.
    assert.match(launcher, /bin\/rmd" deploy-run --image-drift-only/);
    assert.doesNotMatch(launcher, /docker pull/, "the launcher itself must never pull — that is the recycle's job");

    // NO SECOND RECONCILER. The whole point of folding is one loop over one subject.
    const units = readdirSync(join(root, "systemd"));
    assert.deepEqual(
      units.filter((u) => u.startsWith("rmd-deploy")),
      [],
      "no separate deploy service or timer may be rendered",
    );
    assert.equal(units.length, 5, "the five existing units, and no more");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3245: the tick recycles for image drift and never for mount drift", () => {
  // TWO DECISIONS, NOT ONE SCORE. Mount staleness is the daemon's own freshness exit (75), tens of
  // times a day, in seconds; a second actor on that job would race it. `--image-drift-only` is what
  // makes the tick blind to it — asserted on the DECISION, not just on the rendered flag.
  const base = {
    markerPresent: false,
    autoMode: true,
    installHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    originMain: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // the checkout IS behind
    runningHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    daemonAlive: true,
    stopPresent: false,
  };

  // Mount drift alone: the operator's full reading deploys; the tick's reading does NOT.
  assert.equal(decideDeployTrigger({ ...base, imageBakedCommitsBehind: 0 }).deploy, true, "control: the full reading acts");
  const tick = decideDeployTrigger({ ...base, imageBakedCommitsBehind: 0, imageDriftOnly: true });
  assert.equal(tick.deploy, false, "the tick must leave mount staleness to the daemon");
  assert.match(tick.reason, /up-to-date/);

  // Image drift: the tick DOES act, even though the checkout is also behind.
  const drifted = decideDeployTrigger({ ...base, imageBakedCommitsBehind: 1, imageDriftOnly: true });
  assert.equal(drifted.deploy, true, "a new image is the tick's own business");
  assert.match(drifted.reason, /running image predates 1 baked-path commit/);

  // And STOP still outranks it in the tick's reading too.
  assert.equal(
    decideDeployTrigger({ ...base, imageBakedCommitsBehind: 1, imageDriftOnly: true, autoMode: false, markerPresent: false }).deploy,
    false,
    "no marker and no auto mode is still human-gated",
  );
});

test("W1-T3245: a down daemon is revived from cache, not recycled", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-hostunits-down-"));
  try {
    assert.equal(renderAsAzure(root).status, 0);
    const launcher = readFileSync(join(root, "rmd-relaunch.sh"), "utf8");

    // The recycle sits INSIDE the already-running branch. A daemon that is DOWN falls through to
    // the ordinary `docker run` from cache — deliberately, because adopting an untested image
    // mid-crash-loop is exactly when you want the known-good one.
    const running = launcher.indexOf("remudero-daemon healthy");
    const dockerRun = launcher.indexOf("docker run -d --name remudero-daemon");
    assert.ok(running > 0 && dockerRun > running, "the revive path must come AFTER the healthy branch");
    assert.match(launcher, /--boot/, "the boot path is unchanged");

    // On --boot the daemon is not running, so the recycle branch is unreachable there by
    // construction; the guard states it rather than relying on that.
    assert.match(launcher, /\[ "\$BOOT" -eq 0 \]/, "the recycle is never considered on a boot run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
