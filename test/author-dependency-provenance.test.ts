import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
// @ts-expect-error — ESM provenance helper outside source tsconfig roots.
import {authorDependencyProvenance,sameAuthorDependencyProvenance} from '../scripts/lib/author-dependency-provenance.mjs';
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
