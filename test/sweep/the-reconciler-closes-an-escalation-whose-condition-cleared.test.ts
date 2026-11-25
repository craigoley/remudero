import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderIssueBody } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import {
  escalationConditionCleared,
  escalationNamedChecks,
  runEscalationReconcile,
  MAX_ESCALATION_CLOSES_PER_CYCLE,
  type EscalationReconcileCandidate,
} from "#src/lib/sweep.js";
import { attachEscalationConditions, buildEscalationReconcileCandidates, createTickReadProducer } from "#src/lib/tick-read-worker.js";

const OWNER = "craigoley";
const REPO = "remudero";
const OLD_HEAD = "1d6804a1f7".padEnd(40, "0");
const NEW_HEAD = "a9b1077e90".padEnd(40, "0");
const CHECK = "acceptance-author-gate";
const NOTHING: Plan = { tasks: [], byId: new Map() };

/** A clarification escalation in the shape the sweep's metadata-only rung writes, rendered by the real renderer. */
function clarificationBody(pr: number, opts: { head?: string; checks?: string } = {}): string {
  const url = `https://github.com/${OWNER}/${REPO}/pull/${pr}`;
  const reason = "the body red has no deterministic acceptance repair; scope or proof amendment is required";
  return renderIssueBody({
    class: "BLOCKED",
    taskId: `W1-T${pr}`,
    summary: `PR ${url} needs a clarification — metadata-only required checks ${opts.checks ?? CHECK} need title/body repair: ${reason}`,
    detail: `The CLARIFICATION-QUESTION rung reconciled open PR #${pr} to BLOCKED-AMBIGUOUS. Task W1-T${pr}, PR #${pr} (${url}).`,
    options: [
      { label: "re-dispatch-with-constraint", detail: "re-arm the fix rung with the operator's answer" },
      { label: "revise-spec", detail: "file a task-edit proposal" },
    ],
    recommendation: "re-dispatch-with-constraint",
    ...(opts.head === "" ? {} : { headSha: opts.head ?? OLD_HEAD }),
    cause: "ci",
  });
}

/** The stale-proof shape: a Head line and no pull request. */
function staleProofBody(): string {
  return renderIssueBody({
    class: "BLOCKED",
    taskId: "W1-T11114",
    summary: "W1-T11114: a filed proof already passes at the merge base, so metadata-only required checks ci need title/body repair",
    detail: "The proof passes at the merge base.",
    options: [{ label: "amend-proof", detail: "amend the proof" }],
    recommendation: "amend-proof",
    headSha: OLD_HEAD,
  });
}

type Issue = { number: number; url: string; title: string; body: string };
const issueOf = (number: number, body: string): Issue =>
  ({ number, url: `https://github.com/${OWNER}/${REPO}/issues/${number}`, title: `[BLOCKED] issue ${number}`, body });

type Rollup = Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
const openPr = (number: number, head: string, rollup: Rollup | undefined) =>
  ({ number, url: `https://github.com/${OWNER}/${REPO}/pull/${number}`, headRefOid: head, statusCheckRollup: rollup });
