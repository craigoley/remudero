/** Shared runtime exact-head metadata policy. No API writes, dispatch, source execution or notification.
 * UNKNOWN is never a reusable merge permission. Production adapter must re-read HEAD
 * immediately before its write and attest complete file/check pagination from trusted APIs. */
export const CODE_SCANNING_MERGE_POLICY = 'exact-head-new-high-critical-v1';
export const CODE_SCANNING_MAX_CHANGED_FILES = 3000; // BACKSTOP: larger diffs need explicit complete evidence, not a truncated green.
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const path = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
  !value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value) && !value.split('/').some(part => part === '' || part === '.' || part === '..');
// Matches the existing CodeQL workflow's ignored surface; rename predecessors are checked too.
const ignored = value => value.endsWith('.md') || ['plan/', 'docs/', 'learnings/'].some(prefix => value.startsWith(prefix));
const unknown = reason => ({state:'unknown',mergeAllowed:false,reason});
// GitHub's real wording: a plural level above 1, 'Other Alerts:', and one exact optional 'too large' paragraph.
const HEAD = String.raw`^### New alerts in code changed by this pull request\n\n`, QUALITY_ROW = String.raw` \* [1-9][0-9]* (?:error|warning|note)s?\n`;
const TOO_LARGE = String.raw`_Alerts not introduced by this pull request might have been detected because the code changes were too large\._\n\n`;
const TAIL = String.raw`See annotations below for details\.\n\n(\[View all branch alerts\].*)$`;
const QUALITY_ONLY = new RegExp(String.raw`${HEAD}((?:${QUALITY_ROW})+)\n(?:${TOO_LARGE})?${TAIL}`);
const SECTIONED = new RegExp(String.raw`${HEAD}(?:(Security Alerts:\n(?: \* [1-9][0-9]* (?:low|medium)\n)+)\n)?(?:((?:Other|Non-security) Alerts:\n(?:${QUALITY_ROW})+)\n)?(?:\n|${TOO_LARGE})?${TAIL}`);

function completeBelowThresholdSections(sections, title) {
  const declared = /^([1-9][0-9]*) new alerts?(?: including ([1-9][0-9]*) (low|medium) severity security vulnerabilit(?:y|ies))?$/.exec(title ?? '');
  if (!declared || !Number.isSafeInteger(Number(declared[1]))) return false;
  const levels = new Map(); let total = 0;
  for (const row of [sections[1] ?? '', sections[2] ?? ''].join('\n').matchAll(/^ \* ([1-9][0-9]*) (low|medium|error|warning|note)(s?)$/gm)) {
    const count = Number(row[1]);
    if (!Number.isSafeInteger(count) || levels.has(row[2]) || (row[3] === 's' && count === 1)) return false;
    levels.set(row[2], count); total += count;
  }
  if (!Number.isSafeInteger(total) || total !== Number(declared[1])) return false;
  return declared[2] === undefined || (Number.isSafeInteger(Number(declared[2])) && levels.get(declared[3]) === Number(declared[2]));
}

export function classifyCodeScanningMergePolicy(input) {
  if (!input || !sha(input.headSha) || input.observedHeadSha !== input.headSha) return unknown('head-unavailable-or-changed');
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) return unknown('pr-identity-unavailable');
  if (input.filesComplete !== true || input.filesHeadSha !== input.headSha || !Number.isSafeInteger(input.changedFileCount) ||
      !Array.isArray(input.files) || input.files.length !== input.changedFileCount || input.files.length > CODE_SCANNING_MAX_CHANGED_FILES) {
    return unknown('changed-file-corpus-incomplete');
  }
  if (input.files.some(file => !file || !path(file.filename) ||
      (file.previous_filename !== undefined && !path(file.previous_filename)))) return unknown('changed-file-path-ambiguous');
  const relevant = input.files.some(file => !ignored(file.filename) ||
    (file.previous_filename !== undefined && !ignored(file.previous_filename)));
  if (!relevant) return {state:'not-applicable',mergeAllowed:true,reason:'complete-verified-out-of-codeql-scope'};
  if (input.checksComplete !== true || input.checksHeadSha !== input.headSha || !Array.isArray(input.checks)) return unknown('check-corpus-incomplete');
  const checks = input.checks.filter(check => check?.name === 'CodeQL' && check.head_sha === input.headSha &&
    check.app?.slug === 'github-advanced-security' && check.app?.id === 57789 && check.app?.owner?.login === 'github');
  if (checks.length === 0) return unknown('trusted-exact-head-codeql-result-missing');
  if (checks.some(check => !Number.isSafeInteger(check.id) || check.id <= 0)) return unknown('check-generation-unavailable');
  if (new Set(checks.map(check => check.id)).size !== checks.length) return unknown('check-generation-ambiguous');
  const latest = checks.reduce((a,b) => a.id > b.id ? a : b);
  if (latest.status !== 'completed') return unknown('security-analysis-pending');
  const summary = latest.output?.summary;
  if (typeof summary !== 'string') return unknown('security-result-shape-unavailable');
  const counts = [...summary.matchAll(/^\s*\* (\d+) (high|critical)\s*$/gm)];
  if (counts.some(match => Number(match[1]) > 0)) return {state:'blocked',mergeAllowed:false,reason:'new-high-or-critical-security-alert'};
  // Actual GitHub producer stores the no-new-alert statement in TITLE, not SUMMARY.
  // The summary must bind that canonical statement to this PR, not another PR at the same SHA.
  const link = `[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A${input.prNumber}+tool%3ACodeQL+is%3Aopen).`;
  if (latest.conclusion === 'success' && latest.output.title === 'No new alerts in code changed by this pull request' && summary === link) {
    return {state:'safe',mergeAllowed:true,reason:'trusted-complete-exact-head-no-new-alerts'};
  }
  // GitHub omits the section heading for quality-only findings. Bind the exact layout,
  // PR link and total to the trusted check rather than treating any successful prose as safe.
  const qualityOnly = summary.match(QUALITY_ONLY);
  const total = /^([1-9][0-9]*) new alerts?$/.exec(latest.output.title ?? '')?.[1];
  if (['success','failure'].includes(latest.conclusion) && qualityOnly?.[2] === link && total !== undefined) {
    const rows = [...qualityOnly[1].matchAll(/ \* ([1-9][0-9]*) (error|warning|note)(s?)\n/g)];
    if (Number.isSafeInteger(Number(total)) && rows.every(row => Number.isSafeInteger(Number(row[1])) && (row[3] !== 's' || Number(row[1]) > 1)) &&
        new Set(rows.map(row => row[2])).size === rows.length &&
        rows.reduce((sum,row) => sum + Number(row[1]),0) === Number(total)) {
      return {state:'safe',mergeAllowed:true,reason:'trusted-complete-exact-head-below-security-threshold'};
    }
  }
  // Security policy is not a quality ratchet: positively enumerated low/medium or
  // quality-only findings do not become an unbounded hold. Unknown formats stay UNKNOWN.
  const sections = summary.match(SECTIONED);
  if (['success','failure'].includes(latest.conclusion) && sections && (sections[1] || sections[2]) && sections[3] === link &&
      completeBelowThresholdSections(sections, latest.output.title)) {
    return {state:'safe',mergeAllowed:true,reason:'trusted-complete-exact-head-below-security-threshold'};
  }
  return unknown('security-analysis-failed-or-unrecognized');
}
