/**
 * A REFUSED DEPENDABOT PATH NAMES ITS OWN SECURITY VERDICT AND REACHES THE OPERATOR BY NAME.
 *
 * 2026-10-25: Dependabot PR #14094 (setuptools 84.0.0 -> 84.1.0, opentelemetry-api 1.37.0 -> 1.45.1 in
 * /.github/semgrep) was refused because it edits the Semgrep runtime locks, which dep-review keeps
 * outside its allowlist on purpose (W1-T3707, W1-T9797). At 05:30:40Z security-merge-policy had
 * already published `blocked: semgrep-runtime-incompatible-or-install-failed` on the head. The
 * 06:33:47Z proposal (fb-dep-review-4907ce44ff3c0c16) listed only the required reds, told a builder to
 * "land the SAME version moves", and waited at status: new behind a FIFO triage queue days deep.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { buildSweepEffects, depReviewCommand, type DepReviewDeps } from "#test/helpers/run-task-test.js";
import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-10-25T06:33:47.934Z");
const HEAD = "aa4f5eef17a8a26c776e8e3cb3d5e3d963510cd8";
const URL = "https://github.com/craigoley/remudero/pull/14094";
const TITLE = "chore(deps): bump the pip group across 1 directory with 2 updates";
const BODY = "Bumps the pip group with 2 updates in the /.github/semgrep directory: setuptools and opentelemetry-api.\n\n" +
  "Updates `setuptools` from 84.0.0 to 84.1.0\n\nUpdates `opentelemetry-api` from 1.37.0 to 1.45.1\n";
const LOCKS = [".github/semgrep/build-requirements.txt", ".github/semgrep/requirements.txt"];
const DIFF = [
  `diff --git a/${LOCKS[0]} b/${LOCKS[0]}\n--- a/${LOCKS[0]}\n+++ b/${LOCKS[0]}\n@@ -1 +1 @@\n-setuptools==84.0.0\n+setuptools==84.1.0\n`,
  `diff --git a/${LOCKS[1]} b/${LOCKS[1]}\n--- a/${LOCKS[1]}\n+++ b/${LOCKS[1]}\n@@ -9 +9 @@\n-opentelemetry-api==1.37.0\n+opentelemetry-api==1.45.1\n`,
].join("");
const VERDICT = "blocked: semgrep-runtime-incompatible-or-install-failed";

function fixture(t: TestContext, opts: { verdict: "blocked" | "unknown" } = { verdict: "blocked" }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-refused-verdict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const captures: Array<{ id: string; raw: string }> = [];
  const opened: Array<{ url: string; title: string; body: string }> = [];
  let listFails = false;
  const issues: IssueGateway = {
    create(title, body) {
      const url = `https://github.com/craigoley/remudero/issues/${14200 + opened.length}`;
      opened.push({ url, title, body });
      return url;
    },
    listOpen() {
      if (listFails) throw new Error("issue list unavailable");
      return opened.map((i, index) => ({ ...i, number: 14200 + index }));
    },
    closeWithComment() {},
  };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => NOW),
    gh: () => ({
      number: 14094, url: URL, title: TITLE, body: BODY, headRefOid: HEAD,
      headRefName: "dependabot/pip/dot-github/semgrep/pip-4907ce44ff", author: { login: "app/dependabot" },
      commits: [{ oid: HEAD, authors: [{ login: "", name: "dependabot[bot]" }] }],
      statusCheckRollup: [
        { __typename: "CheckRun", name: "head-identity-gate", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "ci-gate", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "semgrep-runtime-compatibility", status: "COMPLETED", conclusion: "FAILURE" },
        opts.verdict === "blocked"
          ? { __typename: "StatusContext", context: "security-merge-policy", state: "FAILURE", description: VERDICT }
          : { __typename: "StatusContext", context: "security-merge-policy", state: "ERROR",
            description: "unknown: trusted-exact-head-codeql-result-missing" },
      ],
    }),
    // #14094's judged set: protection and ci-gate's REQUIRED, which do not name security-merge-policy.
    requiredChecks: async () => ({ kind: "required", names: ["ci", "ci-gate", "head-identity-gate"] }),
    prDiff: () => DIFF,
    postStatus: (async () => assert.fail("a refuse posts no status")) as never,
    arm: () => assert.fail("a refuse never arms"),
    issues,
    captureMigrationFeedback: ((args: { id: string; raw: string }) => {
      captures.push({ id: args.id, raw: args.raw });
      return { id: args.id };
    }) as never,
    prMutations: { comment: () => assert.fail("no @dependabot command is posted"), close: () => assert.fail("a refusal never closes the PR") },
  };
  const ledger = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const view: OpenPrView = {
    prNumber: 14094, prUrl: URL, headSha: HEAD, headRefName: "dependabot/pip/dot-github/semgrep/pip-4907ce44ff",
    isDependabot: true, reviewState: "none", checksState: "red", ciFailures: [{ name: "ci", logTail: "" }], unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: "2026-10-25T05:30:40.000Z", autoMergeArmed: false, mergeState: "clean", changedFiles: LOCKS,
  };
  const sweepOutcome = () => buildSweepEffects({ owner: "craigoley", repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config, ledgerPath, runId: "refused-verdict-sweep",
    plan: { tasks: [], byId: new Map() } as Plan, policy: DEFAULT_SWEEP_POLICY, log: () => {},
    contributorAdmissionImpl: async () => {}, depReviewCommandImpl: (pr, rest) => depReviewCommand(pr, rest, deps),
  }).depReview!(view, undefined, undefined) as Promise<string | void>;
  return {
    run: () => depReviewCommand("14094", ["--repo", "remudero"], deps),
    sweepOutcome, captures, opened, ledger, failList: (fail: boolean) => { listFails = fail; },
  };
}

test("a refused dependabot path names every red verdict and never prescribes a move its own security verdict refuses", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 2, "still a refuse: nothing is posted or armed");
  assert.equal(f.captures.length, 1, "one owned-build proposal");
  const raw = f.captures[0].raw;
  assert.match(raw, /Bumps: setuptools 84\.0\.0 -> 84\.1\.0, opentelemetry-api 1\.37\.0 -> 1\.45\.1/);
  assert.match(raw, /Red checks: head-identity-gate, ci, ci-gate\n/, "the required half, as #14094 listed it");
  assert.ok(raw.includes(`- security-merge-policy (advisory): FAILURE — ${VERDICT}`), "the advisory verdict and its own reason are named");
  assert.ok(raw.includes("- semgrep-runtime-compatibility (advisory): FAILURE"));
  assert.match(raw, /excludes these paths on purpose/, "the deliberate exclusion is named, not left implied");
  assert.doesNotMatch(raw, /SAME version moves/, "a move the PR's own verdict refuses is never prescribed");
  assert.match(raw, /do NOT land the same version moves/);
  assert.match(raw, /REFUSED: with class premise-rotted/);
  assert.ok(raw.includes(f.opened[0]?.url ?? "no-issue"), "the proposal names the operator ask");

  // The control: an `unknown:` security verdict is missing evidence, not a refusal of the move.
  const g = fixture(t, { verdict: "unknown" });
  assert.equal(await g.run(), 2);
  assert.match(g.captures[0].raw, /- security-merge-policy \(advisory\): ERROR — unknown: trusted-exact-head-codeql-result-missing/);
  assert.match(g.captures[0].raw, /SAME version moves/);
  assert.equal(g.opened.length, 0, "no operator ask without a refusing verdict");
});

test("a dependabot refusal blocked by its own security verdict is escalated to the operator by name once per head", async (t) => {
  const f = fixture(t);
  f.failList(true);
  assert.equal(await f.sweepOutcome(), "hold", "an undelivered ask leaves the refuse unsettled, so the next pass re-runs it");
  assert.equal(f.opened.length, 0);
  assert.equal(f.captures.length, 0, "no proposal is filed ahead of the ask it must name");
  f.failList(false);
  assert.equal(await f.sweepOutcome(), "refuse", "the retry asks, files and settles");
  assert.equal(f.opened.length, 1);
  const [ask] = f.opened;
  assert.match(ask.title, /Dependabot PR #14094 is refused by its own security verdict/);
  assert.ok(ask.body.includes(`security-merge-policy: ${VERDICT}`), "the blocker is named by its own words");
  assert.ok(ask.body.includes(LOCKS.join(", ")));
  assert.match(ask.body, /Owner: repository operator/);
  const escalated = f.ledger().filter((r) => r.step === "dep-review.refused_path.escalated");
  assert.deepEqual(escalated.map((r) => [r.pr_number, r.head_sha, r.issue_url]), [[14094, HEAD, ask.url]]);

  // A later pass on the same head neither asks again nor files a second proposal.
  assert.equal(await f.run(), 2);
  assert.equal(f.opened.length, 1);
  assert.equal(f.captures.length, 1);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.refused_path.escalated").length, 1);
});
