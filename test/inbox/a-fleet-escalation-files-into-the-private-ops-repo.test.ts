/**
 * W1-T14998 — A FLEET ESCALATION FILES INTO THE PRIVATE OPS REPOSITORY.
 *
 * OBSERVED 2026-11-26: the fleet opened [MANUAL], MAIN-HEALTH and READ-MODEL needs-human issues on public core
 * (#21036, #21001, #21006, ...), carrying task ids, PR links and host detail. Every escalation gateway is now built on
 * the host's private plan destination (the ops repository); with none named, an escalation is a ledger row only.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ESCALATION_REPOSITORY_ENV, escalate, escalationIssueRepository, ghIssueGateway, ghIssueGatewayAsync, ghIssueGatewayGraphql, issueGatewayRepository, issueGatewayUnfiled,
  issueUrlRepository, NEEDS_HUMAN_LABEL, tryEscalate, type Escalation, type EscalationDestinationRead,
} from "#src/lib/escalate.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { sreOperatorEscalation } from "#src/lib/sre-runbooks.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const CODE = { owner: "craigoley", repo: "remudero" };
const OPS = "craigoley/remudero-ops";
const PR_URL = "https://github.com/craigoley/remudero/pull/20986";
const toOps: EscalationDestinationRead = () => ({ outcome: "named", repository: OPS });
const nowhere: EscalationDestinationRead = () => ({ outcome: "unfiled", reason: "no-private-escalation-repository" });

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

/** A `gh` stand-in holding issues per repository: create, the REST open-issue listing, close, comment and labels. */
function fakeGh() {
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

test("W1-T14998 criterion 2: with no private repository an escalation opens no public issue", async (t) => {
  const gh = fakeGh();
  const { path, rows } = ledger(t);
  const issues = ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec, destination: nowhere });
  assert.equal(issueGatewayRepository(issues), undefined);
  assert.equal(issueGatewayUnfiled(issues), "no-private-escalation-repository");
  assert.equal(escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" }), "");
  assert.equal(tryEscalate(escalation({ class: "BLOCKED" }), { issues, ledgerPath: path, runId: "RUN-1" }), null);
  assert.deepEqual(gh.calls, [], "no gh call at all");
  const unfiled = rows().filter((row) => row.step === "escalation.not_filed");
  assert.deepEqual(unfiled.map((row) => [row.task_id, row.class, row.reason]),
    [["W1-T14945", "MANUAL", "no-private-escalation-repository"], ["W1-T14945", "BLOCKED", "no-private-escalation-repository"]]);
  assert.equal(rows().some((row) => row.step === "escalation.issue_opened" || row.step === "escalation.failed"), false);
  // The async form and its reads open nothing either.
  const quiet = ghIssueGatewayAsync(CODE.owner, CODE.repo, { destination: nowhere });
  assert.deepEqual(await quiet.listOpen?.(NEEDS_HUMAN_LABEL), []);
  await assert.rejects(async () => quiet.create("t", "b", []), /no escalation issue is filed: no-private-escalation-repository/);
  // The host's real route: no plan-destination file is unfiled, and so is an unreadable one, never public core.
  assert.equal(withHostHome(t, undefined, () => issueGatewayUnfiled(ghIssueGateway(CODE.owner, CODE.repo))),
    "no-private-escalation-repository");
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
