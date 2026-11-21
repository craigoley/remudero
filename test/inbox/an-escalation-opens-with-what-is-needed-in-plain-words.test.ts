import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  classifyAsk,
  editEscalationMachineFields,
  escalate,
  escalationBodyInLegacyOrder,
  escalationContractRevision,
  escalationHeadSha,
  escalationIssueCause,
  escalationIssueTitle,
  escalationTaskId,
  LAYOUT_MARKER_RE,
  matchDuplicateEscalation,
  prReferentFromIssueText,
  renderIssueBody,
  taskContractRevision,
  type Escalation,
  type IssueGateway,
  type OpenIssue,
} from "#src/lib/escalate.js";
import { answerTextFor, reactionAnswerText, readEscalationAnswers } from "#src/lib/escalation-answers.js";
import { createEscalationConversationReader, parseEscalationConversationSource } from "#src/lib/escalation-conversation.js";
import {
  duplicateEscalationKey,
  evidenceNames,
  issueEscalationCause,
  issueEscalationClass,
  issueTaskId,
  supersededDuplicates,
  terminalRulePr,
} from "#src/lib/issue-revalidation-garden.js";
import { buildEscalationReconcileCandidates } from "#src/lib/tick-read-worker.js";
import { validateDecisionSummary } from "#src/lib/feedback.js";
import { taskInputAnswer } from "#src/lib/worker.js";
import {
  buildSweepEffects, renderClarificationQuestion, stalledStageEscalationSummary, stallIssueBodyAtHead, type OpenPrView,
} from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import type { Plan, Task } from "#src/lib/plan.js";

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

/** The body as GitHub shows it: the hidden layout markers (HTML comments) removed. */
function visible(body: string): string {
  return body.replace(/\n<!-- rmd-escalation-layout:v1:[0-9a-f]{16}:[a-z]+ -->/g, "");
}

