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
import { buildFixRungDispatchArgs } from "./helpers/run-task-test.js";

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

test("W1-T7754 consumers: carried pending content cannot replace main lineage while another record lands", () => {
  const origin = gitRepo({ bare: true, kind: "admission-carry-origin" });
  const seed = gitRepo({ kind: "admission-carry-seed" });
  const rel = "plan/feedback/fb-original.yaml";
  const original = admitFeedbackContribution(boundIssue(), { mode: "shadow", policy: POLICY, nowMs: NOW });
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed.dir, rel), stringifyYaml({ id: "fb-original", status: "new", contribution: original }));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: original");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.git("checkout", "-b", LANDING_BRANCH);
  writeFileSync(join(seed.dir, rel), stringifyYaml({ id: "fb-original", status: "accepted", contribution: { actor: { id: SUMMARIZER_BOT_ID } } }));
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
  assert.equal(staged.status, "accepted");
  assert.deepEqual(staged.contribution, original);
});

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
