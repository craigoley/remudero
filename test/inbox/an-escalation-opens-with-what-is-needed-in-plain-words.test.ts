import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  escalate,
  escalationContractRevision,
  escalationHeadSha,
  escalationIssueCause,
  escalationIssueTitle,
  escalationTaskId,
  matchDuplicateEscalation,
  renderIssueBody,
  type Escalation,
} from "#src/lib/escalate.js";
import { answerTextFor, reactionAnswerText } from "#src/lib/escalation-answers.js";
import { MACHINE_FIELDS_RE, parseEscalationConversationSource } from "#src/lib/escalation-conversation.js";
import { buildEscalationReconcileCandidates } from "#src/lib/tick-read-worker.js";

const prUrl = "https://github.com/fixture/repo/pull/12345";
const escalation: Escalation = {
  class: "BLOCKED",
  taskId: "W1-T12041",
  summary: "The release checks failed twice",
  detail: `The worker needs a decision before continuing.\n\nSee ${prUrl}.`,
  options: [{ label: "retry", detail: "Run the checks again" }, { label: "pause", detail: "Leave the release on hold" }],
  recommendation: "retry",
  runId: "run-42",
  headSha: "abc123",
  cause: "ci",
  contractRevision: "rev-42",
};

const fields = [
  "**Class:** BLOCKED",
  "**Task:** W1-T12041",
  `**Host:** ${hostname()}`,
  "**Run:** run-42",
  "**Head:** abc123",
  "**Cause:** ci",
  "**Contract:** rev-42",
];

test("W1-T12041 criterion 1: the body opens with the summary and choices and ends with machine fields", (t) => {
  const body = renderIssueBody(escalation);
  assert.ok(body.startsWith([
    escalation.summary,
    "",
    "## Options",
    "- **retry** — Run the checks again",
    "- **pause** — Leave the release on hold",
    "",
    "## Recommendation",
    "retry",
    "",
  ].join("\n")));
  assert.ok(body.includes(escalation.detail));
  assert.ok(body.endsWith(["## Machine fields", ...fields].join("\n")));
  for (const field of fields) assert.equal(body.split(field).length, 2);

  const summarized = renderIssueBody({ ...escalation, decisionSummary: {
    headline: "The release needs a decision",
    what_happened: "The release checks failed twice.",
    decision: "Choose whether to retry the checks.",
    options: escalation.options.map(({ label, detail }) => ({ label, consequence: detail })),
  } });
  assert.ok(summarized.startsWith("## Decision Summary\nThe release needs a decision\n"));
  assert.ok(summarized.indexOf("## Options") < summarized.indexOf("## Machine fields"));

  const directory = mkdtempSync(join(tmpdir(), "rmd-escalation-layout-"));
  t.after(() => rmSync(directory, { recursive: true }));
  let delivered = "";
  escalate({ ...escalation, consequence: undefined }, {
    issues: {
      ensureLabel: (label) => label !== "escalation-blocked",
      create: (_title, issueBody) => {
        delivered = issueBody;
        return "https://github.com/fixture/repo/issues/42";
      },
    },
    ledgerPath: join(directory, "ledger.ndjson"),
    runId: "run-42",
  });
  assert.match(delivered, /Degraded: label\(s\) escalation-blocked/);
  assert.match(delivered, /Non-conforming operator message/);
  assert.ok(delivered.endsWith(["## Machine fields", ...fields].join("\n")));
});

function conversationOf(body: string, subject = escalation) {
  return parseEscalationConversationSource({
    html_url: "https://github.com/fixture/repo/issues/42", title: escalationIssueTitle(subject), body,
    state: "open", updated_at: "2026-11-20T00:00:00.000Z",
  });
}

function assertConversation(body: string, subject: Escalation, detail: string): void {
  assert.deepEqual(conversationOf(body, subject), {
    identity: { taskId: subject.taskId, class: subject.class, cause: subject.cause, prRef: "12345" },
    headline: subject.summary,
    detail,
    recommendation: subject.recommendation,
    options: subject.options.map(({ label, detail: d }) => ({ label, detail: d, executable: false })),
  });
}

