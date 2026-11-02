/**
 * A stage-stall report (`**Cause:** stage-stall`, class MANUAL) is the fleet's own observation of one PR at
 * one head and one blocker, not an operator capacity decision. The issue-revalidation garden therefore
 * resolves it deterministically, and may close it despite class MANUAL, in exactly two cases:
 *   - the PR's head has moved off the head the stall was reported at (a stall at the new head files its own);
 *   - a NEWER open stage-stall issue reports the same PR, head and blocker (W1-T11031's dedup key).
 * Every other guard still holds, and every other MANUAL or GRILL issue still only refreshes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  ISSUE_REVALIDATION_VERDICT_STEP, runIssueRevalidationGarden,
  type IssueRevalidationPorts, type RevalidationComment, type RevalidationIssue, type RevalidationVerdict,
} from "#src/lib/issue-revalidation-garden.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { issueRevalidationRunTaskPorts } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 1, 12);
const clock = fixedClock(NOW);
const at = (hours: number) => fixedClock(NOW + hours * HOUR).iso();
const OLD_HEAD = "7c6f773a757db1c92e6c016df4b0e5838960cfdb";
const NEW_HEAD = "0123456789abcdef0123456789abcdef01234567";
const pull = (n: number) => `https://github.com/acme/remudero/pull/${n}`;

function stall(n: number, o: { pr?: number; head?: string; blocker?: string; cls?: string; cause?: string; title?: string } = {}): RevalidationIssue {
  const pr = o.pr ?? 15065;
  const reason = `PR stage stalled: #${pr} ${pull(pr)} — ${o.blocker ?? "escalated"} for 31 minutes (BACKSTOP 30); since 2026-10-28T07:03:18.825Z; DIAGNOSIS: review loop`;
  const body = [`**Class:** ${o.cls ?? "MANUAL"}`, "**Task:** W1-T10781", "**Host:** h", "**Run:** DAEMON-1",
    `**Head:** ${o.head ?? OLD_HEAD}`, `**Cause:** ${o.cause ?? "stage-stall"}`, "**Contract:** c0ffee", "",
    `The CLARIFICATION-QUESTION rung reconciled open PR #${pr} to BLOCKED-AMBIGUOUS: ${reason}.`, "", reason].join("\n");
  const title = o.title ?? `[${o.cls ?? "MANUAL"}] W1-T10781: PR ${pull(pr)} needs a clarification — PR stage stalled: #${pr} ${pull(pr)} — ${o.blocker ?? "escalated"}; DIAGNOSIS: review loop`;
  return { number: n, url: `https://github.com/acme/remudero/issues/${n}`, title, body, labels: ["needs-human"], createdAt: at(-96), updatedAt: at(-2) };
}

const fleetRefresh = (hours: number): RevalidationComment => ({ authorLogin: "remudero-fleet[bot]", authorType: "Bot",
  authorAssociation: "CONTRIBUTOR", createdAt: at(hours), body: "Still open as of 2026-11-01 (issue-revalidation garden, W1-T8864): still-true." });
const operator = (hours: number): RevalidationComment => ({ authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", createdAt: at(hours), body: "looking" });

/** The referent derivation as run-task builds it: the PR is OPEN, so still-true, carrying its current head. */
const openAt = (sha: string) => async (issues: readonly RevalidationIssue[]) => new Map(issues.map((i): [number, RevalidationVerdict] =>
  [i.number, { verdict: "still-true", reason: "W1-T10781 is still open", openPrHead: { prNumber: 15065, sha } } as RevalidationVerdict]));

function run(issues: RevalidationIssue[], over: Partial<IssueRevalidationPorts> = {}) {
  const closes: Array<{ url: string; comment: string }> = [];
  const comments: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const ports: IssueRevalidationPorts = {
    policy: () => ({ mode: "act", maxClosesPerPass: 5 }),
    listOpenIssues: async () => issues,
    listComments: async () => [fleetRefresh(-3)],
    referentVerdicts: openAt(NEW_HEAD),
    hasReferent: (i) => /\/pull\/\d+/.test(i.title),
    livenessVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    readModelVerdict: () => ({ verdict: "unknown", reason: "n/a" }),
    evidence: () => ({ facts: [] }),
    judge: async () => { throw new Error("no model judge is spent on a stage-stall report"); },
    priorVerdicts: () => new Map(),
    close: async (url, comment) => void closes.push({ url, comment }),
    comment: async (url) => void comments.push(url),
    fileConversion: async () => "fb-none",
    log: (step, extra = {}) => { if (step === ISSUE_REVALIDATION_VERDICT_STEP) rows.push(extra); },
    clock,
    ...over,
  };
  return { ports, closes, comments, rows, row: (n: number) => rows.find((r) => r.issue_number === n)! };
}

