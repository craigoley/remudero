/**
 * W1-T14998 — A FLEET ESCALATION FILES INTO THE PRIVATE OPS REPOSITORY.
 *
 * OBSERVED 2026-11-26: the fleet opened [MANUAL], MAIN-HEALTH and READ-MODEL needs-human issues on public core
 * (#21036, #21001, #21006, ...), carrying task ids, PR links and host detail. Every escalation gateway is now built on
 * the host's private plan destination (the ops repository). With none named, the engine only records a ledger row
 * and managed repositories file in themselves.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ESCALATION_REPOSITORY_ENV, escalate, escalationCodeRepository, escalationDestinationAt, escalationListingIsRouted, escalationIssueRepositories, escalationIssueRepository, ghIssueGateway, ghIssueGatewayAsync, ghIssueGatewayGraphql, issueGatewayRepository, issueGatewayUnfiled,
  issueUrlRepository, NEEDS_HUMAN_LABEL, renderIssueBody, tryEscalate, withCodeRepositoryField, type Escalation, type EscalationDestinationRead,
} from "#src/lib/escalate.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { sreOperatorEscalation } from "#src/lib/sre-runbooks.js";
import { productionIssueRevalidationPorts } from "#src/lib/issue-revalidation-garden.js";
import { attachEscalationConditions, buildEscalationReconcileCandidates } from "#src/lib/tick-read-worker.js";
import { buildMainHealthRung } from "#src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostAlertIssueGateway } from "#src/lib/launcher-host-alerts.js";
import { instanceEscalationIssueRepositories } from "#src/lib/instance-gateway.js";
import { createEscalationConversationReader } from "#src/lib/escalation-conversation.js";
import { buildEscalationIndexSnapshot } from "#src/lib/escalation-conversation-index.js";
import { escalationReplySubmissionKey, recordEscalationIntakeOutcome } from "#src/lib/escalation-correspondence.js";
import { appendThreadMessage, appendThreadReplyOnce, deriveThreadId } from "#src/lib/inbox-thread.js";
import type { FeedbackEntry } from "#src/lib/feedback.js";
import { terminalRulePr } from "#src/lib/issue-revalidation-garden.js";
import { buildBatchedGithub, fetchEscalationIssuesRest, ghGateway } from "#src/lib/status.js";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { ghEscalationAnswerGateway, readEscalationAnswers } from "#src/lib/escalation-answers.js";

const CODE = { owner: "craigoley", repo: "remudero" };
const OPS = "craigoley/remudero-ops";
const PR_URL = "https://github.com/craigoley/remudero/pull/20986";
const toOps: EscalationDestinationRead = () => ({ outcome: "named", repository: OPS });
const nowhere: EscalationDestinationRead = () => ({ outcome: "unfiled", reason: "no-private-escalation-repository", unrouted: true });
const isVisibilityRead = (args: string[]) => args[0] === "api" && /^repos\/[^/]+\/[^/]+$/.test(args[1] ?? "");

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "MANUAL", taskId: "W1-T14945",
    summary: `PR ${PR_URL} proof runner cannot load test files`,
    detail: `Review of ${PR_URL} could not evaluate its proofs.`,
    options: [{ label: "re-review", detail: "re-run the review in a fresh worktree" },
      { label: "hand-review", detail: "review the head by hand" }],
    recommendation: "re-review",
    ...over,
  };
}

/** A `gh` stand-in holding issues per repository: create, the REST open-issue listing, close, comment and labels, and
 *  each repository's own record (`private`) for the repositories `visibility` names. */
function fakeGh(visibility: Record<string, boolean | null> = {}) {
  const issues: Array<{ repo: string; number: number; url: string; title: string; body: string; labels: string[]; state: string }> = [];
  const calls: string[][] = [];
  const repoOf = (args: string[]) => args[args.indexOf("--repo") + 1]!;
  const exec = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") {
      const repo = repoOf(args), number = issues.length + 1;
      const url = `https://github.com/${repo}/issues/${number}`;
      const labels = args.flatMap((arg, i) => (arg === "--label" ? [args[i + 1]!] : []));
      issues.push({ repo, number, url, title: args[args.indexOf("--title") + 1]!, body: args[args.indexOf("--body") + 1]!,
        labels, state: "open" });
      return `${url}\n`;
    }
    if (args[0] === "issue" && args[1] === "close") {
      const issue = issues.find((entry) => entry.url === args[2] && entry.repo === repoOf(args));
      if (!issue) throw new Error(`no issue ${args[2]} on ${repoOf(args)}`);
      issue.state = "closed";
      return "";
    }
    if (args[0] === "issue" && args[1] === "comment") return "";
    if (isVisibilityRead(args)) {
      const repo = args[1]!.slice("repos/".length);
      if (!(repo in visibility)) throw new Error(`HTTP 404: Not Found (${args[1]})`);
      return `${visibility[repo]}\n`;
    }
    if (args[0] === "api") {
      const [, repo, query] = /^repos\/([^/]+\/[^/]+)\/issues\?(.*)$/.exec(args[1]!) ?? [];
      const label = decodeURIComponent(/labels=([^&]*)/.exec(query ?? "")?.[1] ?? "");
      return JSON.stringify(issues.filter((issue) => issue.repo === repo && issue.state === "open" && issue.labels.includes(label))
        .map((issue) => ({ number: issue.number, html_url: issue.url, state: issue.state, title: issue.title, body: issue.body })));
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { issues, calls, exec };
}

function ledger(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.ndjson");
  return { path, rows: () => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** The host's route with {@link ESCALATION_REPOSITORY_ENV} set to `value`, restored after. */
function withEnv<T>(value: string, read: () => T): T {
  const before = process.env[ESCALATION_REPOSITORY_ENV];
  process.env[ESCALATION_REPOSITORY_ENV] = value;
  try {
    return read();
  } finally {
    if (before === undefined) delete process.env[ESCALATION_REPOSITORY_ENV]; else process.env[ESCALATION_REPOSITORY_ENV] = before;
  }
}

/** The host's own route, read from a fixture home's instance config and its plan-destination file. */
function withHostHome<T>(t: TestContext, destination: Record<string, unknown> | undefined, read: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-home-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root }));
  if (destination) writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify(destination));
  const before = process.env.HOME, explicit = process.env[ESCALATION_REPOSITORY_ENV];
  process.env.HOME = home;
  delete process.env[ESCALATION_REPOSITORY_ENV];
  try {
    return read();
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    if (explicit !== undefined) process.env[ESCALATION_REPOSITORY_ENV] = explicit;
  }
}

