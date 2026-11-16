// W1-T10756: the fleet's heartbeat and nightly-reclaim cron lines run the CONVERGED install
// (`<state>/daemon-install`), not a checkout that stopped moving. Drives the REAL installer against a
// file-backed fake crontab (RMD_CRONTAB_CMD), the seam W1-T4770's janitor test uses, and a temp state
// dir holding a `daemon-install` fixture built with the shared gitRepo helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "install-host-units.sh");
const MEMINFO_ROOT = mkdtempSync(join(tmpdir(), "rmd-fleetcron-meminfo-"));
const MEMINFO = join(MEMINFO_ROOT, "meminfo");
writeFileSync(MEMINFO, "MemTotal:       16371996 kB\n");
const SECRET = "ghp_FIXTURE_SECRET_VALUE_0123456789";

interface Fixture {
  root: string;
  state: string;
  home: string;
  table: string;
  tokenFile: string;
  frozen: string;
  install: string;
  env: Record<string, string>;
  cron: () => string;
  run: (args: string[]) => ReturnType<typeof spawnSync<string>>;
  cleanup: () => void;
}

/** A state dir whose `daemon-install` and old `remudero` are real git checkouts, and a fake crontab. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleetcron-"));
  const state = join(root, "state");
  const home = join(root, "home");
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });
  const install = gitRepo({ kind: "fleetcron-install" });
  const frozen = gitRepo({ kind: "fleetcron-frozen" });
  symlinkSync(install.dir, join(state, "daemon-install"));
  symlinkSync(frozen.dir, join(state, "remudero"));
  const table = join(root, "crontab.txt");
  const fake = join(root, "fake-crontab");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash\ncase "$1" in\n  -l) [ -f "${table}" ] && cat "${table}" || { echo "no crontab" >&2; exit 1; } ;;\n  -) cat > "${table}" ;;\nesac\n`,
  );
  chmodSync(fake, 0o755);
  const tokenFile = join(home, ".gh-token");
  writeFileSync(tokenFile, `${SECRET}\n`, { mode: 0o600 });
  const env = {
    RMD_FLEET_CRON: "1",
    RMD_CRONTAB_CMD: fake,
    RMD_STATE_DIR: state,
    RMD_FLEET_TOKEN_FILE: tokenFile,
    RMD_FLEET_RECLAIM_LOG: join(home, "reclaim.log"),
    RMD_CLEANUP_PATH: join(home, "rmd-host-cleanup.sh"),
    HOME: home,
    GH_TOKEN: SECRET,
  };
  return {
    root,
    state,
    home,
    table,
    tokenFile,
    frozen: frozen.dir,
    install: install.dir,
    env,
    cron: () => (existsSync(table) ? readFileSync(table, "utf8") : ""),
    run: (args) =>
      spawnSync("bash", [SCRIPT, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          RMD_UNIT_DIR: join(root, "systemd"),
          RMD_BIN_DIR: join(root, "bin"),
          RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
          RMD_REVIVAL_LOG: join(root, "revivals.log"),
          RMD_NODE_MAX_OLD_SPACE_MB: "8192",
          RMD_SERVICE_UID: "42424",
          RMD_MEMINFO_PATH: MEMINFO,
          ...env,
        },
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The host's real shape: both fleet lines on the frozen checkout, their comment blocks, the janitor's
 *  line and an unrelated line. */
function seed(f: Fixture, extra = ""): string {
  const old = join(f.state, "remudero");
  return [
    "# remudero fleet heartbeat (W1-T483): scripts/fleet-heartbeat.sh every five minutes",
    `*/5 * * * * RMD_HEARTBEAT_BRANCH=heartbeat-azure RMD_ROOT=${f.state} GH_TOKEN=$(cat ${f.tokenFile}) ${old}/scripts/fleet-heartbeat.sh >/dev/null 2>&1`,
    "# nightly reclaim (W1-T2725): deploy/host-update.sh --reclaim-only",
    `17 4 * * * RMD_STATE_OFFHOST=azure-disk-snapshot:SYNTHWATCH-RG/remudero-data RMD_STATE_OFFHOST_KEEP=7 ${old}/deploy/host-update.sh --reclaim-only >> ${f.home}/reclaim.log 2>&1`,
    `1 * * * * ${f.env.RMD_CLEANUP_PATH} >> /dev/null`,
    "0 3 * * * /usr/local/bin/backup",
    ...(extra ? [extra] : []),
    "",
  ].join("\n");
}

const nonComment = (table: string): string[] => table.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
const linesRunning = (table: string, needle: string): string[] => nonComment(table).filter((l) => l.includes(needle));

