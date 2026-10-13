/** Closed native measurements only. No test result reuse, baseline promotion or dispatch. */
export function accountAuthorPhases(receipt) {
 const steps=receipt.steps??[],timed=steps.filter(step=>Number.isSafeInteger(step.durationMs)&&step.durationMs>=0),
  unmeasured=steps.filter(step=>!timed.includes(step)).map(step=>step.name);
 const nativeDurationMs=timed.reduce((sum,step)=>sum+step.durationMs,0);
 const wallMeasured=Number.isSafeInteger(receipt.durationMs)&&receipt.durationMs>=nativeDurationMs;
 const tests=steps.find(step=>step.name==='affected-tests'||step.name==='affected-tests-subset');
 const complete=receipt.verdict==='passed'&&tests?.ok===true&&tests.testSummary?.fail===0&&
  steps.length>0&&unmeasured.length===0&&wallMeasured;
 return {state:complete?'measured':timed.length?'partial':'unavailable',trainingEligible:complete,
  nativeDurationMs,wallDurationMs:wallMeasured?receipt.durationMs:null,
  selectionAndAdmissionOverheadMs:wallMeasured?receipt.durationMs-nativeDurationMs:null,
  unmeasured,phases:timed.map(step=>({name:step.name,durationMs:step.durationMs,ok:step.ok})),
  scope:'this host/tree/run only; partial, skipped and cross-host evidence never becomes a calibrated whole-gate profile'};
}
