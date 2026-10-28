import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error — ESM metadata policy outside tsconfig source roots; executable seam is intentionally plain JS.
import {classifyCodeScanningMergePolicy as classify} from '#src/lib/code-scanning-merge-policy.mjs';
const head='a'.repeat(40), other='b'.repeat(40);
const clean=()=>({prNumber:11468,headSha:head,observedHeadSha:head,filesComplete:true,filesHeadSha:head,changedFileCount:1,
 files:[{filename:'src/feature.ts'}],checksComplete:true,checksHeadSha:head,
 checks:[{id:1,name:'CodeQL',head_sha:head,status:'completed',conclusion:'success',
 app:{id:57789,slug:'github-advanced-security',owner:{login:'github'}},
 output:{title:'No new alerts in code changed by this pull request',summary:'[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen).'}}]});
test('exact-head security policy blocks a trusted new high alert despite green required checks',()=>{
 const x=clean();x.checks[0]!.conclusion='failure';x.checks[0]!.output.summary='### New alerts in code changed by this pull request\nSecurity Alerts:\n * 1 high\n';
 assert.deepEqual(classify(x),{state:'blocked',mergeAllowed:false,reason:'new-high-or-critical-security-alert'});
 x.checks[0]!.output.summary=' * 1 critical\n';assert.equal(classify(x).mergeAllowed,false);
 x.checks[0]!.conclusion='success';x.checks[0]!.output.summary='No new alerts\n * 1 high\n';
 assert.equal(classify(x).mergeAllowed,false,'a success-shaped statement cannot override a positive high-severity control');
});
test('exact-head security policy rejects unavailable incomplete stale spoofed and success-shaped evidence',()=>{
 for(const mutate of [(x:any)=>x.observedHeadSha=other,(x:any)=>x.filesComplete=false,(x:any)=>x.changedFileCount=2,
 (x:any)=>x.checksComplete=false,(x:any)=>x.checksHeadSha=other,(x:any)=>x.checks=[],
 (x:any)=>x.checks[0].head_sha=other,(x:any)=>x.checks[0].app.id=1,(x:any)=>x.checks[0].app.owner.login='attacker',
 (x:any)=>x.checks[0].status='in_progress',(x:any)=>x.checks[0].output.summary='',(x:any)=>x.files[0].filename='../docs/x.md']){
  const x=clean();mutate(x);const r=classify(x);assert.equal(r.state,'unknown');assert.equal(r.mergeAllowed,false);
 }
 const duplicate=clean();duplicate.checks.push({...duplicate.checks[0]!});assert.equal(classify(duplicate).state,'unknown');
 const prose=clean();prose.checks[0]!.output.summary='It is not true that there are no new alerts';assert.equal(classify(prose).state,'unknown');
 const borrowed=clean();borrowed.prNumber=11442;assert.equal(classify(borrowed).state,'unknown');
 const malformed=clean();malformed.prNumber=NaN;assert.equal(classify(malformed).state,'unknown');
});
test('only complete verified ignored paths skip CodeQL and a source rename cannot hide in docs',()=>{
 const x=clean();x.checks=[];x.files=[{filename:'plan/tasks.d/W1-T1.yaml'}];assert.equal(classify(x).state,'not-applicable');
 x.files=[{filename:'docs/x.md',previous_filename:'src/x.ts'}] as any;assert.equal(classify(x).state,'unknown');
 x.filesComplete=false;assert.equal(classify(x).mergeAllowed,false);
});
test('latest exact-head security generation supersedes stale red but pending never becomes green',()=>{
 const x=clean();x.checks.push({...x.checks[0]!,id:2,status:'in_progress'});assert.equal(classify(x).mergeAllowed,false);
 x.checks[1]!.status='completed';x.checks[0]!.conclusion='failure';x.checks[0]!.output={...x.checks[0]!.output,summary:' * 1 high\n'};
 assert.equal(classify(x).state,'safe');
});
test('security policy permits positively enumerated below-threshold findings but refuses unrecognized formats',()=>{
 const x=clean();x.checks[0]!.conclusion='failure';x.checks[0]!.output.title='1 new alert';
 const link=x.checks[0]!.output.summary;
 x.checks[0]!.output.summary='### New alerts in code changed by this pull request\n\nSecurity Alerts:\n * 1 medium\n\n\nSee annotations below for details.\n\n'+link;
 assert.equal(classify(x).state,'safe');
 x.checks[0]!.output.summary=x.checks[0]!.output.summary.replace('medium','critical');assert.equal(classify(x).state,'blocked');
 x.checks[0]!.output.summary='something new';assert.equal(classify(x).state,'unknown');
});
test('a trusted quality-only CodeQL note does not strand an otherwise safe PR',()=>{
 const x=clean();x.prNumber=11936;x.checks[0]!.id=116310590746;
 x.checks[0]!.output.title='1 new alert';
 x.checks[0]!.output.summary='### New alerts in code changed by this pull request\n\n * 1 note\n\nSee annotations below for details.\n\n[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11936+tool%3ACodeQL+is%3Aopen).';
 assert.deepEqual(classify(x),{state:'safe',mergeAllowed:true,reason:'trusted-complete-exact-head-below-security-threshold'});
 for(const level of ['error','warning','note'])for(const conclusion of ['success','failure']){
  const y=clean();y.checks[0]!.conclusion=conclusion;y.checks[0]!.output.title='2 new alerts';
  y.checks[0]!.output.summary='### New alerts in code changed by this pull request\n\n * 2 '+level+'\n\nSee annotations below for details.\n\n'+y.checks[0]!.output.summary;
  assert.equal(classify(y).state,'safe',level+' remains quality, not high/critical security');
 }
});
test('headerless CodeQL findings cannot launder security, incomplete evidence or an inconsistent total',()=>{
 const fixture=()=>{const x=clean();x.checks[0]!.output.title='1 new alert';
  x.checks[0]!.output.summary='### New alerts in code changed by this pull request\n\n * 1 note\n\nSee annotations below for details.\n\n'+x.checks[0]!.output.summary;return x;};
 for(const level of ['high','critical']){
  const x=fixture();x.checks[0]!.output.summary=x.checks[0]!.output.summary.replace('1 note','1 '+level);
  assert.equal(classify(x).state,'blocked');
 }
 for(const mutate of [(x:any)=>x.checks[0].output.title='2 new alerts',
  (x:any)=>x.checks[0].output.title='1 new alert including 1 high severity security vulnerability',
  (x:any)=>{x.checks[0].output.title='9007199254740993 new alerts';x.checks[0].output.summary=x.checks[0].output.summary.replace('1 note','9007199254740993 note');},
  (x:any)=>x.checks[0].output.summary=x.checks[0].output.summary.replace(' * 1 note\n',' * 1 note\n * 1 note\n'),
  (x:any)=>x.checks[0].output.summary=x.checks[0].output.summary.replace('1 note','1 unknown'),
  (x:any)=>x.prNumber=99,(x:any)=>x.checks[0].head_sha=other,
  (x:any)=>x.checks[0].app.id=1,(x:any)=>x.checksComplete=false,
  (x:any)=>x.checks[0].status='in_progress',(x:any)=>x.checks[0].conclusion='neutral']){
  const x=fixture();mutate(x);assert.equal(classify(x).state,'unknown');assert.equal(classify(x).mergeAllowed,false);
 }
});