test("W1-T14998: an unreadable engine origin leaves unrouted gateways ledger-only", (t) => {
  const { path, rows } = ledger(t);
  const gh = fakeGh();
  const previousPath = process.env.PATH;
  const asyncExec = async (args: string[]) => gh.exec(args);
  process.env.PATH = dirname(path);
  try {
    const issues = ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec, destination: nowhere });
    const asyncIssues = ghIssueGatewayAsync(CODE.owner, CODE.repo, { exec: asyncExec, destination: nowhere });
    const graphqlIssues = ghIssueGatewayGraphql(CODE.owner, CODE.repo, { exec: asyncExec, destination: nowhere });
    for (const gateway of [issues, asyncIssues, graphqlIssues]) {
      assert.equal(issueGatewayUnfiled(gateway), "engine-repository-unreadable");
    }
    assert.equal(escalate(escalation(), { issues, ledgerPath: path, runId: "ORIGIN-UNREADABLE" }), "");
    assert.equal(rows().find((row) => row.step === "escalation.not_filed")?.reason, "engine-repository-unreadable");
    assert.deepEqual(gh.calls, []);
    assert.equal(issueGatewayRepository(ghIssueGateway(CODE.owner, CODE.repo, { destination: toOps })), OPS);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("W1-T14998 criterion 1: a fleet escalation opens its issue in the private ops repository", (t) => {
  const gh = fakeGh();
  const { path, rows } = ledger(t);
  const issues = ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec, destination: toOps });
  assert.equal(issueGatewayRepository(issues), OPS);
  const url = withLiveWritesAllowed(() => escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" }));
  assert.match(url, /^https:\/\/github\.com\/craigoley\/remudero-ops\/issues\/1$/);
  assert.deepEqual(gh.issues.map((issue) => issue.repo), [OPS], "the one issue is on the ops repository");
  assert.equal(gh.calls.some((args) => args.includes(`${CODE.owner}/${CODE.repo}`)), false, "no gh call names public core");
  assert.match(gh.issues[0]!.body, /https:\/\/github\.com\/craigoley\/remudero\/pull\/20986/, "the body names the public PR");
  assert.equal(rows().find((row) => row.step === "escalation.issue_opened")?.issue_url, url);
  // Every gateway form takes the same route, the host's real one included.
  assert.equal(issueGatewayRepository(ghIssueGatewayAsync(CODE.owner, CODE.repo, { destination: toOps })), OPS);
  assert.equal(issueGatewayRepository(ghIssueGatewayGraphql(CODE.owner, CODE.repo, { destination: toOps })), OPS);
  const hostRoute = withHostHome(t, { repository: OPS, kinds: ["decision", "feedback", "task"] },
    () => issueGatewayRepository(ghIssueGateway(CODE.owner, CODE.repo)));
  assert.equal(hostRoute, OPS, "the host's plan destination names the escalation repository");
  // An operator's explicit escalation repository is read ahead of the plan destination.
  assert.equal(withEnv(OPS, () => issueGatewayRepository(ghIssueGateway(CODE.owner, CODE.repo))), OPS);
  // An injected transport is never a route: production producers inject one (the SRE lane, liveness, `rmd host-alert`).
  assert.equal(withHostHome(t, { repository: OPS, kinds: ["decision"] },
    () => issueGatewayRepository(ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec }))), OPS);
  assert.equal(withEnv(OPS, () => issueGatewayRepository(ghIssueGatewayAsync(CODE.owner, CODE.repo, { exec: async () => "" }))), OPS);
  // The SRE lane's own producer, over its real exec-injecting gateway, files in ops and assigns there.
  const sre = fakeGh();
  const sreUrl = withEnv(OPS, () => withLiveWritesAllowed(() => sreOperatorEscalation({ ...CODE, ledgerPath: path, log: () => {},
    gh: (args) => (args[0] === "issue" && args[1] === "edit" ? (sre.calls.push(args), "") : sre.exec(args)) })(escalation({ taskId: "W1-T14999" }))));
  assert.match(sreUrl ?? "", /^https:\/\/github\.com\/craigoley\/remudero-ops\/issues\/1$/);
  assert.deepEqual(sre.issues.map((issue) => issue.repo), [OPS]);
  const assign = sre.calls.find((args) => args[0] === "issue" && args[1] === "edit");
  assert.equal(assign?.[assign.indexOf("--repo") + 1], OPS, "the assignee edit names the issue's own repository");
  // Readers of escalation issues (owner replies, relabels) read where they were filed.
  assert.deepEqual(escalationIssueRepository(CODE.owner, CODE.repo, toOps), ["craigoley", "remudero-ops"]);
  assert.deepEqual(escalationIssueRepository(CODE.owner, CODE.repo, nowhere), [CODE.owner, CODE.repo]);
  assert.equal(issueUrlRepository("https://github.com/craigoley/remudero-ops/issues/12"), OPS);
  assert.equal(issueUrlRepository("https://github.com/craigoley/remudero/pull/12"), undefined);
});

test("W1-T14998 criterion 2: the engine repository records an unrouted escalation without opening an issue" +
  " (W1-T14998 criterion 2: with no private repository an escalation opens no public issue for core)", async (t) => {
  // Engine identity comes from this checkout. The issue gateway never asks GitHub for visibility.
  const gh = fakeGh({ [`${CODE.owner}/${CODE.repo}`]: false });
  const { path, rows } = ledger(t);
  const issues = ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec, destination: nowhere });
  assert.equal(issueGatewayRepository(issues), undefined);
  assert.equal(escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" }), "");
  assert.equal(tryEscalate(escalation({ class: "BLOCKED" }), { issues, ledgerPath: path, runId: "RUN-1" }), null);
  assert.deepEqual(gh.calls, [], "the engine-only suppression does not read repository visibility or issue endpoints");
  const unfiled = rows().filter((row) => row.step === "escalation.not_filed");
  assert.deepEqual(unfiled.map((row) => [row.task_id, row.class, row.reason]),
    [["W1-T14945", "MANUAL", "no-private-escalation-repository"], ["W1-T14945", "BLOCKED", "no-private-escalation-repository"]]);
  assert.equal(rows().some((row) => row.step === "escalation.issue_opened" || row.step === "escalation.failed"), false);
  // The async form also stays ledger-only without a GitHub read.
  const quiet = ghIssueGatewayAsync(CODE.owner, CODE.repo, { destination: nowhere });
  assert.deepEqual(await quiet.listOpen?.(NEEDS_HUMAN_LABEL), []);
  await assert.rejects(async () => quiet.create("t", "b", []), /no escalation issue is filed: no-private-escalation-repository/);
  // The host's real route identifies the engine checkout and opens nothing there.
  const hostRoute = withHostHome(t, undefined, () => ghIssueGateway(CODE.owner, CODE.repo));
  assert.deepEqual([hostRoute.listOpen?.(NEEDS_HUMAN_LABEL), hostRoute.ensureLabel?.(NEEDS_HUMAN_LABEL)], [[], false]);
  assert.throws(() => hostRoute.create("t", "b", []), /no escalation issue is filed: no-private-escalation-repository/);
  // An unreadable visibility record is irrelevant: a non-engine managed repo uses the ordinary issue gateway.
  const dark = fakeGh({ "craigoley/unreadable": null });
  const darkIssues = ghIssueGateway("craigoley", "unreadable", { exec: dark.exec, destination: nowhere });
  const darkUrl = withLiveWritesAllowed(() => escalate(escalation({ taskId: "W1-T14997" }),
    { issues: darkIssues, ledgerPath: path, runId: "RUN-1" }));
  assert.match(darkUrl, /^https:\/\/github\.com\/craigoley\/unreadable\/issues\/1$/);
  assert.equal(dark.calls.some(isVisibilityRead), false, "unrouted managed repositories never read visibility");
  assert.match(withHostHome(t, { repository: "not a repository", kinds: [] },
    () => issueGatewayUnfiled(ghIssueGateway(CODE.owner, CODE.repo))) ?? "", /^private-escalation-repository-unreadable: /);
  // An exec-injecting producer with no valid route opens nothing either, and records why.
  const sre = fakeGh();
  assert.equal(withEnv("../remudero", () => sreOperatorEscalation({ ...CODE, ledgerPath: path, log: () => {}, gh: sre.exec })(
    escalation({ taskId: "W1-T14999" }))), null);
  assert.deepEqual(sre.calls, [], "the SRE lane runs no gh call");
  assert.equal(rows().filter((row) => row.step === "escalation.not_filed" && row.task_id === "W1-T14999").length, 1);
  // A set escalation repository that is not <owner>/<name> files nowhere, never on public core.
  assert.equal(withEnv("../remudero", () => issueGatewayUnfiled(ghIssueGateway(CODE.owner, CODE.repo))),
    "RMD_ESCALATION_REPOSITORY is not <owner>/<name>");
});

