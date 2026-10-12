export interface PromisedFollowUp { path: string; text: string; taskId?: string }
export interface FollowUpPlanRecord { id: string; title: string; plan_refs?: readonly string[]; rationale?: string; prompt?: string }
export interface HarvestableFollowUp { type: "research" | "task" | "action"; text: string }
export function promisedFollowUps(_files: readonly string[], _readFile: (path: string) => string): PromisedFollowUp[] { return []; }
export function unreportedFollowUps(promised: readonly PromisedFollowUp[], _report: string, _records: readonly FollowUpPlanRecord[]): PromisedFollowUp[] { return [...promised]; }
export function parseHarvestableFollowUps(_text: string): HarvestableFollowUp[] | null { return null; }
