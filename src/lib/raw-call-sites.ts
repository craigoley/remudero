/**
 * W1-T9720: this frame's callers as V8 call sites, without Node's source-map formatter.
 * The existing read-plane capture collects 50 frames and drops this helper's own frame.
 * A caller preserving a different capture budget includes that one helper frame in `limit`.
 */
export function rawCallSites(limit = 50): NodeJS.CallSite[] {
  const prepare = Error.prepareStackTrace;
  const ambientLimit = Error.stackTraceLimit;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    Error.stackTraceLimit = limit;
    const sites = new Error().stack as unknown as NodeJS.CallSite[];
    return sites.slice(1);
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = ambientLimit;
  }
}
