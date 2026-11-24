import {createHash} from "node:crypto";
import {classifyCodeScanningMergePolicy, CODE_SCANNING_MAX_CHANGED_FILES, isCodeqlConfigurationWarning} from './code-scanning-merge-policy.mjs';
import {changesSemgrepRuntime, semgrepRuntimeMetadataRequests} from './semgrep-runtime-merge-policy.mjs';

export const SECURITY_MERGE_CONTEXT = 'security-merge-policy';
export const SECURITY_METADATA_MAX_PAGES = 30; // BACKSTOP: complete evidence or UNKNOWN, never partial success.
const unknown = reason => ({state:'unknown',mergeAllowed:false,reason});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const CODEQL_WARNING_SUMMARY_MAX_CHARS = 8192; // BACKSTOP: the verbatim receipt is bounded per ledger row and job log.
const digest = text => createHash('sha256').update(text).digest('hex');

/** W1-T13470 — GitHub's own check text for the configuration-not-found shape, never a token or a header: the summary
 *  verbatim up to its BACKSTOP with the whole summary's sha256, and the "View all branch alerts" target or null. */
function configurationWarning(headSha, check) {
  const summary = typeof check.output?.summary === 'string' ? check.output.summary : null;
  return {checkId: check.id, headSha, completedAt: check.completed_at ?? null, conclusion: check.conclusion, title: check.output.title,
    summary: summary === null ? null : summary.slice(0, CODEQL_WARNING_SUMMARY_MAX_CHARS),
    summarySha256: summary === null ? null : digest(summary),
    truncated: summary !== null && summary.length > CODEQL_WARNING_SUMMARY_MAX_CHARS,
    alertsLink: summary?.match(/\[View all branch alerts\]\(([^()\s]{1,2048})\)/)?.[1] ?? null};
}

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
      summarySha256: typeof latest.output?.summary === 'string' ? digest(latest.output.summary) : null,
      startedAt: latest.started_at ?? null, completedAt: latest.completed_at ?? null},
    ...(isCodeqlConfigurationWarning(latest) ? {configurationWarning: configurationWarning(headSha, latest)} : {})} : {})};
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
    let decision = classifyCodeScanningMergePolicy(input), checks = [], checksComplete = false;
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
      decision = classifyCodeScanningMergePolicy({...input,checksComplete,checksHeadSha:headSha,checks});
    }
    if (decision.mergeAllowed && changesSemgrepRuntime(files)) {
      const runtime = yield* semgrepRuntimeMetadataRequests({headSha,baseSha:first.base.sha,prNumber:target.prNumber,files,checks,checksComplete});
      decision = runtime.mergeAllowed ? {state:'safe',mergeAllowed:true,reason:'trusted-exact-head-security-and-runtime-compatible'} : runtime;
    }
    // Changes to head/base/file-count during pagination invalidate even a docs-only result.
    const last = yield prPath;
    if (last?.head?.sha !== headSha || last.state !== 'open' || last.base?.sha !== first.base.sha || last.changed_files !== first.changed_files ||
        last.base?.repo?.full_name !== first.base.repo.full_name || last.base.ref !== first.base.ref)
      return {headSha,baseSha,decision:unknown('head-or-base-changed-during-observation')};
    return {headSha,baseSha,decision,observation:codeqlObservation(headSha,checks,checksComplete)};
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

/** W1-T14493: the two reasons that mean "the exact-head CodeQL result has not arrived yet", not that anything failed. */
const CODEQL_AWAITED_REASONS = new Set(['trusted-exact-head-codeql-result-missing', 'security-analysis-pending']);
const CODEQL_WORKFLOW_PATH = '.github/workflows/codeql.yml';
/** BACKSTOP (W1-T14493): a CodeQL run still queued or running this long after it started is treated as stuck, and the
 *  status goes back to error so the wait is visible as a fault. A healthy run takes well under this. */
export const CODEQL_RUN_PENDING_BOUND_MS = 60 * 60_000;

/** True only when this repository's CodeQL workflow run for the exact head is queued or in progress and started within
 *  {@link CODEQL_RUN_PENDING_BOUND_MS}. An absent, finished, unreadable, ambiguous or overdue run reads false. */
export async function codeqlRunInFlight(target, headSha, read, now) {
  try {
    const page = await read(`repos/${target.owner}/${target.repo}/actions/runs?head_sha=${headSha}&per_page=100`);
    if (!Array.isArray(page?.workflow_runs) || !Number.isSafeInteger(page.total_count) || page.total_count > page.workflow_runs.length) return false;
    const runs = page.workflow_runs.filter(run => run?.path === CODEQL_WORKFLOW_PATH && run.head_sha === headSha &&
      run.repository?.full_name === `${target.owner}/${target.repo}`);
    if (runs.length === 0 || runs.some(run => !Number.isSafeInteger(run.id) || run.id <= 0)) return false;
    const latest = runs.reduce((a, b) => (a.id > b.id ? a : b));
    if (latest.status !== 'queued' && latest.status !== 'in_progress') return false;
    const started = Date.parse(latest.run_started_at ?? latest.created_at);
    return Number.isFinite(started) && now - started <= CODEQL_RUN_PENDING_BOUND_MS;
  } catch {
    return false;
  }
}

/** Publish only a SHA-scoped status, never merge permission for another head.
 * UNKNOWN is an actionable error, not a forever-pending or success-shaped result. The one exception (W1-T14493): while
 * the exact head's CodeQL run is still queued or running, a decision that only awaits its result posts pending. That
 * blocks merge exactly as error does, and it turns back into error once the run finishes or passes its bound.
 * The trusted completion producer may reobserve pending analysis; each call repeats every guard.
 */
export async function publishSecurityMergeDecision(target, api, targetUrl) {
  const observed = await readSecurityMergeDecision(target, api.read);
  if (!sha(observed.headSha) || (target.expectedHead !== undefined && target.expectedHead !== observed.headSha))
    return {...observed,published:false};
  const live = await api.read(`repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`);
  if (live?.head?.sha !== observed.headSha || live.state !== 'open' || live.base?.sha !== observed.baseSha ||
      live.base?.ref !== 'main' || live.base?.repo?.full_name !== 'craigoley/remudero')
    return {...observed,decision:unknown('head-or-base-changed-before-publication'),published:false};
  const state = observed.decision.mergeAllowed ? 'success' : observed.decision.state === 'blocked' ? 'failure' :
    CODEQL_AWAITED_REASONS.has(observed.decision.reason) &&
      await codeqlRunInFlight(target, observed.headSha, api.read, api.now?.() ?? Date.now()) ? 'pending' : 'error';
  await api.status({sha:observed.headSha,context:SECURITY_MERGE_CONTEXT,state,
    description:`${observed.decision.state}: ${observed.decision.reason}`.slice(0,140),target_url:targetUrl});
  return {...observed,published:true,postedState:state};
}
