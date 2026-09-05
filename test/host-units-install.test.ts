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
    for (const env of [{ RMD_STATE_DIR: "" }, { RMD_IMAGE: "" }, { RMD_SERVICE_USER: "" }]) {
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
