import type { DependencyMergeEvidence, Task } from '../../src/lib/plan.js';
export const CI_DEPENDENCY_EVIDENCE_SCHEMA: string;
export const CI_DEPENDENCY_EVIDENCE_MAX_BYTES: number;
export interface CiDependencyEvidenceContext {
  actions: boolean; repository: string; head: string; base: string; producerSha: string;
  runId: string; attempt: string; producerJob: string; digest: string;
  nowMs: number; maxAgeMs: number; runnerTemp: string; checkout: string;
}
export function readCiDependencyEvidence(path: string, expected: CiDependencyEvidenceContext): {
  state: 'ready' | 'unknown'; reason?: string;
  dependencyEvidence: (task: Pick<Task, 'id'>) => DependencyMergeEvidence;
};
export function ciDependencyEvidenceForInvocation(argv: string[], env?: NodeJS.ProcessEnv, cwd?: string):
  ((task: Pick<Task, 'id'>) => DependencyMergeEvidence) | undefined;
export interface CiDependencyProducerContext {
  actions: boolean; repository: string; head: string; base: string; producerSha: string;
  producerJob: string; runId: string; attempt: string; nowMs: number; checkout: string;
}
export function ciDependencyClosure(checkout: string, head: string, base: string): {
  plan: import('../../src/lib/plan.js').Plan; taskIds: string[];
  overrides: import('../../src/lib/status.js').CreditOverrideRow[];
};
export function produceCiDependencyEvidence(context: CiDependencyProducerContext, ports?: {
  request?: (path: string) => unknown | Promise<unknown>;
  closure?: typeof ciDependencyClosure; git?: (args: string[]) => string;
}): Promise<{ bytes: string; digest: string; producerSha: string }>;
