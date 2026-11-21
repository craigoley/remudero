import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  escalate,
  escalationContractRevision,
  escalationHeadSha,
  escalationIssueCause,
  escalationIssueTitle,
  escalationTaskId,
  MACHINE_FIELD_LINE_RE,
  matchDuplicateEscalation,
  renderIssueBody,
  SECTION_HEADING_LINE_RE,
  SUMMARY_HEADING_WORD_RE,
  type Escalation,
} from "#src/lib/escalate.js";
import { answerTextFor, reactionAnswerText, readEscalationAnswers } from "#src/lib/escalation-answers.js";
import {
  createEscalationConversationReader,
  MACHINE_FIELDS_RE,
  parseEscalationConversationSource,
  QUOTED_MACHINE_FIELD_LINE_RE,
} from "#src/lib/escalation-conversation.js";
import { issueTaskId, supersededDuplicates } from "#src/lib/issue-revalidation-garden.js";
import { buildEscalationReconcileCandidates } from "#src/lib/tick-read-worker.js";
import { taskInputAnswer } from "#src/lib/worker.js";

const prUrl = "https://github.com/fixture/repo/pull/12345";
const otherPrUrl = "https://github.com/fixture/repo/pull/54321";
const issueUrl = "https://github.com/fixture/repo/issues/42";
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

function sourceOf(body: string, subject = escalation) {
  return {
    html_url: issueUrl, title: escalationIssueTitle(subject), body,
    state: "open" as const, updated_at: "2026-11-20T00:00:00.000Z",
  };
}

