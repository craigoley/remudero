import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
type Verdict = { state: string; action: string; reason: string; generationBootMs: number | null };

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-watchdog-freshness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function launcher(t: TestContext) {
  const root = fixture(t);
  const state = join(root, "fleet");
  const bin = join(root, "stubs");
  const script = join(root, "relaunch.sh");
  const verdictFile = join(root, "verdict.json");
  for (const dir of [bin, join(state, "state"), join(state, "remudero", "bin"),
    join(state, "daemon-install", "deploy")]) mkdirSync(dir, { recursive: true });
  executable(join(bin, "git"), "exit 1");
  executable(join(bin, "docker"), 'case "$1" in ps) echo container ;; inspect) echo 1 ;; esac');
  executable(join(bin, "findmnt"), "exit 0");
  executable(join(state, "remudero", "bin", "rmd"),
    'if [ "$1" = progress-watchdog ]; then cat "$TEST_VERDICT"; else echo supervisor-reached; fi');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RMD_STATE_DIR: state,
    RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "installed-bin"),
    RMD_LAUNCHER_PATH: script, RMD_REVIVAL_LOG: join(root, "revivals"),
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"), RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    TEST_VERDICT: verdictFile,
  };
  const install = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install"], {
    cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  return (state: string, action: string) => {
    const reason = "fixture loop verdict";
    writeFileSync(verdictFile, JSON.stringify({ state, action, reason }));
    const result = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /supervisor-reached/);
    return result.stdout;
  };
}

function progress(t: TestContext) {
  const state = fixture(t);
  const row = (step: string, ageMinutes: number, extra: Row = {}): Row => ({
    ts: new Date(Date.now() - ageMinutes * 60_000).toISOString(), step, run_id: "generation", ...extra,
  });
  const boot = row("daemon.boot", 12, { actor_pid: 42 });
  const pass = row("sweep.pass", 10, { enumerated: 3, surface: "full" });
  const exit = row("daemon.freshness_exit", 6);
  const decide = (rows: Row[]): Verdict => {
    writeFileSync(join(state, "ledger.ndjson"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const result = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src/run-task.ts"),
      "progress-watchdog", "--json", "--state-root", state], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, RMD_SELF_SYNC_DONE: "1", RMD_REVIVAL_LOG: "" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  };
  return { state, row, boot, pass, exit, decide };
}

function stopped(verdict: Verdict, exit: Row): void {
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  assert.match(verdict.reason, /daemon stopped.*did not start again/);
  assert.ok(verdict.reason.includes(String(exit.ts)), verdict.reason);
}

test("W1-T12161 criterion 1: only progressing or idle with action none prints healthy", t => {
  const tick = launcher(t);
  for (const state of ["PROGRESSING", "IDLE"]) assert.match(tick(state, "none"), /\bhealthy\b/);
  for (const [state, action] of [
    ["STALLED", "capture-diagnostics"], ["STALLED", "none"], ["RECOVERING", "none"],
    ["UNKNOWN", "none"], ["IN_PASS", "capture-diagnostics"], ["IN_RECYCLE", "none"],
    ["CRASH_LOOP", "hold-revive"], ["PROGRESSING", "capture-diagnostics"], ["IDLE", "capture-diagnostics"],
  ]) {
    const output = tick(state, action);
    assert.doesNotMatch(output, /\bhealthy\b/, `${state}/${action}: ${output}`);
    assert.ok(output.includes(`${state} action=${action} -- fixture loop verdict`), output);
  }
});

test("W1-T12161 criterion 2: a freshness exit without a newer boot recycles after five minutes", t => {
  const h = progress(t);
  stopped(h.decide([h.boot, h.pass, h.exit]), h.exit);
  for (const enumerated of [0, undefined]) {
    stopped(h.decide([h.boot, { ...h.pass, enumerated }, h.exit]), h.exit);
  }
  const ordinary = (last: Row) => h.decide([h.boot, h.row("sweep.pass", 1, { enumerated: 3 }), last]);
  const young = ordinary(h.row("daemon.freshness_exit", 2));
  assert.deepEqual([young.state, young.action], ["PROGRESSING", "none"]);
  const malformed = ordinary({ ...h.exit, ts: "invalid" });
  assert.deepEqual([malformed.state, malformed.action], ["PROGRESSING", "none"]);
  const future = ordinary(h.row("daemon.freshness_exit", -60));
  assert.deepEqual([future.state, future.action], ["PROGRESSING", "none"]);
});

test("W1-T12161 criterion 3: a boot following the exit preserves the current generation verdict", t => {
  const h = progress(t);
  stopped(h.decide([h.boot, h.pass, h.exit]), h.exit);
  const boot = h.row("daemon.boot", 4, { run_id: "next-generation", actor_pid: 43 });
  for (const after of [[], [h.row("sweep.pass", 1, { enumerated: 3, surface: "full" })]]) {
    const rows = [h.boot, h.pass, boot, ...after];
    const expected = h.decide(rows);
    const actual = h.decide([h.exit, ...rows]);
    assert.deepEqual([actual.state, actual.action, actual.generationBootMs],
      [expected.state, expected.action, expected.generationBootMs]);
    assert.doesNotMatch(actual.reason, /did not start again/);
    assert.deepEqual([actual.state, actual.action], ["PROGRESSING", "none"]);
  }
});

test("W1-T12161 criterion 4: operator stops and pauses are never an unrestarted freshness exit", t => {
  const h = progress(t);
  stopped(h.decide([h.boot, h.pass, h.exit]), h.exit);
  for (const step of ["daemon.stop", "daemon.pause"]) {
    for (const exits of [[], [h.exit]]) {
      const verdict = h.decide([h.boot, h.row("sweep.pass", 1, { enumerated: 3 }),
        ...exits, h.row(step, 5, { detail: "operator request" })]);
      assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"]);
      assert.doesNotMatch(verdict.reason, /did not start again/);
    }
  }
  const tickRoot = launcher(t);
  assert.doesNotMatch(tickRoot("IN_RECYCLE", "none"), /\bhealthy\b/);
});
