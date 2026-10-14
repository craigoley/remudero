import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {join,sep} from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const atom=part=>part!=='.'&&part!=='..'&&!part.includes('\0');
const boundedRead=path=>{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const st=fstatSync(fd),limit=4*1024*1024;
  if(!st.isFile()||st.size>limit)throw Error('dependency metadata is not a bounded regular file');
  const buffer=Buffer.alloc(st.size+1);let used=0;
  while(used<buffer.length){const n=readSync(fd,buffer,used,buffer.length-used,used);if(!n)break;used+=n;}
  const after=fstatSync(fd);
  if(used!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)throw Error('dependency metadata changed during descriptor read');
  return buffer.subarray(0,used);
 }finally{closeSync(fd);}
};

/** Cheap metadata/tool precheck, NOT a byte attestation or authority to reuse tests.
 * Records the real dependency donor so disappearance through a symlink is visible.
 */
export function authorDependencyProvenance(root) {
 try {
  const lockBytes=boundedRead(join(root,'package-lock.json')),lock=JSON.parse(lockBytes);
  if(lock.lockfileVersion!==3||!lock.packages||typeof lock.packages!=='object')throw Error('complete v3 lock metadata required');
  const dependencyRoot=realpathSync(join(root,'node_modules')),identity=statSync(dependencyRoot),rows=[];
  let optionalAbsent=0;
  for(const [path,entry] of Object.entries(lock.packages)) {
   if(!path.startsWith('node_modules/'))continue;
   if(path.startsWith('/')||!path.split('/').every(atom))throw Error('ambiguous locked dependency path');
   const expected=entry.link?lock.packages[entry.resolved]?.version:entry.version;
   if(typeof expected!=='string')throw Error('locked package version unavailable');
   let bytes;
   try{bytes=boundedRead(join(root,path,'package.json'));}
   catch(error){if(entry.optional&&error.code==='ENOENT'){optionalAbsent++;continue;}throw error;}
   const observed=JSON.parse(bytes);
   if(observed.version!==expected)throw Error(`installed package version differs: ${path}`);
   rows.push([path,expected,hash(bytes)]);
  }
  if(rows.length===0)throw Error('no positive installed dependency control');
  const tools=[];
  for(const name of ['tsx','tsc','commitlint']) {
   const path=realpathSync(join(root,'node_modules/.bin',name));
   if(!path.startsWith(dependencyRoot+sep))throw Error(`dependency tool escapes installed donor: ${name}`);
   tools.push([name,hash(boundedRead(path))]);
  }
  const after=statSync(realpathSync(join(root,'node_modules')));
  if(identity.dev!==after.dev||identity.ino!==after.ino)throw Error('dependency donor changed during measurement');
  return {state:'present',assurance:'installed-metadata-and-tool-bytes-only',dependencyRoot,dev:identity.dev,ino:identity.ino,
   lockSha256:hash(lockBytes),metadataSha256:hash(JSON.stringify(rows)),toolsSha256:hash(JSON.stringify(tools)),
   installedPackages:rows.length,optionalAbsent};
 }catch(error){return {state:'unavailable',reason:error.message};}
}

export function sameAuthorDependencyProvenance(first,next) {
 return first?.state==='present'&&next?.state==='present'&&JSON.stringify(first)===JSON.stringify(next);
}
