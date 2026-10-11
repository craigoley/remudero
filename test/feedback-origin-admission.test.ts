import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { feedbackLineageAuthority } from "../src/lib/authority.js";
import { decideAutoTriage, newFeedbackIdsOldestFirst, type AutoTriageInputs } from "../src/lib/auto-triage.js";
import { classifyContribution, type AdmissionPolicy } from "../src/lib/contributor-admission.js";
import {
  admitFeedbackContribution, captureFeedback, feedbackEntryPath, homeRepoPath, proposeFeedbackWithSummary,
  readFeedbackEntry, type FeedbackEntry,
} from "../src/lib/feedback.js";
import { normalizeIssue, pollIssues, type IssueListGateway } from "../src/lib/issues-intake.js";

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
    number, title: `issue ${number}`, body: "please change the thing", state: "open",
    created_at: "2026-10-10T00:00:00Z", html_url: `https://github.com/acme/widgets/issues/${number}`, labels: [],
    ...(user === undefined ? {} : { user, author_association: association }),
  };
}

function gateway(rows: ReturnType<typeof issueRow>[]): IssueListGateway {
  return { list: (owner, repo) => rows.map((row) => normalizeIssue(owner, repo, row)) };
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
    now: () => NOW, admission: { policy: POLICY },
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
    origin: { actor: { id: SUMMARIZER_BOT_ID, type: "Bot", login: "rmd-summarizer[bot]" } },
  };
  assert.equal(admitFeedbackContribution(botInput, { policy: POLICY, nowMs: NOW }).admission.outcome, "trusted");

  // Re-filing the summary as feedback inherits the ORIGINAL contributor, not the summarizer's.
  const derived = captureFeedback(root, {
    raw: SUMMARY.headline, origin: "cli", land: { stateRoot: root },
    contribution: botInput, admission: { policy: POLICY, nowMs: NOW },
    derivedFrom: { entry: proposed, relayedBy: "rmd-summarizer[bot]" },
  });
  const written = onDisk(root, derived.id).contribution as FeedbackEntry["contribution"];
  assert.deepEqual(written?.actor, outsider, "the summarizer never becomes the contributor");
  assert.equal(written?.admission.outcome, "confirmed-external");
  assert.deepEqual(written?.relayed_by, ["rmd-summarizer[bot]"]);
  assert.equal(written?.derived_from, original.id);

  // The subsequent task proposal: neither entry supplies autonomous authority.
  for (const id of [original.id, derived.id]) {
    const authority = feedbackLineageAuthority(onDisk(root, id));
    assert.equal(authority.autonomous, false, `${id} must not authorize autonomous adoption`);
    assert.equal(authority.basis, "external-contribution");
  }
  assert.deepEqual(newFeedbackIdsOldestFirst(root).filter((id) => id === derived.id), []);
});

test("W1-T7754: feedback admission preserves trusted and legacy reconciliation flow", async () => {
  const root = tmpRoot();
  // An owner-authored issue is admitted by the shared classifier and stays autonomously usable.
  const polled = await pollIssues([{ owner: "acme", repo: "widgets" }], {
    issues: gateway([issueRow(7, { id: OWNER_ID, type: "User", login: "owner" }, "OWNER")]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "r2", now: () => NOW, admission: { policy: POLICY },
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
  // Only the one legacy issue whose author was never recorded waits for the owner.
  assert.equal(candidates.includes("fb-legacy-issue"), false);
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
    ledgerPath: join(root, "ledger.ndjson"), runId: "r3", now: () => NOW, admission: { policy: POLICY },
  });
  const orgPolicy: AdmissionPolicy = { ...POLICY, organizationIds: [600] };
  const unresolved = await pollIssues([{ owner: "acme", repo: "sprockets" }], {
    issues: gateway([issueRow(3, { id: 502, type: "User", login: "maybe-member" })]), root,
    ledgerPath: join(root, "ledger.ndjson"), runId: "r3", now: () => NOW, admission: { policy: orgPolicy },
  });
  const reasons = [noPolicy, noActor, unresolved].map((r) => r.created[0].contribution?.admission);
  assert.deepEqual(reasons.map((a) => [a?.outcome, a?.reason]), [
    ["unknown", "no-admission-policy"], ["unknown", "missing-origin"], ["unknown", "membership-unresolved"],
  ]);
  for (const r of [noPolicy, noActor, unresolved]) {
    const authority = feedbackLineageAuthority(onDisk(root, r.created[0].id));
    assert.equal(authority.autonomous, false);
    assert.equal(authority.basis, "unresolved-origin");
  }

  // Effect trap: the autonomous rung has nothing it may adopt, so it never fires.
  assert.deepEqual(newFeedbackIdsOldestFirst(root), []);
  const decision = decideAutoTriage(triageInputs(newFeedbackIdsOldestFirst(root)));
  assert.equal(decision.fire, false);

  // Effect trap: an unresolved contribution is never published to a home repo either.
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(homeRepoPath(root), JSON.stringify({ repo: "acme/upstream" }));
  const ghCalls: string[][] = [];
  const entry = captureFeedback(root, {
    raw: "relayed outside request", origin: "issue#4", land: { stateRoot: root },
    contribution: { kind: "issue", sourceRef: "acme/widgets#4", observedAtMs: NOW, origin: { actor: { id: 503, type: "User", login: "x" } } },
    upstream: {
      git: () => "https://github.com/someone-else/otherrepo.git\n",
      gh: (args) => { ghCalls.push(args); throw new Error("gh must not be called"); },
    },
  });
  assert.deepEqual(ghCalls, []);
  assert.equal(entry.upstream?.status, "withheld");

  // The shared classifier evaluates a feedback subject only for the feedback action.
  const subject = { kind: "issue" as const, sourceRef: "acme/widgets#4", observedAtMs: NOW,
    origin: { actor: { id: OWNER_ID, type: "User" } } };
  assert.equal(classifyContribution(subject, "auto-merge", POLICY, [], NOW).reason, "invalid-context");
  assert.equal(classifyContribution(subject, "feedback", POLICY, [], NOW).outcome, "trusted");
});