test("W1-T14998 criterion 3: a re-escalation reuses its issue and recovery closes it", (t) => {
  const gh = fakeGh();
  const { path, rows } = ledger(t);
  const issues = ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec, destination: toOps });
  const first = withLiveWritesAllowed(() => escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" }));
  const again = withLiveWritesAllowed(() => escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-2" }));
  assert.equal(again, first, "the second escalation names the one open issue");
  assert.equal(gh.issues.length, 1);
  assert.equal(rows().filter((row) => row.step === "escalation.deduped").length, 1);
  // Recovery closes through the gateway's own close (run-task's buildEscalationCloser delegates to it), on the ops repository.
  issues.closeWithComment!(first, "recovered: the review ran");
  assert.deepEqual(gh.issues.map((issue) => [issue.repo, issue.state]), [[OPS, "closed"]]);
  const reopened = withLiveWritesAllowed(() => escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-3" }));
  assert.notEqual(reopened, first, "a closed issue does not silence a recurrence");
  assert.deepEqual(gh.issues.map((issue) => issue.repo), [OPS, OPS]);
});

test("W1-T14998 criterion 3: a re-escalation reuses its issue and recovery closes it, reading its thread and listing where filed", async () => {
  // A condition-cleared close first asks whether a person replied: on the issue's own (ops) thread, never core's #7.
  const reads: string[] = [];
  const read = async (args: string[]): Promise<unknown> => { reads.push(args[1]!); return []; };
  const [candidate] = await attachEscalationConditions(CODE.owner, CODE.repo, [{
    issueUrl: `https://github.com/${OPS}/issues/7`, issueNumber: 7, title: "t",
    condition: { prNumber: 20986, escalatedHead: "old", checks: ["ci-gate"] },
  } as unknown as Parameters<typeof attachEscalationConditions>[2][number]], [{
    number: 20986, url: PR_URL, headRefOid: "new",
    statusCheckRollup: [{ name: "ci-gate", conclusion: "SUCCESS", status: "COMPLETED", headSha: "new" }],
  } as unknown as Parameters<typeof attachEscalationConditions>[3] extends readonly (infer R)[] | undefined ? R : never], read);
  assert.deepEqual(reads, [`repos/${OPS}/issues/7/comments?per_page=100`]);
  assert.equal(candidate?.condition?.personReplied, false);
  // The revalidation garden lists and reads escalation issues in ops, and reads pull requests on the code repository.
  const garden: string[] = [];
  const ports = withEnv(OPS, () => productionIssueRevalidationPorts({ ...CODE, stateDir: tmpdir(), repoRoot: tmpdir(), log: () => {},
    referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "",
    readText: async (args: string[]) => { garden.push(args[1]!); return args[1]!.includes("/pulls/") ? "{}" : "[]"; } } as never));
  await ports.listOpenIssues();
  await ports.listComments(7);
  await ports.pullState?.(20986).catch(() => undefined);
  assert.deepEqual(garden.map((path) => path.split("?")[0]),
    [`repos/${OPS}/issues`, `repos/${OPS}/issues/7/comments`, `repos/${CODE.owner}/${CODE.repo}/pulls/20986`]);
});

test("W1-T14998 criterion 1: a fleet escalation opens its issue in the private ops repository, posted by the host alert and answered from the Console there", async (t) => {
  // `rmd host-alert` files where its --state-root routes, even when this machine's HOME config names no destination.
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: ["decision"] }));
  const gh = fakeGh();
  const [alert, homeRoute] = withHostHome(t, undefined, () => [hostAlertIssueGateway(stateDir, CODE.owner, CODE.repo, gh.exec),
    ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec })] as const);
  assert.equal(issueGatewayRepository(homeRoute), undefined, "control: HOME's state names no destination");
  assert.equal(issueGatewayRepository(alert), OPS, "the host alert files where its own state directory routes");
  assert.deepEqual(withHostHome(t, undefined, () => escalationDestinationAt(stateDir)()), { outcome: "named", repository: OPS });
  // Readers take ops-filed issues as this repository's, beside its own legacy ones.
  const code = `${CODE.owner}/${CODE.repo}`, repositories = escalationIssueRepositories(CODE.owner, CODE.repo, toOps);
  assert.deepEqual(repositories, [OPS, code]);
  assert.deepEqual(escalationIssueRepositories(CODE.owner, CODE.repo, nowhere), [code]);
  // A managed instance's Console readers take the route its own state directory (the ledger's) names.
  assert.deepEqual(withHostHome(t, undefined, () => instanceEscalationIssueRepositories(join(stateDir, "ledger.ndjson"), code)), [OPS, code]);
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-bare-`));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.deepEqual(withHostHome(t, undefined, () => instanceEscalationIssueRepositories(join(bare, "ledger.ndjson"), code)), [code],
    "control: an instance whose state names no destination reads only its code repository");
  const opsIssue = `https://github.com/${OPS}/issues/5`;
  const read: string[] = [];
  const readIssue = async (url: string) => { read.push(url); throw new Error("offline"); };
  const reader = createEscalationConversationReader({ repository: code, issueRepositories: repositories, readIssue });
  assert.equal((await reader(opsIssue)).state === "unavailable" && (await reader(opsIssue) as { reason: string }).reason, "source_unavailable");
  assert.deepEqual([...new Set(read)], [opsIssue], "the Console reader reads the ops issue");
  assert.equal((await reader("https://github.com/someone/else/issues/5") as { reason?: string }).reason, "wrong_repository");
  assert.equal((await createEscalationConversationReader({ repository: code, readIssue })(opsIssue) as { reason?: string }).reason,
    "wrong_repository", "control: a reader told only the code repository refuses the ops issue");
  const board = () => ({ state: "ready" as const, flags: [{ taskId: "W1-T14945", issueUrl: opsIssue, title: "[MANUAL] W1-T14945" }] });
  const index = buildEscalationIndexSnapshot({ repository: code, issueRepositories: repositories, threadStorePath: join(stateDir, "threads.jsonl"), readBoard: board });
  assert.deepEqual([index.coverage.conflicts, index.rows.map((row) => row.issueUrl)], [0, [opsIssue]], "the mailbox lists the ops escalation");
  assert.equal(buildEscalationIndexSnapshot({ repository: code, threadStorePath: join(stateDir, "threads.jsonl"), readBoard: board }).coverage.conflicts, 1,
    "control: an index told only the code repository counts it a conflict");
  // The intake receipt answers an ops-filed escalation and its ops-filed follow-up question; the publication stays a code PR.
  const deps = { threadStorePath: join(stateDir, "threads.jsonl"), repository: code, issueRepositories: repositories, now: () => 1793621400000 };
  const identity = { taskId: "W1-T14945", class: "MANUAL", cause: "review", prRef: "20986" };
  const threadId = deriveThreadId(identity);
  appendThreadMessage(identity, "escalation", "PR #20986 needs clarification", deps);
  appendThreadReplyOnce(identity, "Re-review it.", "reply-w1-t14998-1", deps, { escalation: { issueUrl: opsIssue, revision: "a".repeat(64) } });
  const entry: FeedbackEntry = { id: "fb-w1-t14998", ts: "2026-11-27T08:00:00Z", raw: "Re-review it.", attachments: [], origin: "ui", status: "new",
    proposal_pr: null, thread_id: threadId, submission_key: escalationReplySubmissionKey(threadId, "reply-w1-t14998-1", opsIssue) };
  const grill = { action: "grill" as const, publicationPr: `https://github.com/${code}/pull/21100`, detail: "Which head?", questionIssueUrl: `https://github.com/${OPS}/issues/6` };
  assert.equal(recordEscalationIntakeOutcome(entry, grill, { ...deps, issueRepositories: [code] }).state, "unknown", "control: the code repository alone refuses it");
  assert.equal(recordEscalationIntakeOutcome(entry, grill, deps).state, "recorded");
  assert.equal(recordEscalationIntakeOutcome(entry, grill, deps).state, "existing", "a replay keeps the one response");
  assert.equal(recordEscalationIntakeOutcome(entry, { ...grill, publicationPr: `https://github.com/${OPS}/pull/1` }, deps).state, "unknown",
    "the intake publication is still a pull request on the code repository");
});

