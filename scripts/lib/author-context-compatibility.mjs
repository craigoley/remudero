import {lstatSync, realpathSync, statfsSync} from 'node:fs';
import {authorDependencyProvenance} from './author-dependency-provenance.mjs';

export const AUTHOR_CONTEXT_FORMAT = 'rmd-author-execution-context-v1';
export const AUTHOR_CONTEXT_PARENT_ENV = 'RMD_TEST_SLOT_PARENT';
const SHA = /^[a-f0-9]{40}$/;

/** The slot owner a native phase runs under: the lease's own parent claim, never a new identity. */
export function authorSlotOwner(slot) {
  const raw = slot?.childEnvironment?.[AUTHOR_CONTEXT_PARENT_ENV];
  if (slot?.outcome !== 'acquired' || typeof raw !== 'string') return null;
  let claim;
  try { claim = JSON.parse(raw); } catch (error) { return {state: 'unreadable', reason: error.message}; }
  if (typeof claim?.nonce !== 'string' || !claim.nonce || !Number.isSafeInteger(claim.pid) || claim.pid < 1 ||
      typeof claim.start !== 'string' || !claim.start || typeof claim.path !== 'string' || !claim.path) {
    return {state: 'unreadable', reason: 'slot parent claim lacks nonce, pid, start or path'};
  }
  return {state: 'held', path: claim.path, pid: claim.pid, processStart: claim.start, ownerNonce: claim.nonce};
}

function allocationIdentity(path, stat, statfs) {
  const real = realpathSync(path), entry = stat(real), fs = statfs(real);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`allocation is not a real directory: ${path}`);
  return {path: real, dev: entry.dev, ino: entry.ino, fsType: fs.type, blockSize: fs.bsize, blocks: fs.blocks};
}

/**
 * Observe the exact execution context a native phase is about to start or reuse under:
 * committed head and tree, installed dependency provenance, the actual slot owner nonce and
 * every allocation filesystem. An unavailable part is recorded, never defaulted.
 */
export function observeAuthorContext({root, git, slot, allocations = {}, dependency = authorDependencyProvenance,
  stat = lstatSync, statfs = statfsSync} = {}) {
  const context = {format: AUTHOR_CONTEXT_FORMAT, source: null, dependency: null, owner: null, allocations: {}};
  try {
    const head = git(['rev-parse', 'HEAD']).trim(), tree = git(['rev-parse', 'HEAD^{tree}']).trim();
    const clean = git(['status', '--porcelain']).trim() === '';
    context.source = SHA.test(head) && SHA.test(tree) ? {head, tree, clean} : {state: 'unresolved'};
  } catch (error) { context.source = {state: 'unavailable', reason: error.message}; }
  context.dependency = dependency(root);
  context.owner = authorSlotOwner(slot);
  for (const [name, path] of Object.entries(allocations).sort(([a], [b]) => a.localeCompare(b))) {
    try { context.allocations[name] = allocationIdentity(path, stat, statfs); }
    catch (error) { context.allocations[name] = {state: 'unavailable', reason: error.message}; }
  }
  return context;
}

/** Every part must be present on both sides and exactly equal; a missing part is a mismatch, not a match. */
export function authorContextCompatibility(expected, observed) {
  const mismatches = [];
  if (expected?.format !== AUTHOR_CONTEXT_FORMAT || observed?.format !== AUTHOR_CONTEXT_FORMAT) mismatches.push('format');
  const source = (c) => c?.source;
  if (!SHA.test(source(expected)?.head ?? '') || source(expected)?.clean !== true ||
      JSON.stringify(source(expected)) !== JSON.stringify(source(observed))) mismatches.push('source');
  if (expected?.dependency?.state !== 'present' || JSON.stringify(expected.dependency) !== JSON.stringify(observed?.dependency)) {
    mismatches.push('dependency');
  }
  if (expected?.owner?.state !== 'held' || JSON.stringify(expected.owner) !== JSON.stringify(observed?.owner)) mismatches.push('owner');
  const names = Object.keys(expected?.allocations ?? {});
  if (!names.length || JSON.stringify(names) !== JSON.stringify(Object.keys(observed?.allocations ?? {}))) {
    mismatches.push('allocations');
  } else {
    for (const name of names) {
      const want = expected.allocations[name];
      if (want?.state === 'unavailable' || JSON.stringify(want) !== JSON.stringify(observed.allocations[name])) {
        mismatches.push(`allocation:${name}`);
      }
    }
  }
  return {compatible: mismatches.length === 0, mismatches};
}

/** Gate a native phase: only an exact matching context may start it or reuse its allocations. */
export function requireAuthorContext(expected, observed, intent) {
  if (intent !== 'start' && intent !== 'reuse') throw new Error('author context intent must be start or reuse');
  const verdict = authorContextCompatibility(expected, observed);
  if (!verdict.compatible) {
    throw Object.assign(new Error(`author context NOT_RUN (${intent}): ${verdict.mismatches.join(', ')}`),
      {code: 'ERR_AUTHOR_CONTEXT_MISMATCH', mismatches: verdict.mismatches});
  }
  return verdict;
}
