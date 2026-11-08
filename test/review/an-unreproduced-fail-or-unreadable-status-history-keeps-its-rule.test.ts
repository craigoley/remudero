import assert from "node:assert/strict";
import { test } from "node:test";
import * as review from "#src/lib/review.js";
import * as reviewCommand from "#src/cli/commands/review.js";
import { rmSync } from "node:fs";
import { ghShim } from "#test/helpers/gh-shim.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const SHA = "90be1a69eaea5510184cf6eec69f7c72afd13c39";
const computed = {
  state: "success", summary: "PASS", criteria: [{ claim: "claim", proof: "unit test: proof", met: true,
    floorMet: true, reason: "proof passed", proof_exec: "executed_pass" }],
  testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

test("W1-T11443 criterion 2: a same-head failure without a reproduction keeps today's PASS behavior", () => {
  assert.equal(typeof review.reproducedReviewFailuresFromHistory, "function");
  assert.equal(typeof review.applyReviewStatusHistoryGuard, "function");
  const failures = review.reproducedReviewFailuresFromHistory(
    [{ context: "remudero-review", state: "failure" }],
    [{ commit_id: SHA, state: "COMMENTED", body: "remudero-review=failure: unable to inspect" }], SHA);
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "readable", failures }, "REVIEW_VERDICT 1: PASS");
  assert.equal(result.kind, "post");
  assert.equal(result.verdict.state, "success");
});

test("W1-T11443 criterion 2: unreadable status history withholds SUCCESS and names the pending reason", () => {
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "unreadable", reason: "GitHub remudero-review status history unreadable: offline" }, "REVIEW_VERDICT 1: PASS");
  assert.equal(result.kind, "pending");
  assert.equal(result.verdict.state, "success");
  assert.match(result.reason, /status history unreadable: offline/);
});

test("W1-T11443 criterion 2: the common publisher fails closed on returned and thrown history outages", async t => {
  for (const failure of ["returned", "thrown"] as const) {
    const ledger = writeLedger([], { scope: t });
    const posted: string[] = [];
    const result = await review.postReviewStatusGuarded({ owner: "acme", repo: "remudero", sha: SHA,
      state: "success", verdict: computed as never, taskId: "W1-T11443", evidence: "executed",
      ledgerPath: ledger.path, runId: failure, prUrl: "https://github.com/acme/remudero/pull/1",
      fetchLifecycle: () => ({ headSha: SHA, closed: false, merged: false }),
      readReviewStatusHistory: async (_owner, _repo, _url, head) => {
        assert.equal(head, SHA);
        if (failure === "thrown") throw new Error("history transport offline");
        return { kind: "unreadable", reason: "history transport offline" };
      },
      post: status => { posted.push(status.state); },
    });
    assert.equal(result.posted, false);
    assert.equal(result.effectiveState, "pending");
    assert.match(result.reason ?? "", /pending:.*history transport offline/);
    assert.deepEqual(posted, [], "the publisher never blindly posts SUCCESS");
  }
});

test("W1-T11443 criterion 2: a failed GitHub history read returns an explicit unreadable reason", async () => {
  const result = await reviewCommand.readReviewStatusHistory(
    "craigoley", "remudero", "https://github.com/craigoley/remudero/pull/16523", SHA,
    async () => { throw new Error("offline"); });
  assert.equal(result.kind, "unreadable");
  assert.match(result.reason, /GitHub remudero-review status history unreadable: offline/);
});

test("W1-T11443 criterion 2: the default reader shells to a contained gh and refuses malformed history", async () => {
  const oldPath = process.env.PATH;
  const shim = ghShim([{ when: "/statuses?", stdout: "[[]]" }], { kind: "review-history-default" });
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const readable = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA);
    assert.deepEqual(readable, { kind: "readable", failures: [] });
    assert.ok(shim.calls().some(call => call.includes(`/commits/${SHA}/statuses?per_page=100`)));
    shim.addRoute({ when: "/statuses?", stdout: "{}" });
    const malformed = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA);
    assert.equal(malformed.kind, "unreadable");
    const invalidPr = await reviewCommand.readReviewStatusHistory("acme", "remudero", "invalid", SHA);
    assert.equal(invalidPr.kind, "unreadable");
    assert.match(invalidPr.kind === "unreadable" ? invalidPr.reason : "", /PR number/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T11443 criterion 2: an unknown status state is unreadable, never an empty failure history", async () => {
  const result = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA,
    async () => [[{ context: "remudero-review", state: "not-a-github-state" }]]);
  assert.equal(result.kind, "unreadable");
});