test("W1-T14998 criterion 3: a re-escalation reuses its issue and recovery closes it, judged and read against its own repository", async (t) => {
  // The garden's terminal-PR close: a clarification escalation filed in ops still names its PR on the code repository.
  const code = `${CODE.owner}/${CODE.repo}`;
  const issue = { url: `https://github.com/${OPS}/issues/9`, title: "[MANUAL] W1-T14945",
    body: `**Task:** W1-T14945\n**Class:** MANUAL\n\nPR ${PR_URL} needs a clarification before it can merge.` };
  assert.equal(terminalRulePr(issue, code), 20986);
  assert.equal(terminalRulePr(issue), undefined, "control: compared against the issue's own repository, no PR is found");
  // The per-command gateway reads an escalation's state on the repository its URL names, not on its own slug.
  const asked: string[] = [];
  const github = ghGateway(CODE.owner, CODE.repo, { cwd: tmpdir(), commitTrailerIndex: () => new Map(),
    exec: (args) => { asked.push(args[1]!); return JSON.stringify({ state: "closed", title: "t" }); } });
  assert.deepEqual(github.issueByUrl?.(`https://github.com/${OPS}/issues/9`), { state: "closed", title: "t" });
  assert.deepEqual(asked, [`repos/${OPS}/issues/9`]);
  // The board lists ops and legacy code-repository issues, each from its own delta: equal numbers never collide.
  const listed: string[] = [];
  // Stamped from the clock: the board's delta is a stop test on these, and a fixed date would age past sweep.staleDays.
  const day = (n: number) => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - n * 86_400_000).toISOString();
  const [opsNew, opsOld, codeOld, codeNew] = [day(1), day(2), day(8), day(7)];
  const row = (repo: string, n: number, updated: string) => ({ number: n, html_url: `https://github.com/${repo}/issues/${n}`, state: "open", title: `${repo}#${n}`, updated_at: updated });
  const fetch = (args: string[]) => {
    listed.push(args[1]!.split("?")[0]!);
    return args[1]!.startsWith(`repos/${OPS}/`) ? [row(OPS, 2, opsNew), row(OPS, 1, opsOld)]
      : [row(code, 3, codeNew)];
  };
  const known = [{ number: 1, url: `https://github.com/${OPS}/issues/1`, state: "open", updatedAt: opsOld },
    { number: 1, url: `https://github.com/${code}/issues/1`, state: "closed", updatedAt: codeOld },
    { number: 3, url: `https://github.com/${code}/issues/3`, state: "open", updatedAt: codeNew }];
  const fetched = withEnv(OPS, () => fetchEscalationIssuesRest(CODE.owner, CODE.repo, fetch as never, known));
  assert.deepEqual(listed, [`repos/${OPS}/issues`, `repos/${code}/issues`]);
  assert.deepEqual(fetched.rows.map((r) => `${r.url} ${r.state}`).sort(), [`https://github.com/${OPS}/issues/1 open`, `https://github.com/${OPS}/issues/2 open`,
    `https://github.com/${code}/issues/1 closed`, `https://github.com/${code}/issues/3 open`], "each issue once, from its own repository");
  assert.deepEqual([fetched.mode, fetched.calls, fetched.truncated], ["delta", 2, false]);
  // The board's persisted snapshot keeps every escalation repository's issues, keyed by URL: ops #1 and code #1 both
  // survive a restart, so a cold board still answers an ops escalation's state.
  const snapshotRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-snapshot-`));
  t.after(() => rmSync(snapshotRoot, { recursive: true, force: true }));
  const persisted = withEnv(OPS, () => {
    const gateway = buildBatchedGithub(CODE.owner, CODE.repo, { commitTrailerIndex: () => new Map(), ttlMs: 60_000, pacer: { wait() {}, recordResult() {} },
      snapshotCache: createBoardSnapshotCache(snapshotRoot, CODE.owner, CODE.repo),
      exec: (args) => JSON.stringify(args[1]!.startsWith(`repos/${OPS}/issues?`) ? [row(OPS, 1, opsOld)]
        : args[1]!.startsWith(`repos/${code}/issues?`) ? [{ ...row(code, 1, codeOld), state: "closed" }] : []) });
    return [gateway.issueByUrl?.(`https://github.com/${OPS}/issues/1`)?.state, gateway.issueByUrl?.(`https://github.com/${code}/issues/1`)?.state];
  });
  assert.deepEqual(persisted, ["open", "closed"], "control: the live board read both repositories' issue #1");
  const seed = createBoardSnapshotCache(snapshotRoot, CODE.owner, CODE.repo).issueSeed();
  assert.deepEqual([...(seed?.values() ?? [])].map((r) => `${r.url} ${r.state}`).sort(),
    [`https://github.com/${OPS}/issues/1 open`, `https://github.com/${code}/issues/1 closed`], "the restarted board's seed holds both");
});

