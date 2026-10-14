/** Closed native measurements only. No test result reuse, baseline promotion or dispatch. */
export function accountAuthorPhases(receipt) {
 const steps=receipt.steps??[],timed=steps.filter(step=>Number.isSafeInteger(step.durationMs)&&step.durationMs>=0),
  unmeasured=steps.filter(step=>!timed.includes(step)).map(step=>step.name);
 const nativeDurationMs=timed.reduce((sum,step)=>sum+step.durationMs,0);
 const wallMeasured=Number.isSafeInteger(receipt.durationMs)&&receipt.durationMs>=nativeDurationMs;
 const tests=steps.find(step=>step.name==='affected-tests'||step.name==='affected-tests-subset');
 const summary=tests?.testSummary;
 const positiveSummary=summary && ['tests','suites','pass','fail','cancelled','skipped','todo']
  .every(field=>Number.isSafeInteger(summary[field])&&summary[field]>=0) && summary.tests>0 && summary.pass===summary.tests &&
  ['fail','cancelled','skipped','todo'].every(field=>summary[field]===0);
 const complete=receipt.verdict==='passed'&&tests?.name==='affected-tests'&&positiveSummary&&
  Array.isArray(receipt.suites)&&receipt.suites.length>0&&new Set(receipt.suites).size===receipt.suites.length&&
  receipt.suites.every(path=>typeof path==='string'&&path.startsWith('test/')&&path.endsWith('.test.ts'))&&
  receipt.tiered===undefined&&receipt.affectedTestsNotRunReason===undefined&&
  steps.length>0&&steps.every(step=>step.ok===true)&&unmeasured.length===0&&wallMeasured&&Number.isSafeInteger(nativeDurationMs);
 return {state:complete?'measured':timed.length?'partial':'unavailable',trainingEligible:complete,
  nativeDurationMs,wallDurationMs:wallMeasured?receipt.durationMs:null,
  selectionAndAdmissionOverheadMs:wallMeasured?receipt.durationMs-nativeDurationMs:null,
  unmeasured,phases:timed.map(step=>({name:step.name,durationMs:step.durationMs,ok:step.ok})),
  scope:'this host/tree/run only; partial, skipped and cross-host evidence never becomes a calibrated whole-gate profile'};
}
