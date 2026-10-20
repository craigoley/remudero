import type { Stats } from 'node:fs';
export const EVIDENCE_IDLE_MS: number;
export const EVIDENCE_MAX_FILE_BYTES: number;
export function eligibleEvidence(stat: Stats, now: number, uid: number): boolean;
export function sameEvidenceIdentity(a: Stats, b: Stats): boolean;
export function evidenceDigest(fd: number, expectedSize: number): string;
export interface EvidenceResult { path: string; disposition: string; reason?: string; retainedOriginalPath?: string; sha256?: string; copyMethod?: string; allocatedSavingBytes?: number; }
export function compressEvidenceFile(path: string, options?: { apply?: boolean; now?: number; beforePublish?: () => void; afterPublish?: (paths: { path: string; original: string }) => void }): EvidenceResult;
export function compactEvidenceRoot(root: string, options?: { apply?: boolean; now?: number; maxEntries?: number }): { entries: EvidenceResult[]; incomplete: boolean; historyDeleted: false; modelCalls: 0 };