test("W1-T14998 criterion 3: a re-escalation reuses its issue and recovery closes it, each code repository its own in one shared pool", async (t) => {
  // Core and site both file in the one ops pool. Each keeps its own MAIN-HEALTH issue, dedupes onto its own, and a
  // green main closes only its own; core's reconciler never resolves site's PR-<n> as core's PR #<n>.
  const gh = fakeGh();
  const { path } = ledger(t);
  const SITE = { owner: "craigoley", repo: "site" };
  const code = `${CODE.owner}/${CODE.repo}`, site = `${SITE.owner}/${SITE.repo}`;
  const core = ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec, destination: toOps });
  const siteIssues = ghIssueGateway(SITE.owner, SITE.repo, { exec: gh.exec, destination: toOps });
  const red = escalation({ class: "BLOCKED", taskId: "MAIN-HEALTH", summary: "main's own check suite is red", detail: "required check ci failed on main" });
  const coreUrl = withLiveWritesAllowed(() => escalate(red, { issues: core, ledgerPath: path, runId: "CORE-1" }));
  const siteUrl = withLiveWritesAllowed(() => escalate(red, { issues: siteIssues, ledgerPath: path, runId: "SITE-1" }));
  assert.notEqual(siteUrl, coreUrl, "site's red main is its own issue, never folded onto core's");
  assert.deepEqual(gh.issues.map((issue) => [issue.repo, escalationCodeRepository(issue.body)]), [[OPS, code], [OPS, site]]);
  assert.equal(withLiveWritesAllowed(() => escalate(red, { issues: siteIssues, ledgerPath: path, runId: "SITE-2" })), siteUrl,
    "a re-escalation reuses its own repository's issue");
  assert.equal(gh.issues.length, 2);
  // A detail that quotes another repository's field never decides whose issue it is: the machine field does.
  withLiveWritesAllowed(() => escalate(escalation({ taskId: "W1-T15000", detail: `pasted log:\n**Code-Repository:** ${site}` }),
    { issues: core, ledgerPath: path, runId: "CORE-2" }));
  assert.equal(escalationCodeRepository(gh.issues[2]!.body), code);
  gh.issues.pop();
  // The field joins any body: after its Host line (keeping CRLF line ends), or first when it has none.
  assert.equal(withCodeRepositoryField("**Class:** BLOCKED\r\n**Task:** T\r\n**Host:** h\r\n\r\ndetail", code),
    `**Class:** BLOCKED\r\n**Task:** T\r\n**Host:** h\r\n**Code-Repository:** ${code}\r\n\r\ndetail`);
  assert.equal(withCodeRepositoryField("**Cause-Key:** k\n\nentry", code), `**Code-Repository:** ${code}\n**Cause-Key:** k\n\nentry`);
  // Site's main goes green: its rung closes its own MAIN-HEALTH issue and leaves core's open.
  const logged: Array<Record<string, unknown>> = [];
  const green = buildMainHealthRung(SITE.owner, SITE.repo, {
    fetch: async (args: string[]): Promise<unknown> => {
      const at = args[1]!;
      if (at === `repos/${site}`) return { default_branch: "main" };
      if (at === `repos/${site}/commits/main`) return { sha: "b".repeat(40) };
      if (at.includes("/check-runs?")) return { check_runs: [{ id: 9, name: "ci", status: "completed", conclusion: "success" }] };
      if (at.endsWith("/status")) return { statuses: [] };
      if (at.includes("/actions/runs?")) return { workflow_runs: [] };
      throw new Error(`unrouted: ${at}`);
    },
    ledgerPath: path, runId: "SITE-RUNG", log: (step, extra) => void logged.push({ step, ...extra }),
    readRequiredChecks: () => ["ci"], issues: siteIssues,
  });
  await green();
  assert.deepEqual(logged.filter((row) => row.step === "main.health.resolved").map((row) => row.issue_url), [siteUrl]);
  // The ops catalog is itself a managed code repository. Its daemon shares the same repository as the pool, so its
  // explicitly configured gateway still scopes dedup and recovery to ops's recorded field.
  const opsOwner = OPS.split("/")[0]!, opsRepo = OPS.split("/")[1]!;
  const opsIssues = ghIssueGateway(opsOwner, opsRepo, { exec: gh.exec, destination: toOps });
  const opsUrl = withLiveWritesAllowed(() => escalate(red, { issues: opsIssues, ledgerPath: path, runId: "OPS-1" }));
  assert.notEqual(opsUrl, coreUrl, "ops does not reuse core's issue from the shared repository");
  assert.equal(withLiveWritesAllowed(() => escalate(red, { issues: opsIssues, ledgerPath: path, runId: "OPS-2" })), opsUrl,
    "ops re-escalation reuses its own issue");
  assert.equal(escalationCodeRepository(gh.issues.find((issue) => issue.url === opsUrl)?.body), OPS);
  const opsRecovery = buildMainHealthRung(opsOwner, opsRepo, {
    fetch: async (args: string[]): Promise<unknown> => {
      const at = args[1]!;
      if (at === `repos/${OPS}`) return { default_branch: "main" };
      if (at === `repos/${OPS}/commits/main`) return { sha: "d".repeat(40) };
      if (at.includes("/check-runs?")) return { check_runs: [{ id: 10, name: "ci", status: "completed", conclusion: "success" }] };
      if (at.endsWith("/status")) return { statuses: [] };
      if (at.includes("/actions/runs?")) return { workflow_runs: [] };
      throw new Error(`unrouted ops recovery read: ${at}`);
    },
    ledgerPath: path, runId: "OPS-RUNG", log: () => {}, readRequiredChecks: () => ["ci"], issues: opsIssues,
  });
  await opsRecovery();
  assert.deepEqual(gh.issues.map((issue) => [issue.url, issue.state]), [[coreUrl, "open"], [siteUrl, "closed"], [opsUrl, "closed"]]);
  // Core's reconciler, over the routed ops pool, follows an explicit code-repository field even if a grill cites a
  // different PR. For legacy issues without that field, it still judges by the PR repository as the listing does.
  const askedPrs: number[] = [];
  const github = { prByRef: (n: number) => (askedPrs.push(n), { number: n, url: `https://github.com/${code}/pull/${n}`, state: "MERGED" }),
    prByTrailer: () => undefined, mergedNewestFirst: () => [] };
  const pool = [
    { number: 3, url: `https://github.com/${OPS}/issues/3`, title: "[BLOCKED] PR-45: stalled", body: `**Code-Repository:** ${site}\n**Class:** BLOCKED\n**Task:** PR-45\n` },
    { number: 4, url: `https://github.com/${OPS}/issues/4`, title: "[BLOCKED] PR-44: stalled", body: "**Class:** BLOCKED\n**Task:** PR-44\n" },
    { number: 5, url: `https://github.com/${OPS}/issues/5`, title: "[MANUAL] SITE-T9: review", body: `**Code-Repository:** ${code}\n**Task:** SITE-T9\n\nhttps://github.com/${site}/pull/45` },
    { number: 6, url: `https://github.com/${OPS}/issues/6`, title: "[BLOCKED] PR-46: stalled", body: `**Code-Repository:** ${code}\n**Class:** BLOCKED\n**Task:** PR-46\n` },
    { number: 7, url: `https://github.com/${code}/issues/7`, title: "[BLOCKED] PR-47: stalled", body: "**Class:** BLOCKED\n**Task:** PR-47\n" },
    { number: 8, url: `https://github.com/${OPS}/issues/8`, title: "[MANUAL] TRIAGE-1: ask", body: `**Task:** TRIAGE-1\n\nPR https://github.com/${code}/pull/48 needs an answer.` },
    { number: 9, url: `https://github.com/${OPS}/issues/9`, title: "[MANUAL] TRIAGE-2: ask", body: `**Task:** TRIAGE-2\n\nPR https://github.com/${site}/pull/45 needs an answer.` },
  ];
  const reconcile = (routed?: boolean) => {
    askedPrs.length = 0;
    return buildEscalationReconcileCandidates(CODE.owner, CODE.repo, { tasks: [], byId: new Map() }, path, () => {},
      { issues: { listOpen: () => pool }, github: github as never, evidenceRootFor: () => undefined, routed })
      .map((c) => [c.issueNumber, c.derived.merged]);
  };
  assert.deepEqual(reconcile(true), [[4, true], [5, true], [6, true], [7, true], [8, true]],
    "an explicit core ownership field wins; unrecorded legacy issues still follow their PR repository");
  assert.deepEqual(askedPrs, [44, 45, 46, 47, 48]);
  assert.deepEqual(reconcile().map(([n]) => n), [3, 4, 5, 6, 7, 8, 9], "control: a listing that is not routed applies no pool rule");
  // A routed gateway is read as routed; one filing in its own code repository, or a fake, is not.
  assert.equal(escalationListingIsRouted(CODE.owner, CODE.repo, core), true);
  assert.equal(escalationListingIsRouted(OPS.split("/")[0]!, OPS.split("/")[1]!, ghIssueGateway("craigoley", "remudero-ops", { exec: gh.exec, destination: toOps })), false);
  assert.equal(escalationListingIsRouted(CODE.owner, CODE.repo, { listOpen: () => pool }), false);
  // The revalidation garden, which closes what it lists, lists only core's issues out of the ops pool.
  const rest = JSON.stringify(pool.map((issue) => ({ number: issue.number, html_url: issue.url, title: issue.title, body: issue.body })));
  const ports = withEnv(OPS, () => productionIssueRevalidationPorts({ ...CODE, stateDir: tmpdir(), repoRoot: tmpdir(), log: () => {},
    referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "", readText: async () => rest } as never));
  assert.deepEqual((await ports.listOpenIssues()).map((issue) => issue.number), [4, 5, 6, 7, 8]);
});

