import {performance} from 'node:perf_hooks';

export const CENSUS_PARENT_BUDGET_MAX_MS = 110_000;
export const CENSUS_PARENT_BUDGET_PREFIX = 'census-parent-budget: ';
class CensusParentDeferral extends Error {
  constructor(owner, operation) {
    super(`parent census budget deferred ${operation.label} before starting its child`);
    this.owner = owner;
  }
}

/** A parent allowance never shortens a child's existing backstop or retries it. */
export function censusParentBudget(milliseconds, now = () => performance.now(), {captureBytes = 256 * 1024 ** 2} = {}) {
  if (milliseconds === undefined) return undefined;
  const budgetMs = Number(milliseconds);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > CENSUS_PARENT_BUDGET_MAX_MS)
    throw new Error('parent census budget must be an integer from 1 through 110000 ms');
  if (!Number.isSafeInteger(captureBytes) || captureBytes < 16 * 1024 ** 2 || captureBytes > 256 * 1024 ** 2)
    throw new Error('parent census capture allowance must be from 16 through 256 MiB');
  let previous = now();
  if (!Number.isFinite(previous)) throw new Error('parent census clock is unavailable');
  const started = previous, admitted = [], completed = [], deferred = [];
  const elapsed = () => {
    const at = now();
    if (!Number.isFinite(at) || at < previous) throw new Error('parent census clock moved backwards or is unavailable');
    previous = at; return at - started;
  };
  const owner = {
    outputLimitBytes: Math.min(8 * 1024 ** 2, Math.floor(captureBytes / 32)),
    ensureFits(label, requiredMs, files = []) {
      if (typeof label !== 'string' || !label || !Number.isSafeInteger(requiredMs) || requiredMs < 1 ||
          !Array.isArray(files) || files.some(p => typeof p !== 'string') || admitted.length + deferred.length >= 8192)
        throw new Error('invalid parent census operation');
      const operation = {label, requiredMs, files: [...files], remainingMs: Math.max(0, budgetMs - elapsed()),
        reason: admitted.length >= 32 ? 'operation-count' : 'time'};
      if (admitted.length >= 32 || operation.remainingMs < requiredMs + 2000) {
        deferred.push(operation); throw new CensusParentDeferral(owner, operation);
      }
      return operation;
    },
    admit(label, requiredMs, files = []) {
      admitted.push(owner.ensureFits(label, requiredMs, files));
    },
    complete(label, observation) { elapsed(); completed.push({label, ...observation}); },
    owns(error) { return error instanceof CensusParentDeferral && error.owner === owner; },
    receipt(identity) { return {version: 'census-parent-budget-v1', state: 'over-capacity', ...identity,
      budgetMs, shutdownReserveMs: 2000, maxOperations: 32, captureBytes, outputLimitBytes: owner.outputLimitBytes,
      elapsedMs: elapsed(), admitted, completed, deferred,
      assurance: 'partial-local-feedback; full census remains required'}; },
  };
  return owner;
}

/** Only a complete, context-bound partial producer result permits continuation.
 * An actual timeout, failed assertion or unrelated unavailable result cannot qualify. */
export function readCensusParentBudgetResult(result, identity) {
  if (result.status !== 3 || result.signal || result.error || result.outputComplete !== true) return undefined;
  const lines = String(result.stderr ?? '').split('\n');
  const rows = lines.filter(line => line.startsWith(CENSUS_PARENT_BUDGET_PREFIX));
  if (rows.length !== 1 || lines.some(line => /^census-precheck: (?:.*NOT MEASURED|could not measure|this branch grows)/.test(line)))
    return undefined;
  try {
    const row = JSON.parse(rows[0].slice(CENSUS_PARENT_BUDGET_PREFIX.length));
    if (row.version !== 'census-parent-budget-v1' || row.state !== 'over-capacity' ||
        Object.entries(identity).some(([key, value]) => row[key] !== value) ||
        !Number.isSafeInteger(row.budgetMs) || row.budgetMs < 1 || row.budgetMs > CENSUS_PARENT_BUDGET_MAX_MS ||
        row.shutdownReserveMs !== 2000 || row.maxOperations !== 32 ||
        !Number.isSafeInteger(row.captureBytes) || row.captureBytes < 16 * 1024 ** 2 || row.captureBytes > 256 * 1024 ** 2 ||
        row.outputLimitBytes !== Math.min(8 * 1024 ** 2, Math.floor(row.captureBytes / 32)) ||
        !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 ||
        !Array.isArray(row.deferred) || !row.deferred.length || row.deferred.length > 8192 ||
        !Array.isArray(row.admitted) || row.admitted.length > 32 || !Array.isArray(row.completed) ||
        row.deferred.some(op => typeof op.label !== 'string' || !op.label || !Array.isArray(op.files) ||
          !Number.isSafeInteger(op.requiredMs) || op.requiredMs < 1 || !Number.isFinite(op.remainingMs) ||
          op.remainingMs < 0 || !(op.reason === 'operation-count' && row.admitted.length === 32 ||
            op.reason === 'time' && op.remainingMs < op.requiredMs + row.shutdownReserveMs))) return undefined;
    return row;
  } catch { return undefined; }
}
