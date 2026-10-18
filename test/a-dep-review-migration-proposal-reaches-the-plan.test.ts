/**
 * W1-T9664 — A DEP-REVIEW MIGRATION PROPOSAL REACHES THE PLAN.
 *
 * Both dep-review captures wrote into config.root, the daemon's STATE root, which is not a git checkout and which
 * nothing reads. Four Dependabot majors (#5758, #6337, #6761, #9767) were closed on fb-dep-review-adb8a956b051dd72,
 * a proposal that never reached origin/main or triage. These tests drive the REAL capture (no
 * captureMigrationFeedback seam): the proposal is written in the checkout and staged into the landing queue under
 * the landing state root, and a proposal the queue refused keeps the bot PR open.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { queuedFeedbackDir } from "#src/lib/feedback-landing.js";
import { depReviewCommand, type DepReviewDeps } from "#test/helpers/run-task-test.js";

const NOW = Date.parse("2026-10-15T09:00:00.000Z");
const MAJOR_TITLE = "build(deps-dev): bump @types/node from 22.20.2 to 25.9.6";
const MAJOR_BODY = "Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) from 22.20.2 to 25.9.6.";
const OWN_RED_TITLE = "build(deps): bump @anthropic-ai/claude-agent-sdk from 0.3.293 to 0.3.296";
const PKG_DIFF = [
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1,3 +1,3 @@",
  '-    "@types/node": "^22.20.2",',
  '+    "@types/node": "^25.9.6",',
  "",
].join("\n");

interface Harness {
  state: string;
  checkout: string;
  deps: DepReviewDeps;
  closes: string[];
  comments: string[];
  ledger: () => Record<string, unknown>[];
  advance: (ms: number) => void;
}

function harness(t: TestContext, pr: { title: string; body: string; diff: string; red: string[] }): Harness {
  const state = mkdtempSync(join(tmpdir(), "rmd-t9664-state-"));
  const checkout = mkdtempSync(join(tmpdir(), "rmd-t9664-co-"));
  t.after(() => {
    rmSync(state, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });
  const ledgerPath = join(state, "state", "ledger.ndjson");
  let now = NOW;
  const closes: string[] = [];
  const comments: string[] = [];
  const deps: DepReviewDeps = {
    config: { root: state, ledger: ledgerPath } as never,
    root: checkout,
    landingStateRoot: state,
    clock: clockFromMillisFn(() => now),
    gh: () => ({
      number: 5758, url: "https://github.com/craigoley/remudero/pull/5758", title: pr.title, body: pr.body,
      headRefOid: "dbc46d90".padEnd(40, "0"), headRefName: "dependabot/npm_and_yarn/pr-5758", author: { login: "app/dependabot" },
      statusCheckRollup: ["ci-gate", "coverage-shard (4/8)"].map((name) => ({ name, conclusion: pr.red.includes(name) ? "FAILURE" : "SUCCESS" })),
      commits: [{ oid: "dbc46d90".padEnd(40, "0"), authors: [{ login: "", name: "dependabot[bot]" }] }],
    }),
    prDiff: () => pr.diff,
    nodePin: { readAtHead: () => undefined, commitAndPush: () => { throw new Error("no .nvmrc push in this suite"); } },
    postStatus: (async () => ({ posted: true })) as DepReviewDeps["postStatus"],
    arm: () => "armed",
    contributorAdmission: async () => {},
    issues: { create: () => "https://github.com/craigoley/remudero/issues/9664", listOpen: () => [], closeWithComment() {} } as never,
    prMutations: {
      comment: (_url, body) => { comments.push(body); },
      close: (_url, opts) => { closes.push(opts.comment); },
    },
  };
  return {
    state, checkout, deps, closes, comments,
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    advance: (ms) => { now += ms; },
  };
}

function queued(state: string): Array<Record<string, unknown>> {
  const dir = queuedFeedbackDir(state);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".yaml")).map((n) => parseYaml(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>);
}

const feedbackFiles = (root: string): string[] => existsSync(join(root, "plan", "feedback")) ? readdirSync(join(root, "plan", "feedback")) : [];

test("W1-T9664: a daemon dep-review migration proposal is staged from the checkout, never the state root", async (t) => {
  const h = harness(t, { title: MAJOR_TITLE, body: MAJOR_BODY, diff: PKG_DIFF, red: ["ci-gate"] });
  assert.equal(await depReviewCommand("5758", ["--repo", "remudero"], h.deps), 0);
  const decided = h.ledger().find((r) => r.step === "dep-review.decided");
  assert.equal(decided?.decision, "migrate", "control: the fixture is a migrate decision");

  const records = queued(h.state);
  assert.equal(records.length, 1, "exactly one proposal waits in the landing queue");
  const [record] = records;
  assert.match(String(record.id), /^fb-dep-review-[0-9a-f]{16}$/);
  assert.equal(record.origin, "repair#dep-review");
  assert.equal(record.submission_key, "dep-review:migration:craigoley/remudero:@types/node@25");
  assert.deepEqual(feedbackFiles(h.state), [], "nothing is written under the state root's plan/feedback");
  assert.deepEqual(feedbackFiles(h.checkout), [], "the checkout copy was MOVED into the queue, not left to land inline");

  assert.equal(h.closes.length, 1, "a staged proposal is durable, so the bot PR closes");
  assert.match(h.closes[0], new RegExp(String(record.id)));
  const captured = h.ledger().find((r) => r.step === "dep-review.migrate.feedback_captured");
  assert.equal(captured?.feedback_id, record.id);

  // A second pass over the same major dedupes on the queued submission key: no second record, no second write.
  assert.equal(await depReviewCommand("5758", ["--repo", "remudero"], h.deps), 0);
  assert.equal(queued(h.state).length, 1);
  assert.deepEqual(feedbackFiles(h.checkout), []);
});

test("W1-T9664: a daemon dep-review own-red proposal is staged from the checkout, never the state root", async (t) => {
  const sdkDiff = "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n";
  const h = harness(t, { title: OWN_RED_TITLE, body: "", diff: sdkDiff, red: ["ci-gate", "coverage-shard (4/8)"] });
  const run = () => depReviewCommand("5758", ["--repo", "remudero", "--dependabot-own-red", "main-passes"], h.deps);
  assert.equal(await run(), 1);
  assert.equal(queued(h.state).length, 0, "control: the first own-red pass only records the head");
  h.advance(15 * 60_000);
  assert.equal(await run(), 1, "an own-red proposal holds the PR");

  const records = queued(h.state);
  assert.equal(records.length, 1, "one own-red proposal waits in the landing queue");
  assert.equal(records[0].origin, "repair#dep-review");
  assert.equal(records[0].submission_key, "dep-review:own-red:craigoley/remudero:@anthropic-ai/claude-agent-sdk@0.3.296");
  assert.deepEqual(feedbackFiles(h.state), [], "nothing is written under the state root's plan/feedback");
  assert.deepEqual(feedbackFiles(h.checkout), []);
  assert.deepEqual(h.closes, [], "an own-red proposal never closes the bot PR");
  assert.equal(h.ledger().some((r) => r.step === "dep-review.own_red.failed"), false);
});

test("W1-T9664: a dep-review migration whose proposal was not staged never closes the bot pr", async (t) => {
  const h = harness(t, { title: MAJOR_TITLE, body: MAJOR_BODY, diff: PKG_DIFF, red: ["ci-gate"] });
  // The queue's plan/ component is a FILE, so the record cannot be moved into the landing queue.
  const pendingPlan = join(queuedFeedbackDir(h.state), "..");
  mkdirSync(join(pendingPlan, ".."), { recursive: true });
  writeFileSync(pendingPlan, "not a directory\n");

  assert.equal(await depReviewCommand("5758", ["--repo", "remudero"], h.deps), 1);
  assert.deepEqual(h.closes, [], "an unstaged proposal leaves the Dependabot PR open");
  assert.deepEqual(h.comments, [], "and posts no Dependabot ignore command");
  const failed = h.ledger().find((r) => r.step === "dep-review.migrate.capture_failed");
  assert.match(String(failed?.error), /was not staged: queueing plan\/feedback\/fb-dep-review-[0-9a-f]{16}\.yaml/);
  assert.equal(h.ledger().some((r) => r.step === "dep-review.migrate.completed"), false);
  assert.deepEqual(feedbackFiles(h.state), [], "nothing is written under the state root's plan/feedback");
  assert.equal(feedbackFiles(h.checkout).length, 1, "the unstaged copy stays in the checkout for the landing sweep");
});
