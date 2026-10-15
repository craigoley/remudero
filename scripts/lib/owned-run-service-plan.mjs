/** Default-off planning only. No exec, migration, lease release or model spend.
 * SHIPS-UNWIRED: native crash/migration qualification and the authorized producer are separate.
 */
export function ownedRunServicePlan(input) {
  if (input?.enabled !== true) return {state:'inert',dispatchAllowed:false,reason:'whole-run-service-disabled'};
  const {unitId,nowMs,finishByMs,startReserveMs,shutdownReserveMs,cpuPercent,memoryMaxBytes,command}=input;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(unitId ?? '') ||
      ![nowMs,finishByMs,startReserveMs,shutdownReserveMs,cpuPercent,memoryMaxBytes].every(Number.isSafeInteger) ||
      nowMs<0 || startReserveMs<1 || shutdownReserveMs<1 || cpuPercent<1 || memoryMaxBytes<1 ||
      !Array.isArray(command) || !command.length || typeof command[0]!=='string' || !command[0].startsWith('/') ||
      command.some(arg=>typeof arg!=='string'||arg.includes('\0')))
    return {state:'refused',dispatchAllowed:false,reason:'invalid-owned-service-contract'};
  const runtimeMs=finishByMs-nowMs-startReserveMs-shutdownReserveMs;
  if (!Number.isSafeInteger(runtimeMs)||runtimeMs<1) return {state:'refused',dispatchAllowed:false,reason:'fixed-deadline-does-not-fit'};
  const unit=`rmd-heavy-run-${unitId}`;
  const properties={Type:'exec',ExitType:'cgroup',Delegate:'yes',Restart:'no',KillMode:'control-group',SendSIGKILL:'yes',
    RuntimeMaxSec:`${runtimeMs}ms`,RuntimeRandomizedExtraSec:'0',TimeoutStartSec:`${startReserveMs}ms`,
    TimeoutStopSec:`${shutdownReserveMs}ms`,CPUQuota:`${cpuPercent}%`,MemoryMax:String(memoryMaxBytes)};
  return {state:'planned',dispatchAllowed:false,unit,finishByMs,pricedAtMs:nowMs,runtimeMs,
    limitations:'relative manager runtime needs startup/read-back qualification; not absolute-deadline, migration, capacity or live-dispatch proof',
    args:['--user',`--unit=${unit}`,'--collect',...Object.entries(properties).map(([key,value])=>`--property=${key}=${value}`),'--',...command]};
}
