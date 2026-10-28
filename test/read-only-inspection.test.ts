import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}inspection-fixture-`));
  const state = join(dir, "state");
  const home = join(dir, "home");
  const scratch = join(dir, "scratch");
  const stale = join(scratch, "rmd-inspection-stale");
  mkdirSync(state); mkdirSync(home); mkdirSync(scratch); mkdirSync(stale);
  const old = new Date(Date.now() - 2 * 86400_000);
  utimesSync(stale, old, old);
  const archive = { ts: "2026-01-01T00:00:00Z", run_id: "positive-control", step: "skills.selection",
    task_type: "implement", approved_eligible_names: ["fixture"], selected_names: ["fixture"],
    budget_omitted_names: [], withheld_names: [] };
  writeFileSync(join(state, "ledger.2026-01-02T00-00-00-000Z.ndjson.gz"), gzipSync(JSON.stringify(archive) + "\n"));
  writeFileSync(join(state, "ledger.ndjson"), JSON.stringify({ run_id: "positive-control", step: "verdict", verdict: "failed" }) + "\n");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve("src/run-task.ts"), "inspect", ...args], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: home, TMPDIR: scratch, RMD_ROOT: dir, TSX_DISABLE_CACHE: "1",
      GH_TOKEN: "", GH_APP_ID: "", GH_APP_PRIVATE_KEY: "", GH_APP_INSTALLATION_ID: "" },
  });
  return { dir, state, home, stale, run };
}

test("read-only inspection enters before housekeeping, credentials and cli.invoked writes", () => {
  const f = fixture();
  try {
    const paths = readdirSync(f.state).sort();
    const before = paths.map(p => ({ path: p, body: readFileSync(join(f.state, p)), mtime: statSync(join(f.state, p)).mtimeMs }));
    const result = f.run("--state-dir", f.state, "ledger-grep", "positive-control");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /archives:\s+1 matched/);
    assert.match(result.stdout, /matches:\s+2/);
    assert.equal(result.stderr, "");
    assert.deepEqual(readdirSync(f.state).sort(), paths);
    assert.deepEqual(readdirSync(f.home), [], "no first-run config or credential cache");
    assert.equal(existsSync(f.stale), true, "no boot temp sweep");
    for (const entry of before) {
      assert.deepEqual(readFileSync(join(f.state, entry.path)), entry.body);
      assert.equal(statSync(join(f.state, entry.path)).mtimeMs, entry.mtime);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("read-only inspection refuses lifecycle writes and an absent target without creating it", () => {
  const f = fixture();
  try {
    const result = f.run("--state-dir", f.state, "skill", "lifecycle", "fixture");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not an allowlisted/);
    const absent = f.run("--state-dir", join(f.dir, "absent"), "ledger-grep", "anything");
    assert.equal(absent.status, 2);
    assert.deepEqual(readdirSync(f.dir).sort(), ["home", "scratch", "state"]);
    assert.deepEqual(readdirSync(f.home), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("read-only inspection effectiveness sees archive selection and live verdict", () => {
  const f = fixture();
  try {
    const result = f.run("--state-dir", f.state, "skill", "effectiveness", "fixture");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /terminal_runs=1/);
    assert.match(result.stdout, /harmful_terminal_runs=1/);
    assert.match(result.stdout, /INSUFFICIENT EVIDENCE/);
    assert.deepEqual(readdirSync(f.home), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("read-only inspection help bypasses housekeeping without requiring configuration", () => {
  const f = fixture();
  try {
    for (const flag of ["--help", "-h"]) {
      const result = f.run(flag);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /rmd inspect --state-dir/);
      assert.equal(result.stderr, "");
      assert.deepEqual(readdirSync(f.home), []);
      assert.equal(existsSync(f.stale), true);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("read-only inspection rejects unsupported options, relative targets and missing archives", async () => {
  const { readOnlyInspectionCommand } = await import("#src/lib/read-only-inspection.js");
  const f = fixture();
  try {
    assert.equal(readOnlyInspectionCommand(["--state-dir", "relative", "ledger-grep", "x"]), 2);
    assert.equal(readOnlyInspectionCommand(["--state-dir", f.state, "--write", "ledger-grep", "x"]), 2);
    const empty = join(f.dir, "empty"); mkdirSync(empty);
    const result = f.run("--state-dir", empty, "skill", "effectiveness", "fixture");
    assert.equal(result.status, 1, "no archive cannot read as a small clean cohort");
    assert.match(result.stderr, /incomplete|unreadable/);
    assert.deepEqual(readdirSync(empty), []);
    assert.equal(readOnlyInspectionCommand(["--help"]), 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("read-only inspection reports an exceptional reader failure without its private message", async () => {
  const { readOnlyInspectionCommand } = await import("#src/lib/read-only-inspection.js");
  const f = fixture();
  try {
    assert.equal(readOnlyInspectionCommand(["--state-dir", f.state, "skill", "effectiveness", "fixture"],
      () => { throw new Error("private-reader-detail"); },
    ), 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
