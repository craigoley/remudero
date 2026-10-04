/**
 * W1-T5518 — the installer reports the legacy user janitor as drift on Linux.
 *
 * ~/bin/remudero-janitor.sh lived in no repo. It ran every 30 minutes on the Azure host from the
 * user timer azure-remudero-janitor, scanned macOS-shaped roots, removed one thing in 569 runs and
 * logged a false 20 GiB-floor EMERGENCY on each run. The operator disabled it on 2026-10-03. Its
 * two real targets (/tmp/.remudero-coverage, /tmp/.rmd-coverage) moved into deploy/rmd-tmp-sweep.sh.
 * So check mode now names the timer's unit files and enable link as drift and prints the command
 * that retires them, which means a re-enable or a reinstall can no longer happen silently.
 *
 * Every case runs the installer against a throwaway tree with a FIXTURE user-unit dir
 * (RMD_LEGACY_USER_UNIT_DIR) and a pinned kernel (RMD_HOST_KERNEL). No case reads or touches the
 * real host's ~/.config/systemd/user, its systemctl or its crontab, and the suite gives the same
 * result on the Linux CI runner and on a macOS dev machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitRepo } from "./helpers/git-repo.js";

const SCRIPT = "deploy/install-host-units.sh";
const TIMER = "azure-remudero-janitor.timer";
const SERVICE = "azure-remudero-janitor.service";
const DISABLE = "systemctl --user disable --now azure-remudero-janitor.timer";

/** Run the installer against a throwaway tree, with the legacy user-unit dir under `root` too. */
function run(args: string[], root: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "bin"),
      RMD_LAUNCHER_PATH: join(root, "rmd-relaunch.sh"),
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
      RMD_LEGACY_USER_UNIT_DIR: join(root, "home", ".config", "systemd", "user"),
      RMD_HOST_KERNEL: "Linux",
      ...env,
    },
  });
}

/** A fixture home holding the legacy janitor exactly as the Azure host had it: both unit files and
 *  the timers.target.wants link that `systemctl --user enable` makes. */
