// These are cheap workflow contracts, not the general workflow-reading test population.
// R-50 lists the workflow DIRECTORY: searching for a literal changed filename misses it.
// Keep the existing suites as the assertion authority instead of duplicating their rules.
export const AUTHOR_WORKFLOW_CONTRACT_SUITES = Object.freeze([
  'test/ci-cache-concurrency-and-job-timeouts.test.ts',
  'test/workflow-job-timeouts.test.ts',
]);
/** BACKSTOP: these filesystem/YAML contracts must finish before heavyweight author admission. */
export const AUTHOR_WORKFLOW_CONTRACT_MAX_MS = 30_000;

/** Include deleted/renamed workflows and edits to the contracts or their author-time wiring. */
export function authorWorkflowContractInputs(changedFiles) {
  return changedFiles.filter(path => path.startsWith('.github/workflows/') || path === '.nvmrc' ||
    path === 'scripts/preflight-author.mjs' || path === 'scripts/lib/author-workflow-contract.mjs' ||
    AUTHOR_WORKFLOW_CONTRACT_SUITES.includes(path));
}
