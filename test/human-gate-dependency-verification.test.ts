import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow, BoardSnapshot } from "../src/lib/board.js";
import type { Row } from "../src/lib/board-projection.js";
import {
  projectDependencyVerificationGates,
  projectHumanGates,
  type DependencyReviewFact,
  type HeldRootFact,
  type VerifyHumanFact,
} from "../src/lib/human-gate.js";
import { nowDependencyVerificationGates } from "../src/lib/now-view.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { currentVerifyHumanRulings } from "../src/lib/verify-human-judge.js";

const AT = "2026-10-04T12:00:00.000Z";
const LATER = "2026-10-04T13:00:00.000Z";
const REPO = "example/repo";
const issue = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const pull = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function dep(over: Partial<DependencyReviewFact> & { prNumber: number }): DependencyReviewFact {
  return { repo: REPO, prUrl: pull(over.prNumber), decision: "escalate", prOpen: true,
    escalation: { class: "MANUAL", issueUrl: issue(900 + over.prNumber), openedAt: AT }, ...over };
}

const none = { state: "complete" as const, items: [] };

function project(input: {
  instance?: string;
  dependencyReview?: readonly DependencyReviewFact[];
  heldRoots?: readonly HeldRootFact[];
  verifyHuman?: readonly VerifyHumanFact[];
}) {
  return projectDependencyVerificationGates({
    instance: input.instance ?? "core",
    dependencyReview: { ...none, items: input.dependencyReview ?? [] },
    heldRoots: { ...none, items: input.heldRoots ?? [] },
    verifyHuman: { ...none, items: input.verifyHuman ?? [] },
  });
}

const boardRow = (taskId: string, over: Partial<BoardRow> = {}): BoardRow =>
  ({ taskId, title: taskId, status: "queued", risk: "low", ...over }) as BoardRow;

function snapshot(tasks: BoardRow[], prs: number[] = [], complete = true): Pick<BoardSnapshot, "tasks" | "prQueue" | "github_unreachable"> {
  return {
    tasks, github_unreachable: false,
    prQueue: { complete, rows: prs.map((n) => ({ prNumber: n, prUrl: pull(n), title: `bump ${n}`, disposition: "dep-review",
      reason: "dependabot PR", reviewState: "none", queueClass: "waiting", held: false, snapshotAt: AT })) as BoardSnapshot["prQueue"]["rows"] },
  };
}

const issuesOpen = (open: ReadonlySet<string>) =>
  fakeGitHub({ issueByUrl: (url: string) => ({ state: open.has(url) ? "OPEN" : "CLOSED" }) });