const green: Rollup = [{ name: CHECK, status: "COMPLETED", conclusion: "SUCCESS" }, { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const red: Rollup = [{ name: CHECK, status: "COMPLETED", conclusion: "FAILURE" }];

type Comment = { created_at: string; body: string; user: { login: string; type: string } };
const fleetComment = (at: string): Comment => ({
  created_at: at, user: { login: "remudero-fleet", type: "User" },
  body: "Another escalation observed the same condition (task W1-T1, PR #1) while this issue was open.",
});
const personComment = (at: string, body = "design-remedy"): Comment => ({ created_at: at, body, user: { login: "cao825", type: "User" } });

/** Drive the builder, the tick read's pairing and the reconciler the way the read plane and the sweep wire them. */
async function drive(
  issues: Issue[],
  prs: ReturnType<typeof openPr>[] | undefined,
  comments: (issueNumber: number) => Comment[] | Error = () => [fleetComment("2026-11-24T10:00:00Z")],
  maxCloses?: number,
) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t13995-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const github = {
    prByRef: (ref: number | string) => {
      const n = typeof ref === "number" ? ref : Number(/(\d+)$/.exec(ref)?.[1]);
      const pr = prs?.find((p) => p.number === n);
      return pr ? { number: n, url: pr.url, state: "OPEN", headRefOid: pr.headRefOid } : undefined;
    },
    prByTrailer: () => undefined,
    mergedNewestFirst: () => [],
  };
  const built = buildEscalationReconcileCandidates(OWNER, REPO, NOTHING, ledgerPath, undefined, {
    issues: { listOpen: () => issues.map((i) => ({ ...i, state: "open" })) } as never,
    github: github as never,
    evidenceRootFor: () => undefined,
  });
  const reads: string[] = [];
  const read = async (args: string[]) => {
    reads.push(args[1]!);
    const n = Number(/issues\/(\d+)\/comments/.exec(args[1]!)?.[1]);
    const out = comments(n);
    if (out instanceof Error) throw out;
    return out;
  };
  const candidates = await attachEscalationConditions(OWNER, REPO, built, prs, read);
  const closes: Array<{ url: string; comment: string }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const summary = await runEscalationReconcile(candidates, {
    closeIssue: (url, comment) => void closes.push({ url, comment }),
    appendLine: ((_: string, row: Record<string, unknown>) => void rows.push(row)) as never,
    ledgerPath,
    runId: "TEST",
    ...(maxCloses === undefined ? {} : { maxCloses }),
  });
  return { built, candidates, closes, rows, summary, reads };
}

test("W1-T13995 criterion 1: a moved head with a green named check closes the escalation once, naming the head and the check", async () => {
  const { closes, rows, summary, reads } = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)]);
  assert.equal(summary.closed, 1);
  assert.deepEqual(summary.results.map((r) => r.outcome), ["closed"]);
  assert.equal(closes.length, 1);
  assert.equal(closes[0]!.url, `https://github.com/${OWNER}/${REPO}/issues/20742`);
  assert.match(closes[0]!.comment, new RegExp(`moved from head ${OLD_HEAD} to head ${NEW_HEAD}`));
  assert.match(closes[0]!.comment, /`acceptance-author-gate` passed at a9b1077e90/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, "sweep.escalation_closed");
  assert.equal(rows[0]!.resolution, "condition-cleared");
  assert.equal(rows[0]!.pr_number, 20740);
  assert.equal(rows[0]!.head_sha, NEW_HEAD);
  assert.deepEqual(rows[0]!.checks, [CHECK]);
  assert.equal(reads.length, 1, "one comment page is read for the one cleared escalation");
});

test("W1-T13995 criterion 1: a status context named by the escalation counts when its state is SUCCESS", async () => {
  const { closes } = await drive([issueOf(20742, clarificationBody(20740))],
    [openPr(20740, NEW_HEAD, [{ context: CHECK, state: "SUCCESS" }])]);
  assert.equal(closes.length, 1);
});

test("W1-T13995 criterion 2: an escalation stays open when its head moved but the named check is red or missing", async () => {
  for (const rollup of [red, [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }], [{ name: CHECK, status: "IN_PROGRESS" }], undefined]) {
    const { closes, summary, reads } = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, rollup)]);
    assert.equal(closes.length, 0, JSON.stringify(rollup));
    assert.deepEqual(summary.results.map((r) => r.outcome), ["left-live"]);
    assert.equal(reads.length, 0, "no comment read without a green check");
  }
  const twoChecks = await drive([issueOf(20742, clarificationBody(20740, { checks: `${CHECK}, review-gate` }))], [openPr(20740, NEW_HEAD, green)]);
  assert.equal(twoChecks.closes.length, 0, "every named check must be green, not only the first");
});

