import {closeSync,constants,fstatSync,openSync,readSync,statSync,type Stats} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** BACKSTOP: bounded advisory text, not a claim that a larger proof target is absent. */
export const PROOF_FILE_READ_BYTES=4*1024**2;
/** BACKSTOP: this protocol carries path components only, never source or execution instructions. */
export const PROOF_FILE_REQUEST_BYTES=8192;
const sameDirectory=(a:Stats,b:Stats)=>a.isDirectory()&&b.isDirectory()&&a.dev===b.dev&&a.ino===b.ino;
function readBounded(fd:number,maximum:number):Buffer {
 const parts:Buffer[]=[];let used=0;
 for(;;){const b=Buffer.alloc(Math.min(65536,maximum+1-used)),n=readSync(fd,b);if(n===0)break;used+=n;if(used>maximum)throw Error('read bound');parts.push(b.subarray(0,n));}
 return Buffer.concat(parts);
}
function readPinnedFile():Buffer {
 if(!['linux','darwin'].includes(process.platform))throw Error('unqualified filesystem platform');
 const request=JSON.parse(readBounded(0,PROOF_FILE_REQUEST_BYTES).toString('utf8')) as {parts?:unknown};
 if(!Array.isArray(request.parts)||request.parts.length<1||request.parts.length>128||request.parts.some(x=>typeof x!=='string'||x.length===0||x==='.'||x==='..'||x.includes('/')||x.includes('\\')||x.includes('\0')))throw Error('invalid relative components');
 if(!sameDirectory(fstatSync(3),statSync('.')))throw Error('root identity changed');
 const parts=request.parts as string[];
 // Only this disposable child changes cwd. Each cwd is the already-open verified inode:
 // no previously checked ancestor is re-resolved when opening the next component.
 for(const component of parts.slice(0,-1)) {
  const fd=openSync(component,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const opened=fstatSync(fd);process.chdir(component);if(!sameDirectory(opened,statSync('.')))throw Error('directory changed while entering');}
  finally {closeSync(fd);}
 }
 const fd=openSync(parts.at(-1)!,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd);if(!before.isFile()||before.size>PROOF_FILE_READ_BYTES)throw Error('not bounded regular source');
  const bytes=readBounded(fd,PROOF_FILE_READ_BYTES),after=fstatSync(fd);
  if(!after.isFile()||before.dev!==after.dev||before.ino!==after.ino||before.size!==bytes.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('source changed during read');
  return bytes;
 }finally {closeSync(fd);}
}
if(process.argv[1]!==undefined&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {if(process.argv.length!==2)throw Error('unexpected arguments');const bytes=readPinnedFile();closeSync(3);process.stdout.write(bytes);}
 catch {process.stderr.write('proof file read refused\n');process.exitCode=1;}
}
