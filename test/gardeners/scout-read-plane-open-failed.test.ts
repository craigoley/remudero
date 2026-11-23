import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { createInstallationBudget } from "#src/lib/github-installation-budget.js";
import { configureGithubInstallationBudget, createGhCallPacer } from "#src/lib/github-transport.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { createTickReadProducer } from "#src/lib/tick-read-worker.js";
import { withGhShim } from "#test/helpers/gh-shim.js";

const step = "read_plane.open_failed";
const isGraphqlList = (call: string) => call.startsWith("api graphql ") && call.includes("pullRequests");
const isRestList = (call: string) => call.includes("pulls?state=open");
const timestamp = "2026-11-17T00:00:00Z";
const pr = {
  number: 42, url: "https://github.com/o/r/pull/42", headRefName: "draft-branch", headRefOid: "a".repeat(40),
  createdAt: timestamp, updatedAt: timestamp, body: "", autoMergeRequest: null, isDraft: true,
};

function fixture(t: TestContext, remaining: number) {
  const root = mkdtempSync(join(tmpdir(), "rmd-scout-read-plane-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const now = Date.parse(timestamp);
  const budget = createInstallationBudget({ consumers: 4, clock: fixedClock(now), maxWaitMs: 0 });
  budget.record({ resource: "core", remaining, limit: 15_000, reset: now / 1000 + 3_600 });
  configureGithubInstallationBudget(budget);
  t.after(() => {
    configureGithubInstallationBudget(undefined);
    rmSync(root, { recursive: true, force: true });
  });
  const produce = createTickReadProducer({
    owner: "o", repo: "r", config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root,
  }, {
    pacer: createGhCallPacer({ minGapMs: 0 }),
    commitTrailerIndex: () => null,
    log: (name, extra) => appendLedger(ledgerPath, { run_id: "DAEMON", task_id: "DAEMON", step: name, ...extra }),
    issues: { listOpen: () => [], create: () => assert.fail("unexpected issue write") },
    github: {
      prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined,
    },
    viewsDeps: { requiredContexts: () => [], readCiGateRequired: () => [] },
  });
  return {
    run: () => produce({ plan: { tasks: [], byId: new Map() } }),
    failures: () => readLedgerLines(ledgerPath).filter((row) => row.step === step),
  };
}

test("W1-T13102: read_plane.open_failed no longer recurs", async (t) => {
  const { run, failures } = fixture(t, 1_496);
  const body = JSON.stringify({ data: { repository: { pullRequests: { nodes: [pr] } } } });
  await withGhShim([{ when: "api graphql", stdout: body }], async (shim) => {
    for (let pass = 0; pass < 2; pass++) {
      const facts = await run();
      assert.equal(facts.openPrError, undefined);
      assert.deepEqual(facts.openPrRows, [{ ...pr, rollupUnreadable: true }]);
      assert.deepEqual(facts.openPrViews.map((view) => [view.prNumber, view.rollupUnreadable]), [[42, true]]);
    }
    assert.equal(shim.calls().filter(isGraphqlList).length, 2);
    assert.equal(shim.calls().filter(isRestList).length, 0);
    assert.deepEqual(failures(), []);
  });
});

test("W1-T13102: the symptom is still recorded when its failure occurs", async (t) => {
  const { run, failures } = fixture(t, 0);
  const partial = JSON.stringify({
    data: { repository: { pullRequests: { nodes: [pr] } } },
    errors: [{ message: "upstream GraphQL failure" }],
  });
  await withGhShim([{ when: "api graphql", stdout: partial }], async (shim) => {
    const facts = await run();
    assert.equal(facts.openPrRows, undefined);
    assert.deepEqual(facts.openPrViews, []);
    assert.match(String(facts.openPrError), /core at 0\/15000.*GraphQL open PR list returned errors/);
    assert.deepEqual(failures().map((row) => row.reason), [facts.openPrError]);

    shim.addRoute({ when: "api graphql", stdout: JSON.stringify({
      data: { repository: { pullRequests: { nodes: [{ number: 42 }] } } },
    }) });
    const malformed = await run();
    assert.equal(malformed.openPrRows, undefined);
    assert.match(String(malformed.openPrError), /GraphQL open PR list returned incomplete PR metadata/);
    assert.deepEqual(failures().map((row) => row.reason), [facts.openPrError, malformed.openPrError]);
    assert.equal(shim.calls().filter(isGraphqlList).length, 2);
    assert.equal(shim.calls().filter(isRestList).length, 0);
  });
});

test("a REST list failure unrelated to the core write reserve stays visible", async (t) => {
  const { run, failures } = fixture(t, 10_000);
  await withGhShim([{ when: "pulls?state=open", stderr: "HTTP 404 listing pull requests", exit: 1 }], async (shim) => {
    const facts = await run();
    assert.equal(facts.openPrRows, undefined);
    assert.match(String(facts.openPrError), /HTTP 404 listing pull requests/);
    assert.deepEqual(failures().map((row) => row.reason), [facts.openPrError]);
    assert.equal(shim.calls().filter(isRestList).length, 1);
    assert.equal(shim.calls().filter(isGraphqlList).length, 0);
  });
});
