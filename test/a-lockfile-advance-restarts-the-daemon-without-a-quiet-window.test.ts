// 2026-10-10 on the fleet host: #10700 changed package.json/package-lock.json at 18:05Z. Every implement worktree cut
// from main then carried install inputs the daemon's install root did not, and W1-T4193 refused nine implement runs
// (W1-T7703 among them) as blocked_toolchain from 18:08 to 18:17Z. The restart that reinstalls the install root was
// already decided at 18:09Z, but W1-T6093's quiet window held it until 18:21Z. A managed-checkout refresh (W1-T4356)
// never ran: the core checkout carries no node_modules of its own, so the worktrees link the install root. An advance
// that changes the install inputs now restarts without waiting for the window.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import * as judge from "../src/lib/deploy-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MINUTE = 60_000;
const START = Date.parse("2026-10-10T18:05:00Z");
const window = { value: 10 * MINUTE, reason: "measured follow-on boots were 1–10 minutes apart" };
const LOCKFILE = [{ sha: "lock", files: ["package.json", "package-lock.json", "src/lib/sweep.ts"] }];
const ORDINARY = [{ sha: "code", files: ["src/lib/daemon.ts"] }];

test("an advance that changes the install inputs is released from the quiet window at once", () => {
  assert.equal(judge.changesInstallInputs(LOCKFILE), true);
  assert.equal(judge.changesInstallInputs([{ sha: "lock", files: ["package-lock.json"] }]), true);
  assert.equal(judge.changesInstallInputs(ORDINARY), false);
  assert.equal(judge.changesInstallInputs(undefined), false);
  assert.equal(judge.changesInstallInputs([{ sha: "nested", files: ["apps/console/package.json"] }]), false, "only the root install inputs");

  const decision = judge.decideFreshnessRestart({ changes: LOCKFILE, busy: false, staleSinceMs: 0, nowMs: MINUTE, state: { total: 0, scoredShas: [] } });
  const input = { decision, newSha: "lock", lastAdvanceAtMs: MINUTE, staleSinceMs: 0, nowMs: MINUTE, window };
  assert.equal(judge.coalesceFreshnessRestart(input).action, "hold", "the control: without the flag the window holds it");
  assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, installInputsChanged: true }), {
    action: "restart", reason: judge.INSTALL_INPUTS_RELEASE, heldMs: MINUTE, windowEndsAtMs: 11 * MINUTE,
  });

  const deferred = judge.decideFreshnessRestart({ changes: [{ sha: "low", files: ["src/lib/inbox.ts"] }], busy: true, staleSinceMs: 0, nowMs: 0, state: { total: 0, scoredShas: [] } });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, decision: deferred, installInputsChanged: true }), deferred, "a deferral stays a deferral");
});

type Row = { step: string; atMs: number; extra: Record<string, unknown> };

async function daemonRun(changesAt: (minute: number) => { sha: string; files: string[] }[]): Promise<Row[]> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}install-inputs-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let nowMs = START;
  const rows: Row[] = [];
  const summary = await runDaemon(loadPlan(path), {
    refreshMerged: () => () => true,
    runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
    now: () => new Date(nowMs),
    sleep: async () => {
      nowMs += MINUTE;
      assert.ok(nowMs <= START + 31 * MINUTE, "fake-clock fixture must terminate");
    },
    sweep: async () => ({}),
    checkFreshness: (): DaemonFreshness => {
      const changes = changesAt((nowMs - START) / MINUTE);
      return { stale: true, oldSha: "boot", newSha: changes.at(-1)!.sha, changes };
    },
    readLedgerLines: () => [],
    log: (step, extra = {}) => rows.push({ step, atMs: nowMs, extra }),
  }, { sweepWallClockBoundMs: 60 * MINUTE });
  assert.equal(summary.stopReason, "stale");
  return rows;
}

test("the daemon restarts on the first decision that sees a lockfile advance, and an ordinary advance still waits", async () => {
  const restartAt = (rows: Row[]) => rows.find((row) => row.step === "daemon.freshness_decision" && row.extra.action === "restart")!;

  const ordinary = await daemonRun(() => ORDINARY);
  assert.ok(restartAt(ordinary).atMs >= START + 10 * MINUTE, "the control: an ordinary advance waits out the window");

  // A held ordinary advance, then the lockfile lands at minute 3: the hold ends on that decision, not at minute 13.
  const rows = await daemonRun((minute) => (minute < 3 ? ORDINARY : [...ORDINARY, ...LOCKFILE]));
  const restart = restartAt(rows);
  assert.equal(restart.atMs, START + 3 * MINUTE);
  assert.equal(restart.extra.reason, judge.INSTALL_INPUTS_RELEASE);
  const release = rows.filter((row) => row.step === "daemon.freshness_coalesced").at(-1)!;
  assert.equal(release.extra.action, "restart");
  assert.equal(release.extra.reason, judge.INSTALL_INPUTS_RELEASE);
});
