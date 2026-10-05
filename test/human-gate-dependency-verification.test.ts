import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardRow, BoardSnapshot } from "../src/lib/board.js";
import type { Row } from "../src/lib/board-projection.js";
import {
  consumeHumanGateCounts,
  projectDependencyVerificationGates,
  projectHumanGates,
  type DependencyReviewFact,
  type HeldRootFact,
  type VerifyHumanFact,
} from "../src/lib/human-gate.js";
import { nowDependencyVerificationGates } from "../src/lib/now-view.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { currentVerifyHumanRulings } from "../src/lib/verify-human-judge.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const AT = "2026-10-04T12:00:00.000Z";
const LATER = "2026-10-04T13:00:00.000Z";
const REPO = "example/repo";
const issue = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const pull = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function dep(over: Partial<DependencyReviewFact> & { prNumber: number }): DependencyReviewFact {
  return { repo: REPO, prUrl: pull(over.prNumber), decision: "escalate", prOpen: true,
    escalations: [{ producer: "manual", class: "MANUAL", issueUrl: issue(900 + over.prNumber), openedAt: AT }], ...over };
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
  ({ taskId, title: taskId, status: "queued", merged: over.status === "merged", risk: "low", ...over }) as BoardRow;

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
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: [${deps.join(", ")}]\n  status: ${status}\n${extra}`;
const humanTask = (id: string, deps: string[] = []) => task(id, "", deps).replace("verify: auto", "verify: human");

const opened = (taskId: string, url: string, cls: string, ts = AT): Row =>
  ({ ts, task_id: taskId, step: "escalation.issue_opened", class: cls, issue_url: url });
const decided = (n: number, decision: string, extra: Row = {}): Row =>
  ({ ts: LATER, task_id: `dep-review-PR${n}`, step: "dep-review.decided", decision, pr_url: pull(n), ...extra });

test("migration and repairable dependency holds create no human gate", () => {
  const projection = projectHumanGates(project({ dependencyReview: [
    dep({ prNumber: 41, decision: "migrate" }),
    dep({ prNumber: 42, decision: "hold" }),
    dep({ prNumber: 43 }),
    dep({ prNumber: 44, prOpen: false }),
    dep({ prNumber: 45, escalations: [] }),
    dep({ prNumber: 46, decision: "hold", escalations: [{ producer: "hold", class: "BLOCKED", issueUrl: issue(946), openedAt: LATER }] }),
    dep({ prNumber: 47, decision: "migrate", escalations: [{ producer: "hold", class: "BLOCKED", issueUrl: issue(947), openedAt: LATER }] }),
  ] }));
  // MIGRATE and a still-repairable HOLD are machine work; only the MANUAL ask and the hold the bounded-age producer
  // already escalated reach a person, once per PR.
  assert.deepEqual(projection.gates.map((g) => [g.key, g.resolutionVerb, g.url]), [
    [`dependency_review:core:${encodeURIComponent(`${REPO}#43`)}`, "approve", issue(943)],
    [`dependency_review:core:${encodeURIComponent(`${REPO}#46`)}`, "rework", issue(946)],
  ]);
  assert.deepEqual(projection.count.byKind, { dependency_review: 2 });
  assert.deepEqual(projection.count.inbox, { count: 2 });
  assert.match(projection.gates[0]!.reason, /MANUAL dependency escalation/);
  assert.match(projection.gates[1]!.reason, /aged-hold escalation/);

  // The production read: rows as dep-review and escalate() write them, joined the way now-view joins them.
  const rows: Row[] = [
    opened("dep-review-PR41", issue(941), "MANUAL"), decided(41, "migrate"),
    opened("dep-review-PR42", issue(942), "MANUAL"), decided(42, "hold"),
    decided(43, "escalate"), opened("dep-review-PR43", issue(943), "MANUAL"),
    // A hold reconciliation failure re-logs `hold`, but the review itself still ruled escalate.
    opened("dep-review-PR48", issue(948), "MANUAL"), decided(48, "hold", { review_decision: "escalate" }),
    decided(49, "hold"), opened("dep-review-hold-PR49", issue(949), "BLOCKED", LATER),
    decided(50, "hold"), opened("dep-review-hold-PR50", issue(950), "BLOCKED", LATER),
  ];
  const live = projectHumanGates(nowDependencyVerificationGates({
    instance: "core", repo: REPO, plan: loadPlanFromYaml(task("R"), "fixture"), snapshot: snapshot([boardRow("R")], [41, 42, 43, 48, 49, 50]), rows,
    github: issuesOpen(new Set([issue(941), issue(942), issue(943), issue(948), issue(949)])),
  }));
  // PR50's aged-hold issue was retired (closed) by the producer when its checks recovered: no ask remains.
  assert.deepEqual(live.gates.map((g) => [g.kind, g.url, g.resolutionVerb]), [
    ["dependency_review", issue(943), "approve"], ["dependency_review", issue(948), "approve"], ["dependency_review", issue(949), "rework"],
  ]);
  assert.equal(live.sources.find((s) => s.name === "dependency-review")?.state, "complete");
});

test("judge-cleared verification stays fleet-owned and unknown stays explicit", () => {
  const projection = projectHumanGates(project({ verifyHuman: [
    { taskId: "V1", url: null, judgment: { state: "judged", decision: "automate", reason: "a test proves it", at: AT } },
    { taskId: "V2", url: null, judgment: { state: "judged", decision: "backlog", reason: "deps unmerged", at: AT } },
    { taskId: "V3", url: pull(3), judgment: { state: "judged", decision: "needs_operator", reason: "taste call on copy", at: AT } },
    { taskId: "V4", url: null, judgment: { state: "unclassified", reason: "no judge verdict recorded" } },
    { taskId: "V5", url: null, judgment: { state: "unclassified", reason: "the judge failed and fell open" } },
  ] }));
  assert.deepEqual(projection.gates.map((g) => [g.kind, g.key, g.resolutionVerb]), [["verify_human", "verify_human:core:V3", "verify"]]);
  assert.match(projection.gates[0]!.reason, /taste call on copy/);
  // Two unjudged tasks are neither two approvals nor a verified zero: the count is a floor and the gap is named.
  assert.deepEqual(projection.count.inbox, { atLeast: 1 });
  const verify = projection.sources.find((s) => s.name === "verify-human")!;
  assert.equal(verify.state, "partial");
  assert.match(verify.reason!, /2 verify: human task\(s\) unclassified/);
  assert.match(verify.reason!, /V4 \(no judge verdict recorded\)/);
  assert.match(verify.reason!, /V5 \(the judge failed and fell open\)/);
  // An empty, complete verify-human read covers its kind: a reader can tell "none" from "never read".
  assert.ok(consumeHumanGateCounts(projectHumanGates(project({}))).kinds.covered.includes("verify_human"));

  // A raw verifyHumanPending flag is never an approval: only the judge's newest, current ruling is read.
  const rows: Row[] = [
    { ts: AT, task_id: "V1", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "old", observed_state: "V1:deps=1:cited=0" },
    { ts: LATER, task_id: "V1", step: "verify_human.judged", judge_decision: "automate", judge_reason: "now provable", observed_state: "V1:deps=1:cited=1" },
    { ts: AT, task_id: "V3", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "taste call on copy", observed_state: "V3:deps=1:cited=0" },
    { ts: AT, task_id: "V5", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "fail-open", judge_failed: true, observed_state: "V5:deps=1:cited=0" },
    { ts: AT, task_id: "V6", step: "verify_human.judged", judge_decision: "maybe", judge_reason: "?", observed_state: "V6:deps=1:cited=0" },
    // Ruled while its dependency was unmerged; that dependency has since merged, so the ruling is not current.
    { ts: AT, task_id: "V8", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "stale", observed_state: "V8:deps=0:cited=0" },
  ];
  const rulings = currentVerifyHumanRulings(rows);
  assert.deepEqual(rulings.get("V1"), { state: "judged", decision: "automate", reason: "now provable", at: LATER });
  assert.equal(rulings.get("V5")?.state, "unclassified");
  assert.equal(rulings.get("V6")?.state, "unclassified");
  const ids = ["V1", "V3", "V4", "V5", "V6", "V8"];
  const plan = loadPlanFromYaml([...ids.map((id) => humanTask(id, id === "V8" ? ["D"] : [])), task("D", "", [], "merged"), task("V7")].join(""), "fixture");
  const live = projectHumanGates(nowDependencyVerificationGates({
    instance: "core", repo: REPO, plan, rows, github: issuesOpen(new Set()),
    snapshot: snapshot([...ids.map((id) => boardRow(id, { verifyHumanPending: true })), boardRow("D", { status: "merged" }), boardRow("V7")]),
  }));
  assert.deepEqual(live.gates.map((g) => g.key), ["verify_human:core:V3"]);
  const liveVerify = live.sources.find((s) => s.name === "verify-human")!;
  assert.equal(liveVerify.state, "partial");
  assert.match(liveVerify.reason!, /4 verify: human task\(s\) unclassified/);
  assert.match(liveVerify.reason!, /V8 \(the ruling \(V8:deps=0:cited=0\) predates the current dependency state/);
  assert.deepEqual(live.count.inbox, { atLeast: 1 });
});

test("a held root has one gate only while live dependents remain stalled", () => {
  const judged = (taskId: string, decision: "needs_operator" | "automate"): VerifyHumanFact =>
    ({ taskId, url: null, judgment: { state: "judged", decision, reason: "a person must sign off", at: AT } });
  const held = projectHumanGates(project({
    heldRoots: [
      { rootId: "H", hold: "verify-not-auto", stalled: ["A", "B", "A"], url: pull(7) },
      { rootId: "X", hold: "blocked", stalled: ["D"], url: null },
      { rootId: "M", hold: "verify-not-auto", stalled: ["E"], url: null },
      { rootId: "Z", hold: "verify-not-auto", stalled: [], url: null },
    ],
    verifyHuman: [judged("H", "needs_operator"), judged("M", "automate")],
  }));
  // H is both a held root and a judge-ruled verify: one decision carrying its impact, never two. M's judge ruled
  // automate, so it stays fleet-owned; Z stalls nothing, so it asks nothing.
  assert.deepEqual(held.gates.map((g) => [g.key, g.resolutionVerb]), [["held_root:core:H", "release"], ["held_root:core:X", "retire"]]);
  const h = held.gates.find((g) => g.key === "held_root:core:H")!;
  assert.match(h.reason, /2 task\(s\) stalled behind it: A, B/);
  assert.match(h.reason, /a person must sign off/);
  assert.equal(h.url, pull(7));
  assert.deepEqual(held.count.byKind, { held_root: 2 });
  assert.match(held.sources.find((s) => s.name === "held-roots")!.reason!, /fleet-owned by a judge automate ruling: M \(1 stalled\)/);

  // Production read: the stalled set comes from heldDependencyRoots over the board's merge state.
  const plan = loadPlanFromYaml([humanTask("H"), task("A", "", ["H"]), task("B", "", ["A"])].join(""), "fixture");
  const rows: Row[] = [{ ts: AT, task_id: "H", step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "sign-off", observed_state: "H:deps=1:cited=0" }];
  const board = (a: BoardRow["status"], b: BoardRow["status"]) => snapshot([boardRow("H", { verifyHumanPending: true, prUrl: pull(7) }), boardRow("A", { status: a }), boardRow("B", { status: b })]);
  const stalled = projectHumanGates(nowDependencyVerificationGates({ instance: "core", repo: REPO, plan, snapshot: board("queued", "queued"), rows, github: issuesOpen(new Set()) }));
  assert.deepEqual(stalled.gates.map((g) => [g.key, g.url]), [["held_root:core:H", pull(7)]]);
  assert.match(stalled.gates[0]!.reason, /2 task\(s\) stalled behind it: A, B/);
  const drained = projectHumanGates(nowDependencyVerificationGates({ instance: "core", repo: REPO, plan, snapshot: board("merged", "merged"), rows, github: issuesOpen(new Set()) }));
  // With no live dependent stalled the root is no longer a held root; the judge's own ruling still asks once.
  assert.deepEqual(drained.gates.map((g) => g.key), ["verify_human:core:H"]);
  const releasedRows: Row[] = [...rows, { ts: LATER, task_id: "H", step: "ratify.approved", released: "verify-human" }];
  const freed = projectHumanGates(nowDependencyVerificationGates({ instance: "core", repo: REPO, plan, snapshot: board("queued", "queued"), rows: releasedRows, github: issuesOpen(new Set()) }));
  assert.deepEqual(freed.gates, [], "an existing release resolves both the hold and the verify ask");
});

test("repo and instance identity survive dependency-review deduplication", () => {
  const second = project({ dependencyReview: [dep({ prNumber: 5, repo: "example/second" })] })
    .filter((s) => s.name === "dependency-review").map((s) => ({ ...s, name: "dependency-review-second" }));
  const projection = projectHumanGates([
    ...project({ dependencyReview: [
      dep({ prNumber: 5, escalations: [{ producer: "manual", class: "MANUAL", issueUrl: issue(2), openedAt: LATER }] }),
      dep({ prNumber: 5, escalations: [{ producer: "arm", class: "MANUAL", issueUrl: issue(1), openedAt: AT }] }),
    ] }),
    ...project({ instance: "other", dependencyReview: [dep({ prNumber: 5 })] }),
    ...second,
  ]);
  assert.deepEqual(projection.gates.map((g) => [g.key, g.url]).sort(), [
    [`dependency_review:core:${encodeURIComponent("example/repo#5")}`, issue(1)],
    [`dependency_review:core:${encodeURIComponent("example/second#5")}`, issue(905)],
    [`dependency_review:other:${encodeURIComponent("example/repo#5")}`, issue(905)],
  ]);

  const unverified = projectHumanGates(project({ dependencyReview: [dep({ prNumber: 9, prOpen: null,
    escalations: [{ producer: "manual", class: "MANUAL", issueUrl: issue(9), openedAt: AT, unverified: true }] })] }));
  assert.equal(unverified.gates.length, 1, "an unconfirmed open state stays an ask, failing closed");
  assert.deepEqual(unverified.count.inbox, { atLeast: 1 });
  assert.match(unverified.gates[0]!.reason, /could not be confirmed/);
});
