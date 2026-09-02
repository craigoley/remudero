import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  RUN_ID_ENV,
  TASK_ID_ENV,
  WORKER_SCOPE_ENV,
  sweepOrphanWorkers,
  workerInstallationScope,
  workerMarkerEnv,
} from "../src/lib/worker-containment.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("W1-T2693: one pure function derives a stable opaque scope and distinct configured roots do not collide", () => {
  const rootA = "/var/lib/remudero/install-a";
  const rootB = "/var/lib/remudero/install-b";
  const first = workerInstallationScope(rootA);

  assert.equal(workerInstallationScope(rootA), first, "the same configured root must keep one stable scope");
  assert.notEqual(workerInstallationScope(rootB), first, "different configured roots must not share a scope");
  assert.match(first, /^rmd-v1-[a-f0-9]{32}$/, "the scope is a versioned opaque digest");
  assert.equal(first.includes(rootA), false, "the marker must not disclose the configured root");
});

test("W1-T2693: the shared marker contract carries run, task and scope and both provider spawn paths consume it", () => {
  const scope = workerInstallationScope("/var/lib/remudero/install-a");
  assert.deepEqual(workerMarkerEnv("run-1", "W1-T2693", scope), {
    [RUN_ID_ENV]: "run-1",
    [TASK_ID_ENV]: "W1-T2693",
    [WORKER_SCOPE_ENV]: scope,
  });

  const claudeSource = readFileSync(join(repoRoot, "src/lib/worker.ts"), "utf8");
  const codexSource = readFileSync(join(repoRoot, "src/lib/worker-provider.ts"), "utf8");
  for (const [provider, source] of [["Claude", claudeSource], ["Codex", codexSource]] as const) {
    assert.match(
      source,
      /workerMarkerEnv\(args\.runId, args\.taskId, workerInstallationScope\(config\.root\)\)/,
      `${provider} must derive the marker from the same configured root at its child-env boundary`,
    );
  }
});

test("W1-T2693: foreign and missing scopes are reported and never reach signal or ledger sinks", () => {
  const expectedScope = workerInstallationScope("/var/lib/remudero/install-b");
  const foreignScope = workerInstallationScope("/var/lib/remudero/install-a");
  const killed: number[] = [];
  const ledgered: unknown[] = [];
  const report = sweepOrphanWorkers({
    expectedScope,
    listCandidates: () => [
      { pid: 101, cmdline: "foreign worker" },
      { pid: 102, cmdline: "legacy worker" },
    ],
    readMarkers: (pid) =>
      pid === 101
        ? { runId: "run-foreign", taskId: "W1-TA", scope: foreignScope }
        : { runId: "run-unscoped", taskId: "W1-TB" },
    isRunActive: () => false,
    kill: (pid) => killed.push(pid),
    ledger: (line) => ledgered.push(line),
  });

  assert.deepEqual(killed, []);
  assert.deepEqual(ledgered, []);
  assert.deepEqual(report.leftAlone, [
    { pid: 101, reason: "scope_mismatch", scope: foreignScope },
    { pid: 102, reason: "scope_missing" },
  ]);
});

test("W1-T2693: only a same-scope ended run is killed and its opaque scope reaches the existing ledger sink", () => {
  const expectedScope = workerInstallationScope("/var/lib/remudero/install-a");
  const killed: number[] = [];
  const ledgered: unknown[] = [];
  const report = sweepOrphanWorkers({
    expectedScope,
    listCandidates: () => [
      { pid: 201, cmdline: "ended worker" },
      { pid: 202, cmdline: "active worker" },
    ],
    readMarkers: (pid) => ({
      runId: pid === 201 ? "run-ended" : "run-active",
      taskId: "W1-T2693",
      scope: expectedScope,
    }),
    isRunActive: (runId) => runId === "run-active",
    kill: (pid) => killed.push(pid),
    ledger: (line) => ledgered.push(line),
  });

  assert.deepEqual(killed, [201]);
  assert.deepEqual(ledgered, [
    {
      run_id: "run-ended",
      task_id: "W1-T2693",
      worker_scope: expectedScope,
      pid: 201,
      cmdline: "ended worker",
    },
  ]);
  assert.deepEqual(report.leftAlone, [{ pid: 202, reason: "run_active", scope: expectedScope }]);
});

test("W1-T2693: daemonCommand supplies its root-derived scope while retaining the real process and signal primitives", () => {
  const source = readFileSync(join(repoRoot, "src/run-task.ts"), "utf8");
  assert.match(source, /const orphanWorkerScope = workerInstallationScope\(config\.root\)/);
  assert.match(source, /expectedScope: orphanWorkerScope/);
  assert.match(source, /listCandidates: defaultListCandidates/);
  assert.match(source, /readMarkers: defaultReadMarkers/);
  assert.match(source, /kill: \(pid\) => killProcessGroup\(pid\)/);
  assert.match(source, /daemonBoot\([\s\S]*?sweepOrphans/);
  assert.match(source, /sweepOrphans,[\s\S]*?sweepFeedbackLanding:/);
});

test("W1-T2693: the real W1-T356 daemon fixture marks its stray and asserts a foreign scoped control survives", () => {
  const source = readFileSync(join(repoRoot, "test/daemon.test.ts"), "utf8");
  assert.match(source, /\[WORKER_SCOPE_ENV\]: workerInstallationScope\(root\)/);
  assert.match(source, /\[WORKER_SCOPE_ENV\]: workerInstallationScope\(`\$\{root\}-foreign`\)/);
  assert.match(source, /foreign-scoped process must never be signalled/);
});
