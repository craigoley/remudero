// test/a-requeue-backstop-escalation-detail-describes-the-refusals.test.ts — W1-T5978.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_REQUEUE_DEFERRAL_BACKSTOP, type OpenPrView } from "./helpers/sweep-test.js";
import { buildSweepEffects } from "../src/run-task.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HEAD = "9d5ff72b0c";
const GATE = "squash-trailer-gate";
const tmp = (l: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5978-${l}-`));

const pr = {
  prNumber: 9438,
  prUrl: "https://github.com/craigoley/remudero/pull/9438",
  taskId: "W1-T5920",
  headSha: HEAD,
  headRefName: "run-W1-T5920-1791250000000",
} as unknown as OpenPrView;

async function body(kind: "cancelled-twice" | "requeue-deferral-backstop", reason: string): Promise<string> {
  const bodies: string[] = [];
  const create: IssueGateway["create"] = (_t, b) => {
    bodies.push(b);
    return "https://github.com/craigoley/remudero/issues/1";
  };
  const eff = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    config: { claudeBin: "/usr/bin/true", root: tmp("root") } as never,
    ledgerPath: join(tmp("ledger"), "ledger.ndjson"),
    runId: "SWEEP-W1-T5978",
    plan: { tasks: [] } as never,
    log: () => {},
    policy: undefined,
    reviewRunner: undefined,
    spawnImpl: undefined,
    pushEmptyCommit: undefined,
    issuesImpl: { create },
    stallNotice: undefined,
    armImpl: undefined,
    armSessionPrsOverride: undefined,
    updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined,
  }).escalateCancelledCheck!;
  await eff(pr, { name: GATE, jobId: "1" }, reason, kind);
  assert.equal(bodies.length, 1);
  return bodies[0];
}

test("a requeue-deferral-backstop escalation's detail names the refused requeues and never claims a second cancellation", async () => {
  const b = await body("requeue-deferral-backstop", "GitHub refused the job rerun (already_running)");
  assert.match(b, new RegExp(`refused the rerun ${CHECK_REQUEUE_DEFERRAL_BACKSTOP} times`));
  assert.match(b, /still in flight/);
  assert.match(b, /already_running/);
  assert.ok(!/CANCELLED again|reported CANCELLED/.test(b), b);
});

test("a cancelled-twice escalation's detail is unchanged", async () => {
  const b = await body("cancelled-twice", "already re-queued once on this head sha");
  assert.ok(b.includes(`re-queued required check "${GATE}"'s job once on head ${HEAD}, and it was reported CANCELLED again on that SAME head — already re-queued once on this head sha.`), b);
});
