// Default-off, read-back validation for the bounded disposable runner probe only.
// No controller writes, execution authority, reserved throughput or pressure qualification.
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';

export const OWNED_RUN_PROBE_CAPS = Object.freeze({
  'cpu.max':'50000 100000', 'memory.max':'536870912', 'memory.swap.max':'0', 'pids.max':'64',
});
const counters=['cgroup.events','cpu.stat','memory.current','memory.events','memory.swap.current','pids.current','pids.events'];
function text(value,label) {
  assert(typeof value?.text==='string'&&value.text.length>0&&value.text.length<=4096&&!value.error,'unreadable '+label);
  return value.text.trim();
}
function controllers(value,label) {
  assert(typeof value?.text==='string'&&value.text.length<=4096&&!value.error,'unreadable '+label);
  const words=value.text.trim().split(/\s+/).filter(Boolean);
  assert(words.every(x=>/^[a-z][a-z0-9_]*$/.test(x))&&new Set(words).size===words.length,'malformed '+label);
  return new Set(words);
}
function cpuList(value) {
  const mask=text(value,'cpuset.cpus.effective');let previous=-1;
  for(const part of mask.split(',')) {
    assert(/^\d+(?:-\d+)?$/.test(part),'malformed cpuset CPU list');
    const [a,b=a]=part.split('-').map(Number);
    assert(Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a>previous&&b>=a,'invalid cpuset CPU range');previous=b;
  }
  return mask;
}

/** Capability absence is explicit non-qualification, never a substituted zero or a permission waiver.
 * A non-root controller interface is supplied by its PARENT's subtree_control. Reading the leaf's
 * own subtree_control would confuse controls applying to that leaf with controls for its children.
 * SHIPS-UNWIRED: only a separately approved, source-pinned observer may consume this pure contract. */
function inspect(snapshot) {
  const rows=snapshot?.hierarchy;
  assert(Array.isArray(rows)&&rows.length>1&&rows.length<=16,'complete visible hierarchy required');
  assert(rows.at(-1)?.path==='/sys/fs/cgroup','real hierarchy root required');
  const metadata=rows.map((row,i)=>{
    assert(typeof row.path==='string'&&row.path===resolve(row.path)&&(row.path.startsWith('/sys/fs/cgroup/')||i===rows.length-1&&row.path==='/sys/fs/cgroup'),'invalid cgroup path');
    assert(Number.isSafeInteger(row.dev)&&row.dev>=0&&Number.isSafeInteger(row.ino)&&row.ino>0,'cgroup inode identity required');
    if(i)assert.equal(dirname(rows[i-1].path),row.path,'ancestor omitted');
    return {available:controllers(row.files?.['cgroup.controllers'],'cgroup.controllers'),enabled:controllers(row.files?.['cgroup.subtree_control'],'cgroup.subtree_control')};
  });
  const observations=[];
  for(let i=0;i<rows.length;i++) {
    const row=rows[i],root=i===rows.length-1,{available,enabled}=metadata[i];
    assert([...enabled].every(x=>available.has(x)),'enabled controller unavailable');
    if(!root)assert([...available].every(x=>metadata[i+1].enabled.has(x)),'controller ancestry contradicts availability');
    for(const key of [...Object.keys(OWNED_RUN_PROBE_CAPS),...counters]) {
      if(root&&row.files?.[key]?.error==='ENOENT'){assert.equal(row.files[key].text,undefined,'contradictory root exception');continue;} // Root exceptions are not child-limit evidence.
      text(row.files?.[key],key);
    }
    const cpusetExpected=root?available.has('cpuset'):metadata[i+1].enabled.has('cpuset');
    assert.equal(available.has('cpuset'),cpusetExpected,'cpuset controller ancestry mismatch');
    const value=row.files?.['cpuset.cpus.effective'];
    if(cpusetExpected)observations.push({path:row.path,state:'OBSERVED',cpus:cpuList(value),reserved:false});
    else {
      assert.equal(value?.error,'ENOENT','non-delegated cpuset must have explicit ENOENT; denied or missing observation is UNKNOWN');
      assert.equal(value?.text,undefined,'contradictory cpuset observation');
      observations.push({path:row.path,state:'NOT_DELEGATED_NOT_QUALIFIED',cpus:null,reserved:false});
    }
  }
  for(const name of ['cpu','memory','pids'])assert(metadata[0].available.has(name),'mandatory leaf controller unavailable '+name);
  return {rows,observations};
}
/** Read-only preflight only: parent capabilities do not certify any future leaf's limits. */
export function inspectOwnedRunnerCapabilities(snapshot,options={}) {
  if(options.enabled!==true)return{state:'inert',dispatchAllowed:false,runnerQualified:false};
  const {rows,observations}=inspect(snapshot);
  return {state:'CAPABILITIES_OBSERVED_NOT_LEAF_LIMITS',scope:'READ_ONLY_PREFLIGHT_ONLY',paths:rows.map(row=>row.path),cpuset:observations,
    leafLimitsQualified:false,pressureQualified:false,runnerQualified:false,dispatchAllowed:false};
}
export function validateOwnedRunnerHierarchy(snapshot,options={}) {
  if(options.enabled!==true)return{state:'inert',dispatchAllowed:false,runnerQualified:false};
  const {rows,observations}=inspect(snapshot);
  for(const [key,expected] of Object.entries(OWNED_RUN_PROBE_CAPS))assert.equal(text(rows[0].files[key],key),expected,'leaf limit mismatch '+key);
  return {state:'KERNEL_SETTINGS_READ_BACK_NOT_PRESSURE_QUALIFIED',scope:'BOUNDED_DISPOSABLE_PROBE_ONLY',
    hierarchy:rows.map(row=>({path:row.path,ceilings:Object.fromEntries(Object.keys(OWNED_RUN_PROBE_CAPS).map(key=>[key,row.files[key]]))})),
    cpuset:observations,leafCpusetQualified:observations[0].state==='OBSERVED',reservedCpu:false,pressureQualified:false,runnerQualified:false,dispatchAllowed:false};
}
