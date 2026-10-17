import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const INSTALLER = join(process.cwd(), "deploy/mac/install-janitor.sh");
const LAUNCHER = join(process.cwd(), "deploy/mac/remudero-mac-janitor.sh");
const run = (file: string, args: string[], home: string) => spawnSync("bash", [file, ...args], {
  encoding: "utf8", env: { ...process.env, HOME: home, REMUDERO_MAC_JANITOR_BIN: "" },
});

test("shared janitor installation includes every helper and never needs another account's home", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-shared-janitor-"));
  try {
    const shared = join(root, "Shared code");
    const home = join(root, "private operator home");
    mkdirSync(home, { mode: 0o700 });
    const installed = run(INSTALLER, ["--shared-root", shared], home);
    assert.equal(installed.status, 0, installed.stderr);
    for (const name of ["remudero-janitor.sh", "workspace-retirement-guard.sh", "dependency-seed-guard.sh", "tmp-reclaim.sh"]) {
      assert.equal(readFileSync(join(shared, "remudero-mac", name), "utf8"),
        readFileSync(join(process.cwd(), name.endsWith("guard.sh") ? "deploy" : "deploy/mac", name), "utf8"));
    }
    const launcher = join(shared, "remudero-mac-janitor.sh");
    assert.equal(readFileSync(launcher, "utf8"), readFileSync(LAUNCHER, "utf8"));
    assert.equal(existsSync(join(home, "bin")), false);
    assert.match(installed.stdout, /schedules unchanged/);
    // A private stand-in records forwarding only; no real account cleanup runs.
    const target = join(shared, "remudero-mac/remudero-janitor.sh");
    writeFileSync(target, '#!/bin/bash\nprintf "home=%s\\nargs=%s\\n" "$HOME" "$*"\n', { mode: 0o755 });
    for (const account of ["craigoley", "craigoleyagent"]) {
      const ownHome = join(root, account); mkdirSync(ownHome, { mode: 0o700 });
      const dry = run(launcher, ["--dry-run"], ownHome);
      assert.equal(dry.status, 0, dry.stderr);
      assert.equal(dry.stdout, `home=${ownHome}\nargs=--dry-run\n`);
      const scheduled = run(launcher, [], ownHome);
      assert.equal(scheduled.status, 0, scheduled.stderr);
      assert.equal(scheduled.stdout, `home=${ownHome}\nargs=--apply\n`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared janitor refuses missing code and invalid arguments before executing a target", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-shared-janitor-refuse-"));
  try {
    const launcher = join(root, "remudero-mac-janitor.sh");
    writeFileSync(launcher, readFileSync(LAUNCHER));
    const missing = run(launcher, ["--dry-run"], root);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /target unavailable/);
    mkdirSync(join(root, "remudero-mac"));
    const marker = join(root, "called");
    writeFileSync(join(root, "remudero-mac/remudero-janitor.sh"),
      `#!/bin/bash\ntouch '${marker}'\n`, { mode: 0o755 });
    for (const args of [["--apply", "extra"], ["--force"]]) {
      assert.equal(run(launcher, args, root).status, 2);
      assert.equal(existsSync(marker), false);
    }
    assert.equal(run(INSTALLER, ["--shared-root", "relative"], root).status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
