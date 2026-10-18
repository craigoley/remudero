import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OWNED_RUN_PROBE_CAPS,validateOwnedRunnerHierarchy,inspectOwnedRunnerCapabilities} from '#scripts/lib/owned-run-hierarchy-contract.mjs';

// Synthetic read-back records only; neither branch proof nor an absent feature certifies a native run.
function fixture(cpuset=true) {
  const paths=['/sys/fs/cgroup/user.slice/user-1000.slice/probe.service','/sys/fs/cgroup/user.slice/user-1000.slice','/sys/fs/cgroup/user.slice','/sys/fs/cgroup'];
  return {hierarchy:paths.map((path,i)=>({path,dev:1,ino:i+1,files:Object.fromEntries([
    ...Object.entries(OWNED_RUN_PROBE_CAPS).map(([k,v])=>[k,{text:v}]),
    ['cgroup.controllers',{text:cpuset||i>=2?'cpuset cpu memory pids':'cpu memory pids'}],
    ['cgroup.subtree_control',{text:i===0?'':cpuset||i===3?'cpuset cpu memory pids':'cpu memory pids'}],
    ['cpuset.cpus.effective',cpuset||i>=2?{text:'0-7\n'}:{error:'ENOENT'}],
    ['cgroup.events',{text:'populated 1\n'}],['cpu.stat',{text:'usage_usec 50\nnr_throttled 2\n'}],
    ['memory.current',{text:'1000\n'}],['memory.events',{text:'oom 0\n'}],['memory.swap.current',{text:'0\n'}],
    ['pids.current',{text:'2\n'}],['pids.events',{text:'max 0\n'}],
  ])}))};
}
const assess=(f: ReturnType<typeof fixture>)=>{const out=validateOwnedRunnerHierarchy(f,{enabled:true});assert(out.state!=='inert');return out;};
test('owned runner hierarchy is inert before explicit opt in',()=>{assert.deepEqual(validateOwnedRunnerHierarchy(undefined),{state:'inert',dispatchAllowed:false,runnerQualified:false});});
test('owned runner hierarchy accepts observed cpuset without claiming reservation or pressure',()=>{const out=assess(fixture());assert.equal(out.leafCpusetQualified,true);assert.equal(out.cpuset[0].cpus,'0-7');assert.equal(out.dispatchAllowed,false);assert.equal(out.reservedCpu,false);assert.equal(out.pressureQualified,false);assert.equal(out.runnerQualified,false);});
test('owned runner hierarchy records non-delegated cpuset as unqualified, not missing mandatory limits',()=>{const out=assess(fixture(false));assert.equal(out.leafCpusetQualified,false);assert.equal(out.cpuset[0].state,'NOT_DELEGATED_NOT_QUALIFIED');assert.equal(out.cpuset[0].cpus,null);assert.equal(out.cpuset[2].state,'OBSERVED');assert.equal(out.dispatchAllowed,false);});
test('owned runner hierarchy uses parent delegation, not the empty leaf subtree control',()=>{const f=fixture();assert.equal(f.hierarchy[0].files['cgroup.subtree_control'].text,'');assert.equal(assess(f).leafCpusetQualified,true);});
for(const key of Object.keys(OWNED_RUN_PROBE_CAPS))test('owned runner hierarchy never waives mandatory '+key,()=>{for(const change of [{error:'ENOENT'},{error:'EACCES'},{text:'max'}]){const f=fixture(false);f.hierarchy[0].files[key]=change;assert.throws(()=>assess(f));}});
test('owned runner hierarchy refuses unavailable, denied, missing and malformed controller observations',()=>{for(const key of ['cgroup.controllers','cgroup.subtree_control'])for(const change of [{error:'ENOENT'},{error:'EACCES'},{text:'cpu cpu'},{text:'+cpu'}]){const f=fixture(false);f.hierarchy[1].files[key]=change;assert.throws(()=>assess(f));}});
test('owned runner hierarchy refuses denied or unobserved cpuset even when not delegated',()=>{for(const change of [{error:'EACCES'},{error:'EIO'},{}]){const f=fixture(false);f.hierarchy[0].files['cpuset.cpus.effective']=change;assert.throws(()=>assess(f));}});
test('owned runner hierarchy refuses missing, empty or malformed cpuset when enabled',()=>{for(const change of [{error:'ENOENT'},{text:''},{text:'7-0'},{text:'0-7,4-5'},{text:'0,not-a-cpu'}]){const f=fixture();f.hierarchy[0].files['cpuset.cpus.effective']=change;assert.throws(()=>assess(f));}});
test('owned runner hierarchy refuses contradictory cpuset availability and fabricated files',()=>{const f=fixture(false);f.hierarchy[0].files['cpuset.cpus.effective']={text:'0-7'};assert.throws(()=>assess(f));const g=fixture();g.hierarchy[0].files['cgroup.controllers']={text:'cpu memory pids'};assert.throws(()=>assess(g));});
test('owned runner hierarchy refuses omitted ancestors and invalid identities',()=>{const f=fixture(false);f.hierarchy.splice(1,1);assert.throws(()=>assess(f));const g=fixture();g.hierarchy[0].ino=0;assert.throws(()=>assess(g));});
test('owned runner hierarchy preserves tighter ancestors and root exceptions without inventing headroom',()=>{const f=fixture(false);f.hierarchy[1].files['memory.max']={text:'1234'};f.hierarchy.at(-1)!.files['memory.max']={error:'ENOENT'};const out=assess(f);assert.equal(out.hierarchy[1].ceilings['memory.max'].text,'1234');assert.equal(out.reservedCpu,false);const g=fixture(false);g.hierarchy[1].files['memory.max']={error:'ENOENT'};assert.throws(()=>assess(g));});
test('owned runner hierarchy reports wholly unavailable cpuset without fabricating CPU placement proof',()=>{const f=fixture(false);for(const row of f.hierarchy){row.files['cgroup.controllers']={text:'cpu memory pids'};row.files['cgroup.subtree_control']={text:'cpu memory pids'};row.files['cpuset.cpus.effective']={error:'ENOENT'};}const out=assess(f);assert(out.cpuset.every(r=>r.state==='NOT_DELEGATED_NOT_QUALIFIED'&&r.cpus===null));assert.equal(out.runnerQualified,false);});
test('owned runner hierarchy refuses missing mandatory controllers and contradictory root exceptions',()=>{const f=fixture(false);f.hierarchy[0].files['cgroup.controllers']={text:'cpu memory'};assert.throws(()=>assess(f));const g=fixture();g.hierarchy.at(-1)!.files['memory.max']={text:'1234',error:'ENOENT'};assert.throws(()=>assess(g));const h=fixture();h.hierarchy[0].path='/sys/fs/cgroup/user.slice/user-1000.slice/../probe.service';assert.throws(()=>assess(h));});
test('owned runner preflight observes parent capabilities without certifying future leaf limits',()=>{const f=fixture(false);f.hierarchy[0].files['memory.max']={text:'1234'};const out=inspectOwnedRunnerCapabilities(f,{enabled:true});assert(out.state!=='inert');assert.equal(out.state,'CAPABILITIES_OBSERVED_NOT_LEAF_LIMITS');assert.equal(out.leafLimitsQualified,false);assert.equal(out.dispatchAllowed,false);assert.throws(()=>assess(f));});
test('owned runner preflight is inert by default and rejects unreadable capabilities',()=>{assert.equal(inspectOwnedRunnerCapabilities(undefined).state,'inert');const f=fixture(false);f.hierarchy[0].files['cgroup.controllers']={error:'EACCES'};assert.throws(()=>inspectOwnedRunnerCapabilities(f,{enabled:true}));});
