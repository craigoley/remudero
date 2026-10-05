import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderPrerequisitePrPrompt, runFixRung } from "../src/run-task.js";
import * as runner from "../src/run-task.js";
import { acceptanceAuthorTimeCheck, type ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";

const proof = "test/a-prerequisite-split-pr-opens-on-a-conforming-head-with-acceptance.test.ts";
const body = "## Acceptance\n- the instrument has a standalone regression | unit test: standalone instrument regression";
const prerequisiteUrl = "https://github.com/acme/remudero/pull/9001";
const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 10, contextBudget: 120000 };
const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
  state: "failure", criteria: [], testTheater: false, summary: "instrument entangled",
  floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
  instrumentEntangled: true,
  instrumentEntanglementPaths: { instrumentPaths: ["scripts/coverage-ratchet.mjs"], srcPaths: ["src/run-task.ts"] },
  headSha: "deadbeef", reviewerOutcome: "success",
};
const worker: WorkerResult = {
  sessionId: "split", costUsd: 0, numTurns: 1, text: `PR_URL: ${prerequisiteUrl}`,
  blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
  permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
  compactionEvents: [], qualitySuspect: false,
};

test(`${proof}: prompt names the exact minted head and executable Acceptance contract`, () => {
  const prerequisiteBranch = "run-unfiled-1791173256741";
  const prompt = renderPrerequisitePrPrompt({
    task: { id: "W1-T5779", title: "split" }, branch: "run-W1-T5779-1",
    prUrl: "https://github.com/acme/remudero/pull/1", prerequisiteBranch,
    instrumentPaths: ["scripts/coverage-ratchet.mjs"], srcPaths: ["src/run-task.ts"],
  });
  assert.ok(prompt.includes(`\`${prerequisiteBranch}\``));
  assert.match(prompt, /## Acceptance/);
  assert.match(prompt, /unit test:/);
  assert.match(prompt, /grep:/);
  assert.match(prompt, /line.*adds|added.*line/i);
  assert.match(prompt, /no.*Remudero-Task:/i);
  assert.match(prompt, /--body-file/);
});

test(`${proof}: fake worker metadata is validated before CI, with head named on escalation`, async (t) => {
  const cases = [
    { name: "wrong head", head: "prereq-instrument-1791173256741", body, expected: /head.*prereq-instrument/ },
    { name: "missing acceptance", body: "opened the split", expected: /no `## Acceptance`/ },
    { name: "empty proofs", body: "## Acceptance\n- instrument works", expected: /no proof/ },
    { name: "wrapped claim", body: "## Acceptance\n- instrument\n  works | unit test: standalone", expected: /no proof/ },
    { name: "metadata read fails", body, readError: "metadata unavailable", expected: /metadata unavailable/ },
    { name: "real metadata reader refuses missing acceptance", body: "opened the split", realReader: true, expected: /no `## Acceptance`/ },
    { name: "valid prerequisite", body },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "rmd-prerequisite-head-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const lines: Array<{ step: string } & Record<string, unknown>> = [];
      const issues: string[] = [];
      const calls: string[] = [];
      let minted = "";
      const shim = scenario.realReader ? ghShim() : undefined;
      if (shim) {
        const oldPath = process.env.PATH;
        process.env.PATH = `${shim.dir}:${oldPath}`;
        t.after(() => {
          if (oldPath === undefined) delete process.env.PATH;
          else process.env.PATH = oldPath;
          rmSync(shim.dir, { recursive: true, force: true });
        });
      }
      const outcome = await runFixRung({
        taskId: "W1-T5779", runId: "W1-T5779-test", task: { id: "W1-T5779", title: "split" },
        prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T5779-1",
        worktreePath: dir, settingsFile: join(dir, "settings.json"), config: {} as Config,
        mount,
        budgetUsd: 1, strikeCap: 2, initialReview: review,
        initialSessionId: "split",
        reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: dir, reviewerMount: mount },
        escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
        deps: {
          spawn: async (args) => {
            calls.push("spawn");
            minted = args.prompt.match(/run-unfiled-\d+/)?.[0] ?? "";
            shim?.addRoute({ when: "--json headRefName,body", stdout: JSON.stringify({ headRefName: minted, body: scenario.body }) });
            return worker;
          },
          readPrerequisitePr: async (url) => {
            calls.push("metadata");
            assert.equal(url, prerequisiteUrl);
            if (shim) return runner.fetchPrerequisitePrViaGh(url);
            if (scenario.readError) throw new Error(scenario.readError);
            return { headRefName: scenario.head ?? minted, body: scenario.body };
          },
          waitForCiGreen: async (url) => {
            calls.push("ci");
            assert.equal(url, prerequisiteUrl);
            return "green";
          },
          readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }),
          runReview: async () => { throw new Error("must not review the entangled PR"); },
          push: () => { throw new Error("must not push the original branch"); },
          issues: { create: (_title, issueBody) => { issues.push(issueBody); return "https://github.com/acme/remudero/issues/99"; } },
          ledgerPath: join(dir, "ledger.ndjson"), ledgerLines: () => [],
          log: (step, fields) => lines.push({ step, ...fields }), say: () => {}, account: (result) => result,
        },
      });
      assert.match(minted, /^run-unfiled-\d+$/);
      assert.equal(outcome.strikes, 0);
      if (shim) assert.deepEqual(shim.calls(), [`pr view ${prerequisiteUrl} --json headRefName,body`]);
      if (scenario.expected) {
        assert.equal(outcome.outcome, "escalated");
        assert.deepEqual(calls, ["spawn", "metadata"]);
        const failure = lines.find((line) => line.step === "fix.prerequisite_dispatch_failed");
        assert.ok(failure);
        assert.equal(failure.prerequisite_branch, minted);
        assert.match(String(failure.reason), scenario.expected);
        assert.equal(issues.length, 1);
        assert.ok(issues[0].includes(minted));
        assert.match(issues[0], scenario.expected);
        assert.ok(!lines.some((line) => line.step === "fix.prerequisite_opened"));
      } else {
        assert.equal(acceptanceAuthorTimeCheck(scenario.body).ok, true);
        assert.equal(outcome.outcome, "parked");
        assert.deepEqual(calls, ["spawn", "metadata", "ci"]);
        assert.equal(issues.length, 0);
        assert.ok(lines.some((line) => line.step === "fix.prerequisite_opened"));
      }
    });
  }
});
