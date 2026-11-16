import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "install-gh-read-broker.sh");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-broker-install-"));
  const home = join(dir, "home"), bin = join(dir, "bin"), checkout = join(dir, "checkout");
  mkdirSync(home); mkdirSync(bin); mkdirSync(join(checkout, "bin"), { recursive: true });
  writeFileSync(join(checkout, "bin", "rmd"), "#!/bin/sh\n"); chmodSync(join(checkout, "bin", "rmd"), 0o755);
  const calls = join(dir, "systemctl.calls");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> '${calls}'\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  const launcher = join(home, ".config", "remudero", "gh-broker-start.sh");
  const unit = join(home, ".config", "systemd", "user", "remudero-gh-read-broker.service");
  const run = (...args: string[]) => spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: dir },
  });
  const systemctl = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return { dir, checkout, launcher, unit, run, systemctl, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W1-T12072 criterion 1: --install writes the unit and launcher from an absolute checkout and a second run changes nothing", () => {
  const f = fixture();
  try {
    const first = f.run("--install", "--checkout", f.checkout);
    assert.equal(first.status, 0, first.stderr);
    const launcher = readFileSync(f.launcher, "utf8"), unit = readFileSync(f.unit, "utf8");
    assert.match(launcher, new RegExp(`^cd ${f.checkout}$`, "m"));
    assert.match(launcher, /^exec \.\/bin\/rmd gh-broker serve$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, new RegExp(`^WorkingDirectory=${f.checkout}$`, "m"));
    assert.match(unit, new RegExp(`^ExecStart=${f.launcher}$`, "m"));
    assert.ok(statSync(f.launcher).mode & 0o100, "the launcher is executable");
    assert.deepEqual(f.systemctl(), [
      "--user daemon-reload", "--user enable remudero-gh-read-broker.service", "--user restart remudero-gh-read-broker.service",
    ]);

    const before = [statSync(f.launcher).mtimeMs, statSync(f.unit).mtimeMs];
    const second = f.run("--install", "--checkout", f.checkout);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged: .*gh-broker-start\.sh/);
    assert.match(second.stdout, /unchanged: .*remudero-gh-read-broker\.service/);
    assert.equal(readFileSync(f.launcher, "utf8"), launcher);
    assert.equal(readFileSync(f.unit, "utf8"), unit);
    assert.deepEqual([statSync(f.launcher).mtimeMs, statSync(f.unit).mtimeMs], before);

    const relative = f.run("--install", "--checkout", "relative/path");
    assert.equal(relative.status, 2);
    assert.match(relative.stderr, /must be absolute/);
  } finally { f.close(); }
});

test("W1-T12072 criterion 2: --check exits non-zero naming each missing or changed file and 0 when both match", () => {
  const f = fixture();
  try {
    const missing = f.run("--check", "--checkout", f.checkout);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, new RegExp(`missing: ${f.launcher}`));
    assert.match(missing.stdout, new RegExp(`missing: ${f.unit}`));
    assert.equal(existsSync(f.launcher), false, "--check writes nothing");

    assert.equal(f.run("--install", "--checkout", f.checkout).status, 0);
    const ok = f.run("--check", "--checkout", f.checkout);
    assert.equal(ok.status, 0, ok.stdout);

    writeFileSync(f.unit, readFileSync(f.unit, "utf8").replace("on-failure", "no"));
    const changed = f.run("--check", "--checkout", f.checkout);
    assert.equal(changed.status, 1);
    assert.match(changed.stdout, new RegExp(`changed: ${f.unit}`));
    assert.doesNotMatch(changed.stdout, /gh-broker-start\.sh/);

    rmSync(f.launcher);
    const both = f.run("--check", "--checkout", f.checkout);
    assert.equal(both.status, 1);
    assert.match(both.stdout, new RegExp(`missing: ${f.launcher}`));
    assert.match(both.stdout, new RegExp(`changed: ${f.unit}`));

    assert.equal(f.run("--install", "--checkout", f.checkout).status, 0);
    assert.equal(f.run("--check", "--checkout", f.checkout).status, 0);
  } finally { f.close(); }
});

test("W1-T12072 criterion 3: the launcher and the unit hold no credential", () => {
  const f = fixture();
  try {
    assert.equal(f.run("--install", "--checkout", f.checkout).status, 0);
    for (const file of [f.launcher, f.unit]) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{10,}|github_pat_|token|secret|password|GH_TOKEN|GITHUB_TOKEN/i, file);
      assert.doesNotMatch(text, /^\s*export\s/m, `${file} sets no environment`);
    }
    assert.doesNotMatch(readFileSync(f.unit, "utf8"), /^Environment(File)?=/m);
  } finally { f.close(); }
});
