// Explicitly enabled, pure shadow assessment. This is not a read-map selector or a production gate.
const platformShadowSafety = Object.freeze({
  dispatchAllowed: false, liveNarrowingAllowed: false, productionCoverageChanged: false,
  authorPass: false, fullCorpusQualified: false, attestedNotApplicable: 0,
  skippedBodyReadCoverageClaimed: false,
});
const platformSummaryKeys = ["tests", "passed", "failed", "cancelled", "skipped", "todo", "suites", "topLevel"];
const platformDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const platformHead = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const platformCounter = value => Number.isSafeInteger(value) && value >= 0;
const platformSameCounts = (a, b) => platformSummaryKeys.every(key => a?.[key] === b?.[key]);
const platformCountsValid = value => value && platformSummaryKeys.every(key => platformCounter(value[key])) &&
  value.tests > 0 && value.tests === value.passed + value.failed + value.cancelled + value.skipped + value.todo;

/** The Node 24.21 single-entry process wrapper is NOT another executed test instance.
 * Refuse unknown shapes instead of dropping anything with a null entry or a familiar name. */
export function isReadMapSingleEntryWrapper(terminal, context) {
  return context?.runtime?.node === "v24.21.0" && context?.processIsolation === "process" && context?.singleEntry === true &&
    typeof context?.entryRelative === "string" && !context.entryRelative.startsWith("/") &&
    context.entryRelative.split("/").every(part => part && part !== "." && part !== "..") &&
    typeof context?.runRoot === "string" && context.runRoot.startsWith("/") &&
    context.entryFile === context.runRoot + "/" + context.entryRelative &&
    terminal?.entryFile === null && terminal?.file === context.entryFile && terminal?.name === context.entryRelative &&
    terminal?.line === 1 && terminal?.column === 1 && terminal?.testId === 1 && terminal?.parentId === 0 &&
    terminal?.nesting === 0 && terminal?.testNumber === 1 && terminal?.type === "test" &&
    terminal?.skip === null && terminal?.todo === null && Array.isArray(terminal?.tags) && terminal.tags.length === 0 &&
    terminal?.details?.passed === true && terminal?.details?.error === null;
}

/** Supplied bindings/declarations are consistency checks, not verified native or human provenance.
 * Initial modeled population: one flat Linux/x64 entry, no retries/filters, at most one declared skip.
 * The strict corpus collector is deliberately unchanged, and no caller is wired automatically. */
export function assessReadMapPlatformOutcomes(input, options = {}) {
  const base = { ...platformShadowSafety, originalCounts: null, completeRecords: 0,
    fileWrapperCount: 0, testInstanceCount: 0, executedPassCount: null, skipCount: 0,
    declarationCandidateCount: 0, declarationProvenance: "SUPPLIED_NOT_INDEPENDENTLY_VERIFIED" };
  if (options.enabled !== true) return { ...base, state: "INERT", problems: [] };
  const x = input, problems = [], check = (ok, why) => { if (!ok) problems.push(why); };
  check(platformHead(x?.head) && x.head === x.expectedHead, "source-head-unbound");
  check(platformDigest(x?.entrySha256) && x.entrySha256 === x.expectedEntrySha256 &&
    platformDigest(x?.reporterSha256) && x.reporterSha256 === x.expectedReporterSha256, "source-or-reporter-unbound");
  check(x?.runtime?.node === "v24.21.0" && x.runtime.platform === "linux" && x.runtime.arch === "x64" &&
    platformDigest(x.runtime.executableSha256) && ["node", "platform", "arch", "executableSha256"].every(key => x.runtime[key] === x.expectedRuntime?.[key]), "runtime-unbound");
  check(platformCountsValid(x?.perFile) && platformCountsValid(x?.final) && platformSameCounts(x.perFile, x.final), "eight-field-counts-missing-or-contradictory");
  check(x?.capture?.status === 0 && x.capture.signal === null && x.capture.childrenClosed === true && x.capture.outputComplete === true, "capture-not-closed");
  check(x?.sourceMaps === true && x?.filters === false && x?.retries === 0, "locations-or-attempt-unbound");
  const completes = Array.isArray(x?.terminals) && x.terminals.length <= 50000 ? x.terminals : [];
  const wrappers = completes.filter(terminal => isReadMapSingleEntryWrapper(terminal, x));
  const terminals = completes.filter(terminal => !wrappers.includes(terminal));
  check(wrappers.length === 1, "single-entry-wrapper-unbound");
  check(terminals.length > 0 && terminals.length === x?.final?.tests, "terminal-denominator-incomplete");
  const identities = new Set();
  for (const terminal of terminals) {
    check(terminal?.entryFile === x?.entryFile && terminal?.file === x?.entryFile &&
      Number.isSafeInteger(terminal?.testId) && terminal.testId > 0 && terminal?.parentId === 0 && terminal?.nesting === 0 &&
      Number.isSafeInteger(terminal?.line) && terminal.line > 0 && Number.isSafeInteger(terminal?.column) && terminal.column > 0 &&
      typeof terminal?.name === "string" && terminal.name.length > 0 && terminal?.type === "test", "terminal-identity-unknown");
    const identity = JSON.stringify([terminal?.entryFile, terminal?.testId]);
    check(!identities.has(identity), "duplicate-terminal"); identities.add(identity);
    check(terminal?.todo === null || terminal?.todo === false, "todo-not-modeled");
    check(terminal?.skip === null || terminal?.skip === false || terminal?.skip === true ||
      typeof terminal?.skip === "string" && terminal.skip.length > 0, "skip-shape-unknown");
    check(terminal?.details?.passed === true && terminal?.details?.error === null, "terminal-not-positive");
  }
  const skips = terminals.filter(terminal => terminal?.skip === true || typeof terminal?.skip === "string" && terminal.skip.length > 0);
  const passes = terminals.length - skips.length;
  check(skips.length <= 1 && x?.final?.skipped === skips.length && x?.final?.passed === passes &&
    x?.final?.failed === 0 && x?.final?.cancelled === 0 && x?.final?.todo === 0 &&
    x?.final?.suites === 0 && x?.final?.topLevel === terminals.length, "unsupported-outcome-population");
  let candidates = 0;
  if (skips.length === 1) {
    const declaration = x?.declaration, skipped = skips[0];
    const bound = declaration?.reviewState === "reviewed-exact-source" && platformDigest(declaration?.sha256) &&
      declaration.entrySha256 === x?.entrySha256 && Array.isArray(declaration.notApplicableOn) &&
      declaration.notApplicableOn.length === 1 && declaration.notApplicableOn[0] === "linux" &&
      skipped.name === declaration.name && skipped.line === declaration.line && skipped.column === declaration.column &&
      skipped.parentId === declaration.parentId;
    check(bound, "skip-declaration-unbound"); candidates = bound ? 1 : 0;
  }
  return { ...base, state: problems.length ? "INCOMPLETE_UNKNOWN" : "OBSERVED_SHADOW_NOT_QUALIFIED",
    problems: [...new Set(problems)], originalCounts: platformCountsValid(x?.final) ?
      Object.fromEntries(platformSummaryKeys.map(key => [key, x.final[key]])) : null,
    completeRecords: completes.length, fileWrapperCount: wrappers.length, testInstanceCount: terminals.length,
    executedPassCount: platformCountsValid(x?.final) ? x.final.passed : null, skipCount: skips.length,
    declarationCandidateCount: candidates };
}
