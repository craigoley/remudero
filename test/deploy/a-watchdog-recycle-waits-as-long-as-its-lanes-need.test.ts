import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as deployer from "#src/lib/deployer.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-watchdog-drain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ledger(stateDir: string, rows: Record<string, unknown>[], name = "ledger.ndjson"): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, name), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

function lock(stateDir: string, taskId: string, runId: string, startedAt: string): void {
  mkdirSync(join(stateDir, "inflight"), { recursive: true });
  writeFileSync(join(stateDir, "inflight", `${taskId}.lock`), JSON.stringify({ run_id: runId, startedAt }));
}

function verdict(t: TestContext, stateDir: string): Record<string, unknown> {
  const root = fixture(t);
  const configDir = join(root, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
  // Keep the CLI's clock identical to the fixture's without importing the entire CLI into this suite.
  const clock = `import { mock } from "node:test"; mock.timers.enable({ apis: ["Date"], now: ${Date.now()} });`;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(clock)}`,
    join(REPO_ROOT, "src/run-task.ts"), "progress-watchdog", "--json", "--state-root", stateDir,
  ], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      RMD_SELF_SYNC_DONE: "1", RMD_INSTANCE_REGISTRY: undefined },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function observed(t: TestContext, stateDir: string): void {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const stamp = (ageS: number): string => new Date(now - ageS * 1000).toISOString();
  ledger(stateDir, [
    { ts: stamp(2400), step: "sweep.pass", enumerated: 3 },
    { ts: stamp(1), step: "daemon.pulse" },
  ]);
  ledger(stateDir, [
    { ts: stamp(172800), step: "implement.done", worker_duration_ms: 7_200_000 },
    { ts: stamp(172800), step: "implement.done", worker_duration_ms: 10_800_000 },
    { ts: stamp(100), step: "verdict", run_id: "settled" },
  ], "ledger.2026-01-01.ndjson");
  lock(stateDir, "young", "young", stamp(60));
  lock(stateDir, "old", "old", stamp(600));
  lock(stateDir, "settled", "settled", stamp(1));
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function launcher(t: TestContext, progress: Record<string, unknown>) {
  const root = fixture(t);
  const stateRoot = join(root, "state-root");
  const bin = join(root, "stubs");
  const script = join(root, "rmd-relaunch.sh");
  const receipt = join(root, "recycle-wait");
  for (const dir of [bin, join(stateRoot, "state"), join(stateRoot, "remudero", "bin"),
    join(stateRoot, "daemon-install", "deploy")]) mkdirSync(dir, { recursive: true });
  const verdictFile = join(root, "verdict.json");
  writeFileSync(verdictFile, JSON.stringify(progress));
  executable(join(stateRoot, "remudero", "bin", "rmd"),
    'if [ "$1" = progress-watchdog ]; then cat "$TEST_VERDICT"; fi');
  executable(join(stateRoot, "daemon-install", "deploy", "recycle-container.sh"),
    'printf \'%s\\n\' "${RMD_RECYCLE_WAIT_S:-3000}" > "$TEST_RECEIPT"');
  executable(join(bin, "docker"), 'case "$1" in ps) echo fake-container ;; inspect) echo 1 ;; esac');
  executable(join(bin, "findmnt"), "exit 0");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RMD_STATE_DIR: stateRoot,
    RMD_UNIT_DIR: join(root, "systemd"), RMD_BIN_DIR: join(root, "bin"),
    RMD_LAUNCHER_PATH: script, RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_CASH_SECRET_DIR: join(root, "no-secrets"), RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_RECYCLE_WAIT_S: undefined, TEST_VERDICT: verdictFile, TEST_RECEIPT: receipt,
  };
  const install = spawnSync("bash", [join(REPO_ROOT, "deploy/install-host-units.sh"), "--install"], {
    cwd: REPO_ROOT, env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  return { env, script, receipt };
}

describe("test/deploy/a-watchdog-recycle-waits-as-long-as-its-lanes-need.test.ts", () => {
  test("the shared lane reader excludes settled runs and retains failed yields", t => {
    const stateDir = fixture(t);
    const now = Date.now();
    const stamp = (ageS: number) => new Date(now - ageS * 1000).toISOString();
    for (const id of ["active", "verdict", "handoff", "ended", "failed"]) lock(stateDir, id, id, stamp(60));
    lock(stateDir, "future", "future", stamp(-60));
    lock(stateDir, "unknown-age", "unknown-age", "invalid");
    writeFileSync(join(stateDir, "inflight", "broken.lock"), "{");
    writeFileSync(join(stateDir, "inflight", "unshaped.lock"), "{}");
    writeFileSync(join(stateDir, "inflight", "ignored.txt"), "{}");
    const text = [
      { step: "verdict", run_id: "verdict" },
      { step: "run.freshness_handoff", run_id: "handoff" },
      { step: "worker.recycle_yield", run_id: "ended", decision: "acted" },
      { step: "worker.recycle_yield", run_id: "failed", decision: "action_failed" },
    ].map(row => JSON.stringify(row)).join("\n");
    assert.equal(typeof deployer.readDrainWaitLanes, "function");
    assert.deepEqual(deployer.readDrainWaitLanes(stateDir, text, () => now).sort((a, b) => a.runId.localeCompare(b.runId)), [
      { runId: "active", taskId: "active", ageS: 60 },
      { runId: "failed", taskId: "failed", ageS: 60, judged: "end_failed" },
      { runId: "future", taskId: "future", ageS: 0 },
      { runId: "unknown-age", taskId: "unknown-age", ageS: 0 },
    ]);
  });

  test("watchdog json derives its wait from archived durations and the longest lane remainder", t => {
    const stateDir = fixture(t);
    observed(t, stateDir);
    const first = verdict(t, stateDir);
    assert.equal(first.action, "recycle");
    assert.equal(first.drainWaitS, 10_740);
    assert.equal(first.drainWaitSource, "observed");
    rmSync(join(stateDir, "inflight", "young.lock"));
    assert.equal(verdict(t, stateDir).drainWaitS, 10_200);
  });

  test("watchdog json labels no history and beyond-history fallbacks", t => {
    const stateDir = fixture(t);
    assert.equal(verdict(t, stateDir).drainWaitS, 3000);
    assert.equal(verdict(t, stateDir).drainWaitSource, "no_history_fallback");
    ledger(stateDir, [{ ts: new Date().toISOString(), step: "implement.done", worker_duration_ms: 1000 }]);
    lock(stateDir, "older", "older", new Date(Date.now() - 60_000).toISOString());
    assert.equal(verdict(t, stateDir).drainWaitS, 3000);
    assert.equal(verdict(t, stateDir).drainWaitSource, "observed_with_fallback_lane");
  });

  for (const override of [undefined, "", "7777"]) {
    test(`the rendered launcher forwards the derived wait with override ${JSON.stringify(override)}`, t => {
      const stateDir = fixture(t);
      observed(t, stateDir);
      const progress = verdict(t, stateDir);
      const h = launcher(t, progress);
      const result = spawnSync("bash", [h.script], {
        env: { ...h.env, RMD_RECYCLE_WAIT_S: override }, encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(h.receipt, "utf8").trim(), override || "10740");
    });
  }

  test("a verdict without a derived wait preserves the script fallback", t => {
    const h = launcher(t, { state: "STALLED", action: "recycle", progressAgeMs: 2_400_000 });
    const result = spawnSync("bash", [h.script], { env: h.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(h.receipt, "utf8").trim(), "3000");
  });

  test("a progressing verdict does not recycle", t => {
    const h = launcher(t, { state: "PROGRESSING", action: "none", drainWaitS: 10_740 });
    const result = spawnSync("bash", [h.script], { env: h.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(h.receipt), false);
  });
});
