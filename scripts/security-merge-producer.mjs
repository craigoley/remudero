import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {isMainModule} from './lib/argv.mjs';
import {publishSecurityMergeDecision, SECURITY_MERGE_CONTEXT} from '../src/lib/code-scanning-merge-adapter.mjs';
import {securityMetadataGhArgs} from '../src/lib/security-metadata-gh-args.mjs';

/** Runs from the trusted default branch. Never execute the event's head checkout.
 * Network failures and unsupported merge-group evidence cannot produce a successful merge-policy status.
 */
export async function runSecurityMergeProducer(eventName, event, transport, targetUrl) {
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
