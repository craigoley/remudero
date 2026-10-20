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
