/**
 * test/light-pass-ci-idle.test.ts — W1-T1211.
 *
 * The daemon's restricted light-sweep ticker (W1-T254, `buildSweepLightHook`, run-task.ts)
 * ticks WHILE `runOne` is in flight and used to gate `SweepDeps.actionable` to
 * `d => d === "post-review"` UNCONDITIONALLY — every other lane, including `dispatchFix`
 * (the "blocked-fixable"/"conflicted" dispositions), stood down for the run's ENTIRE
 * remaining duration, even once that run had nothing left to spend: a run merely polling CI
 * (`ci.polling` — no `claude` process, GitHub is the sole blocker) still parked the whole
 * repair arm for however long CI took (measured: 10-15 minutes on a working fleet; the
 * corpus this task's own rationale sized showed spans up to eight hours).
 *
 * This suite proves the fix: `fixRungMayActBesideInFlightRun` (run-task.ts) reads the
 * ledger `buildSweepLightHook` already loads — never a lock/pid probe — and the fix rung
 * (`dispatchFix`, via the "blocked-fixable"/"conflicted" dispositions) may now act ALONGSIDE
 * an in-flight run whose every open task run's latest logged phase is `ci.polling`. Every
 * other lane (arm/close/escalate/depReview) is UNCHANGED — still gated to `post-review` only.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepLightHook, fixRungMayActBesideInFlightRun } from "../src/run-task.js";

// ── acceptance claims 1/2/4 (unit slice): fixRungMayActBesideInFlightRun is a PURE fold over
// plain ledger-line objects — no fs, no pid, no `state/inflight` path anywhere in its
// signature or body — so every case below is also proof that the read is the run's own
// logged PHASE, never a process probe. ──────────────────────────────────────────────────

test("fixRungMayActBesideInFlightRun: every open task run's latest logged step is ci.polling -> true (the fix rung may act)", () => {
  const lines = [
    { task_id: "W1-TOTHER", step: "run.start" },
    { task_id: "W1-TOTHER", step: "ci.polling" },
    { task_id: "W1-TOTHER", step: "ci.polling" },
  ];
  assert.equal(fixRungMayActBesideInFlightRun(lines), true);
});

test("fixRungMayActBesideInFlightRun: an open task run whose latest logged step is NOT ci.polling -> false (still spending, stands down exactly as today)", () => {
  const lines = [
    { task_id: "W1-TOTHER", step: "run.start" },
    { task_id: "W1-TOTHER", step: "ci.polling" },
    // A later, non-ci.polling row (e.g. a fresh fix strike) — the worker is back to spending.
    { task_id: "W1-TOTHER", step: "fix.dispatch" },
  ];
  assert.equal(fixRungMayActBesideInFlightRun(lines), false);
});

test("fixRungMayActBesideInFlightRun: no run.start anywhere in the ledger -> false, the safe default when there is nothing to positively confirm as idle", () => {
  assert.equal(fixRungMayActBesideInFlightRun([]), false);
  assert.equal(fixRungMayActBesideInFlightRun([{ task_id: "W1-TOTHER", step: "ci.polling" }]), false);
});

test("fixRungMayActBesideInFlightRun: a run that logged run.start and nothing since -> false, a crashed/silent run is never mistaken for confirmed-idle", () => {
  const lines = [{ task_id: "W1-TOTHER", step: "run.start" }];
  assert.equal(fixRungMayActBesideInFlightRun(lines), false);
});

test("fixRungMayActBesideInFlightRun: a run that reached verdict is CLOSED -- an earlier, now-concluded run's ci.polling row never loosens anything for a later pass", () => {
  const lines = [
    { task_id: "W1-TOTHER", step: "run.start" },
    { task_id: "W1-TOTHER", step: "ci.polling" },
    { task_id: "W1-TOTHER", step: "verdict" },
  ];
  assert.equal(fixRungMayActBesideInFlightRun(lines), false);
});

test("fixRungMayActBesideInFlightRun: one open run polling CI and a second still spending -> false, ANY spending run stands the fix rung down", () => {
  const lines = [
    { task_id: "W1-TIDLE", step: "run.start" },
    { task_id: "W1-TIDLE", step: "ci.polling" },
    { task_id: "W1-TBUSY", step: "run.start" },
    { task_id: "W1-TBUSY", step: "recon.done" },
  ];
  assert.equal(fixRungMayActBesideInFlightRun(lines), false);
});

// ── wiring, end to end through buildSweepLightHook -- acceptance claims 1/2/3/4/5 ──────────

/** Two open PRs, mirroring test/run-task.test.ts's own `ghStubForTwoMixedDispositionPrs`
 *  fixture: #900 is checks-green + remudero-review-success (disposition "mergeable", the
 *  arm lane) and #901 is checks-red with no posted review (disposition "blocked-fixable",
 *  the fix rung `dispatchFix` drives). Every OTHER `gh` call (the live-state REST preflight,
 *  `pr view --json headRefName,body`) deliberately falls through to the generic `"{}"`
 *  fallback: `dispatchFix`'s real preflight fails OPEN on an indeterminate read
 *  (`sweep.fix.indeterminate`) and its own creditable-head check then reads `headRefName`
 *  as absent and stands down cleanly (`sweep.fix.uncreditable_head`) — reached ONLY if the
 *  light-pass gate actually let this disposition act, and reached with NO real git/worktree
 *  side effect, which is exactly what this suite needs to prove without spawning a worker. */
