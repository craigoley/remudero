import {createHash} from "node:crypto";
import {classifyCodeScanningMergePolicy, CODE_SCANNING_MAX_CHANGED_FILES} from './code-scanning-merge-policy.mjs';
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

/** Publish only a SHA-scoped status, never merge permission for another head.
 * UNKNOWN is an actionable error, not a forever-pending or success-shaped result.
 * A subsequent CodeQL completion retries through events rather than runner polling.
 */
export async function publishSecurityMergeDecision(target, api, targetUrl) {
  const observed = await readSecurityMergeDecision(target, api.read);
  if (!sha(observed.headSha) || (target.expectedHead !== undefined && target.expectedHead !== observed.headSha))
    return {...observed,published:false};
  const live = await api.read(`repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`);
  if (live?.head?.sha !== observed.headSha || live.state !== 'open' || live.base?.sha !== observed.baseSha ||
      live.base?.ref !== 'main' || live.base?.repo?.full_name !== 'craigoley/remudero')
    return {...observed,decision:unknown('head-or-base-changed-before-publication'),published:false};
  await api.status({sha:observed.headSha,context:SECURITY_MERGE_CONTEXT,
    state:observed.decision.mergeAllowed ? 'success' : observed.decision.state === 'blocked' ? 'failure' : 'error',
    description:`${observed.decision.state}: ${observed.decision.reason}`.slice(0,140),target_url:targetUrl});
  return {...observed,published:true};
}
