import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { deriveDisposition } from "#src/lib/sweep.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const at = (time: string) => `2026-11-15T${time}Z`;
const OWNER = "craigoley";
const REPO = "remudero";
const TASK = "W1-T12231";
const HEAD = "5dd7beb159b058bed83a073245d23410b2d002ba";
const URL = `https://github.com/${OWNER}/${REPO}/pull/18701`;
const BODY = `Remudero-Task: ${TASK}`;
const FIRST_RUN = "review-PR18701-1794763916618";
const NEXT_RUN = "review-PR18701-1794765888095";
const LATER_RUN = "DAEMON-1794765309676-6";

// GitHub's status history for this head. The timestamps of the pending ledger rows below are fixture inputs.
const status = (id: number, state: "pending" | "failure", time: string, description = "") =>
  ({ context: "remudero-review", id, state, created_at: at(time), description });
const firstPending = status(58970413455, "pending", "17:32:24", `remudero-review: review in progress (owned by run ${FIRST_RUN})`);
const nextPending = status(58971542433, "pending", "18:04:58", `pending (owned by run ${NEXT_RUN}) — took over run ${FIRST_RUN}: owner proven dead`);
const firstFailure = status(58971613707, "failure", "18:06:55");
const lastFailure = status(58971926278, "failure", "18:15:41");
const laterPending = status(58973905507, "pending", "19:11:22", `remudero-review: review in progress (owned by run ${LATER_RUN})`);
const history = [laterPending, lastFailure, status(58971882573, "failure", "18:14:31"), firstFailure, nextPending, firstPending];
const passes = [
  { at: at("18:14:25"), latest: firstFailure },
  { at: at("18:16:34"), latest: lastFailure },
  { at: at("18:27:56"), latest: lastFailure },
];

function row(step: string, ts: string, run_id: string, fields: Record<string, unknown> = {}) {
  return { step, ts, run_id, task_id: TASK, pr_url: URL, head_sha: HEAD, ...fields };
}

const firstPendingRow = row("review.pending_posted", firstPending.created_at, FIRST_RUN);
// The refusal time is captured in test/fixtures/review-replay/sample.ndjson. The task records the delivered failure.
const refusal = row("review.post_refused", at("17:36:36.366"), FIRST_RUN, { reviewer_code_freshness: "stale" });
const nextPendingRow = row("review.pending_posted", nextPending.created_at, NEXT_RUN);
const delivered = row("review.posted", at("18:06:56"), NEXT_RUN, { state: "failure" });

async function replay(t: TestContext, rows: Record<string, unknown>[]) {
  const ledger = writeLedger([], { scope: t });
  const pr = {
    number: 18701, html_url: URL, body: BODY, updated_at: firstPending.created_at,
    head: { ref: `run-${TASK}-1794763916618`, sha: HEAD },
  };
  const base = `repos/${OWNER}/${REPO}`;
  const commit = `${base}/commits/${HEAD}`;
  const pull = `${base}/pulls/${pr.number}`;
  const readView = async (observedAt: string, combinedReadAt = observedAt) => {
    const [view] = await buildOpenPrViewsAsync(OWNER, REPO, ledger.path, {
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => [],
      readMainPlan: () => ({ tasks: [], byId: new Map() }),
      assessPendingOwner: () => "active",
      fetchAsync: async ([, path]) => {
        switch (path) {
          case `${base}/pulls?state=open&per_page=100`: return [pr];
          case `${commit}/check-runs?per_page=100`:
            return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
          case `${commit}/status`: {
            const latest = history.find((entry) => Date.parse(entry.created_at) <= Date.parse(combinedReadAt));
            return { statuses: latest ? [latest] : [] };
          }
          case `${commit}/statuses?per_page=100`:
            return history.filter((entry) => Date.parse(entry.created_at) <= Date.parse(observedAt));
          case `${pull}/files?per_page=100`: return [{ filename: "src/run-task.ts" }];
          case pull: return { ...pr, mergeable: true, mergeable_state: "clean" };
          default: return [];
        }
      },
    });
    assert.equal(view?.headSha, HEAD);
    return view;
  };
  const beforePosts = await readView(at("17:32:23"));
  const digest = beforePosts.reviewInputDigest;
  assert.ok(digest);
  const append = (entries: Record<string, unknown>[]) => {
    ledger.append(entries.map((entry) => ({ ...entry, review_input_digest: digest })));
  };
  append(rows);
  return { readView, append, beforePosts };
}