test("W1-T12041 criterion 1: the body opens with the summary and choices and ends with machine fields", (t) => {
  const body = visible(renderIssueBody(escalation));
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
  assert.ok(summarized.indexOf("## Recommendation") < summarized.indexOf("## Details"));
  assert.ok(summarized.indexOf(escalation.detail) < summarized.indexOf("## Machine fields"));
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
  assert.ok(visible(delivered).endsWith(["## Machine fields", ...fields].join("\n")));
  assert.ok(visible(delivered).indexOf("Non-conforming operator message") < visible(delivered).indexOf("## Machine fields"));
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
    assert.equal(repeatOutcome(t, request, legacyRender(request)), "opened");
    assert.equal(repeatOutcome(t, request, renderIssueBody(request)), "opened");
    // Two full links: the fields-first order read Details first, and so does the new order.
    const linked = { ...request, detail: `The release is blocked on ${prUrl}.` };
    assert.equal(repeatOutcome(t, linked, legacyRender(linked)), "reused");
    assert.equal(repeatOutcome(t, linked, renderIssueBody(linked)), "reused");
    const other = { ...request, detail: `The release is blocked on ${otherPrUrl}.` };
    assert.equal(matchDuplicateEscalation(other, [{ number: 42, url: issueUrl, title: escalationIssueTitle(request), body: renderIssueBody(linked) }]), undefined);
  }
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
  assert.equal(escalationBodyInLegacyOrder(body), legacyRender(subject));
  // The escalation conversation reader takes its fields from the trailing block and its detail from
  // under "## Details", so field-shaped lines quoted in the detail never become its identity.
  assertConversation(body, subject, subject.detail);
  assertConversation(renderIssueBody(clipped, ["_Degraded: a notice after the footer._"]), clipped, clipped.detail);
  const crlf = body.replaceAll("\n", "\r\n");
  const issue = { number: 42, url: issueUrl, title: escalationIssueTitle(subject), body: crlf };
  assert.equal(escalationTaskId(crlf), subject.taskId);
  // A CRLF body (edited on GitHub) deduplicates exactly as the same edit of the fields-first body did.
  const legacyCrlf = { ...issue, body: legacyRender(subject).replaceAll("\n", "\r\n") };
  assert.equal(matchDuplicateEscalation(subject, [issue])?.number, matchDuplicateEscalation(subject, [legacyCrlf])?.number);
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
  // The conversation reader refuses this body exactly as it refused the fields-first one: two
  // `## Recommendation` lines make it no supported native source in either order.
  assert.deepEqual(conversationOf(body, subject), conversationOf(legacyRender(subject), subject));
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
  assert.equal(supersededDuplicates([issue, issueOf(43, unrelated, legacyRender(unrelated))], () => 0).size, 0);
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

const FOOTER = [
  "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy). Closing this issue does_",
  "_not resolve the underlying block by itself — act on it, then resume via `rmd drain`._",
].join("\n");

/** origin/main's renderIssueBody plus createEscalationIssue's appended notices, verbatim: the
 *  fields-first body the same escalation produced before W1-T12041. */
function legacyRender(e: Escalation, notices: readonly string[] = [], footer = FOOTER): string {
  const card = validateDecisionSummary(e.decisionSummary ?? null);
  const clippedTitle = escalationIssueTitle(e) !== `[${e.class}] ${e.taskId}: ${e.summary}`;
  const summaryJson = JSON.stringify(e.summary).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return [
    `**Class:** ${e.class}`, `**Task:** ${e.taskId}`, `**Host:** ${hostname()}`,
    e.runId ? `**Run:** ${e.runId}` : undefined,
    e.headSha ? `**Head:** ${e.headSha}` : undefined,
    e.cause ? `**Cause:** ${e.cause}` : undefined,
    e.contractRevision ? `**Contract:** ${e.contractRevision}` : undefined,
    ...(clippedTitle ? [`**Full summary (JSON):** ${summaryJson}`] : []),
    "",
    ...(card ? ["## Decision Summary", card.headline, "", card.what_happened, "", `**Decision:** ${card.decision}`, ""] : []),
    e.detail, "", "## Options", ...e.options.map((o) => `- **${o.label}** — ${o.detail}`), "",
    "## Recommendation", e.recommendation, "",
    footer,
    ...(classifyAsk(e) === "question"
      ? ["", "**To answer:** reply on this issue (repository owner only — every other reply is",
        "counted and ignored) or reply in the console's escalation panel. Either lands in the",
        "same place the next fix round reads."]
      : []),
  ].filter((l): l is string => l !== undefined).join("\n") + notices.map((n) => `\n\n${n}`).join("");
}

function reconciled(body: string, title: string): Array<[number | undefined, boolean | undefined]> {
  const issue = { number: 42, url: issueUrl, title, body };
  return buildEscalationReconcileCandidates("fixture", "repo", { tasks: [], byId: new Map() }, "unused", undefined, {
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
  }).map(({ derived }) => [derived.prNumber, derived.merged]);
}

test("W1-T12041 criterion 1: the detail is written byte for byte and a no-PR repeat opens issues as before", () => {
  // Review of 627460ded3: a fenced `**Head:**` diagnostic was indented, and a `**Cause:** ci` line in a
  // no-PR, no-cause detail let the legacy body absorb a repeat that the new body turned into a second issue.
  const first = {
    ...escalation, summary: "Release checks failed", headSha: undefined, cause: undefined, contractRevision: undefined,
    detail: "The release is blocked.\n\n```\n**Head:** old-head\n**Cause:** ci\n```",
  };
  assert.ok(renderIssueBody(first).includes(first.detail), "the detail renders exactly as written");
  const repeat = { ...first, summary: "Release checks failed again", detail: "Still blocked." };
  const issueOf = (body: string) => ({ number: 42, url: issueUrl, title: escalationIssueTitle(first), body });
  assert.equal(matchDuplicateEscalation(repeat, [issueOf(legacyRender(first))])?.number, 42);
  assert.equal(matchDuplicateEscalation(repeat, [issueOf(renderIssueBody(first))])?.number, 42);
});

test("W1-T12041 criterion 2: a body with its footer removed reconciles against the PR in Details on both orders", () => {
  // Review of 627460ded3: open PR #12345 in Details, merged PR #54321 in Options, footer deleted.
  const subject = {
    ...escalation,
    options: [{ label: "retry", detail: `Compare the checks with ${otherPrUrl}.` }, escalation.options[1]!],
  };
  const title = escalationIssueTitle(subject);
  for (const body of [legacyRender(subject), renderIssueBody(subject)]) {
    assert.ok(body.includes(FOOTER));
    assert.deepEqual(reconciled(body, title), [[12345, false]]);
    assert.deepEqual(reconciled(body.replace(FOOTER, ""), title), [[12345, false]]);
  }
});

test("W1-T12041 criterion 3: an edited fields-first body keeps its Task and Head over a quoted Machine fields block", async (t) => {
  // Review of 627460ded3: a blank line between Class and Task, and a quoted `## Machine fields` in the detail.
  const subject = {
    ...escalation,
    options: [{ label: "retry", detail: `Compare ${otherPrUrl} before retrying.` }, escalation.options[1]!],
    detail: `${escalation.detail}\n\n## Machine fields\n**Head:** prior-head`,
  };
  const edited = legacyRender(subject).replace("**Class:** BLOCKED\n", "**Class:** BLOCKED\n\n");
  assert.ok(edited.startsWith("**Class:** BLOCKED\n\n**Task:** W1-T12041\n"));
  assert.equal(escalationTaskId(edited), subject.taskId);
  assert.equal(escalationHeadSha(edited), subject.headSha);
  assert.equal(escalationIssueCause(edited), subject.cause);
  await assertReaders(t, edited, subject, "MERGED");
});

/** Text that imitates every structure a reader of the body keys on. */
const FRAGMENTS = [
  "plain words", "**Task:** PR-54321", "**Class:** MANUAL", "**Head:** prior-head", "  **Head:** indented-head",
  "**Cause:** review", "**Contract:** prior-revision", '**Full summary (JSON):** "PR #54321 needs a decision"',
  "## Options", "## Recommendation", "## Details", "## Machine fields", "## Decision Summary", "- **pause** — quoted option",
  FOOTER, "_Opened automatically by Remudero (MASTER-PLAN §4 escalation taxonomy)", prUrl, otherPrUrl, "PR #777",
  "<!-- Strike-Ladder-PR: 888 -->", "The CLARIFICATION-QUESTION rung asked", "**Raised-by:** conflict-evidence-missing",
  "<!-- rmd-escalation-layout:v1:0123456789abcdef:fields -->", "<!-- rmd-escalation-layout:v1:0123456789abcdef:summary -->",
  "```", "`src/lib/escalate.ts`", "", "trailing\r", "line\u2028separated", "crlf\r\nline",
];

/** A deterministic generator, so a red names a reproducible case. */
function generator(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedEscalations(count: number): Array<{ e: Escalation; notices: string[] }> {
  const random = generator(12041);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const text = (): string => Array.from({ length: Math.floor(random() * 6) }, () => pick(FRAGMENTS)).join(pick(["\n", "\n\n", " "]));
  return Array.from({ length: count }, (_, i) => {
    const options = Array.from({ length: Math.floor(random() * 4) }, (_, n) => ({ label: n === 0 ? "retry" : pick(["pause", "edit-it", "Ship"]), detail: text() }));
    const e: Escalation = {
      class: pick(["BLOCKED", "MANUAL", "GRILL"] as const),
      taskId: pick(["W1-T12041", "PR-12345", "TRIAGE-abc"]),
      summary: random() < 0.2 ? "x".repeat(260) + text() : `Release checks failed ${i} ${text()}`,
      detail: text(),
      options,
      recommendation: random() < 0.5 ? "retry" : text(),
      ...(random() < 0.6 ? { runId: "run-42" } : {}),
      ...(random() < 0.6 ? { headSha: "abc123" } : {}),
      ...(random() < 0.6 ? { cause: pick(["ci", "review", "stage-stall"] as const) } : {}),
      ...(random() < 0.4 ? { contractRevision: "rev-42" } : {}),
      ...(random() < 0.3 ? { decisionSummary: {
        headline: `Decide on release ${i}`, what_happened: `It happened. ${text()}`.slice(0, 600), decision: `Choose ${text()}`.slice(0, 280),
        options: [{ label: "retry", consequence: "The checks run again." }, { label: "pause", consequence: "The release waits." }],
      } } : {}),
    };
    const notices = random() < 0.3 ? ["_Degraded: label(s) x could not be provisioned._", text() || "note"].slice(0, 1 + Math.floor(random() * 2)) : [];
    return { e, notices };
  });
}

const CASES = generatedEscalations(400);

test("W1-T12041 criterion 2: every generated body reads back as the exact fields-first text of the same escalation", () => {
  let cards = 0;
  for (const { e, notices } of CASES) {
    const body = renderIssueBody(e, notices);
    const legacy = legacyRender(e, notices);
    if (/^## Decision Summary\n/.test(body)) cards++;
    assert.equal(escalationBodyInLegacyOrder(body), legacy);
    // Editing on GitHub turns every newline into CRLF; an edit that drops the footer or adds to the
    // detail moves with its section.
    assert.equal(escalationBodyInLegacyOrder(body.replaceAll("\n", "\r\n")), legacy.replaceAll("\n", "\r\n"));
    const nonce = /:([0-9a-f]{16}):fields -->$/.exec(body)![1];
    const detailsEnd = `\n<!-- rmd-escalation-layout:v1:${nonce}:details -->`;
    assert.equal(body.split(detailsEnd).length, 2);
    assert.equal(escalationBodyInLegacyOrder(body.replace(`${detailsEnd}\n\n${FOOTER}`, `${detailsEnd}\n\n`)), legacyRender(e, notices, ""));
    const appended = `${e.detail}\n\nAn operator note with ${otherPrUrl}.`;
    assert.equal(escalationBodyInLegacyOrder(body.replace(`\n## Details\n${e.detail}${detailsEnd}`, `\n## Details\n${appended}${detailsEnd}`)),
      legacyRender({ ...e, detail: appended }, notices));
  }
  assert.ok(cards > 20, `only ${cards} generated bodies carried a decision card`);
});

test("W1-T12041 criterion 3: every fields-first body, edited or not, reads exactly as it did before", () => {
  for (const { e, notices } of CASES) {
    const legacy = legacyRender(e, notices);
    for (const body of [legacy, legacy.replace("**Class:** ", "**Status:** waiting\n**Class:** "), legacy.replace("\n**Task:**", "\n\n**Task:**"),
      legacy.replaceAll("\n", "\r\n"), `${legacy}\n\n${renderIssueBody(escalation)}`.slice(0, legacy.length + 40)]) {
      assert.equal(escalationBodyInLegacyOrder(body), body);
      assert.equal(editEscalationMachineFields(body, (text) => text.replace(/^\*\*Head:\*\*.*$/m, "**Head:** moved")),
        body.replace(/^\*\*Head:\*\*.*$/m, "**Head:** moved"));
    }
  }
});

/** What every body reader in the fleet reads off one issue. */
function readings(body: string, e: Escalation): unknown {
  const title = escalationIssueTitle(e);
  const issue = { number: 42, url: issueUrl, title, body };
  const garden = { ...issue, labels: [], createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z" };
  const probes = [e, { ...e, cause: "review" as const }, { ...e, headSha: "other" }, { ...e, contractRevision: "other" },
    { ...e, summary: "Release checks failed", detail: "No pull request named." }, { ...e, detail: `See ${otherPrUrl}.` },
    { ...e, detail: "See PR #777." }, { ...e, headDedup: "independent" as const }];
  return {
    task: escalationTaskId(body), head: escalationHeadSha(body), cause: escalationIssueCause(body),
    contract: escalationContractRevision(body), pr: prReferentFromIssueText(body),
    dedup: probes.map((probe) => matchDuplicateEscalation(probe, [issue])?.number),
    answers: [...e.options.map((o) => answerTextFor(`${o.label} please`, body)), reactionAnswerText("+1", body), reactionAnswerText("-1", body)],
    conversation: conversationOf(body, e),
    garden: [issueTaskId(garden), issueEscalationClass(garden), issueEscalationCause(garden), duplicateEscalationKey(garden),
      terminalRulePr(garden), evidenceNames(garden)],
    reconciled: reconciled(body, title),
  };
}

test("W1-T12041 criterion 2: every reader finds the same fields, PR, answers and duplicates in either order", () => {
  let tasks = 0;
  for (const { e, notices } of CASES.slice(0, 150)) {
    const legacy = readings(legacyRender(e, notices), e);
    assert.deepEqual(readings(renderIssueBody(e, notices), e), legacy);
    if ((legacy as { task?: string }).task !== undefined) tasks++;
  }
  assert.equal(tasks, 150);
});

test("W1-T12041 criterion 2: a field rewrite reaches the machine fields, never a line quoted in the detail", () => {
  const subject = { ...escalation, detail: "```\n**Head:** old-head\n**Contract:** prior-revision\n```", cause: undefined };
  const body = renderIssueBody(subject);
  const moved = editEscalationMachineFields(body, (text) => text.replace(/^\*\*Head:\*\*.*$/m, "**Head:** new-head")
    .replace(/^\*\*Contract:\*\*.*\n/m, ""));
  assert.ok(moved.includes(subject.detail));
  assert.equal(escalationHeadSha(moved), "new-head");
  assert.equal(escalationContractRevision(moved), "prior-revision");
  assert.equal(escalationBodyInLegacyOrder(moved),
    legacyRender(subject).replace("**Head:** abc123", "**Head:** new-head").replace("**Contract:** rev-42\n", ""));
  // A CRLF body and one whose heading an edit removed keep the rewrite inside the fields.
  const crlf = editEscalationMachineFields(body.replaceAll("\n", "\r\n"), (text) => text.replace(/^\*\*Head:\*\*.*$/m, "**Head:** new-head"));
  assert.equal(escalationHeadSha(crlf), "new-head");
  assert.ok(crlf.includes(subject.detail.replaceAll("\n", "\r\n")));
  const headless = editEscalationMachineFields(body.replace("\n## Machine fields\n", "\n"), (text) => text.replace(/^\*\*Head:\*\*.*$/m, "**Head:** new-head"));
  assert.equal(escalationHeadSha(headless), "new-head");
});

test("W1-T12041 criterion 2: a body quoting a whole other escalation still reads its own sections", () => {
  const quoted = renderIssueBody({ ...escalation, taskId: "W1-T99999", detail: `Quoted ${otherPrUrl}` });
  const subject = { ...escalation, detail: `The earlier issue said:\n\n${quoted}` };
  const body = renderIssueBody(subject);
  assert.equal(escalationBodyInLegacyOrder(body), legacyRender(subject));
  assert.equal(escalationTaskId(body), "W1-T12041");
  // A body whose own markers an edit removed is read exactly as any other body is.
  const stripped = body.replace(/\n<!-- rmd-escalation-layout:v1:[0-9a-f]{16}:fields -->$/, "");
  assert.notEqual(stripped, body);
  assert.equal(escalationBodyInLegacyOrder(stripped), stripped);
});

test("the layout marker grammar accepts only a writer marker: v1, a 16-hex nonce and a section name", () => {
  const marker = "<!-- rmd-escalation-layout:v1:0123456789abcdef:fields -->";
  LAYOUT_MARKER_RE.lastIndex = 0;
  assert.equal(LAYOUT_MARKER_RE.exec(marker)?.[2], "fields");
  for (const lookalike of [marker.replace(":v1:", ":v2:"), marker.replace("0123456789abcdef", "0123"), marker.replace(":fields", ":Fields")]) {
    LAYOUT_MARKER_RE.lastIndex = 0;
    assert.equal(LAYOUT_MARKER_RE.test(lookalike), false);
  }
  LAYOUT_MARKER_RE.lastIndex = 0;
  assert.equal(LAYOUT_MARKER_RE.test(renderIssueBody(escalation)), true);
  LAYOUT_MARKER_RE.lastIndex = 0;
});

// ── The sweep's one stall question per PR (src/lib/sweep.ts, scope amendment #20023) ──────────────

const STALL_HEAD_A = "9dca5f8c614f2ec64134bdebbbc32c0204201234";
const STALL_HEAD_B = "1b2c3d4e5f60718293a4b5c6d7e8f90112233445";
const stallPr: OpenPrView = {
  prNumber: 15520, prUrl: "https://github.com/craigoley/remudero/pull/15520", taskId: "W1-T10842", headSha: STALL_HEAD_A,
  headRefName: "run-W1-T10842-1793300000000", reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: "2026-10-29T20:20:00.000Z", autoMergeArmed: false,
};
const stallTask = { id: stallPr.taskId, files: ["src/lib/sweep.ts"], acceptance: [] } as unknown as Task;
const stallReason = (blocker: string) => `PR stage stalled: #${stallPr.prNumber} ${stallPr.prUrl} — ${blocker} for 45 minutes ` +
  "(BACKSTOP 30); since 2026-10-29T20:20:00.000Z; DIAGNOSIS: unknown signature";

/** One stored stall issue, then a stall episode at `STALL_HEAD_B` offered to it through the sweep. */
async function stallEpisode(t: TestContext, stored: Escalation, storedBody = renderIssueBody(stored)): Promise<{ issues: Array<OpenIssue & { labels: string[] }>; comments: string[]; edits: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-escalation-stall-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const issues: Array<OpenIssue & { labels: string[] }> = [];
  const comments: string[] = [];
  const edits: string[] = [];
  const gateway: IssueGateway = {
    create(title, body, labels) {
      const number = 17000 + issues.length;
      issues.push({ number, url: `https://github.com/craigoley/remudero/issues/${number}`, title, body, labels });
      return issues.at(-1)!.url;
    },
    listOpen: (label) => issues.filter((issue) => issue.labels.includes(label)),
    comment: (url) => { comments.push(url); },
    editBody(url, body) {
      issues.find((issue) => issue.url === url)!.body = body;
      edits.push(body);
    },
    closeWithComment() {},
  };
  gateway.create(escalationIssueTitle(stored), storedBody, ["needs-human"]);
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: root, config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-W1-T12041", log: () => {},
    plan: { tasks: [stallTask], byId: new Map([[stallTask.id, stallTask]]) } as Plan,
    issuesImpl: gateway, reloadPlanForFixImpl: () => undefined,
    readJsonImpl: async () => { throw new Error("unexpected remote read"); },
  });
  const view = { ...stallPr, headSha: STALL_HEAD_B };
  const reason = stallReason("escalated");
  await effects.escalate(view, reason, { ...renderClarificationQuestion(view, reason), cause: "stage-stall" });
  return { issues, comments, edits };
}

const storedStall: Escalation = {
  class: "MANUAL", taskId: stallTask.id, headSha: STALL_HEAD_A, cause: "stage-stall",
  summary: `PR ${stallPr.prUrl} needs a clarification — ${stalledStageEscalationSummary(stallReason("own-red"))}`, detail: stallReason("own-red"),
  options: [{ label: "inspect", detail: "inspect the stalled stage" }], recommendation: "inspect",
};

test("W1-T12041 criterion 2: the stall rewrite moves the producer's Head, never a Head quoted in the detail", () => {
  const subject = { ...escalation, detail: "```\n**Head:** old-head\n```" };
  const moved = stallIssueBodyAtHead(renderIssueBody(subject), "new-head")!;
  assert.ok(moved.includes(subject.detail));
  assert.equal(escalationHeadSha(moved), "new-head");
  assert.equal(escalationBodyInLegacyOrder(moved), legacyRender(subject).replace("**Head:** abc123", "**Head:** new-head"));
  assert.equal(stallIssueBodyAtHead(legacyRender(subject), "new-head"), legacyRender(subject).replace("**Head:** abc123", "**Head:** new-head"));
});

test("W1-T12041 criterion 2: a clipped stall issue is found by the identity in its Details, not one quoted in Options", async (t) => {
  // The title is clipped, so the sweep reads the stall identity off the body. An option quotes another PR's stall.
  const stored = {
    ...storedStall,
    summary: `PR ${stallPr.prUrl} needs a clarification — ${"context ".repeat(40)}`,
    options: [{ label: "inspect", detail: `Compare PR stage stalled: #99999 https://github.com/craigoley/remudero/pull/99999 — own-red; elsewhere` }],
  };
  assert.ok(escalationIssueTitle(stored).endsWith("…"));
  assert.equal((await stallEpisode(t, stored, legacyRender(stored))).issues.length, 1, "the fields-first issue takes the episode");
  const episode = await stallEpisode(t, stored);
  assert.equal(episode.issues.length, 1, "the episode appends to the PR's one stall issue");
  assert.deepEqual(episode.comments, [episode.issues[0]!.url]);
});

test("W1-T12041 criterion 2: the stall view drops the producer's Contract and the stored Head moves, never a quoted line", async (t) => {
  // The detail quotes the CURRENT contract and an old head; the producer's own Contract field is older.
  const current = taskContractRevision(stallTask);
  const stored = {
    ...storedStall, contractRevision: "rev-old",
    detail: `${stallReason("own-red")}\n\n\`\`\`\n**Contract:** ${current}\n**Head:** old-diagnostic-head\n\`\`\``,
  };
  const legacyEpisode = await stallEpisode(t, stored, legacyRender(stored));
  const episode = await stallEpisode(t, stored);
  assert.equal(legacyEpisode.issues.length, 1, "the fields-first issue takes the episode");
  assert.equal(episode.issues.length, 1, "the episode appends to the PR's one stall issue");
  assert.deepEqual(episode.comments, [episode.issues[0]!.url]);
  assert.equal(episode.edits.length, 1);
  assert.equal(episode.edits[0], renderIssueBody(stored).replace(`**Head:** ${STALL_HEAD_A}`, `**Head:** ${STALL_HEAD_B}`));
  assert.ok(episode.edits[0]!.includes(stored.detail));
});
