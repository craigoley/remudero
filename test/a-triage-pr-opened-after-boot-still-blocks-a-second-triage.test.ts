// #10265 (2026-10-09): feedback fb-1789927308301-29a363 was triaged twice. The first triage opened #10255 at 05:04,
// the second fired at 05:22 while #10255 was still open. The in-flight guard reads `isFeedbackOpenPr`, which answers
// from a once-per-boot snapshot of open PRs (daemon booted 04:49), so a triage PR opened after boot was invisible.
// This boot's own `pr.opened` row names it; the guard now reads it when the snapshot misses.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const FEEDBACK = "fb-1789927308301-29a363";

function plan(dir: string): string {
  const f = join(dir, "tasks.yaml");
  // Two tasks on one file, so the deferral the auto-triage rung gates on persists (see triage-inflight-dedup.test.ts).
  writeFileSync(f,
    "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n" +
    "- id: T2\n  title: t2\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n");
  return f;
}

async function drive(ledgerLines: string[], liveState: string) {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-triage-after-boot-"));
  try {
    let fires = 0;
    let checks = 0;
    const liveReads: number[] = [];
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    await runDaemon(loadPlan(plan(dir)), {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, ok: true, merged: true }) as never,
      checkStop: () => (++checks > 3 ? "test bound reached" : undefined),
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: FEEDBACK, reason: "idle" }),
      runAutoTriage: async () => { fires++; },
      // The boot snapshot was taken before the first triage opened its PR.
      isFeedbackOpenPr: () => undefined,
      readFeedbackLiveState: (_id: string, pr: number) => {
        liveReads.push(pr);
        return pr === 10255 ? liveState : undefined;
      },
      readLedgerLines: () => ledgerLines,
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    }, { laneCount: 2 });
    return { fires, lines, liveReads };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OPENED = JSON.stringify({
  ts: "2026-10-09T05:04:36.507Z", run_id: `TRIAGE-${FEEDBACK}-1791522017359`, task_id: `TRIAGE-${FEEDBACK}`,
  step: "pr.opened", lane: "triage", pr_url: "https://github.com/craigoley/remudero/pull/10255",
});

test("a triage PR opened after boot blocks a second triage of the same feedback", async () => {
  const { fires, lines } = await drive([OPENED], "OPEN");
  assert.equal(fires, 0, "the feedback already has an open triage PR");
  const skipped = lines.filter((l) => l.step === "auto_triage.skipped_inflight");
  assert.ok(skipped.length >= 1);
  assert.equal(skipped[0]!.extra.pr_number, 10255);
});

test("a triage PR opened after boot and since closed lets the feedback be triaged again", async () => {
  const { fires, liveReads } = await drive([OPENED], "CLOSED");
  assert.ok(liveReads.includes(10255), "the ledger's candidate must reach the live-state read");
  assert.ok(fires >= 1, "a closed, unmerged triage leaves the feedback untriaged");
});

test("the ledger read takes the newest opened triage PR and skips torn, foreign and unnumbered rows", async () => {
  const { triagePrOpenedInLedger } = await import("../src/lib/daemon.js");
  const row = (pr: string, task = `TRIAGE-${FEEDBACK}`, step = "pr.opened") => JSON.stringify({ step, task_id: task, pr_url: `https://github.com/o/r/pull/${pr}` });
  assert.equal(triagePrOpenedInLedger(undefined, FEEDBACK), undefined);
  assert.equal(triagePrOpenedInLedger([row("10255"), row("10260")], FEEDBACK), 10260, "newest wins");
  assert.equal(triagePrOpenedInLedger([row("10255"), `{"step":"pr.opened","task_id":"TRIAGE-${FEEDBACK}"`], FEEDBACK), 10255, "a torn line is skipped");
  assert.equal(triagePrOpenedInLedger([row("10255", `TRIAGE-${FEEDBACK}-other`)], FEEDBACK), undefined, "another feedback id's row is not this one");
  assert.equal(triagePrOpenedInLedger([row("x")], FEEDBACK), undefined, "an unnumbered PR url names nothing");
  assert.equal(triagePrOpenedInLedger([row("10255", `TRIAGE-${FEEDBACK}`, "pr.closed") + ' "pr.opened"'], FEEDBACK), undefined);
});
