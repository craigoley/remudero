// test/a-merged-triage-pr-blocks-a-re-triage-until-the-checkout-catches-up.test.ts
//
// LIVE 2026-10-09 (#10255 / #10265): a feedback entry's `status: new` changes only when its triage
// PR MERGES, and the daemon reads that status from its own checkout, which lags main. The in-flight
// guard's confirming read sees the triage PR as MERGED and stands down, so the next idle fire picks
// the SAME entry again — a second triage of an already-triaged item, whose PR can never pass.
// Now a MERGED read asks origin/main for the entry's status first and keeps the guard closed while
// main has moved it on. An unreadable main still fails open, exactly as before.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitRepo } from "./helpers/git-repo.js";

const ID = "fb-1789927308301-29a363";

function planFile(dir: string): string {
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n" +
      "- id: T2\n  title: t2\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n",
  );
  return f;
}

async function runGuard(mainStatus: string | undefined, wired = true) {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-triage-merged-"));
  try {
    let fires = 0;
    let checks = 0;
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    await runDaemon(loadPlan(planFile(dir)), {
      refreshMerged: () => () => false,
      runOne: async (id: string) => ({ taskId: id, ok: true, merged: true }) as never,
      checkStop: () => (++checks > 1 ? "bound" : undefined),
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: ID, reason: "idle" }),
      runAutoTriage: async () => {
        fires++;
      },
      isFeedbackOpenPr: () => 10255,
      readFeedbackLiveState: () => "MERGED",
      ...(wired ? { readFeedbackStatusOnMain: () => mainStatus } : {}),
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    }, { laneCount: 2 });
    return { fires, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a merged triage whose entry main has moved on is not triaged a second time", async () => {
  const { fires, lines } = await runGuard("proposed");
  assert.equal(fires, 0);
  const skip = lines.find((l) => l.step === "auto_triage.skipped_inflight");
  assert.ok(skip, "the refusal is ledgered");
  assert.equal(skip.extra.pr_number, 10255);
  assert.match(String(skip.extra.reason), /origin\/main holds the entry at status: proposed/);
});

test("a merged triage whose entry main still holds at status new may fire again", async () => {
  assert.equal((await runGuard("new")).fires, 1);
});

test("an unreadable main status fails open, as an unwired read always has", async () => {
  assert.equal((await runGuard(undefined)).fires, 1);
  assert.equal((await runGuard("proposed", false)).fires, 1);
});

test("feedbackStatusOnMain reads the status committed on origin/main, not the working tree", async () => {
  const { feedbackStatusOnMain } = await import("../src/lib/auto-triage.js");
  const upstream = gitRepo({ kind: "triage-upstream" });
  const local = gitRepo({ kind: "triage-local", cloneFrom: upstream.dir });
  try {
    mkdirSync(join(upstream.dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(upstream.dir, "plan", "feedback", `${ID}.yaml`), "id: x\nstatus: proposed\n");
    upstream.git("add", "plan");
    upstream.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "triage");
    assert.equal(feedbackStatusOnMain(local.dir, ID), undefined, "before the fetch main has no such entry");
    local.git("fetch", "-q", "origin");
    mkdirSync(join(local.dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(local.dir, "plan", "feedback", `${ID}.yaml`), "id: x\nstatus: new\n");
    assert.equal(feedbackStatusOnMain(local.dir, ID), "proposed");
  } finally {
    local.cleanup();
    upstream.cleanup();
  }
});

test("feedbackStatusOnMain propagates a refused repository before reading main", async () => {
  const { feedbackStatusOnMain } = await import("../src/lib/auto-triage.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-triage-refused-"));
  try {
    assert.throws(() => feedbackStatusOnMain(dir, ID), { name: "WorktreePointerRefusedError" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