function twoMixedDispositionPrsGhStub(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
const a = args.join(" ");
if (a.includes("required_status_checks")) {
  process.stdout.write(JSON.stringify({ contexts: ["ci-gate", "remudero-review"] }));
  process.exit(0);
}
if (a.includes("pulls?state=open")) {
  process.stdout.write(JSON.stringify([
    {
      number: 900, html_url: "https://github.com/o/r/pull/900", state: "open",
      body: "Remudero-Task: W1-T900\\n", updated_at: "2026-08-22T00:00:00Z",
      head: { ref: "run-W1-T900-1", sha: "aaaa900000000000000000000000000000000a" },
      auto_merge: null,
    },
    {
      number: 901, html_url: "https://github.com/o/r/pull/901", state: "open",
      body: "Remudero-Task: W1-T901\\n", updated_at: "2026-08-22T00:00:00Z",
      head: { ref: "run-W1-T901-1", sha: "bbbb901000000000000000000000000000000b" },
      auto_merge: null,
    },
  ]));
  process.exit(0);
}
if (a.includes("aaaa900") && a.includes("check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] }));
  process.exit(0);
}
if (a.includes("aaaa900") && a.includes("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [{ context: "remudero-review", state: "success" }] }));
  process.exit(0);
}
if (a.includes("bbbb901") && a.includes("check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "failure" }] }));
  process.exit(0);
}
if (a.includes("bbbb901") && a.includes("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [] }));
  process.exit(0);
}
// runSweep's own W1-T177 live-state pre-flight (readLiveState, checked BEFORE dispatchFix is
// ever called) — AND dispatchFix's own W1-T177 preflight — both read exactly this REST shape
// (ghJson appends "-i" to every "gh api" call, so args[1] is matched directly rather than the
// joined+anchored string). Must answer OPEN, never the "{}" fallback, which folds to state
// "UNKNOWN" and would stand blocked-fixable down for an unrelated reason before this task's
// own gate is ever reached.
if (args[0] === "api" && typeof args[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(args[1])) {
  process.stdout.write(JSON.stringify({ state: "open", merged: false }));
  process.exit(0);
}
process.stdout.write("{}");
`;
}

function ledgerLine(taskId: string, step: string, runId = "RUN-INFLIGHT"): string {
  return JSON.stringify({ ts: new Date().toISOString(), run_id: runId, task_id: taskId, step }) + "\n";
}

async function runLightHookFixture(seedLedgerLines: string): Promise<{
  logs: Array<{ step: string; extra?: Record<string, unknown> }>;
  root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "rmd-lightpass-ci-idle-"));
  const bin = mkdtempSync(join(tmpdir(), "gh-lightpass-ci-idle-"));
  writeFileSync(join(bin, "gh"), twoMixedDispositionPrsGhStub(), { mode: 0o755 });
  const ledgerPath = join(root, "ledger.ndjson");
  if (seedLedgerLines) writeFileSync(ledgerPath, seedLedgerLines);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    const hook = buildSweepLightHook(
      "o", "r", { root } as never, ledgerPath, "RUN-LH-CI-IDLE",
      { tasks: [] } as never,
      (step, extra) => { logs.push({ step, extra }); },
    );
    await hook();
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
  return { logs, root };
}

function disposeLine(logs: Array<{ step: string; extra?: Record<string, unknown> }>, prNumber: number) {
  return logs.find((l) => l.step === "sweep.dispose" && l.extra?.pr_number === prNumber);
}

test("buildSweepLightHook (W1-T1211, acceptance 1+3): every in-flight task run's latest ledger phase is ci.polling -- the blocked-fixable PR's fix rung is no longer deferred, but the mergeable PR's arm lane still stands down", async () => {
  const seed = ledgerLine("W1-TOTHER", "run.start") + ledgerLine("W1-TOTHER", "ci.polling");
  const { logs, root } = await runLightHookFixture(seed);
  try {
    assert.ok(!logs.some((l) => l.step === "sweep_light.error"), `no internal failure; logs=${JSON.stringify(logs)}`);

    const mergeable = disposeLine(logs, 900);
    assert.ok(mergeable, "PR #900 was dispositioned");
    assert.equal(mergeable!.extra?.disposition, "mergeable");
    assert.equal(mergeable!.extra?.acted, false, "the arm lane is UNCHANGED by W1-T1211 — still deferred in the light pass");
    const mergeableNotOpen = logs.find((l) => l.step === "sweep.dispose.not_open" && l.extra?.pr_number === 900);
    assert.match(String(mergeableNotOpen?.extra?.reason), /deferred to full sweep \(light pass\)/);

    const fixable = disposeLine(logs, 901);
    assert.ok(fixable, "PR #901 was dispositioned");
    assert.equal(fixable!.extra?.disposition, "blocked-fixable");
    const fixableNotOpen = logs.find((l) => l.step === "sweep.dispose.not_open" && l.extra?.pr_number === 901);
    assert.ok(
      !fixableNotOpen || !/deferred to full sweep \(light pass\)/.test(String(fixableNotOpen.extra?.reason)),
      `PR #901's blocked-fixable disposition must NOT be gated off as "deferred to full sweep (light pass)" once every in-flight run reads ci.polling; logs=${JSON.stringify(logs)}`,
    );
    // Positive proof `dispatchFix`'s REAL closure ran (never a second, independently-built
    // reconciler) — its own preflight/creditable-head steps only ever fire from inside it.
    assert.ok(
      logs.some((l) => (l.step === "sweep.fix.indeterminate" || l.step === "sweep.fix.uncreditable_head") && l.extra?.pr_number === 901),
      `dispatchFix must have actually been invoked for PR #901; logs=${JSON.stringify(logs)}`,
    );

    // Acceptance 4 corroboration: no lock/process-probe artifact of any kind was involved —
    // this whole pass never touched `state/inflight` (the fix rung's own dispatchFix effect
    // does not create one; nothing here reads one either).
    assert.ok(!existsSync(join(root, "state", "inflight")), "no state/inflight directory was ever consulted or created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSweepLightHook (W1-T1211, acceptance 2): an in-flight task run that is still spending (latest phase recon.done, not ci.polling) -- the blocked-fixable PR's fix rung still defers exactly as today", async () => {
  const seed = ledgerLine("W1-TOTHER", "run.start") + ledgerLine("W1-TOTHER", "recon.done");
  const { logs, root } = await runLightHookFixture(seed);
  try {
    const fixable = disposeLine(logs, 901);
    assert.ok(fixable, "PR #901 was dispositioned");
    assert.equal(fixable!.extra?.acted, false, "a genuinely spending in-flight run must still stand the fix rung down");
    const fixableNotOpen = logs.find((l) => l.step === "sweep.dispose.not_open" && l.extra?.pr_number === 901);
    assert.match(
      String(fixableNotOpen?.extra?.reason),
      /deferred to full sweep \(light pass\)/,
      `PR #901 must be deferred while an in-flight run is spending; logs=${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.some((l) => l.step.startsWith("sweep.fix.") && l.extra?.pr_number === 901),
      "dispatchFix must never have been invoked while the in-flight run is spending",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSweepLightHook (W1-T1211): no ledger evidence of any in-flight run at all -- the blocked-fixable PR still defers, never loosens on missing evidence", async () => {
  const { logs, root } = await runLightHookFixture("");
  try {
    const fixable = disposeLine(logs, 901);
    assert.ok(fixable, "PR #901 was dispositioned");
    assert.equal(fixable!.extra?.acted, false);
    const fixableNotOpen = logs.find((l) => l.step === "sweep.dispose.not_open" && l.extra?.pr_number === 901);
    assert.match(String(fixableNotOpen?.extra?.reason), /deferred to full sweep \(light pass\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSweepLightHook (W1-T1211, acceptance 5): no lock is released or aged out by this path", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lightpass-ci-idle-lock-"));
  const inflightDir = join(root, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  const lockPath = join(inflightDir, "W1-TOTHER.lock");
  writeFileSync(lockPath, JSON.stringify({ run_id: "RUN-INFLIGHT", pid: 999999999 }));
  const before = { content: readFileSync(lockPath, "utf8"), mtimeMs: statSync(lockPath).mtimeMs };

  const bin = mkdtempSync(join(tmpdir(), "gh-lightpass-ci-idle-lock-"));
  writeFileSync(join(bin, "gh"), twoMixedDispositionPrsGhStub(), { mode: 0o755 });
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, ledgerLine("W1-TOTHER", "run.start") + ledgerLine("W1-TOTHER", "ci.polling"));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const hook = buildSweepLightHook(
      "o", "r", { root } as never, ledgerPath, "RUN-LH-CI-IDLE-LOCK",
      { tasks: [] } as never,
      () => {},
    );
    await hook();

    const after = { content: readFileSync(lockPath, "utf8"), mtimeMs: statSync(lockPath).mtimeMs };
    assert.deepEqual(after, before, "the in-flight lock file must be byte-identical and untouched by this path");
    assert.ok(existsSync(lockPath), "the lock was never released");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
