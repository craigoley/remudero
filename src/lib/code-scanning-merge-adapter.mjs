import {createHash} from "node:crypto";
import {classifyCodeScanningMergePolicy, CODE_SCANNING_MAX_CHANGED_FILES, CODEQL_ANALYSIS_KEY, CODEQL_EXPECTED_CATEGORIES,
  CODEQL_RECOVERY_PENDING_REASON, isMissingConfigurationCandidate} from './code-scanning-merge-policy.mjs';
import {changesSemgrepRuntime, semgrepRuntimeMetadataRequests} from './semgrep-runtime-merge-policy.mjs';

export const SECURITY_MERGE_CONTEXT = 'security-merge-policy';
export const SECURITY_METADATA_MAX_PAGES = 30; // BACKSTOP: complete evidence or UNKNOWN, never partial success.
const unknown = reason => ({state:'unknown',mergeAllowed:false,reason});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Diagnostic receipt only; the classifier remains the sole permission decision. */
function codeqlObservation(headSha, checks, checksComplete) {
  const trusted = checks.filter(check => check?.name === 'CodeQL' && check.head_sha === headSha &&
    check.app?.slug === 'github-advanced-security' && check.app?.id === 57789 && check.app?.owner?.login === 'github');
  const identitiesKnown = trusted.every(check => Number.isSafeInteger(check.id) && check.id > 0) &&
    new Set(trusted.map(check => check.id)).size === trusted.length;
  const latest = identitiesKnown ? trusted.reduce((a, b) => !a || a.id < b.id ? b : a, undefined) : undefined;
  return {checksComplete, checkCount: checks.length, trustedCodeqlCount: trusted.length,
    ...(latest ? {latest: {id: latest.id, status: latest.status ?? null, conclusion: latest.conclusion ?? null,
      title: latest.output?.title ?? null,
      summarySha256: typeof latest.output?.summary === 'string'
        ? createHash('sha256').update(latest.output.summary).digest('hex') : null,
      startedAt: latest.started_at ?? null, completedAt: latest.completed_at ?? null}} : {})};
}

const invalidEvidence = cause => ({state:'invalid',cause});
/** Complete bounded pagination: a full last page needs a next page; the ceiling is incomplete, never a partial array. */
function* readPages(pathFor) {
  const rows = [];
  for (let page = 1; page <= SECURITY_METADATA_MAX_PAGES; page++) {
    const got = yield pathFor(page);
    if (!Array.isArray(got) || got.length > 100) return undefined;
    rows.push(...got);
    if (got.length < 100) return rows;
  }
  return undefined;
}
const CATEGORY_SET = new Set(CODEQL_EXPECTED_CATEGORIES);
const SECURITY_LEVELS = new Set(['low','medium','high','critical']);

/** W1-T10976 — complete same-merge-commit evidence for a missing CodeQL configuration. Read-only trusted metadata:
 * merge-ref identity, every analysis page (NO tool_name filter; tool.name is validated per row) and every alert page.
 * `pending` only while an expected category has not arrived; every malformed or contradicting corpus is `invalid`. */
