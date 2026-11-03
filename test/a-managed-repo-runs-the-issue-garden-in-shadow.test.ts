// Operator 2026-11-01: "We need something that manages this running as a part of rmd on any repo its managing to keep
// things tidy." The issue-revalidation garden was self-only (registeredGardenEnabled returned isSelf for every garden,
// and the daemon built every garden over self.owner/self.repo), so a consumer repository's stale issues were never
// named. Now it runs on every managed target over THAT repository, never above shadow, with its pacing record and
// verdict history keyed by the repository. Every other garden stays self-only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import {
  GARDEN_REPO_FLAG, issueRevalidationPolicyForTarget, registeredGardenEnabled, registeredGardenTargetArgs, REGISTERED_GARDEN_NAMES,
} from "#src/lib/garden-registry.js";
import {
  ISSUE_REVALIDATION_VERDICT_STEP, productionIssueRevalidationPorts, runIssueRevalidationGarden, type IssueRevalidationPolicy,
} from "#src/lib/issue-revalidation-garden.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// The daemon and garden-child wiring tests (they import run-task.ts) live in
// test/a-gardener-pass-never-runs-on-the-daemon-loop.test.ts.
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const clock = fixedClock(NOW);
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const ACT: IssueRevalidationPolicy = { mode: "act", maxClosesPerPass: 5 };
const consumer = { owner: "acme", repo: "consumer", isSelf: false };

test("a managed repo runs the issue garden in shadow: only issue-revalidation is enabled off self, naming the target", () => {
  for (const name of REGISTERED_GARDEN_NAMES) {
    assert.equal(registeredGardenEnabled(name, false, {}), name === "issue-revalidation", name);
    if (name !== "inbox") assert.equal(registeredGardenEnabled(name, true, {}), true, `${name} still runs on self`);
  }
  assert.deepEqual(registeredGardenTargetArgs("issue-revalidation", consumer), [GARDEN_REPO_FLAG, "acme/consumer"]);
  assert.deepEqual(registeredGardenTargetArgs("issue-revalidation", { ...consumer, isSelf: true }), [], "a self pass's argv is unchanged");
  assert.deepEqual(registeredGardenTargetArgs("plan", consumer), []);
  // No per-target block exists in policy.yaml: a non-self target is never above shadow, and off stays off.
  assert.equal(issueRevalidationPolicyForTarget(ACT, false).mode, "shadow");
  assert.equal(issueRevalidationPolicyForTarget(ACT, false).maxClosesPerPass, 5);
  assert.equal(issueRevalidationPolicyForTarget({ ...ACT, mode: "off" }, false).mode, "off");
  assert.equal(issueRevalidationPolicyForTarget(ACT, true).mode, "act", "the self repo keeps policy.yaml's mode");
});

test("a managed repo runs the issue garden in shadow: it reads the target's issues, ledgers verdicts and closes nothing", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}managed-garden-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const url = (repo: string, n: number) => `https://github.com/acme/${repo}/issues/${n}`;
  const reads: string[][] = [], writes: string[] = [], rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const listing = JSON.stringify([{ number: 7, html_url: url("consumer", 7), title: "stale", body: "**Task:** PR-3\n**Class:** BLOCKED\n",
    labels: [], created_at: at(-200), updated_at: at(-100) }]);
  const ports = productionIssueRevalidationPorts({
    owner: "acme", repo: "consumer", stateDir, repoRoot: REPO_ROOT, log: (step, extra = {}) => void rows.push({ step, extra }), clock,
    managedTarget: true, policy: () => issueRevalidationPolicyForTarget(ACT, false),
    hasReferent: () => true,
    referentVerdicts: async () => new Map([[7, { verdict: "resolved" as const, reason: "merged", citation: "PR #3 merged" }]]),
    judgeText: async () => { throw new Error("no judge for a referent issue"); },
    readText: async (args) => { reads.push(args); return args[1]!.includes("/comments") ? "[]" : listing; },
    issues: { closeWithComment: async (u) => void writes.push(`close ${u}`), comment: async (u) => void writes.push(`comment ${u}`) },
    // Both repositories' verdicts share one ledger: only this target's, named by its issue_url, are its history.
    readLedgerRows: () => [
      { ts: at(-2), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, issue_url: url("remudero", 7), verdict: "still-true" },
      { ts: at(-3), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, issue_url: url("consumer", 7), verdict: "unknown" },
      { ts: at(-1), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 8, verdict: "still-true" },
    ],
  });
  const prior = ports.priorVerdicts();
  assert.deepEqual([...prior.keys()], [7], "an unkeyed row is never a managed target's history");
  assert.equal(prior.get(7)?.verdict, "unknown", "the self repo's issue #7 is not the consumer's #7");
  const summary = await runIssueRevalidationGarden(ports);
  assert.equal(summary.mode, "shadow");
  assert.deepEqual(reads[0], ["api", "repos/acme/consumer/issues?state=open&per_page=100", "--paginate"]);
  assert.deepEqual(writes, [], "shadow writes nothing to the target's GitHub");
  const verdict = rows.find((r) => r.step === ISSUE_REVALIDATION_VERDICT_STEP)!.extra;
  assert.equal(verdict.issue_url, url("consumer", 7));
  assert.equal(verdict.verdict, "resolved");
  assert.equal(verdict.acted, false);
});
