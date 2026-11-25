import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14780: a shifted run without test/setup/tmp-hygiene.ts wrote 2027-dated cli.invoked rows to the
// live ledger. The preload itself now refuses a non-zero shift until isolation is active.
const PRELOAD = join(REPO_ROOT, "scripts", "clock-shift.mjs");

function shiftedChild(env: NodeJS.ProcessEnv, home: string) {
  const ledger = join(home, "Remudero", "state", "ledger.ndjson");
  const body = "const fs=require('node:fs');const p=require('node:path');const f=process.argv[1];"
    + "fs.mkdirSync(p.dirname(f),{recursive:true});fs.appendFileSync(f,JSON.stringify({ts:new Date().toISOString()})+'\\n');"
    + "process.stdout.write(String(Date.now()))";
  const run = spawnSync(process.execPath, ["--import", PRELOAD, "-e", body, ledger], { encoding: "utf8", env: { ...env, HOME: home } });
  return { run, ledger };
}

test("W1-T14780: a shifted clock refuses to run without test isolation", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-shift-refusal-"));
  try {
    const { RMD_TEST_LIVE_DENY_ROOT: _deny, ...env } = process.env;
    const { run, ledger } = shiftedChild({ ...env, FK_SHIFT_DAYS: "7" }, home);
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, /tmp-hygiene\.ts/);
    assert.equal(existsSync(ledger), false, "the refusal must come before any code can append a ledger row");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T14780: a shifted clock still runs under test isolation", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-shift-isolated-"));
  try {
    const before = Date.now();
    const { run } = shiftedChild({ ...process.env, FK_SHIFT_DAYS: "7", RMD_TEST_LIVE_DENY_ROOT: join(home, "deny") }, home);
    assert.equal(run.status, 0, run.stderr);
    const days = (Number(run.stdout) - before) / 86_400_000;
    assert.ok(Math.abs(days - 7) < 1, `Date.now() moved ${days} days, expected about 7`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T14780: an unshifted preload stays inert without test isolation", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-shift-inert-"));
  try {
    const { RMD_TEST_LIVE_DENY_ROOT: _deny, FK_SHIFT_DAYS: _days, ...env } = process.env;
    const { run } = shiftedChild(env, home);
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
