export function evidenceStorageConfig(home?: string): { enabled: boolean; roots: string[] };
export function main(args?: string[], home?: string, deps?: { readPressure?: () => { status: number | null; stdout: string; error?: unknown }; compactRoot?: typeof import('./lib/evidence-storage.mjs').compactEvidenceRoot }): number;
