import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { createInstallationBudget } from "#src/lib/github-installation-budget.js";
import { configureGithubInstallationBudget } from "#src/lib/github-transport.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { buildEscalationReconcileCandidatesAsync } from "#src/lib/tick-read-worker.js";
import { withGhShim } from "#test/helpers/gh-shim.js";

const symptom = "sweep.escalation_reconcile.list_failed";
const issue = { number: 17, url: "https://github.com/o/r/issues/17", body: "**Task:** PR-42\n" };
const graphqlList = JSON.stringify({ data: {
  repository: { issues: { nodes: [issue], pageInfo: { hasNextPage: false } } },
} });

function fixture(t: TestContext, remaining: number) {
  const now = Date.parse("2026-11-18T03:00:00Z");
  const budget = createInstallationBudget({ consumers: 4, clock: fixedClock(now), maxWaitMs: 0 });
  budget.record({ resource: "core", remaining, limit: 15_000, reset: now / 1000 + 3_600 });
  configureGithubInstallationBudget(budget);
  const dir = mkdtempSync(join(tmpdir(), "rmd-scout-escalation-list-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  t.after(() => {
    configureGithubInstallationBudget(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    run: () => buildEscalationReconcileCandidatesAsync("o", "r", { tasks: [], byId: new Map() }, ledgerPath,
      (step, extra) => appendLedger(ledgerPath, { run_id: "SWEEP", task_id: "SWEEP", step, ...extra }), {
        evidenceRootFor: () => undefined,
        github: {
          prByRef: () => ({ number: 42, url: "https://github.com/o/r/pull/42", state: "MERGED" }),
          findMergedByTrailer: () => null,
          headRefName: () => undefined,
          prBody: () => undefined,
        },
      }),
    failures: () => readLedgerLines(ledgerPath).filter((row) => row.step === symptom),
  };
}

test("W1-T13101: sweep.escalation_reconcile.list_failed no longer recurs", async (t) => {
  const { run, failures } = fixture(t, 1_496);
  await withGhShim([{ when: "api graphql", stdout: graphqlList }], async (shim) => {
    const candidates = await run();
    assert.deepEqual(candidates.map((c) => [c.issueUrl, c.derived.merged]), [[issue.url, true]]);
    const calls = shim.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.startsWith("api graphql ")));
    assert.ok(calls[0]?.includes("label=needs-human"));
    assert.ok(calls[1]?.includes("label=fleet-notice"));
    assert.deepEqual(failures(), []);
  });
});

test("W1-T13101: the symptom is still recorded when its failure occurs", async (t) => {
  const { run, failures } = fixture(t, 0);
  await withGhShim([
    { when: "label=needs-human", stdout: graphqlList },
    { when: "label=fleet-notice", stderr: "HTTP 502 listing fleet notices", exit: 1 },
  ], async () => {
    assert.deepEqual(await run(), [], "a partial queue cannot produce candidates");
    const rows = failures();
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]?.error), /HTTP 502 listing fleet notices/);
  });
});

test("a non-quota REST failure stays visible and does not invoke GraphQL", async (t) => {
  const { run, failures } = fixture(t, 10_000);
  await withGhShim([{ when: "issues?labels=", stderr: "HTTP 404 listing issues", exit: 1 }], async (shim) => {
    assert.deepEqual(await run(), []);
    assert.equal(shim.calls().length, 1);
    assert.match(String(failures()[0]?.error), /HTTP 404 listing issues/);
  });
});