test("W1-T13995 criterion 2: an escalation stays open when the head did not move, even with a green check", async () => {
  const sameRed = await drive([issueOf(20743, clarificationBody(20737))], [openPr(20737, OLD_HEAD, red)]);
  assert.equal(sameRed.closes.length, 0);
  assert.deepEqual(sameRed.summary.results.map((r) => r.outcome), ["left-live"]);
  const sameGreen = await drive([issueOf(20743, clarificationBody(20737))], [openPr(20737, OLD_HEAD, green)]);
  assert.equal(sameGreen.closes.length, 0);
});

test("W1-T13995 criterion 2: an escalation whose check name cannot be read exactly stays open", async () => {
  for (const checks of ["acceptance author gate", "", "`acceptance-author-gate`", `${CHECK}, ${CHECK}`]) {
    const body = clarificationBody(20740, { checks });
    assert.equal(escalationNamedChecks(body), undefined, checks);
    const { closes, built } = await drive([issueOf(20742, body)], [openPr(20740, NEW_HEAD, green)]);
    assert.equal(closes.length, 0, checks);
    assert.equal(built[0]!.condition, undefined);
  }
  const twoLists = clarificationBody(20740).replace(/(## Details\n)/, `$1metadata-only required checks ci need title/body repair: other\n`);
  assert.equal(escalationNamedChecks(twoLists), undefined, "two different lists read as unread");
  assert.equal((await drive([issueOf(20742, twoLists)], [openPr(20740, NEW_HEAD, green)])).closes.length, 0);
  assert.deepEqual(escalationNamedChecks(clarificationBody(20740)), [CHECK]);
});

test("W1-T13995 criterion 2: an escalation stays open when a person commented on it, after the fleet's newest comment or before it", async () => {
  const replied = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => [fleetComment("2026-11-24T10:00:00Z"), personComment("2026-11-24T11:00:00Z")]);
  assert.equal(replied.closes.length, 0);
  assert.equal(replied.candidates[0]!.condition?.personReplied, true);
  const noFleet = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => [personComment("2026-11-24T09:00:00Z", "a question from someone outside the repository")]);
  assert.equal(noFleet.closes.length, 0, "a person's comment with no fleet comment after it keeps the issue open");
  const fleetOnly = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => [fleetComment("2026-11-24T09:00:00Z"), fleetComment("2026-11-24T10:00:00Z"),
      { ...fleetComment("2026-11-24T11:00:00Z"), user: { login: "github-actions[bot]", type: "Bot" }, body: "ok" }]);
  assert.equal(fleetOnly.closes.length, 1, "positive control: fleet and bot comments alone do not block");
});

test("W1-T13995 criterion 2: a person's reply followed by a fleet dedup comment keeps the escalation open", async () => {
  const { closes, summary, candidates } = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => [personComment("2026-11-24T09:00:00Z"), fleetComment("2026-11-24T10:00:00Z")]);
  assert.equal(closes.length, 0);
  assert.deepEqual(summary.results.map((r) => r.outcome), ["left-live"]);
  assert.equal(candidates[0]!.condition?.personReplied, true);
  const fleetLogin = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => [{ ...fleetComment("2026-11-24T09:00:00Z"), body: "Auto-resolved by plan_amendment_pr" }, fleetComment("2026-11-24T10:00:00Z")]);
  assert.equal(fleetLogin.closes.length, 0, "text the fleet reader does not know counts as a person's");
});

test("W1-T13995 criterion 2: an escalation stays open when its comments cannot be read or fill a whole page", async () => {
  const failed = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)], () => new Error("HTTP 502"));
  assert.equal(failed.closes.length, 0);
  const full = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => Array.from({ length: 100 }, (_, i) => fleetComment(new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString())));
  assert.equal(full.closes.length, 0);
  const undated = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20740, NEW_HEAD, green)],
    () => [{ ...fleetComment("2026-11-24T10:00:00Z"), created_at: "not a date" }]);
  assert.equal(undated.closes.length, 0);
});

