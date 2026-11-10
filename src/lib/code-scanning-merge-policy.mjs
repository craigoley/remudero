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

/** W1-T10976 — the trusted codeql.yml job `analyze` configuration; NEVER inferred from returned rows. */
export const CODEQL_ANALYSIS_KEY = '.github/workflows/codeql.yml:analyze';
export const CODEQL_EXPECTED_CATEGORIES = Object.freeze(['/language:javascript-typescript', '/language:actions', '/language:python']);
export const MISSING_CONFIGURATION_TITLE = '1 configuration not found';
/** The distinct final dispositions a missing-configuration recovery can end in; the sweep owns these (never a fix round). */
export const CODEQL_RECOVERY_PENDING_REASON = 'codeql-configuration-recovery-pending';
export const CODEQL_RECOVERY_DISPOSITION_REASONS = Object.freeze(['codeql-configuration-recovery-exhausted',
  'codeql-configuration-recovery-invalid-evidence', 'codeql-configuration-recovery-unrecognized-warning']);
/** UNVERIFIED SHAPE: the verbatim trusted GitHub summary has not been captured (no live GitHub in the building run).
 * This strict builder is the ONLY shape that can reconcile; real wording that differs stays UNKNOWN (fail-safe).
 * Replace with the captured fixture before relying on recovery in production. */
export const missingConfigurationSummary = (prNumber, category) =>
  `Code scanning found no analysis of this pull request's merge commit for this configuration:\n\n * \`${CODEQL_ANALYSIS_KEY}${category}\`\n\n` +
  `[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A${prNumber}+tool%3ACodeQL+is%3Aopen).`;
const MISSING_CONFIGURATION_SUMMARY = prNumber => new RegExp(String.raw`^Code scanning found no analysis of this pull request's merge commit for this configuration:\n\n \* \`(${
  CODEQL_ANALYSIS_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(/language:[a-z-]+)\`\n\n\[View all branch alerts\]\(/craigoley/remudero/security/code-scanning\?query=pr%3A${prNumber}\+tool%3ACodeQL\+is%3Aopen\)\.$`);
/** The ONE missing configuration the exact warning names, bound to the expected key and a configured category. */
export function parseMissingConfigurationWarning(check, prNumber) {
  if (check?.status !== 'completed' || check.conclusion !== 'neutral' || check.output?.title !== MISSING_CONFIGURATION_TITLE ||
      typeof check.output.summary !== 'string' || !Number.isSafeInteger(prNumber) || prNumber < 1) return undefined;
  const match = MISSING_CONFIGURATION_SUMMARY(prNumber).exec(check.output.summary);
  return match && CODEQL_EXPECTED_CATEGORIES.includes(match[2]) ? {analysisKey: match[1], category: match[2]} : undefined;
}
/** The newest trusted exact-head CodeQL check, only when it is the one-configuration-missing warning in its strict shape. */
export function isMissingConfigurationCandidate(checks, headSha, prNumber) {
  const trusted = (Array.isArray(checks) ? checks : []).filter(check => check?.name === 'CodeQL' && check.head_sha === headSha &&
    check.app?.slug === 'github-advanced-security' && check.app?.id === 57789 && check.app?.owner?.login === 'github');
  if (trusted.length === 0 || trusted.some(check => !Number.isSafeInteger(check.id) || check.id <= 0) ||
      new Set(trusted.map(check => check.id)).size !== trusted.length) return false;
  return parseMissingConfigurationWarning(trusted.reduce((a, b) => a.id > b.id ? a : b), prNumber) !== undefined;
}
/** Only the shared classifier grants safe: the warning, the adapter's complete same-merge evidence and zero new alerts. */
function classifyMissingConfiguration(latest, input) {
  if (!parseMissingConfigurationWarning(latest, input.prNumber)) return unknown('codeql-configuration-recovery-unrecognized-warning');
  const evidence = input.recovery;
  if (evidence?.state === 'pending') return unknown(CODEQL_RECOVERY_PENDING_REASON);
  if (evidence?.state !== 'complete' || !sha(evidence.mergeSha) || evidence.alertsComplete !== true || !Array.isArray(evidence.newHighCritical) ||
      !Array.isArray(evidence.categories) || evidence.categories.length !== CODEQL_EXPECTED_CATEGORIES.length ||
      !CODEQL_EXPECTED_CATEGORIES.every(category => evidence.categories.includes(category)))
    return unknown('codeql-configuration-recovery-invalid-evidence');
  if (evidence.newHighCritical.length > 0) return {state:'blocked',mergeAllowed:false,reason:'new-high-or-critical-security-alert'};
  return {state:'safe',mergeAllowed:true,reason:'trusted-missing-configuration-reconciled-by-complete-analyses'};
}
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
  if (latest.conclusion === 'neutral' && latest.output?.title === MISSING_CONFIGURATION_TITLE) return classifyMissingConfiguration(latest, input);
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
