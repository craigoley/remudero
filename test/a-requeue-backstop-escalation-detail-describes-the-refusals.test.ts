import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSweepEffects,
  CHECK_REQUEUE_DEFERRAL_BACKSTOP,
  type CancelledCheckEscalationKind,
  type OpenPrView,
} from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

test("test/a-requeue-backstop-escalation-detail-describes-the-refusals.test.ts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5978-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pr: OpenPrView = {
    prNumber: 9438,
    prUrl: "https://github.com/craigoley/remudero/pull/9438",
    taskId: "W1-T5978",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
    headSha: "9d5ff72b0c",
    headRefName: "run-W1-T5978-1791950823212",
    autoMergeArmed: false,
  };
  const check = { name: "squash-trailer-gate", jobId: "111989995761" };

  async function detail(kind?: CancelledCheckEscalationKind): Promise<string> {
    const bodies: string[] = [];
    const effect = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero",
      config: { claudeBin: "/usr/bin/true", root } as never,
      ledgerPath: join(root, `${kind ?? "default"}.ndjson`),
      runId: "SWEEP-W1-T5978",
      plan: { tasks: [] } as never,
      log: () => {},
      policy: undefined,
      reviewRunner: undefined,
      spawnImpl: undefined,
      pushEmptyCommit: undefined,
      issuesImpl: {
        create: (_title, body) => {
          bodies.push(body);
          return "https://github.com/craigoley/remudero/issues/9500";
        },
      },
      stallNotice: undefined,
      armImpl: undefined,
      armSessionPrsOverride: undefined,
      updateBranchImpl: undefined,
      captureRepairFeedbackImpl: undefined,
    }).escalateCancelledCheck!;
    await effect(pr, check, "GitHub refused the job rerun (already_running)", kind);
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].includes("\n\n## Options\n"));
    return bodies[0].split("\n\n## Options\n")[0].split("\n\n").at(-1)!;
  }

  const backstop = await detail("requeue-deferral-backstop");
  assert.match(backstop, new RegExp(`refused ${CHECK_REQUEUE_DEFERRAL_BACKSTOP} times`));
  assert.match(backstop, /run was still in flight/);
  assert.ok(backstop.includes(check.name));
  assert.ok(backstop.includes(pr.headSha!));
  assert.ok(backstop.includes("GitHub refused the job rerun (already_running)"));
  assert.doesNotMatch(backstop, /reported CANCELLED again|re-queued.*once/);

  const unchanged = `The gate-reconciliation lane (W1-T1223) re-queued required check "${check.name}"'s job once ` +
    `on head ${pr.headSha}, and it was reported CANCELLED again on that SAME head — ` +
    `GitHub refused the job rerun (already_running). ` +
    `A concurrency group cancelling it, a capacity fault, or a workflow-level cancel are all beyond ` +
    `what a second re-queue could fix; nothing in this PR's own diff caused this.`;
  assert.equal(await detail("cancelled-twice"), unchanged);
  assert.equal(await detail(), unchanged);
});
