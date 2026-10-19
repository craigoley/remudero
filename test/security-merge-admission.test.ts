import assert from 'node:assert/strict';
import {test} from 'node:test';
import {securityMergeHead,securityMergeHeadAsync,SecurityMergeRefused} from '../src/lib/security-merge-admission.js';
import {exitCodeFor,isRmdError} from '../src/lib/errors.js';
const head='a'.repeat(40),base='b'.repeat(40),url='https://github.com/craigoley/remudero/pull/11468';
const pr={state:'open',head:{sha:head},base:{sha:base,ref:'main',repo:{full_name:'craigoley/remudero'}},changed_files:1};
const clean={id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'success',
 app:{id:57789,slug:'github-advanced-security',owner:{login:'github'}},
 output:{title:'No new alerts in code changed by this pull request',summary:'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen).'}};
const reader=(check:any=clean)=>(path:string)=>path.includes('/files?')?[{filename:'src/a.ts'}]:
 path.includes('/check-runs?')?{total_count:1,check_runs:[check]}:pr;
test('security merge refusal retains structured GitHub error details at the CLI boundary',()=>{
 const error=new SecurityMergeRefused('unknown','security-api-unavailable');
 assert.equal(isRmdError(error),true);assert.equal(error.kind,'github');assert.equal(exitCodeFor(error),1);
 assert.deepEqual(error.details,{state:'unknown',reason:'security-api-unavailable'});
});
test('core security admission sync and async bind trusted exact head without widening policy to other repos',async()=>{
 assert.equal(securityMergeHead(url,reader()),head);assert.equal(await securityMergeHeadAsync(url,async p=>reader()(p)),head);
 assert.equal(securityMergeHead('https://github.com/acme/widgets/pull/1',()=>assert.fail('out of scope read')),undefined);
 assert.throws(()=>securityMergeHead(url+'/files',reader()),SecurityMergeRefused);
});
test('core security admission blocks high alerts and preserves unavailable as UNKNOWN rather than a merge fallback',async()=>{
 const high={...clean,conclusion:'failure',output:{title:'1 new alert including 1 high severity security vulnerability',summary:' * 1 high\n'}};
 assert.throws(()=>securityMergeHead(url,reader(high)),(e:unknown)=>e instanceof SecurityMergeRefused&&e.state==='blocked');
 await assert.rejects(()=>securityMergeHeadAsync(url,async()=>{throw Error('read failed');}),
  (e:unknown)=>e instanceof SecurityMergeRefused&&e.state==='unknown');
 assert.throws(()=>securityMergeHead(url,reader({...clean,status:'in_progress'})),SecurityMergeRefused);
});
test('core security admission rejects a changed expected head and carries the observed head into its refusal',async()=>{
 const oldHead='c'.repeat(40);
 const refused=(e:unknown)=>e instanceof SecurityMergeRefused&&e.state==='unknown'&&e.headSha===head&&e.details?.headSha===head;
 assert.throws(()=>securityMergeHead(url,reader(),oldHead),refused);
 await assert.rejects(()=>securityMergeHeadAsync(url,async p=>reader()(p),oldHead),refused);
 assert.equal(securityMergeHead(url,reader(),head),head);
});
test('core URL identity aliases cannot become an out-of-scope security fallback',async()=>{
 const aliases=[
  'https://github.com/CRAIGOLEY/REMUDERO/pull/11468',
  'https://GITHUB.COM/craigoley/remudero/pull/11468',
  'http://github.com/craigoley/remudero/pull/11468',
  'https://github.com:443/craigoley/remudero/pull/11468',
  'https://github.com./craigoley/remudero/pull/11468',
  'https://github.com/%63raigoley/remudero/pull/11468',
  'https://github.com/craigoley/%72emudero/pull/11468',
  'https://github.com/craigoley%2Fremudero/pull/11468',
  'https://github.com/craigoley/%ZZ/pull/11468',
  'https://github.com/craigoley/unused/../remudero/pull/11468',
  'https://user@github.com/craigoley/remudero/pull/11468',
  ' '+url+' ',url+'?view=files',url+'#discussion',
 ];
 const refused=(error:unknown)=>error instanceof SecurityMergeRefused&&error.state==='unknown'&&error.reason==='noncanonical-pr-target';
 for(const alias of aliases){
  assert.throws(()=>securityMergeHead(alias,()=>assert.fail('ambiguous core target must be refused before API reads')),refused,alias);
  await assert.rejects(()=>securityMergeHeadAsync(alias,async()=>assert.fail('ambiguous core target must be refused before API reads')),refused,alias);
 }
});
test('ambiguous CLI selectors are not proof that a merge target is outside core',async()=>{
 for(const selector of ['11468','main','not a URL']){
  assert.throws(()=>securityMergeHead(selector,()=>assert.fail('unresolved identity')),SecurityMergeRefused);
  await assert.rejects(()=>securityMergeHeadAsync(selector,async()=>assert.fail('unresolved identity')),SecurityMergeRefused);
 }
 for(const other of ['https://github.com/acme/widgets/pull/1','https://github.com/CRAIGOLEY/another-repo/pull/1','https://git.example.com/craigoley/remudero/pull/1']){
  assert.equal(securityMergeHead(other,()=>assert.fail('valid other repo remains outside approved policy')),undefined);
  assert.equal(await securityMergeHeadAsync(other,async()=>assert.fail('valid other repo remains outside approved policy')),undefined);
 }
});
