import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error — ESM metadata policy outside tsconfig source roots; executable seam is intentionally plain JS.
import {classifyCodeScanningMergePolicy as classify} from '#src/lib/code-scanning-merge-policy.mjs';

// Verbatim CodeQL check-run output read from GitHub on 2026-11-21 (#19651 check run 136855694129). The same PR read
// "below threshold" at an earlier head whose summary lacked the too-large note.
const link = (pr: number) => `[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A${pr}+tool%3ACodeQL+is%3Aopen).`;
const TOO_LARGE = '_Alerts not introduced by this pull request might have been detected because the code changes were too large._';
const SECURITY_ONLY_19651 = '### New alerts in code changed by this pull request\n\nSecurity Alerts:\n * 2 medium\n\n\n' +
  TOO_LARGE + '\n\nSee annotations below for details.\n\n' + link(19651);
const TITLE_19651 = '2 new alerts including 2 medium severity security vulnerabilities';
const head = 'c'.repeat(40);
const run = (prNumber: number, title: string, summary: string, conclusion = 'success') => ({
  prNumber, headSha: head, observedHeadSha: head, filesComplete: true, filesHeadSha: head, changedFileCount: 1,
  files: [{filename: 'src/feature.ts'}], checksComplete: true, checksHeadSha: head,
  checks: [{id: 136855694129, name: 'CodeQL', head_sha: head, status: 'completed', conclusion,
    app: {id: 57789, slug: 'github-advanced-security', owner: {login: 'github'}}, output: {title, summary}}],
});
const SAFE = {state: 'safe', mergeAllowed: true, reason: 'trusted-complete-exact-head-below-security-threshold'};
const UNKNOWN = {state: 'unknown', mergeAllowed: false, reason: 'security-analysis-failed-or-unrecognized'};

test("W1-T14165 criterion 1: a security-only summary with the too-large note is below the security threshold", () => {
  assert.deepEqual(classify(run(19651, TITLE_19651, SECURITY_ONLY_19651)), SAFE);
  assert.deepEqual(classify(run(19651, TITLE_19651, SECURITY_ONLY_19651.replace(TOO_LARGE + '\n\n', ''))), SAFE, 'without the note, as at the earlier head');
});

test("W1-T14165 criterion 2: the same shape with a high row, a mismatched title, or a doubled note still grants nothing", () => {
  for (const row of [' * 2 high\n', ' * 2 critical\n', ' * 2 medium\n * 1 high\n']) {
    assert.notDeepEqual(classify(run(19651, TITLE_19651, SECURITY_ONLY_19651.replace(' * 2 medium\n', row))), SAFE, row);
  }
  assert.deepEqual(classify(run(19651, '3 new alerts including 2 medium severity security vulnerabilities', SECURITY_ONLY_19651)), UNKNOWN, 'title count disagrees');
  assert.deepEqual(classify(run(19651, TITLE_19651, SECURITY_ONLY_19651.replace(TOO_LARGE, TOO_LARGE + '\n\n' + TOO_LARGE))), UNKNOWN, 'the note twice');
  assert.deepEqual(classify(run(19651, TITLE_19651, SECURITY_ONLY_19651.replace('\n\n\n' + TOO_LARGE, '\n\n\n\n' + TOO_LARGE))), UNKNOWN, 'an extra blank line');
  assert.deepEqual(classify(run(19651, TITLE_19651, SECURITY_ONLY_19651.replace(TOO_LARGE, '_Alerts were suppressed by policy._'))), UNKNOWN, 'an unknown paragraph');
  // The extra blank line is accepted only when Security Alerts is the sole section: after an Other or Non-security
  // Alerts section, with or without a Security Alerts section before it, the base read it as unknown and still does.
  const otherOnly = (heading: string) => '### New alerts in code changed by this pull request\n\n' + heading + ' Alerts:\n * 2 warnings\n\n\n' +
    TOO_LARGE + '\n\nSee annotations below for details.\n\n' + link(19651);
  for (const heading of ['Other', 'Non-security']) {
    assert.deepEqual(classify(run(19651, '2 new alerts', otherOnly(heading))), UNKNOWN, `${heading} Alerts only, extra blank line`);
    const both = SECURITY_ONLY_19651.replace(' * 2 medium\n\n\n', ' * 2 medium\n\n' + heading + ' Alerts:\n * 2 warnings\n\n\n');
    assert.deepEqual(classify(run(19651, '4 new alerts including 2 medium severity security vulnerabilities', both)), UNKNOWN, `Security and ${heading} Alerts, extra blank line`);
  }
});