function conversationOf(body: string, subject = escalation) {
  return parseEscalationConversationSource(sourceOf(body, subject));
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

async function assertReaders(t: TestContext, body: string, subject: Escalation, prState: "OPEN" | "MERGED"): Promise<void> {
  assert.equal(escalationTaskId(body), subject.taskId);
  assert.equal(escalationHeadSha(body), subject.headSha);
  assert.equal(escalationIssueCause(body), subject.cause);
  assert.equal(escalationContractRevision(body), subject.contractRevision);
  assert.equal(answerTextFor("RETRY, when ready", body), "retry");
  assert.equal(reactionAnswerText("+1", body), "retry");

  const issue = { number: 42, url: issueUrl, title: escalationIssueTitle(subject), body };
  const candidates = buildEscalationReconcileCandidates("fixture", "repo", { tasks: [], byId: new Map() }, "unused", undefined, {
    issues: { listOpen: () => [issue] },
    evidenceRootFor: () => undefined,
    github: {
      prByRef: (ref) => Number(ref) === 12345
        ? { number: 12345, url: prUrl, state: prState }
        : { number: 54321, url: otherPrUrl, state: "MERGED" },
      findMergedByTrailer: () => null,
      headRefName: () => undefined,
      prBody: () => undefined,
    },
  });
  assert.deepEqual(candidates.map(({ taskId, derived }) => [taskId, derived.prNumber, derived.merged]), [
    [subject.taskId, 12345, prState === "MERGED"],
  ]);

  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-answer-layout-"));
  t.after(() => rmSync(root, { recursive: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const answers = await readEscalationAnswers(root, "fixture", {
    listOpen: () => [issue],
    listComments: () => [{ id: 3, body: "RETRY, when ready", authorLogin: "operator", authorAssociation: "OWNER", authorType: "User" }],
    reactPlusOne: () => {},
  }, { ledgerPath });
  assert.equal(answers.accepted, 1);
  assert.equal(taskInputAnswer(root, subject.taskId), "retry");
  assert.equal(taskInputAnswer(root, "PR-54321"), undefined);

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

/** What a repeat of `request` does against one open issue carrying `body`: reuse it or open another. */
function repeatOutcome(t: TestContext, request: Escalation, body: string): "reused" | "opened" {
  const directory = mkdtempSync(join(tmpdir(), "rmd-escalation-dedup-layout-"));
  t.after(() => rmSync(directory, { recursive: true }));
  let opened = false;
  const issue = { number: 42, url: issueUrl, title: escalationIssueTitle(request), body };
  escalate(request, {
    issues: {
      listOpen: () => [issue],
      create: () => { opened = true; return "https://github.com/fixture/repo/issues/43"; },
      comment: () => {},
    },
    ledgerPath: join(directory, "ledger.ndjson"),
    runId: "run-42",
  });
  return opened ? "opened" : "reused";
}

/** The fields-first body the writer produced before W1-T12041, for the same escalation. */
function legacyBodyOf(e: Escalation): string {
  return [
    `**Class:** ${e.class}`, `**Task:** ${e.taskId}`, `**Host:** ${hostname()}`, `**Run:** ${e.runId}`,
    `**Head:** ${e.headSha}`, `**Cause:** ${e.cause}`, `**Contract:** ${e.contractRevision}`,
    ...(escalationIssueTitle(e).endsWith("…") ? [`**Full summary (JSON):** ${JSON.stringify(e.summary)}`] : []),
    "", e.detail, "", "## Options", ...e.options.map((o) => `- **${o.label}** — ${o.detail}`), "",
    "## Recommendation", e.recommendation, "",
    "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_",
    "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
  ].join("\n");
}

test("W1-T12041 criterion 1: a bare PR in Details and a PR link in Options open issues exactly as the fields-first order did", (t) => {
  // The reviewer's case: bare PR #12345 in Details, a full link to PR #54321 in Options. The legacy
  // matcher read #54321 (a full link outranks a bare reference), so a repeat opened another issue.
  const subject = {
    ...escalation,
    detail: "The release is blocked on PR #12345.",
    options: [{ label: "retry", detail: `Compare the checks with ${otherPrUrl}.` }, escalation.options[1]!],
  };
  for (const summary of [subject.summary, subject.summary + " x".repeat(150)]) {
    const request = { ...subject, summary };
    assert.equal(repeatOutcome(t, request, legacyBodyOf(request)), "opened");
    assert.equal(repeatOutcome(t, request, renderIssueBody(request)), "opened");
    // Two full links: the fields-first order read Details first, and so does the new order.
    const linked = { ...request, detail: `The release is blocked on ${prUrl}.` };
    assert.equal(repeatOutcome(t, linked, legacyBodyOf(linked)), "reused");
    assert.equal(repeatOutcome(t, linked, renderIssueBody(linked)), "reused");
    const other = { ...request, detail: `The release is blocked on ${otherPrUrl}.` };
    assert.equal(matchDuplicateEscalation(other, [{ number: 42, url: issueUrl, title: escalationIssueTitle(request), body: renderIssueBody(linked) }]), undefined);
  }
});

test("the machine fields matcher requires the exact heading after a blank line", () => {
  assert.equal(MACHINE_FIELDS_RE.test(renderIssueBody(escalation)), true);
  assert.equal(MACHINE_FIELDS_RE.test("Summary\r\n\r\n## Machine fields\r\n**Class:** BLOCKED"), true);
  assert.equal(MACHINE_FIELDS_RE.test("Summary\n\n## Machine fields (example)\n**Class:** BLOCKED"), false);
  assert.equal(MACHINE_FIELDS_RE.test("Summary\n## Machine fields\n**Class:** BLOCKED"), false);
});

test("section heading quoting matches reserved headings and rejects lookalikes", () => {
  assert.equal(SECTION_HEADING_LINE_RE.test("## Details\t"), true);
  assert.equal(SECTION_HEADING_LINE_RE.test("## Details from the prior run"), false);
});

test("machine field quoting matches fields at the start of a line", () => {
  assert.equal(MACHINE_FIELD_LINE_RE.test("Compare **Task:** PR-54321"), false);
  assert.equal(MACHINE_FIELD_LINE_RE.test("**Task owner:** Operator"), false);
  assert.equal(MACHINE_FIELD_LINE_RE.test("**Task:** PR-54321"), true);
  assert.equal(MACHINE_FIELD_LINE_RE.test('  **Full summary (JSON):** "Prior summary"'), true);
});

test("summary quoting recognizes reserved heading words within the summary", () => {
  assert.equal(SUMMARY_HEADING_WORD_RE.test("See ## Prior recommendation"), false);
  assert.equal(SUMMARY_HEADING_WORD_RE.test("See ## recommendation"), true);
  SUMMARY_HEADING_WORD_RE.lastIndex = 0;
});

test("machine field unquoting requires a leading space before a machine field label", () => {
  assert.equal(QUOTED_MACHINE_FIELD_LINE_RE.test("**Head:** prior-head"), false);
  assert.equal(QUOTED_MACHINE_FIELD_LINE_RE.test("  **Head count:** 3"), false);
  assert.equal(QUOTED_MACHINE_FIELD_LINE_RE.test("  **Head:** prior-head"), true);
  QUOTED_MACHINE_FIELD_LINE_RE.lastIndex = 0;
});

test("W1-T12041 criterion 2: reconciliation, answers and dedup read the new body order", async (t) => {
  const subject = {
    ...clipped,
    detail: [
      clipped.detail, "", "**Task:** PR-54321", "  **Head:** prior-head", "  **Head count:** 3",
      "**Cause:** review", "**Contract:** prior-revision",
    ].join("\n"),
    options: [{ label: "retry", detail: `Compare ${otherPrUrl} before retrying.` }, escalation.options[1]!],
  };
  const body = renderIssueBody(subject);
  assert.ok(escalationIssueTitle(clipped).endsWith("/123…"));
  await assertReaders(t, body, subject, "OPEN");
  assert.match(body, /\n## Machine fields\n\*\*Class:\*\* BLOCKED/);
  // The escalation conversation reader takes its fields from the trailing block and its detail from
  // under "## Details", so field-shaped lines quoted in the detail never become its identity.
  assertConversation(body, subject, subject.detail);
  assertConversation(renderIssueBody(clipped, ["_Degraded: a notice after the footer._"]), clipped, clipped.detail);
  const crlf = body.replaceAll("\n", "\r\n");
  const issue = { number: 42, url: issueUrl, title: escalationIssueTitle(subject), body: crlf };
  assert.equal(escalationTaskId(crlf), subject.taskId);
  assert.equal(matchDuplicateEscalation(subject, [issue]), issue);
  assert.equal(conversationOf(body.replace("\n## Details\n", "\n## Elsewhere\n"), clipped), undefined);
  assert.equal(conversationOf(body.replace("\n## Machine fields\n", "\n## Elsewhere\n"), clipped), undefined);
});

test("W1-T12041 criterion 3: reconciliation, answers and dedup still read a legacy body", async (t) => {
  const subject = {
    ...clipped,
    options: [{ label: "retry", detail: `Compare ${otherPrUrl} before retrying.` }, escalation.options[1]!],
  };
  const legacyBody = [
    ...fields,
    `**Full summary (JSON):** ${JSON.stringify(clipped.summary)}`,
    "",
    escalation.detail,
    "**Task:** PR-54321",
    "",
    "## Machine fields",
    "**Head:** prior-head",
    "",
    "## Options",
    `- **retry** — ${subject.options[0]!.detail}`,
    "- **pause** — Leave the release on hold",
    "",
    "## Recommendation",
    "retry",
  ].join("\n");
  await assertReaders(t, legacyBody, subject, "MERGED");
  assertConversation(legacyBody, subject, `${escalation.detail}\n**Task:** PR-54321\n\n## Machine fields\n**Head:** prior-head`);
});

test("the console retains decision context and keeps the native reply destination", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rmd-escalation-console-layout-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const threadStorePath = join(directory, "threads.jsonl");
  const decisionSummary = {
    headline: "The release needs a decision",
    what_happened: `The checks failed again. ${otherPrUrl} has related context.`,
    decision: "Choose whether to retry the checks.",
    options: escalation.options.map(({ label, detail }) => ({ label, consequence: detail })),
  };
  let source = sourceOf("");
  escalate({ ...escalation, decisionSummary }, {
    issues: { create: (title, body) => { source = { ...source, title, body }; return issueUrl; } },
    ledgerPath: join(directory, "ledger.ndjson"),
    runId: "run-42",
    threadStorePath,
  });
  const read = createEscalationConversationReader({
    repository: "fixture/repo", threadStorePath, knownIssue: () => true, readIssue: async () => source,
  });
  const result = await read(issueUrl);
  assert.equal(result.state, "served");
  assert.equal(result.conversation.identity.prRef, "12345");
  assert.equal(result.conversation.headline, escalation.summary);
  assert.equal(result.conversation.canReply, true);
  assert.equal(result.conversation.whatHappened, [
    "## Decision Summary", decisionSummary.headline, "", decisionSummary.what_happened, "",
    `**Decision:** ${decisionSummary.decision}`, "", escalation.detail,
  ].join("\n"));

  writeFileSync(threadStorePath, "");
  assert.equal((await read(issueUrl, true)).state, "unavailable");
  source = sourceOf(renderIssueBody(escalation));
  const starter = await read(issueUrl, true);
  assert.equal(starter.state, "served");
  assert.equal(starter.conversation.canStartConversation, true);
  assert.equal(starter.conversation.initialMessage, `${escalation.summary}\n\n${escalation.detail}`);
});

test("W1-T12041 criterion 1: quoted section headings in an option cannot divert deduplication from Details", (t) => {
  const quoted = `Compare the checks.\n\n## Recommendation\nquoted\n\n## Details\nSee ${otherPrUrl}.`;
  const subject = {
    ...escalation,
    options: [{ label: "retry", detail: quoted }, escalation.options[1]!],
    recommendation: `retry\n\n## Details\nSee ${otherPrUrl}.`,
  };
  const body = renderIssueBody(subject);
  const issue = { number: 42, url: issueUrl, title: escalationIssueTitle(subject), body };
  assert.equal(matchDuplicateEscalation(subject, [issue]), issue);
  const directory = mkdtempSync(join(tmpdir(), "rmd-escalation-quoted-headings-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const commented: string[] = [];
  const delivered = escalate(subject, {
    issues: {
      listOpen: () => [issue],
      create: () => assert.fail("a repeat opened a second issue"),
      comment: (url) => { commented.push(url); },
    },
    ledgerPath: join(directory, "ledger.ndjson"),
    runId: "run-42",
  });
  assert.equal(delivered, issueUrl);
  assert.deepEqual(commented, [issueUrl]);
  assert.equal(conversationOf(body, subject)?.identity.prRef, "12345");
  assert.equal(conversationOf(body, subject)?.detail, subject.detail);
});

test("W1-T12041 criterion 2: a PR in the title does not outrank the PR in Details for reconciliation", () => {
  const subject = { ...escalation, summary: `The release checks failed twice; related ${otherPrUrl}` };
  const legacyBody = [...fields, "", subject.detail, "", "## Options", "- **retry** — Run the checks again", "",
    "## Recommendation", "retry"].join("\n");
  for (const body of [legacyBody, renderIssueBody(subject)]) {
    const issue = { number: 42, url: issueUrl, title: escalationIssueTitle(subject), body };
    const candidates = buildEscalationReconcileCandidates("fixture", "repo", { tasks: [], byId: new Map() }, "unused", undefined, {
      issues: { listOpen: () => [issue] },
      evidenceRootFor: () => undefined,
      github: {
        prByRef: (ref) => Number(ref) === 12345
          ? { number: 12345, url: prUrl, state: "OPEN" }
          : { number: 54321, url: otherPrUrl, state: "MERGED" },
        findMergedByTrailer: () => null,
        headRefName: () => undefined,
        prBody: () => undefined,
      },
    });
    assert.deepEqual(candidates.map(({ derived }) => [derived.prNumber, derived.merged]), [[12345, false]]);
  }
});

test("W1-T12041 criterion 2: a Task quoted in Details cannot make the revalidation garden close the issue as another's duplicate", () => {
  const unrelated = { ...escalation, taskId: "W1-T99999", detail: "An unrelated release is blocked." };
  const subject = { ...escalation, detail: `${escalation.detail}\n\n**Task:** W1-T99999\n**Class:** BLOCKED` };
  const issueOf = (number: number, e: Escalation, body: string) => ({
    number, url: `https://github.com/fixture/repo/issues/${number}`, title: escalationIssueTitle(e), body,
    labels: [], createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z",
  });
  const issue = issueOf(42, subject, renderIssueBody(subject));
  assert.equal(issueTaskId(issue), "W1-T12041");
  assert.equal(supersededDuplicates([issue, issueOf(43, unrelated, renderIssueBody(unrelated))], () => 0).size, 0);
  assert.equal(supersededDuplicates([issue, issueOf(43, unrelated, legacyBodyOf(unrelated))], () => 0).size, 0);
  // The detail still reads back as written.
  assert.equal(conversationOf(issue.body, subject)?.detail, subject.detail);
});

test("W1-T12041 criterion 2: a summary ending in a section heading cannot change what a reaction records", () => {
  for (const summary of ["The release checks failed; see ## Recommendation", "The release checks failed; see ## Options"]) {
    const body = renderIssueBody({ ...escalation, summary });
    assert.equal(reactionAnswerText("+1", body), "retry");
    assert.equal(answerTextFor("RETRY, when ready", body), "retry");
    assert.equal(conversationOf(body, { ...escalation, summary })?.recommendation, "retry");
  }
});

test("W1-T12041 criterion 3: an old body led by another field keeps its own fields over a quoted Machine fields heading", async (t) => {
  const subject = {
    ...clipped,
    options: [{ label: "retry", detail: `Compare ${otherPrUrl} before retrying.` }, escalation.options[1]!],
  };
  const legacyBody = [
    "**Status:** waiting on the operator",
    ...fields,
    `**Full summary (JSON):** ${JSON.stringify(clipped.summary)}`,
    "",
    escalation.detail,
    "",
    "## Machine fields",
    "**Head:** prior-head",
    "",
    "## Options",
    `- **retry** — ${subject.options[0]!.detail}`,
    "- **pause** — Leave the release on hold",
    "",
    "## Recommendation",
    "retry",
  ].join("\n");
  assert.equal(escalationTaskId(legacyBody), subject.taskId);
  assert.equal(escalationHeadSha(legacyBody), subject.headSha);
  await assertReaders(t, legacyBody, subject, "MERGED");
  assertConversation(legacyBody, subject, `${escalation.detail}\n\n## Machine fields\n**Head:** prior-head`);
});
