import {execFileSync,type ExecFileSyncOptionsWithStringEncoding} from 'node:child_process';
import {closeSync,constants,fstatSync,openSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROOF_FILE_READ_BYTES,PROOF_FILE_REQUEST_BYTES} from './proof-file-reader-child.js';

/** BACKSTOP: advisory normalization cannot stall a review on a filesystem or child read. */
export const PROOF_FILE_READ_TIMEOUT_MS=2000;
type ReaderExec=(file:string,args:string[],options:ExecFileSyncOptionsWithStringEncoding)=>string;
/** Descriptor-pinned source read. A root alias is trusted as the caller's root only at its first open.
 * Descendant aliases are canonicalized, then walked without following replacement symlinks.
 * Failure means no advisory, not proof that the literal is absent. No parent cwd is changed.
 * Child read attribution remains a separate shadow-mapping obligation; no selector is enabled here. */
export function readProofFileInside(root:string,target:string,run:ReaderExec=execFileSync):string|undefined {
 let fd:number|undefined;
 try {
  if(![constants.O_DIRECTORY,constants.O_NOFOLLOW,constants.O_NONBLOCK].every(flag=>Number.isInteger(flag)&&flag>0))return undefined;
  fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY);
  if(!fstatSync(fd).isDirectory())return undefined;
  const realRoot=realpathSync(root),realTarget=realpathSync(join(realRoot,target)),path=relative(realRoot,realTarget);
  if(path===''||isAbsolute(path)||path.split(sep).includes('..'))return undefined;
  const request=JSON.stringify({parts:path.split(sep)});if(Buffer.byteLength(request)>PROOF_FILE_REQUEST_BYTES)return undefined;
  const child=fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith('.ts')?'./proof-file-reader-child.ts':'./proof-file-reader-child.js',import.meta.url));
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH};
  if(process.env.NODE_V8_COVERAGE)env.NODE_V8_COVERAGE=process.env.NODE_V8_COVERAGE; // Explicit generated coverage only, never preloads or credentials.
  return run(process.execPath,[child],{cwd:realRoot,stdio:['pipe','pipe','pipe',fd],encoding:'utf8',input:request,
   timeout:PROOF_FILE_READ_TIMEOUT_MS,maxBuffer:PROOF_FILE_READ_BYTES,env});
 }catch {return undefined;} // Absent, denied, replaced or incomplete: none may manufacture an advisory.
 finally {if(fd!==undefined)closeSync(fd);}
}
