import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test} from 'node:test';
import readMapPlatformReporter,{platformEventRecord} from '#scripts/lib/read-map-platform-reporter.mjs';
const reporter=fileURLToPath(import.meta.resolve('#scripts/lib/read-map-platform-reporter.mjs'));
test('platform default producer hashes its actual executable and reporter while refusing output promotion',async()=>{
 const digest=async(path:string)=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
 async function* events(){yield{type:'test:stdout',data:{message:'must not enter metadata'}};yield{type:'test:summary',data:{counts:{tests:2,passed:1,skipped:1},success:true}};}
 const rows=[];for await(const line of readMapPlatformReporter(events()))rows.push(JSON.parse(line));
 assert.equal(rows.length,2);const producer=rows[0];assert.equal(producer.event,'producer');assert.deepEqual(producer.runtime,{node:process.version,platform:process.platform,arch:process.arch,executableSha256:await digest(process.execPath)});assert.equal(producer.reporterSha256,await digest(reporter));assert.equal(producer.state,'RAW_SHADOW_METADATA_NOT_QUALIFIED');
 assert.equal(rows[1].event,'test:summary');assert.equal(rows[1].data.counts.skipped,1);assert.equal(rows[1].data.counts.failed,null);
 for(const row of rows){assert.equal(row.dispatchAllowed,false);assert.equal(row.liveNarrowingAllowed,false);assert.equal(row.productionCoverageChanged,false);assert.equal(row.authorPass,false);assert.equal(row.fullCorpusQualified,false);}
});
test('platform metadata uses actual entry identity and preserves concurrent lineage and duplicate names',()=>{
 const root=mkdtempSync(join(tmpdir(),'rmd-platform-events-'));
 try{
  const entry=join(root,'entry.test.mjs'),imported=join(root,'imported.mjs');
  writeFileSync(imported,'import {test} from "node:test";test("imported definition",()=>{});');
  // The generated fixture has no repository package aliases: bind its real module by file URL.
  writeFileSync(entry,'import {test} from "node:test";import '+JSON.stringify(pathToFileURL(imported).href)+';test("parent",{concurrency:true},async t=>{await Promise.all([t.test("same",async()=>{await new Promise(r=>setTimeout(r,10))}),t.test("same",()=>{})])});test("platform skip",{skip:process.platform!=="darwin"},()=>{});');
  // Forward generated coverage attribution only; never a preload or ambient credentials.
  const env={PATH:process.env.PATH,...(process.env.NODE_V8_COVERAGE?{NODE_V8_COVERAGE:process.env.NODE_V8_COVERAGE}:{})};
  const out=execFileSync(process.execPath,['--test','--test-concurrency=1','--test-reporter',reporter,entry],{cwd:root,env,encoding:'utf8',timeout:15000,maxBuffer:1<<20});
  const rows=out.trim().split('\n').map(x=>JSON.parse(x)),producer=rows[0],terminals=rows.filter(x=>x.event==='test:complete'),summaries=rows.filter(x=>x.event==='test:summary');
  assert.equal(producer.runtime.node,process.version);assert.equal(producer.runtime.platform,process.platform);assert.match(producer.runtime.executableSha256,/^[a-f0-9]{64}$/);assert.match(producer.reporterSha256,/^[a-f0-9]{64}$/);
  const parent=terminals.find(x=>x.data.name==='parent')!,siblings=terminals.filter(x=>x.data.name==='same'),definition=terminals.find(x=>x.data.name==='imported definition')!;
  assert.equal(siblings.length,2);assert.notEqual(siblings[0].data.testId,siblings[1].data.testId);assert(siblings.every(x=>x.data.parentId===parent.data.testId&&x.data.entryFile===entry));assert.equal(definition.data.entryFile,entry);assert.equal(definition.data.file,imported);
  assert.equal(summaries.length,2);assert.equal(summaries[0].data.file,entry);assert.equal(summaries[1].data.file,null);assert.deepEqual(summaries[0].data.counts,summaries[1].data.counts);assert.equal(summaries[1].data.counts.tests,5);assert.equal(summaries[1].data.counts.skipped,process.platform==='darwin'?0:1);
  for(const row of rows){assert.equal(row.dispatchAllowed,false);assert.equal(row.fullCorpusQualified,false);assert.equal(row.authorPass,false);assert.equal(row.liveNarrowingAllowed,false);}
 }finally{rmSync(root,{recursive:true});}
});
test('platform metadata never substitutes missing identity or counts and retains raw skip and failure states',()=>{
 const skipped=platformEventRecord({type:'test:complete',data:{skip:'linux-only omission',details:{passed:true,type:'test'}}})!;
 const data=skipped.data as Record<string,unknown>;assert.equal(data.entryFile,null);assert.equal(data.testId,null);assert.equal(data.parentId,null);assert.equal(data.skip,'linux-only omission');
 const summary=platformEventRecord({type:'test:summary',data:{counts:{tests:2,failed:1},success:false}})!;
 const counts=(summary.data as {counts:Record<string,unknown>}).counts;assert.equal(counts.failed,1);assert.equal(counts.passed,null);assert.equal(counts.skipped,null);
 const failed=platformEventRecord({type:'test:complete',data:{details:{passed:false,error:new Error('fixture failure')}}})!;assert.equal((failed.data as {details:{passed:boolean}}).details.passed,false);
});
test('platform metadata records interruptions and never copies arbitrary test output',()=>{
 for(const type of ['test:interrupted','test:watch:restarted'])assert.equal(platformEventRecord({type})!.state,'UNKNOWN_INTERRUPTED_OR_WATCH_RUN');
 for(const type of ['test:stdout','test:stderr','test:diagnostic','not-modeled'])assert.equal(platformEventRecord({type,data:{message:'do not copy'}}),null);
 assert.equal(platformEventRecord(undefined),null);
 const plan=platformEventRecord({type:'test:plan',data:{count:3}})!;assert.equal((plan.data as {count:number}).count,3);
});
test('platform failure metadata preserves the failed outcome without serializing arbitrary error details',()=>{
 const secret='PRIVATE_ASSERTION_ACTUAL_VALUE',error=Object.assign(new Error(secret),{name:secret,code:secret,cause:{secret}});
 const failed=platformEventRecord({type:'test:complete',data:{details:{passed:false,error}}})!;
 assert.equal((failed.data as {details:{passed:boolean}}).details.passed,false);
 assert.deepEqual((failed.data as {details:{error:unknown}}).details.error,{present:true});
 assert(!JSON.stringify(failed).includes(secret),'error name/code/message/cause must not enter observational metadata');
});