test("W1-T10756: every fleet cron line converges to the install checkout with check lines", () => {
  const f = fixture();
  try {
    writeFileSync(f.table, seed(f));
    const before = f.cron();

    // CHECK: read-only, DRIFTED for both rows.
    const check = f.run([]);
    assert.equal(check.status, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /DRIFTED fleet cron heartbeat/);
    assert.match(check.stdout, /DRIFTED fleet cron reclaim/);
    assert.equal(f.cron(), before, "--check writes nothing");

    // INSTALL: the frozen lines are replaced, never joined.
    const first = f.run(["--install"]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const table = f.cron();
    const hb = linesRunning(table, "scripts/fleet-heartbeat.sh");
    const rc = linesRunning(table, "deploy/host-update.sh --reclaim-only");
    assert.equal(hb.length, 1, "exactly one heartbeat line");
    assert.equal(rc.length, 1, "exactly one reclaim line");
    const installed = join(f.state, "daemon-install");
    assert.equal(
      hb[0],
      `*/5 * * * * RMD_HEARTBEAT_BRANCH=heartbeat-azure RMD_ROOT=${f.state} GH_TOKEN=$(cat ${f.tokenFile}) ${installed}/scripts/fleet-heartbeat.sh >/dev/null 2>&1`,
    );
    assert.equal(
      rc[0],
      `17 4 * * * RMD_STATE_OFFHOST=azure-disk-snapshot:SYNTHWATCH-RG/remudero-data RMD_STATE_OFFHOST_KEEP=7 ${installed}/deploy/host-update.sh --reclaim-only >> ${f.home}/reclaim.log 2>&1`,
    );
    assert.ok(!table.includes(`${join(f.state, "remudero")}/`), "no line still runs the frozen checkout");
    assert.match(table, /# remudero fleet heartbeat/, "comment lines survive");
    assert.match(table, /# nightly reclaim/, "comment lines survive");
    assert.match(table, /\/usr\/local\/bin\/backup/, "unrelated lines survive");
    assert.equal(linesRunning(table, f.env.RMD_CLEANUP_PATH).length, 1, "the janitor keeps its one line");

    // A second install changes nothing, and check then reads ok for every row.
    const second = f.run(["--install"]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(f.cron(), table, "a second --install changes nothing");
    const after = f.run([]);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.match(after.stdout, /ok {6}fleet cron heartbeat/);
    assert.match(after.stdout, /ok {6}fleet cron reclaim/);
    assert.ok(!/DRIFTED|MISSING/.test(after.stdout), after.stdout);
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: a cron line that runs a frozen checkout reads drifted", () => {
  const f = fixture();
  try {
    const old = join(f.state, "remudero");
    const extra = `30 2 * * * ${old}/scripts/some-other-job.sh >> /dev/null 2>&1`;
    writeFileSync(f.table, seed(f, extra));
    const frozenSha = gitRepo({ cloneFrom: f.frozen }).git("rev-parse", "--short", "HEAD");

    const check = f.run([]);
    assert.equal(check.status, 1, check.stdout + check.stderr);
    const census = check.stdout.split("\n").filter((l) => l.includes("some-other-job.sh"));
    assert.equal(census.length, 1, check.stdout);
    assert.match(census[0], /DRIFTED /);
    assert.ok(census[0].includes(`runs ${old} at ${frozenSha}`), census[0]);
    assert.ok(census[0].includes("not the converged install"), census[0]);
    assert.ok(
      !check.stdout.split("\n").some((l) => l.includes("fleet-heartbeat.sh runs")),
      "a row's own line is reported by its row, not by the census",
    );

    // Reported, never rewritten: --install replaces the rows and leaves the hand-added line alone.
    const install = f.run(["--install"]);
    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.match(install.stdout, /DRIFTED .*some-other-job\.sh runs/);
    assert.ok(f.cron().includes(extra), "the hand-added line is left exactly as it was");

    // A line running the converged install itself is never flagged.
    writeFileSync(f.table, f.cron() + `45 5 * * * ${join(f.state, "daemon-install")}/scripts/ok-job.sh\n`);
    assert.ok(!f.run([]).stdout.includes("ok-job.sh runs"));
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: an empty fleet crontab reads missing for each row and renders no token value", () => {
  const f = fixture();
  try {
    assert.ok(!existsSync(f.table), "fixture sanity: the table starts empty");
    const check = f.run([]);
    assert.equal(check.status, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /MISSING fleet cron heartbeat/);
    assert.match(check.stdout, /MISSING fleet cron reclaim/);
    assert.equal(existsSync(f.table), false, "--check must not write the crontab");

    const install = f.run(["--install"]);
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const hb = linesRunning(f.cron(), "scripts/fleet-heartbeat.sh");
    assert.equal(hb.length, 1);
    assert.ok(hb[0].includes(`GH_TOKEN=$(cat ${f.tokenFile})`), hb[0]);
    for (const out of [f.cron(), install.stdout, install.stderr, check.stdout, check.stderr]) {
      assert.ok(!out.includes(SECRET), "no token VALUE is rendered or printed");
      assert.ok(!/gh[pousr]_[A-Za-z0-9]{10,}/.test(out), "nothing token-shaped is rendered");
    }

    // An unreadable token file is reported, never guessed.
    rmSync(f.tokenFile);
    const unreadable = f.run([]);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stdout, /DRIFTED fleet cron heartbeat token file .* is not readable/);
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: the field-trials line is converged only where it already exists", () => {
  const f = fixture();
  try {
    // Absent: nothing is reported and nothing is added.
    writeFileSync(f.table, "0 3 * * * /usr/local/bin/backup\n");
    const absent = f.run(["--install"]);
    assert.equal(absent.status, 0, absent.stdout + absent.stderr);
    assert.ok(!/field-trials/.test(absent.stdout), absent.stdout);
    assert.ok(!f.cron().includes("rmd-field-trials-refresh"), "never added where it is absent");

    // Present but its copy was never installed: DRIFTED, and --install converges it with its own installer.
    const line = `17 4 * * * ${f.home}/.local/bin/rmd-field-trials-refresh >> ${f.home}/.local/state/remudero/field-trials-refresh.log 2>&1 # remudero-field-trials-refresh`;
    writeFileSync(f.table, f.cron() + line + "\n");
    const drifted = f.run([]);
    assert.equal(drifted.status, 1, drifted.stdout + drifted.stderr);
    assert.match(drifted.stdout, /DRIFTED field-trials refresh/);

    const install = f.run(["--install"]);
    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.match(install.stdout, /wrote {3}field-trials refresh/);
    assert.ok(existsSync(join(f.home, ".local", "bin", "rmd-field-trials-refresh")), "its own installer copied the script");
    const after = f.run([]);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.match(after.stdout, /ok {6}field-trials refresh/);
  } finally {
    f.cleanup();
  }
});
