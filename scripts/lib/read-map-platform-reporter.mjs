// Metadata-only SECOND reporter, selected explicitly by a source-qualified shadow producer.
// No N/A classification, read-map promotion, test selection, gate change or file write.
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {fileURLToPath} from 'node:url';

const safety=Object.freeze({dispatchAllowed:false,liveNarrowingAllowed:false,productionCoverageChanged:false,authorPass:false,fullCorpusQualified:false});
function digest(path){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{const before=fstatSync(fd);if(!before.isFile())throw Error('reporter input is not regular');const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;
  for(;;){const n=readSync(fd,buffer);if(!n)break;count+=n;hash.update(buffer.subarray(0,n));}
  const after=fstatSync(fd);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==count||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('reporter input changed');return hash.digest('hex');
 }finally{closeSync(fd);}
}
/** Missing public event fields remain null/UNKNOWN; never derive lineage from concurrent nesting. */
export function platformEventRecord(event){
 const d=event?.data??{},base={format:'rmd-platform-test-event-v1',event:event?.type,...safety};
 if(['test:enqueue','test:dequeue','test:complete'].includes(event?.type)){
  const data=Object.fromEntries(['entryFile','file','line','column','testId','parentId','name','nesting','testNumber','skip','todo','tags'].map(k=>[k,d[k]??null]));
  data.type=d.details?.type??d.type??null;
  // Assertion errors can embed private actual/expected values in every error field.
  // Outcome and error presence suffice here; diagnostic content belongs to the primary reporter.
  if(event.type==='test:complete')data.details={passed:d.details?.passed??null,duration_ms:d.details?.duration_ms??null,error:d.details?.error?{present:true}:null};
  return {...base,data};
 }
 if(event?.type==='test:summary')return {...base,data:{file:d.file??null,counts:Object.fromEntries(['tests','passed','failed','cancelled','skipped','todo','suites','topLevel'].map(k=>[k,d.counts?.[k]??null])),success:d.success??null,duration_ms:d.duration_ms??null}};
 if(event?.type==='test:plan')return {...base,data:{file:d.file??null,entryFile:d.entryFile??null,nesting:d.nesting??null,count:d.count??null}};
 if(event?.type==='test:interrupted'||event?.type?.startsWith('test:watch:'))return {...base,state:'UNKNOWN_INTERRUPTED_OR_WATCH_RUN'};
 return null; // Omit arbitrary stdout/stderr, diagnostics and error detail; identity fields remain test metadata.
}
export default async function* readMapPlatformReporter(events){
 yield JSON.stringify({format:'rmd-platform-test-event-v1',event:'producer',runtime:{node:process.version,platform:process.platform,arch:process.arch,executableSha256:digest(process.execPath)},reporterSha256:digest(fileURLToPath(import.meta.url)),state:'RAW_SHADOW_METADATA_NOT_QUALIFIED',...safety})+'\n';
 for await(const event of events){const record=platformEventRecord(event);if(record)yield JSON.stringify(record)+'\n';}
}
