export const SEMGREP_RUNTIME_WORKFLOW = '.github/workflows/semgrep-runtime-compatibility.yml';
export const SEMGREP_RUNTIME_CHECK = 'semgrep-runtime-compatibility';
const locks = new Set(['.github/semgrep/requirements.txt', '.github/semgrep/build-requirements.txt']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const unknown = reason => ({state:'unknown',mergeAllowed:false,reason});
export const changesSemgrepRuntime = files => files.some(file => locks.has(file.filename) || locks.has(file.previous_filename));

/** Metadata only: a green job name is insufficient without its trusted workflow and exact run/job binding. */
export function* semgrepRuntimeMetadataRequests(input) {
  if (!changesSemgrepRuntime(input.files)) return {state:'not-applicable',mergeAllowed:true,reason:'semgrep-runtime-lock-unchanged'};
  if (!sha(input.headSha) || !sha(input.baseSha) || !positive(input.prNumber) || input.checksComplete !== true || !Array.isArray(input.checks))
    return unknown('semgrep-runtime-evidence-incomplete');
  const checks = input.checks.filter(check => check?.name === SEMGREP_RUNTIME_CHECK && check.head_sha === input.headSha &&
    check.app?.id === 15368 && check.app?.slug === 'github-actions' && check.app?.owner?.login === 'github');
  if (!checks.length) return unknown('trusted-exact-head-semgrep-runtime-result-missing');
  if (checks.some(check => !positive(check.id)) || new Set(checks.map(check => check.id)).size !== checks.length)
    return unknown('semgrep-runtime-check-generation-ambiguous');
  // BACKSTOP: bound additional metadata reads; a larger generation corpus is UNKNOWN, not partial success.
  if (checks.length > 8) return unknown('semgrep-runtime-generation-corpus-exceeds-bound');
  const prefix = 'repos/craigoley/remudero';
  let selected;
  for (const check of [...checks].sort((a,b) => b.id-a.id)) {
    const link = /^https:\/\/github\.com\/craigoley\/remudero\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(check.details_url ?? '');
    if (!link || !positive(Number(link[1])) || !positive(Number(link[2])) || !positive(check.check_suite?.id))
      return unknown('semgrep-runtime-run-identity-unavailable');
    const runId = Number(link[1]), jobId = Number(link[2]);
    const run = yield `${prefix}/actions/runs/${runId}`;
    if (run?.id !== runId || run.repository?.full_name !== 'craigoley/remudero' || run.event !== 'pull_request' ||
        run.head_sha !== input.headSha || !positive(run.workflow_id) || !positive(run.run_attempt) || run.check_suite_id !== check.check_suite.id)
      return unknown('semgrep-runtime-workflow-identity-mismatch');
    if (run.path !== SEMGREP_RUNTIME_WORKFLOW) {
      if (typeof run.path === 'string' && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(run.path)) continue;
      return unknown('semgrep-runtime-workflow-identity-mismatch');
    }
    selected = {check,run,runId,jobId}; break;
  }
  if (!selected) return unknown('trusted-exact-head-semgrep-runtime-result-missing');
  const {check,run,runId,jobId} = selected;
  const pr = Array.isArray(run.pull_requests) && run.pull_requests.length === 1 ? run.pull_requests[0] : null;
  if (pr?.number !== input.prNumber || pr.head?.sha !== input.headSha ||
      pr.base?.repo?.url !== 'https://api.github.com/repos/craigoley/remudero')
    return unknown('semgrep-runtime-pr-provenance-unavailable');
  if (check.status !== 'completed') return unknown('semgrep-runtime-compatibility-pending');
  if (typeof run.node_id !== 'string' || !/^[A-Za-z0-9_=-]{8,200}$/.test(run.node_id))
    return unknown('semgrep-runtime-executed-workflow-unavailable');
  const source = yield `security-workflow-source:${run.node_id}`;
  const executed = source?.data?.node, file = executed?.file;
  const immutable = /^https:\/\/github\.com\/craigoley\/remudero\/blob\/([a-f0-9]{40})\/\.github\/workflows\/semgrep-runtime-compatibility\.yml$/.exec(file?.repositoryFileUrl ?? '');
  const runUrl = `https://github.com/craigoley/remudero/actions/runs/${runId}`;
  if (source?.errors || executed?.__typename !== 'WorkflowRun' || executed.url !== runUrl || executed.runAttempt !== run.run_attempt ||
      file?.path !== SEMGREP_RUNTIME_WORKFLOW || !['craigoley/remudero','https://github.com/craigoley/remudero'].includes(file.repositoryName) ||
      file.run?.url !== runUrl || file.run.runAttempt !== run.run_attempt || !immutable)
    return unknown('semgrep-runtime-executed-workflow-unavailable');
  const job = yield `${prefix}/actions/jobs/${jobId}`;
  if (job?.id !== jobId || job.run_id !== runId || job.run_attempt !== run.run_attempt || job.head_sha !== input.headSha ||
      job.name !== SEMGREP_RUNTIME_CHECK || job.check_run_url !== `https://api.github.com/${prefix}/check-runs/${check.id}` ||
      job.status !== check.status || job.conclusion !== check.conclusion)
    return unknown('semgrep-runtime-job-identity-mismatch');
  const content = ref => `${prefix}/contents/${SEMGREP_RUNTIME_WORKFLOW}?ref=${ref}`;
  const trusted = yield content(input.baseSha), proposed = yield content(input.headSha), actual = yield content(immutable[1]);
  const valid = item => item?.type === 'file' && item.path === SEMGREP_RUNTIME_WORKFLOW && sha(item.sha) && positive(item.size) && item.size <= 65536;
  if (![trusted,proposed,actual].every(valid) || trusted.sha !== proposed.sha || trusted.size !== proposed.size ||
      trusted.sha !== actual.sha || trusted.size !== actual.size)
    return unknown('semgrep-runtime-workflow-not-trusted-main-bytes');
  if (run.status !== 'completed' || run.conclusion !== check.conclusion) return unknown('semgrep-runtime-run-not-closed');
  if (check.conclusion === 'failure') return {state:'blocked',mergeAllowed:false,reason:'semgrep-runtime-incompatible-or-install-failed'};
  if (check.conclusion !== 'success') return unknown('semgrep-runtime-compatibility-not-successful');
  for (const name of ['Detect runtime lock changes','Set up pinned Python','Verify hash-locked install and dependency closure']) {
    const steps = Array.isArray(job.steps) ? job.steps.filter(step => step.name === name) : [];
    if (steps.length !== 1 || !positive(steps[0].number) || steps[0].status !== 'completed' || steps[0].conclusion !== 'success')
      return unknown('semgrep-runtime-required-step-not-successful');
  }
  return {state:'compatible',mergeAllowed:true,reason:'trusted-exact-head-semgrep-runtime-compatible'};
}
