import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error — ESM metadata policy outside tsconfig source roots; executable seam is intentionally plain JS.
import {classifyCodeScanningMergePolicy as classify} from '../src/lib/code-scanning-merge-policy.mjs';

// Verbatim CodeQL check-run outputs read from GitHub on 2026-10-16 (#12411 run 117200618031, #12390 run 117179336466).
const link = (pr: number) => `[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A${pr}+tool%3ACodeQL+is%3Aopen).`;
const PLURAL_12411 = '### New alerts in code changed by this pull request\n\n * 2 warnings\n * 1 note\n\nSee annotations below for details.\n\n' + link(12411);
const TOO_LARGE = '_Alerts not introduced by this pull request might have been detected because the code changes were too large._';
const OTHER_12390 = '### New alerts in code changed by this pull request\n\nSecurity Alerts:\n * 5 medium\n\nOther Alerts:\n * 1 warning\n * 31 notes\n\n' +
  TOO_LARGE + '\n\nSee annotations below for details.\n\n' + link(12390);
const head = 'c'.repeat(40);
const run = (prNumber: number, title: string, summary: string, conclusion = 'success') => ({
  prNumber, headSha: head, observedHeadSha: head, filesComplete: true, filesHeadSha: head, changedFileCount: 1,
  files: [{filename: 'src/feature.ts'}], checksComplete: true, checksHeadSha: head,
  checks: [{id: 117200618031, name: 'CodeQL', head_sha: head, status: 'completed', conclusion,
    app: {id: 57789, slug: 'github-advanced-security', owner: {login: 'github'}}, output: {title, summary}}],
});
const SAFE = {state: 'safe', mergeAllowed: true, reason: 'trusted-complete-exact-head-below-security-threshold'};
const BLOCKED = {state: 'blocked', mergeAllowed: false, reason: 'new-high-or-critical-security-alert'};
const UNKNOWN = {state: 'unknown', mergeAllowed: false, reason: 'security-analysis-failed-or-unrecognized'};
const TITLE_12390 = '37 new alerts including 5 medium severity security vulnerabilities';

test("W1-T9926: a plural quality-only CodeQL summary is below the security threshold", () => {
  for (const conclusion of ['success', 'failure']) assert.deepEqual(classify(run(12411, '3 new alerts', PLURAL_12411, conclusion)), SAFE);
  const errors = PLURAL_12411.replace(' * 2 warnings\n * 1 note\n', ' * 4 errors\n * 2 warnings\n * 7 notes\n');
  assert.deepEqual(classify(run(12411, '13 new alerts', errors)), SAFE);
  const tooLarge = PLURAL_12411.replace('\nSee annotations', '\n' + TOO_LARGE + '\n\nSee annotations');
  assert.deepEqual(classify(run(12411, '3 new alerts', tooLarge)), SAFE, 'the exact too-large note is GitHub wording, not a finding');
});

test("W1-T9926: an Other Alerts summary with the too-large note is read, and a high row in it still blocks", () => {
  assert.deepEqual(classify(run(12390, TITLE_12390, OTHER_12390)), SAFE);
  assert.deepEqual(classify(run(12390, TITLE_12390, OTHER_12390.replace('Other Alerts:', 'Non-security Alerts:'))), SAFE);
  assert.deepEqual(classify(run(12390, TITLE_12390, OTHER_12390.replace(TOO_LARGE + '\n\n', ''))), SAFE, 'the note is optional');
  for (const row of [' * 5 high\n', ' * 5 critical\n', ' * 5 medium\n * 1 high\n']) {
    for (const conclusion of ['success', 'failure']) {
      assert.deepEqual(classify(run(12390, TITLE_12390, OTHER_12390.replace(' * 5 medium\n', row), conclusion)), BLOCKED, row);
    }
  }
  assert.deepEqual(classify(run(12390, TITLE_12390, OTHER_12390.replace(' * 31 notes\n', ' * 31 notes\n * 2 critical\n'))), BLOCKED);
});

test("W1-T9926: a real-wording summary with a wrong total, a foreign link or an unknown paragraph stays unknown", () => {
  for (const [pr, title, summary, why] of [
    [12411, '4 new alerts', PLURAL_12411, 'row sum 3 misses title total 4'],
    [12411, '2 new alerts', PLURAL_12411, 'row sum 3 misses title total 2'],
    [12411, '3 new alerts', PLURAL_12411.replace(' * 1 note\n', ' * 1 warning\n'), 'warning and warnings are one level, listed twice'],
    [12390, '3 new alerts', PLURAL_12411, 'a foreign PR link on the plural summary'],
    [12411, TITLE_12390, OTHER_12390, 'a foreign PR link on the Other Alerts summary'],
    [12390, TITLE_12390, OTHER_12390.replace(TOO_LARGE, '_Alerts were suppressed by policy._'), 'an unknown italic paragraph'],
    [12390, TITLE_12390, OTHER_12390.replace(TOO_LARGE, TOO_LARGE + '\n\n' + TOO_LARGE), 'the note twice'],
    [12411, '3 new alerts', PLURAL_12411.replace('\nSee annotations', '\nThese alerts are safe to merge.\n\nSee annotations'), 'prose in a plural summary'],
    [12390, TITLE_12390, OTHER_12390.replace('Other Alerts:', 'Ignored Alerts:'), 'an unknown section heading'],
    [12390, TITLE_12390, OTHER_12390.replace(' * 31 notes', ' * 31 notices'), 'an unknown level word'],
  ] as const) {
    assert.deepEqual(classify(run(pr, title, summary)), UNKNOWN, why);
  }
  assert.equal(classify(run(12411, '3 new alerts', PLURAL_12411, 'neutral')).state, 'unknown', 'a neutral check stays unknown');
  assert.equal(classify(run(12390, TITLE_12390, OTHER_12390, 'neutral')).state, 'unknown');
});