test("W1-T11443 criterion 2: malformed review rows cannot erase a readable failure status", async () => {
  const result = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA,
    async (args) => args.at(-1)?.includes("/statuses?") ? [[{ context: "remudero-review", state: "failure" }]] : [[{}]]);
  assert.equal(result.kind, "unreadable");
});

test("W1-T11443 criterion 2: shared status and finding reads explicitly revalidate broker history", async () => {
  const options: unknown[] = [];
  const result = await reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA,
    async (args, readOptions) => {
      options.push(readOptions);
      assert.equal(readOptions?.fresh, true, "shared evidence must bypass a previously cached PASS");
      return args.at(-1)?.includes("/statuses?") ? [[{ context: "remudero-review", state: "failure" }]] : [[]];
    });
  assert.equal(result.kind, "readable");
  assert.equal(options.length, 2);
});

test("W1-T11443 criterion 1: shared history identity follows terminal changes and ignores pending bookkeeping", async () => {
  const body = "remudero-review=failure\n1. claim\n   - proof executed: reproduction throws ReferenceError at daemon.ts:4218";
  const statuses = [{ id: 1, context: "remudero-review", state: "failure" }];
  const read = () => reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA,
    async args => args.at(-1)?.includes("/statuses?") ? [statuses] : [[{ commit_id: SHA, body }]]);
  const first = await read();assert.equal(first.kind, "readable");
  assert.equal(typeof first.revision, "string");
  statuses.unshift({ id: 2, context: "remudero-review", state: "success" });
  const changed = await read();assert.equal(changed.kind, "readable");
  assert.notEqual(changed.revision, first.revision);
  statuses.push({ id: 3, context: "remudero-review", state: "pending" });
  const pending = await read();assert.equal(pending.kind, "readable");
  assert.equal(pending.revision, changed.revision);
});

test("W1-T11443 criterion 1: guarded failure publication settles the history identity", async () => {
  const body = "remudero-review=failure\n1. claim\n   - proof executed: reproduction throws ReferenceError at daemon.ts:4218";
  const statuses = [{ id: 1, context: "remudero-review", state: "failure" }];
  const read = () => reviewCommand.readReviewStatusHistory("acme", "remudero", "https://github.com/acme/remudero/pull/1", SHA,
    async args => args.at(-1)?.includes("/statuses?") ? [statuses] : [[{ commit_id: SHA, body }]]);
  const first = await read();assert.equal(first.kind, "readable");
  statuses.unshift({ id: 2, context: "remudero-review", state: "failure" });
  const settled = await read();assert.equal(settled.kind, "readable");
  assert.equal(settled.revision, first.revision, "posting the guarded FAILURE must not invalidate its own decision forever");
  statuses.unshift({ id: 3, context: "remudero-review", state: "success" });
  const contradicted = await read();assert.equal(contradicted.kind, "readable");
  assert.notEqual(contradicted.revision, settled.revision);
  statuses.push({ id: 0, context: "remudero-review", state: "error" });
  const older = await read();assert.equal(older.kind, "readable");
  assert.equal(older.revision, contradicted.revision, "older terminal history is not a fresh competing PASS");
  statuses.unshift({ id: 4, context: "remudero-review", state: "failure" });
  const nextRefusal = await read();assert.equal(nextRefusal.kind, "readable");
  assert.equal(nextRefusal.revision, settled.revision, "another own FAILURE stays on the refusal identity");
  statuses.unshift({ id: 5, context: "remudero-review", state: "success" });
  const nextContradiction = await read();assert.equal(nextContradiction.kind, "readable");
  assert.notEqual(nextContradiction.revision, contradicted.revision, "a PASS after another refusal cannot reuse the earlier contradicted decision");
});