test("W1-T13995 criterion 2: an escalation with a Head line and no open pull request stays open", async () => {
  const noPr = await drive([issueOf(20167, staleProofBody())], [openPr(20740, NEW_HEAD, green)]);
  assert.equal(noPr.closes.length, 0);
  const closedPr = await drive([issueOf(20742, clarificationBody(20740))], [openPr(20999, NEW_HEAD, green)]);
  assert.equal(closedPr.closes.length, 0, "a pull request missing from the open rows is never read as moved");
  const noRows = await drive([issueOf(20742, clarificationBody(20740))], undefined);
  assert.equal(noRows.closes.length, 0, "an unread open-PR list closes nothing");
  const noHead = await drive([issueOf(20742, clarificationBody(20740, { head: "" }))], [openPr(20740, NEW_HEAD, green)]);
  assert.equal(noHead.closes.length, 0, "an escalation without a Head line is never read as moved");
  const otherRepo = clarificationBody(20740).replace(/\(https:\/\/github\.com\/craigoley\/remudero\/pull\/20740\)/, "(https://github.com/craigoley/wreckterra/pull/20740)");
  assert.equal((await drive([issueOf(20742, otherRepo)], [openPr(20740, NEW_HEAD, green)])).closes.length, 0,
    "a body naming two pull requests is never paired");
});

test("W1-T13995 criterion 3: merged, closed, indeterminate and live escalations reconcile exactly as before", async () => {
  const base = { issueUrl: "https://github.com/craigoley/remudero/issues/1", taskId: "W1-T1" };
  const candidates: EscalationReconcileCandidate[] = [
    { ...base, derived: { merged: true, prNumber: 5, prUrl: "https://github.com/craigoley/remudero/pull/5", source: "trailer" } },
    { ...base, issueUrl: `${base.issueUrl}2`, derived: { merged: false, closed: true, prNumber: 6, source: "pr-referent" } },
    { ...base, issueUrl: `${base.issueUrl}3`, derived: { merged: false, indeterminate: true } },
    { ...base, issueUrl: `${base.issueUrl}4`, derived: { merged: false } },
  ];
  const closes: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const summary = await runEscalationReconcile(candidates, {
    closeIssue: (_url, comment) => void closes.push(comment),
    appendLine: ((_: string, row: Record<string, unknown>) => void rows.push(row)) as never,
    ledgerPath: "/dev/null",
    runId: "TEST",
  });
  assert.deepEqual(summary.results.map((r) => r.outcome), ["closed", "closed", "left-indeterminate", "left-live"]);
  assert.deepEqual(rows.map((r) => [r.resolution, r.pr_number, r.source, "head_sha" in r]),
    [["merged", 5, "trailer", false], ["closed", 6, "pr-referent", false]]);
  assert.match(closes[0]!, /is now \*\*merged\*\*/);
  assert.match(closes[1]!, /closed without merging/);
  for (const c of candidates) assert.equal(escalationConditionCleared(c), undefined);
  const cleared = { prNumber: 9, escalatedHead: OLD_HEAD, checks: [CHECK], currentHead: NEW_HEAD, checksGreen: true, personReplied: false };
  assert.equal(escalationConditionCleared({ ...base, condition: cleared, derived: { merged: false, indeterminate: true } }), undefined,
    "an indeterminate derivation is never read as cleared");
  assert.equal(escalationConditionCleared({ ...base, condition: { ...cleared, personReplied: undefined }, derived: { merged: false } }), undefined,
    "an unread comment thread is never read as cleared");
});

