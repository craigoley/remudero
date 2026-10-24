import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLedger } from '#src/lib/ledger.js';
import { claimReviewDecision, reviewContractDigest, reviewDecisionDigest, reviewInputDigest,
  type ReviewState, type ReviewVerdict } from '#src/lib/review.js';

// Either independently changed parent engine is still too old for the combined contract.
// An unrelated engine bump must not make this proof pass on the unchanged base.
const priorEngines = ['promised-followups-snapshot-v3', 'promised-followups-named-execution-v4',
  'explained-semantic-failures-v1'] as const;
const taskId = 'PR-7';
const prUrl = 'https://github.com/example/fixture/pull/7';
const head = 'a'.repeat(40);
const acceptance = [{ claim: 'the named safety assertion executes', proof: 'unit test: fixture safety assertion executes' }];
const body = '## Acceptance\n- the named safety assertion executes | unit test: fixture safety assertion executes\n';
const material = { headSha: head, diff: '+test.skip("fixture safety assertion executes", () => {});\n',
  report: body, body, acceptance, declaredFiles: ['test/fixture.test.ts'] };
const terminal = (state: ReviewState): ReviewVerdict => ({ state, criteria: [], testTheater: false,
  summary: 'isolated prior-engine fixture', floorDegraded: false, capped: false, keywordOnly: false, planOnly: false });

test('named proof execution semantics cannot replay an old exact-head terminal or cross-base contract', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rmd-named-proof-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const currentDecision = reviewDecisionDigest(material);
  for (const priorEngine of priorEngines) {
    const priorDecision = reviewDecisionDigest({ ...material, engineRevision: priorEngine });
    for (const state of ['success', 'failure'] as const) {
      const ledgerPath = join(root, priorEngine, state, 'ledger.ndjson');
      appendLedger(ledgerPath, { run_id: 'prior', task_id: taskId, step: 'review.posted', pr_url: prUrl,
        head_sha: head, state, review_decision_digest: priorDecision, decision_verdict: terminal(state) });
      const before = readFileSync(ledgerPath);
      const prior = await claimReviewDecision({ ledgerPath, taskId, prUrl, digest: priorDecision });
      assert.equal(prior.kind, 'replay', 'positive control: the actual old decision is retained and readable');
      if (prior.kind === 'replay') assert.equal(prior.terminal.state, state);
      const current = await claimReviewDecision({ ledgerPath, taskId, prUrl, digest: currentDecision });
      try {
        assert.equal(current.kind, 'owned', 'changed proof semantics must execute before an old terminal can be accepted');
      } finally {
        if (current.kind === 'owned') current.release();
      }
      assert.deepEqual(readFileSync(ledgerPath), before, 'rejudging never rewrites the old terminal evidence');
      // A completed decision under the new rules remains final; a revision is not an unlimited retry.
      appendLedger(ledgerPath, { run_id: 'current', task_id: taskId, step: 'review.posted', pr_url: prUrl,
        head_sha: head, state, review_decision_digest: currentDecision, decision_verdict: terminal(state) });
      const completed = await claimReviewDecision({ ledgerPath, taskId, prUrl, digest: currentDecision });
      assert.equal(completed.kind, 'replay');
      if (completed.kind === 'replay') assert.equal(completed.terminal.state, state);
    }
    assert.notEqual(reviewInputDigest(head, body), reviewInputDigest(head, body, priorEngine),
      'sweep admission must not suppress the new semantic contract');
    assert.notEqual(reviewContractDigest({ taskId, acceptance }),
      reviewContractDigest({ taskId, acceptance, engineRevision: priorEngine }),
      'a cross-base reuse certificate cannot carry skipped proof evidence across the contract change');
  }
  assert.equal(reviewDecisionDigest({ ...material, provider: 'other', model: 'other',
    comments: ['later'], unrelatedMainSha: 'b'.repeat(40) } as never), currentDecision,
    'operational, model and unrelated-main churn do not create new decisions');
});