test("W1-T14998 criterion 4: unrouted public and private managed repositories file in themselves" +
  " (W1-T14998 criterion 4: an unrouted managed repository files its escalation in itself)", async (t) => {
  // Site is public, names no escalation route, and visibility is never consulted: it files where it did before.
  const SITE = "craigoley/site";
  const gh = fakeGh({ [SITE]: false, "craigoley/private-site": true });
  const { path, rows } = ledger(t);
  const issues = ghIssueGateway("craigoley", "site", { exec: gh.exec, destination: nowhere });
  const publicAlarm = escalation({ class: "BLOCKED", taskId: "MAIN-HEALTH",
    summary: "main's own check suite is red", detail: "required check ci failed on main" });
  const url = withLiveWritesAllowed(() => escalate(publicAlarm, { issues, ledgerPath: path, runId: "RUN-1" }));
  assert.match(url, /^https:\/\/github\.com\/craigoley\/site\/issues\/1$/);
  assert.deepEqual(gh.issues.map((issue) => issue.repo), [SITE], "the public issue is on its own code repository");
  assert.equal(escalationCodeRepository(gh.issues[0]!.body), undefined, "filed exactly as before: no pool field");
  assert.equal(rows().find((row) => row.step === "escalation.issue_opened")?.issue_url, url);
  assert.equal(rows().some((row) => row.step === "escalation.not_filed"), false);
  // Dedup, the listing and recovery's close work on it as before, and it is never read as a routed pool.
  assert.equal(withLiveWritesAllowed(() => escalate(publicAlarm, { issues, ledgerPath: path, runId: "RUN-2" })), url);
  assert.equal(gh.issues.length, 1);
  assert.equal(escalationListingIsRouted("craigoley", "site", issues), false);
  const listedAsync = await ghIssueGatewayAsync("craigoley", "site", { exec: async (args) => gh.exec(args), destination: nowhere })
    .listOpen?.(NEEDS_HUMAN_LABEL);
  assert.deepEqual(listedAsync?.map((issue) => issue.url), [url], "the async form lists it on the code repository");
  const hostRoute = withHostHome(t, undefined, () => ghIssueGateway("craigoley", "site", { exec: gh.exec }));
  assert.deepEqual(hostRoute.listOpen?.(NEEDS_HUMAN_LABEL).map((issue) => issue.url), [url], "the host's real unrouted route too");
  const recoveryLog: Array<Record<string, unknown>> = [];
  const recover = buildMainHealthRung("craigoley", "site", {
    fetch: async (args: string[]): Promise<unknown> => {
      const at = args[1]!;
      if (at === `repos/${SITE}`) return { default_branch: "main" };
      if (at === `repos/${SITE}/commits/main`) return { sha: "c".repeat(40) };
      if (at.includes("/check-runs?")) return { check_runs: [{ id: 12, name: "ci", status: "completed", conclusion: "success" }] };
      if (at.endsWith("/status")) return { statuses: [] };
      if (at.includes("/actions/runs?")) return { workflow_runs: [] };
      throw new Error(`unrouted public recovery read: ${at}`);
    },
    ledgerPath: path, runId: "PUBLIC-RECOVERY", log: (step, extra) => void recoveryLog.push({ step, ...extra }),
    readRequiredChecks: () => ["ci"], issues,
  });
  await recover();
  assert.deepEqual(recoveryLog.filter((row) => row.step === "main.health.resolved").map((row) => row.issue_url), [url],
    "an unrouted public repository's green-main recovery resolves its own issue");
  assert.deepEqual(gh.issues.map((issue) => [issue.repo, issue.state]), [[SITE, "closed"]]);
  const privateIssues = ghIssueGateway("craigoley", "private-site", { exec: gh.exec, destination: nowhere });
  const privateUrl = withLiveWritesAllowed(() => escalate(escalation({ taskId: "W1-T15522" }),
    { issues: privateIssues, ledgerPath: path, runId: "PRIVATE-RUN" }));
  assert.match(privateUrl, /^https:\/\/github\.com\/craigoley\/private-site\/issues\/2$/);
  assert.equal(gh.calls.some(isVisibilityRead), false, "public and private managed repositories do not read visibility");
  // The quota notice's GraphQL gateway reads it over GraphQL and lists a private repository's own issues.
  const graphqlCalls: string[] = [];
  const graphql = (isPrivate: boolean) => async (args: string[]) => {
    const query = args.find((arg) => arg.startsWith("query="))!;
    graphqlCalls.push("issues");
    return JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  };
  assert.deepEqual(await ghIssueGatewayGraphql("craigoley", "console", { exec: graphql(true), destination: nowhere }).listOpen?.(NEEDS_HUMAN_LABEL), []);
  assert.deepEqual(graphqlCalls, ["issues"], "a private managed repository is listed directly");
  graphqlCalls.length = 0;
  assert.deepEqual(await ghIssueGatewayGraphql("craigoley", "arcade", { exec: graphql(false), destination: nowhere }).listOpen?.(NEEDS_HUMAN_LABEL), []);
  assert.deepEqual(graphqlCalls, ["issues"], "public managed repositories are listed directly too");
  // An unrouted ops repo keeps its pre-task body shape but ignores a core issue routed into the same repository when
  // searching for duplicates. Its own escalation opens separately and subsequent recovery can see it.
  const shared = fakeGh();
  const coreGateway = ghIssueGateway(CODE.owner, CODE.repo, { exec: shared.exec, destination: toOps });
  const opsGateway = ghIssueGateway("craigoley", "remudero-ops", { exec: shared.exec, destination: nowhere });
  const sameKey = escalation({ class: "BLOCKED", taskId: "MAIN-HEALTH", summary: "main is red", detail: "ci failed" });
  const coreIssue = withLiveWritesAllowed(() => escalate(sameKey, { issues: coreGateway, ledgerPath: path, runId: "CORE-POOL" }));
  const opsIssue = withLiveWritesAllowed(() => escalate(sameKey, { issues: opsGateway, ledgerPath: path, runId: "OPS-LOCAL" }));
  assert.notEqual(opsIssue, coreIssue, "the unrouted ops producer ignores core's pooled issue");
  assert.equal(escalationCodeRepository(shared.issues.find((issue) => issue.url === coreIssue)?.body), CORE_REPO);
  assert.equal(escalationCodeRepository(shared.issues.find((issue) => issue.url === opsIssue)?.body), undefined,
    "unrouted ops filing keeps the legacy body with no ownership field");
  assert.equal(withLiveWritesAllowed(() => escalate(sameKey, { issues: opsGateway, ledgerPath: path, runId: "OPS-LOCAL-2" })), opsIssue);
});