test("W1-T13148 criterion 1: a stale rollup and a missing pending row reproduce the old view across three passes", async (t) => {
  const complete = await replay(t, [firstPendingRow, refusal, nextPendingRow, delivered]);
  const missingPending = await replay(t, [firstPendingRow, refusal, delivered]);

  for (const pass of passes) {
    const stale = await complete.readView(pass.at, nextPending.created_at);
    assert.equal(stale.reviewState, "pending", pass.at);
    assert.equal(stale.reviewVerdictPostedAt, nextPending.created_at, pass.at);
    assert.equal(stale.reviewPendingStatusConflict, true, pass.at);
    assert.equal(stale.reviewPendingSince, nextPendingRow.ts, pass.at);
    assert.equal(stale.reviewPostRefused, true, pass.at);

    const datedFromOldRow = await missingPending.readView(pass.at, nextPending.created_at);
    assert.equal(datedFromOldRow.reviewState, "pending", pass.at);
    assert.equal(datedFromOldRow.reviewVerdictPostedAt, nextPending.created_at, pass.at);
    assert.equal(datedFromOldRow.reviewPendingSince, firstPendingRow.ts, pass.at);
  }
  assert.ok(Date.parse(firstPendingRow.ts) <= Date.parse(refusal.ts));
  assert.ok(Date.parse(nextPendingRow.ts) > Date.parse(refusal.ts));

  // A second refusal could change which pending stamp it follows. It supplies neither view field.
  const comparison = passes[0].at;
  complete.append([row("review.post_refused", at("18:10:00"), NEXT_RUN, { reviewer_code_freshness: "stale" })]);
  const withLaterRefusal = await complete.readView(comparison, nextPending.created_at);
  assert.equal(withLaterRefusal.reviewState, "pending");
  assert.equal(withLaterRefusal.reviewPendingSince, nextPendingRow.ts);
});

test("W1-T13148 criterion 2: a fresh terminal rollup reads failure even if the pending row is missing", async (t) => {
  const complete = await replay(t, [firstPendingRow, refusal, nextPendingRow, delivered]);
  const missingPending = await replay(t, [firstPendingRow, refusal, delivered]);

  for (const pass of passes) {
    for (const fixture of [complete, missingPending]) {
      const view = await fixture.readView(pass.at);
      assert.equal(view.reviewState, "failure", pass.at);
      assert.equal(view.reviewVerdictPostedAt, pass.latest.created_at, pass.at);
      assert.equal(view.reviewPendingSince, undefined, pass.at);
    }
  }
});

test("W1-T13148 criterion 3: a live pending status keeps its own time and a head without a status reads none", async (t) => {
  const liveRow = row("review.pending_posted", laterPending.created_at, LATER_RUN);
  const fixture = await replay(t, [firstPendingRow, refusal, nextPendingRow, delivered, liveRow]);
  const now = at("19:11:24");
  const live = await fixture.readView(now);
  assert.equal(live.reviewState, "pending");
  assert.equal(live.reviewPendingSince, laterPending.created_at);
  assert.equal(live.reviewPendingOwnerRunId, LATER_RUN);
  assert.equal(live.reviewPendingStatusRunId, LATER_RUN);
  assert.equal(deriveDisposition(live, undefined, Date.parse(now)).disposition, "wait");

  assert.equal(fixture.beforePosts.reviewState, "none");
  assert.equal(fixture.beforePosts.reviewPendingSince, undefined);
});
