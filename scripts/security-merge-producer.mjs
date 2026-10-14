import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {isMainModule} from './lib/argv.mjs';
import {publishSecurityMergeDecision, SECURITY_MERGE_CONTEXT} from '../src/lib/code-scanning-merge-adapter.mjs';

/** Runs from the trusted default branch. Never execute the event's head checkout.
 * Network failures and unsupported merge-group evidence cannot produce success.
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
  } else if (eventName === 'workflow_run' && event.workflow_run?.name === 'CodeQL') {
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

if (isMainModule(import.meta.url)) {
  const read=path=>JSON.parse(execFileSync('gh',['api','--method','GET',path],
    {encoding:'utf8',timeout:15000,maxBuffer:2<<20}));
  const status=payload=>{execFileSync('gh',['api','--method','POST',`repos/craigoley/remudero/statuses/${payload.sha}`,
    '--input','-'],{input:JSON.stringify(payload),encoding:'utf8',timeout:15000,maxBuffer:1<<20});};
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  const results=await runSecurityMergeProducer(process.env.GITHUB_EVENT_NAME,event,{read,status},
    `https://github.com/craigoley/remudero/actions/runs/${process.env.GITHUB_RUN_ID}`);
  console.log(JSON.stringify({context:SECURITY_MERGE_CONTEXT,results}));
  if (results.some(r=>!r.published || !r.decision.mergeAllowed)) process.exitCode=1;
}