const task = (id: string, extra = "", deps: string[] = [], status = "queued") =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: [${deps.join(", ")}]\n  status: ${status}\n${extra}`;

test("migration and repairable dependency holds create no human gate", () => {
  const sources = project({ dependencyReview: [
    dep({ prNumber: 41, decision: "migrate" }),
    dep({ prNumber: 42, decision: "hold" }),
    dep({ prNumber: 43 }),
    dep({ prNumber: 44, prOpen: false }),
    dep({ prNumber: 45, escalation: null }),
  ] });
  const projection = projectHumanGates(sources);
  assert.deepEqual(projection.gates.map((gate) => gate.key), [`dependency_review:core:${encodeURIComponent(`${REPO}#43`)}`]);
  assert.deepEqual(projection.count.byKind, { dependency_review: 1 });
  assert.deepEqual(projection.count.inbox, { count: 1 });
  const gate = projection.gates[0]!;
  assert.equal(gate.resolutionVerb, "approve");
  assert.equal(gate.url, issue(943));
  assert.equal(gate.openedAt, AT);
  assert.match(gate.reason, /MANUAL dependency escalation/);

  // The production read: ledger rows as the dep-review lane and escalate() write them, joined the way now-view joins them.
  const rows: Row[] = [
    { ts: AT, task_id: "dep-review-PR41", step: "escalation.issue_opened", class: "MANUAL", issue_url: issue(941) },
    { ts: LATER, task_id: "dep-review-PR41", step: "dep-review.decided", decision: "migrate", pr_url: pull(41) },
    { ts: AT, task_id: "dep-review-PR42", step: "escalation.issue_opened", class: "MANUAL", issue_url: issue(942) },
    { ts: LATER, task_id: "dep-review-PR42", step: "dep-review.decided", decision: "hold", pr_url: pull(42) },
    { ts: AT, task_id: "dep-review-PR43", step: "dep-review.decided", decision: "escalate", pr_url: pull(43) },
    { ts: AT, task_id: "dep-review-PR43", step: "escalation.issue_opened", class: "MANUAL", issue_url: issue(943) },
  ];
  const live = projectHumanGates(nowDependencyVerificationGates({
    instance: "core", repo: REPO, plan: loadPlanFromYaml(task("R"), "fixture"), snapshot: snapshot([boardRow("R")], [41, 42, 43]), rows,
    github: issuesOpen(new Set([issue(941), issue(942), issue(943)])),
  }));
  assert.deepEqual(live.gates.map((g) => [g.kind, g.url]), [["dependency_review", issue(943)]]);
  assert.equal(live.sources.find((s) => s.name === "dependency-review")?.state, "complete");
});

test("judge-cleared verification stays fleet-owned and unknown stays explicit", () => {
  const sources = project({ verifyHuman: [
    { taskId: "V1", url: null, judgment: { state: "judged", decision: "automate", reason: "a test proves it", at: AT } },
    { taskId: "V2", url: null, judgment: { state: "judged", decision: "backlog", reason: "deps unmerged", at: AT } },
    { taskId: "V3", url: pull(3), judgment: { state: "judged", decision: "needs_operator", reason: "taste call on copy", at: AT } },
    { taskId: "V4", url: null, judgment: { state: "unclassified", reason: "no judge verdict recorded" } },
    { taskId: "V5", url: null, judgment: { state: "unclassified", reason: "the judge failed and fell open" } },
  ] });
  const projection = projectHumanGates(sources);
  assert.deepEqual(projection.gates.map((gate) => [gate.kind, gate.key, gate.resolutionVerb]), [["verify_human", "verify_human:core:V3", "verify"]]);
  assert.match(projection.gates[0]!.reason, /taste call on copy/);
  // Two unjudged tasks are neither two approvals nor a verified zero: the count is a floor and the gap is named.
  assert.deepEqual(projection.count.inbox, { atLeast: 1 });
  const verify = projection.sources.find((source) => source.name === "verify-human")!;
  assert.equal(verify.state, "partial");
  assert.match(verify.reason!, /2 verify: human task\(s\) unclassified/);
  assert.match(verify.reason!, /V4/);
  assert.match(verify.reason!, /V5/);

  // A raw verifyHumanPending flag is never an approval: only the judge's newest ruling is read.
  const rows: Row[] = [
    { ts: AT, task_id: "V1", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "old", observed_state: "V1:deps=0:cited=0" },
    { ts: LATER, task_id: "V1", step: "verify_human.judged", judge_decision: "automate", judge_reason: "now provable", observed_state: "V1:deps=1:cited=0" },
    { ts: AT, task_id: "V3", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "taste call on copy", observed_state: "V3:deps=1:cited=0" },
    { ts: AT, task_id: "V5", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "fail-open", judge_failed: true, observed_state: "V5:deps=1:cited=0" },
    { ts: AT, task_id: "V6", step: "verify_human.judged", judge_decision: "maybe", judge_reason: "?", observed_state: "V6:deps=1:cited=0" },
  ];
  const rulings = currentVerifyHumanRulings(rows);
  assert.deepEqual(rulings.get("V1"), { state: "judged", decision: "automate", reason: "now provable", at: LATER });
  assert.equal(rulings.get("V5")?.state, "unclassified");
  assert.equal(rulings.get("V6")?.state, "unclassified");
  const pending = ["V1", "V3", "V4", "V5", "V6"].map((id) => boardRow(id, { verifyHumanPending: true }));
  const live = projectHumanGates(nowDependencyVerificationGates({
    instance: "core", repo: REPO, plan: loadPlanFromYaml(["V1", "V3", "V4", "V5", "V6"].map((id) => task(id, "  verify: human\n")).join(""), "fixture"),
    snapshot: snapshot([...pending, boardRow("V7")]), rows, github: issuesOpen(new Set()),
  }));
  assert.deepEqual(live.gates.map((g) => g.key), ["verify_human:core:V3"]);
  const liveVerify = live.sources.find((source) => source.name === "verify-human")!;
  assert.equal(liveVerify.state, "partial");
  assert.match(liveVerify.reason!, /3 verify: human task\(s\) unclassified/);
});

test("a held root has one gate only while live dependents remain stalled", () => {
  const judged = (taskId: string): VerifyHumanFact =>
    ({ taskId, url: null, judgment: { state: "judged", decision: "needs_operator", reason: "a person must sign off", at: AT } });
  const held = projectHumanGates(project({
    heldRoots: [{ rootId: "H", hold: "verify-not-auto", stalled: ["A", "B"], url: pull(7) }, { rootId: "X", hold: "blocked", stalled: ["D"], url: null }],
    verifyHuman: [judged("H")],
  }));
  // H is both a held root and a judge-ruled verify: one decision, carrying its impact, never two.
  assert.deepEqual(held.gates.map((g) => [g.key, g.resolutionVerb]), [["held_root:core:H", "release"], ["held_root:core:X", "retire"]]);
  const h = held.gates.find((g) => g.key === "held_root:core:H")!;
  assert.match(h.reason, /2 task\(s\) stalled behind it: A, B/);
  assert.match(h.reason, /a person must sign off/);
  assert.equal(h.url, pull(7));
  assert.deepEqual(held.count.byKind, { held_root: 2 });

  const released = projectHumanGates(project({ heldRoots: [{ rootId: "H", hold: "verify-not-auto", stalled: [], url: null }], verifyHuman: [] }));
  assert.deepEqual(released.gates, []);

  // Production read: the stalled set comes from heldDependencyRoots over the board's merge state.
  const plan = loadPlanFromYaml([task("H", "  verify: human\n"), task("A", "", ["H"]), task("B", "", ["A"])].join(""), "fixture");
  const rows: Row[] = [{ ts: AT, task_id: "H", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "sign-off", observed_state: "H:deps=1:cited=0" }];
  const stalled = projectHumanGates(nowDependencyVerificationGates({ instance: "core", repo: REPO, plan,
    snapshot: snapshot([boardRow("H", { verifyHumanPending: true }), boardRow("A"), boardRow("B")]), rows, github: issuesOpen(new Set()) }));
  assert.deepEqual(stalled.gates.map((g) => g.key), ["held_root:core:H"]);
  assert.match(stalled.gates[0]!.reason, /A, B/);
  const drained = projectHumanGates(nowDependencyVerificationGates({ instance: "core", repo: REPO, plan,
    snapshot: snapshot([boardRow("H", { verifyHumanPending: true }), boardRow("A", { status: "merged" }), boardRow("B", { status: "merged" })]), rows, github: issuesOpen(new Set()) }));
  // With no live dependent stalled the root is no longer a held root; the judge's ruling still asks once.
  assert.deepEqual(drained.gates.map((g) => g.key), ["verify_human:core:H"]);
  const releasedRows: Row[] = [...rows, { ts: LATER, task_id: "H", step: "ratify.approved", released: "verify-human" }];
  const freed = projectHumanGates(nowDependencyVerificationGates({ instance: "core", repo: REPO, plan,
    snapshot: snapshot([boardRow("H", { verifyHumanPending: true }), boardRow("A"), boardRow("B")]), rows: releasedRows, github: issuesOpen(new Set()) }));
  assert.deepEqual(freed.gates, [], "an existing release resolves both the hold and the verify ask");
});

test("repo and instance identity survive dependency-review deduplication", () => {
  const twoProducers = projectHumanGates([
    ...project({ dependencyReview: [dep({ prNumber: 5, escalation: { class: "MANUAL", issueUrl: issue(2), openedAt: LATER } }),
      dep({ prNumber: 5, escalation: { class: "MANUAL", issueUrl: issue(1), openedAt: AT } })] }),
    ...project({ instance: "other", dependencyReview: [dep({ prNumber: 5 })] }),
    ...project({ instance: "core", dependencyReview: [dep({ prNumber: 5, repo: "example/second" })] }).filter((s) => s.name === "dependency-review")
      .map((s) => ({ ...s, name: "dependency-review-second" })),
  ]);
  assert.deepEqual(twoProducers.gates.filter((g) => g.kind === "dependency_review").map((g) => [g.key, g.url]).sort(), [
    [`dependency_review:core:${encodeURIComponent("example/repo#5")}`, issue(1)],
    [`dependency_review:core:${encodeURIComponent("example/second#5")}`, issue(905)],
    [`dependency_review:other:${encodeURIComponent("example/repo#5")}`, issue(905)],
  ]);

  const unverified = projectHumanGates(project({ dependencyReview: [dep({ prNumber: 9, prOpen: null,
    escalation: { class: "MANUAL", issueUrl: issue(9), openedAt: AT, unverified: true } })] }));
  assert.equal(unverified.gates.length, 1, "an unconfirmed open state stays an ask, failing closed");
  assert.deepEqual(unverified.count.inbox, { atLeast: 1 });
  assert.match(unverified.gates[0]!.reason, /could not be confirmed/);
});
