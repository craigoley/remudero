import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,unlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {test,type TestContext} from 'node:test';
// @ts-expect-error — ESM provenance helper outside source tsconfig roots.
import {authorDependencyProvenance,sameAuthorDependencyProvenance} from '#scripts/lib/author-dependency-provenance.mjs';
import {gitRepo} from '#test/helpers/git-repo.js';
test('author dependency precheck proves its installed corpus and refuses vanished symlink donors before expensive work',t=>{
 const root=mkdtempSync(join(tmpdir(),'rmd-dependency-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const donor=join(root,'donor'),view=join(root,'view');mkdirSync(donor);mkdirSync(view);mkdirSync(join(donor,'pkg'));mkdirSync(join(donor,'.bin'));
 writeFileSync(join(donor,'pkg/package.json'),JSON.stringify({version:'1.0.0'}));
 for(const name of ['tsx','tsc','commitlint'])writeFileSync(join(donor,'.bin',name),'tool');
 symlinkSync(donor,join(view,'node_modules'));
 writeFileSync(join(view,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/pkg':{version:'1.0.0'},'node_modules/optional':{version:'1',optional:true}}}));
 const good=authorDependencyProvenance(view);assert.equal(good.state,'present');assert.equal(good.installedPackages,1);assert.equal(good.optionalAbsent,1);
 assert.equal(sameAuthorDependencyProvenance(good,authorDependencyProvenance(view)),true);
 writeFileSync(join(donor,'pkg/package.json'),JSON.stringify({version:'2.0.0'}));assert.equal(authorDependencyProvenance(view).state,'unavailable');
 writeFileSync(join(donor,'pkg/package.json'),JSON.stringify({version:'1.0.0'}));writeFileSync(join(donor,'.bin/tsc'),'changed');
 assert.equal(sameAuthorDependencyProvenance(good,authorDependencyProvenance(view)),false);
 rmSync(donor,{recursive:true});assert.equal(authorDependencyProvenance(view).state,'unavailable');
 assert.equal(sameAuthorDependencyProvenance(good,authorDependencyProvenance(view)),false);
});

function wrappedCompiler(t: TestContext) {
 const repo=gitRepo({scope:t,kind:'dependency-wrapper',seedCommit:false}),owner=repo.dir;
 // Physical payload paths avoid writes through a node_modules segment in the author sandbox.
 const donor=join(owner,'payload'),view=join(owner,'view'),entry=join(owner,'scripts/tsc-entry.mjs');
 for(const path of [join(donor,'.bin'),join(donor,'typescript/bin'),join(owner,'scripts'),view])mkdirSync(path,{recursive:true});
 const lock={lockfileVersion:3,packages:{'node_modules/typescript':{version:'7.0.2'}}};
 writeFileSync(join(owner,'.gitignore'),'node_modules\npayload/\nview/\n');
 writeFileSync(join(owner,'package-lock.json'),JSON.stringify(lock));
 writeFileSync(join(view,'package-lock.json'),JSON.stringify(lock));
 writeFileSync(join(donor,'typescript/package.json'),JSON.stringify({name:'typescript',version:'7.0.2'}));
 writeFileSync(join(donor,'typescript/bin/tsc'),'// fixture compiler; never executed\n');
 writeFileSync(entry,'// fixture admission wrapper; never executed\n');
 for(const name of ['tsx','commitlint'])writeFileSync(join(donor,'.bin',name),'tool');
 symlinkSync(donor,join(owner,'node_modules'));symlinkSync(donor,join(view,'node_modules'));
 symlinkSync(entry,join(donor,'.bin/tsc'));
 repo.git('add','.gitignore','package-lock.json','scripts/tsc-entry.mjs');repo.git('commit','-m','test: tracked admission wrapper');
 return {repo,owner,donor,view,entry,lock};
}

test('author dependency precheck admits only the install-owned tracked wrapper with its locked compiler',t=>{
 const f=wrappedCompiler(t),before=readFileSync(f.entry),good=authorDependencyProvenance(f.view);
 assert.equal(good.state,'present',JSON.stringify(good));
 assert.equal(sameAuthorDependencyProvenance(good,authorDependencyProvenance(f.view)),true);
 assert.deepEqual(readFileSync(f.entry),before,'metadata inspection never executes or rewrites the wrapper');
 writeFileSync(join(f.donor,'typescript/bin/tsc'),'// changed compiler bytes\n');
 assert.equal(authorDependencyProvenance(f.view).state,'present');
 assert.equal(sameAuthorDependencyProvenance(good,authorDependencyProvenance(f.view)),false,'compiler changes invalidate earlier evidence');
 writeFileSync(f.entry,'// modified admission wrapper\n');
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','a modified tracked path is not a tracked-byte attestation');
 writeFileSync(f.entry,before);assert.equal(authorDependencyProvenance(f.view).state,'present');
});

test('author dependency precheck refuses foreign untracked and symlinked wrapper escapes',t=>{
 const f=wrappedCompiler(t),bin=join(f.donor,'.bin/tsc');
 assert.equal(authorDependencyProvenance(f.view).state,'present','the real tracked Git fixture is the positive control');
 const foreign=join(f.owner,'foreign');mkdirSync(foreign);mkdirSync(join(foreign,'scripts'));
 const other=join(foreign,'scripts/tsc-entry.mjs');writeFileSync(other,readFileSync(f.entry));
 unlinkSync(bin);symlinkSync(other,bin);
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','same basename and bytes in another owner are insufficient');
 unlinkSync(bin);symlinkSync(f.entry,bin);
 f.repo.git('rm','--cached','scripts/tsc-entry.mjs');f.repo.git('commit','-m','test: remove tracked wrapper');
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','an untracked install-owned file still refuses');
 f.repo.git('add','scripts/tsc-entry.mjs');f.repo.git('commit','-m','test: restore tracked wrapper');
 unlinkSync(f.entry);symlinkSync(other,f.entry);
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','a tracked pathname cannot vouch for an escaped replacement');
});

test('author dependency precheck refuses an absent unlocked wrong-version or escaped compiler behind the wrapper',t=>{
 const f=wrappedCompiler(t),compiler=join(f.donor,'typescript/bin/tsc'),bytes=readFileSync(compiler);
 assert.equal(authorDependencyProvenance(f.view).state,'present');
 unlinkSync(compiler);assert.equal(authorDependencyProvenance(f.view).state,'unavailable');
 const outside=join(f.owner,'outside-compiler');writeFileSync(outside,bytes);symlinkSync(outside,compiler);
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','the locked package cannot route its compiler outside the donor');
 unlinkSync(compiler);writeFileSync(compiler,bytes);
 writeFileSync(join(f.donor,'typescript/package.json'),JSON.stringify({version:'7.0.3'}));
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable');
 writeFileSync(join(f.donor,'typescript/package.json'),JSON.stringify({name:'typescript',version:'7.0.2'}));
 writeFileSync(join(f.view,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/optional':{version:'1',optional:true}}}));
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','no positive locked compiler control means no admission');
});

test('author dependency wrapper attestation ignores inherited foreign Git routing and refuses a missing repository',t=>{
 const f=wrappedCompiler(t),foreign=gitRepo({scope:t,kind:'dependency-foreign'}),prior=process.env.GIT_DIR;
 process.env.GIT_DIR=join(foreign.dir,'.git');
 try{assert.equal(authorDependencyProvenance(f.view).state,'present','Git must read the physical install owner, not inherited routing');}
 finally{if(prior===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=prior;}
 rmSync(join(f.owner,'.git'),{recursive:true});
 assert.equal(authorDependencyProvenance(f.view).state,'unavailable','an unreadable Git attestation is unknown, never present');
});

test('author dependency precheck refuses ancestor resolution when the checkout donor is missing',t=>{
 const root=mkdtempSync(join(tmpdir(),'rmd-dependency-fallback-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const view=join(root,'view'),ancestor=join(root,'node_modules/pkg');mkdirSync(view);mkdirSync(ancestor,{recursive:true});
 writeFileSync(join(ancestor,'package.json'),JSON.stringify({name:'pkg',version:'1.0.0',main:'index.js'}));
 writeFileSync(join(ancestor,'index.js'),'module.exports = true;');
 writeFileSync(join(view,'package.json'),JSON.stringify({name:'fixture'}));
 writeFileSync(join(view,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/pkg':{version:'1.0.0'}}}));
 symlinkSync(join(root,'vanished-donor'),join(view,'node_modules'));
 assert.equal(createRequire(join(view,'package.json')).resolve('pkg'),join(ancestor,'index.js'),
  'positive control: normal module loading silently finds an ancestor installation');
 assert.equal(authorDependencyProvenance(view).state,'unavailable',
  'an ancestor package must never qualify this checkout or its absolute CLI entry');
});
