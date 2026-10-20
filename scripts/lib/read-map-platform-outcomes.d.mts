export interface PlatformOutcomeShadow {
  state: "INERT" | "INCOMPLETE_UNKNOWN" | "OBSERVED_SHADOW_NOT_QUALIFIED";
  problems: string[];
  originalCounts: Record<"tests" | "passed" | "failed" | "cancelled" | "skipped" | "todo" | "suites" | "topLevel", number> | null;
  completeRecords: number;
  fileWrapperCount: number;
  testInstanceCount: number;
  executedPassCount: number | null;
  skipCount: number;
  declarationCandidateCount: number;
  declarationProvenance: string;
  dispatchAllowed: false;
  liveNarrowingAllowed: false;
  productionCoverageChanged: false;
  authorPass: false;
  fullCorpusQualified: false;
  attestedNotApplicable: 0;
  skippedBodyReadCoverageClaimed: false;
}
export function isReadMapSingleEntryWrapper(terminal: unknown, context: unknown): boolean;
export function assessReadMapPlatformOutcomes(input?: unknown, options?: { enabled?: boolean }): PlatformOutcomeShadow;
