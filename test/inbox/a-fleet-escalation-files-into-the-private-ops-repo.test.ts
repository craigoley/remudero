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
  escalate, ghIssueGateway, ghIssueGatewayAsync, ghIssueGatewayGraphql, issueGatewayRepository, issueGatewayUnfiled,
  NEEDS_HUMAN_LABEL, tryEscalate, type Escalation, type EscalationDestinationRead,
} from "#src/lib/escalate.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildEscalationCloser } from "#src/run-task.js";

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

/** The host's own route, read from a fixture home's instance config and its plan-destination file. */
function withHostHome<T>(t: TestContext, destination: Record<string, unknown> | undefined, read: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14998-home-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root }));
  if (destination) writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify(destination));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    return read();
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
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
  // A caller's own fake transport, with no route, keeps the repository it names.
  assert.equal(issueGatewayRepository(ghIssueGateway(CODE.owner, CODE.repo, { exec: gh.exec })), `${CODE.owner}/${CODE.repo}`);
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
  // Recovery's closer, over the same route, closes that issue on the ops repository.
  buildEscalationCloser(CODE.owner, CODE.repo, issues)(first, "recovered: the review ran");
  assert.deepEqual(gh.issues.map((issue) => [issue.repo, issue.state]), [[OPS, "closed"]]);
  const reopened = withLiveWritesAllowed(() => escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-3" }));
  assert.notEqual(reopened, first, "a closed issue does not silence a recurrence");
  assert.deepEqual(gh.issues.map((issue) => issue.repo), [OPS, OPS]);
});
