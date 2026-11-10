import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {isMainModule} from './lib/argv.mjs';
import {publishSecurityMergeDecision, SECURITY_MERGE_CONTEXT} from '../src/lib/code-scanning-merge-adapter.mjs';
import {CODEQL_RECOVERY_PENDING_REASON} from '../src/lib/code-scanning-merge-policy.mjs';
import {securityMetadataGhArgs} from '../src/lib/security-metadata-gh-args.mjs';

// BACKSTOP inherited from the existing bounds, not a measured GitHub latency: at most three 60-second waits
// within 240 seconds of the job's five-minute limit, reserving the remainder for final publication.
const SECURITY_RECOVERY_MAX_WAITS = 3;
const SECURITY_RECOVERY_BUDGET_MS = 240_000;
const CODEQL_WORKFLOW_PATH = '.github/workflows/codeql.yml';

/** A completed/successful repository-local CodeQL run, still the live attempt of that run, from the trusted workflow path.
 * A workflow name or event payload alone is never enough: the run is re-read and must agree on every identity field. */
export async function verifyCodeqlRun(run, read, owner, repo) {
  const full = `${owner}/${repo}`;
  if (!Number.isSafeInteger(run?.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      run.path !== CODEQL_WORKFLOW_PATH || run.repository?.full_name !== full || run.head_repository?.full_name !== full) return false;
  const live = await read(`repos/${owner}/${repo}/actions/runs/${run.id}`);
  return live?.id === run.id && live.run_attempt === run.run_attempt && live.head_sha === run.head_sha &&
    live.path === CODEQL_WORKFLOW_PATH && live.status === 'completed' && live.conclusion === 'success' &&
    live.name === 'CodeQL' && live.repository?.full_name === full && live.head_repository?.full_name === full;
}

/** Runs from the trusted default branch. Never execute the event's head checkout.
 * Network failures and unsupported merge-group evidence cannot produce a successful merge-policy status.
 */
export async function runSecurityMergeProducer(eventName, event, transport, targetUrl) {
  const startedAt = (transport.now ?? (() => performance.now()))();
  if (event?.repository?.full_name !== 'craigoley/remudero') throw Error('foreign security event repository');
  const owner='craigoley',repo='remudero';
  if (eventName === 'merge_group') {
    const sha=event.merge_group?.head_sha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('missing merge-group head');
    await transport.status({sha,context:SECURITY_MERGE_CONTEXT,state:'error',
      description:'unknown: merge-group-security-analysis-unqualified',target_url:targetUrl});
    return [{headSha:sha,decision:{state:'unknown',mergeAllowed:false,reason:'merge-group-security-analysis-unqualified'},published:true}];
  }
  let candidates;
  if (eventName === 'pull_request_target') candidates=[{number:event.pull_request?.number,head:event.pull_request?.head}];
  else if (eventName === 'workflow_dispatch') {
    const number=Number(event.inputs?.pr_number);
    if (!Number.isSafeInteger(number) || number < 1) throw Error('invalid dispatch PR number');
    candidates=[{number}];
  } else if (eventName === 'workflow_run' && ['CodeQL','Semgrep runtime compatibility'].includes(event.workflow_run?.name)) {
    const sha=event.workflow_run.head_sha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('missing workflow head');
    // One bounded association page; at the API page ceiling, never presume it was complete.
    const rows=await transport.read(`repos/${owner}/${repo}/commits/${sha}/pulls?per_page=100`);
    if (!Array.isArray(rows) || rows.length >= 100) throw Error('PR association corpus incomplete');
    candidates=rows.filter(pr=>pr.state === 'open' && pr.head?.sha === sha);
  } else throw Error('unsupported security producer event');
  if (candidates.length > 16) throw Error('security producer fanout exceeds bounded event scope');
  const results=[];
  for (const pr of candidates) results.push(await publishSecurityMergeDecision({owner,repo,prNumber:pr.number,
    expectedHead:pr.head?.sha},transport,targetUrl));
  // The workflow can finish before GitHub's separate CodeQL check finishes processing SARIF.
  // Reobserve only a positively identified pending analysis, or the exact one-configuration-missing warning
  // whose categories are still arriving, within the existing five-minute workflow deadline. Every
  // observation still uses the complete classifier and fresh head/base/merge identity.
  if (eventName === 'workflow_run' && event.workflow_run.name === 'CodeQL' &&
      event.workflow_run.status === 'completed' && event.workflow_run.conclusion === 'success') {
    const clock = transport.now ?? (() => performance.now());
    const deadline = startedAt + SECURITY_RECOVERY_BUDGET_MS;
    const guarded = {...transport, read: path => {
      if (clock() >= deadline) throw Error('security recovery deadline exceeded');
      return transport.read(path);
    }};
    const awaiting = result => result.published === true && result.observation?.trustedCodeqlCount > 0 &&
      ((result.decision.reason === 'security-analysis-pending' && result.observation.latest?.status !== 'completed') ||
        result.decision.reason === CODEQL_RECOVERY_PENDING_REASON);
    let attempts = 0, runVerified = false;
    const verifiedRun = async () => {
      try { return await verifyCodeqlRun(event.workflow_run, guarded.read, owner, repo); } catch { return false; }
    };
    for (let round=0; round<SECURITY_RECOVERY_MAX_WAITS; round++) {
      const pending=results.flatMap((result,i)=>awaiting(result) ? [i] : []);
      if (pending.length === 0) break;
      // Never start a wait that cannot fit the remaining budget; the remainder is reserved for publication.
      if (clock() + 60_000 > deadline) break;
      runVerified = await verifiedRun();
      if (!runVerified) break;
      await (transport.wait ?? delay)(60_000);
      attempts++;
      for (const i of pending) {
        if (clock() >= deadline) break;
        try {
          results[i]=await publishSecurityMergeDecision({owner,repo,prNumber:candidates[i].number,
            expectedHead:results[i].headSha},guarded,targetUrl);
        } catch { break; }
      }
    }
    // Still awaiting at the end of the shared window: a final distinct, actionable UNKNOWN, never pending or success.
    for (const [i, result] of results.entries()) {
      if (result.decision?.reason !== CODEQL_RECOVERY_PENDING_REASON || result.published !== true) continue;
      try {
        results[i]={...await publishSecurityMergeDecision({owner,repo,prNumber:candidates[i].number,
          expectedHead:result.headSha},transport,targetUrl,{exhausted:true}),recoveryAttempts:attempts,
          recoveryRun:{id:event.workflow_run.id,attempt:event.workflow_run.run_attempt,verified:runVerified}};
      } catch { results[i]={...result,published:false}; }
    }
  }
  return results;
}

// BACKSTOP: persistent opaque CLI response failures cannot spin; transient recovery needs
// two reads, and four attempts matches the existing CI reporter's bounded transport recovery.
const SECURITY_METADATA_READ_ATTEMPTS = 4;

export function createSecurityMetadataReader({exec=execFileSync,wait=delay}={}) {
  return async path=>{
    const args=securityMetadataGhArgs(path);
    if (args[1] !== 'graphql') args.splice(1,0,'--method','GET');
    let output;
    for (let attempt=1; ; attempt++) {
      try {
        output=exec('gh',args,{encoding:'utf8',timeout:15000,maxBuffer:2<<20});
        break;
      } catch (error) {
        const truncated=typeof error?.stderr === 'string' && error.stderr.trim() === 'unexpected end of JSON input' &&
          Number.isInteger(error.status) && error.status !== 0;
        const unavailable=typeof error?.stderr === 'string' && /(?:^|\n)gh: HTTP 503(?:\b|$)/.test(error.stderr) &&
          Number.isInteger(error.status) && error.status !== 0;
        if ((!truncated && !unavailable) || attempt >= SECURITY_METADATA_READ_ATTEMPTS) throw error;
        await wait(1000 * 2 ** (attempt-1));
      }
    }
    return JSON.parse(output);
  };
}

if (isMainModule(import.meta.url)) {
  const read=createSecurityMetadataReader();
  // Fields travel as argv `-f` (raw string) pairs, never a stdin body: a child that exits without
  // draining stdin would otherwise surface a spurious EPIPE instead of its real exit status.
  const status=payload=>{
    const fields=Object.entries(payload).filter(([k,v])=>k !== 'sha' && v !== undefined)
      .flatMap(([k,v])=>['-f',`${k}=${v}`]);
    execFileSync('gh',['api','--method','POST',`repos/craigoley/remudero/statuses/${payload.sha}`,...fields],
      {stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:15000,maxBuffer:1<<20});};
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const results=await runSecurityMergeProducer(process.env.GITHUB_EVENT_NAME,event,{read,status},
    `https://github.com/craigoley/remudero/actions/runs/${process.env.GITHUB_RUN_ID}`);
  console.log(JSON.stringify({context:SECURITY_MERGE_CONTEXT,results}));
  // The job reports delivery, not merge permission. A published denied/UNKNOWN decision
  // stays failure/error on the authoritative SHA-scoped policy status. Failing this
  // bootstrap job as well leaves a sticky red after CodeQL completion publishes safe
  // from workflow_run (whose own check belongs to the default-branch commit).
  if (results.some(r=>r.published !== true)) process.exitCode=1;
}