function* codeqlRecoveryRequests({prefix, prNumber, headSha, baseSha, mergeSha}) {
  if (!sha(mergeSha) || mergeSha === headSha) return invalidEvidence('merge-sha-unavailable');
  const mergeRef = `refs/pull/${prNumber}/merge`;
  const ref = yield `${prefix}/git/ref/pull/${prNumber}/merge`;
  if (ref?.object?.sha !== mergeSha) return invalidEvidence('merge-ref-identity-mismatch');
  const commit = yield `${prefix}/commits/${mergeSha}`;
  const parents = Array.isArray(commit?.parents) ? commit.parents.map(parent => parent?.sha) : [];
  if (commit?.sha !== mergeSha || parents.length !== 2 || !parents.includes(headSha) || !parents.includes(baseSha))
    return invalidEvidence('merge-parents-mismatch');
  const analyses = yield* readPages(page => `${prefix}/code-scanning/analyses?ref=${mergeRef}&per_page=100&page=${page}`);
  if (analyses === undefined) return invalidEvidence('analysis-corpus-incomplete');
  const ids = new Set(), latest = new Map();
  for (const row of analyses) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id)) return invalidEvidence('analysis-identity-malformed');
    ids.add(row.id);
    if (typeof row.tool?.name !== 'string') return invalidEvidence('analysis-tool-malformed');
    // Foreign tool, ref, commit, key or category rows are not evidence for an expected category.
    if (row.tool.name !== 'CodeQL' || row.commit_sha !== mergeSha || row.ref !== mergeRef || row.analysis_key !== CODEQL_ANALYSIS_KEY ||
        !CATEGORY_SET.has(row.category)) continue;
    if (typeof row.error !== 'string' || typeof row.warning !== 'string' || !Number.isSafeInteger(row.results_count) || row.results_count < 0 ||
        typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return invalidEvidence('analysis-shape-malformed');
    const prior = latest.get(row.category);
    if (prior !== undefined && prior.created_at === row.created_at) return invalidEvidence('analysis-generation-ambiguous');
    if (prior === undefined || Date.parse(prior.created_at) < Date.parse(row.created_at)) latest.set(row.category, row);
  }
  const missing = CODEQL_EXPECTED_CATEGORIES.filter(category => !latest.has(category));
  if (missing.length > 0) return {state:'pending',missing};
  if ([...latest.values()].some(row => row.error !== '' || row.warning !== '')) return invalidEvidence('analysis-failed-or-warning');
  const alertsFor = function* (alertRef) {
    return yield* readPages(page => `${prefix}/code-scanning/alerts?ref=${alertRef}&state=open&per_page=100&page=${page}`);
  };
  const prAlerts = yield* alertsFor(mergeRef), baseAlerts = yield* alertsFor('refs/heads/main');
  if (prAlerts === undefined || baseAlerts === undefined) return invalidEvidence('alert-corpus-incomplete');
  const baseNumbers = new Set(), seen = new Set(), newHighCritical = [];
  for (const alert of baseAlerts) {
    if (!Number.isSafeInteger(alert?.number) || alert.number < 1 || baseNumbers.has(alert.number)) return invalidEvidence('alert-identity-malformed');
    baseNumbers.add(alert.number);
  }
  for (const alert of prAlerts) {
    if (!Number.isSafeInteger(alert?.number) || alert.number < 1 || seen.has(alert.number)) return invalidEvidence('alert-identity-malformed');
    seen.add(alert.number);
    if (typeof alert.tool?.name !== 'string') return invalidEvidence('alert-tool-malformed');
    if (alert.tool.name !== 'CodeQL') continue;
    const level = alert.rule?.security_severity_level;
    if (level !== null && level !== undefined && !SECURITY_LEVELS.has(level)) return invalidEvidence('alert-severity-unreadable');
    if (level === null || level === undefined) {
      if (!['error','warning','note','none'].includes(alert.rule?.severity)) return invalidEvidence('alert-severity-unreadable');
      continue; // Quality finding: below the security threshold.
    }
    if (level !== 'high' && level !== 'critical') continue;
    const instance = alert.most_recent_instance;
    if (instance?.ref !== mergeRef || instance.commit_sha !== mergeSha || instance.analysis_key !== CODEQL_ANALYSIS_KEY ||
        !CATEGORY_SET.has(instance.category)) return invalidEvidence('alert-instance-identity-mismatch');
    if (!baseNumbers.has(alert.number)) newHighCritical.push(alert.number);
  }
  return {state:'complete',mergeSha,analysisKey:CODEQL_ANALYSIS_KEY,categories:[...latest.keys()],
    analysisIds:Object.fromEntries([...latest].map(([category,row]) => [category,row.id])),alertsComplete:true,newHighCritical};
}

/** Shared runtime trusted API metadata ONLY. Caller supplies an authenticated, bounded HTTP reader;
 * no PR checkout, uploaded artifact, evaluator, install, merge or dispatch is executed.
 * SHIPS-UNWIRED: GitHub producer/protection activation awaits main adoption and smoke evidence.
 */
