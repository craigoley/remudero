// #7598 — a symlinked temp root (macOS: /var -> /private/var) must not split the paths a fixture builds
// from the paths git and the OS report back. The setup module pins TMPDIR to its real path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SETUP = pathToFileURL(join(process.cwd(), "test", "setup", "canonical-tmpdir.ts")).href;

test("#7598: a symlinked temp root is pinned to its real path before any fixture reads it", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rmd-canonical-tmp-")));
  try {
    const real = join(base, "private", "var");
    mkdirSync(real, { recursive: true });
    const linked = join(base, "var");
    symlinkSync(real, linked);
    assert.notEqual(linked, real, "positive control: the temp root is reached through a symlink");
    const { NODE_TEST_CONTEXT: _omit, ...env } = process.env;
    const run = spawnSync(process.execPath, [
      "--import", "tsx", "--import", SETUP, "--input-type=module",
      "-e", 'import { tmpdir } from "node:os"; process.stdout.write(tmpdir());',
    ], { encoding: "utf8", env: { ...env, TMPDIR: linked } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, real, "os.tmpdir() must name the real path, not the symlink");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
