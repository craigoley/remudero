import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { feedbackLineageAuthority } from "../src/lib/authority.js";
import { decideAutoTriage, newFeedbackIdsOldestFirst, type AutoTriageInputs } from "../src/lib/auto-triage.js";
import { classifyContribution, feedbackContentDigest, feedbackLineagePayload, type AdmissionPolicy, type FeedbackAdmissionSubject } from "../src/lib/contributor-admission.js";
import {
  admitFeedbackContribution, captureFeedback, feedbackEntryPath, homeRepoPath, inheritFeedbackLineage, proposeFeedbackWithSummary,
  readFeedbackEntry, type FeedbackEntry,
} from "../src/lib/feedback.js";
import { ghIssueListGateway, normalizeIssue, pollIssues, type IssueListGateway } from "../src/lib/issues-intake.js";
import { ghShim } from "./helpers/gh-shim.js";
import { mergeFeedbackRecord } from "../src/lib/feedback-record-merge.js";
import { LANDING_BRANCH, landFeedback, landFeedbackStatusContent, sweepFeedbackLanding } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";
import { feedbackEntryBlock } from "../src/lib/triage.js";
import { operatorVerdictEvidence } from "../src/lib/sweep.js";
import { buildFixRungDispatchArgs, feedbackFixConstraint, runPlanScopedFixRound, buildIntakeRungsDaemonHooks } from "./helpers/run-task-test.js";
import * as admissionModule from "../src/lib/contributor-admission.js";
import type { AdmissionSettings, AdmissionRead, AdmissionDecision } from "../src/lib/contributor-admission.js";
import { ghEscalationAnswerGateway, readEscalationAnswers } from "../src/lib/escalation-answers.js";
import { renderIssueBody } from "../src/lib/escalate.js";
import { fixedClock } from "../src/lib/clock.js";

// W1-T7754 — an issue or comment is an outside contribution until the shared classifier admits
// its ORIGINAL actor. These fixtures drive real captures through pollIssues/captureFeedback and
// read back what was written, then ask the autonomous rung what it would adopt.

const NOW = Date.parse("2026-10-11T12:00:00Z");
const OWNER_ID = 1;
const SUMMARIZER_BOT_ID = 77;
const POLICY: AdmissionPolicy = {
  version: "fixture-v1",
  ownerIds: [OWNER_ID],
  organizationIds: [],
  services: [{ id: SUMMARIZER_BOT_ID, actions: ["feedback"] }],
  maxEvidenceAgeMs: 60_000,
};

type SourceObservation = { decision: AdmissionDecision; subject?: FeedbackAdmissionSubject; wouldDeny: boolean };
const recheckSource = (...args: [AdmissionSettings | undefined, FeedbackAdmissionSubject, string,
  (step: string, fields: Record<string, unknown>) => void, { read?: AdmissionRead; clock?: { now(): number } }?]) =>
  (admissionModule as unknown as { observeFeedbackSource: (...params: typeof args) => Promise<SourceObservation | undefined> })
    .observeFeedbackSource(...args);

function sourceFixture(kind: FeedbackAdmissionSubject["kind"] = "issue", actorId = OWNER_ID) {
  const actor = { id: actorId, type: "User", login: `actor-${actorId}` };
  const repository = { id: 100, full_name: "acme/widgets", private: true };
  const issue = { ...issueRow(4, actor), author_association: "NONE" };
  const comment = { id: 9, user: actor, body: "answer", updated_at: issue.updated_at,
    issue_url: "https://api.github.com/repos/acme/widgets/issues/4", author_association: "NONE" };
  const reaction = { id: 81, user: actor, content: "+1", created_at: issue.updated_at };
  const isComment = kind.includes("comment"), isReaction = kind.includes("reaction");
  const issueRevision = { updatedAt: issue.updated_at, contentDigest: feedbackContentDigest([issue.title, issue.body, issue.labels]) };
  const commentRevision = { updatedAt: comment.updated_at, contentDigest: feedbackContentDigest(comment.body) };
  const subject: FeedbackAdmissionSubject = { kind,
    sourceRef: `acme/widgets#4${isComment ? "/comment/9" : ""}${isReaction ? "/reaction/81" : ""}`,
    observedAtMs: NOW - 120_000, repository: { id: 100, fullName: "acme/widgets", private: true },
    itemId: isReaction ? 81 : isComment ? 9 : 1004, issueNumber: 4,
    revision: isReaction ? { createdAt: reaction.created_at, contentDigest: feedbackContentDigest(reaction.content) }
      : isComment ? commentRevision : issueRevision,
    ...(isReaction ? { parent: { kind: isComment ? "issue-comment" as const : "issue" as const,
      itemId: isComment ? 9 : 1004, revision: isComment ? commentRevision : issueRevision } } : {}),
    origin: { actor, ...(!isReaction ? { association: "NONE" } : {}) } };
  const routes: Record<string, unknown> = {
    "repos/acme/widgets": repository, "repos/acme/widgets/issues/4": issue,
    "repos/acme/widgets/issues/comments/9": comment,
    "repos/acme/widgets/issues/4/reactions?per_page=100&page=1": [reaction],
    "repos/acme/widgets/issues/comments/9/reactions?per_page=100&page=1": [reaction],
  };
  const calls: string[] = [];
  const read: AdmissionRead = async path => { calls.push(path); return { status: 200, body: routes[path] }; };
  const settings: AdmissionSettings = { mode: "shadow", repositoryId: 200, policy: { ...POLICY }, organizations: [] };
  return { settings, subject, routes, calls, read, issue, comment, reaction };
}

for (const kind of ["issue", "issue-comment", "issue-reaction", "issue-comment-reaction"] as const) {
  test(`W1-T7754 source: ${kind} re-reads actual identity and revision without inventing a PR head`, async () => {
    const f = sourceFixture(kind); const rows: Record<string, unknown>[] = [];
    const result = await recheckSource(f.settings, f.subject, "direct-adoption", (_step, fields) => rows.push(fields),
      { read: f.read, clock: { now: () => NOW } });
    assert.equal(result?.decision.reason, "owner");
    assert.equal(result?.subject?.observedAtMs, NOW, "fresh read, not the stale capture timestamp");
    assert.deepEqual(result?.subject?.revision, f.subject.revision);
    assert.equal(result?.wouldDeny, false);
    assert.equal(rows.length, 1);
    assert.ok(f.calls.filter(p => p === "repos/acme/widgets").length === 2);
    assert.equal(f.calls.some(p => /pulls|\/reactions\/81/.test(p)), false);
  });
}

