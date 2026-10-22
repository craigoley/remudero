/** @source-text-subject: .github/workflows/ci.yml single coverage admission owner and consumers. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RMD_TMP_PREFIX } from '../src/lib/tmp.js';
import { ghShim } from './helpers/gh-shim.js';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
const steps = (job: string) => doc.jobs[job].steps as Array<{name?:string;run?:string;uses?:string;with?:Record<string,unknown>}>;
const step = (job: string, name: string) => {
  const found = steps(job).find((s) => s.name === name || s.name?.startsWith(name + ' ('));
  assert.ok(found?.run, `${job} needs ${name}`); return found.run;
};
const body = (job: string, name: string) => step(job, name).replaceAll('${{ matrix.shard }}','1')
  .replaceAll('${{ steps.classify.outputs.class }}','SOURCE').replaceAll('${{ steps.coverage-artifact.outputs.class }}','SOURCE');
const version = spawnSync('bash',['--version'],{encoding:'utf8'}).stdout;
const mapfile = /^GNU bash, version 3\./.test(version) ? 'mapfile() { local target="$2" line; eval "$target=()"; while IFS= read -r line; do eval "$target+=(\\\"\\$line\\\")"; done; }\n' : '';
function run(t: {after(fn:()=>void):void}, shell: string, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(),`${RMD_TMP_PREFIX}pinned-workflow-`)); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const gh = ghShim([{ when: '', stderr: 'unexpected gh call', exit: 97 }]);
  t.after(() => rmSync(gh.dir, { recursive: true, force: true }));
  mkdirSync(join(root,'bin')); writeFileSync(join(root,'changed-files.txt'),'src/control.ts\n');
  const node = `#!/usr/bin/env bash
printf 'node %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = scripts/coverage-floor.mjs ]; then
  case "$2" in
    select) mkdir -p "$3"; echo all > "$3/mode"; if [ "\${PIN_FORCE_ELIGIBLE:-0}" = 1 ] || { [ "$GITHUB_EVENT_NAME" = pull_request ] && [ "\${RMD_AFFECTED_SUITE_LIVE:-0}" = 1 ] && [ "\${FLOOR_AVAILABLE:-0}" = 1 ]; }; then echo eligible > "$3/mode"; fi ;;
    mode) [ "\${PIN_BROKEN:-0}" = 0 ] || exit 3; cat "$3/mode" ;;
    finalize) if [ "\${CANDIDATES_REFUSED:-0}" = 1 ]; then echo all > "$3/mode"; else echo narrow > "$3/mode"; fi ;;
    shard) [ "\${PIN_BROKEN:-0}" = 0 ] || exit 3; echo test/narrow.test.ts ;;
    verify-shards) [ "\${PIN_BROKEN:-0}" = 0 ] || exit 3; mode=$(cat "$3/mode"); for n in 1 2 3 4 5 6 7 8; do [ "$(cat "$4/coverage-shard-$n/selection")" = "$mode" ] || exit 4; done ;;
    *) exit 5 ;;
  esac
elif [[ "$*" = *'--import tsx -e'* ]]; then for last; do :; done; printf 'test/narrow.test.ts\\n' > "$last"
elif [[ "$*" = *'--select-all'* ]]; then echo test/full.test.ts
elif [[ "$*" = *'test-with-retry.mjs'* ]]; then mkdir -p coverage/raw; echo SF:src/control.ts > coverage/lcov.info; echo '{}' > coverage/raw/coverage-1.json; echo '# tests 1'
fi
`;
  for (const [name, text] of [['node',node],['git','#!/usr/bin/env bash\necho "git $*" >> "$CALL_LOG"\n']]) {
    writeFileSync(join(root,'bin',name),text); chmodSync(join(root,'bin',name),0o755);
  }
  writeFileSync(join(root,'run.sh'),mapfile+shell);
  const result=spawnSync('bash',['--noprofile','--norc','-e',join(root,'run.sh')],{cwd:root,encoding:'utf8',env:{...process.env,PATH:join(root,'bin')+':'+gh.dir+':'+process.env.PATH,RUNNER_TEMP:root,CALL_LOG:join(root,'calls'),GITHUB_STEP_SUMMARY:join(root,'summary'),...env}});
  const read=(path:string)=>existsSync(join(root,path))?readFileSync(join(root,path),'utf8'):'';
  return {status:result.status,out:result.stdout+result.stderr,calls:read('calls')+gh.calls().map(call=>'unexpected gh '+call).join('\n'),read};
}
const owner=body('squash-trailer-gate','Pin one verified historical coverage floor before any narrowing');
const collect=body('coverage-ratchet','Test with coverage');
const ratchet=body('coverage-ratchet-required','Coverage ratchet');
const pin=(mode:string)=>`mkdir -p coverage-floor-pin; echo ${mode} > coverage-floor-pin/mode\n`;
const shards=(mode:string)=>Array.from({length:8},(_,i)=>`mkdir -p coverage-shards/coverage-shard-${i+1}; echo ${mode} > coverage-shards/coverage-shard-${i+1}/selection`).join('\n')+'\n';

test('W1-T5705: a successful compatible pin lets the owner select once and coverage consume that narrow shard',t=>{
  const result=run(t,owner+'\n'+collect,{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1',FLOOR_AVAILABLE:'1'});
  assert.equal(result.status,0,result.out); assert.equal(result.read('coverage-selection.txt').trim(),'narrow');
  assert.equal((result.calls.match(/node --import tsx -e/g)??[]).length,1);
  assert.match(result.calls,/coverage-floor\.mjs select coverage-floor-pin/);
  assert.match(result.calls,/coverage-floor\.mjs finalize coverage-floor-pin coverage-narrow-suites\.txt/);
  assert.match(result.calls,/coverage-floor\.mjs shard coverage-floor-pin 1/);
  assert.doesNotMatch(result.calls,/--select-all|unexpected gh/);
  assert.equal(result.read('coverage-test-files.txt').trim(),'test/narrow.test.ts');
});

test('W1-T5705: flag off, missing floor, refused candidates and final merge group retain full selection',t=>{
  assert.equal(doc.env.RMD_AFFECTED_SUITE_LIVE,'0');
  for (const env of [{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'0'},
    {GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1'},
    {GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1',FLOOR_AVAILABLE:'1',CANDIDATES_REFUSED:'1'},
    {GITHUB_EVENT_NAME:'merge_group',RMD_AFFECTED_SUITE_LIVE:'1',FLOOR_AVAILABLE:'1'}]) {
    const result=run(t,owner+'\n'+collect,env); assert.equal(result.status,0,result.out);
    assert.equal(result.read('coverage-selection.txt').trim(),'all'); assert.match(result.calls,/--select-all --shard 1\/8 --base HEAD\^1/);
    assert.doesNotMatch(result.calls,/coverage-floor\.mjs shard/);
  }
  const push=run(t,collect,{GITHUB_EVENT_NAME:'push',RMD_AFFECTED_SUITE_LIVE:'1'});
  assert.equal(push.status,0,push.out); assert.equal(push.calls,'');
});

test('W1-T5705: an unreadable pinned decision fails before the instrumented runner and never selects another floor',t=>{
  const result=run(t,pin('narrow')+collect,{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1',PIN_BROKEN:'1'});
  assert.notEqual(result.status,0); assert.doesNotMatch(result.calls,/test-with-retry|--select-all|unexpected gh/);
});

test('the floor owner cannot use a PR first parent on push even when a pin says eligible',t=>{
  const result=run(t,owner,{GITHUB_EVENT_NAME:'push',RMD_AFFECTED_SUITE_LIVE:'1',FLOOR_AVAILABLE:'1',PIN_FORCE_ELIGIBLE:'1'});
  assert.equal(result.status,0,result.out);
  assert.equal(result.read('coverage-floor-pin/mode').trim(),'eligible','the control must actually supply its claimed eligible pin');
  assert.match(result.calls,/coverage-floor\.mjs select coverage-floor-pin/);
  assert.doesNotMatch(result.calls,/git |--import tsx -e|coverage-floor\.mjs finalize|unexpected gh/);
});

test('W1-T5705: every source shard and the aggregator download the same current-run pin with stable names',()=>{
  assert.deepEqual(doc.jobs['coverage-ratchet'].needs,['coverage-ledger']);
  const shard = steps('coverage-ratchet');
  const waiting = shard.findIndex(s => s.run?.includes('coverage-floor.mjs wait-pin'));
  const download = shard.findIndex(s => s.uses?.startsWith('actions/download-artifact@') && s.with?.['artifact-ids'] === '${{ steps.coverage-pin.outputs.artifact_id }}');
  assert.ok(waiting > shard.findIndex(s => s.name === 'Install (clean, from lockfile)'));
  assert.equal(download, waiting + 1);
  assert.ok(download < shard.findIndex(s => s.name?.startsWith('Test with coverage')));
  assert.equal(shard[download].with?.path, 'coverage-floor-pin');
  assert.equal(shard[download].with?.['digest-mismatch'], 'error');
  const name = 'coverage-floor-pin-${{ github.run_attempt }}';
  assert.ok(steps('coverage-ratchet-required').some(s=>s.uses?.startsWith('actions/download-artifact@')&&s.with?.name===name&&s.with?.path==='coverage-floor-pin'));
  assert.ok(steps('squash-trailer-gate').some(s=>s.uses?.startsWith('actions/upload-artifact@')&&s.with?.name===name));
  assert.equal(doc.jobs['coverage-ratchet-required'].name,'coverage-ratchet');
  const stage=step('coverage-ratchet','Stage this coverage shard for the required-check aggregator');
  assert.match(stage,/coverage-artifact\/selection/); assert.match(stage,/coverage-artifact\/suites/); assert.match(stage,/coverage-artifact\/test-exit/);
});

test('W1-T5705: the absolute floor reads the pin while current added-line coverage reads current LCOV',t=>{
  const narrow=run(t,pin('narrow')+shards('narrow')+ratchet,{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1'});
  assert.equal(narrow.status,0,narrow.out); assert.match(narrow.calls,/coverage-ratchet\.mjs --lcov coverage-floor-pin\/lcov\.info/);
  assert.doesNotMatch(narrow.calls,/unexpected gh|--lcov coverage\/lcov\.info/);
  const mismatch=run(t,pin('narrow')+shards('all')+ratchet,{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1'});
  assert.notEqual(mismatch.status,0); assert.doesNotMatch(mismatch.calls,/coverage-ratchet\.mjs/);
  const broken=run(t,pin('narrow')+shards('narrow')+ratchet,{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1',PIN_BROKEN:'1'});
  assert.notEqual(broken.status,0); assert.doesNotMatch(broken.calls,/coverage-ratchet\.mjs/);
  const full=run(t,pin('all')+shards('all')+ratchet,{GITHUB_EVENT_NAME:'pull_request',RMD_AFFECTED_SUITE_LIVE:'1'});
  assert.equal(full.status,0,full.out); assert.match(full.calls,/coverage-ratchet\.mjs --lcov coverage\/lcov\.info/);
  assert.match(step('coverage-ratchet-required','Diff coverage'),/diff-coverage\.mjs --lcov coverage\/lcov\.info --diff pr\.diff/);
});

test('W1-T5705: the single owner inline selector still runs for real against the repo',t=>{
  const script=/node --import tsx -e '\n([\s\S]*?)\n\s*' changed-files\.txt "\$\{RUNNER_TEMP\}\/affected\.diff" coverage-narrow-suites\.txt/.exec(owner);
  assert.ok(script,'one owner must execute the real affected-suite selector');
  const root=mkdtempSync(join(tmpdir(),`${RMD_TMP_PREFIX}single-selector-`));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'changed'),'.github/workflows/ci.yml\n');writeFileSync(join(root,'diff'),'');
  const result=spawnSync(process.execPath,['--import','tsx','-e',script[1],join(root,'changed'),join(root,'diff'),join(root,'out')],{cwd:ROOT,encoding:'utf8',env:{...process.env,GITHUB_WORKSPACE:ROOT}});
  assert.equal(result.status,0,result.stdout+result.stderr); assert.equal(readFileSync(join(root,'out'),'utf8'),'full\n');
});
