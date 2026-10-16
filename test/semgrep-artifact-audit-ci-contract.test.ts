import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parse} from 'yaml';

const auditor=new URL('../.github/semgrep/runtime-compatibility-audit.py',import.meta.url);
const cases=new URL('../.github/semgrep/test_runtime_compatibility_audit.py',import.meta.url);
const workflow=new URL('../.github/workflows/semgrep-runtime-compatibility.yml',import.meta.url);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('Semgrep policy changes require pinned audit controls before every candidate execution phase',()=>{
 const flow=parse(readFileSync(workflow,'utf8')),job=flow.jobs['runtime-compatibility'];
 const scope=job.steps.find((s:any)=>s.id==='scope');
 for(const path of ['requirements.txt','build-requirements.txt','runtime-compatibility-audit.py',
  'runtime_audit_test_fixtures.py','test_runtime_compatibility_audit.py'])assert.ok(scope.run.includes('.github/semgrep/'+path));
 assert.ok(scope.run.includes('.github/workflows/semgrep-runtime-compatibility.yml'));
 assert.ok(scope.run.includes('test-policy=true'));assert.ok(scope.run.includes('test-policy=false'));
 assert.equal(flow.on.pull_request.paths,undefined);assert.equal(flow.on.pull_request['paths-ignore'],undefined);
 const name='Test Semgrep artifact audit policy',units=job.steps.filter((s:any)=>s.name===name);
 assert.equal(units.length,1);const unit=units[0];assert.equal(unit.env.AUDIT_PHASE,'unit');
 assert.equal(unit.if,"steps.scope.outputs.test-policy == 'true'");
 assert.equal(unit['continue-on-error'],undefined);assert.equal(job.env.AUDITOR_SHA256,hash(readFileSync(auditor)));
 for(const name of ['Set up pinned Python','Create neutral private audit root'])
  assert.equal(job.steps.find((s:any)=>s.name===name).if,unit.if);
 for(const phase of ['download','original','build','built','install','verify']){
  const step=job.steps.find((s:any)=>s.env?.AUDIT_PHASE===phase);
  assert.ok(job.steps.indexOf(unit)<job.steps.indexOf(step));
  assert.equal(step.if,"steps.scope.outputs.changed == 'true'");assert.equal(step.run,unit.run);
 }
 assert.ok(unit.run.includes('"-I", "-S"'));assert.ok(unit.run.includes('git("cat-file", "blob", blob)'));
 assert.ok(unit.run.includes('hashlib.sha256(raw).hexdigest() == expected'));
});

test('Semgrep Python audit has its own CodeQL language without importing candidate artifacts',()=>{
 const flow=parse(readFileSync(new URL('../.github/workflows/codeql.yml',import.meta.url),'utf8'));
 const job=flow.jobs.analyze;
 assert.deepEqual(job.strategy.matrix.include.filter((row:any)=>row.language==='python'),[{language:'python','build-mode':'none'}]);
 assert.equal(job.steps.find((step:any)=>step.name==='Initialize CodeQL').with.languages,'${{ matrix.language }}');
 assert.equal(job.steps.find((step:any)=>step.name==='Perform CodeQL Analysis').with.category,'/language:${{ matrix.language }}');
 assert.equal(job.steps.some((step:any)=>/pip|semgrep|runtime-compatibility-audit/.test(step.run??'')),false);
 assert.equal(flow.on.pull_request['paths-ignore'].some((path:string)=>path.includes('.github')||path.includes('.py')),false);
});