/** An owner-reply reader over `pool`'s open issues: each has one owner comment answering `re-review`. */
function poolReader(t: TestContext, pool: string, codeRepository: string | undefined,
  issues: Array<{ number: number; body: string; reactions?: Array<{ id: number; content: string; login: string }> }>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-answers-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads: string[] = [];
  const reacted: number[] = [];
  const [owner, repo] = pool.split("/") as [string, string];
  const gateway = ghEscalationAnswerGateway(owner, repo, async (args) => {
    const at = args[1]!;
    reads.push(at);
    if (at.startsWith(`repos/${pool}/issues?`)) {
      return JSON.stringify(issues.map((issue) => ({ number: issue.number, html_url: `https://github.com/${pool}/issues/${issue.number}`,
        state: "open", title: `[MANUAL] ${issue.number}`, body: issue.body })));
    }
    const comments = new RegExp(`^repos/${pool}/issues/(\\d+)/comments\\?per_page=100$`).exec(at);
    if (comments) {
      return JSON.stringify([{ id: Number(comments[1]) * 100, body: "re-review", user: { login: owner, type: "User" },
        author_association: "OWNER", updated_at: "2026-11-27T08:00:00Z" }]);
    }
    const reactions = new RegExp(`^repos/${pool}/issues/(\\d+)/reactions\\?per_page=100$`).exec(at);
    if (reactions) {
      const issue = issues.find((entry) => entry.number === Number(reactions[1]));
      return JSON.stringify((issue?.reactions ?? []).map((reaction) => ({ id: reaction.id, content: reaction.content,
        user: { login: reaction.login, type: "User" }, created_at: "2026-11-27T08:00:00Z" })));
    }
    if (at.includes("/issues/comments?")) return "[]";
    throw new Error(`unrouted read ${at}`);
  }, undefined, undefined, ...(codeRepository === undefined ? [] : [codeRepository]));
  gateway.reactPlusOne = (id) => void reacted.push(id);
  gateway.reactPlusOneOnIssue = (n) => void reacted.push(n);
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const read = async () => {
    const result = await readEscalationAnswers(root, "RUN-ANSWERS", gateway, { ledgerPath });
    const questions = join(root, "plan", "questions.ndjson");
    const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
    const stored = lines(questions) as Array<{ task: string; origin: string }>;
    const ledgerRows = lines(ledgerPath) as Array<Record<string, unknown>>;
    return { result, stored: stored.map((row) => [row.task, row.origin]), ignored: ledgerRows.filter((row) => row.step === "escalation_answer.ignored") };
  };
  return { read, reads, reacted };
}

const SITE_PR = "https://github.com/craigoley/site/pull/45";
const answerable = (taskId: string, over: Partial<Escalation> = {}) => renderIssueBody(escalation({ taskId, ...over }));
const CORE_REPO = `${CODE.owner}/${CODE.repo}`;