export function* securityMergeMetadataRequests(target) {
  if (target?.owner !== 'craigoley' || target.repo !== 'remudero' || !Number.isSafeInteger(target.prNumber) || target.prNumber < 1 ||
      (target.expectedHead !== undefined && !sha(target.expectedHead))) return {decision:unknown('invalid-target')};
  const prefix = `repos/${target.owner}/${target.repo}`, prPath = `${prefix}/pulls/${target.prNumber}`;
  let headSha,baseSha;
  try {
    const first = yield prPath;
    headSha = first?.head?.sha;
    baseSha = first?.base?.sha;
    if (!sha(headSha) || first.state !== 'open' || first.base?.repo?.full_name !== 'craigoley/remudero' || first.base.ref !== 'main' ||
        (target.expectedHead !== undefined && target.expectedHead !== headSha)) return {headSha,baseSha,decision:unknown('head-unavailable-or-changed')};
    if (!Number.isSafeInteger(first.changed_files) || first.changed_files < 1 || first.changed_files > CODE_SCANNING_MAX_CHANGED_FILES)
      return {headSha,baseSha,decision:unknown('changed-file-corpus-incomplete')};
    const files = [];
    for (let page = 1; page <= SECURITY_METADATA_MAX_PAGES; page++) {
      const rows = yield `${prPath}/files?per_page=100&page=${page}`;
      if (!Array.isArray(rows) || rows.length > 100) return {headSha,baseSha,decision:unknown('changed-file-corpus-incomplete')};
      files.push(...rows);
      if (files.length >= first.changed_files || rows.length < 100) break;
    }
    if (new Set(files.map(file => file?.filename)).size !== files.length) return {headSha,baseSha,decision:unknown('changed-file-corpus-ambiguous')};
    const input = {prNumber:target.prNumber,headSha,observedHeadSha:headSha,filesComplete:files.length === first.changed_files,
      filesHeadSha:headSha,changedFileCount:first.changed_files,files};
    let decision = classifyCodeScanningMergePolicy(input), checks = [], checksComplete = false, recovery;
    if (decision.state !== 'not-applicable' && decision.reason === 'check-corpus-incomplete') {
      let total;
      for (let page = 1; page <= SECURITY_METADATA_MAX_PAGES; page++) {
        const corpus = yield `${prefix}/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`;
        if (!Number.isSafeInteger(corpus?.total_count) || corpus.total_count < 0 || corpus.total_count > 100 * SECURITY_METADATA_MAX_PAGES ||
            !Array.isArray(corpus.check_runs) || corpus.check_runs.length > 100 || (total !== undefined && total !== corpus.total_count))
          return {headSha,baseSha,decision:unknown('check-corpus-incomplete-or-changing')};
        total = corpus.total_count;checks.push(...corpus.check_runs);
        if (checks.length >= total || corpus.check_runs.length < 100) break;
      }
      checksComplete = checks.length === total;
      if (isMissingConfigurationCandidate(checks, headSha, target.prNumber))
        recovery = yield* codeqlRecoveryRequests({prefix,prNumber:target.prNumber,headSha,baseSha,mergeSha:first.merge_commit_sha});
      decision = classifyCodeScanningMergePolicy({...input,checksComplete,checksHeadSha:headSha,checks,
        ...(recovery ? {recovery} : {})});
    }
    if (decision.mergeAllowed && changesSemgrepRuntime(files)) {
      const runtime = yield* semgrepRuntimeMetadataRequests({headSha,baseSha:first.base.sha,prNumber:target.prNumber,files,checks,checksComplete});
      decision = runtime.mergeAllowed ? {state:'safe',mergeAllowed:true,reason:'trusted-exact-head-security-and-runtime-compatible'} : runtime;
    }
    // Changes to head/base/file-count during pagination invalidate even a docs-only result.
    const last = yield prPath;
    if (last?.head?.sha !== headSha || last.state !== 'open' || last.base?.sha !== first.base.sha || last.changed_files !== first.changed_files ||
        last.base?.repo?.full_name !== first.base.repo.full_name || last.base.ref !== first.base.ref ||
        (recovery !== undefined && last.merge_commit_sha !== first.merge_commit_sha))
      return {headSha,baseSha,decision:unknown('head-or-base-changed-during-observation')};
    return {headSha,baseSha,decision,observation:{...codeqlObservation(headSha,checks,checksComplete),
      ...(recovery ? {recovery:{state:recovery.state,...(recovery.cause ? {cause:recovery.cause} : {}),
        ...(recovery.missing ? {missing:recovery.missing} : {}),...(recovery.state === 'complete' ? {mergeSha:recovery.mergeSha,
          analysisKey:recovery.analysisKey,categories:recovery.categories,analysisIds:recovery.analysisIds,
          newHighCritical:recovery.newHighCritical} : {})}} : {})},
      ...(recovery ? {mergeSha:first.merge_commit_sha} : {})};
  } catch {
    return {headSha,baseSha,decision:unknown('security-api-unavailable')};
  }
}

/** The synchronous CLI and awaited daemon/workflow drive the SAME observation program. */
export function readSecurityMergeDecisionSync(target, read) {
  const requests=securityMergeMetadataRequests(target);let next=requests.next();
  while(!next.done){try{next=requests.next(read(next.value));}catch(error){next=requests.throw(error);}}
  return next.value;
}
export async function readSecurityMergeDecision(target, read) {
  const requests=securityMergeMetadataRequests(target);let next=requests.next();
  while(!next.done){try{next=requests.next(await read(next.value));}catch(error){next=requests.throw(error);}}
  return next.value;
}

/** Publish only a SHA-scoped status, never merge permission for another head.
 * UNKNOWN is an actionable error, not a forever-pending or success-shaped result.
 * The trusted completion producer may reobserve pending analysis; each call repeats every guard.
 */
export async function publishSecurityMergeDecision(target, api, targetUrl, {exhausted=false}={}) {
  let observed = await readSecurityMergeDecision(target, api.read);
  // The shared window ended with the recovery still pending: a final, distinct, actionable disposition.
  if (exhausted && observed.decision?.reason === CODEQL_RECOVERY_PENDING_REASON)
    observed = {...observed,decision:unknown('codeql-configuration-recovery-exhausted')};
  if (!sha(observed.headSha) || (target.expectedHead !== undefined && target.expectedHead !== observed.headSha))
    return {...observed,published:false};
  const live = await api.read(`repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`);
  if (live?.head?.sha !== observed.headSha || live.state !== 'open' || live.base?.sha !== observed.baseSha ||
      live.base?.ref !== 'main' || live.base?.repo?.full_name !== 'craigoley/remudero' ||
      (observed.mergeSha !== undefined && live.merge_commit_sha !== observed.mergeSha))
    return {...observed,decision:unknown('head-or-base-changed-before-publication'),published:false};
  await api.status({sha:observed.headSha,context:SECURITY_MERGE_CONTEXT,
    state:observed.decision.mergeAllowed ? 'success' : observed.decision.state === 'blocked' ? 'failure' : 'error',
    description:`${observed.decision.state}: ${observed.decision.reason}`.slice(0,140),target_url:targetUrl});
  return {...observed,published:true};
}