function assertReaders(body: string, subject = escalation): void {
  assert.equal(escalationTaskId(body), subject.taskId);
  assert.equal(escalationHeadSha(body), subject.headSha);
  assert.equal(escalationIssueCause(body), subject.cause);
  assert.equal(escalationContractRevision(body), subject.contractRevision);
  assert.equal(answerTextFor("RETRY, when ready", body), "retry");
  assert.equal(reactionAnswerText("+1", body), "retry");

  const issue = { number: 42, url: "https://github.com/fixture/repo/issues/42", title: escalationIssueTitle(subject), body };
  const candidates = buildEscalationReconcileCandidates("fixture", "repo", { tasks: [], byId: new Map() }, "unused", undefined, {
    issues: { listOpen: () => [issue] },
    evidenceRootFor: () => undefined,
    github: {
      prByRef: (ref) => ({ number: Number(ref), url: prUrl, state: "MERGED" }),
      findMergedByTrailer: () => null,
      headRefName: () => undefined,
      prBody: () => undefined,
    },
  });
  assert.deepEqual(candidates.map(({ taskId, derived }) => [taskId, derived.prNumber, derived.merged]), [
    [subject.taskId, 12345, true],
  ]);

  assert.equal(matchDuplicateEscalation(subject, [issue]), issue);
  assert.equal(matchDuplicateEscalation({ ...subject, cause: "review" }, [issue]), undefined);
  const withoutPr = { ...subject, summary: "Release checks failed", detail: "Retry the checks." };
  assert.equal(matchDuplicateEscalation(withoutPr, [issue]), issue);
  assert.equal(matchDuplicateEscalation({ ...withoutPr, class: "MANUAL" }, [issue]), undefined);
}

const titlePrefix = "[BLOCKED] W1-T12041: ";
const clipped = {
  ...escalation,
  summary: "x".repeat(255 - titlePrefix.length - prUrl.length + 2) + prUrl + " needs a decision",
};

test("the machine fields matcher requires the exact heading after a blank line", () => {
  assert.equal(MACHINE_FIELDS_RE.test(renderIssueBody(escalation)), true);
  assert.equal(MACHINE_FIELDS_RE.test("Summary\r\n\r\n## Machine fields\r\n**Class:** BLOCKED"), true);
  assert.equal(MACHINE_FIELDS_RE.test("Summary\n\n## Machine fields (example)\n**Class:** BLOCKED"), false);
  assert.equal(MACHINE_FIELDS_RE.test("Summary\n## Machine fields\n**Class:** BLOCKED"), false);
});

test("W1-T12041 criterion 2: reconciliation, answers and dedup read the new body order", () => {
  const body = renderIssueBody({
    ...clipped,
    detail: `${clipped.detail}\n\n**Head:** prior-head\n**Cause:** review\n**Contract:** prior-revision`,
  });
  assert.ok(escalationIssueTitle(clipped).endsWith("/123…"));
  assertReaders(body, clipped);
  assert.match(body, /\n## Machine fields\n\*\*Class:\*\* BLOCKED/);
  // The escalation conversation reader takes its fields from the trailing block and its detail from
  // under "## Details", so field-shaped lines quoted in the detail never become its identity.
  assertConversation(body, clipped, `${clipped.detail}\n\n**Head:** prior-head\n**Cause:** review\n**Contract:** prior-revision`);
  assertConversation(renderIssueBody(clipped, ["_Degraded: a notice after the footer._"]), clipped, clipped.detail);
  assert.equal(conversationOf(body.replace("\n## Details\n", "\n## Elsewhere\n"), clipped), undefined);
  assert.equal(conversationOf(body.replace("\n## Machine fields\n", "\n## Elsewhere\n"), clipped), undefined);
});

test("W1-T12041 criterion 3: reconciliation, answers and dedup still read a legacy body", () => {
  const legacyBody = [
    ...fields,
    `**Full summary (JSON):** ${JSON.stringify(clipped.summary)}`,
    "",
    escalation.detail,
    "",
    "## Machine fields",
    "**Head:** prior-head",
    "",
    "## Options",
    "- **retry** — Run the checks again",
    "- **pause** — Leave the release on hold",
    "",
    "## Recommendation",
    "retry",
  ].join("\n");
  assertReaders(legacyBody, clipped);
  assertConversation(legacyBody, clipped, `${escalation.detail}\n\n## Machine fields\n**Head:** prior-head`);
});