test("W1-T14998 criterion 5: an owner reply on another repository's pooled issue lands nothing here", async (t) => {
  // Core reads its replies out of the ops pool. Site's issue for the same task id, recorded or named by its PR, is site's.
  const core = poolReader(t, OPS, CORE_REPO, [
    { number: 1, body: withCodeRepositoryField(answerable("W1-T15500"), "craigoley/site") },
    { number: 2, body: answerable("W1-T15500", { summary: `PR ${SITE_PR} needs a review`, detail: `Review of ${SITE_PR} stalled.` }) },
    { number: 3, body: withCodeRepositoryField(answerable("W1-T15500"), CORE_REPO) },
    { number: 4, body: withCodeRepositoryField(answerable("W1-T15501", {
      summary: `PR ${SITE_PR} needs a review`, detail: `Review of ${SITE_PR} stalled.`,
    }), CORE_REPO), reactions: [{ id: 401, content: "+1", login: "craigoley" }] },
  ]);
  const { result, stored, ignored } = await core.read();
  assert.deepEqual(stored, [["W1-T15500", "issue#3:comment:300"], ["W1-T15501", "issue#4:comment:400"],
    ["W1-T15501", "issue#4:reaction:401"]], "the recorded owner field wins over an unrelated PR link");
  assert.deepEqual(core.reacted, [300, 400, 4], "accepted comments and reactions are acknowledged");
  assert.equal(result.accepted, 3);
  assert.deepEqual(ignored, [], "another repository's issue writes no refusal row");
  assert.equal(core.reads.some((at) => /\/issues\/[12]\//.test(at)), false, "another repository's issue is never read");
  // The ops daemon reads its own repository, which is also the pool: an issue recording another code repository is skipped.
  const ops = poolReader(t, OPS, undefined, [
    { number: 1, body: withCodeRepositoryField(answerable("W1-T15500"), CORE_REPO) },
    { number: 4, body: answerable("W1-T15502", { summary: "ops plan lint is red", detail: "no PR" }) },
  ]);
  const opsRead = await ops.read();
  assert.deepEqual(opsRead.stored, [["W1-T15502", "issue#4:comment:400"]]);
  assert.deepEqual([ops.reacted, opsRead.ignored], [[400], []]);
});

test("W1-T14998 criterion 6: an owner reply on this repository's own issue lands as before", async (t) => {
  // A routed reader answers its own recorded issue and a legacy one recording none and naming no other repository's PR.
  const routed = poolReader(t, OPS, CORE_REPO, [
    { number: 3, body: withCodeRepositoryField(answerable("W1-T15500"), CORE_REPO) },
    { number: 5, body: answerable("W1-T15501", { summary: "proof runner cannot load test files", detail: "no PR named" }) },
  ]);
  const routedRead = await routed.read();
  assert.deepEqual(routedRead.stored, [["W1-T15500", "issue#3:comment:300"], ["W1-T15501", "issue#5:comment:500"]]);
  assert.deepEqual([routed.reacted, routedRead.result.accepted], [[300, 500], 2]);
  // An unrouted reader over its own code repository answers every issue there, legacy and recorded, as origin/main did
  // before this pool filter existed. This pre-field issue deliberately quotes site's PR: the owner comment and reaction
  // must still land exactly as they did on main because the issue itself lives in core.
  const legacyBody = [
    "**Class:** MANUAL", "**Task:** W1-T15503", "**Host:** legacy-host", "",
    `Review of ${SITE_PR} stalled.`, "", "## Options", "- **re-review** — re-run the review in a fresh worktree",
    "- **hand-review** — review the head by hand", "", "## Recommendation", "re-review", "",
  ].join("\n");
  const own = poolReader(t, CORE_REPO, undefined, [
    { number: 6, body: legacyBody,
      reactions: [{ id: 601, content: "+1", login: "craigoley" }] },
    { number: 7, body: withCodeRepositoryField(answerable("W1-T15504"), CORE_REPO) },
  ]);
  const ownRead = await own.read();
  assert.deepEqual(ownRead.stored, [["W1-T15503", "issue#6:comment:600"], ["W1-T15503", "issue#6:reaction:601"],
    ["W1-T15504", "issue#7:comment:700"]]);
  assert.deepEqual([own.reacted, ownRead.result.accepted, ownRead.ignored], [[600, 6, 700], 3, []]);
});

test("W1-T14998: routed answers include legacy code-repository issues and scope refusal alarms to their owner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-routed-answer-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads: string[] = [];
  const writes: string[][] = [];
  const legacyUrl = `https://github.com/${CORE_REPO}/issues/41`;
  const gateway = withEnv(OPS, () => ghEscalationAnswerGateway("craigoley", "remudero-ops", async (args) => {
    const path = args[1]!;
    reads.push(path);
    if (path.startsWith(`repos/${OPS}/issues?`)) return "[]";
    if (path.startsWith(`repos/${CORE_REPO}/issues?`)) return JSON.stringify([
      { number: 41, html_url: legacyUrl, state: "open", title: "[MANUAL] W1-T15541", body: answerable("W1-T15541") },
    ]);
    if (path === `repos/${CORE_REPO}/issues/41/comments?per_page=100`) return JSON.stringify([
      { id: 4101, body: "re-review", author_association: "OWNER", user: { login: "craigoley", type: "User" }, updated_at: "2026-11-27T08:00:00Z" },
    ]);
    if (path.endsWith("/reactions?per_page=100") || path.includes("/issues/comments?")) return "[]";
    if (path === `repos/${OPS}/issues/41/comments?per_page=100`) throw new Error("issue number alone chose the wrong repository");
    if (path === `repos/${OPS}/issues`) return "";
    throw new Error(`unexpected routed answer read ${path}`);
  }, undefined, undefined, CORE_REPO, [CORE_REPO]));
  gateway.reactPlusOne = (id) => { writes.push(["comment-reaction", String(id)]); };
  gateway.reactPlusOneOnIssue = (number) => { writes.push(["issue-reaction", String(number)]); };
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const result = await readEscalationAnswers(root, "RUN-ROUTED-ANSWER", gateway, {
    ledgerPath,
  });
  const questions = readFileSync(join(root, "plan", "questions.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(result.accepted, 1, "the code repository's legacy owner reply is still landed");
  assert.deepEqual(questions.map((row: { task: string; origin: string }) => [row.task, row.origin]),
    [["W1-T15541", "issue#41:comment:4101"]]);
  assert.ok(reads.includes(`repos/${CORE_REPO}/issues/41/comments?per_page=100`), "comments are read from the issue URL's repository");
  assert.ok(reads.includes(`repos/${OPS}/issues/comments?sort=updated&direction=desc&per_page=1`), "the routed repository keeps its own comment cursor read");
  assert.ok(reads.includes(`repos/${CORE_REPO}/issues/comments?sort=updated&direction=desc&per_page=1`), "the legacy repository keeps its own comment cursor read");
  assert.ok(reads.includes(`repos/${CORE_REPO}/issues/41/reactions?per_page=100`), "issue reactions are read from the issue URL's repository");
  assert.deepEqual(writes, [["comment-reaction", "4101"]], "the acknowledgement is sent through the same repository-specific reader");

  const poolResponse = JSON.stringify([
    { number: 1, html_url: `https://github.com/${OPS}/issues/1`, state: "open", title: "core alarm", body: `**Code-Repository:** ${CORE_REPO}\n` },
    { number: 2, html_url: `https://github.com/${OPS}/issues/2`, state: "open", title: "site alarm", body: "**Code-Repository:** craigoley/site\n" },
  ]);
  const scoped = withEnv(OPS, () => ghEscalationAnswerGateway("craigoley", "remudero-ops", async (args) => {
    if (args[1]?.startsWith(`repos/${OPS}/issues?`)) return poolResponse;
    if (args[0] === "issue" && args[1] === "create") { writes.push(args); return `https://github.com/${OPS}/issues/3\n`; }
    throw new Error(`unexpected alarm call ${args.join(" ")}`);
  }, undefined, undefined, CORE_REPO));
  assert.deepEqual((await scoped.refusalIssues!.listOpen?.("needs-human"))?.map(issue => issue.number), [1],
    "the refusal alarm dedup listing filters the shared ops pool to this code repository");
  await withLiveWritesAllowed(async () => scoped.refusalIssues!.create("core refusal", "alarm detail", ["needs-human"]));
  const create = writes.find(args => args[0] === "issue" && args[1] === "create")!;
  assert.ok(create.includes(OPS), "refusal alarms remain in the configured escalation repository");
  assert.ok(create.some(value => value.includes(`**Code-Repository:** ${CORE_REPO}`)),
    "the shared-pool issue records its code repository for scoped dedup and recovery");
});