function legacyHome(root: string, opts: { enabled?: boolean } = {}): string {
  const dir = join(root, "home", ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SERVICE), "[Service]\nType=oneshot\nExecStart=%h/bin/remudero-janitor.sh --apply\n");
  writeFileSync(join(dir, TIMER), "[Timer]\nOnCalendar=*:0/30\n\n[Install]\nWantedBy=timers.target\n");
  if (opts.enabled !== false) {
    mkdirSync(join(dir, "timers.target.wants"), { recursive: true });
    symlinkSync(join(dir, TIMER), join(dir, "timers.target.wants", TIMER));
  }
  return dir;
}

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-legacy-janitor-${label}-`));
}

test("the installer reports the legacy janitor timer as drift and prints the command that retires it", () => {
  const root = scratch("drift");
  try {
    // Every repo unit is installed first, so the legacy timer is the ONLY thing that can drift.
    assert.equal(run(["--install"], root, { RMD_LEGACY_USER_UNIT_DIR: join(root, "absent") }).status, 0);
    const dir = legacyHome(root);
    const before = readdirSync(dir).sort();

    const r = run([], root);
    assert.equal(r.status, 1, `the legacy timer must count in the drift exit; got ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes(`install-host-units: LEGACY ${join(dir, TIMER)}`), r.stdout);
    assert.ok(r.stdout.includes(`install-host-units: LEGACY ${join(dir, SERVICE)}`), r.stdout);
    assert.ok(r.stdout.includes(`install-host-units: LEGACY ${join(dir, "timers.target.wants", TIMER)}`), r.stdout);
    assert.ok(r.stdout.includes(DISABLE), `the exact disable command must be printed; got ${r.stdout}`);
    assert.match(r.stderr, /3 unit\(s\) missing or drifted/, "all three legacy paths count in the drift total");
    assert.match(r.stderr, /--install does not retire/, "the summary must not offer --install as the fix");

    // REPORT ONLY: check mode never edits a user unit.
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.ok(existsSync(join(dir, "timers.target.wants", TIMER)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disabled timer whose unit files remain is still drift, because it can be re-enabled silently", () => {
  const root = scratch("disabled");
  try {
    assert.equal(run(["--install"], root, { RMD_LEGACY_USER_UNIT_DIR: join(root, "absent") }).status, 0);
    const dir = legacyHome(root, { enabled: false });
    const r = run([], root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`install-host-units: LEGACY ${join(dir, TIMER)}`), r.stdout);
    assert.ok(!r.stdout.includes("timers.target.wants"), "no enable link exists to report");
    assert.ok(r.stdout.includes(DISABLE), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installer reports nothing when the legacy janitor is absent or the host is not Linux", () => {
  const root = scratch("absent");
  try {
    assert.equal(run(["--install"], root).status, 0);
    // An existing but empty user-unit dir: the retired state the operator leaves behind.
    mkdirSync(join(root, "home", ".config", "systemd", "user"), { recursive: true });
    const clean = run([], root);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.doesNotMatch(clean.stdout, /LEGACY/);
    assert.match(clean.stdout, /all units match this repo/);

    // Systemd user units exist only on Linux; elsewhere the check never runs.
    legacyHome(root);
    const mac = run([], root, { RMD_HOST_KERNEL: "Darwin" });
    assert.equal(mac.status, 0, mac.stdout + mac.stderr);
    assert.doesNotMatch(mac.stdout, /LEGACY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install mode names the legacy janitor and never edits a user unit", () => {
  const root = scratch("install");
  try {
    const dir = legacyHome(root);
    const timerBefore = readFileSync(join(dir, TIMER), "utf8");
    const r = run(["--install"], root);
    assert.equal(r.status, 0, `the legacy janitor must not fail an install; got ${r.stderr}`);
    assert.ok(r.stdout.includes(`install-host-units: LEGACY ${join(dir, TIMER)}`), r.stdout);
    assert.ok(r.stdout.includes(DISABLE), r.stdout);
    assert.equal(readFileSync(join(dir, TIMER), "utf8"), timerBefore);
    assert.ok(existsSync(join(dir, SERVICE)));
    assert.ok(existsSync(join(dir, "timers.target.wants", TIMER)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// THE WATCHDOG TICK. The rendered launcher runs check every 5 minutes and runs `--install` on any
// drift. --install cannot retire a user unit, so without the arm below a host that still holds the
// legacy timer would reinstall every unit on every tick, forever. These cases drive the RENDERED
// launcher against a local checkout whose installer is a stub, with stub docker and sudo on PATH.

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

/** Renders the launcher for `stateDir`, places a clean checkout at `stateDir/daemon-install` whose
 *  installer prints `checkOutput` and exits 1 in check mode and writes a marker on `--install`, and
 *  runs the launcher's healthy, non-boot tick. Returns the tick's output and whether it installed. */
function tick(root: string, checkOutput: string): { stdout: string; stderr: string; installed: boolean } {
  const stateDir = join(root, "state-root");
  mkdirSync(stateDir, { recursive: true });
  const rendered = join(root, "render");
  mkdirSync(rendered, { recursive: true });
  const r = run(["--install"], rendered, { RMD_STATE_DIR: stateDir });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);

  const marker = join(root, "install-marker.txt");
  const origin = gitRepo({ bare: true, kind: "legacy-janitor-origin" });
  const seed = gitRepo({ kind: "legacy-janitor-seed" });
  mkdirSync(join(seed.dir, "deploy"), { recursive: true });
  writeExecutable(
    join(seed.dir, "deploy", "install-host-units.sh"),
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "--install" ]; then echo installed > "${marker}"; exit 0; fi\nprintf '%s\\n' ${checkOutput.split("\n").map((l) => JSON.stringify(l)).join(" ")}\nexit 1\n`,
  );
  seed.addRemote("origin", origin.dir);
  seed.git("add", ".");
  seed.git("commit", "--quiet", "-m", "installer stub");
  seed.git("push", "--quiet", "origin", "main");
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "legacy-janitor-checkout" });
  renameSync(checkout.dir, join(stateDir, "daemon-install"));

  const stubDir = join(root, "stubbin");
  mkdirSync(stubDir, { recursive: true });
  writeExecutable(join(stubDir, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = "ps" ]; then echo fake-container-id; fi\nexit 0\n`);
  writeExecutable(join(stubDir, "sudo"), `#!/usr/bin/env bash\nif [ "\${1:-}" = "-n" ]; then shift; fi\nexec "$@"\n`);

  const t = spawnSync("bash", [join(rendered, "rmd-relaunch.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.equal(t.status, 0, `launcher failed: ${t.stderr}`);
  return { stdout: t.stdout, stderr: t.stderr, installed: existsSync(marker) };
}

test("the watchdog tick does not reinstall when the only drift is the legacy janitor", () => {
  const root = scratch("tick-legacy");
  try {
    const legacyLine = `install-host-units: LEGACY /home/svc/.config/systemd/user/${TIMER}`;
    const t = tick(root, `${legacyLine}\ninstall-host-units: retire it as svc: ${DISABLE}`);
    assert.equal(t.installed, false, "--install cannot retire a user unit, so the tick must not run it");
    assert.ok(t.stderr.includes(legacyLine), `the tick must name the legacy path; got ${t.stderr}`);
    assert.ok(t.stderr.includes(DISABLE), `the tick must carry the retire command; got ${t.stderr}`);
    assert.doesNotMatch(t.stdout, /units DRIFTED at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the watchdog tick still converges real unit drift reported beside the legacy janitor", () => {
  const root = scratch("tick-mixed");
  try {
    const t = tick(
      root,
      `install-host-units: MISSING /etc/systemd/system/rmd-fleet.service\ninstall-host-units: LEGACY /home/svc/.config/systemd/user/${TIMER}`,
    );
    assert.equal(t.installed, true, "a MISSING unit beside a LEGACY one must still be installed");
    assert.match(t.stdout, /units DRIFTED at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