test("W1-T7754 source: absent policy does no reads and malformed identities cannot choose an API path", async () => {
  const f = sourceFixture();
  assert.equal(await recheckSource(undefined, f.subject, "adoption", () => {}, { read: f.read }), undefined);
  assert.equal(f.calls.length, 0);
  for (const subject of [{ ...f.subject, sourceRef: "../private#4" }, { ...f.subject, itemId: undefined }]) {
    assert.equal((await recheckSource(f.settings, subject, "adoption", () => {}, { read: f.read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  }
  assert.equal(f.calls.length, 0);
});

test("W1-T7754 source: source edits, numeric identity drift and changed reaction parents invalidate adoption", async () => {
  for (const mutate of [
    (f: ReturnType<typeof sourceFixture>) => { f.issue.body = "edited"; },
    (f: ReturnType<typeof sourceFixture>) => { f.issue.id = 1005; },
    (f: ReturnType<typeof sourceFixture>) => { f.issue.user = { id: 9001, type: "User", login: "actor-9001" }; },
    (f: ReturnType<typeof sourceFixture>) => { f.routes["repos/acme/widgets"] = { id: 101, full_name: "acme/widgets", private: true }; },
  ]) {
    const f = sourceFixture(); mutate(f);
    assert.equal((await recheckSource(f.settings, f.subject, "adoption", () => {}, { read: f.read, clock: { now: () => NOW } }))?.decision.reason, "source-revision-changed");
  }
  const f = sourceFixture("issue-comment-reaction"); f.comment.body = "edited parent";
  assert.equal((await recheckSource(f.settings, f.subject, "fix", () => {}, { read: f.read, clock: { now: () => NOW } }))?.decision.reason, "source-revision-changed");
});

test("W1-T7754 source: membership negatives require an identity-bound credential positive control", async () => {
  for (const control of [false, true]) {
    const f = sourceFixture("issue", 9001);
    f.settings.policy = { ...POLICY, organizationIds: [600] }; f.settings.organizations = [{ id: 600, login: "acme" }];
    const read: AdmissionRead = path => {
      if (path === "orgs/acme/memberships/actor-9001") return { status: 404, body: {} };
      if (path === "user") return { status: 200, body: { id: 88, login: "credential" } };
      if (path === "orgs/acme/memberships/credential") return { status: 200,
        body: { state: "active", user: { id: control ? 88 : 89 }, organization: { id: 600 } } };
      return f.read(path);
    };
    assert.equal((await recheckSource(f.settings, f.subject, "adoption", () => {}, { read, clock: { now: () => NOW } }))?.decision.outcome,
      control ? "confirmed-external" : "unknown");
  }
});

test("W1-T7754 source: edits during membership, policy changes and deadline expiry remain unknown", async () => {
  for (const arm of ["source", "policy", "clock"] as const) {
    const f = sourceFixture("issue", 9001); let now = NOW;
    f.settings.policy = { ...POLICY, version: `race-${arm}`, organizationIds: [600] };
    f.settings.organizations = [{ id: 600, login: "acme" }];
    const read: AdmissionRead = path => {
      if (path.startsWith("orgs/")) {
        if (arm === "source") f.issue.body = "changed while resolving membership";
        if (arm === "policy") f.settings.policy.version = "changed-policy";
        if (arm === "clock") now += 60_001;
        return { status: 200, body: { state: "active", user: { id: 9001 }, organization: { id: 600 } } };
      }
      return f.read(path);
    };
    const result = await recheckSource(f.settings, f.subject, "adoption", () => {}, { read, clock: { now: () => now } });
    assert.equal(result?.decision.outcome, "unknown", arm);
  }
});

test("W1-T7754 source: unreadable REST, permission ambiguity, comment reparenting and bounded reaction misses stay unknown", async () => {
  for (const read of [async () => { throw new Error("offline"); }, async () => ({ status: 403, body: {} }),
    async () => ({ status: 200, body: undefined })] satisfies AdmissionRead[]) {
    const f = sourceFixture();
    assert.equal((await recheckSource(f.settings, f.subject, "adoption", () => {}, { read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  }
  const f = sourceFixture("issue-comment"); f.comment.issue_url = "https://api.github.com/repos/acme/widgets/issues/5";
  assert.equal((await recheckSource(f.settings, f.subject, "adoption", () => {}, { read: f.read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  const missing = sourceFixture("issue-reaction"); let count = 0;
  const read: AdmissionRead = path => { count++; return path.includes("reactions?")
    ? { status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: 200 + i })) } : missing.read(path); };
  assert.equal((await recheckSource(missing.settings, missing.subject, "fix", () => {}, { read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  assert.ok(count <= 5, "reaction lookup is capped, not a repository scanner");
});

test("W1-T7754 source: real default transport leaves the event loop responsive while a GitHub child is in flight", async () => {
  const f = sourceFixture();
  const shim = ghShim(Object.entries(f.routes).map(([path, body]) => ({ when: `api ${path} -i`,
    stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`, ...(path === "repos/acme/widgets" ? { delaySeconds: 0.15 } : {}) })),
  { kind: "feedback-action-source" });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${previousPath}`;
    let finished = false;
    const pending = recheckSource(f.settings, f.subject, "direct-adoption", () => {}, { clock: { now: () => NOW } })
      .finally(() => { finished = true; });
    const until = Date.now() + 2_000;
    while (!shim.events().some(e => e.phase === "start") && Date.now() < until) await new Promise(r => setTimeout(r, 5));
    assert.equal(finished, false);
    const events = shim.events();
    assert.ok(events.some(e => e.phase === "start" && !events.some(end => end.phase === "end" && end.id === e.id)),
      "not merely a promise around an already-completed synchronous child");
    assert.equal((await pending)?.decision.reason, "owner");
    assert.equal(shim.calls().length, 4);
  } finally { process.env.PATH = previousPath; rmSync(shim.dir, { recursive: true, force: true }); }
});

test("W1-T7754 source: real default failed and malformed responses cannot grant trust or hold shadow effects", async () => {
  const previousPath = process.env.PATH;
  for (const route of [
    { stdout: "HTTP/2.0 403 Forbidden\n\n{}", exit: 1 },
    { stdout: "HTTP/2.0 200 OK\n\nnot-json" },
    { stderr: "transport offline", exit: 1 },
  ]) {
    const shim = ghShim([{ when: "", ...route }], { kind: "feedback-action-failure" });
    try {
      process.env.PATH = `${shim.dir}:${previousPath}`;
      const f = sourceFixture();
      const result = await recheckSource(f.settings, f.subject, "adoption", () => { throw new Error("receipt offline"); },
        { clock: { now: () => NOW } });
      assert.equal(result?.decision.outcome, "unknown");
      assert.equal(shim.calls().length, 1);
    } finally { process.env.PATH = previousPath; rmSync(shim.dir, { recursive: true, force: true }); }
  }
});

test("W1-T7754 source: positive membership is bounded by pinned policy and failed rechecks never reuse trust", async () => {
  const f = sourceFixture("issue", 9011);
  f.settings.policy = { ...POLICY, version: "source-cache-case", organizationIds: [600] };
  f.settings.organizations = [{ id: 600, login: "acme" }];
  let membershipReads = 0, failRecheck = false, repoReads = 0;
  const read: AdmissionRead = path => {
    if (path.startsWith("orgs/")) { membershipReads++; return { status: 200,
      body: { state: "active", user: { id: 9011 }, organization: { id: 600 } } }; }
    if (path === "repos/acme/widgets" && ++repoReads % 2 === 0 && failRecheck) throw new Error("recheck failed");
    return f.read(path);
  };
  const run = () => recheckSource(f.settings, f.subject, "fix", () => {}, { read, clock: { now: () => NOW } });
  assert.equal((await run())?.decision.reason, "organization-member");
  assert.equal((await run())?.decision.reason, "organization-member");
  assert.equal(membershipReads, 1);
  failRecheck = true;
  assert.equal((await run())?.decision.outcome, "unknown");
  f.settings.policy.version = "source-cache-case-changed"; failRecheck = false;
  assert.equal((await run())?.decision.reason, "organization-member");
  assert.equal(membershipReads, 2);
});

test("W1-T7754 source: a thrown membership read is unknown and never escapes the shadow observer", async () => {
  const f = sourceFixture("issue", 9021);
  f.settings.policy = { ...POLICY, version: "membership-transport-throw", organizationIds: [600] };
  f.settings.organizations = [{ id: 600, login: "acme" }];
  let membershipReads = 0;
  const read: AdmissionRead = path => {
    if (path.startsWith("orgs/")) { membershipReads++; throw new Error("membership transport offline"); }
    return f.read(path);
  };
  const rows: Record<string, unknown>[] = [];
  const result = await recheckSource(f.settings, f.subject, "adoption", (_step, fields) => rows.push(fields),
    { read, clock: { now: () => NOW } });
  assert.equal(membershipReads, 1);
  assert.equal(result?.decision.outcome, "unknown");
  assert.equal(result?.wouldDeny, true);
  assert.equal(rows.length, 1);
});

test("W1-T7754 answers: real comment and reaction bindings survive the durable store and rebuilt fix evidence", async () => {
  for (const enabled of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "rmd-answer-origin-"));
    const f = sourceFixture("issue-reaction");
    f.issue.body = renderIssueBody({ class: "BLOCKED", taskId: "W1-T9000", summary: "fixture", detail: "fixture",
      options: [{ label: "retry", detail: "fixture" }], recommendation: "retry" });
    f.comment.body = "retry";
    const rows: Record<string, unknown>[] = [];
    const gateway = (ghEscalationAnswerGateway as unknown as (...args: unknown[]) => ReturnType<typeof ghEscalationAnswerGateway>)(
      "acme", "widgets", async (args: string[]) => JSON.stringify(args[1].includes("comments") ? [f.comment]
        : args[1].includes("reactions") ? [f.reaction]
        : [{ ...f.issue, html_url: "https://github.com/acme/widgets/issues/4" }]), ["actor-1"],
      enabled ? { settings: f.settings, read: f.read } : undefined);
    gateway.reactPlusOne = () => {};
    gateway.reactPlusOneOnIssue = () => {};
    try {
      const result = await readEscalationAnswers(root, "fixture", gateway,
        { ledgerPath: join(root, "ledger.ndjson"), writeLedger: (_path, row) => rows.push(row) }, fixedClock(NOW));
      assert.equal(result.accepted, 2);
      const answers = readFileSync(join(root, "plan/questions.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const evidence = operatorVerdictEvidence("W1-T9000", [], answers)!;
      assert.equal(evidence.constraint, "retry", "text deduplication does not deduplicate the distinct original sources");
      if (!enabled) {
        assert.ok(answers.every(answer => !("contribution" in answer)));
        assert.equal(f.calls.length, 0);
        assert.equal(evidence.contributions, undefined);
      } else {
        assert.equal(evidence.contributions?.length, 2);
        const [comment, reaction] = answers.map(answer => answer.contribution.subject);
        assert.equal(comment.kind, "issue-comment"); assert.equal(comment.itemId, 9);
        assert.equal(comment.origin.actor.id, OWNER_ID); assert.equal(comment.revision.updatedAt, f.comment.updated_at);
        assert.equal(reaction.kind, "issue-reaction"); assert.equal(reaction.itemId, 81);
        assert.equal(reaction.revision.createdAt, f.reaction.created_at);
        assert.equal(reaction.revision.updatedAt, undefined);
        assert.equal(reaction.parent.itemId, f.issue.id);
        assert.equal(reaction.parent.revision.contentDigest, feedbackContentDigest([f.issue.title, f.issue.body, f.issue.labels]));
        assert.ok(rows.filter(row => row.step === "panel.question_answered").every(row => row.contribution));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("W1-T7754 adoption: selected lineage is re-read once and unreadable or over-bound inputs cannot hold effects", async () => {
  const f = sourceFixture(); const rows: Record<string, unknown>[] = [];
  const contribution = { subject: f.subject, admission: { outcome: "trusted" } };
  const log = (_step: string, fields: Record<string, unknown>) => rows.push(fields);
  await admissionModule.observeFeedbackInputs(f.settings, [contribution, structuredClone(contribution)], "adoption", log,
    { read: f.read, clock: { now: () => NOW } });
  assert.equal(f.calls.length, 4, "duplicate lineage is one current source, not extra origin scans");
  assert.equal(rows.length, 1); assert.equal(rows[0].reason, "owner");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await admissionModule.observeFeedbackInputs(f.settings, [{}, { subject: cyclic }, ...Array(9).fill({})], "fix", log,
    { read: () => { assert.fail("unreadable lineage cannot choose an API path"); }, clock: { now: () => NOW } });
  assert.ok(rows.some(row => row.reason === "lineage-read-bound"));
  assert.ok(rows.some(row => row.reason === "lineage-unreadable"));
  await admissionModule.observeFeedbackInputs(f.settings, [{}], "fix", () => { throw new Error("receipt failure"); });
  await admissionModule.observeFeedbackInputs(f.settings, Array(9).fill({}), "fix", () => { throw new Error("bounded receipt failure"); },
    { read: () => { assert.fail("missing lineage cannot choose an API path"); } });
  await admissionModule.observeFeedbackInputs(undefined, [contribution], "fix", log,
    { read: () => { assert.fail("absent settings cannot read"); } });
});

test("W1-T7754 adoption: the actual plan-fix round rechecks and carries original lineage without treating shadow as a gate", async () => {
  for (const admitted of [true, false]) {
    const f = sourceFixture("issue", admitted ? OWNER_ID : 9012);
    f.issue.updated_at = new Date(Date.now() - 1_000).toISOString();
    f.subject.revision!.updatedAt = f.issue.updated_at;
    const contribution = { subject: f.subject, source_ref: f.subject.sourceRef, actor: f.subject.origin?.actor };
    const rows: Record<string, unknown>[] = []; const prompts: string[] = [];
    const path = "plan/tasks.d/W1-T9000-fixture.yaml", head = "a".repeat(40);
    const result = await runPlanScopedFixRound({
      admission: f.settings, pr: { prNumber: 9000, prUrl: "https://github.com/acme/widgets/pull/9000", headSha: head,
        headRefName: "fixture", checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0,
        lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
        pendingAnswer: { constraint: "operator selected answer", contributions: [contribution] } },
      task: { id: "W1-T9000", title: "fixture", files: [path] }, worktreePath: "/fixture",
      title: "chore(plan): fixture", body: `## Acceptance\n- the task exists | grep: id: W1-T9000 in ${path}`,
      deps: { feedbackRead: f.read,
        runGit: args => args[0] === "rev-parse" ? head : args[0] === "show" ? "- id: W1-T9000\n" : "",
        preflight: async () => ({ ok: true, failures: [], unreadable: [] }),
        spawn: async prompt => { prompts.push(prompt); return "COMMIT_MESSAGE: chore(plan): fixture"; },
        push: () => assert.fail("no source change may push"), updateMetadata: async () => assert.fail("no metadata change"),
        log: (_step, fields) => { if (fields) rows.push(fields); } },
    });
    assert.equal(result.outcome, "refused", "fixture has no changed files, not an admission refusal");
    assert.equal(prompts.length, 1, "both admitted and external shadow observations preserve dispatch");
    assert.equal(f.calls.length, 4);
    assert.ok(rows.some(row => row.boundary === "plan-fix-adoption" && row.would_deny === !admitted));
    assert.match(prompts[0], /Original contribution lineage/);
    assert.match(prompts[0], /acme\/widgets#4/);
    assert.match(prompts[0], /not permission/);
  }
  assert.equal(feedbackFixConstraint(undefined), undefined);
  assert.equal(feedbackFixConstraint({ constraint: "legacy answer" }), "legacy answer");
});

test("W1-T7754 source: pagination and invalid metadata retain explicit unknown rather than an empty success", async () => {
  const f = sourceFixture("issue-reaction");
  const page2 = "repos/acme/widgets/issues/4/reactions?per_page=100&page=2";
  f.routes["repos/acme/widgets/issues/4/reactions?per_page=100&page=1"] = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }));
  f.routes[page2] = [f.reaction];
  assert.equal((await recheckSource(f.settings, f.subject, "fix", () => {}, { read: f.read, clock: { now: () => NOW } }))?.decision.reason, "owner");
  assert.equal(f.calls.filter(path => path === page2).length, 2);
  for (const body of [[], {}, undefined]) {
    const g = sourceFixture("issue-reaction");
    g.routes["repos/acme/widgets/issues/4/reactions?per_page=100&page=1"] = body;
    assert.equal((await recheckSource(g.settings, g.subject, "fix", () => {}, { read: g.read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  }
  for (const repository of [{ id: 100, full_name: "acme/other", private: true }, { id: 100, full_name: "acme/widgets" }]) {
    const g = sourceFixture(); g.routes["repos/acme/widgets"] = repository;
    assert.equal((await recheckSource(g.settings, g.subject, "fix", () => {}, { read: g.read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  }
  const g = sourceFixture(); g.routes["repos/acme/widgets/issues/4"] = { ...g.issue, pull_request: {} };
  assert.equal((await recheckSource(g.settings, g.subject, "fix", () => {}, { read: g.read, clock: { now: () => NOW } }))?.decision.outcome, "unknown");
  g.settings.organizations = [{ id: 600, login: "../hidden" }];
  assert.equal((await recheckSource(g.settings, g.subject, "fix", () => {}, { read: g.read, clock: { now: () => NOW } }))?.decision.reason, "invalid-action-config");
});

test("W1-T7754 admission wiring: actual daemon issue intake forwards opt-in policy and ledger receipts", async () => {
  for (const configured of [false, true]) {
    const root = tmpRoot(), f = sourceFixture();
    let captured: Parameters<typeof pollIssues>[1] | undefined;
    const hooks = buildIntakeRungsDaemonHooks({ config: { root, claudeBin: "/bin/true",
      ...(configured ? { contributorAdmission: f.settings } : {}) },
      clock: { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() },
      loadManagedRepos: () => [{ owner: "acme", repo: "widgets" }],
      pollIssues: async (_managed, deps) => { captured = deps; return { summary: { polledAt: new Date(NOW).toISOString(),
        repos: ["acme/widgets"], reviewedCount: 0, createdCount: 0 }, newIssues: [], created: [], skippedExisting: 0 }; },
    });
    assert.equal((await hooks.runIntakeRung({ rung: "issues", fire: true, reason: "fixture" })).status, "ok");
    assert.ok(captured);
    assert.equal(captured.admission?.policy, configured ? f.settings.policy : undefined);
    assert.equal(captured.admission?.mode, configured ? "shadow" : undefined);
    if (configured) {
      captured.admission!.record!("feedback_admission.shadow", { would_deny: true });
      const rows = readFileSync(captured.ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(rows.some(row => row.step === "feedback_admission.shadow" && row.task_id === "ISSUES"));
    }
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-feedback-origin-"));
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  return root;
}

function issueRow(number: number, user: { id: number; type: string; login: string } | undefined, association = "NONE") {
  return {
    id: 1000 + number, number, title: `issue ${number}`, body: "please change the thing", state: "open",
    updated_at: new Date(NOW - 1000).toISOString(),
    created_at: "2026-10-10T00:00:00Z", html_url: `https://github.com/acme/widgets/issues/${number}`, labels: [],
    ...(user === undefined ? {} : { user, author_association: association }),
  };
}

function gateway(rows: ReturnType<typeof issueRow>[]): IssueListGateway {
  return { list: (owner, repo) => rows.map((row) => normalizeIssue(owner, repo, row)),
    repository: (owner, repo) => ({ id: 100, fullName: `${owner}/${repo}`, private: false }) };
}

const SUMMARY = {
  headline: "Outside request to change the thing",
  what_happened: "An issue asked for the thing to change.",
  decision: "Decide whether to adopt the request",
  options: [{ label: "adopt", consequence: "a task is filed" }, { label: "decline", consequence: "nothing changes" }],
};

function triageInputs(candidates: string[]): AutoTriageInputs {
  return {
    policy: { enabled: true, minIntervalMinutes: 1, maxPerDay: 50 },
    deferralPending: true, dispatchCount: 0, laneBudget: 1, lockHeld: false,
    marker: { kind: "absent" }, now: new Date(NOW), candidates,
  };
}

function onDisk(root: string, id: string): Record<string, unknown> {
  return parseYaml(readFileSync(feedbackEntryPath(root, id), "utf8")) as Record<string, unknown>;
}

function upstreamFixture(calls: string[][]) {
  return {
    git: () => "https://github.com/someone-else/otherrepo.git\n",
    gh: (args: string[]) => {
      calls.push(args);
      if (args[1] === "repos/acme/upstream") return JSON.stringify({ default_branch: "main" });
      if (args[1].includes("git/ref/heads/main")) return JSON.stringify({ object: { sha: "a".repeat(40) } });
      if (args[1] === "repos/acme/upstream/pulls") return JSON.stringify({ html_url: "https://github.com/acme/upstream/pull/1" });
      return "{}";
    },
  };
}

test("W1-T7754 checkpoint: no-policy intake preserves legacy selection and writes no admission metadata", async () => {
  const root = tmpRoot();
  const result = await pollIssues([{ owner: "acme", repo: "widgets" }], {
    issues: gateway([issueRow(1, { id: 501, type: "User", login: "someone" })]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "compat", now: () => NOW,
  });
  assert.ok(newFeedbackIdsOldestFirst(root).includes(result.created[0].id));
  assert.equal("contribution" in onDisk(root, result.created[0].id), false);
});

test("W1-T7754 checkpoint: shadow selection observes without filtering external feedback", async () => {
  const root = tmpRoot();
  const result = await pollIssues([{ owner: "acme", repo: "widgets" }], {
    issues: gateway([issueRow(2, { id: 502, type: "User", login: "someone" })]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "shadow", now: () => NOW,
    admission: { mode: "shadow", policy: POLICY, nowMs: NOW },
  });
  assert.ok(newFeedbackIdsOldestFirst(root).includes(result.created[0].id));
});

for (const configured of [false, true]) {
  test(`W1-T7754 checkpoint: ${configured ? "shadow" : "no-policy"} capture preserves upstream effect`, () => {
    const root = tmpRoot();
    mkdirSync(join(root, ".remudero"), { recursive: true });
    writeFileSync(homeRepoPath(root), JSON.stringify({ repo: "acme/upstream" }));
    const calls: string[][] = [];
    const entry = captureFeedback(root, {
      raw: "outside request", origin: "issue#4", land: { stateRoot: root },
      contribution: { kind: "issue", sourceRef: "acme/widgets#4", observedAtMs: NOW,
        origin: { actor: { id: 503, type: "User", login: "someone" } } },
      ...(configured ? { admission: { mode: "shadow" as const, policy: POLICY, nowMs: NOW } } : {}),
      upstream: upstreamFixture(calls),
    });
    assert.equal(entry.upstream?.status, "landed");
    assert.equal(calls.filter((args) => args[1] === "repos/acme/upstream/pulls").length, 1);
  });
}

test("W1-T7754 checkpoint: numeric source identity and actual revision are required even for the owner", () => {
  const subject = { kind: "issue" as const, sourceRef: "acme/widgets#4", observedAtMs: NOW,
    origin: { actor: { id: OWNER_ID, type: "User" } } };
  assert.equal(classifyContribution(subject, "feedback", POLICY, [], NOW).outcome, "unknown");
});

test("W1-T7754 checkpoint: stored trusted admission is not current authority", () => {
  const contribution = admitFeedbackContribution({ kind: "issue", sourceRef: "acme/widgets#4", observedAtMs: NOW,
    origin: { actor: { id: OWNER_ID, type: "User" } } }, { policy: POLICY, nowMs: NOW });
  contribution.admission.outcome = "trusted";
  assert.equal(feedbackLineageAuthority({ origin: "issue#4", contribution }).autonomous, false);
});

test("W1-T7754: a trusted summary cannot launder external contribution origin", async () => {
  const root = tmpRoot();
  const outsider = { id: 9001, type: "User", login: "outsider" };
  const polled = await pollIssues([{ owner: "acme", repo: "widgets" }], {
    issues: gateway([issueRow(42, outsider)]), root, ledgerPath: join(root, "ledger.ndjson"), runId: "r1",
    now: () => NOW, admission: { mode: "shadow", policy: POLICY },
  });
  const [original] = polled.created;
  assert.deepEqual(original.contribution?.actor, outsider, "the issue author is recorded at capture");
  assert.equal(original.contribution?.source_ref, "acme/widgets#42");
  assert.equal(original.contribution?.admission.outcome, "confirmed-external");
  assert.equal(original.contribution?.admission.policy_version, "fixture-v1");

  // A trusted summarizer writes the decision card; the status write must keep the lineage.
  await proposeFeedbackWithSummary(root, original.id, { summarize: () => SUMMARY });
  const proposed = readFeedbackEntry(root, original.id);
  assert.equal(proposed.summary?.headline, SUMMARY.headline);
  assert.deepEqual(proposed.contribution, original.contribution, "a summary never rewrites the original lineage");

  // The relaying bot IS trusted in its own right — which is exactly what would launder the item.
  const botInput = {
    kind: "issue-comment" as const, sourceRef: "acme/widgets#42/comment/5", observedAtMs: NOW,
    repository: { id: 100, fullName: "acme/widgets", private: false }, itemId: 5, issueNumber: 42,
    revision: { updatedAt: new Date(NOW - 1000).toISOString(), contentDigest: feedbackContentDigest("summary") },
    origin: { actor: { id: SUMMARIZER_BOT_ID, type: "Bot", login: "rmd-summarizer[bot]" } },
  };
  assert.equal(admitFeedbackContribution(botInput, { mode: "shadow", policy: POLICY, nowMs: NOW }).admission.outcome, "trusted");

  // Re-filing the summary as feedback inherits the ORIGINAL contributor, not the summarizer's.
  const derived = captureFeedback(root, {
    raw: SUMMARY.headline, origin: "cli", land: { stateRoot: root },
    contribution: botInput, admission: { mode: "shadow", policy: POLICY, nowMs: NOW },
    derivedFrom: { entry: proposed, relayedBy: "rmd-summarizer[bot]" },
  });
  const written = onDisk(root, derived.id).contribution as FeedbackEntry["contribution"];
  assert.deepEqual(written?.actor, outsider, "the summarizer never becomes the contributor");
  assert.equal(written?.admission.outcome, "confirmed-external");
  assert.deepEqual(written?.relayed_by, ["rmd-summarizer[bot]"]);
  assert.equal(written?.derived_from, original.id);

  // The subsequent task proposal: neither entry supplies autonomous authority.
  for (const id of [original.id, derived.id]) {
    const authority = feedbackLineageAuthority(onDisk(root, id), { mode: "shadow", policy: POLICY,
      nowMs: NOW, currentSubject: original.contribution?.subject });
    assert.equal(authority.autonomous, false, `${id} must not authorize autonomous adoption`);
    assert.equal(authority.basis, "external-contribution");
  }
  assert.deepEqual(newFeedbackIdsOldestFirst(root).filter((id) => id === derived.id), [derived.id],
    "shadow observation is not live enforcement");
});

test("W1-T7754: feedback admission preserves trusted and legacy reconciliation flow", async () => {
  const root = tmpRoot();
  // An owner-authored issue is admitted by the shared classifier and stays autonomously usable.
  const polled = await pollIssues([{ owner: "acme", repo: "widgets" }], {
    issues: gateway([issueRow(7, { id: OWNER_ID, type: "User", login: "owner" }, "OWNER")]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "r2", now: () => NOW, admission: { mode: "shadow", policy: POLICY },
  });
  const [owned] = polled.created;
  assert.equal(owned.contribution?.admission.outcome, "trusted");
  assert.equal(owned.contribution?.admission.reason, "owner");

  // Legacy records carry no contribution. Each reconciles on its own origin.
  const dir = join(root, "plan", "feedback");
  writeFileSync(join(dir, "fb-legacy-cli.yaml"), "id: fb-legacy-cli\nts: 2026-01-01T00:00:00.000Z\norigin: cli\nstatus: new\n");
  writeFileSync(join(dir, "fb-legacy-incident.yaml"),
    `id: fb-legacy-incident\nts: 2026-01-02T00:00:00.000Z\norigin: incident#${"a".repeat(64)}\nstatus: new\n`);
  writeFileSync(join(dir, "fb-legacy-bare.yaml"), "id: fb-legacy-bare\nts: 2026-01-03T00:00:00.000Z\nstatus: new\n");
  writeFileSync(join(dir, "fb-legacy-issue.yaml"), "id: fb-legacy-issue\nts: 2026-01-04T00:00:00.000Z\norigin: issue#12\nstatus: new\n");

  // An operator's own CLI capture is unchanged: no contribution key is written at all.
  const cli = captureFeedback(root, { raw: "operator note", origin: "cli", land: { stateRoot: root } });
  assert.equal(readFileSync(feedbackEntryPath(root, cli.id), "utf8").includes("contribution"), false);

  const candidates = newFeedbackIdsOldestFirst(root);
  for (const id of ["fb-legacy-cli", "fb-legacy-incident", "fb-legacy-bare", owned.id, cli.id]) {
    assert.ok(candidates.includes(id), `${id} remains an autonomous candidate`);
  }
  // Unknown origin does not grant pure authority, but no-policy selection remains unchanged.
  assert.equal(candidates.includes("fb-legacy-issue"), true);
  assert.deepEqual(feedbackLineageAuthority(onDisk(root, "fb-legacy-issue")),
    { autonomous: false, basis: "unresolved-origin", reason: "legacy-origin-unresolved" });
  assert.equal(feedbackLineageAuthority(onDisk(root, "fb-legacy-cli")).basis, "legacy-internal");

  const decision = decideAutoTriage(triageInputs(candidates));
  assert.equal(decision.fire, true);
  assert.equal((decision as { feedbackId: string }).feedbackId, "fb-legacy-cli", "oldest trusted entry is still adopted");
});

test("W1-T7754: unresolved origin never supplies autonomous task authority", async () => {
  const root = tmpRoot();
  // Three unresolved shapes: no admission policy, no recorded author, unresolved membership.
  const noPolicy = await pollIssues([{ owner: "acme", repo: "widgets" }], {
    issues: gateway([issueRow(1, { id: 501, type: "User", login: "someone" })]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "r3", now: () => NOW,
  });
  const noActor = await pollIssues([{ owner: "acme", repo: "gadgets" }], {
    issues: gateway([issueRow(2, undefined)]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "r3", now: () => NOW, admission: { mode: "shadow", policy: POLICY },
  });
  const orgPolicy: AdmissionPolicy = { ...POLICY, organizationIds: [600] };
  const unresolved = await pollIssues([{ owner: "acme", repo: "sprockets" }], {
    issues: gateway([issueRow(3, { id: 502, type: "User", login: "maybe-member" })]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "r3", now: () => NOW, admission: { mode: "shadow", policy: orgPolicy },
  });
  const reasons = [noPolicy, noActor, unresolved].map((r) => r.created[0].contribution?.admission);
  assert.deepEqual(reasons.map((a) => [a?.outcome, a?.reason]), [
    [undefined, undefined], ["unknown", "missing-origin"], ["unknown", "membership-unresolved"],
  ]);
  for (const r of [noPolicy, noActor, unresolved]) {
    const authority = feedbackLineageAuthority(onDisk(root, r.created[0].id));
    assert.equal(authority.autonomous, false);
    assert.equal(authority.basis, "unresolved-origin");
  }

  // Separate the hypothetical authority decision from actual shadow effects.
  assert.equal(newFeedbackIdsOldestFirst(root).length, 3);
  const decision = decideAutoTriage(triageInputs(newFeedbackIdsOldestFirst(root)));
  assert.equal(decision.fire, true, "shadow-only does not claim to have blocked adoption");

  // No-config upstream behavior is preserved. All outward calls use a fixture, not GitHub.
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(homeRepoPath(root), JSON.stringify({ repo: "acme/upstream" }));
  const ghCalls: string[][] = [];
  const entry = captureFeedback(root, {
    raw: "relayed outside request", origin: "issue#4", land: { stateRoot: root },
    contribution: { kind: "issue", sourceRef: "acme/widgets#4", observedAtMs: NOW, origin: { actor: { id: 503, type: "User", login: "x" } } },
    upstream: upstreamFixture(ghCalls),
  });
  assert.equal(ghCalls.length, 5);
  assert.equal(entry.upstream?.status, "landed");

  // The shared classifier evaluates a feedback subject only for the feedback action.
  const subject = { kind: "issue" as const, sourceRef: "acme/widgets#4", observedAtMs: NOW,
    origin: { actor: { id: OWNER_ID, type: "User" } } };
  assert.equal(classifyContribution(subject, "auto-merge", POLICY, [], NOW).reason, "invalid-context");
  assert.equal(classifyContribution(subject, "feedback", POLICY, [], NOW).outcome, "unknown",
    "owner identity does not invent a missing source revision");
});

function boundIssue(): FeedbackAdmissionSubject {
  return { kind: "issue", sourceRef: "acme/widgets#4", observedAtMs: NOW,
    repository: { id: 100, fullName: "acme/widgets", private: true }, itemId: 1004, issueNumber: 4,
    revision: { updatedAt: new Date(NOW - 1000).toISOString(), contentDigest: feedbackContentDigest("source body") },
    origin: { actor: { id: OWNER_ID, type: "User", login: "owner" } } };
}

test("W1-T7754 checkpoint: authority re-evaluates a fresh bound source and rejects revisions and stale evidence", () => {
  const subject = boundIssue();
  const contribution = admitFeedbackContribution(subject, { mode: "shadow", policy: POLICY, nowMs: NOW });
  const entry = { origin: "issue#4", contribution };
  const context = { mode: "shadow" as const, policy: POLICY, nowMs: NOW, currentSubject: subject };
  assert.equal(feedbackLineageAuthority(entry, context).autonomous, true);
  assert.equal(feedbackLineageAuthority(entry, { ...context, currentSubject: undefined }).reason, "origin-recheck-unavailable");
  for (const currentSubject of [
    { ...subject, itemId: 1005 },
    { ...subject, repository: { ...subject.repository, id: 101 } },
    { ...subject, revision: { ...subject.revision, contentDigest: feedbackContentDigest("edited body") } },
    { ...subject, revision: { ...subject.revision, updatedAt: new Date(NOW).toISOString() } },
    { ...subject, origin: { actor: { id: 9001, type: "User" } } },
  ]) assert.equal(feedbackLineageAuthority(entry, { ...context, currentSubject }).reason, "source-revision-changed");
  assert.equal(feedbackLineageAuthority(entry, { ...context, nowMs: NOW + 60_001 }).reason, "stale-origin");
  contribution.admission.outcome = "confirmed-external";
  assert.equal(feedbackLineageAuthority(entry, context).autonomous, true, "stored outcome is not current authority");
});

test("W1-T7754 checkpoint: reaction identity uses created_at and separately binds derived parent revision", () => {
  const parent = boundIssue();
  const subject: FeedbackAdmissionSubject = { ...parent, kind: "issue-reaction", sourceRef: "acme/widgets#4/reaction/81",
    itemId: 81, revision: { createdAt: new Date(NOW - 500).toISOString(), contentDigest: feedbackContentDigest("+1") },
    parent: { kind: "issue", itemId: 1004, revision: parent.revision! } };
  assert.equal(classifyContribution(subject, "feedback", POLICY, [], NOW).outcome, "trusted");
  assert.equal(classifyContribution({ ...subject, parent: undefined }, "feedback", POLICY, [], NOW).reason, "invalid-parent-revision");
  assert.equal(classifyContribution({ ...subject, revision: { ...subject.revision, updatedAt: new Date(NOW).toISOString() } },
    "feedback", POLICY, [], NOW).reason, "invalid-source-revision");
  const comment: FeedbackAdmissionSubject = { ...subject, kind: "issue-comment-reaction", sourceRef: "acme/widgets#4/comment/9/reaction/81",
    parent: { kind: "issue-comment", itemId: 9, revision: parent.revision! } };
  assert.equal(classifyContribution(comment, "feedback", POLICY, [], NOW).outcome, "trusted");
  assert.equal(classifyContribution({ ...comment, parent: { ...comment.parent!, itemId: 10 } },
    "feedback", POLICY, [], NOW).reason, "invalid-parent-revision");
});

test("W1-T7754 checkpoint: shadow selection records would-deny but diagnostic failure cannot hold the queue", () => {
  const root = tmpRoot();
  const subject = boundIssue();
  subject.origin = { actor: { id: 9001, type: "User" } };
  const entry = captureFeedback(root, { raw: "outside request", origin: "issue#4", land: { stateRoot: root },
    contribution: subject, admission: { mode: "shadow", policy: POLICY, nowMs: NOW } });
  const receipts: Record<string, unknown>[] = [];
  const context = { mode: "shadow" as const, policy: POLICY, currentSubject: subject, nowMs: NOW,
    record: (_step: string, fields: Record<string, unknown>) => { receipts.push(fields); } };
  assert.ok(newFeedbackIdsOldestFirst(root, context).includes(entry.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].would_deny, true);
  assert.equal(receipts[0].basis, "external-contribution");
  assert.ok(newFeedbackIdsOldestFirst(root, { ...context, record: () => { throw new Error("receipt unavailable"); } }).includes(entry.id));
});

test("W1-T7754 checkpoint: capture deep-copies source binding and unreadable repository metadata stays unknown", async () => {
  const root = tmpRoot();
  const source = boundIssue();
  const contribution = admitFeedbackContribution(source, { mode: "shadow", policy: POLICY, nowMs: NOW });
  source.origin!.actor!.id = 9001;
  source.revision!.contentDigest = feedbackContentDigest("edited");
  assert.equal(contribution.subject?.origin?.actor?.id, OWNER_ID);
  assert.notEqual(contribution.subject?.revision?.contentDigest, source.revision!.contentDigest);
  const issues = gateway([issueRow(7, { id: OWNER_ID, type: "User", login: "owner" })]);
  issues.repository = () => { throw new Error("unreadable"); };
  const result = await pollIssues([{ owner: "acme", repo: "widgets" }], { issues, root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "unreadable", now: () => NOW,
    admission: { mode: "shadow", policy: POLICY } });
  assert.equal(result.created[0].contribution?.admission.reason, "invalid-source-identity");
  assert.ok(newFeedbackIdsOldestFirst(root).includes(result.created[0].id));
});

test("W1-T7754 checkpoint: default repository transport really spawns a contained CLI and rejects unreadable metadata", async () => {
  for (const stdout of [
    'HTTP/2 200 OK\ncontent-type: application/json\n\n{"id":100,"full_name":"acme/widgets","private":true}',
    'HTTP/2 404 Not Found\ncontent-type: application/json\n\n{}',
    'HTTP/2 200 OK\ncontent-type: application/json\n\nnull',
  ]) {
    const shim = ghShim([{ when: "", stdout }], { kind: "feedback-source-repository" });
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${oldPath}`;
    try {
      const repository = await ghIssueListGateway().repository!("acme", "widgets");
      assert.equal(shim.calls().length, 1, "the default adapter was exercised, not injected");
      assert.equal(shim.calls()[0], "api repos/acme/widgets -i");
      assert.deepEqual(repository, stdout.includes('"id":100') ? { id: 100, fullName: "acme/widgets", private: true } : undefined);
    } finally {
      process.env.PATH = oldPath;
      rmSync(shim.dir, { recursive: true, force: true });
    }
  }
});

test("W1-T7754 checkpoint: a policy without explicit shadow mode adds no metadata or repository reads", async () => {
  const root = tmpRoot();
  const issues = gateway([issueRow(8, { id: OWNER_ID, type: "User", login: "owner" })]);
  issues.repository = () => assert.fail("unconfigured metadata read");
  const result = await pollIssues([{ owner: "acme", repo: "widgets" }], { issues, root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "no-mode", now: () => NOW, admission: { policy: POLICY } });
  assert.equal(result.created[0].contribution, undefined);
  assert.ok(newFeedbackIdsOldestFirst(root).includes(result.created[0].id));
});

test("W1-T7754 checkpoint: malformed shadow lineage is unknown without changing legacy selection", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "plan", "feedback", "fb-malformed.yaml"), "status: new\nraw: [broken\n");
  const receipts: Record<string, unknown>[] = [];
  const context = { mode: "shadow" as const, policy: POLICY, nowMs: NOW,
    record: (_step: string, fields: Record<string, unknown>) => { receipts.push(fields); } };
  assert.deepEqual(newFeedbackIdsOldestFirst(root, context), ["fb-malformed"]);
  assert.equal(receipts[0].reason, "unreadable-entry");
  assert.equal(receipts[0].would_deny, true);
});

test("W1-T7754 checkpoint: legacy relay preserves unresolved source instead of fabricating an issue identity", () => {
  const parent = { id: "fb-old", origin: "issue#12" as const };
  const lineage = inheritFeedbackLineage(parent, "trusted-summarizer");
  assert.equal(lineage?.kind, "unresolved");
  assert.equal(lineage?.subject, undefined);
  assert.equal(lineage?.admission.outcome, "unknown");
  assert.equal(lineage?.admission.reason, "legacy-origin-unresolved");
  assert.deepEqual(lineage?.relayed_by, ["trusted-summarizer"]);
  assert.equal(lineage?.derived_from, parent.id);
  assert.equal(inheritFeedbackLineage({ ...parent, origin: "cli" }, "trusted-summarizer"), null);
});

test("W1-T7754 checkpoint: cyclic public lineage is unknown rather than a global trusted-flow hold", () => {
  const subject = boundIssue();
  const cyclic: Record<string, unknown> = { repository: {} };
  cyclic.origin = cyclic;
  assert.deepEqual(feedbackLineageAuthority({ contribution: { subject: cyclic } }, {
    mode: "shadow", policy: POLICY, nowMs: NOW, currentSubject: subject,
  }), { autonomous: false, basis: "unresolved-origin", reason: "lineage-unreadable" });
});

test("W1-T7754 consumers: every advancing merge preserves original lineage instead of trusting a later summary", () => {
  const original = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
  for (const status of ["new", "grilling", "proposed", "accepted", "rejected", "answered"]) {
    const upstream = { status: "new", contribution: original };
    for (const contribution of [undefined, { ...original, actor: { id: SUMMARIZER_BOT_ID, type: "Bot" } }]) {
      const local = { status, contribution, summary: { headline: "trusted summary" } };
      const decision = mergeFeedbackRecord(stringifyYaml(upstream), stringifyYaml(local));
      assert.equal(decision.kind, "take-local", "lineage repair must not strand a valid status advance");
      const staged = parseYaml((decision as { content?: string }).content ?? stringifyYaml(local));
      assert.deepEqual(staged.contribution, original, `immutable source survives ${status}`);
      assert.deepEqual(staged.summary, local.summary);
    }
  }
  assert.deepEqual(mergeFeedbackRecord(undefined, "status: new\n"), { kind: "take-local" });
  assert.deepEqual(mergeFeedbackRecord("status: new\n", "status: accepted\n"), { kind: "take-local" });
});

for (const path of ["disk", "status-content", "queued", "pending-disk", "pending-status-content", "pending-queued"] as const) {
  test(`W1-T7754 consumers: ${path} writer really stages original lineage and a forward status without a global hold`, () => {
    const origin = gitRepo({ bare: true, kind: "admission-origin" });
    const seed = gitRepo({ kind: "admission-seed" });
    const rel = "plan/feedback/fb-lineage.yaml";
    const original = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
    mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
    const originalContent = stringifyYaml({ id: "fb-lineage", status: "new", contribution: original });
    if (path.startsWith("pending-")) writeFileSync(join(seed.dir, "README.md"), "seed\n");
    else writeFileSync(join(seed.dir, rel), originalContent);
    seed.git("add", "-A");
    seed.git("commit", "--quiet", "-m", "chore: seed lineage");
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    const root = gitRepo({ cloneFrom: origin.dir, kind: "admission-consumer" });
    const content = stringifyYaml({ id: "fb-lineage", status: "accepted", summary: { headline: "trusted relay" } });
    const gh = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") return "[]";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/acme/widgets/pull/1\n";
      assert.fail(`unexpected GitHub effect ${JSON.stringify(args)}`);
    };
    const opts = { gh, targetRepository: { owner: "acme", repo: "widgets" },
      sourceRepository: { owner: "acme", repo: "widgets" } };
    const result = withLiveWritesAllowed(() => {
      if (path.startsWith("pending-")) {
        const first = landFeedbackStatusContent(root.dir, rel, originalContent, opts);
        assert.equal(first.landed, true, JSON.stringify(first));
      }
      if (path.endsWith("status-content")) return landFeedbackStatusContent(root.dir, rel, content, opts);
      if (path.endsWith("queued")) {
        const stateRoot = tmpRoot();
        const queued = landFeedbackStatusContent(root.dir, rel, content, { ...opts, stateRoot });
        assert.deepEqual(queued.queued, [rel]);
        return sweepFeedbackLanding(root.dir, { ...opts, stateRoot });
      }
      mkdirSync(join(root.dir, "plan", "feedback"), { recursive: true });
      writeFileSync(join(root.dir, rel), content);
      return landFeedback(root.dir, opts);
    });
    assert.equal(result.landed, true, JSON.stringify(result));
    assert.equal(result.refused, undefined);
    const staged = parseYaml(origin.git("show", `${LANDING_BRANCH}:${rel}`));
    assert.equal(staged.status, "accepted");
    assert.deepEqual(staged.contribution, original);
  });
}

for (const lineaged of [true, false]) {
test(`W1-T7754 consumers: carried pending ${lineaged ? "content cannot replace main lineage" : "legacy content keeps its prior effect"} while another record lands`, () => {
  const origin = gitRepo({ bare: true, kind: "admission-carry-origin" });
  const seed = gitRepo({ kind: "admission-carry-seed" });
  const rel = "plan/feedback/fb-original.yaml";
  const original = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed.dir, rel), stringifyYaml({ id: "fb-original", status: lineaged ? "new" : "accepted", ...(lineaged ? { contribution: original } : {}) }));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: original");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.git("checkout", "-b", LANDING_BRANCH);
  writeFileSync(join(seed.dir, rel), stringifyYaml({ id: "fb-original", status: lineaged ? "accepted" : "new", ...(lineaged ? { contribution: { actor: { id: SUMMARIZER_BOT_ID } } } : {}) }));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: stale relay");
  seed.git("push", "--quiet", "origin", LANDING_BRANCH);
  const root = gitRepo({ cloneFrom: origin.dir, kind: "admission-carry-consumer" });
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(root.dir, "plan/feedback/fb-other.yaml",
    "id: fb-other\nstatus: new\n", { gh: args => {
      if (args[1] === "list") return "[]";
      if (args[1] === "create") return "https://github.com/acme/widgets/pull/2\n";
      assert.fail(`unexpected GitHub effect ${JSON.stringify(args)}`);
    }, targetRepository: { owner: "acme", repo: "widgets" }, sourceRepository: { owner: "acme", repo: "widgets" } }));
  assert.equal(result.landed, true, JSON.stringify(result));
  const staged = parseYaml(origin.git("show", `${LANDING_BRANCH}:${rel}`));
  assert.equal(staged.status, lineaged ? "accepted" : "new");
  assert.deepEqual(staged.contribution, lineaged ? original : undefined);
});
}

for (const writer of ["disk", "status-content", "queued"]) {
for (const malformed of [false, true]) {
test(`W1-T7754 consumers: ${writer} unchanged pending legacy ${malformed ? "unreadable" : "plain"} content stays in the receipt without restarting CI`, () => {
  const origin = gitRepo({ bare: true, kind: "admission-no-churn-origin" });
  const seed = gitRepo({ kind: "admission-no-churn-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const root = gitRepo({ cloneFrom: origin.dir, kind: "admission-no-churn-consumer" });
  mkdirSync(join(root.dir, "plan", "feedback"), { recursive: true });
  const rel = "plan/feedback/fb-legacy.yaml";
  const opts = { gh: (args: string[]) => {
    if (args[1] === "list") return "[]";
    if (args[1] === "create") return "https://github.com/acme/widgets/pull/3\n";
    assert.fail(`unexpected GitHub effect ${JSON.stringify(args)}`);
  }, targetRepository: { owner: "acme", repo: "widgets" }, sourceRepository: { owner: "acme", repo: "widgets" } };
  const stateRoot = tmpRoot();
  const land = (path: string, content: string) => withLiveWritesAllowed(() => {
    if (writer === "status-content") return landFeedbackStatusContent(root.dir, path, content, opts);
    if (writer === "queued") {
      landFeedbackStatusContent(root.dir, path, content, { ...opts, stateRoot });
      return sweepFeedbackLanding(root.dir, { ...opts, stateRoot });
    }
    writeFileSync(join(root.dir, path), content);
    return landFeedback(root.dir, opts);
  });
  const originalContent = malformed ? "id: [\n" : "id: fb-legacy\nraw: unchanged\n";
  const first = land(rel, originalContent);
  assert.equal(first.landed, true, JSON.stringify(first));
  const head = origin.git("rev-parse", LANDING_BRANCH).trim();
  const unchanged = land(rel, originalContent);
  assert.deepEqual(unchanged.files, [rel]);
  assert.equal(unchanged.pushed, false);
  assert.equal(origin.git("rev-parse", LANDING_BRANCH).trim(), head);
  const another = "plan/feedback/fb-next.yaml";
  const changed = land(another, "id: fb-next\nraw: new\n");
  assert.deepEqual(changed.files.sort(), writer === "status-content" ? [another] : [rel, another].sort());
  assert.equal(changed.pushed, true);
  const changedHead = origin.git("rev-parse", LANDING_BRANCH).trim();
  const editedContent = "id: fb-legacy\nraw: edited\n";
  const edited = land(rel, editedContent);
  assert.equal(edited.pushed, true, JSON.stringify(edited));
  assert.notEqual(origin.git("rev-parse", LANDING_BRANCH).trim(), changedHead);
  assert.equal(origin.git("show", `${LANDING_BRANCH}:${rel}`), editedContent.trim());
});
}
}

test("W1-T7754 consumers: actual triage prompt retains original lineage inside its untrusted boundary", () => {
  const contribution = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
  const entry: FeedbackEntry = { id: "fb-prompt", ts: new Date(NOW).toISOString(), raw: "trusted summary of outside request",
    status: "new", origin: "issue#4", attachments: [], proposal_pr: null, contribution };
  const block = feedbackEntryBlock(entry);
  const position = block.indexOf(JSON.stringify(contribution));
  assert.ok(position > block.indexOf("<untrusted_external_data "));
  assert.ok(position < block.indexOf("</untrusted_external_data "));
  assert.ok(block.includes(entry.raw));
});

test("W1-T7754 consumers: rebuilt answer-to-fix arguments preserve every original source even when text deduplicates", () => {
  const original = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
  const other = structuredClone(original);
  other.actor = { id: 9001, type: "User" };
  const answers = [original, other].map(contribution => ({ task: "W1-FIX", answer: "use B", ts: new Date(NOW).toISOString(),
    origin: "trusted-relay", contribution }));
  const pending = operatorVerdictEvidence("W1-FIX", [], answers);
  assert.ok(pending);
  assert.deepEqual((pending as { contributions?: unknown[] }).contributions, [original, other]);
  const built = buildFixRungDispatchArgs({ task: { id: "W1-FIX", title: "fix", type: "implement", verify: "auto", acceptance: [] } as never,
    runId: "fix", prUrl: "https://github.com/acme/widgets/pull/1", branch: "fixture", worktreePath: "/fixture",
    mount: { provider: "claude", model: "fixture" } as never, settingsFile: "/fixture/settings", config: {} as never,
    budgetUsd: 1, strikeCap: 1, evidence: { unmetCriteria: [] }, pr: { headSha: "a".repeat(40), pendingAnswer: pending },
    reviewBase: { owner: "acme", repo: "widgets", headCheckoutDir: "/fixture", reviewerMount: {} as never } });
  assert.ok(built.constraint?.includes(JSON.stringify(original)));
  assert.ok(built.constraint?.includes(JSON.stringify(other)));
  original.actor!.id = 666;
  assert.notEqual((pending as { contributions?: Array<{ actor: { id: number } }> }).contributions![0].actor.id, 666);
  const rebuilt = operatorVerdictEvidence("W1-FIX", [], answers);
  assert.equal((rebuilt as { contributions?: Array<{ actor: { id: number } }> }).contributions![0].actor.id, 666);
  assert.equal(operatorVerdictEvidence("W1-FIX", [], [{ task: "W1-FIX", answer: "use B" }])?.constraint, "use B");
});

test("W1-T7754 consumers: unreadable prompt lineage is unknown without erasing text or changing legacy constraints", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const payload = feedbackLineagePayload("original answer", [cyclic]);
  assert.ok(payload.includes("original answer"));
  assert.ok(payload.includes("unknown origin, not an authority grant"));
  assert.equal(feedbackLineagePayload("owner instruction", []), "owner instruction");
  const contribution = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
  const evidence = operatorVerdictEvidence("W1-FIX", [{ step: "operator_feedback", task_id: "W1-FIX", verdict: "wrong",
    note: "trusted relay", ts: new Date(NOW).toISOString(), contribution }], []);
  assert.deepEqual(evidence?.contributions, [contribution]);
  const spent = operatorVerdictEvidence("W1-FIX", [{ step: "fix.dispatch", task_id: "W1-FIX", ts: new Date(NOW + 1).toISOString() }],
    [{ task: "W1-FIX", answer: "original answer", ts: new Date(NOW).toISOString(), contribution }]);
  assert.equal(spent?.spent, true);
  assert.deepEqual(spent?.contributions, [contribution]);
  const unreadable = operatorVerdictEvidence("W1-FIX", [], [{ task: "W1-FIX", answer: "original answer", contribution: () => {} }]);
  assert.deepEqual(unreadable?.contributions, [{ kind: "unresolved", reason: "lineage-unreadable" }]);
});