test('Semgrep unit receipt rejects incomplete inventory source drift skips and qualification transfer',()=>{
 // Pure receipt/controller fixtures only: these claims are synthetic, NOT an
 // execution of Python 3.12.15 or of the 107 native artifact-audit controls.
 const script=String.raw`
import ast, copy, hashlib, json, pathlib, sys, tempfile, types
source=pathlib.Path(sys.argv[1]); raw=source.read_bytes()
p=types.ModuleType("receipt_contract_fixture");p.__file__=str(source)
exec(compile(raw,str(source),"exec"),p.__dict__)
tests=pathlib.Path(sys.argv[2]); tree=ast.parse(tests.read_bytes())
ids=list(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and
              any(isinstance(t,ast.Name) and t.id=="EXPECTED_TEST_IDS" for t in n.targets)))
expected=dict(p.AUDIT_TEST_SOURCES);expected[source.name]=p.digest(raw)
for name, value in p.AUDIT_TEST_SOURCES.items():
    assert p.digest(source.with_name(name).read_bytes()) == value
r={"schema":"semgrep-audit-unit-controls/v1","state":"SOURCE_MODULE_CONTROLS_PASS",
   **{k:107 for k in ("selected","executed","pass")},
   **{k:0 for k in ("fail","error","skipped","unrun","expectedFailures","unexpectedSuccesses")},
   **{k:True for k in ("complete","successful","inventoryClosed","successfulInventoryClosed","isolated","noSite","exactTargetPatchObserved")},
   **{k:False for k in ("qualified","linuxQualification","pinnedRuntimeQualified","runnerQualified")},
   "invariantErrors":[],"failures":[],"errors":[],"literalInventory":ids,
   "executedIds":list(reversed(ids)),"successfulIds":list(ids),"inventorySha256":p.AUDIT_TEST_INVENTORY,
   "sourceHashes":expected,"expectedAuditorSha256":expected[source.name],
   "pipWheelSha256":p.APPROVED_TOOLS["pip"][1],"pythonVersion":"3.12.15","platform":"linux","machine":"x86_64"}
p.verify_unit_receipt(r,expected); blocked=0
def refuse(row):
    global blocked
    try: p.verify_unit_receipt(row,expected)
    except (p.AuditBlocked,TypeError,ValueError): blocked+=1;return
    raise AssertionError("mutant unexpectedly accepted")
for key in r:
    bad=copy.deepcopy(r);del bad[key];refuse(bad)
for key in ("selected","executed","pass","fail","error","skipped","unrun","expectedFailures","unexpectedSuccesses"):
    for value in (True,False,str(r[key]),r[key]+1):
        bad=copy.deepcopy(r);bad[key]=value;refuse(bad)
for key in ("complete","successful","inventoryClosed","successfulInventoryClosed","isolated","noSite","exactTargetPatchObserved"):
    bad=copy.deepcopy(r);bad[key]=False;refuse(bad)
for key in ("qualified","linuxQualification","pinnedRuntimeQualified","runnerQualified"):
    bad=copy.deepcopy(r);bad[key]=True;refuse(bad)
for key,value in (("pythonVersion","3.12.3"),("platform","darwin"),("machine","aarch64"),
                  ("invariantErrors",["changed"]),("inventorySha256","0"*64),("pipWheelSha256","0"*64),
                  ("expectedAuditorSha256","0"*64),("sourceHashes",{})):
    bad=copy.deepcopy(r);bad[key]=value;refuse(bad)
for key in ("literalInventory","executedIds","successfulIds"):
    for value in (ids[:-1],ids+[ids[0]],ids[:-1]+["unknown.test"]):
        bad=copy.deepcopy(r);bad[key]=value;refuse(bad)
# Reuse a prior unit bootstrap only after verifying the real bytes, never by
# filename/existence. No network operation occurs in these refusal fixtures.
with tempfile.TemporaryDirectory(prefix="rmd-bootstrap-fixture-") as tmp:
    root=pathlib.Path(tmp);wheel=root/"pip-26.2.1-py3-none-any.whl";wheel.write_bytes(b"unapproved")
    try:p._bootstrap_pip(root)
    except p.AuditBlocked as error:assert error.code=="TOOL_HASH"
    else:raise AssertionError("unapproved cached pip accepted")
    wheel.unlink();wheel.symlink_to(root/"missing")
    try:p._bootstrap_pip(root)
    except (p.AuditBlocked,FileNotFoundError):pass
    else:raise AssertionError("dangling pip symlink accepted")
print(json.dumps({"positive":1,"refusedMutants":blocked,"inventory":len(ids)}))
`;
 const run=spawnSync('python3',['-I','-S','-',auditor.pathname,cases.pathname],
  {input:script,encoding:'utf8',timeout:10000,maxBuffer:1<<20});
 assert.equal(run.error,undefined);assert.equal(run.signal,null);assert.equal(run.status,0,run.stderr);
 const result=JSON.parse(run.stdout);assert.equal(result.positive,1);assert.equal(result.inventory,107);
 assert.ok(result.refusedMutants>=90);
});