test("a stage-stall issue whose PR head moved closes, citing the new head and the head it was reported at", async () => {
  const f = run([stall(15114, { blocker: "awaiting-review" })]);
  await runIssueRevalidationGarden(f.ports);
  const row = f.row(15114);
  assert.equal(row.verdict, "resolved");
  assert.equal(row.citation, `PR #15065 head is now ${NEW_HEAD}; this stall was reported at ${OLD_HEAD}`);
  assert.equal(row.action, "close");
  assert.equal(row.judged, false, "deterministic: no model judge is spent");
  assert.deepEqual(f.closes.map((c) => c.url), ["https://github.com/acme/remudero/issues/15114"]);
  assert.match(f.closes[0]!.comment, new RegExp(`PR #15065 head is now ${NEW_HEAD}`));
});

test("of two stage-stall issues at one PR, head and blocker the older closes as a duplicate and the newer stays", async () => {
  const f = run([stall(15124), stall(15116)], { referentVerdicts: openAt(OLD_HEAD) });
  await runIssueRevalidationGarden(f.ports);
  const older = f.row(15116);
  assert.equal(older.verdict, "resolved");
  assert.equal(older.action, "close");
  assert.match(String(older.citation), /https:\/\/github\.com\/acme\/remudero\/issues\/15124/);
  assert.notEqual(f.row(15124).action, "close", "the newest report of the condition stays open");
  assert.equal(f.row(15124).verdict, "still-true");
  assert.deepEqual(f.closes.map((c) => c.url), ["https://github.com/acme/remudero/issues/15116"]);
});

test("stage-stall issues at one head with different blockers both stay open", async () => {
  const f = run([stall(15124, { blocker: "escalated" }), stall(15114, { blocker: "awaiting-review" })], { referentVerdicts: openAt(OLD_HEAD) });
  await runIssueRevalidationGarden(f.ports);
  assert.deepEqual(f.closes, []);
  assert.equal(f.row(15114).verdict, "still-true");
  assert.equal(f.row(15124).verdict, "still-true");
});

test("a MANUAL issue that is not a stage stall still only refreshes, whatever its head", async () => {
  const notStall = stall(15200, { cause: "review" });
  const grill = stall(15201, { cls: "GRILL" });
  const f = run([notStall, grill], {
    // A terminal referent is a resolved verdict with a citation: the operator-owned guard still refreshes it.
    referentVerdicts: async (issues) => new Map(issues.map((i): [number, RevalidationVerdict] =>
      [i.number, i.number === 15200 ? { verdict: "resolved", reason: "merged", citation: "PR #15065 merged" }
        : { verdict: "still-true", reason: "open", openPrHead: { prNumber: 15065, sha: NEW_HEAD } } as RevalidationVerdict])),
  });
  await runIssueRevalidationGarden(f.ports);
  assert.deepEqual(f.closes, []);
  assert.equal(f.row(15200).action, "refresh");
  assert.equal(f.row(15200).guard, "operator-owned-class");
  assert.equal(f.row(15201).verdict, "still-true", "a GRILL is never resolved by the stage-stall rule");
});

test("a stage-stall issue the operator spoke on last is kept, even at a moved head", async () => {
  const f = run([stall(15114)], { listComments: async () => [fleetRefresh(-5), operator(-1)] });
  await runIssueRevalidationGarden(f.ports);
  assert.equal(f.row(15114).verdict, "resolved");
  assert.equal(f.row(15114).action, "keep");
  assert.equal(f.row(15114).guard, "newer-operator-comment");
  assert.deepEqual(f.closes, []);
});

test("a stage-stall resolution still honours the close cap and the re-observed window", async () => {
  const issues = [16001, 16002, 16003].map((n) => stall(n, { blocker: "awaiting-review" }));
  const f = run(issues, { policy: () => ({ mode: "act", maxClosesPerPass: 2 }),
    listComments: async (n) => n === 16003 ? [{ ...fleetRefresh(-1), body: "Another escalation observed the same condition (k) while this issue was open." }] : [fleetRefresh(-3)] });
  await runIssueRevalidationGarden(f.ports);
  assert.deepEqual(f.closes.map((c) => c.url.replace(/.*\//, "")), ["16001", "16002"]);
  assert.equal(f.row(16003).guard, "condition-reobserved");
});

test("the run-task referent derivation carries an open PR's current head from the batched view, and only an open one's", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stage-stall-head-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const rows: Record<number, { state: string; headRefOid: string }> = {
    15065: { state: "OPEN", headRefOid: NEW_HEAD }, 15066: { state: "MERGED", headRefOid: NEW_HEAD },
  };
  const github = { prByRef: (n: number) => (n in rows ? { number: n, url: pull(n), ...rows[n] } : undefined) } as never;
  const p = issueRevalidationRunTaskPorts({ owner: "acme", repo: "remudero", repoRoot: REPO_ROOT, stateDir, log: () => {} }, {
    loadPlan: () => ({ tasks: [], byId: new Map() }) as never,
    reconcile: { github, evidenceRootFor: () => undefined },
  });
  const verdicts = await p.referentVerdicts([stall(1, { pr: 15065 }), stall(2, { pr: 15066 })]);
  assert.deepEqual(verdicts.get(1)?.openPrHead, { prNumber: 15065, sha: NEW_HEAD });
  assert.equal(verdicts.get(2)?.verdict, "resolved");
  assert.equal(verdicts.get(2)?.openPrHead, undefined, "a merged PR's head describes no live stall");
});