test("W1-T13995 criterion 3: the per-cycle close bound covers the new closes and the comment reads", async () => {
  const n = MAX_ESCALATION_CLOSES_PER_CYCLE + 2;
  const issues = Array.from({ length: n }, (_, i) => issueOf(30000 + i, clarificationBody(31000 + i)));
  const prs = Array.from({ length: n }, (_, i) => openPr(31000 + i, NEW_HEAD, green));
  const { closes, summary, reads } = await drive(issues, prs);
  assert.equal(MAX_ESCALATION_CLOSES_PER_CYCLE, 20);
  assert.equal(closes.length, MAX_ESCALATION_CLOSES_PER_CYCLE);
  assert.equal(reads.length, MAX_ESCALATION_CLOSES_PER_CYCLE, "comment reads stop at the bound");
  assert.equal(summary.results.filter((r) => r.outcome === "left-live").length, 2, "an unread thread waits for the next pass");
  const capped = await drive(issues.slice(0, 2), prs.slice(0, 2), undefined, 1);
  assert.deepEqual(capped.summary.results.map((r) => r.outcome), ["closed", "deferred-cap"]);
});

test("W1-T13995 criterion 1: the read plane's tick pairs an escalation with its open pull request, and the reconciler closes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t13995-tick-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const url = `https://github.com/${OWNER}/${REPO}/pull/20740`;
  const pull = {
    number: 20740, html_url: url, state: "open", draft: false, title: "fix: 20740", body: "Remudero-Task: W1-T20740",
    updated_at: "2026-11-24T00:00:00Z", created_at: "2026-11-24T00:00:00Z", head: { ref: "run-W1-T20740-1", sha: NEW_HEAD },
  };
  const commentReads: string[] = [];
  const fetch = (args: string[]): unknown => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("/pulls?")) return path.includes("state=open") ? [pull] : [];
    if (path.includes("/check-runs")) return { check_runs: [{ id: 7, name: CHECK, status: "completed", conclusion: "success", head_sha: NEW_HEAD }] };
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.includes("/issues/20742/comments")) {
      commentReads.push(path);
      return [fleetComment("2026-11-24T10:00:00Z")];
    }
    if (path.endsWith("/files") || path.includes("/files?")) return [{ filename: "src/a.ts" }];
    if (path.includes("/compare/")) return { ahead_by: 0 };
    return {};
  };
  const issue = { ...issueOf(20742, clarificationBody(20740)), state: "open" };
  const github = {
    prByRef: (ref: number | string) => (String(ref).endsWith("20740") ? { number: 20740, url, state: "OPEN", headRefOid: NEW_HEAD } : undefined),
    prByTrailer: () => undefined, mergedNewestFirst: () => [],
  };
  const produce = createTickReadProducer({ owner: OWNER, repo: REPO, config: { root, claudeBin: process.execPath } as never, ledgerPath, checkoutRoot: root }, {
    fetch, fetchAsync: async (args) => fetch(args), changedFilesFetch: async () => ["src/a.ts"],
    commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined, github: github as never,
    issues: { create: () => { throw new Error("write in read plane"); }, listOpen: (label: string) => (label === "needs-human" ? [issue] : []) } as never,
    viewsDeps: { requiredContexts: () => ["ci-gate"], readCiGateRequired: () => [], fetchCiFailureEvidence: () => [] },
  });
  const facts = await produce({ plan: NOTHING });
  const candidate = facts.escalationCandidates.find((c) => c.issueNumber === 20742);
  assert.equal(candidate?.condition?.currentHead, NEW_HEAD);
  assert.equal(candidate?.condition?.checksGreen, true);
  assert.equal(candidate?.condition?.personReplied, false);
  assert.equal(commentReads.length, 1);
  const closes: string[] = [];
  const summary = await runEscalationReconcile(facts.escalationCandidates, {
    closeIssue: (issueUrl) => void closes.push(issueUrl), appendLine: (() => {}) as never, ledgerPath, runId: "TEST",
  });
  assert.equal(summary.closed, 1);
  assert.deepEqual(closes, [issue.url]);
});
