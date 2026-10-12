import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow, BoardSnapshot } from "../src/lib/board.js";
import type { Row } from "../src/lib/board-projection.js";
import { projectHumanGates } from "../src/lib/human-gate.js";
import { nowDependencyVerificationGates } from "../src/lib/now-view.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { buildLedgerIndex, noteLedgerGeneration } from "../src/lib/status.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const AT = "2026-10-08T12:00:00.000Z";
const REPO = "example/repo";
const issue = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const pull = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const task = (id: string, verify: string, deps: string[] = [], status = "queued") =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: ${verify}\n  depends_on: [${deps.join(", ")}]\n  status: ${status}\n`;

/** A ledger-shaped array that counts every element read, the way the board projection's rows are held: one array
 *  per store, registered with a generation, and indexed once per generation by the snapshot stage. */
function countedRows(rows: Row[]): { rows: Row[]; reads: () => number; reset: () => void } {
  let reads = 0;
  const proxy = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { rows: proxy, reads: () => reads, reset: () => { reads = 0; } };
}

test("now dependency gates read their steps' rows from the generation's index, not the whole ledger", () => {
  const filler: Row[] = Array.from({ length: 5000 }, (_, i) => ({ ts: AT, task_id: `W${i % 50}`, step: "worker.activity", run_id: `r${i}` }));
  const rows: Row[] = [
    ...filler.slice(0, 2500),
    { ts: AT, task_id: "dep-review-PR41", step: "escalation.issue_opened", class: "MANUAL", issue_url: issue(941) },
    { ts: AT, task_id: "dep-review-PR41", step: "dep-review.decided", decision: "escalate", pr_url: pull(41) },
    { ts: AT, task_id: "V1", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "taste call", observed_state: "V1:deps=1:cited=0" },
    { ts: AT, task_id: "ROOT", step: "ratify.approved", released: "other" },
    ...filler.slice(2500),
  ];
  const counted = countedRows(rows);
  noteLedgerGeneration(counted.rows, 1);
  buildLedgerIndex(counted.rows); // the snapshot stage's index for this generation
  counted.reset();

  const plan = loadPlanFromYaml([task("V1", "human"), task("ROOT", "human"), task("LEAF", "auto", ["ROOT"])].join(""), "fixture");
  const tasks = [{ taskId: "V1", verifyHumanPending: true }, { taskId: "ROOT" }, { taskId: "LEAF" }]
    .map((t) => ({ title: t.taskId, status: "queued", merged: false, risk: "low", ...t }) as BoardRow);
  const snapshot: Pick<BoardSnapshot, "tasks" | "prQueue" | "github_unreachable"> = {
    tasks, github_unreachable: false,
    prQueue: { complete: true, rows: [{ prNumber: 41, prUrl: pull(41), title: "bump", disposition: "dep-review", reason: "dependabot PR",
      reviewState: "none", queueClass: "waiting", held: false, snapshotAt: AT }] as BoardSnapshot["prQueue"]["rows"] },
  };
  const gates = projectHumanGates(nowDependencyVerificationGates({
    instance: "core", repo: REPO, plan, rows: counted.rows, snapshot,
    github: fakeGitHub({ issueByUrl: () => ({ state: "OPEN" }) }),
  }));

  // Every producer still answers: the escalation, the held root and the judge's ruling...
  assert.deepEqual(gates.gates.map((g) => g.key).sort(), [
    `dependency_review:core:${encodeURIComponent(`${REPO}#41`)}`, "held_root:core:ROOT", "verify_human:core:V1",
  ]);
  // ...yet not one of the ledger's 5,004 rows was walked: the index's step and task buckets carried every read.
  assert.equal(counted.reads(), 0);
});