function sectionedFindings() {
 const x=clean();x.checks[0]!.conclusion='failure';x.checks[0]!.output.title='3 new alerts including 1 medium severity security vulnerability';
 x.checks[0]!.output.summary='### New alerts in code changed by this pull request\n\nSecurity Alerts:\n * 1 low\n * 1 medium\n\nOther Alerts:\n * 1 note\n\nSee annotations below for details.\n\n'+x.checks[0]!.output.summary;
 return x;
}
test('sectioned CodeQL findings require a complete matching alert total and severity title',()=>{
 for(const title of ['4 new alerts','3 new alerts including 1 high severity security vulnerability',
  '3 new alerts including 1 critical severity security vulnerability',
  '3 new alerts including 2 medium severity security vulnerabilities','3 new alerts including unknown findings']){
  const x=sectionedFindings();x.checks[0]!.output.title=title;
  assert.equal(classify(x).state,'unknown',title);assert.equal(classify(x).mergeAllowed,false,title);
 }
});
test('sectioned CodeQL findings refuse duplicate levels unsafe counts and contradictory title sections',()=>{
 for(const mutate of [(x:any)=>{x.checks[0].output.title='4 new alerts';x.checks[0].output.summary=x.checks[0].output.summary.replace(' * 1 low\n',' * 1 low\n * 1 low\n');},
  (x:any)=>{x.checks[0].output.title='4 new alerts';x.checks[0].output.summary=x.checks[0].output.summary.replace(' * 1 note\n',' * 1 note\n * 1 note\n');},
  (x:any)=>{x.checks[0].output.title='9007199254740995 new alerts';x.checks[0].output.summary=x.checks[0].output.summary.replace(' * 1 low\n',' * 9007199254740993 low\n');},
  (x:any)=>{x.checks[0].output.title='2 new alerts including 1 medium severity security vulnerability';x.checks[0].output.summary=x.checks[0].output.summary.replace(' * 1 medium\n','');}]){
  const x=sectionedFindings();mutate(x);assert.equal(classify(x).state,'unknown');assert.equal(classify(x).mergeAllowed,false);
 }
});
test('consistent sectioned CodeQL low medium and quality findings remain below the security threshold',()=>{
 const x=sectionedFindings();assert.equal(classify(x).state,'safe');
 x.checks[0]!.output.title='3 new alerts';assert.equal(classify(x).state,'safe');
 x.checks[0]!.output.summary=x.checks[0]!.output.summary.replace('Other Alerts:','Non-security Alerts:');assert.equal(classify(x).state,'safe');
 x.checks[0]!.output.summary=x.checks[0]!.output.summary.replace(' * 1 low\n',' * 1 high\n');assert.equal(classify(x).state,'blocked');
});
