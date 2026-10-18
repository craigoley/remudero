import {spawn,type ExecFileSyncOptionsWithStringEncoding} from 'node:child_process';
import {closeSync,constants,fstatSync,openSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROOF_FILE_READ_BYTES,PROOF_FILE_REQUEST_BYTES} from './proof-file-reader-child.js';

/** BACKSTOP: advisory normalization cannot stall a review on a filesystem or child read. */
export const PROOF_FILE_READ_TIMEOUT_MS=2000;
type ReaderExec=(file:string,args:string[],options:ExecFileSyncOptionsWithStringEncoding)=>string|Promise<string>;
class ProofFileAbsent extends Error {}
export type ProofFileObservation={state:'read';text:string}|{state:'absent'|'unavailable';reason:string};
function spawnProofReader(file:string,args:string[],options:ExecFileSyncOptionsWithStringEncoding):Promise<string> {
 return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{cwd:options.cwd,env:options.env,stdio:options.stdio});
  const chunks:Buffer[]=[],errors:Buffer[]=[];let bytes=0,stderrBytes=0,refused:Error|undefined;
  const refuse=(error:Error)=>{refused??=error;child.kill('SIGKILL');};
  const timer=setTimeout(()=>refuse(Error('proof source read timeout')),PROOF_FILE_READ_TIMEOUT_MS);
  child.once('error',error=>{refused=error;});
  child.stdin!.on('error',error=>refuse(error));
  child.stdout!.on('error',error=>refuse(error));child.stderr!.on('error',error=>refuse(error));
  child.stdout!.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>PROOF_FILE_READ_BYTES)refuse(Error('proof source output bound'));else if(!refused)chunks.push(chunk);});
  child.stderr!.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65536)refuse(Error('proof source error output bound'));else if(!refused)errors.push(chunk);});
  child.once('close',(code,signal)=>{clearTimeout(timer);if(!refused&&!signal&&code===3&&bytes===0&&Buffer.concat(errors).toString('utf8')==='proof file absent\n')reject(new ProofFileAbsent('descriptor-observed missing target'));else if(refused||code!==0||signal||stderrBytes>0)reject(refused??Error('proof source child refused'));else resolve(Buffer.concat(chunks).toString('utf8'));});
  child.stdin!.end(options.input);
 });
}
/** Descriptor-pinned source read. A root alias is trusted as the caller's root only at its first open.
 * Descendant aliases are canonicalized, then walked without following replacement symlinks.
 * Failure means no advisory, not proof that the literal is absent. No parent cwd is changed.
 * Child read attribution remains a separate shadow-mapping obligation; no selector is enabled here. */
export async function observeProofFileInside(root:string,target:string,run:ReaderExec=spawnProofReader):Promise<ProofFileObservation> {
 let fd:number|undefined;
 try {
  if(![constants.O_DIRECTORY,constants.O_NOFOLLOW,constants.O_NONBLOCK].every(flag=>Number.isInteger(flag)&&flag>0))return {state:'unavailable',reason:'required descriptor flags unavailable'};
  fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY);
  if(!fstatSync(fd).isDirectory())return {state:'unavailable',reason:'root is not a directory'};
  const realRoot=realpathSync(root),requested=join(realRoot,target);let realTarget:string;
  try{realTarget=realpathSync(requested);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;realTarget=requested;}
  // A pathname ENOENT requests a descriptor walk; it is not itself absence evidence.
  const path=relative(realRoot,realTarget);
  if(path===''||isAbsolute(path)||path.split(sep).includes('..'))return {state:'unavailable',reason:'target escaped root or named the root'};
  const request=JSON.stringify({parts:path.split(sep)});if(Buffer.byteLength(request)>PROOF_FILE_REQUEST_BYTES)return {state:'unavailable',reason:'bounded protocol exceeded'};
  const child=fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith('.ts')?'./proof-file-reader-child.ts':'./proof-file-reader-child.js',import.meta.url));
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH};
  if(process.env.NODE_V8_COVERAGE)env.NODE_V8_COVERAGE=process.env.NODE_V8_COVERAGE; // Explicit generated coverage only, never preloads or credentials.
  const text=await run(process.execPath,[child],{cwd:realRoot,stdio:['pipe','pipe','pipe',fd],encoding:'utf8',input:request,
   timeout:PROOF_FILE_READ_TIMEOUT_MS,maxBuffer:PROOF_FILE_READ_BYTES,env});
  return {state:'read',text};
 }catch(error) {
  // Only the trusted child's exact missing-component protocol is absence; all other failures are UNKNOWN.
  return error instanceof ProofFileAbsent?{state:'absent',reason:error.message}:{state:'unavailable',reason:'descriptor source read refused or incomplete'};
 }
 finally {if(fd!==undefined)closeSync(fd);}
}

/** Text compatibility view. Absence-sensitive callers must use the typed observation. */
export async function readProofFileInside(root:string,target:string,run:ReaderExec=spawnProofReader):Promise<string|undefined>{const observed=await observeProofFileInside(root,target,run);return observed.state==='read'?observed.text:undefined;}
