export const OWNED_RUN_PROBE_CAPS: Readonly<Record<'cpu.max'|'memory.max'|'memory.swap.max'|'pids.max',string>>;
export interface ProbeCpusetObservation {path:string;state:'OBSERVED'|'NOT_DELEGATED_NOT_QUALIFIED';cpus:string|null;reserved:false}
export interface ProbeHierarchyObservation {
 state:'KERNEL_SETTINGS_READ_BACK_NOT_PRESSURE_QUALIFIED';
 scope:'BOUNDED_DISPOSABLE_PROBE_ONLY';
 hierarchy:Array<{path:string;ceilings:Record<string,{text?:string;error?:string}>}>;
 cpuset:ProbeCpusetObservation[];
 leafCpusetQualified:boolean;
 reservedCpu:false;
 pressureQualified:false;
 runnerQualified:false;
 dispatchAllowed:false;
}
export function validateOwnedRunnerHierarchy(snapshot:unknown,options?:{enabled?:boolean}):
 {state:'inert';dispatchAllowed:false;runnerQualified:false}|ProbeHierarchyObservation;
export function inspectOwnedRunnerCapabilities(snapshot:unknown,options?:{enabled?:boolean}):
 {state:'inert';dispatchAllowed:false;runnerQualified:false}|{
  state:'CAPABILITIES_OBSERVED_NOT_LEAF_LIMITS';scope:'READ_ONLY_PREFLIGHT_ONLY';paths:string[];cpuset:ProbeCpusetObservation[];
  leafLimitsQualified:false;pressureQualified:false;runnerQualified:false;dispatchAllowed:false;
 };
